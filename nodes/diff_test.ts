import { diff } from './diff';
import { TextPair } from '../gen/messages_pb';
import { ctx, CORPUS, lcsLength, splitLines } from './testkit';
import { MAX_CHARS, MAX_LINES } from './lib';

const ORIGINAL = 'line1\nline2\nline3\nline4\nline5';
const REVISED = 'line1\nline2\nCHANGED\nline4\nline5';

function run(original: string, revised: string, opts: Partial<{ ctxLines: number; on: string; rn: string }> = {}) {
  const input = new TextPair();
  input.setOriginal(original);
  input.setRevised(revised);
  if (opts.ctxLines !== undefined) input.setContextLines(opts.ctxLines);
  if (opts.on !== undefined) input.setOriginalName(opts.on);
  if (opts.rn !== undefined) input.setRevisedName(opts.rn);
  return diff(ctx, input);
}

describe('Diff', () => {
  it('GOLDEN: emits a valid, pinned unified diff for a known change', () => {
    // A deterministic regression anchor. This is a valid, minimal unified diff
    // (and, for this multi-line-range input, it also happens to match GNU
    // `diff -u`) — but the package does NOT claim byte-for-byte GNU equivalence
    // in general; see the round-trip and re-parse tests for the real guarantee.
    const out = run(ORIGINAL, REVISED);
    expect(out.getError()).toBe('');
    expect(out.getIdentical()).toBe(false);
    expect(out.getUnifiedDiff()).toBe(
      [
        '--- original',
        '+++ revised',
        '@@ -1,5 +1,5 @@',
        ' line1',
        ' line2',
        '-line3',
        '+CHANGED',
        ' line4',
        ' line5',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
  });

  it('GOLDEN: emits the expected structured hunk', () => {
    const hunks = run(ORIGINAL, REVISED).getHunksList();
    expect(hunks).toHaveLength(1);
    expect(hunks[0].getOldStart()).toBe(1);
    expect(hunks[0].getOldLines()).toBe(5);
    expect(hunks[0].getNewStart()).toBe(1);
    expect(hunks[0].getNewLines()).toBe(5);
    expect(hunks[0].getLinesList()).toEqual([
      ' line1',
      ' line2',
      '-line3',
      '+CHANGED',
      ' line4',
      ' line5',
      '\\ No newline at end of file',
    ]);
  });

  it('does NOT emit jsdiff\'s non-standard "=====" index separator', () => {
    expect(run(ORIGINAL, REVISED).getUnifiedDiff().startsWith('===')).toBe(false);
    expect(run(ORIGINAL, REVISED).getUnifiedDiff().startsWith('--- ')).toBe(true);
  });

  it("hunk numbers always match the @@ header in the patch's own unified_diff", () => {
    // These disagreed silently once: jsdiff's in-memory hunk says oldStart 1 for
    // a hunk against an empty side while its text says -0, and formatPatch
    // mutates the hunk to reconcile them. The envelope must be self-consistent.
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const out = run(original, revised);
      if (out.getIdentical()) continue;

      const headers = out
        .getUnifiedDiff()
        .split('\n')
        .filter((l) => l.startsWith('@@'));
      const fromHunks = out
        .getHunksList()
        .map((h) => `@@ -${h.getOldStart()},${h.getOldLines()} +${h.getNewStart()},${h.getNewLines()} @@`);
      expect([label, fromHunks]).toEqual([label, headers]);
    }
  });

  it('reports identical texts as an empty patch', () => {
    const out = run(ORIGINAL, ORIGINAL);
    expect(out.getError()).toBe('');
    expect(out.getIdentical()).toBe(true);
    expect(out.getUnifiedDiff()).toBe('');
    expect(out.getHunksList()).toHaveLength(0);
  });

  it('uses supplied header names, and defaults when absent', () => {
    const named = run(ORIGINAL, REVISED, { on: 'a/app.txt', rn: 'b/app.txt' });
    expect(named.getOriginalName()).toBe('a/app.txt');
    expect(named.getRevisedName()).toBe('b/app.txt');
    expect(named.getUnifiedDiff().startsWith('--- a/app.txt\n+++ b/app.txt\n')).toBe(true);

    const plain = run(ORIGINAL, REVISED);
    expect(plain.getOriginalName()).toBe('original');
    expect(plain.getRevisedName()).toBe('revised');
  });

  it('GOLDEN: honours context_lines, with 0 meaning the default and -1 meaning none', () => {
    expect(run(ORIGINAL, REVISED, { ctxLines: 1 }).getUnifiedDiff()).toBe(
      ['--- original', '+++ revised', '@@ -2,3 +2,3 @@', ' line2', '-line3', '+CHANGED', ' line4', ''].join('\n'),
    );
    expect(run(ORIGINAL, REVISED, { ctxLines: -1 }).getUnifiedDiff()).toBe(
      ['--- original', '+++ revised', '@@ -3,1 +3,1 @@', '-line3', '+CHANGED', ''].join('\n'),
    );
    expect(run(ORIGINAL, REVISED, { ctxLines: 0 }).getUnifiedDiff()).toBe(
      run(ORIGINAL, REVISED, { ctxLines: 3 }).getUnifiedDiff(),
    );
  });

  it('ERROR PATH: rejects out-of-range context_lines without crashing', () => {
    const low = run(ORIGINAL, REVISED, { ctxLines: -2 });
    expect(low.getError()).toContain('must not be below -1');
    expect(low.getUnifiedDiff()).toBe('');
    expect(low.getHunksList()).toHaveLength(0);

    expect(run(ORIGINAL, REVISED, { ctxLines: 101 }).getError()).toContain('must not exceed 100');
  });

  it('BOUNDS: accepts input at the character cap and rejects one over', () => {
    const atCap = 'x'.repeat(MAX_CHARS);
    expect(run(atCap, atCap).getError()).toBe('');

    expect(run('x'.repeat(MAX_CHARS + 1), 'y').getError()).toContain(
      `original exceeds the maximum of ${MAX_CHARS} characters`,
    );
  });

  it('BOUNDS: accepts input at the line cap and rejects one over, on either side', () => {
    const atCap = Array.from({ length: MAX_LINES }, (_, i) => `l${i}`).join('\n');
    expect(run(atCap, atCap).getError()).toBe('');

    const overCap = Array.from({ length: MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    expect(run(overCap, 'a').getError()).toContain(`original exceeds the maximum of ${MAX_LINES} lines`);
    expect(run('a', overCap).getError()).toContain(`revised exceeds the maximum of ${MAX_LINES} lines`);
  });

  it('BOUNDS: the worst case at the line cap completes in bounded time', () => {
    // Two wholly-dissimilar texts maximise the O(N*D) cost — the input that
    // would hang an unbounded implementation.
    const a = Array.from({ length: MAX_LINES }, (_, i) => `alpha-${i}`).join('\n');
    const b = Array.from({ length: MAX_LINES }, (_, i) => `beta-${i}`).join('\n');
    const started = Date.now();
    const out = run(a, b);
    expect(out.getError()).toBe('');
    expect(out.getHunksList().length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('SECURITY: rejects a header name containing a line break (forged-header injection)', () => {
    // A newline in a name would let the caller inject extra "---"/"+++"/"@@"
    // lines and turn this single-file diff into a forged multi-file patch that
    // ParseUnifiedDiff or `git apply` would act on. Must be refused.
    const injected = run(ORIGINAL, REVISED, {
      on: 'a/real\n+++ b/real\n@@ -1 +1 @@\n-x\n+y\n--- a/victim',
      rn: 'b/victim',
    });
    expect(injected.getError()).toContain('must not contain a line break');
    expect(injected.getUnifiedDiff()).toBe('');
    expect(injected.getHunksList()).toHaveLength(0);

    // A carriage return is refused too.
    expect(run(ORIGINAL, REVISED, { rn: 'b/f\rmalicious' }).getError()).toContain(
      'must not contain a line break',
    );

    // A normal, single-line name with slashes is still fine.
    expect(run(ORIGINAL, REVISED, { on: 'a/app.txt', rn: 'b/app.txt' }).getError()).toBe('');
  });

  it('SECURITY: the emitted unified_diff describes exactly one file for any accepted input', () => {
    for (const [original, revised] of CORPUS) {
      const out = run(original, revised);
      if (out.getIdentical()) continue;
      const fileHeaders = out
        .getUnifiedDiff()
        .split('\n')
        .filter((l) => l.startsWith('--- ') || l.startsWith('+++ '));
      // Exactly one "---" and one "+++" — never a smuggled second file.
      expect([JSON.stringify([original, revised]), fileHeaders.length]).toEqual([
        JSON.stringify([original, revised]),
        2,
      ]);
    }
  });

  // Header names flow verbatim into the "---"/"+++" lines. Line breaks are the
  // forging vector for jsdiff and git (both split on "\n"), but Python's
  // str.splitlines() — used by unidiff and most Python diff tooling — also
  // breaks on U+2028/U+2029/U+0085/VT/FF, so a name carrying those forges a
  // second file header for a downstream consumer even though git sees one file.
  // Control characters additionally corrupt terminals and logs.
  it('SECURITY: rejects control characters and line separators in header names', () => {
    const forging = '\u2028+++ evil.txt\u2028@@ -1,1 +1,1 @@';
    // Line-splitting characters (the forging vector) plus bidi and zero-width
    // characters, which split nothing but make a name RENDER as a different path
    // than it is in any terminal, editor, or review UI showing the diff.
    for (const bad of [
      forging, 'x\u0000y', 'x\u000by', 'x\u000cy', 'x\u0085y', 'x\u2029y',
      'x\u202e--- /etc/passwd', 'x\u200by', 'x\u200ey', 'x\u2066y',
    ]) {
      const out = run('a\n', 'b\n', { on: bad });
      expect([bad, out.getError()]).toEqual([bad, 'original_name / revised_name must not contain control, bidi, or zero-width characters']);
      expect(out.getUnifiedDiff()).toBe('');
    }
    // A tab is legal in a filename field and must still be accepted.
    expect(run('a\n', 'b\n', { on: 'ok.txt' }).getError()).toBe('');
  });

  it('is deterministic across repeated invocations', () => {
    const first = run(ORIGINAL, REVISED).getUnifiedDiff();
    for (let i = 0; i < 5; i++) expect(run(ORIGINAL, REVISED).getUnifiedDiff()).toBe(first);
  });

  it('treats an empty text as zero lines', () => {
    expect(run('', '').getIdentical()).toBe(true);
    const inserted = run('', 'hello\nworld');
    expect(inserted.getError()).toBe('');
    expect(inserted.getIdentical()).toBe(false);
  });

  it('ORACLE: hunk line counts agree with a from-scratch LCS dynamic program', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const out = run(original, revised);
      expect(out.getError()).toBe('');

      const lcs = lcsLength(splitLines(original), splitLines(revised));
      let added = 0;
      let removed = 0;
      for (const h of out.getHunksList()) {
        for (const line of h.getLinesList()) {
          if (line.startsWith('+')) added++;
          else if (line.startsWith('-')) removed++;
        }
      }
      expect([label, added]).toEqual([label, splitLines(revised).length - lcs]);
      expect([label, removed]).toEqual([label, splitLines(original).length - lcs]);
    }
  });
});
