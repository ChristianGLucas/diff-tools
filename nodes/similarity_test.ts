import { similarity } from './similarity';
import { Texts } from '../gen/messages_pb';
import { ctx, CORPUS, lcsLength, splitLines } from './testkit';
import { MAX_CHARS, MAX_LINES } from './lib';

function score(original: string, revised: string) {
  const input = new Texts();
  input.setOriginal(original);
  input.setRevised(revised);
  return similarity(ctx, input);
}

describe('Similarity', () => {
  it('GOLDEN: a hand-computed score of 2*4/(5+5) = 0.8', () => {
    const out = score('line1\nline2\nline3\nline4\nline5', 'line1\nline2\nCHANGED\nline4\nline5');
    expect(out.getError()).toBe('');
    expect(out.getRatio()).toBeCloseTo(0.8, 12);
    expect(out.getMatchingLines()).toBe(4);
    expect(out.getOriginalLines()).toBe(5);
    expect(out.getRevisedLines()).toBe(5);
  });

  it('GOLDEN: an asymmetric pair where appending changes the old last line', () => {
    // "a\nb\nc" is [a\n, b\n, c]; "a\nb\nc\nd\ne" is [a\n, b\n, c\n, d\n, e].
    // Only "a\n" and "b\n" are shared — the old final line "c" gained a
    // newline, so it is a changed line, exactly as Diff reports it.
    // Hand-computed: 2 * 2 / (3 + 5) = 0.5.
    const out = score('a\nb\nc', 'a\nb\nc\nd\ne');
    expect(out.getMatchingLines()).toBe(2);
    expect(out.getOriginalLines()).toBe(3);
    expect(out.getRevisedLines()).toBe(5);
    expect(out.getRatio()).toBeCloseTo(0.5, 12);
  });

  it('GOLDEN: appending to a newline-terminated text keeps every old line', () => {
    // "a\nb\nc\n" is [a\n, b\n, c\n], all of which survive in the revised text.
    // Hand-computed: 2 * 3 / (3 + 5) = 0.75.
    const out = score('a\nb\nc\n', 'a\nb\nc\nd\ne');
    expect(out.getMatchingLines()).toBe(3);
    expect(out.getRatio()).toBeCloseTo(0.75, 12);
  });

  it('scores identical texts exactly 1.0', () => {
    expect(score('a\nb\nc', 'a\nb\nc').getRatio()).toBe(1);
  });

  it('scores texts sharing no line exactly 0.0', () => {
    const out = score('a\nb\nc', 'x\ny\nz');
    expect(out.getError()).toBe('');
    expect(out.getRatio()).toBe(0);
    expect(out.getMatchingLines()).toBe(0);
  });

  it('scores two empty texts 1.0 without dividing by zero', () => {
    const out = score('', '');
    expect(out.getError()).toBe('');
    expect(out.getRatio()).toBe(1);
    expect(out.getOriginalLines()).toBe(0);
    expect(out.getRevisedLines()).toBe(0);
  });

  it('scores an empty side 0.0', () => {
    expect(score('', 'a\nb').getRatio()).toBe(0);
    expect(score('a\nb', '').getRatio()).toBe(0);
  });

  it('counts a trailing newline as closing the last line, but still a real change', () => {
    const out = score('a\nb', 'a\nb\n');
    // Both texts are two lines — the trailing newline does not invent a third.
    expect(out.getOriginalLines()).toBe(2);
    expect(out.getRevisedLines()).toBe(2);
    // But "b" and "b\n" are not the same line, so this is NOT a perfect match.
    // Diff reports this pair as changed, and Similarity must agree with it.
    expect(out.getMatchingLines()).toBe(1);
    expect(out.getRatio()).toBeCloseTo(0.5, 12);
  });

  it('ORACLE: matching_lines equals a from-scratch LCS over the whole corpus', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const out = score(original, revised);
      expect([label, out.getError()]).toEqual([label, '']);

      const a = splitLines(original);
      const b = splitLines(revised);
      expect([label, out.getMatchingLines()]).toEqual([label, lcsLength(a, b)]);
      expect([label, out.getOriginalLines()]).toEqual([label, a.length]);
      expect([label, out.getRevisedLines()]).toEqual([label, b.length]);

      const ratio = out.getRatio();
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });

  it('ERROR PATH: rejects oversized input with a zeroed result', () => {
    const out = score('x'.repeat(MAX_CHARS + 1), 'y');
    expect(out.getError()).toContain('original exceeds the maximum');
    expect(out.getRatio()).toBe(0);
    expect(out.getMatchingLines()).toBe(0);
  });

  // Similarity and Stats pay the same O(N*D) cost as Diff and carry the same
  // "bounded cost" claim, but neither had a timing test — the cap was only ever
  // asserted for Diff. The worst case is two wholly dissimilar texts at the line
  // cap. The threshold is generous enough not to flake on a loaded CI box while
  // still catching a regression that removes the bound entirely.
  it('BOUNDS: the worst case at the line cap completes in bounded time', () => {
    const a = Array.from({ length: MAX_LINES }, (_, i) => `alpha ${i}`).join('\n');
    const b = Array.from({ length: MAX_LINES }, (_, i) => `beta ${i}`).join('\n');
    const started = Date.now();
    const out = score(a, b);
    expect(out.getError()).toBe('');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('is deterministic across repeated invocations', () => {
    const first = score('a\nb\nc', 'a\nX\nc').getRatio();
    for (let i = 0; i < 5; i++) expect(score('a\nb\nc', 'a\nX\nc').getRatio()).toBe(first);
  });
});
