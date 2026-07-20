import { PatchApplyRequest, PatchApplyResult } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { applyPatch as jsApplyPatch } from 'diff';
import { checkBounds, errorMessage, fromProtoHunks, nameOr } from './lib';

/**
 * Apply a Patch to a text and return the patched result, completing the
 * Diff -> Patch -> ApplyPatch round trip: for any two texts, applying the patch
 * Diff produced reproduces the revised text exactly, including trailing
 * newlines, CRLF line endings, and Unicode.
 *
 * Only the patch's structured hunks are applied; its unified_diff field is
 * ignored. To apply a diff that arrived as unified-diff text — from git, `diff
 * -u`, or another agent — run it through ParseUnifiedDiff first.
 *
 * Matching is exact: when a hunk's context does not match the text, applied is
 * false and error says so. The node never fuzzy-matches, never applies a patch
 * partially, and never returns a half-patched text — on any failure, text is
 * empty. A hunk with a negative start line, a negative line count, or a body line
 * carrying an unknown prefix is rejected outright, as is an original above
 * 1,000,000 characters or 5,000 lines, or a patch spanning more than 5,000
 * lines. An empty patch is a no-op that returns the original unchanged.
 *
 * Deterministic and fully offline.
 *
 * @param ax - Platform context: ax.log for logging, ax.secrets for secrets.
 */
export function applyPatch(ax: AxiomContext, input: PatchApplyRequest): PatchApplyResult {
  try {
    const original = input.getOriginal() || '';
    checkBounds(original, 'original');

    const patch = input.getPatch();
    const hunks = fromProtoHunks(patch ? patch.getHunksList() : []);

    const out = new PatchApplyResult();
    if (hunks.length === 0) {
      out.setText(original);
      out.setApplied(true);
      return out;
    }

    const result = jsApplyPatch(original, {
      oldFileName: nameOr(patch ? patch.getOriginalName() : '', 'original'),
      newFileName: nameOr(patch ? patch.getRevisedName() : '', 'revised'),
      oldHeader: undefined,
      newHeader: undefined,
      hunks,
    });

    if (result === false) {
      out.setApplied(false);
      out.setError("patch does not apply to this text: a hunk's context does not match");
      return out;
    }

    ax.log.info('patch applied', { hunks: String(hunks.length) });
    out.setText(result);
    out.setApplied(true);
    return out;
  } catch (e) {
    const err = new PatchApplyResult();
    err.setApplied(false);
    err.setError(errorMessage(e, 'applying the patch'));
    return err;
  }
}
