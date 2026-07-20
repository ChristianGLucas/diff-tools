import { Texts, SimilarityScore } from '../gen/messages_pb';
import { AxiomContext } from '../gen/axiomContext';
import { diffLines } from 'diff';
import { checkBounds, countLines, errorMessage } from './lib';

/**
 * Score how similar two texts are at line granularity, from their line diff.
 *
 * ratio is 2 * matching_lines / (original_lines + revised_lines): 1.0 for
 * identical texts, 0.0 when they share no line, and always within [0.0, 1.0].
 * matching_lines counts the lines the diff leaves untouched. Two empty texts —
 * zero lines each — score 1.0 by definition, and an empty text against a
 * non-empty one scores 0.0 without dividing by zero.
 *
 * An empty text is zero lines, and a trailing newline closes the last line
 * rather than adding an empty one, so "a\nb" and "a\nb\n" are both two lines.
 * A line carries its terminator, though, so "b" and "b\n" are NOT the same
 * line: adding or removing a trailing newline is a real change here, exactly as
 * Diff and Stats report it. Input above 1,000,000 characters or 5,000 lines is
 * rejected with a structured error rather than a crash.
 *
 * Use Stats when you want the counts of what changed; use this when you want a
 * single comparable number. Deterministic and fully offline.
 *
 * @param ax - Platform context: ax.log for logging, ax.secrets for secrets.
 */
export function similarity(ax: AxiomContext, input: Texts): SimilarityScore {
  try {
    const original = input.getOriginal() || '';
    const revised = input.getRevised() || '';
    checkBounds(original, 'original');
    checkBounds(revised, 'revised');

    const originalLines = countLines(original);
    const revisedLines = countLines(revised);

    let matching = 0;
    for (const part of diffLines(original, revised)) {
      if (!part.added && !part.removed) {
        matching += countLines(part.value);
      }
    }

    const total = originalLines + revisedLines;
    const ratio = total === 0 ? 1 : (2 * matching) / total;

    const out = new SimilarityScore();
    out.setRatio(ratio);
    out.setMatchingLines(matching);
    out.setOriginalLines(originalLines);
    out.setRevisedLines(revisedLines);

    ax.log.info('similarity computed', { ratio: String(ratio) });
    return out;
  } catch (e) {
    const err = new SimilarityScore();
    err.setError(errorMessage(e, 'scoring similarity'));
    return err;
  }
}
