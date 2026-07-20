import { UnifiedDiffText, Patch } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { parsePatch } from 'diff';
import { BadInput, MAX_LINES, checkPatchBounds, errorMessage, headerNames, nameOr, toProtoHunks } from './lib';

/**
 * Parse standard unified-diff text (---/+++/@@ hunks) into the canonical Patch
 * envelope, so a diff produced anywhere — git, `diff -u`, another agent — can be
 * fed straight into ApplyPatch.
 *
 * The returned patch carries the structured hunks parsed from the input and
 * echoes back the unified_diff it was given. original_name and revised_name come
 * from the "---" and "+++" header lines when present, defaulting to "original"
 * and "revised". Empty or whitespace-only input parses to an empty patch with
 * identical set to true.
 *
 * Input that is not unified-diff format is REJECTED, not silently treated as an
 * empty patch: prose that merely talks about a change, a malformed @@ header, or
 * a hunk with an unparseable line number all return a structured error. That
 * strictness is deliberate — silently reporting "no changes" for a diff the
 * caller believed was real is the dangerous failure here. Multi-file diffs are
 * also rejected, since this envelope describes exactly one file; split them and
 * parse each separately. A diff document is budgeted as a PATCH rather than as a
 * text — it carries both sides, so it is inherently about twice the size of
 * either text it describes — and one above 2,004,096 characters or 15,010 lines
 * is rejected with a structured error, as is a hunk whose "@@" header declares a
 * line number beyond the 5,000-line input cap.
 *
 * Deterministic and fully offline.
 *
 * @param ax - Platform context: ax.log for logging, ax.secrets for secrets.
 */
export function parseUnifiedDiff(ax: AxiomContext, input: UnifiedDiffText): Patch {
  try {
    const text = input.getUnifiedDiff() || '';
    checkPatchBounds(text, 'unified_diff');

    const out = new Patch();

    if (text.trim() === '') {
      out.setOriginalName('original');
      out.setRevisedName('revised');
      out.setIdentical(true);
      return out;
    }

    // jsdiff is permissive: prose parses to a patch with zero hunks, which would
    // read as "no changes". Require the input to actually look like a diff first.
    const lines = text.split('\n');
    const hasHunkHeader = lines.some((l) => l.startsWith('@@'));
    const hasFileHeaders =
      lines.some((l) => l.startsWith('--- ')) && lines.some((l) => l.startsWith('+++ '));
    if (!hasHunkHeader && !hasFileHeaders) {
      throw new BadInput(
        'unified_diff is not in unified-diff format: no "@@" hunk header and no "---"/"+++" file headers',
      );
    }

    let parsed;
    try {
      parsed = parsePatch(text);
    } catch (e) {
      throw new BadInput(
        `unified_diff is not valid unified-diff format: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (parsed.length > 1) {
      throw new BadInput(
        `unified_diff describes ${parsed.length} files; this envelope holds one file — split the diff and parse each separately`,
      );
    }

    const hunks = parsed.length === 0 ? [] : parsed[0].hunks;

    // A malformed "@@" header yields a hunk with null/NaN line numbers rather
    // than an exception; reject those instead of passing them to ApplyPatch.
    hunks.forEach((h, i) => {
      for (const [field, value] of [
        ['old_start', h.oldStart],
        ['old_lines', h.oldLines],
        ['new_start', h.newStart],
        ['new_lines', h.newLines],
      ] as const) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BadInput(
            `unified_diff has a malformed hunk header at hunk ${i}: ${field} is not a number`,
          );
        }
        if (value < 0) {
          throw new BadInput(
            `unified_diff has a negative ${field} at hunk ${i}`,
          );
        }
        // Refuse an absurd line number here rather than laundering it into a
        // Patch envelope. ApplyPatch bounds starts against the text it is given,
        // but a Patch minted from hostile diff TEXT would otherwise travel
        // through a flow as a loaded gun: jsdiff's applier scans linearly from
        // the declared start, so a header of "@@ -2000000000,1 +2000000000,1 @@"
        // costs ~30s of CPU at the far end. No line number in a diff this
        // package will accept can legitimately exceed the input line cap.
        if (value > MAX_LINES) {
          throw new BadInput(
            `unified_diff has ${field}=${value} at hunk ${i}, beyond the maximum of ${MAX_LINES} lines`,
          );
        }
      }
    });

    if (hasHunkHeader && hunks.length === 0) {
      throw new BadInput(
        'unified_diff has an "@@" header but no hunk could be parsed from it',
      );
    }

    // Route parsed names through the SAME validator Diff uses. Otherwise the two
    // producers of this envelope disagree about what a legal name is, and a
    // Patch minted from hostile diff text could carry a name Diff itself would
    // have refused — laundered through a flow to whatever consumes it next.
    const names = headerNames(text);
    out.setUnifiedDiff(text);
    out.setHunksList(toProtoHunks(hunks));
    out.setOriginalName(nameOr(names.original, 'original'));
    out.setRevisedName(nameOr(names.revised, 'revised'));
    out.setIdentical(hunks.length === 0);

    ax.log.info('unified diff parsed', { hunks: String(hunks.length) });
    return out;
  } catch (e) {
    const err = new Patch();
    err.setError(errorMessage(e, 'parsing the unified diff'));
    return err;
  }
}
