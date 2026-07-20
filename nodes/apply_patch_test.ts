import { applyPatch } from './apply_patch';
import { diff } from './diff';
import { Hunk, Patch, PatchApplyRequest, TextPair } from '../gen/messages_pb';
import { ctx, CORPUS } from './testkit';
import { MAX_CHARS, MAX_LINES } from './lib';

const ORIGINAL = 'line1\nline2\nline3\nline4\nline5';
const REVISED = 'line1\nline2\nCHANGED\nline4\nline5';

function makeDiff(original: string, revised: string): Patch {
  const input = new TextPair();
  input.setOriginal(original);
  input.setRevised(revised);
  return diff(ctx, input);
}

function apply(original: string, patch: Patch) {
  const req = new PatchApplyRequest();
  req.setOriginal(original);
  req.setPatch(patch);
  return applyPatch(ctx, req);
}

function hunk(fields: Partial<Record<'oldStart' | 'oldLines' | 'newStart' | 'newLines', number>>, lines: string[]): Patch {
  const h = new Hunk();
  h.setOldStart(fields.oldStart ?? 1);
  h.setOldLines(fields.oldLines ?? 5);
  h.setNewStart(fields.newStart ?? 1);
  h.setNewLines(fields.newLines ?? 5);
  h.setLinesList(lines);
  const p = new Patch();
  p.setHunksList([h]);
  return p;
}

describe('ApplyPatch', () => {
  it('GOLDEN: applies a known patch to a known text', () => {
    const out = apply(
      ORIGINAL,
      hunk({}, [' line1', ' line2', '-line3', '+CHANGED', ' line4', ' line5', '\\ No newline at end of file']),
    );
    expect(out.getError()).toBe('');
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe(REVISED);
  });

  it("ROUND TRIP: reproduces the revised text exactly for the whole corpus", () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const patch = makeDiff(original, revised);
      expect([label, patch.getError()]).toEqual([label, '']);

      const out = apply(original, patch);
      expect([label, out.getApplied(), out.getError()]).toEqual([label, true, '']);
      expect([label, out.getText()]).toEqual([label, revised]);
    }
  });

  it('treats an empty patch as a no-op', () => {
    const out = apply(ORIGINAL, new Patch());
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe(ORIGINAL);
  });

  it('ERROR PATH: refuses a patch whose context does not match, without corrupting the text', () => {
    const out = apply(
      'totally\ndifferent\ntext\nhere\nnow',
      makeDiff(ORIGINAL, REVISED),
    );
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not apply');
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: refuses a near-miss context rather than fuzzy-matching it', () => {
    // One context line differs. A fuzzy implementation would silently apply
    // here and produce a wrong result; this node must refuse.
    const out = apply('line1\nlineX\nline3\nline4\nline5', makeDiff(ORIGINAL, REVISED));
    expect(out.getApplied()).toBe(false);
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: rejects a hunk with a negative start line', () => {
    const out = apply(ORIGINAL, hunk({ oldStart: -1 }, [' line1']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('negative start line');
    expect(out.getText()).toBe('');
  });

  it('accepts a start line of 0, valid for a hunk against an empty side', () => {
    // GNU diff emits `@@ -0,0 +1,N @@` when a file is created; rejecting 0
    // would refuse a legitimate patch.
    const out = apply('', makeDiff('', 'hello\nworld'));
    expect(out.getError()).toBe('');
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe('hello\nworld');
  });

  it('ERROR PATH: rejects a hunk with a negative line count', () => {
    const out = apply(ORIGINAL, hunk({ oldLines: -1 }, [' line1']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('negative line count');
  });

  it('ERROR PATH: rejects a hunk body line with an unknown prefix', () => {
    const out = apply(ORIGINAL, hunk({}, [' line1', '?line2']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('unknown prefix');
  });

  it('ERROR PATH: rejects a hunk pointing far past the end of the text', () => {
    const out = apply(ORIGINAL, hunk({ oldStart: 9999, newStart: 9999 }, ['-nope', '+nah']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).not.toBe('');
    expect(out.getText()).toBe('');
  });

  it('BOUNDS: rejects an oversized original and an oversized patch', () => {
    const big = apply('x'.repeat(MAX_CHARS + 1), new Patch());
    expect(big.getApplied()).toBe(false);
    expect(big.getError()).toContain('original exceeds the maximum');

    const manyLines = Array.from({ length: MAX_LINES + 1 }, (_, i) => `+line ${i}`);
    const wide = apply(ORIGINAL, hunk({}, manyLines));
    expect(wide.getApplied()).toBe(false);
    expect(wide.getError()).toContain(`span more than ${MAX_LINES} lines`);
  });

  it('is deterministic across repeated invocations', () => {
    const patch = makeDiff(ORIGINAL, REVISED);
    const first = apply(ORIGINAL, patch).getText();
    for (let i = 0; i < 5; i++) expect(apply(ORIGINAL, patch).getText()).toBe(first);
  });
});
