// Shared bounds, conversions, and line accounting for the diff-tools nodes.
// Not a node and not a test file, so it is neither registered nor collected.
//
// The algorithmically hard parts — the diff itself, unified-diff formatting and
// parsing, and patch application — all belong to jsdiff. This module only
// enforces input bounds and maps between jsdiff's shapes and the proto messages.
import { Hunk } from '../gen/messages_pb';
import type { StructuredPatch } from 'diff';

/** Maximum characters accepted for any single text or unified-diff input. */
export const MAX_CHARS = 1_000_000;

/**
 * Maximum lines accepted for any single text or unified-diff input.
 *
 * The diff is O(N*D), so cost peaks when two texts of N lines share nothing.
 * Measured on this library, that worst case costs roughly 0.1s at 1,000 lines,
 * 2.4s at 5,000, and 44s at 20,000 — so the cap is what keeps a hostile input
 * from becoming a denial of service, not a stylistic limit.
 */
export const MAX_LINES = 5_000;

/** Context lines used when TextPair.context_lines is 0. */
export const DEFAULT_CONTEXT = 3;

/** Largest accepted TextPair.context_lines. */
export const MAX_CONTEXT = 100;

/** jsdiff prefixes formatted patches with this separator; standard `diff -u` does not. */
const INDEX_SEPARATOR = '='.repeat(67) + '\n';

/** Raised for any rejected input; the message becomes the node's structured error. */
export class BadInput extends Error {}

/**
 * The structured error text for a caught failure. A BadInput carries a specific,
 * stable message; anything else is reported as a generic failure for `what`,
 * so an unexpected internal error can never leak a stack trace to the caller.
 */
export function errorMessage(e: unknown, what: string): string {
  return e instanceof BadInput ? e.message : `${what} failed on this input`;
}

/**
 * Rejects a text that exceeds the character or line bound, counting both on the
 * raw input before any diffing, splitting, or allocation happens.
 */
export function checkBounds(text: string, label: string): void {
  if (text.length > MAX_CHARS) {
    throw new BadInput(
      `${label} exceeds the maximum of ${MAX_CHARS} characters (got ${text.length})`,
    );
  }
  const lines = countLines(text);
  if (lines > MAX_LINES) {
    throw new BadInput(`${label} exceeds the maximum of ${MAX_LINES} lines (got ${lines})`);
  }
}

/**
 * Counts lines the way this package reports them: an empty text is zero lines,
 * otherwise it is the number of "\n"-separated pieces, so a trailing newline
 * does NOT invent an extra empty line ("a\nb\n" and "a\nb" are both 2 lines).
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  // A trailing newline closes the final line rather than starting a new one.
  return text.charCodeAt(text.length - 1) === 10 ? n - 1 : n;
}

/** Validates context_lines: -1 means zero context, 0 selects the default. */
export function contextLines(requested: number): number {
  if (requested < -1) {
    throw new BadInput(`context_lines must not be below -1 (got ${requested})`);
  }
  if (requested > MAX_CONTEXT) {
    throw new BadInput(`context_lines must not exceed ${MAX_CONTEXT} (got ${requested})`);
  }
  if (requested === 0) return DEFAULT_CONTEXT;
  return requested === -1 ? 0 : requested;
}

/** Returns name if non-empty, else fallback. */
export function nameOr(name: string, fallback: string): string {
  return name ? name : fallback;
}

/**
 * Strips jsdiff's leading "======" index separator so the emitted text is
 * byte-for-byte standard unified diff, as GNU `diff -u` produces it. Only that
 * one known constant line is removed; the diff body is never rewritten.
 */
export function stripIndexSeparator(patch: string): string {
  return patch.startsWith(INDEX_SEPARATOR) ? patch.slice(INDEX_SEPARATOR.length) : patch;
}

/**
 * Converts jsdiff hunks into proto Hunk messages, in UNIFIED-DIFF numbering.
 *
 * jsdiff's in-memory hunks and its text output disagree for a hunk against an
 * empty side: structuredPatch reports oldStart 1 with oldLines 0, while the
 * emitted header — and GNU diff — say `@@ -0,0 +1,N @@`, and parsePatch reads
 * that back as 0. The envelope commits to the TEXT numbering, so a Patch's hunk
 * numbers always match its own unified_diff and a parsed patch is
 * indistinguishable from a generated one.
 *
 * (jsdiff's own formatPatch performs this adjustment by MUTATING the hunk in
 * place, so formatting the same patch twice corrupts it — `@@ -0,0` becomes
 * `@@ --1,0`. Doing the conversion explicitly here keeps that side effect from
 * silently deciding what this package publishes.)
 */
export function toProtoHunks(hunks: StructuredPatch['hunks']): Hunk[] {
  return hunks.map((h) => {
    const out = new Hunk();
    out.setOldStart(h.oldLines === 0 ? h.oldStart - 1 : h.oldStart);
    out.setOldLines(h.oldLines);
    out.setNewStart(h.newLines === 0 ? h.newStart - 1 : h.newStart);
    out.setNewLines(h.newLines);
    out.setLinesList([...h.lines]);
    return out;
  });
}

/**
 * Converts proto Hunks back into the shape jsdiff's applyPatch consumes,
 * validating each one. A hunk with a non-finite or non-positive start, a
 * negative length, or a body line carrying an unknown prefix is rejected rather
 * than guessed at — jsdiff itself is permissive here and would otherwise
 * silently misapply or refuse without explanation.
 */
export function fromProtoHunks(hunks: Hunk[]): StructuredPatch['hunks'] {
  let totalLines = 0;
  for (const h of hunks) totalLines += h.getLinesList().length;
  if (totalLines > MAX_LINES) {
    throw new BadInput(
      `patch hunks span more than ${MAX_LINES} lines in total (got ${totalLines})`,
    );
  }

  return hunks.map((h, i) => {
    const oldStart = h.getOldStart();
    const newStart = h.getNewStart();
    const oldLines = h.getOldLines();
    const newLines = h.getNewLines();

    if (!Number.isInteger(oldStart) || !Number.isInteger(newStart)) {
      throw new BadInput(`hunk ${i} has a non-integer start line`);
    }
    // Unified-diff line numbers are 1-based, EXCEPT that a hunk against an empty
    // side legitimately starts at 0 (`@@ -0,0 +1,3 @@`), which is what GNU diff
    // emits when a file is created or emptied. Rejecting 0 would refuse a valid
    // patch, so only negative starts are invalid.
    if (oldStart < 0 || newStart < 0) {
      throw new BadInput(`hunk ${i} has a negative start line`);
    }
    if (oldLines < 0 || newLines < 0) {
      throw new BadInput(`hunk ${i} has a negative line count`);
    }

    const lines = h.getLinesList();
    for (const line of lines) {
      const prefix = line.charAt(0);
      if (line !== '' && prefix !== ' ' && prefix !== '-' && prefix !== '+' && prefix !== '\\') {
        throw new BadInput(
          `hunk ${i} has a body line with an unknown prefix ${JSON.stringify(prefix)} ` +
            `(expected " ", "-", "+", or "\\")`,
        );
      }
    }

    // Back to jsdiff's in-memory convention (see toProtoHunks): an empty-side
    // hunk is stored as 0 in unified-diff text but must be 1 in the object the
    // applier consumes, or it silently appends a spurious trailing newline.
    return {
      oldStart: oldLines === 0 ? oldStart + 1 : oldStart,
      oldLines,
      newStart: newLines === 0 ? newStart + 1 : newStart,
      newLines,
      lines: [...lines],
    };
  });
}

/** Extracts the "---" / "+++" header names from unified-diff text, if present. */
export function headerNames(unifiedDiff: string): { original: string; revised: string } {
  let original = 'original';
  let revised = 'revised';
  let sawOriginal = false;
  let sawRevised = false;

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) break;
    if (!sawOriginal && line.startsWith('--- ')) {
      sawOriginal = true;
      const v = line.slice(4).trim();
      if (v) original = v;
    } else if (!sawRevised && line.startsWith('+++ ')) {
      sawRevised = true;
      const v = line.slice(4).trim();
      if (v) revised = v;
    }
  }
  return { original, revised };
}
