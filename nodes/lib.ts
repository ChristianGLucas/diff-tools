// Shared bounds, conversions, line accounting, and the patch applier for the
// diff-tools nodes. Not a node and not a test file, so it is neither registered
// nor collected.
//
// The algorithmically hard parts that this package does NOT own — computing the
// diff, and formatting/parsing unified-diff text — belong to jsdiff. Applying a
// structured patch, by contrast, is done HERE (splitLines/toApplyHunks/
// applyStructuredPatch): it is a fully-specified, exact transformation, and
// delegating it to jsdiff's positioning and end-of-file heuristics was the
// source of a whole class of trailing-newline and relocation corruption bugs.
// Owning the applier means this package's model of a patch IS the behaviour,
// with no second interpreter to disagree with.
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
 * The cap bounds LINES, which is NOT the product that drives cost — line LENGTH
 * multiplies the per-comparison cost on top of O(N*D). Measured: 5,000 thin
 * dissimilar lines cost ~6.7s, while 5,000 dissimilar lines of ~88 characters
 * (a ~900KB request, inside every declared bound) cost ~9.1s. So thin lines are
 * NOT the worst case, and MAX_CHARS is the bound that actually constrains the
 * fat-line end. Both caps are needed; neither alone is sufficient.
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

/**
 * Maximum characters accepted for a patch expressed as unified-diff TEXT.
 *
 * Same reasoning as MAX_PATCH_LINES, for the other dimension: the text form
 * carries both sides plus a one-character prefix per line and the "@@"/"---"
 * headers, so it is inherently larger than either text it describes.
 */
export const MAX_PATCH_CHARS = 2 * MAX_CHARS + 4096;

/**
 * Maximum LINES accepted for a patch expressed as unified-diff TEXT.
 *
 * Larger than MAX_PATCH_LINES because the text form carries structure the hunk
 * bodies do not: two "---"/"+++" file headers, one "@@" header per hunk, and up
 * to two end-of-file markers. A hunk needs at least one body line, so the hunk
 * headers cannot outnumber the body; allowing MAX_LINES of them plus a small
 * constant covers any patch this package can produce or accept. Parsing is
 * linear, and the quadratic cost lives in the diff, not here — so this bound
 * exists to keep the document finite, not to throttle an algorithm.
 */
export const MAX_PATCH_TEXT_LINES = MAX_PATCH_LINES + MAX_LINES + 8;

/**
 * Rejects an oversized patch supplied as unified-diff TEXT.
 *
 * A diff is a PATCH, not a text, and must be budgeted as one on EVERY path that
 * accepts a patch. Validating diff text with checkBounds applied the 5,000-LINE
 * *text* cap to a document that is inherently ~2x the size of what it describes,
 * so `Diff` emitted a diff that `ApplyPatch` then refused above ~2,500 changed
 * lines — the round-trip guarantee breaking on the scalar path exactly as it had
 * on the hunks path, for the same reason.
 */
export function checkPatchBounds(text: string, label: string): void {
  if (text.length > MAX_PATCH_CHARS) {
    throw new BadInput(
      `${label} exceeds the maximum of ${MAX_PATCH_CHARS} characters (got ${text.length})`,
    );
  }
  const lines = countLines(text);
  if (lines > MAX_PATCH_TEXT_LINES) {
    throw new BadInput(
      `${label} exceeds the maximum of ${MAX_PATCH_TEXT_LINES} lines (got ${lines})`,
    );
  }
}

/**
 * Maximum number of hunks in a single patch.
 *
 * DERIVED from MAX_LINES, not chosen: a hunk needs at least one changed line,
 * so an N-line original cannot produce more than N hunks — that is the true
 * structural ceiling. A flat 2,000 was smaller than what Diff itself can emit
 * (5,000 lines with every other line changed at `context_lines: -1` yields
 * 2,500 hunks), so ApplyPatch refused patches Diff had just produced, breaking
 * the same round-trip guarantee the line and character budgets exist to keep.
 * Every budget here must admit any patch Diff can emit; none may be set
 * independently of the input caps.
 *
 * Hunk count still needs its OWN bound — the line budget does not constrain it,
 * since a hunk drives a locate-scan in the applier regardless of its size.
 */
export const MAX_HUNKS = MAX_LINES;

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
  // Also reject bidi controls and zero-width characters. These split no line for
  // any parser, so they cannot forge a header — but they make a name RENDER as a
  // different path than it is in any terminal, editor, or review UI that shows
  // the diff, which is its own deception. A path field has no use for them.
  if (name && /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/.test(name)) {
    throw new BadInput(
      'original_name / revised_name must not contain control, bidi, or zero-width characters',
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
 * A single text line: its content, plus whether it was terminated by a newline.
 *
 * Only the LAST line of a well-formed text may be unterminated. This model is
 * the whole reason ApplyPatch no longer delegates application to jsdiff: the
 * trailing newline is an explicit property of a specific line, not a global
 * flag inferred from a "\" marker's position, so there is no second interpreter
 * to disagree with about what the same bytes mean.
 */
export interface Line {
  content: string;
  /** True when this line is followed by a "\n" in the text. */
  eol: boolean;
}

/**
 * Splits a text into lines under this package's model, the exact inverse of
 * joinLines: an empty text is zero lines; "\n" separates lines; a trailing "\n"
 * closes the final line rather than beginning an empty one, so only the last
 * line may be unterminated ("a\nb\n" -> [a•, b•]; "a\nb" -> [a•, b]).
 *
 * Crucially there is NO phantom trailing element — the source of an entire class
 * of the older apply path's newline bugs, where jsdiff applied against
 * `source.split('\n')` and a hunk could address the "" that split appends to a
 * newline-terminated text. Here that "" is never a line, so nothing can address
 * it, and the trailing newline can only change if a hunk's own line says so.
 */
export function splitLines(text: string): Line[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const trailingNewline = parts[parts.length - 1] === '';
  const n = trailingNewline ? parts.length - 1 : parts.length;
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    lines.push({ content: parts[i], eol: trailingNewline || i < n - 1 });
  }
  return lines;
}

/** Reconstructs text from lines; the exact byte-for-byte inverse of splitLines. */
export function joinLines(lines: Line[]): string {
  let out = '';
  for (const l of lines) out += l.eol ? l.content + '\n' : l.content;
  return out;
}

/**
 * A hunk parsed for exact application: the old and new sides as explicit Line
 * runs (each line's newline resolved from any "\" marker), plus the declared
 * old-side start in unified-diff numbering.
 */
export interface ApplyHunk {
  /** Position of this hunk in the patch, for error messages. */
  index: number;
  /** As-written old-side start (1-based; 0 for a zero-line side, e.g. "@@ -0,0"). */
  oldStart: number;
  /** The lines the hunk consumes from the original (context + removed), in order. */
  old: Line[];
  /** The lines the hunk produces in the revised text (context + added), in order. */
  new: Line[];
}

/** No line but the last of a side may be unterminated; a marker elsewhere is malformed. */
function assertOnlyLastUnterminated(side: Line[], hunk: number, which: string): void {
  for (let k = 0; k < side.length - 1; k++) {
    if (!side[k].eol) {
      throw new BadInput(
        `hunk ${hunk} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker on a non-final line of the ` +
          `${which} side; only the last line of a side may lack a trailing newline`,
      );
    }
  }
}

/**
 * Parses proto Hunks into the explicit-Line form applyStructuredPatch consumes,
 * validating each one structurally. This validates that the patch is
 * WELL-FORMED — legal prefixes, a legal marker in a legal place, header counts
 * that match the body, sane bounds. It deliberately does NOT try to predict what
 * an applier will DO with the patch (which line moves, whether a marker changes
 * the trailing newline): that is the applier's job, done by exact matching
 * against the actual text, so there is no divergence between a validator's model
 * and an applier's behaviour to exploit.
 *
 * A "\" marker sets eol=false on the last line of whichever side(s) the
 * preceding body line belonged to — a context line belongs to both sides, so a
 * marker after one marks both, exactly as a shared unterminated final line
 * means. A hunk with a non-integer or negative start/count, an unknown body
 * prefix, an illegal or misplaced marker, or a header whose counts disagree with
 * its body is rejected here rather than misapplied later.
 */
export function toApplyHunks(hunks: Hunk[]): ApplyHunk[] {
  // Bound every dimension the caller controls, on the RAW hunks, before any
  // allocation. Line count alone is not enough: a body line's LENGTH is
  // unbounded, so few lines could still carry gigabytes. Only the gateway's
  // ~1MB body limit stood behind these, an external control this node does not
  // own. (The old start-magnitude DoS is gone independently of these bounds:
  // applyStructuredPatch indexes the text directly and refuses an out-of-range
  // start in O(1), never scanning outward from it as jsdiff's applier did.)
  if (hunks.length > MAX_HUNKS) {
    throw new BadInput(`patch has more than ${MAX_HUNKS} hunks (got ${hunks.length})`);
  }
  let totalLines = 0;
  let totalChars = 0;
  for (const h of hunks) {
    const body = h.getLinesList();
    totalLines += body.length;
    for (const line of body) totalChars += line.length;
  }
  if (totalLines > MAX_PATCH_LINES) {
    throw new BadInput(
      `patch hunks span more than ${MAX_PATCH_LINES} lines in total (got ${totalLines})`,
    );
  }
  if (totalChars > MAX_PATCH_CHARS) {
    throw new BadInput(
      `patch hunks span more than ${MAX_PATCH_CHARS} characters in total (got ${totalChars})`,
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
    // emits when a file is created or emptied. Only negative starts are invalid.
    if (oldStart < 0 || newStart < 0) {
      throw new BadInput(`hunk ${i} has a negative start line`);
    }
    if (oldLines < 0 || newLines < 0) {
      throw new BadInput(`hunk ${i} has a negative line count`);
    }
    // A sane upper bound on the declared numbering, kept identical to the bound
    // ParseUnifiedDiff enforces so the two readers of one patch agree. This is
    // no longer load-bearing for cost (the applier bounds the real work against
    // the actual text), but a clean early rejection beats a confusing one, and
    // new_start is otherwise unused: the applier emits the new side in order and
    // never trusts a caller-declared revised position, so a lying new_start
    // cannot misplace a line — it just gets a sanity check.
    if (oldStart > MAX_LINES + 1) {
      throw new BadInput(
        `hunk ${i} has old_start=${oldStart}, beyond the maximum of ${MAX_LINES} lines`,
      );
    }
    if (newStart > MAX_LINES + 1) {
      throw new BadInput(
        `hunk ${i} has new_start=${newStart}, beyond the maximum of ${MAX_LINES} lines`,
      );
    }

    const body = h.getLinesList();
    if (body.length === 0) {
      throw new BadInput(`hunk ${i} has an empty body`);
    }

    const oldSide: Line[] = [];
    const newSide: Line[] = [];
    // The side(s) the previous non-marker body line appended to, so a following
    // marker knows which line(s) it unterminates. Empty means the previous line
    // was itself a marker (or we are at the start) — no marker may follow.
    let prevSides: Line[][] = [];
    for (let j = 0; j < body.length; j++) {
      const line = body[j];
      const prefix = line.charAt(0);
      if (prefix === '\\') {
        // The only legal "\" line is the end-of-file marker.
        if (line !== NO_NEWLINE_MARKER) {
          throw new BadInput(
            `hunk ${i} has a "\\" body line that is not ${JSON.stringify(NO_NEWLINE_MARKER)}`,
          );
        }
        if (prevSides.length === 0) {
          throw new BadInput(
            `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker that does not follow a body line`,
          );
        }
        // The marker declares the preceding line unterminated. A context line is
        // on both sides, so a marker after it unterminates both — exactly the
        // meaning of a shared final line that ends without a newline.
        for (const side of prevSides) side[side.length - 1].eol = false;
        prevSides = []; // a marker cannot be followed immediately by another marker
        continue;
      }
      if (line !== '' && prefix !== ' ' && prefix !== '-' && prefix !== '+') {
        throw new BadInput(
          `hunk ${i} has a body line with an unknown prefix ${JSON.stringify(prefix)} ` +
            `(expected " ", "-", "+", or "\\")`,
        );
      }
      // A " "-prefixed line is context; so is a bare "" line — real unified diffs
      // routinely lose the single space on a blank context line (git send-email,
      // mailing lists, editors that strip trailing whitespace). Content is the
      // line minus its one-character prefix ("" stays "").
      const content = line === '' ? '' : line.slice(1);
      if (prefix === '-') {
        oldSide.push({ content, eol: true });
        prevSides = [oldSide];
      } else if (prefix === '+') {
        newSide.push({ content, eol: true });
        prevSides = [newSide];
      } else {
        oldSide.push({ content, eol: true });
        newSide.push({ content, eol: true });
        prevSides = [oldSide, newSide];
      }
    }

    // The "@@" header's declared counts must match the body the hunk carries.
    // A header that lied about its size but still applied would let a Patch's
    // header and body silently disagree.
    if (oldLines !== oldSide.length || newLines !== newSide.length) {
      throw new BadInput(
        `hunk ${i} header (old_lines=${oldLines}, new_lines=${newLines}) does not match its body ` +
          `(counted old=${oldSide.length}, new=${newSide.length})`,
      );
    }

    // A marker may only unterminate the LAST line of a side. A marker that
    // leaves a non-final line unterminated describes a text that cannot exist
    // (only the last line of a text lacks a newline), so it is malformed. This
    // one structural rule replaces all the older path's marker-position
    // gymnastics, because the applier enforces the SEMANTICS by exact match.
    assertOnlyLastUnterminated(oldSide, i, 'original');
    assertOnlyLastUnterminated(newSide, i, 'revised');

    return { index: i, oldStart, old: oldSide, new: newSide };
  });
}

/**
 * Applies structured hunks to a text EXACTLY, and is the whole point of the
 * redesign: it never delegates application to jsdiff, so no second interpreter
 * can disagree with this package's model of the patch. Every one of the apply
 * path's historical corruption bugs was that disagreement — jsdiff relocating a
 * hunk, resolving a bare "" line, or stripping a trailing newline in a prescan,
 * differently from what the package's validator predicted. Here the package IS
 * the applier, so its model is the behaviour by construction.
 *
 * Semantics, all standard and all enforced against the ACTUAL text:
 *  - Position is pinned to the declared line. Each hunk's old side must match the
 *    text exactly — content AND trailing-newline — starting at its declared
 *    line. No fuzz, no relocation: a mismatch is refused, never applied
 *    elsewhere. (This is stricter than patch(1), and deliberately so — it is the
 *    exact round-trip contract Diff's output relies on.)
 *  - Hunks apply left to right; one that overlaps or precedes an already-applied
 *    hunk, or that starts past the end of the text, is refused.
 *  - The trailing newline of the result is whatever the hunks' own lines say via
 *    their "\" markers, applied to specific lines — it is never inferred from a
 *    marker's position or a phantom split element.
 *
 * Throws BadInput on any non-application; the caller reports that as
 * applied:false with the reason, never a partial or half-patched text.
 */
export function applyStructuredPatch(original: string, hunks: ApplyHunk[]): string {
  const src = splitLines(original);
  const result: Line[] = [];
  let pos = 0; // next unconsumed index into src

  for (const h of hunks) {
    // Where the old side begins, 0-indexed. A zero-line old side ("@@ -L,0")
    // inserts AFTER original line L — 0-indexed position L (0 for start-of-file,
    // src.length for append). A non-empty old side's first line is 1-based line
    // oldStart — 0-indexed oldStart-1.
    const at = h.old.length === 0 ? h.oldStart : h.oldStart - 1;

    if (at < pos) {
      throw new BadInput(
        `patch does not apply to this text: hunk ${h.index} overlaps or precedes an earlier hunk`,
      );
    }
    if (at > src.length) {
      throw new BadInput(
        `patch does not apply to this text: hunk ${h.index} starts at line ${h.oldStart}, ` +
          `past the end of a ${src.length}-line text`,
      );
    }
    if (at + h.old.length > src.length) {
      throw new BadInput(
        `patch does not apply to this text: hunk ${h.index}'s context runs past the end of the text`,
      );
    }
    // Exact match of the old side against the text — content AND terminator.
    for (let k = 0; k < h.old.length; k++) {
      const s = src[at + k];
      const o = h.old[k];
      if (s.content !== o.content || s.eol !== o.eol) {
        throw new BadInput(
          `patch does not apply to this text: hunk ${h.index}'s context does not match at line ${at + k + 1}`,
        );
      }
    }
    // Copy the unchanged run before the hunk, then the hunk's new side.
    for (let k = pos; k < at; k++) result.push(src[k]);
    for (const l of h.new) result.push(l);
    pos = at + h.old.length;
  }
  for (let k = pos; k < src.length; k++) result.push(src[k]);

  // CLASS-CLOSING INVARIANT, checked on the APPLIED BYTES. A "\" marker sets its
  // line unterminated, but a line without a trailing newline can only be the
  // LAST line of a text. If a hunk marks its new side's final line unterminated
  // while more lines follow it in the result — a marker on any but the last
  // hunk, or on a hunk that does not actually reach the end of the file — then
  // joinLines would concatenate that line with the next, silently corrupting the
  // output. Refuse instead. This checks the OUTPUT, so it holds no matter how a
  // marker's position or the text conspire to reach it: the whole family of
  // end-of-file tricks the old delegated path lost seven rounds to is closed at
  // once, because a patch may only leave the file's true last line unterminated.
  for (let k = 0; k < result.length - 1; k++) {
    if (!result[k].eol) {
      throw new BadInput(
        `patch does not apply to this text: it marks line ${k + 1} of the result as having no ` +
          `trailing newline, but that line is not the end of the file`,
      );
    }
  }

  return joinLines(result);
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
