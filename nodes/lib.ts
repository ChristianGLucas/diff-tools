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
 * Measured against the deployed nodes, that worst case runs roughly 2.0s at
 * 2,000 lines, 5.8s at 4,000, and ~7-8s at the 5,000-line cap (Diff, Similarity
 * and Stats all sit in that band, since they pay the same O(N*D)). Cost scales
 * superlinearly, reaching ~44s at 20,000 lines — so the cap is what keeps a
 * hostile input from becoming a denial of service, not a stylistic limit.
 *
 * Note the cap bounds LINES, not the N*D product that actually drives cost, so
 * the worst case here is genuinely the worst case: minimal-length wholly
 * dissimilar lines maximise line count per byte, which is why a ~30KB body can
 * buy several seconds of CPU.
 */
export const MAX_LINES = 5_000;

/**
 * Maximum body lines accepted across all hunks of a single patch.
 *
 * This is deliberately derived from MAX_LINES rather than set independently:
 * a patch body carries BOTH sides, so rewriting every line of an N-line text
 * yields ~2N body lines (each line once as "-", once as "+"), plus at most one
 * end-of-file marker per side. Capping the body at MAX_LINES made ApplyPatch
 * refuse patches that Diff had just emitted without error — the round-trip
 * guarantee broke at ~2,500 changed lines, well inside the input caps. The
 * budget must therefore admit any patch Diff itself can produce.
 */
export const MAX_PATCH_LINES = 2 * MAX_LINES + 2;

/** The only legal "\" body line in a unified diff. */
export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

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

/**
 * Returns a header name if non-empty, else the fallback — after rejecting any
 * name that could forge diff structure.
 *
 * original_name/revised_name flow verbatim into the "---"/"+++" header lines of
 * the emitted unified_diff. A name is a SINGLE header field, so it must not
 * contain a line break: a newline (or carriage return) in the name would let a
 * caller inject additional "---"/"+++"/"@@" lines and turn a single-file diff
 * into a forged multi-file patch that ParseUnifiedDiff or `git apply` would act
 * on. Reject rather than strip, so the caller learns their name was invalid.
 */
export function nameOr(name: string, fallback: string): string {
  if (name && /[\n\r]/.test(name)) {
    throw new BadInput('original_name / revised_name must not contain a line break');
  }
  // Beyond the line breaks that could forge diff structure, no control character
  // or Unicode line/paragraph separator belongs in a path field. None of these
  // terminate a line for jsdiff or `git apply` (both split on "\n" only), so
  // they cannot forge a header — but they survive verbatim into the "--- "/"+++ "
  // position, where NUL, VT, FF and the C1 range corrupt terminals and logs and
  // break downstream tools that treat the header as a filename.
  if (name && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
    throw new BadInput(
      'original_name / revised_name must not contain control characters or line separators',
    );
  }
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
export function fromProtoHunks(hunks: Hunk[], originalLines: number): StructuredPatch['hunks'] {
  let totalLines = 0;
  for (const h of hunks) totalLines += h.getLinesList().length;
  if (totalLines > MAX_PATCH_LINES) {
    throw new BadInput(
      `patch hunks span more than ${MAX_PATCH_LINES} lines in total (got ${totalLines})`,
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
    // A start line beyond the end of the text is not merely wrong, it is a
    // denial of service: jsdiff locates a hunk by scanning linearly outward from
    // the declared start, so the cost is linear in the START MAGNITUDE and is
    // bounded by nothing else here. The line and body caps do not constrain it —
    // a ~150-byte patch declaring oldStart 2147483647 pins a core for ~30s.
    // The applier is given the original, so the only sane bound is knowable:
    // a hunk cannot legitimately begin past one line after the text ends.
    const maxStart = originalLines + 1;
    if (oldStart > maxStart || newStart > maxStart) {
      throw new BadInput(
        `hunk ${i} starts past the end of the text ` +
          `(old_start=${oldStart}, new_start=${newStart}, text has ${originalLines} lines)`,
      );
    }

    const lines = h.getLinesList();
    let oldBody = 0; // lines the hunk consumes from the original: context + removed
    let newBody = 0; // lines the hunk produces in the revised text: context + added
    let markers = 0; // "\ No newline at end of file" markers seen in this hunk
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const prefix = line.charAt(0);
      if (line !== '' && prefix !== ' ' && prefix !== '-' && prefix !== '+' && prefix !== '\\') {
        throw new BadInput(
          `hunk ${i} has a body line with an unknown prefix ${JSON.stringify(prefix)} ` +
            `(expected " ", "-", "+", or "\\")`,
        );
      }
      if (prefix === '\\') {
        // The only legal backslash line is the end-of-file marker. jsdiff keys
        // its trailing-newline handling off the "\" prefix alone, so an
        // unchecked marker is both free payload and a way to steer that
        // behaviour from an arbitrary position in the body.
        if (line !== NO_NEWLINE_MARKER) {
          throw new BadInput(
            `hunk ${i} has a "\\" body line that is not ${JSON.stringify(NO_NEWLINE_MARKER)}`,
          );
        }
        // The marker terminates a RUN, not the hunk: it follows the last line of
        // whichever side lacks the trailing newline. When only the original side
        // lacks one, Diff emits it mid-hunk, between the "-" run and the "+" run
        // — so requiring it to be the hunk's final line would reject patches
        // this package itself produces. It must still follow a real body line,
        // and a hunk has at most two sides to terminate.
        if (j === 0) {
          throw new BadInput(
            `hunk ${i} begins with a ${JSON.stringify(NO_NEWLINE_MARKER)} marker`,
          );
        }
        if (lines[j - 1].charAt(0) === '\\') {
          throw new BadInput(`hunk ${i} has consecutive ${JSON.stringify(NO_NEWLINE_MARKER)} markers`);
        }
        markers++;
        if (markers > 2) {
          throw new BadInput(
            `hunk ${i} has more than two ${JSON.stringify(NO_NEWLINE_MARKER)} markers`,
          );
        }
        continue; // the marker itself consumes and produces nothing
      }
      if (prefix === '-') {
        oldBody++;
      } else if (prefix === '+') {
        newBody++;
      } else {
        // A " "-prefixed line is context. So is a bare "" line: real-world
        // unified diffs routinely lose the single space on a blank context line
        // (git send-email, mailing lists, editors that strip trailing
        // whitespace), and jsdiff's applier resolves an empty body line to a
        // context line — `hunkLine[0]` is undefined, so its operation defaults
        // to " ". Counting "" as neither side made this validator disagree with
        // the applier over the same bytes, which both accepted hunks whose
        // header understated their true reach and rejected honest headers.
        oldBody++;
        newBody++;
      }
    }

    // The @@ header's declared line counts must match the body the hunk actually
    // carries. jsdiff positions by the declared counts but edits by the body, so
    // a hunk whose header lies about its size would still "apply" — accepting
    // that would make a Patch's header and body silently disagree. Reject it.
    if (oldLines !== oldBody || newLines !== newBody) {
      throw new BadInput(
        `hunk ${i} header (old_lines=${oldLines}, new_lines=${newLines}) does not match its body ` +
          `(counted old=${oldBody}, new=${newBody})`,
      );
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

/** The filename portion of a "--- "/"+++ " header line: everything before the tab. */
function headerName(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab === -1 ? rest : rest.slice(0, tab)).trim();
}

/**
 * Extracts the "---" / "+++" header names from unified-diff text, if present.
 *
 * GNU `diff -u` appends a TAB-separated modification timestamp after the
 * filename ("--- f.txt\t2026-07-19 10:00:00.000000000 +0000"), and git accepts
 * the same form. The name is the field BEFORE that tab — cutting there is what
 * git and patch(1) do, and not doing it dragged the timestamp into
 * original_name/revised_name for every diff produced by the very tool this
 * node advertises it can read.
 */
export function headerNames(unifiedDiff: string): { original: string; revised: string } {
  let original = 'original';
  let revised = 'revised';
  let sawOriginal = false;
  let sawRevised = false;

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) break;
    if (!sawOriginal && line.startsWith('--- ')) {
      sawOriginal = true;
      const v = headerName(line);
      if (v) original = v;
    } else if (!sawRevised && line.startsWith('+++ ')) {
      sawRevised = true;
      const v = headerName(line);
      if (v) revised = v;
    }
  }
  return { original, revised };
}
