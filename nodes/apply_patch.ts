import { PatchApplyRequest, PatchApplyResult, UnifiedDiffText } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { applyPatch as jsApplyPatch } from 'diff';
import { checkBounds, countLines, errorMessage, fromProtoHunks, nameOr } from './lib';
import { parseUnifiedDiff } from './parse_unified_diff';

/** A refusal: never a partially-patched text, so text stays empty. */
function failed(reason: string): PatchApplyResult {
  const out = new PatchApplyResult();
  out.setApplied(false);
  out.setError(reason);
  return out;
}

/** Wraps raw unified-diff text in the message ParseUnifiedDiff consumes. */
function unifiedDiffInput(text: string): UnifiedDiffText {
  const msg = new UnifiedDiffText();
  msg.setUnifiedDiff(text);
  return msg;
}

/**
 * Apply a Patch to a text and return the patched result, completing the
 * Diff -> Patch -> ApplyPatch round trip: for any two texts, applying the patch
 * Diff produced reproduces the revised text exactly, including trailing
 * newlines, CRLF line endings, and Unicode.
 *
 * Supply the patch exactly one of two ways: `patch`, the canonical envelope
 * (its structured hunks are what get applied; the envelope's own unified_diff
 * field is ignored), or `unified_diff`, the same diff as text — from git, `diff
 * -u`, or another agent — which is parsed with the same strict reader
 * ParseUnifiedDiff uses. Setting both, or neither, is refused. The text form
 * exists so the chain composes inside a flow, where an edge can carry only
 * scalar leaves and the nested `patch` message cannot be routed.
 *
 * A patch carrying a non-empty error is REFUSED, never applied as a no-op: a
 * failed upstream step must not read as a successful identity. Likewise a patch
 * with no hunks is applied as an identity only when it is marked identical.
 *
 * Content matching is exact: when a hunk's context does not match the text,
 * applied is false and error says so. The node never fuzzy-matches content,
 * never applies a patch partially, and never returns a half-patched text — on
 * any failure, text is empty. POSITION, however, is not pinned: as with `git
 * apply` and patch(1), a hunk whose context matches may apply at an offset from
 * its declared line number.
 *
 * A hunk with a negative start line, a negative line count, a start beyond the
 * end of the text, a body line carrying an unknown prefix, or a "\" line that is
 * not exactly the end-of-file marker terminating a side is rejected outright, as
 * is an original above 1,000,000 characters or 5,000 lines, or a patch whose
 * hunks span more than 10,002 body lines.
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
    // Presence, not emptiness: a diff of two identical texts is legitimately the
    // empty string, so "" must still count as a supplied patch.
    const hasUnifiedDiff = input.hasUnifiedDiff();
    const unifiedDiff = input.getUnifiedDiff() || '';

    // A patch that failed upstream must not be mistaken for "nothing to do".
    // Diff and ParseUnifiedDiff report failure by returning a Patch whose error
    // is set and whose hunks are empty; applying that as a no-op would turn a
    // broken step into a successful-looking identity and hand the caller back
    // their unchanged text as though the patch had been honoured.
    if (patch && patch.getError()) {
      return failed(`patch carries an upstream error: ${patch.getError()}`);
    }

    // Exactly one source of hunks. Silently preferring one over the other would
    // make a caller who set both believe the ignored one had been applied.
    if (patch && hasUnifiedDiff) {
      return failed('supply either patch or unified_diff, not both');
    }
    if (!patch && !hasUnifiedDiff) {
      return failed('no patch supplied: set either patch or unified_diff');
    }

    let protoHunks;
    let identical: boolean;
    if (hasUnifiedDiff) {
      checkBounds(unifiedDiff, 'unified_diff');
      const parsed = parseUnifiedDiff(ax, unifiedDiffInput(unifiedDiff));
      if (parsed.getError()) {
        return failed(parsed.getError());
      }
      protoHunks = parsed.getHunksList();
      identical = parsed.getIdentical();
    } else {
      protoHunks = patch!.getHunksList();
      identical = patch!.getIdentical();
    }

    // An empty hunk list is a legal identity apply only when the producer said
    // so. Otherwise it is a malformed patch — most often a Patch whose
    // unified_diff was populated but whose hunks were never parsed — and
    // returning the original unchanged would silently discard the caller's edit.
    if (protoHunks.length === 0 && !identical) {
      return failed('patch has no hunks and is not marked identical');
    }

    const hunks = fromProtoHunks(protoHunks, countLines(original));

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
