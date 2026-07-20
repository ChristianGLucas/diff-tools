import { TextPair, Patch } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { structuredPatch, formatPatch } from 'diff';
import {
  checkBounds,
  contextLines,
  errorMessage,
  nameOr,
  stripIndexSeparator,
  toProtoHunks,
} from './lib';

/**
 * Compute the line-level difference between two texts, returned both as
 * standard unified-diff text and as structured hunks in one canonical Patch
 * envelope. The unified_diff field is byte-for-byte what GNU `diff -u` emits,
 * including the "\ No newline at end of file" marker, so it can be piped
 * straight to `git apply` or `patch`.
 *
 * Feeding the result to ApplyPatch reproduces the revised text exactly — trailing
 * newlines, CRLF line endings, and Unicode all round-trip unchanged. When the two
 * texts are identical the patch is empty, unified_diff is "", and identical is true.
 *
 * context_lines controls the unchanged lines shown around each hunk: 0 selects
 * the default of 3, and -1 means no context at all. Inputs above 1,000,000
 * characters or 5,000 lines, and context_lines outside -1..100, are rejected
 * with a structured error rather than a crash — the line bound is what keeps a
 * hostile pair of wholly-dissimilar texts from becoming a denial of service.
 *
 * Deterministic and fully offline.
 *
 * @param ax - Platform context: ax.log for logging, ax.secrets for secrets.
 */
export function diff(ax: AxiomContext, input: TextPair): Patch {
  try {
    const original = input.getOriginal() || '';
    const revised = input.getRevised() || '';
    checkBounds(original, 'original');
    checkBounds(revised, 'revised');

    const context = contextLines(input.getContextLines());
    const originalName = nameOr(input.getOriginalName() || '', 'original');
    const revisedName = nameOr(input.getRevisedName() || '', 'revised');

    const patch = structuredPatch(
      originalName,
      revisedName,
      original,
      revised,
      undefined,
      undefined,
      { context },
    );
    const identical = patch.hunks.length === 0;

    // formatPatch MUTATES the hunks it renders (it rewrites the start line of a
    // hunk against an empty side), so it gets a deep copy. Formatting twice, or
    // reading the hunks back after formatting, would otherwise corrupt them:
    // `@@ -0,0` degrades to `@@ --1,0`.
    const forFormatting = {
      ...patch,
      hunks: patch.hunks.map((h) => ({ ...h, lines: [...h.lines] })),
    };

    const out = new Patch();
    out.setUnifiedDiff(identical ? '' : stripIndexSeparator(formatPatch(forFormatting)));
    out.setHunksList(toProtoHunks(patch.hunks));
    out.setOriginalName(originalName);
    out.setRevisedName(revisedName);
    out.setIdentical(identical);

    ax.log.info('diff computed', { hunks: String(patch.hunks.length) });
    return out;
  } catch (e) {
    const out = new Patch();
    out.setError(errorMessage(e, 'diff'));
    return out;
  }
}
