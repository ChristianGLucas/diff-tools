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

**Composing inside a flow.** A flow edge currently carries only *scalar* leaves,
so the nested `Patch` message cannot be routed across one — attempting it fails
at run time with `encoding kind KIND_MESSAGE not implemented`, after compiling
green. `ApplyPatch` therefore also accepts the diff as **text**, via its scalar
`unified_diff` input, which is how the chain is wired in a flow:

```
Diff.unified_diff -> ApplyPatch.unified_diff   # scalar hop, parsed strictly
```

There is a second, more fundamental limit, and it is honest to state it
plainly: **`ApplyPatch` cannot terminate a pure diff-tools flow.** It needs the
*original* text, and a `Patch` does not carry it — a patch describes a change,
not the thing it changes. A downstream edge sees only its upstream node's
output, and no node here emits the original text, so `original` has to be
supplied by the caller. `Diff → ApplyPatch` is therefore an **invoke-level**
composition (verified exactly, over the whole corpus, by the round-trip and
`COMPOSE` tests), not a two-node flow. Inside a flow, `ApplyPatch` belongs in a
compose join whose other source carries the text being patched.

The flow that *is* expressible end to end is
[`flows/diff-roundtrip.flow.yaml`](flows/diff-roundtrip.flow.yaml) —
`Diff → ParseUnifiedDiff`, a scalar hop proving the emitted diff is genuinely
re-parseable.

## Nodes

| Node | In → Out | What it does |
|---|---|---|
| `Diff` | `TextPair` → `Patch` | Line diff of two texts, as unified-diff text **and** structured hunks. |
| `ApplyPatch` | `PatchApplyRequest` → `PatchApplyResult` | Applies a patch — as a `Patch` envelope or as unified-diff text — to a text. Exact matching, never fuzzy, never partial. |
| `ParseUnifiedDiff` | `UnifiedDiffText` → `Patch` | Parses a unified diff from git, `diff -u`, or another agent. |
| `Similarity` | `Texts` → `SimilarityScore` | Line-level similarity in `[0.0, 1.0]`, plus the raw line counts. |
| `Stats` | `Texts` → `DiffStats` | Lines added/deleted and changed-block count, `git diff --shortstat` style. |

## Guarantees

- **Exact round trip.** `ApplyPatch(original, Diff(original, revised))` reproduces
  `revised` byte for byte — trailing newlines, CRLF endings, and Unicode all
  survive. Enforced by a test over a corpus of newline and encoding edge cases,
  and by a full-rewrite round trip **at the 5,000-line cap**, so the guarantee is
  proven at the scale where the caps interact rather than only on short inputs.
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
  refused rather than fuzzy-matched; and a header name containing a line break,
  control character, or Unicode line separator — which could forge extra diff
  headers or corrupt a downstream consumer — is rejected. A patch that arrives
  carrying an upstream `error`, or with no hunks and not marked `identical`, is
  refused rather than applied as a silent no-op: a failed step upstream must not
  read as a successful identity.
- **Bounded cost.** Inputs are capped at 1,000,000 characters and 5,000 lines per
  text, and a patch body at 10,002 lines — twice the line cap, so any patch `Diff`
  can emit is one `ApplyPatch` will accept. The diff is O(N·D), so two
  wholly-dissimilar texts are the worst case: measured at roughly 2.0s at 2,000
  lines and **~7-8s at the 5,000-line cap**, versus the ~44s that 20,000 lines
  would take. Hunk start lines are bounded by the text being patched, because the
  applier locates a hunk by scanning outward from the declared start — an
  unbounded start is a denial of service that no size cap constrains.
- **Deterministic and offline.** No network, no state, no secrets, no clock.

### Line model

An empty text is zero lines, and a trailing newline closes the final line rather
than adding an empty one — `"a\nb"` and `"a\nb\n"` are both two lines. A line
carries its terminator, so `"b"` and `"b\n"` are *not* the same line: adding or
removing a trailing newline is a real change, and every node reports it as one.

## Errors

Failures come back in one of two shapes, and the difference is worth knowing:

- **Semantic failures** — anything this package decides to reject (a context
  mismatch, prose instead of a diff, an out-of-range `context_lines`, a bound
  exceeded) — return a **success status with an in-band `error` field** set on
  the output message, and the other fields zeroed. Every node uses this contract,
  with stable wording. `ApplyPatch` additionally sets `applied: false`, and never
  returns a half-patched text: on any failure `text` is empty.
- **Schema failures** — input that does not match the message type at all (a
  number where a string belongs) — are rejected by the platform *before* the node
  runs, and come back as a transport-level **400** in a different shape
  (`{error_message, execution_id}`).

So a caller checking only the HTTP status will miss every semantic failure:
check the `error` field.

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
