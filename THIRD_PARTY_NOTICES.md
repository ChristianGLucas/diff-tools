# Third-party notices

`christiangeorgelucas/diff-tools` is MIT licensed. It ships with the runtime
dependency tree below, every entry of which is a permissive, non-copyleft
license (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, or the BSD-3-Clause /
Apache-2.0 dual license). There is **no** GPL/AGPL/LGPL/MPL/EPL/CDDL anywhere in
the tree. The tree was resolved and audited from `package-lock.json` and the
installed `LICENSE`/`COPYING` files, not from registry metadata alone.

This file covers the **runtime** tree only — the dependencies that ship in the
built artifact. `devDependencies` (the jest / ts-jest / typescript / babel build
toolchain) are build-time only and are never distributed, so they require no
notice here. That exclusion is deliberate, not an omission: the dev-only tree
does contain two non-standard-but-permissive licenses a future audit will
otherwise flag — `caniuse-lite` (CC-BY-4.0, via browserslist/babel) and
`type-fest` (MIT OR CC0-1.0) — and neither reaches the artifact.

## The library this package wraps

The one dependency this package's own code imports is **`diff` (jsdiff) 8.0.2,
BSD-3-Clause** — it owns the diff algorithm, unified-diff formatting and parsing,
and patch application, and has **zero transitive runtime dependencies**. Its
license text is reproduced in full at the end of this file. Everything else in
the tree below is the standard Axiom node runtime, scaffolded by `axiom init`
(the gRPC transport, protobuf, and OpenTelemetry stack).

## Full runtime dependency tree

License family totals: Apache-2.0 (33), MIT (31), BSD-3-Clause (11), ISC (5),
BSD-2-Clause (1), BSD-3-Clause AND Apache-2.0 dual (1) — 82 packages, all
permissive.

| Package | Version | License (SPDX) |
|---|---|---|
| `@grpc/grpc-js` | 1.14.4 | Apache-2.0 |
| `@grpc/proto-loader` | 0.8.1 | Apache-2.0 |
| `@grpc/proto-loader` | 0.7.15 | Apache-2.0 |
| `@js-sdsl/ordered-map` | 4.4.2 | MIT |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 |
| `@opentelemetry/api-logs` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/context-async-hooks` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/core` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/exporter-logs-otlp-grpc` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-logs-otlp-http` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-logs-otlp-proto` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-metrics-otlp-grpc` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-metrics-otlp-proto` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-prometheus` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-trace-otlp-grpc` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-trace-otlp-proto` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/exporter-zipkin` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/instrumentation` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/otlp-exporter-base` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/otlp-grpc-exporter-base` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/otlp-transformer` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/propagator-b3` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/propagator-jaeger` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/resources` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/sdk-logs` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/sdk-metrics` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/sdk-node` | 0.57.2 | Apache-2.0 |
| `@opentelemetry/sdk-trace-base` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/sdk-trace-node` | 1.30.1 | Apache-2.0 |
| `@opentelemetry/semantic-conventions` | 1.28.0 | Apache-2.0 |
| `@protobufjs/aspromise` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/base64` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/codegen` | 2.0.5 | BSD-3-Clause |
| `@protobufjs/eventemitter` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/fetch` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/float` | 1.0.2 | BSD-3-Clause |
| `@protobufjs/path` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/pool` | 1.1.0 | BSD-3-Clause |
| `@protobufjs/utf8` | 1.1.2 | BSD-3-Clause |
| `@types/node` | 20.19.43 | MIT |
| `@types/shimmer` | 1.2.0 | MIT |
| `acorn` | 8.17.0 | MIT |
| `acorn-import-attributes` | 1.9.5 | MIT |
| `ansi-regex` | 5.0.1 | MIT |
| `ansi-styles` | 4.3.0 | MIT |
| `cjs-module-lexer` | 1.4.3 | MIT |
| `cliui` | 8.0.1 | ISC |
| `color-convert` | 2.0.1 | MIT |
| `color-name` | 1.1.4 | MIT |
| `debug` | 4.4.3 | MIT |
| `diff` | 8.0.2 | BSD-3-Clause |
| `emoji-regex` | 8.0.0 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `escalade` | 3.2.0 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-caller-file` | 2.0.5 | ISC |
| `google-protobuf` | 3.21.4 | (BSD-3-Clause AND Apache-2.0) |
| `hasown` | 2.0.4 | MIT |
| `import-in-the-middle` | 1.15.0 | Apache-2.0 |
| `is-core-module` | 2.16.2 | MIT |
| `is-fullwidth-code-point` | 3.0.0 | MIT |
| `lodash.camelcase` | 4.3.0 | MIT |
| `long` | 5.3.2 | Apache-2.0 |
| `module-details-from-path` | 1.0.4 | MIT |
| `ms` | 2.1.3 | MIT |
| `path-parse` | 1.0.7 | MIT |
| `protobufjs` | 7.6.5 | BSD-3-Clause |
| `require-directory` | 2.1.1 | MIT |
| `require-in-the-middle` | 7.5.2 | MIT |
| `resolve` | 1.22.12 | MIT |
| `semver` | 7.8.5 | ISC |
| `shimmer` | 1.2.1 | BSD-2-Clause |
| `string-width` | 4.2.3 | MIT |
| `strip-ansi` | 6.0.1 | MIT |
| `supports-preserve-symlinks-flag` | 1.0.0 | MIT |
| `undici-types` | 6.21.0 | MIT |
| `wrap-ansi` | 7.0.0 | MIT |
| `y18n` | 5.0.8 | ISC |
| `yargs` | 17.7.3 | MIT |
| `yargs-parser` | 21.1.1 | ISC |

Each package's declared `license` field was cross-checked against its installed
license text; `google-protobuf` correctly declares the dual
`(BSD-3-Clause AND Apache-2.0)` and ships both texts. The permissive BSD/MIT/ISC
notice-retention conditions are satisfied by preserving this file and each
package's own bundled `LICENSE` in `node_modules` as installed.

---

## diff (jsdiff) 8.0.2 — BSD-3-Clause (full text)

<https://github.com/kpdecker/jsdiff>

```
BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
