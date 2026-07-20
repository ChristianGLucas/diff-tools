import { TextPair, DiffStats } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { diffLines } from 'diff';
import { checkBounds, countLines, errorMessage } from './lib';

/**
 * Count what changed between two texts — lines added, lines deleted, and how
 * many contiguous blocks changed — without returning the diff itself.
 *
 * lines_added counts every line only the revised text has; lines_deleted counts
 * every line only the original has. A modified line therefore counts once as
 * added and once as deleted, the same convention `git diff --shortstat` uses.
 * changed_blocks is the number of contiguous changed regions, so a one-line edit
 * and a fifty-line edit in one place each count as a single block.
 *
 * An empty text is zero lines, and a trailing newline closes the last line
 * rather than adding an empty one. A line carries its terminator, so adding or
 * removing a trailing newline counts as a changed line, matching what Diff
 * emits. Identical texts report all zeros with identical set to true. Input above
 * 1,000,000 characters or 5,000 lines is rejected with a structured error
 * rather than a crash.
 *
 * Use Diff when you need the change itself; use this for a cheap summary.
 * Deterministic and fully offline.
 *
 * @param ax - Platform context: ax.log for logging, ax.secrets for secrets.
 */
export function stats(ax: AxiomContext, input: TextPair): DiffStats {
  try {
    const original = input.getOriginal() || '';
    const revised = input.getRevised() || '';
    checkBounds(original, 'original');
    checkBounds(revised, 'revised');

    let added = 0;
    let deleted = 0;
    let blocks = 0;
    let inBlock = false;

    for (const part of diffLines(original, revised)) {
      if (part.added || part.removed) {
        if (part.added) added += countLines(part.value);
        if (part.removed) deleted += countLines(part.value);
        if (!inBlock) {
          blocks++;
          inBlock = true;
        }
      } else {
        inBlock = false;
      }
    }

    const out = new DiffStats();
    out.setLinesAdded(added);
    out.setLinesDeleted(deleted);
    out.setChangedBlocks(blocks);
    out.setOriginalLines(countLines(original));
    out.setRevisedLines(countLines(revised));
    out.setIdentical(added === 0 && deleted === 0);

    ax.log.info('stats computed', { added: String(added), deleted: String(deleted) });
    return out;
  } catch (e) {
    const err = new DiffStats();
    err.setError(errorMessage(e, 'computing stats'));
    return err;
  }
}
