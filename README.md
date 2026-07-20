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
| `Similarity` | `TextPair` → `SimilarityScore` | Line-level similarity in `[0.0, 1.0]`, plus the raw line counts. |
| `Stats` | `TextPair` → `DiffStats` | Lines added/deleted and changed-block count, `git diff --shortstat` style. |

## Guarantees

- **Exact round trip.** `ApplyPatch(original, Diff(original, revised))` reproduces
  `revised` byte for byte — trailing newlines, CRLF endings, and Unicode all
  survive. Enforced by a test over a corpus of newline and encoding edge cases.
- **Standard format.** `unified_diff` is byte-for-byte what GNU `diff -u` emits,
  including the `\ No newline at end of file` marker, so it pipes straight into
  `git apply` or `patch`. jsdiff's non-standard `=====` index separator is stripped.
- **Self-consistent envelope.** A `Patch`'s hunk numbers always match the `@@`
  headers in its own `unified_diff`, and a parsed patch is indistinguishable from
  a generated one.
- **Strict, not permissive.** Prose that merely *talks about* a change is
  rejected rather than silently reported as "no changes"; a malformed `@@` header
  is an error, not a null-numbered hunk; a patch whose context does not match is
  refused rather than fuzzy-matched.
- **Bounded cost.** Inputs are capped at 1,000,000 characters and 5,000 lines per
  text. The diff is O(N·D), so two wholly-dissimilar texts are the worst case;
  the cap holds that under ~2.5s instead of the ~44s that 20,000 lines would take.
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
correctness rather than of self-consistency. Golden unified diffs were verified
character-for-character against GNU `diff -u`.

## Built on

[jsdiff](https://github.com/kpdecker/jsdiff) (`diff` 8.0.2, BSD-3-Clause), which
owns the diff algorithm, unified-diff formatting and parsing, and patch
application. It has zero transitive runtime dependencies. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE). Built for the Axiom marketplace.
