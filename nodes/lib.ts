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
 * Converts proto Hunks back into the shape jsdiff's applyPatch consumes,
 * validating each one. A hunk with a non-finite or non-positive start, a
 * negative length, or a body line carrying an unknown prefix is rejected rather
 * than guessed at — jsdiff itself is permissive here and would otherwise
 * silently misapply or refuse without explanation.
 */
export function fromProtoHunks(hunks: Hunk[], original: string): StructuredPatch['hunks'] {
  // Indices of hunks carrying an end-of-file marker; those must be anchored.
  const markedHunks: number[] = [];
  const originalLines = countLines(original);
  const originalEndsWithNewline = original.length > 0 && original.charCodeAt(original.length - 1) === 10;
  // Bound every dimension the caller controls, on the RAW hunks, before any
  // conversion. Line count alone is not enough: a zero-line hunk contributes
  // nothing to that budget yet still drives a scan in the applier, and a body
  // line's LENGTH is unbounded, so 10,002 lines could carry gigabytes. Only the
  // gateway's ~1MB body limit stood behind these, and that is an external
  // control this node does not own.
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

  const converted = hunks.map((h, i) => {
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
    // ONLY old_start may be bounded by the original: it is the only start the
    // applier scans the given text for, so it is the only one carrying the DoS
    // risk — and it is the only one this node can bound correctly.
    //
    // new_start indexes the REVISED text, which ApplyPatch does not have and
    // which is LONGER than the original whenever the patch nets an insertion.
    // Bounding it by originalLines rejected ordinary multi-hunk patches — insert
    // a block early, edit further down, and the later hunk's new_start
    // legitimately exceeds the original's length — so ApplyPatch refused patches
    // Diff had just emitted. It gets the same sanity cap ParseUnifiedDiff uses.
    if (oldStart > originalLines + 1) {
      throw new BadInput(
        `hunk ${i} starts past the end of the text ` +
          `(old_start=${oldStart}, text has ${originalLines} lines)`,
      );
    }
    if (newStart > MAX_LINES + 1) {
      throw new BadInput(
        `hunk ${i} has new_start=${newStart}, beyond the maximum of ${MAX_LINES} lines`,
      );
    }

    const lines = h.getLinesList();
    let oldBody = 0; // lines the hunk consumes from the original: context + removed
    let newBody = 0; // lines the hunk produces in the revised text: context + added
    let markers = 0; // "\ No newline at end of file" markers seen in this hunk
    let sawMarker = false;
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
        // Enforce the invariant, rather than merely stating it. jsdiff's applier
        // scans the last hunk for ANY line starting with "\\" and, seeing the
        // PRECEDING line's side, strips that side's trailing newline. So a marker
        // parked mid-hunk after a "+" line silently removes the result's trailing
        // newline while the "@@" counts still balance — the validator and the
        // applier disagreeing about the same bytes again, and the round trip no
        // longer reproducing the revised text exactly. A marker is legal ONLY
        // where a side genuinely ends:
        //   - after a "-" line, when the new side follows (old side ends), or
        //   - as the hunk's final line (whichever side it terminates).
        const prev = lines[j - 1].charAt(0);
        const isLast = j === lines.length - 1;
        if (prev === '\\') {
          throw new BadInput(`hunk ${i} has consecutive ${JSON.stringify(NO_NEWLINE_MARKER)} markers`);
        }
        // Structural position. A marker terminates a RUN, so it is legal as the
        // hunk's final line (ending whichever side stops there — including a
        // shared context line, which is exactly what jsdiff's own formatter
        // emits when both texts end unterminated), or between the "-" run and
        // the "+" run, ending the OLD side only.
        if (!isLast && !(prev === '-' && lines[j + 1].charAt(0) === '+')) {
          throw new BadInput(
            `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker that does not terminate a side`,
          );
        }
        // A mid-hunk marker declares that the OLD side ends right here, so no
        // later line may belong to the old side. Checking only that a "+"
        // follows is not enough: a context line further down is on BOTH sides,
        // so the old side would in fact continue past the marker. jsdiff honours
        // the marker regardless and pushes a trailing newline, producing the
        // opposite of what a later marker in the same hunk declares.
        if (!isLast) {
          for (let k = j + 1; k < lines.length; k++) {
            const p2 = lines[k].charAt(0);
            const onOldSide = p2 === '-' || p2 === ' ' || lines[k] === '';
            if (onOldSide) {
              throw new BadInput(
                `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker for the original, ` +
                  `but the original side continues after it`,
              );
            }
          }
        }
        // CONSISTENCY with the text being patched. A marker is a DECLARATION —
        // "the side ending here has no trailing newline" — and jsdiff's EOFNL
        // prescan only ever acts on a marker preceded by "+" or "-". A marker
        // that makes a claim about the OLD side (preceded by "-", or by a
        // context line, which belongs to both sides) is therefore checkable
        // against the original we were handed, and must be refused when it
        // contradicts it. Without this a patch could declare "the result does
        // not end in a newline" against an original that does, the applier would
        // ignore the declaration, and the output would silently carry a newline
        // the patch forbade — the applied bytes disagreeing with the patch.
        if (prev !== '+' && originalEndsWithNewline) {
          throw new BadInput(
            `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker for the original, ` +
              `but the original does end with a newline`,
          );
        }
        sawMarker = true;
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

    if (lines.length === 0) {
      throw new BadInput(`hunk ${i} has an empty body`);
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

    // A marker is only MEANINGFUL for a hunk that actually reaches the end of the
    // file, and jsdiff enforces nothing of the kind: its EOFNL pass scans only
    // the LAST hunk for a "\\" line, reads the preceding line's prefix, and then
    // pops or pushes a trailing empty line on the WHOLE result before any hunk is
    // fitted. So a structurally-legal marker on a hunk that touches line 1 of a
    // long file silently adds or removes the trailing newline of the entire
    // output, with the "@@" counts still balancing and applied coming back true.
    // Validating the marker's neighbours is therefore not enough — the side it
    // claims to terminate must genuinely end at EOF, and only the final hunk can.
    if (sawMarker) {
      if (i !== hunks.length - 1) {
        throw new BadInput(
          `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker but is not the last hunk`,
        );
      }
      // Where the old side stops. A hunk that consumes nothing (a pure addition,
      // e.g. against an empty original) stops at its own start.
      const endOfOldSide = oldBody > 0 ? oldStart + oldBody - 1 : oldStart;
      if (endOfOldSide !== originalLines) {
        throw new BadInput(
          `hunk ${i} has a ${JSON.stringify(NO_NEWLINE_MARKER)} marker but does not reach the end ` +
            `of the text (hunk ends at line ${endOfOldSide}, text has ${originalLines} lines)`,
        );
      }
    }

    if (sawMarker) markedHunks.push(i);

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

  assertMarkedHunksAnchored(converted, markedHunks, original);
  return converted;
}

/**
 * Refuses a marker-bearing hunk that would not apply exactly where it says.
 *
 * A marker is a claim about the END OF THE FILE, so its meaning depends on the
 * hunk's ABSOLUTE position — but jsdiff does not pin position. When the declared
 * location's context does not match it RELOCATES the hunk and applies it
 * elsewhere, while its end-of-file pass runs BEFORE any hunk is fitted and
 * adjusts the trailing newline regardless. So a patch declaring "the line I add
 * is last and unterminated" could be relocated into the middle of the file and
 * silently strip the newline from a different final line it never mentions,
 * returning applied:true.
 *
 * Validating the declared position — which the caller controls — cannot secure a
 * relocating applier, so anchor instead: with a marker present, the hunk's
 * old-side lines must match the text exactly at the declared start, making
 * declared and actual position the same and the EOF reasoning sound. Unmarked
 * hunks keep jsdiff's normal relocation, which is standard patch(1) semantics.
 */
function assertMarkedHunksAnchored(
  hunks: StructuredPatch['hunks'],
  markedHunks: number[],
  original: string,
): void {
  if (markedHunks.length === 0) return;
  const textLines = original.split('\n');
  // A trailing newline closes the last line rather than starting an empty one.
  if (textLines.length > 0 && textLines[textLines.length - 1] === '') textLines.pop();

  for (const i of markedHunks) {
    const h = hunks[i];
    const oldSide: string[] = [];
    for (const line of h.lines) {
      const prefix = line.charAt(0);
      if (prefix === '\\') continue;
      if (prefix === '-' || prefix === ' ' || line === '') oldSide.push(line.slice(1));
    }
    for (let k = 0; k < oldSide.length; k++) {
      if (textLines[h.oldStart - 1 + k] !== oldSide[k]) {
        throw new BadInput(
          `patch does not apply to this text: hunk ${i} declares the end of the file, so it must ` +
            `match exactly at its declared line ${h.oldStart}, and it does not`,
        );
      }
    }
  }
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
