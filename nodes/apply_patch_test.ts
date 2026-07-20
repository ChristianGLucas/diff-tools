import { applyPatch } from './apply_patch';
import { diff } from './diff';
import { Hunk, Patch, PatchApplyRequest, TextPair } from '../gen/messages_pb';
import { ctx, CORPUS } from './testkit';
import {
  MAX_CHARS,
  MAX_HUNKS,
  MAX_LINES,
  MAX_PATCH_LINES,
  splitLines,
  joinLines,
} from './lib';

const ORIGINAL = 'line1\nline2\nline3\nline4\nline5';
const REVISED = 'line1\nline2\nCHANGED\nline4\nline5';

function makeDiff(original: string, revised: string, context?: number): Patch {
  const input = new TextPair();
  input.setOriginal(original);
  input.setRevised(revised);
  if (context !== undefined) input.setContextLines(context);
  return diff(ctx, input);
}

function apply(original: string, patch: Patch) {
  const req = new PatchApplyRequest();
  req.setOriginal(original);
  req.setPatch(patch);
  return applyPatch(ctx, req);
}

function applyText(original: string, unifiedDiff: string) {
  const req = new PatchApplyRequest();
  req.setOriginal(original);
  req.setUnifiedDiff(unifiedDiff);
  return applyPatch(ctx, req);
}

function hunk(
  fields: Partial<Record<'oldStart' | 'oldLines' | 'newStart' | 'newLines', number>>,
  lines: string[],
): Patch {
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

// --- The line model, tested directly. splitLines/joinLines are the whole basis
// of the self-contained applier: if they are not exact inverses, every apply is
// suspect. The phantom trailing element that split('\n') appends to a
// newline-terminated text — the source of the old delegated applier's whole
// newline-corruption class — must NOT appear here.
describe('line model (splitLines / joinLines)', () => {
  const samples = [
    '',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    '\n',
    '\n\n',
    'a\r\nb\r\n',
    'é你\nsecond',
    'trailing spaces  \n',
  ];
  it('joinLines is the exact inverse of splitLines', () => {
    for (const s of samples) {
      expect([s, joinLines(splitLines(s))]).toEqual([s, s]);
    }
  });
  it('models the trailing newline as a line property, with no phantom line', () => {
    expect(splitLines('a\nb\n')).toEqual([
      { content: 'a', eol: true },
      { content: 'b', eol: true },
    ]);
    expect(splitLines('a\nb')).toEqual([
      { content: 'a', eol: true },
      { content: 'b', eol: false },
    ]);
    expect(splitLines('')).toEqual([]);
  });
});

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

  it('ROUND TRIP: reproduces the revised text exactly for the whole corpus', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const patch = makeDiff(original, revised);
      expect([label, patch.getError()]).toEqual([label, '']);

      const out = apply(original, patch);
      expect([label, out.getApplied(), out.getError()]).toEqual([label, true, '']);
      expect([label, out.getText()]).toEqual([label, revised]);
    }
  });

  // The strongest correctness evidence for the redesigned apply path: many
  // generated pairs, every context setting, BOTH supply modes, byte-exact.
  // Deterministic (seeded LCG) so a failure reproduces. This is the net that
  // covers what hand-picked fixtures miss — the trailing-newline transitions,
  // multi-hunk net insertions, and zero-context shapes where the old delegated
  // applier's interpretation diverged from the package's model. Here there is no
  // second interpreter, so agreement is structural; the fuzz proves it.
  it('FUZZ ROUND TRIP: Diff -> ApplyPatch is exact across generated pairs, contexts, and both paths', () => {
    let seed = 0x9e3779b9 >>> 0;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    // Small alphabet (with blank and Unicode lines) so pairs share lines and the
    // diffs are non-trivial; random trailing newline to exercise the EOF edge.
    const alphabet = ['a', 'b', 'c', 'd', '', ' e', 'é你', 'x\ty'];
    const gen = () => {
      const n = Math.floor(rand() * 7); // 0..6 lines
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(alphabet[Math.floor(rand() * alphabet.length)]);
      let text = lines.join('\n');
      if (text !== '' && rand() < 0.5) text += '\n';
      return text;
    };

    const contexts = [-1, 0, 1, 3];
    let checked = 0;
    for (let iter = 0; iter < 500; iter++) {
      const original = gen();
      const revised = gen();
      for (const c of contexts) {
        const patch = makeDiff(original, revised, c);
        const label = JSON.stringify([original, revised, c]);
        expect([label, patch.getError()]).toEqual([label, '']);

        const viaEnvelope = apply(original, patch);
        expect([label, 'env', viaEnvelope.getApplied(), viaEnvelope.getError()]).toEqual([label, 'env', true, '']);
        expect([label, 'env', viaEnvelope.getText()]).toEqual([label, 'env', revised]);

        const viaScalar = applyText(original, patch.getUnifiedDiff());
        expect([label, 'txt', viaScalar.getApplied(), viaScalar.getError()]).toEqual([label, 'txt', true, '']);
        expect([label, 'txt', viaScalar.getText()]).toEqual([label, 'txt', revised]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1500);
  }, 120_000);

  it('treats a patch marked identical as a no-op', () => {
    const p = new Patch();
    p.setIdentical(true);
    const out = apply(ORIGINAL, p);
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe(ORIGINAL);
  });

  it('ERROR PATH: refuses a hunk-less patch that is not marked identical', () => {
    const out = apply(ORIGINAL, new Patch());
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('no hunks and is not marked identical');
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: refuses a patch carrying an upstream error', () => {
    const p = new Patch();
    p.setError('unified_diff is not in unified-diff format');
    const out = apply(ORIGINAL, p);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('upstream error');
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: refuses a request that supplies neither patch nor unified_diff', () => {
    const req = new PatchApplyRequest();
    req.setOriginal(ORIGINAL);
    const out = applyPatch(ctx, req);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('no patch supplied');
  });

  it('ERROR PATH: refuses a request that supplies both patch and unified_diff', () => {
    const req = new PatchApplyRequest();
    req.setOriginal(ORIGINAL);
    req.setPatch(makeDiff(ORIGINAL, REVISED));
    req.setUnifiedDiff(makeDiff(ORIGINAL, REVISED).getUnifiedDiff());
    const out = applyPatch(ctx, req);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('not both');
  });

  it('COMPOSE: applies a patch supplied as unified-diff text, matching the envelope path', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const out = applyText(original, makeDiff(original, revised).getUnifiedDiff());
      expect([label, out.getApplied(), out.getError()]).toEqual([label, true, '']);
      expect([label, out.getText()]).toEqual([label, revised]);
    }
  });

  // A multi-hunk patch that nets an insertion: insert a block early, change
  // something further down, so a later hunk begins past the ORIGINAL's end. The
  // self-applier emits the new side in order and never trusts a declared revised
  // position, so this shape — which broke the old new_start bounding — is exact.
  it('ROUND TRIP: a multi-hunk patch that nets an insertion applies on both paths', () => {
    const original = Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n') + '\n';
    const inserted = Array.from({ length: 8 }, (_, i) => `N${i}`);
    const revisedLines = ['L0', ...inserted, ...Array.from({ length: 11 }, (_, i) => `L${i + 1}`)];
    revisedLines[revisedLines.length - 2] = 'CHANGED';
    const revised = revisedLines.join('\n') + '\n';

    const patch = makeDiff(original, revised);
    expect(patch.getError()).toBe('');

    expect(apply(original, patch).getText()).toBe(revised);
    expect(applyText(original, patch.getUnifiedDiff()).getText()).toBe(revised);
  });

  // --- The historical corruption class, now closed structurally ---------------
  // Each of these was, in a prior review round, a route by which a
  // structurally-legal patch made the OLD (jsdiff-delegated) applier produce
  // wrong bytes with applied:true. The self-applier refuses every one, because
  // it matches the old side exactly against the real text and checks the applied
  // output — there is no second interpreter to disagree with. The LEGITIMATE
  // sibling of each attack still applies, proving the guard is not a blanket ban.

  // (Instance 1) A bare "" body line is context, counted on both sides. A header
  // that lies about its reach is refused; the honest header is accepted.
  it('SECURITY: a bare empty body line is context, and a lying header is refused', () => {
    const original = 'a\n\n\nb\n';
    const honest = apply(original, hunk({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 }, [' a', '', '', '-b', '+B']));
    expect(honest.getError()).toBe('');
    expect(honest.getText()).toBe('a\n\n\nB\n');

    const lying = apply(original, hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }, [' a', '', '', '+INJECTED']));
    expect(lying.getApplied()).toBe(false);
    expect(lying.getError()).toContain('does not match its body');
    expect(lying.getText()).toBe('');
  });

  // (Instances 2-5) A "\" no-newline marker only ever unterminates the LAST line
  // of a side. A marker that would leave a non-final line unterminated is
  // malformed and refused; and even a well-formed marker's CLAIM is verified —
  // against the real text on the old side (exact match), and against the applied
  // output on the new side (only the true last line of the result may lack a
  // newline).
  it('SECURITY: refuses a marker on a non-final line of a side', () => {
    // Marker after "+X" with a context line still to come: X would be a non-final
    // unterminated line of the new side.
    const out = apply('a\nb\n', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }, [
      ' a', '+X', '\\ No newline at end of file', ' b',
    ]));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('non-final line of the revised side');

    // Same shape arriving as unified-diff TEXT is refused too.
    const viaText = applyText('a\nb\n', '--- a\n+++ b\n@@ -1,2 +1,3 @@\n a\n+X\n\\ No newline at end of file\n b\n');
    expect(viaText.getApplied()).toBe(false);

    // Legitimate: a marker terminating the OLD side between the "-" and "+" runs,
    // and terminating the new side as the final line, both apply.
    const ok = apply('a\nb', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file',
    ]));
    expect(ok.getError()).toBe('');
    expect(ok.getText()).toBe('a\nB');
  });

  it('SECURITY: refuses a marker whose no-newline claim contradicts the real text', () => {
    // The marker declares the original's final line unterminated, but in the
    // real text it ends with a newline — exact matching refuses it, rather than
    // ignoring the declaration and silently keeping the newline as jsdiff did.
    const out = apply('a\nb\n', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      '-a', '+A', ' b', '\\ No newline at end of file',
    ]));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not apply');
    expect(out.getText()).toBe('');
  });

  it('SECURITY: refuses a marker on a hunk that does not reach the end of the file', () => {
    // Would once have silently ADDED a trailing newline: the marker claims "a" is
    // the unterminated last line, but "a" is terminated (more lines follow).
    const adds = apply('a\nb\nc', hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, [
      '-a', '\\ No newline at end of file', '+X',
    ]));
    expect(adds.getApplied()).toBe(false);
    expect(adds.getText()).toBe('');

    // Would once have silently REMOVED the trailing newline: "X" is declared
    // unterminated but is followed by b, c in the result.
    const removes = apply('a\nb\nc\n', hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, [
      '-a', '+X', '\\ No newline at end of file',
    ]));
    expect(removes.getApplied()).toBe(false);
    expect(removes.getError()).toContain('not the end of the file');
    expect(removes.getText()).toBe('');

    // A marker on a hunk that DOES reach the end still works.
    const ok = apply('a\nb', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file',
    ]));
    expect(ok.getText()).toBe('a\nB');
  });

  it('SECURITY: refuses a marker on a non-final hunk that would corrupt a mid-file line', () => {
    const p = new Patch();
    const h1 = new Hunk();
    h1.setOldStart(1); h1.setOldLines(1); h1.setNewStart(1); h1.setNewLines(1);
    h1.setLinesList(['-a', '+X', '\\ No newline at end of file']);
    const h2 = new Hunk();
    h2.setOldStart(3); h2.setOldLines(1); h2.setNewStart(3); h2.setNewLines(1);
    h2.setLinesList(['-c', '+Z']);
    p.setHunksList([h1, h2]);
    const out = apply('a\nb\nc\n', p);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('not the end of the file');
    expect(out.getText()).toBe('');
  });

  // (Instance 6) The marker-FREE route: the old applier ran against
  // source.split('\n'), whose trailing "" for a newline-terminated text was a
  // phantom line a hunk could address to strip or fabricate the file's newline.
  // This package's line model has no such phantom, so a hunk addressing a line
  // past the true end is simply out of range.
  it('SECURITY: a marker-free patch cannot change the trailing newline via a phantom line', () => {
    const strips = apply('a\n', hunk({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 0 }, ['-']));
    expect(strips.getApplied()).toBe(false);
    expect(strips.getText()).toBe('');

    const viaText = applyText('a\n', '--- original\n+++ revised\n@@ -2 +1,0 @@\n-\n');
    expect(viaText.getApplied()).toBe(false);
    expect(viaText.getText()).toBe('');
  });

  // (Instance 7) jsdiff RELOCATED a hunk whose context did not match at its
  // declared line, then applied its end-of-file logic anyway. The self-applier
  // never relocates: an exact match at the declared line is required, so a hunk
  // whose context is elsewhere is refused, not moved.
  it('SECURITY: never relocates a hunk — an off-position context is refused', () => {
    const out = apply('x\nx\nx\ny\n', hunk({ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }, [
      '-x', '+z', '\\ No newline at end of file',
    ]));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not match');
    expect(out.getText()).toBe('');

    // The honest position (the "y" line, at 4) applies.
    const ok = apply('x\nx\nx\ny\n', hunk({ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }, [
      '-y', '+z',
    ]));
    expect(ok.getError()).toBe('');
    expect(ok.getText()).toBe('x\nx\nx\nz\n');
  });

  // --- General error paths ----------------------------------------------------

  it('ERROR PATH: refuses a context that does not match, without corrupting the text', () => {
    const out = apply('totally\ndifferent\ntext\nhere\nnow', makeDiff(ORIGINAL, REVISED));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not apply');
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: refuses a near-miss context rather than fuzzy-matching it', () => {
    const out = apply('line1\nlineX\nline3\nline4\nline5', makeDiff(ORIGINAL, REVISED));
    expect(out.getApplied()).toBe(false);
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: refuses overlapping / out-of-order hunks', () => {
    const p = new Patch();
    const h1 = new Hunk();
    h1.setOldStart(3); h1.setOldLines(1); h1.setNewStart(3); h1.setNewLines(1);
    h1.setLinesList(['-line3', '+Z']);
    const h2 = new Hunk();
    h2.setOldStart(1); h2.setOldLines(1); h2.setNewStart(1); h2.setNewLines(1);
    h2.setLinesList(['-line1', '+Y']);
    p.setHunksList([h1, h2]);
    const out = apply(ORIGINAL, p);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('overlaps or precedes');
    expect(out.getText()).toBe('');
  });

  it('accepts a start line of 0, valid for a hunk against an empty side', () => {
    const out = apply('', makeDiff('', 'hello\nworld'));
    expect(out.getError()).toBe('');
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe('hello\nworld');
  });

  it('applies a patch that deletes all content, needing no marker', () => {
    // A legitimately empty result carries no trailing newline and needs no
    // marker. The class-closing invariant must not refuse it.
    const out = apply('a\nb\n', makeDiff('a\nb\n', ''));
    expect(out.getError()).toBe('');
    expect(out.getText()).toBe('');
  });

  it('ERROR PATH: rejects a hunk with a negative start line', () => {
    const out = apply(ORIGINAL, hunk({ oldStart: -1 }, [' line1']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('negative start line');
    expect(out.getText()).toBe('');
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

  it('ERROR PATH: rejects a hunk with an empty body', () => {
    const out = apply('a\nb\n', hunk({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0 }, []));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('empty body');
  });

  it('ERROR PATH: rejects a hunk whose declared counts contradict its body', () => {
    const lying = hunk({ oldLines: 99, newLines: 99 }, [' line1', '-line2', '+X']);
    const out = apply(ORIGINAL, lying);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not match its body');
    expect(out.getText()).toBe('');

    const honest = hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [' line1', '-line2', '+X']);
    expect(apply(ORIGINAL, honest).getError()).toBe('');
  });

  it('SECURITY: rejects a "\\" body line that is not the end-of-file marker', () => {
    const out = apply(ORIGINAL, hunk({ oldLines: 5, newLines: 5 }, [' line1', ' line2', '-line3', '+CHANGED', ' line4', ' line5', '\\ arbitrary payload']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('is not "\\\\ No newline at end of file"');
  });

  it('SECURITY: refuses an LF patch against a CRLF original instead of silently converting', () => {
    const out = apply('a\r\nb\r\n', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [' a', '-b', '+Z']));
    expect(out.getApplied()).toBe(false);
    expect(out.getText()).toBe('');

    const ok = apply('a\r\nb\r\n', makeDiff('a\r\nb\r\n', 'a\r\nZ\r\n'));
    expect(ok.getError()).toBe('');
    expect(ok.getText()).toBe('a\r\nZ\r\n');
  });

  it('ERROR PATH: rejects a hunk pointing past the end of the text', () => {
    const out = apply(ORIGINAL, hunk({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }, ['-nope', '+nah']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('past the end of');
    expect(out.getText()).toBe('');
  });

  // DoS regression, now defused by design: the self-applier indexes the text
  // directly, so an out-of-range start costs O(1) — it never scans outward from
  // the declared start as jsdiff did. An absurd start is refused by the numbering
  // bound in toApplyHunks before any application, and INSTANTLY.
  it('BOUNDS: rejects an INT32_MAX hunk start immediately rather than scanning to it', () => {
    const started = Date.now();
    const out = apply(ORIGINAL, hunk({ oldStart: 2147483647, oldLines: 1, newStart: 2147483647, newLines: 1 }, ['-nope', '+nah']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('beyond the maximum');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('BOUNDS: rejects a patch with more hunks than the cap', () => {
    const p = new Patch();
    p.setHunksList(Array.from({ length: MAX_HUNKS + 1 }, () => {
      const h = new Hunk();
      h.setOldStart(1); h.setOldLines(1); h.setNewStart(1); h.setNewLines(1);
      h.setLinesList([' a']);
      return h;
    }));
    const out = apply('a\n', p);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain(`more than ${MAX_HUNKS} hunks`);
  });

  it('BOUNDS: rejects an oversized original and an oversized patch', () => {
    const big = apply('x'.repeat(MAX_CHARS + 1), new Patch());
    expect(big.getApplied()).toBe(false);
    expect(big.getError()).toContain('original exceeds the maximum');

    const manyLines = Array.from({ length: MAX_PATCH_LINES + 1 }, (_, i) => `+line ${i}`);
    const wide = apply(ORIGINAL, hunk({ newLines: MAX_PATCH_LINES + 1 }, manyLines));
    expect(wide.getApplied()).toBe(false);
    expect(wide.getError()).toContain(`span more than ${MAX_PATCH_LINES} lines`);
  });

  // The patch budget must admit any patch Diff itself can emit — on BOTH supply
  // modes — or the round-trip guarantee breaks on input the package accepted.
  describe.each([
    ['envelope (patch)', (o: string, p: Patch) => apply(o, p)],
    ['scalar (unified_diff)', (o: string, p: Patch) => applyText(o, p.getUnifiedDiff())],
  ])('BOUNDS: a full rewrite at the line cap — %s path', (_label, applyVia) => {
    it('still round-trips through ApplyPatch', () => {
      const n = MAX_LINES;
      const original = Array.from({ length: n }, (_, i) => `alpha-${i}`).join('\n') + '\n';
      const revised = Array.from({ length: n }, (_, i) => `beta-${i}`).join('\n') + '\n';

      const patch = makeDiff(original, revised);
      expect(patch.getError()).toBe('');
      const body = patch.getHunksList().reduce((s, h) => s + h.getLinesList().length, 0);
      expect(body).toBeGreaterThan(MAX_LINES);
      expect(patch.getUnifiedDiff().split('\n').length).toBeGreaterThan(MAX_LINES);

      const out = applyVia(original, patch);
      expect(out.getError()).toBe('');
      expect(out.getText()).toBe(revised);
    }, 60_000);
  });

  it('BOUNDS: a zero-context patch at the line cap still round-trips', () => {
    const n = MAX_LINES;
    const original = Array.from({ length: n }, (_, i) => `L${i}`).join('\n') + '\n';
    const revised = Array.from({ length: n }, (_, i) => (i % 2 ? `L${i}` : `X${i}`)).join('\n') + '\n';

    const patch = makeDiff(original, revised, -1);
    expect(patch.getError()).toBe('');
    expect(patch.getHunksList().length).toBeGreaterThan(2000);

    const out = apply(original, patch);
    expect(out.getError()).toBe('');
    expect(out.getText()).toBe(revised);
  }, 120_000);

  // Independent external oracle: the unified diff Diff emits is accepted by the
  // system `git apply`, applied to a real repo, and reproduces the revised text.
  // FAILS LOUDLY if git is absent — a vanished oracle must not read as a pass.
  it('COMPAT: the unified diff Diff emits is accepted by the system `git apply`', () => {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    for (const [original, revised] of CORPUS) {
      if (original === '' || revised === '') continue;
      if (original === revised) continue;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-tools-gitapply-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'f.txt'), original);
        execFileSync('git', ['add', 'f.txt'], { cwd: dir });
        execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });

        const input = new TextPair();
        input.setOriginal(original);
        input.setRevised(revised);
        input.setOriginalName('a/f.txt');
        input.setRevisedName('b/f.txt');
        const unified = diff(ctx, input).getUnifiedDiff();

        execFileSync('git', ['apply', '-'], { cwd: dir, input: unified });
        expect([original, revised, fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')]).toEqual([
          original,
          revised,
          revised,
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('is deterministic across repeated invocations', () => {
    const patch = makeDiff(ORIGINAL, REVISED);
    const first = apply(ORIGINAL, patch).getText();
    for (let i = 0; i < 5; i++) expect(apply(ORIGINAL, patch).getText()).toBe(first);
  });
});
