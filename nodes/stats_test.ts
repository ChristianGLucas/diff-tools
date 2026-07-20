import { stats } from './stats';
import { TextPair } from '../gen/messages_pb';
import { ctx, CORPUS, lcsLength, splitLines } from './testkit';
import { MAX_LINES } from './lib';

function count(original: string, revised: string) {
  const input = new TextPair();
  input.setOriginal(original);
  input.setRevised(revised);
  return stats(ctx, input);
}

describe('Stats', () => {
  it('GOLDEN: a one-line edit is 1 added, 1 deleted, 1 block — matching `git diff --shortstat`', () => {
    const out = count('line1\nline2\nline3\nline4\nline5', 'line1\nline2\nCHANGED\nline4\nline5');
    expect(out.getError()).toBe('');
    expect(out.getLinesAdded()).toBe(1);
    expect(out.getLinesDeleted()).toBe(1);
    expect(out.getChangedBlocks()).toBe(1);
    expect(out.getOriginalLines()).toBe(5);
    expect(out.getRevisedLines()).toBe(5);
    expect(out.getIdentical()).toBe(false);
  });

  it('GOLDEN: two separate edits are two blocks', () => {
    const out = count('a\nb\nc\nd\ne\nf\ng', 'a\nX\nc\nd\nY\nf\ng');
    expect(out.getLinesAdded()).toBe(2);
    expect(out.getLinesDeleted()).toBe(2);
    expect(out.getChangedBlocks()).toBe(2);
  });

  it('GOLDEN: a contiguous multi-line edit is still one block', () => {
    const out = count('a\nb\nc\nd', 'a\nX\nY\nd');
    expect(out.getLinesAdded()).toBe(2);
    expect(out.getLinesDeleted()).toBe(2);
    expect(out.getChangedBlocks()).toBe(1);
  });

  it('counts a pure insertion without deletions', () => {
    const out = count('a\nb', 'a\nNEW\nb');
    expect(out.getLinesAdded()).toBe(1);
    expect(out.getLinesDeleted()).toBe(0);
    expect(out.getChangedBlocks()).toBe(1);
  });

  it('counts a pure deletion without additions', () => {
    const out = count('a\nGONE\nb', 'a\nb');
    expect(out.getLinesAdded()).toBe(0);
    expect(out.getLinesDeleted()).toBe(1);
    expect(out.getChangedBlocks()).toBe(1);
  });

  it('reports identical texts as all zeros', () => {
    const out = count('a\nb\nc', 'a\nb\nc');
    expect(out.getError()).toBe('');
    expect(out.getIdentical()).toBe(true);
    expect(out.getLinesAdded()).toBe(0);
    expect(out.getLinesDeleted()).toBe(0);
    expect(out.getChangedBlocks()).toBe(0);
  });

  it('treats empty texts as zero lines', () => {
    const out = count('', '');
    expect(out.getIdentical()).toBe(true);
    expect(out.getOriginalLines()).toBe(0);
    expect(out.getRevisedLines()).toBe(0);
  });

  it('ORACLE: added/deleted counts equal a from-scratch LCS over the whole corpus', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const out = count(original, revised);
      expect([label, out.getError()]).toEqual([label, '']);

      const a = splitLines(original);
      const b = splitLines(revised);
      const lcs = lcsLength(a, b);
      expect([label, out.getLinesDeleted()]).toEqual([label, a.length - lcs]);
      expect([label, out.getLinesAdded()]).toEqual([label, b.length - lcs]);
      expect([label, out.getIdentical()]).toEqual([label, original === revised]);
    }
  });

  it('ERROR PATH: rejects oversized input with a zeroed result', () => {
    const overCap = Array.from({ length: MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const out = count('a', overCap);
    expect(out.getError()).toContain('revised exceeds the maximum');
    expect(out.getLinesAdded()).toBe(0);
    expect(out.getChangedBlocks()).toBe(0);
  });

  it('is deterministic across repeated invocations', () => {
    const first = count('a\nb\nc', 'a\nX\nc').getChangedBlocks();
    for (let i = 0; i < 5; i++) expect(count('a\nb\nc', 'a\nX\nc').getChangedBlocks()).toBe(first);
  });
});
