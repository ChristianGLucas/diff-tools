import { applyPatch } from './apply_patch';
import { diff } from './diff';
import { Hunk, Patch, PatchApplyRequest, TextPair } from '../gen/messages_pb';
import { ctx, CORPUS } from './testkit';
import { MAX_CHARS, MAX_HUNKS, MAX_LINES, MAX_PATCH_LINES, countLines } from './lib';

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

  it('treats a patch marked identical as a no-op', () => {
    const p = new Patch();
    p.setIdentical(true);
    const out = apply(ORIGINAL, p);
    expect(out.getApplied()).toBe(true);
    expect(out.getText()).toBe(ORIGINAL);
  });

  // A hunk-less patch that nobody marked identical is malformed, not a no-op.
  // Applying it as an identity hands the caller back their unchanged text as
  // though the edit had landed.
  it('ERROR PATH: refuses a hunk-less patch that is not marked identical', () => {
    const out = apply(ORIGINAL, new Patch());
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('no hunks and is not marked identical');
    expect(out.getText()).toBe('');
  });

  // An upstream failure must never read as a successful identity apply: Diff and
  // ParseUnifiedDiff report failure as a Patch with error set and no hunks.
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

  // The scalar compose path: a flow edge can carry only scalar leaves, so this
  // is how Diff -> ApplyPatch is wired inside a flow.
  it('COMPOSE: applies a patch supplied as unified-diff text, matching the envelope path', () => {
    for (const [original, revised] of CORPUS) {
      const label = JSON.stringify([original, revised]);
      const req = new PatchApplyRequest();
      req.setOriginal(original);
      req.setUnifiedDiff(makeDiff(original, revised).getUnifiedDiff());
      const out = applyPatch(ctx, req);
      expect([label, out.getApplied(), out.getError()]).toEqual([label, true, '']);
      expect([label, out.getText()]).toEqual([label, revised]);
    }
  });

  // REGRESSION. new_start indexes the REVISED text, which is longer than the
  // original whenever the patch nets an insertion, so bounding it by the
  // ORIGINAL's line count rejected the single most common real edit shape:
  // insert a block early, change something further down. The CORPUS has no
  // multi-hunk net-insertion case, which is why a green suite missed it.
  // Driven through BOTH supply paths, because the bug was reachable from each.
  it('ROUND TRIP: a multi-hunk patch that nets an insertion applies on both paths', () => {
    const original = Array.from({ length: 12 }, (_, i) => `L${i}`).join('\n') + '\n';
    const inserted = Array.from({ length: 8 }, (_, i) => `N${i}`);
    const revisedLines = ['L0', ...inserted, ...Array.from({ length: 11 }, (_, i) => `L${i + 1}`)];
    revisedLines[revisedLines.length - 2] = 'CHANGED';
    const revised = revisedLines.join('\n') + '\n';

    const patch = makeDiff(original, revised);
    expect(patch.getError()).toBe('');
    // Guard the premise: a later hunk must really start past the ORIGINAL's end.
    const starts = patch.getHunksList().map((h) => h.getNewStart());
    expect(Math.max(...starts)).toBeGreaterThan(countLines(original) + 1);

    const viaEnvelope = apply(original, patch);
    expect(viaEnvelope.getError()).toBe('');
    expect(viaEnvelope.getText()).toBe(revised);

    const req = new PatchApplyRequest();
    req.setOriginal(original);
    req.setUnifiedDiff(patch.getUnifiedDiff());
    const viaScalar = applyPatch(ctx, req);
    expect(viaScalar.getError()).toBe('');
    expect(viaScalar.getText()).toBe(revised);
  });

  // REGRESSION. jsdiff scans the last hunk for any "\\"-prefixed line and strips
  // the trailing newline of the PRECEDING line's side. A marker parked mid-hunk
  // after a "+" line therefore silently removed the result's trailing newline
  // while the "@@" counts still balanced — validator and applier disagreeing
  // about the same bytes, and the round trip no longer exact. Reachable through
  // BOTH input paths, so any diff arriving from git or another agent could
  // carry it.
  it('SECURITY: rejects an end-of-file marker that does not terminate a side', () => {
    const smuggled = hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }, [
      ' a', '+X', '\\ No newline at end of file', ' b',
    ]);
    const out = apply('a\nb\n', smuggled);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not terminate a side');
    expect(out.getText()).toBe('');

    // The same smuggled marker arriving as unified-diff TEXT must also be refused.
    const req = new PatchApplyRequest();
    req.setOriginal('a\nb\n');
    req.setUnifiedDiff('--- a\n+++ b\n@@ -1,2 +1,3 @@\n a\n+X\n\\ No newline at end of file\n b\n');
    const viaText = applyPatch(ctx, req);
    expect(viaText.getApplied()).toBe(false);
    expect(viaText.getError()).toContain('does not terminate a side');

    // A marker in a LEGITIMATE terminating position still works: as the final
    // line, and between the "-" run and the "+" run.
    expect(apply('a\nb', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file',
    ])).getError()).toBe('');
  });

  // A hunk that changes nothing passes every count check (0 === 0) and jsdiff
  // "applies" it at the first probed position, so it reproduced exactly the
  // silent no-op the hunk-less guard exists to prevent: applied:true, text
  // unchanged, no error, and the caller believing their edit landed.
  it('ERROR PATH: rejects a hunk with an empty body rather than applying a no-op', () => {
    const out = apply('a\nb\n', hunk({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0 }, []));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('empty body');
  });

  // REGRESSION. MAX_HUNKS was a flat 2,000 while Diff at context_lines:-1 can
  // emit one hunk per changed line — 2,500 from a 5,000-line original — so
  // ApplyPatch refused patches Diff had just produced, on BOTH paths. Every
  // budget must admit any patch Diff can emit; none may be set independently
  // of the input caps.
  it('BOUNDS: a zero-context patch at the line cap still round-trips', () => {
    const n = MAX_LINES;
    const original = Array.from({ length: n }, (_, i) => `L${i}`).join('\n') + '\n';
    const revised = Array.from({ length: n }, (_, i) => (i % 2 ? `L${i}` : `X${i}`)).join('\n') + '\n';

    const input = new TextPair();
    input.setOriginal(original);
    input.setRevised(revised);
    input.setContextLines(-1);
    const patch = diff(ctx, input);
    expect(patch.getError()).toBe('');
    // Guard the premise: this really is a patch with more hunks than the old cap.
    expect(patch.getHunksList().length).toBeGreaterThan(2000);

    const out = apply(original, patch);
    expect(out.getError()).toBe('');
    expect(out.getText()).toBe(revised);
  }, 120_000);

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

  // The node advertises EXACT content matching. jsdiff defaults
  // autoConvertLineEndings ON when the option is omitted, which silently
  // rewrites an LF patch to match a CRLF original — so "-b" would delete "b\r",
  // a byte the patch author never wrote. Pinned off, so the mismatch is refused
  // and the contract is ours rather than the library's default-of-the-day.
  it('SECURITY: refuses an LF patch against a CRLF original instead of silently converting', () => {
    const out = apply('a\r\nb\r\n', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [' a', '-b', '+Z']));
    expect(out.getApplied()).toBe(false);
    expect(out.getText()).toBe('');

    // A CRLF patch against a CRLF original still applies exactly.
    const crlf = makeDiff('a\r\nb\r\n', 'a\r\nZ\r\n');
    const ok = apply('a\r\nb\r\n', crlf);
    expect(ok.getError()).toBe('');
    expect(ok.getText()).toBe('a\r\nZ\r\n');
  });

  // REGRESSION (the fourth instance of validator-vs-applier disagreement).
  // jsdiff's EOFNL pass scans only the LAST hunk for a "\\" line, reads the
  // preceding line's prefix, then pops or pushes a trailing empty line on the
  // WHOLE result before any hunk is fitted. So a STRUCTURALLY legal marker on a
  // hunk that touches line 1 of a long file silently added or removed the
  // trailing newline of the entire output, counts balancing and applied:true.
  // Validating the marker's neighbours is not enough — the side it claims to
  // terminate must actually end at EOF, and only the final hunk can.
  it('SECURITY: refuses an end-of-file marker on a hunk that does not reach the end', () => {
    // Would have silently ADDED a trailing newline.
    const adds = apply('a\nb\nc', hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, [
      '-a', '\\ No newline at end of file', '+X',
    ]));
    expect(adds.getApplied()).toBe(false);
    expect(adds.getError()).toContain('does not reach the end');

    // Would have silently REMOVED the trailing newline.
    const removes = apply('a\nb\nc\n', hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }, [
      '-a', '+X', '\\ No newline at end of file',
    ]));
    expect(removes.getApplied()).toBe(false);
    expect(removes.getError()).toContain('does not reach the end');

    // Same corruption arriving as unified-diff TEXT is refused too.
    const req = new PatchApplyRequest();
    req.setOriginal('a\nb\nc');
    req.setUnifiedDiff('--- o\n+++ r\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+X\n');
    const viaText = applyPatch(ctx, req);
    expect(viaText.getApplied()).toBe(false);
    expect(viaText.getError()).toContain('does not reach the end');

    // A marker on a hunk that DOES reach the end still works — this is the
    // legitimate case the rule must not break.
    const ok = apply('a\nb', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file',
    ]));
    expect(ok.getError()).toBe('');
    expect(ok.getText()).toBe('a\nB');
  });

  it('SECURITY: refuses an end-of-file marker on a non-final hunk', () => {
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
    expect(out.getError()).toContain('is not the last hunk');
  });

  // REGRESSION. A marker is a DECLARATION — "the side ending here has no
  // trailing newline" — and jsdiff's EOFNL prescan acts on it without checking
  // whether the claim is true. Three ways a structurally-legal marker lied:
  it('SECURITY: refuses an end-of-file marker whose claim contradicts the text', () => {
    // (1) Marker after a final context line, but the original DOES end with a
    // newline — the patch declares the result unterminated, jsdiff ignores the
    // declaration, and the output silently keeps the newline.
    const contradicts = apply('a\nb\n', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      '-a', '+A', ' b', '\\ No newline at end of file',
    ]));
    expect(contradicts.getApplied()).toBe(false);
    expect(contradicts.getError()).toContain('the original does end with a newline');

    // (2) Mid-hunk marker claiming the old side ends, with a context line still
    // to come — so the old side does NOT end there. jsdiff honoured the first
    // marker and PUSHED a newline, the exact opposite of the final marker.
    const continues = apply('a\nc', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      '-a', '\\ No newline at end of file', '+b', ' c', '\\ No newline at end of file',
    ]));
    expect(continues.getApplied()).toBe(false);
    expect(continues.getError()).toContain('the original side continues after it');

    // The honest form of (2) — nothing on the old side after the marker — works.
    const honest = apply('a\nb', hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' a', '-b', '\\ No newline at end of file', '+B', '\\ No newline at end of file',
    ]));
    expect(honest.getError()).toBe('');
    expect(honest.getText()).toBe('a\nB');
  });

  // REGRESSION — marker-free route to an undeclared trailing-newline change.
  // jsdiff applies against source.split('\n'), whose last element for a
  // newline-terminated text is a PHANTOM empty string this package's line model
  // does not have. A marker-free hunk addressing that element deletes or inserts
  // it, silently stripping or fabricating the file's trailing newline with
  // balanced counts, legal prefixes and applied:true. Every earlier end-of-file
  // guard keyed on a "\\" marker, so all of them were bypassed by omitting one.
  // The invariant is now checked on the APPLIED BYTES, which closes the family
  // rather than the instance.
  it('SECURITY: refuses a marker-free patch that changes the trailing newline', () => {
    const strips = apply('a\n', hunk({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 0 }, ['-']));
    expect(strips.getApplied()).toBe(false);
    expect(strips.getError()).toContain('changes the trailing newline without declaring it');

    const fabricates = apply('a', hunk({ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1 }, ['+']));
    expect(fabricates.getApplied()).toBe(false);
    expect(fabricates.getError()).toContain('changes the trailing newline without declaring it');

    // Same route via unified-diff text.
    const req = new PatchApplyRequest();
    req.setOriginal('a\n');
    req.setUnifiedDiff('--- original\n+++ revised\n@@ -2 +1,0 @@\n-\n');
    const viaText = applyPatch(ctx, req);
    expect(viaText.getApplied()).toBe(false);
    expect(viaText.getError()).toContain('changes the trailing newline without declaring it');
  });

  // REGRESSION — jsdiff RELOCATES a hunk whose context does not match at its
  // declared line, but its end-of-file pass runs BEFORE any hunk is fitted. A
  // marker-bearing hunk could therefore be relocated into the middle of the file
  // and still strip the trailing newline off a final line it never mentions.
  // Validating the declared position cannot secure a relocating applier, so a
  // marker-bearing hunk must now match exactly where it claims to.
  it('SECURITY: refuses a marker-bearing hunk that would be relocated', () => {
    const out = apply('x\nx\nx\ny\n', hunk({ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }, [
      '-x', '+z', '\\ No newline at end of file',
    ]));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('must match exactly at its declared line');
    expect(out.getText()).toBe('');
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

  it('ERROR PATH: rejects a hunk whose declared counts contradict its body', () => {
    // jsdiff positions by the declared counts but edits by the body, so a lying
    // header would still "apply". The envelope must not let header and body
    // disagree — reject it. Body is 1 context + 1 removed + 1 added.
    const lying = hunk({ oldLines: 99, newLines: 99 }, [' line1', '-line2', '+X']);
    const out = apply(ORIGINAL, lying);
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('does not match its body');
    expect(out.getText()).toBe('');

    // The honest counts for that same body (old = context+removed = 2,
    // new = context+added = 2) are accepted.
    const honest = hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }, [
      ' line1',
      '-line2',
      '+X',
    ]);
    expect(apply(ORIGINAL, honest).getError()).toBe('');
  });

  it('COMPAT: the unified diff Diff emits is accepted by the system `git apply`', () => {
    // Backs the "standard, git-apply-compatible unified diff" claim with a real
    // external oracle rather than a self-check.
    //
    // This test must FAIL, not silently pass, when git is missing: an oracle
    // that disappears with a green tick is indistinguishable in the suite output
    // from one that ran and proved something, which is exactly how an unbacked
    // claim survives review. It also drives the FULL corpus (CRLF, Unicode,
    // empty sides, trailing-newline edges) rather than three hand-picked pairs,
    // and does NOT pass --unidiff-zero, which would relax git's own context
    // checking and weaken the oracle it is here to be.
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    for (const [original, revised] of CORPUS) {
      // git apply cannot represent a change to a file with no content on either
      // side as an in-tree patch of an existing file; those are covered by the
      // round-trip and ParseUnifiedDiff tests instead.
      if (original === '' || revised === '') continue;
      // Identical texts produce an empty diff, which git rightly refuses as
      // "No valid patches in input" — there is nothing for the oracle to check.
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

  it('ERROR PATH: rejects a hunk pointing far past the end of the text', () => {
    const out = apply(ORIGINAL, hunk({ oldStart: 9999, newStart: 9999 }, ['-nope', '+nah']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('starts past the end of the text');
    expect(out.getText()).toBe('');
  });

  // DoS regression. jsdiff locates a hunk by scanning outward from the declared
  // start, so cost is linear in the START MAGNITUDE — a ~150-byte patch with
  // oldStart INT32_MAX burned ~30s of CPU and blew the platform deadline. The
  // char, line, and patch-body caps all fail to constrain it. A small start
  // (the previous test's 9999) returns instantly and cannot detect this, so the
  // bound is asserted here at INT32_MAX *and* timed: the point is that we refuse
  // without ever handing the value to the applier.
  it('BOUNDS: rejects an INT32_MAX hunk start immediately rather than scanning to it', () => {
    const started = Date.now();
    const out = apply(
      ORIGINAL,
      hunk({ oldStart: 2147483647, oldLines: 1, newStart: 2147483647, newLines: 1 }, ['-nope', '+nah']),
    );
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('starts past the end of the text');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // The validator and jsdiff's applier must agree about the same bytes. jsdiff
  // resolves a bare "" body line to a context line (hunkLine[0] is undefined, so
  // the operation defaults to " "); counting it as neither side made ApplyPatch
  // ACCEPT hunks whose header understated their reach and REJECT honest headers.
  // Real diffs carry bare blank context lines whenever trailing whitespace is
  // stripped in transit (git send-email, mailing lists, editors).
  it('SECURITY: counts a bare empty body line as context, agreeing with the applier', () => {
    const original = 'a\n\n\nb\n';

    // The honest header for this body must be ACCEPTED.
    const honest = apply(original, hunk({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 }, [' a', '', '', '-b', '+B']));
    expect(honest.getError()).toBe('');
    expect(honest.getApplied()).toBe(true);
    expect(honest.getText()).toBe('a\n\n\nB\n');

    // A header that lies about its reach must be REFUSED — previously this was
    // accepted and silently consumed 3 old lines while declaring 1.
    const lying = apply(original, hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }, [' a', '', '', '+INJECTED']));
    expect(lying.getApplied()).toBe(false);
    expect(lying.getError()).toContain('does not match its body');
    expect(lying.getText()).toBe('');
  });

  it('SECURITY: rejects a "\\" body line that is not the end-of-file marker', () => {
    const out = apply(ORIGINAL, hunk({ oldLines: 5, newLines: 5 }, [' line1', ' line2', '-line3', '+CHANGED', ' line4', ' line5', '\\ arbitrary payload']));
    expect(out.getApplied()).toBe(false);
    expect(out.getError()).toContain('is not "\\\\ No newline at end of file"');
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

  // The patch budget must admit any patch Diff itself can emit, or the headline
  // round-trip guarantee breaks on input the package accepted without error.
  // A full rewrite is the worst case: every line appears once as "-", once as "+".
  // Table-driven over BOTH supply modes on purpose. A previous round fixed the
  // hunks path only, and the same defect survived on the unified_diff path
  // because scale was tested on one path and the scalar path was tested at one
  // (tiny) scale — the bug lived in the untested intersection. Any future
  // divergence between the two validation paths must fail here.
  describe.each([
    ['envelope (patch)', (o: string, p: Patch) => apply(o, p)],
    ['scalar (unified_diff)', (o: string, p: Patch) => {
      const req = new PatchApplyRequest();
      req.setOriginal(o);
      req.setUnifiedDiff(p.getUnifiedDiff());
      return applyPatch(ctx, req);
    }],
  ])('BOUNDS: a full rewrite at the line cap — %s path', (_label, applyVia) => {
    it('still round-trips through ApplyPatch', () => {
      const n = MAX_LINES;
      const original = Array.from({ length: n }, (_, i) => `alpha-${i}`).join('\n') + '\n';
      const revised = Array.from({ length: n }, (_, i) => `beta-${i}`).join('\n') + '\n';

      const patch = makeDiff(original, revised);
      expect(patch.getError()).toBe('');
      // Guard the premise on BOTH dimensions: a patch is inherently ~2x the text
      // it describes, so it exceeds the input line cap as hunks AND as text.
      const body = patch.getHunksList().reduce((s, h) => s + h.getLinesList().length, 0);
      expect(body).toBeGreaterThan(MAX_LINES);
      expect(patch.getUnifiedDiff().split('\n').length).toBeGreaterThan(MAX_LINES);

      const out = applyVia(original, patch);
      expect(out.getError()).toBe('');
      expect(out.getApplied()).toBe(true);
      expect(out.getText()).toBe(revised);
    }, 60_000);
  });

  it('is deterministic across repeated invocations', () => {
    const patch = makeDiff(ORIGINAL, REVISED);
    const first = apply(ORIGINAL, patch).getText();
    for (let i = 0; i < 5; i++) expect(apply(ORIGINAL, patch).getText()).toBe(first);
  });
});
