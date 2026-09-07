# Third-party notices

zipnative-mcp is published under the MIT License (see [LICENSE](LICENSE)). It
has exactly three runtime dependencies, all MIT-licensed; nothing else ships in
the published package. This file lists them, the vendored scripts, and the
specifications the code implements. Development dependencies (never shipped)
are listed in `package.json` and carry their own licences; the publish
workflow attaches a CycloneDX SBOM (`sbom.cdx.json`) to every GitHub release.

## Runtime dependencies

### zipnative — MIT

Copyright (c) 2026 Nizoka — Plika (https://plika.app)

The ZIP engine every tool delegates to: parsing, writing, DEFLATE, CRC-32,
Zip64, path sanitisation and the security bounds. https://github.com/Nizoka/zipnative

### @modelcontextprotocol/server and @modelcontextprotocol/core — MIT

Copyright (c) Anthropic, PBC (https://anthropic.com)

The Model Context Protocol TypeScript SDK v2 (`@modelcontextprotocol/server`
depends on `@modelcontextprotocol/core`). The MCP project is transitioning
from the MIT License to Apache-2.0 for new contributions; the versions this
package depends on are published under MIT (`"license": "MIT"` in their
`package.json`). https://github.com/modelcontextprotocol/typescript-sdk

### zod — MIT

Copyright (c) 2025 Colin McDonnell

Runtime input validation at every tool boundary. https://github.com/colinhacks/zod

## MIT License (applies to the three dependencies above)

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
npm tarballs. Each copy pins the upstream commit and blob it was taken from in
its header (asserted by `tests/verazip-vendor.test.ts`):

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
