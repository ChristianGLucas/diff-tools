# diff-tools

Composable text-diff nodes for the [Axiom](https://axiom.dev) marketplace,
published as `christiangeorgelucas/diff-tools`.

Agents produce and consume patches constantly — proposing an edit, reviewing a
change, checking whether two versions of a document actually differ. These nodes
make that a typed, deterministic, offline operation instead of something an LLM
has to eyeball.

Everything is built around **one canonical envelope, `Patch`**, which carries
both the unified-diff text and the structured hunks encoding the same change.
`Diff` and `ParseUnifiedDiff` emit it; `ApplyPatch` consumes it:

```
Diff             -> Patch -> ApplyPatch      # reproduces the revised text exactly
ParseUnifiedDiff -> Patch -> ApplyPatch      # applies a diff produced anywhere
```

## Nodes

| Node | In → Out | What it does |
|---|---|---|
| `Diff` | `TextPair` → `Patch` | Line diff of two texts, as unified-diff text **and** structured hunks. |
| `ApplyPatch` | `PatchApplyRequest` → `PatchApplyResult` | Applies a patch to a text. Exact matching — never fuzzy, never partial. |
| `ParseUnifiedDiff` | `UnifiedDiffText` → `Patch` | Parses a unified diff from git, `diff -u`, or another agent. |
| `Similarity` | `Texts` → `SimilarityScore` | Line-level similarity in `[0.0, 1.0]`, plus the raw line counts. |
| `Stats` | `Texts` → `DiffStats` | Lines added/deleted and changed-block count, `git diff --shortstat` style. |

## Guarantees

- **Exact round trip.** `ApplyPatch(original, Diff(original, revised))` reproduces
  `revised` byte for byte — trailing newlines, CRLF endings, and Unicode all
  survive. Enforced by a test over a corpus of newline and encoding edge cases.
- **Standard, apply-compatible format.** `unified_diff` is a valid, minimal
  unified diff (`---`/`+++`/`@@` hunks, including the `\ No newline at end of
  file` marker); the system `git apply` accepts it (checked by a differential
  test) and `ParseUnifiedDiff` re-parses it to identical hunks. jsdiff's
  non-standard `=====` index separator is stripped. It is standard-conformant but
  **not** byte-identical to any one tool — GNU `diff -u` drops the `,1` on
  single-line ranges and may pick a different equally-minimal alignment.
- **Self-consistent envelope.** A `Patch`'s hunk numbers always match the `@@`
  headers in its own `unified_diff`, a hunk's header counts must match its body,
  and a parsed patch is indistinguishable from a generated one.
- **Strict, not permissive.** Prose that merely *talks about* a change is
  rejected rather than silently reported as "no changes"; a malformed `@@` header
  is an error, not a null-numbered hunk; a patch whose context does not match is
  refused rather than fuzzy-matched; and a header name containing a line break —
  which could forge extra diff headers — is rejected.
- **Bounded cost.** Inputs are capped at 1,000,000 characters and 5,000 lines per
  text. The diff is O(N·D), so two wholly-dissimilar texts are the worst case;
  the cap holds that under ~3.5s instead of the ~44s that 20,000 lines would take.
- **Deterministic and offline.** No network, no state, no secrets, no clock.

### Line model

An empty text is zero lines, and a trailing newline closes the final line rather
than adding an empty one — `"a\nb"` and `"a\nb\n"` are both two lines. A line
carries its terminator, so `"b"` and `"b\n"` are *not* the same line: adding or
removing a trailing newline is a real change, and every node reports it as one.

## Correctness

Beyond golden tests, the suite includes an **independent oracle**: a from-scratch
longest-common-subsequence dynamic program that shares no code with the underlying
library. `Similarity`'s matching-line count and `Stats`' added/deleted counts are
checked against it across the whole corpus, so agreement is evidence of
correctness rather than of self-consistency. A separate differential test shells
out to the system `git apply` to confirm the emitted diffs are genuinely
apply-compatible, not merely self-consistent.

## Built on

[jsdiff](https://github.com/kpdecker/jsdiff) (`diff` 8.0.2, BSD-3-Clause), which
owns the diff algorithm, unified-diff formatting and parsing, and patch
application. It has zero transitive runtime dependencies. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE). Built for the Axiom marketplace.
