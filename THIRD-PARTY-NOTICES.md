# Third-party notices

zipnative-mcp is published under the MIT License (see [LICENSE](LICENSE)). It
has exactly three runtime dependencies (two MIT, one Apache-2.0) and nothing
else ships in the published package. This file lists them, the vendored
scripts, and the specifications the code implements. Development dependencies
(never shipped) are listed in `package.json` and carry their own licences; the
publish workflow attaches a CycloneDX SBOM (`npm sbom`) naming the exact
resolved versions to every GitHub release. This file quotes the version ranges
of `package.json`, so it does not go stale with a lockfile update.

## Runtime dependencies

### zipnative — MIT

`zipnative` (`^1.1.0`). Copyright (c) 2026 Nizoka — Plika (https://plika.app)

The ZIP engine every tool delegates to: parsing, writing, DEFLATE, CRC-32,
Zip64, path sanitisation and the security bounds. https://github.com/Nizoka/zipnative

### @modelcontextprotocol/server and @modelcontextprotocol/core — Apache-2.0

`@modelcontextprotocol/server` (`^2.3.1`) and its dependency
`@modelcontextprotocol/core`. Copyright (c) Anthropic, PBC (https://anthropic.com)

The Model Context Protocol TypeScript SDK v2. From 2.3.0 the packages declare
`"license": "Apache-2.0"`; their `LICENSE` file records the project's
transition from the MIT License to Apache-2.0 — contributions whose authors
have not granted relicensing consent remain under MIT, and no rights beyond the
applicable original licence are conveyed for them. The SDK provides the MCP
transport and request handling (`server/discover` on MCP 2026-07-28, the
legacy `initialize` fallback, stdio framing and the Streamable HTTP handler).
https://github.com/modelcontextprotocol/typescript-sdk

### zod — MIT

`zod` (`^4.6.5`). Copyright (c) 2025 Colin McDonnell

Runtime input validation at every tool boundary. https://github.com/colinhacks/zod

## MIT License (applies to zipnative and zod)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions: the above copyright notice and this
permission notice shall be included in all copies or substantial portions of
the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

The full licence text of each dependency is shipped in its own package
(`node_modules/<name>/LICENSE`).

## Vendored scripts (repository only, not in the npm package)

The `scripts/` and `tests/` directories carry code copied — not imported —
from sibling repositories, because those repositories do not ship it in their
npm tarballs. The `scripts/` copies pin the upstream commit and blob in their
header (asserted by `tests/verazip-vendor.test.ts`); the adapted `src/` modules and
the `docs/data` files name their upstream file and version:

| File | Upstream | Licence |
| --- | --- | --- |
| `scripts/verazip-core.mjs`, `scripts/validate-zip.mjs` | zipnative `scripts/validate-zip.ts` (via zipnative-cli `scripts/validate-zip.mjs`) | MIT (Nizoka) |
| `scripts/helpers/interop-tools.mjs` | zipnative `tests/helpers/interop-tools.ts` (via zipnative-cli) | MIT (Nizoka) |
| `scripts/helpers/raw-zip-builder.mjs`, `tests/_fixtures/raw-zip-builder.ts` | zipnative `tests/helpers/raw-zip-builder.ts` | MIT (Nizoka) |
| `src/entry.ts`, `src/filter.ts`, `src/zip-errors.ts` (adapted) | zipnative-cli `src/utils/{entryfmt,glob,ziperr}.ts` | MIT (Nizoka) |
| `docs/data/errors.json`, `docs/data/core-exports.json` | zipnative-cli `docs/data/` | MIT (Nizoka) |

zipnative and zipnative-cli: Copyright (c) 2026 Nizoka, MIT License.

## Specifications (references, not code)

- ZIP: PKWARE APPNOTE.TXT — .ZIP File Format Specification
- ISO/IEC 21320-1:2015 — Document Container File (the profile the veraZIP gate validates)
- DEFLATE: RFC 1951 (P. Deutsch, 1996)
- CRC-32: ISO/IEC 3309 polynomial 0xEDB88320
- Model Context Protocol specification 2026-07-28 (https://modelcontextprotocol.io)
