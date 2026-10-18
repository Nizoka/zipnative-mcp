# zipnative-mcp

> **MCP server for ZIP archives — deterministic creation, inspection and listing without extracting, random-access entry reads, secure-by-default extraction, one-call verification, forward scanning of truncated streams, incremental modification without recompression, CRC-32 and raw-DEFLATE inflation** — 13 tools on the [zipnative](https://github.com/Nizoka/zipnative) engine (zero-dependency, ISO/IEC 21320-1 conformance validated in CI), for Claude Desktop, Cursor, ChatGPT and any MCP client.

[![npm version](https://img.shields.io/npm/v/zipnative-mcp.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/zipnative-mcp)
[![npm downloads](https://img.shields.io/npm/dm/zipnative-mcp.svg?logo=npm)](https://www.npmjs.com/package/zipnative-mcp)
[![Node version](https://img.shields.io/node/v/zipnative-mcp.svg?logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Nizoka/zipnative-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nizoka/zipnative-mcp/actions/workflows/ci.yml)
[![ISO 21320-1 · veraZIP](https://github.com/Nizoka/zipnative-mcp/actions/workflows/verazip.yml/badge.svg)](https://github.com/Nizoka/zipnative-mcp/actions/workflows/verazip.yml)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-6f42c1.svg)](https://modelcontextprotocol.io)
[![zipnative](https://img.shields.io/badge/zipnative-1.0-2563EB.svg)](https://github.com/Nizoka/zipnative)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Nizoka/zipnative-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/Nizoka/zipnative-mcp)
[![CodeQL](https://github.com/Nizoka/zipnative-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/Nizoka/zipnative-mcp/actions/workflows/codeql.yml)

---

## ✨ Features

`zipnative-mcp` exposes **13 tools** to any MCP host:

| Tool | What it does | Read-only |
| ---- | ------------ | :-------: |
| `inspect_zip` | ONE-call archive report: sizes, entry / file / directory counts, Zip64, comment, compressed vs uncompressed totals, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date range, a **determinism verdict** (the structural one: epoch timestamps + canonical order + UTF-8 flags) and every engine diagnostic. Opens eagerly: every entry's real extent is checked up front — overlapping entries, entries reaching into the central directory or past EOF, Zip64 spoofing — and refused with their `ZIP_*` code (a method / CRC / size divergence between central and local headers is caught by `verify_zip` and on read, not here). `check: […]` + `assert: {…}` turn it into a **CI gate**. | ✓ |
| `list_zip_entries` | Paged central-directory inventory, nothing decompressed — every entry as a full row (sizes, CRC-32, method, timestamp, flags, Unix mode, symlink, Zip64, offsets, extra fields, the sanitized path an extraction would use, raw name bytes). `filter` by names / prefix / glob, `offset` + `limit` (200 default, 2000 max). | ✓ |
| `read_zip_entry` | ONE entry by `name` or `index` without extracting: decompressed content as base64 or UTF-8 text (CRC-verified), a byte `range` through the chunked stream, the raw compressed payload (`mode: 'raw'`), or a non-throwing integrity check (`mode: 'verify'`). | ✓ |
| `verify_zip` | Deep verification in one call — the engine's `verifyZip` report verbatim: structure, every entry's CRC-32 / size / local-header agreement, encrypted entries honestly `skipped` — while an entry whose method has no codec here (anything but 0 store / 8 deflate) is reported **failed**, not skipped. **Never `isError` for an archive problem**: branch on `ok` and `error.code`. | ✓ |
| `extract_zip` | **Secure by default**: zip-slip / device names, symlinks, duplicate paths, declared-size and ratio bombs, overlapping entries and central/local divergence refused with frozen `ZIP_*` codes; relaxations are explicit named inputs that skip, never emit. Inline files (`includeData: false` = dry run — it opens eagerly and refuses an overlapping, offset-into-CD or Zip64-spoofed archive before returning any plan) or streamed into the sandbox with resource links. | |
| `scan_zip_forward` | Walk local headers in stream order with bounded memory — the only tool that works on a **truncated download or a cut / unseekable stream that starts at a local header**, and the only one whose result is NOT authoritative (`trust: 'local-headers-only'`). `tolerateTruncation: true` returns the partial inventory plus the error. It cannot skip an SFX / prepended prefix and refuses one (`ZIP_SIGNATURE_MISMATCH`): `inspect_zip` reports it (`prependedData`, `ZIP_PREPENDED_DATA`) and `modify_zip mode: 'compact'` drops it. | ✓ |
| `sanitize_entry_paths` | The engine's single traversal gate over a list of names: the safe `/`-relative form each maps to, or `null` with the rule that fired (traversal, absolute, drive, UNC, NUL, ADS, device name). No archive needed. | ✓ |
| `create_zip` | Write a ZIP from inline text / base64 / sandbox files (up to 100 000 entries — Zip64 auto-promotes past 65 535). **Reproducible on one runtime by default** (canonical order, DOS-epoch timestamps, UTF-8 names); `compression.deterministic: true` for identical bytes on every runtime — `summary.deterministic` is `true` ONLY then (a default call reports `false` with `deflateTier: 'node-zlib'`); store / deflate at archive or entry level; `order: 'insertion'` for EPUB / JAR; comments, Unix modes, extra fields; streamed sources; the worker pool (`parallel`, byte-identical); `includeSha256` proofs in base64 and file mode. | |
| `modify_zip` | add / replace / remove / rename / setComment **without recompressing anything**. `mode: 'append'` keeps the original bytes verbatim (removed content stays recoverable — data remanence, said loudly); `mode: 'compact'` rewrites canonically so it is truly gone. | |
| `compute_crc32` | The ZIP checksum (IEEE 802.3 CRC-32, the engine's slice-by-8) of text, base64 or a sandbox file streamed in 1 MiB chunks; `seed` chains chunks, `expect` compares. | ✓ |
| `inflate_raw` | Raw DEFLATE (RFC 1951) through the engine's resumable inflater with a **mandatory `maxOutput`** bound: exact `bytesConsumed`, trailing bytes as `leftover`. Feed it `read_zip_entry mode: 'raw'`. |  |
| `describe_engine` | Offline preflight: versions, deflate tiers, runtime codecs and workers, the engine's default limits, the operator ceilings, every server cap, sandbox / cache state, the 39 error codes and 11 diagnostic codes, the deliberately unexposed engine exports. `network` is always `'none'`. | ✓ |
| `draft_governance_issue` | Draft a governance-compliant GitHub issue **locally** for a **human** to review and submit — never submits, no network, no GitHub write path. | |

**What every tool guarantees:**

- 🔐 **Secure by default** — every engine guard is on; a relaxation is an explicit, named input (`rejectTraversal`, `rejectSymlinks`, `onDuplicate`, `limits`) that skips, never emits an unsafe path or materialises a link. Overlaps, central/local divergence and Zip64 spoofing have no opt-out at all.
- 🌐 **No network, ever** — the server has no network code path: no telemetry, no GitHub, no URL from any argument, no operator-configurable endpoint. The only filesystem boundary is `ZIPNATIVE_MCP_OUTPUT_DIR`.
- 🔁 **Reproducible by default, deterministic on request** — `create_zip` emits canonical order, DOS-epoch timestamps and UTF-8 names unless you opt out, so the bytes are stable on one runtime; `compression.deterministic: true` pins the pure-TypeScript encoder for identical SHA-256 on every runtime and is the only setting under which `summary.deterministic` is `true`; `inspect_zip.determinism` is the separate structural verdict (epoch timestamps required); `parallel` is byte-identical.
- 🧭 **Frozen `ZIP_*` error codes, verbatim** — the engine's 39-code vocabulary reaches you unchanged in `_meta.error.code` (with the entry name, the limit that fired, both CRCs, …), plus the wrapper's own 16 codes. Branch on the code, never on the message.
- 🪙 **Token-frugal projections** — the read tools accept `verbosity: 'summary'` and `fields: […]`; produced archives are delivered **once** as an embedded `resource` block, never duplicated into `structuredContent`.
- 📏 **ISO/IEC 21320-1 conformance gate** — every archive the tools write is validated clause by clause by an engine-independent validator (veraZIP) on Linux and Windows in CI and again before publish.

All archive-producing tools support two output modes:

- **`base64`** *(default)* — the archive is returned **once** as an embedded `resource` content block (a `data:application/zip;base64,…` URI); `structuredContent` carries `{ mode, sizeBytes, summary, diagnostics, diagnosticCounts }`.
- **`file`** — the archive is streamed into a sandboxed directory configured via `ZIPNATIVE_MCP_OUTPUT_DIR` (≤ 4 GiB, never overwritten) and the result carries a `resource_link`. File I/O is disabled unless this variable is set; absolute paths, traversal, non-container extensions and NUL bytes are all rejected, and the **real** path of every file read and of every parent written must stay inside the sandbox (a planted symlink or junction is `SECURITY_VIOLATION` on both sides). The same sandbox serves `zipPath` / `sourcePath` **inputs**, so a `create_zip → modify_zip → verify_zip → extract_zip` chain never re-sends the bytes.

**Token-frugal reads.** The read tools (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `describe_engine`) and `extract_zip` accept two optional inputs:

- `verbosity: 'summary'` — a compact scalar-only verdict (drops the rows and payloads). E.g. `verify_zip` → `{ ok, error, entryCount, verifiedCount, failedCount, skippedCount, diagnosticCount }`; `inspect_zip` keeps `deterministic`, `canonicalLayout`, `checksPassed`.
- `fields: ['a', 'b.c']` — projects the structured result to named dot-paths; composes after `verbosity`. Unmatched paths are omitted and reported in `_meta.unmatchedFields` (with `_meta.availableFields`).

Smallest "is this archive intact?" probe: `{ "zipBase64": "…", "verbosity": "summary", "fields": ["ok", "error", "failedCount"] }` on `verify_zip`.

The server also ships **seven MCP prompts** — `secure_extraction`, `reproducible_archive`, `incremental_update`, `forensic_scan`, `verify_before_trust`, `governance_contract`, `draft_issue_workflow` — and exposes every file in the sandbox as a `zipnative://output/{+path}` **resource**.

### Why zipnative?

`zipnative-mcp` inherits every guarantee of the underlying engine:

- **Zero runtime dependencies in the engine** — pure TypeScript, no native bindings, no `eval`; one API across Node ≥ 22, browsers, Deno, Bun and Workers (this server adds only the MCP SDK and zod: three runtime dependencies in total).
- **Safe by default** — path traversal, symlinks, duplicate names, decompression bombs, overlapping entries, parser-differential smuggling and Zip64 spoofing are refused, not guessed at; every parser loop runs under a named, CWE-tagged, caller-configurable bound.
- **Random access and streaming** — read one entry from a multi-gigabyte archive without touching the rest; iterate unseekable streams with bounded memory.
- **Deterministic** — a written determinism contract: reproducible layout always, byte-stable per environment by default, and the same SHA-256 on every runtime under `compression.deterministic: true`.
- **Incremental modification** — replace, remove, add or rename entries without recompressing the untouched 99 % (append-only), or compact for true deletion.
- **A frozen 39-code error vocabulary** and **`verifyZip()`** — one call, a machine-readable report that never throws for archive problems.
- **The first open clause-by-clause ISO/IEC 21320-1:2015 validator**, blocking in CI.
- **What it will NOT do:** no encryption (read or write, in 1.x — ZipCrypto is broken), no other archive formats, no multi-disk archives, no archive repair, no filesystem I/O in the engine, **no network access, ever**.

---

## 🚀 Installation

```bash
# Run directly with npx (recommended for MCP clients)
npx -y zipnative-mcp

# Or install globally
npm install -g zipnative-mcp
zipnative-mcp
```

Requirements: **Node.js ≥ 22**.

---

## ⚙️ Configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zipnative": {
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": {
        "ZIPNATIVE_MCP_OUTPUT_DIR": "/Users/you/Documents/mcp-archives"
      }
    }
  }
}
```

### Cursor / Continue / Zed / Windsurf / Cline / Roo Code

Any MCP-compatible client that supports stdio servers will work. Use the same `command` + `args` + `env` triple. Example for **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "zipnative": {
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "/Users/you/Documents/mcp-archives" }
    }
  }
}
```

**Windsurf / Cline / Roo Code** use the same shape inside their respective MCP config files.

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "zipnative": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "${workspaceFolder}/.mcp-archives" }
    }
  }
}
```

### 🌐 Supported AI Ecosystem & Clients

`zipnative-mcp` is designed for MCP-native environments and works with clients that support MCP over stdio or Streamable HTTP: Claude Desktop, Claude Code, Cursor, Continue, Zed, Windsurf, Cline, Roo Code, VS Code, ChatGPT (Streamable HTTP), the MCP Inspector, and any client built on the MCP TypeScript / Python SDKs. Because the server never opens a socket of its own, it is also safe to run inside air-gapped or egress-restricted hosts.

### 🔌 MCP protocol compliance

The server is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) and speaks **MCP 2026-07-28**:

- **Stateless serving** — `server/discover` replaces the session handshake; every result carries `resultType` and the `_meta` `serverInfo` envelope. Over HTTP, 2026-07-28 clients send `Mcp-Method` / `Mcp-Name` headers with each `POST /mcp`.
- **Cache hints** — `tools/list` and `prompts/list` are `public` with a 24 h `ttlMs`, `server/discover` is `public` for 1 h, and `resources/list` / `resources/templates/list` / `resources/read` are `private` with `ttlMs: 0` (sandbox files are per-host user data).
- **Protocol errors** — `tools/call` with an unknown tool name is a JSON-RPC error (`-32602`, `[UNKNOWN_TOOL] Unknown tool: …`) rather than an `isError` result, and an unknown resource URI is `-32602` (Invalid params), as the specification requires; `isError: true` is reserved for execution failures.
- **Automatic legacy fallback** — a client that opens with `initialize` is served through the SDK's legacy path on both stdio and HTTP for every revision the SDK negotiates: **2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25** (legacy) next to **2026-07-28** (modern). Nothing changes for existing hosts. `tests/protocol-revisions.test.ts` proves each legacy revision negotiates exactly that revision and serves the 13 tools; `tests/stdio-modern.test.ts` and `tests/http-modern.test.ts` prove the 2026-07-28 path on stdio and HTTP.
- **HTTP** — `POST /mcp` only; `GET` / `DELETE /mcp` answer **405** (no SSE resumability; the server is stateless). Bound to `127.0.0.1` with a `Host` / `Origin` guard (foreign values → 403; the `Origin` port must equal the server port); `ZIPNATIVE_MCP_HTTP_TOKEN` adds an opt-in bearer-token gate (`401` + `WWW-Authenticate` without it); bodies above 256 MiB → 413.
- **stdio** — the SDK's 10 MiB default frame cap is raised to **256 MiB** so multi-MiB base64 archives fit in one `tools/call`; as in every SDK release, a request sent before `initialize` is dropped without a reply on the legacy path.
- **Output schemas** — every `structuredContent` validates against the tool's `outputSchema` (a 2026-07-28 MUST), including `verbosity: 'summary'` and `fields` projections: the read tools declare projectable schemas (all properties optional, `additionalProperties: false` kept). Input schemas carry no `$schema` keyword and no `$ref` by policy (some hosts forward `inputSchema` to function-calling APIs that reject unknown keywords). `serverInfo` carries `websiteUrl`; the resource template is `zipnative://output/{+path}`.

The `tools/call` payload (`content`, `structuredContent`, `isError`) is identical between the 2026-07-28 path and the legacy path; `tests/http-modern.test.ts` asserts it, and `tests/schema-conformance.test.ts` validates `structuredContent` with the SDK's JSON Schema 2020-12 validator.

| Client                                                   | Transport        | Protocol negotiated                                 |
| -------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| Claude Desktop, Cursor, Continue, Zed, Windsurf, Cline   | stdio            | legacy `initialize` (2024-xx / 2025-xx) — unchanged |
| ChatGPT and other Streamable HTTP hosts                  | HTTP `POST /mcp` | legacy stateless streamable HTTP — unchanged        |
| MCP 2026-07-28 clients (SDK v2 `Client`, current MCP Inspector) | stdio / HTTP | `server/discover`, cache hints, `_meta` envelope |

Compatibility matrix — every negotiated revision, on both transports, with the test that proves it:

| Revision | Era | stdio | HTTP `POST /mcp` | Proven by |
| -------- | --- | :---: | :--------------: | --------- |
| 2024-10-07 | legacy `initialize` | ✓ | ✓ | `tests/protocol-revisions.test.ts` |
| 2024-11-05 | legacy `initialize` | ✓ | ✓ | `tests/protocol-revisions.test.ts` |
| 2025-03-26 | legacy `initialize` (JSON-RPC batches accepted over HTTP, refused on stdio) | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts` |
| 2025-06-18 | legacy `initialize` | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts`, `tests/http-transport.test.ts` |
| 2025-11-25 | legacy `initialize` | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts`, `tests/autonomy.test.ts` |
| 2026-07-28 | modern (`server/discover`, `_meta` envelope, cache hints) | ✓ | ✓ (+ bearer token) | `tests/stdio-modern.test.ts`, `tests/http-modern.test.ts`, `tests/autonomy.test.ts` |

**Autonomy proof.** `tests/autonomy.test.ts` replays one scripted agent scenario (S0 handshake → S1 `tools/list` → S2 `describe_engine` → S3 `create_zip` file / base64 / parallel → S4 `verify_zip` → S5 `inspect_zip` checks → S6 `list_zip_entries` → S7 `read_zip_entry` / `inflate_raw` / `compute_crc32` → S8 `modify_zip` append then compact → S9 `extract_zip` dry run then files → S10 `resources/*` → S11 `scan_zip_forward` → S12 hostile refusals → S13 ceilings → S14 protocol errors → S15 `draft_governance_issue` → S16 `prompts/get` → S17 clean shutdown) against the built `dist/cli.js` on four transports — stdio legacy, stdio modern, HTTP legacy, HTTP modern with `ZIPNATIVE_MCP_HTTP_TOKEN` — under a sandbox, a cache directory, `ZIPNATIVE_MCP_MAX_ENTRIES=5000` and `ZIPNATIVE_MCP_WORKERS=2`, asserting no interaction, no unexpected `isError`, a code and a remedy on every refusal, a cache hit over the wire, a JSON-only stdout and a clean exit. To replay it by hand from Claude Code, Claude Desktop or the MCP Inspector, see [`docs/guides/LOCAL_TESTING.md`](docs/guides/LOCAL_TESTING.md) § "Drive it from Claude Code / Claude Desktop / MCP Inspector" (the repository ships a ready `.mcp.json`).

### Environment variables

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `ZIPNATIVE_MCP_OUTPUT_DIR` | *(unset)* | Absolute path of the **one** sandbox directory: `zipPath` / `sourcePath` inputs are read from it, `outputMode: 'file'` / `outputDir` outputs are written under it (exclusive create — never overwritten). The **real** path of every file read and of every parent written must stay inside it: a symlink or junction planted in the sandbox is `SECURITY_VIOLATION` on `zipPath` / `sourcePath` / `resources/read` as much as on writes. Unset ⇒ every path input and file output is refused and the tools work on base64 only. |
| `ZIPNATIVE_MCP_CACHE_DIR` | *(unset)* | Opt-in persistent SHA-256-keyed result cache (1 h TTL, 256 MiB LRU, plaintext at rest; key namespaced by tool API + package + engine version). Never caches `zipPath` / `sourcePath` inputs, file output, `defaultDate: 'now'`, `parallel`, `describe_engine` or `draft_governance_issue`; a hit carries `_meta.cached: true`. |
| `ZIPNATIVE_MCP_PORT` | *(unset → stdio)* | When set to a valid port (1–65535), serves Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead of stdio. Loopback only, DNS-rebinding protection (foreign `Host` / `Origin` → **403**), `GET` / `DELETE` → 405. **No authentication unless `ZIPNATIVE_MCP_HTTP_TOKEN` is set** — other local processes can reach the endpoint. |
| `ZIPNATIVE_MCP_HTTP_TOKEN` | *(unset)* | *(secret)* Opt-in bearer token for the HTTP transport (≥ 16 characters, no whitespace — a weaker value aborts startup). When set, every `/mcp` request must carry `Authorization: Bearer <token>`; otherwise **401** + `WWW-Authenticate: Bearer realm="zipnative-mcp"` (with `error="invalid_token"` only when credentials were sent — RFC 6750 §3.1). Compared constant-time, never logged. |
| `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` | `8589934592` (8 GiB) | Operator ceiling for `limits.maxEntryUncompressedSize` and `limits.maxTotalUncompressedSize`. Integer ≥ 1024, read once at startup — an invalid value refuses to start. A per-call value above it is `LIMIT_CEILING_EXCEEDED`; a ceiling below the engine default tightens the default silently. |
| `ZIPNATIVE_MCP_MAX_ENTRIES` | `100000` | Operator ceiling for `limits.maxEntries` and `scan_zip_forward` `maxEntries` (whose default of 10 000 is clamped to the ceiling; only an explicit value above it is `LIMIT_CEILING_EXCEEDED`). Integer ≥ 1, read once at startup. |
| `ZIPNATIVE_MCP_WORKERS` | `8` | Operator ceiling for `create_zip` `parallel.workers`; with no explicit `workers` the engine default `max(1, min(cores − 1, 8))` applies, bounded by this ceiling; `0` disables worker threads (compression stays on the calling thread). Integer ≥ 0, read once at startup. |

---

## 🛠 Tool reference

Every archive-consuming tool takes exactly one of `zipBase64` (the raw archive as base64 exactly once; a `data:…;base64,` prefix is tolerated; decoded ≤ 128 MiB) or `zipPath` (a relative path inside the sandbox; container extensions only — `.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix .nupkg .whl .apk .ipa .xpi .crx .kmz`; ≤ 1 GiB buffered). Every engine-touching tool takes `limits` (the eight named `ZipLimits` bounds — `maxEntries`, `maxEntryUncompressedSize`, `maxTotalUncompressedSize`, `maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`, `maxCommentBytes`, `maxCentralDirectoryBytes`; values above the operator ceilings → `LIMIT_CEILING_EXCEEDED`) and `strict` (escalate the first diagnostic to `ZIP_STRICT_DIAGNOSTIC`). The read tools take `verbosity` (`'full'` | `'summary'`) and `fields` (≤ 16 dot paths). Every result carries `diagnostics[]` + `diagnosticCounts` (+ `diagnosticsTruncated` past 200). Error results: `content[0].text = "<tool> failed [CODE]: message"`, `isError: true`, `_meta.error = { code, message, data? }`. Full input/output schemas are advertised by `tools/list`; the complete error table is in [`AGENTS.md`](AGENTS.md#6-error-reference).

### `inspect_zip`

Read-only archive report in ONE call, the `zipnative inspect --json` shape: size, entry / file / directory counts, Zip64, comment (+ `commentHex`), compressed vs uncompressed totals and ratio, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, earliest / latest date, `prependedData` / `multipleEocd`, a `determinism` verdict (`epochTimestamps`, `canonicalOrder`, `utf8Flags`, `noDataDescriptors`, `canonicalLayout`, `deterministic` — reproducible = epoch timestamps + canonical order + UTF-8 flags; a streamed archive is reproducible but not canonical; a pinned non-epoch date is reproducible but reports `deterministic: false` here — this is the structural verdict, distinct from `create_zip.summary.deterministic`) and every diagnostic. It opens the archive **eagerly** by default: every entry's real extent is checked up front — overlapping entries, entries reaching into the central directory or past EOF, and Zip64 spoofing are refused with their `ZIP_*` code rather than summarised. A method / CRC / size divergence between the central directory and a local header is **not** an extent problem: `verify_zip` (`localHeaderMatch`) is the one-call gate for it, and `read_zip_entry` / `extract_zip` raise `ZIP_CD_LFH_MISMATCH` / `ZIP_SIZE_MISMATCH` when the entry is read. `check` / `assert` turn it into a CI gate.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `validate` | `'eager'` \| `'lazy'` | `'eager'` | `lazy` defers local-header cross-checks to first read (cheaper on huge archives) |
| `check` | string[] ≤ 15 | — | `deterministic`, `epoch-timestamps`, `canonical-order`, `utf8-names`, `no-data-descriptor`, `canonical-layout`, `no-zip64`, `zip64`, `no-encryption`, `no-symlinks`, `safe-names`, `no-duplicates`, `no-diagnostics`, `store-only`, `deflate-only` |
| `assert` | object | — | `maxEntries`, `minEntries`, `maxUncompressedBytes` (integers ≥ 0), `maxRatio` (number ≥ 1, worst per-entry ratio), `has` (≤ 100 exact names), `method` (`'store'` \| `'deflate'`) |
| `strict`, `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: the report above plus `checks[]` (`{ check, ok, detail }`) and `checksPassed` when `check` / `assert` was supplied; `diagnostics[]`. Summary: `archiveBytes`, `entryCount`, `isZip64`, `compressedBytes`, `uncompressedBytes`, `encryptedCount`, `unsafeNameCount`, `duplicateNameCount`, `deterministic`, `canonicalLayout`, `diagnosticCount`, `checksPassed`.

```jsonc
{
  "zipBase64": "<base64 ZIP>",
  "check": ["deterministic", "no-encryption", "safe-names", "no-symlinks"],
  "assert": { "maxEntries": 5000, "maxRatio": 100, "has": ["manifest.json"] },
  "verbosity": "summary",
  "fields": ["checksPassed", "checks"]
}
```

Errors: `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `SECURITY_VIOLATION`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `ZIP_STRICT_DIAGNOSTIC`, and the structural `ZIP_*` refusals (`ZIP_EOCD_NOT_FOUND`, `ZIP_EOCD_INCONSISTENT`, `ZIP_CD_INCONSISTENT`, `ZIP_RECORD_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_ZIP64_LOCATOR_MISSING`, `ZIP_ZIP64_EOCD_MISPLACED`, `ZIP_ZIP64_CONTRADICTION`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_VALUE_UNREPRESENTABLE`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_LIMIT_EXCEEDED`).

### `list_zip_entries`

Read-only central-directory inventory without decompressing anything: every entry (duplicates included) in directory order as a full row — `index`, `name`, `nameEncoding`, `isDirectory`, `isSymlink`, `method` / `methodName`, `compressedSize`, `uncompressedSize`, `ratio`, `crc32`, `lastModified`, `isEncrypted`, `usesZip64`, `usesDataDescriptor`, `unixMode`, `sanitizedPath` (`null` = the extraction gate would refuse it), `comment`, decoded `flags`, `versionMadeBy` / `versionNeeded`, `hostSystem`, attributes, `localHeaderOffset`, DOS date / time, named `extraFields`, `rawNameHex`, `commentHex`. Paged so a 100 000-entry archive stays token-bounded.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `offset` | integer ≥ 0 | `0` | skip this many matching entries |
| `limit` | integer 1–2000 | `200` | `hasMore` tells you to page |
| `filter` | object | — | `names` (≤ 1000 exact), `prefix`, `glob` (≤ 32; `*` in a segment, `**` across, `?` one char; no `/` = any depth; trailing `/` = subtree), `includeDirectories` (directories are listed when no filter is given) |
| `includeExtraData` | boolean | `false` | extra-field payloads as base64 (forensics) |
| `validate` | `'lazy'` \| `'eager'` | `'lazy'` | |
| `strict`, `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: `entryCount`, `matchedCount`, `offset`, `limit`, `returnedCount`, `hasMore`, `isZip64`, `entries[]`, `diagnostics[]`. Summary: the counts plus `names` (this page).

```jsonc
{ "zipBase64": "<base64 ZIP>", "filter": { "prefix": "src/", "glob": ["**/*.json"] }, "limit": 50, "fields": ["entries.name", "entries.uncompressedSize", "hasMore"] }
```

Errors: as `inspect_zip` (structural refusals appear on `validate: 'eager'` or when the central directory itself is broken).

### `read_zip_entry`

Read ONE entry without extracting the archive, by `name` (exact, case-sensitive; the last duplicate wins) or `index` (central-directory position — disambiguates duplicates). `mode: 'data'` (default) returns the decompressed content, CRC-verified, as `dataBase64` or as `text` with `encoding: 'utf8'`; a `range` reads a byte window through the chunked stream (bounded memory, no CRC for a window). `mode: 'raw'` returns the compressed payload verbatim (zero-copy — feed it to `inflate_raw`). `mode: 'verify'` returns `verification: { ok, crcMatch, sizeMatch, localHeaderMatch }` only. Encrypted entries are refused (`ZIP_UNSUPPORTED_ENCRYPTION` — no decryption in this engine).

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `name` / `index` | string / integer ≥ 0 | — | exactly one |
| `mode` | `'data'` \| `'raw'` \| `'verify'` | `'data'` | |
| `encoding` | `'base64'` \| `'utf8'` | `'base64'` | mode `data` only; invalid UTF-8 → `ENTRY_NOT_UTF8` |
| `verifyCrc` | boolean | `true` | mode `data` without `range` |
| `range` | `{ offset ≥ 0, length 1–16777216 }` | — | mode `data` only |
| `strict`, `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: `entry` (the full row), `mode`, `sizeBytes`, `crcVerified`, `encoding`, `dataBase64` / `text` + `textLength`, `range: { offset, length, returned }`, `verification`, `diagnostics[]`. Inline cap 16 MiB per entry (`ENTRY_TOO_LARGE`, `data.remedy: 'range'`): in `mode: 'data'` read a `range` window or use `extract_zip` file mode; a **raw** payload above the cap is not retrievable inline at all — the same remedies yield the *decompressed* content. An out-of-range `index` is `ZIP_ENTRY_NOT_FOUND` naming the valid range (`data.remedy: 'list_zip_entries'`).

```jsonc
{ "zipBase64": "<base64 ZIP>", "name": "META-INF/MANIFEST.MF", "encoding": "utf8" }
```

Errors: `ZIP_ENTRY_NOT_FOUND`, `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DECOMPRESSION_FAILED`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ENTRY_OVERLAP`, plus the structural refusals and wrapper codes above.

### `verify_zip`

Deep verification in one call — zipnative's `verifyZip` report verbatim: eager structural validation, then every entry's CRC-32 / size / local-header agreement. `ok` is true when the structure is valid AND every verifiable entry passed. This tool **never fails for a problem with the archive**: a structural refusal lands in `error: { code: 'ZIP_*', message }`; an unverifiable entry is `skipped` (`'encrypted'` | `'stream-only-codec'`) and does not fail the archive, while an entry whose method has no codec here (anything but 0 store / 8 deflate) is reported **failed** (`ok: false`), not skipped — the engine's verdict verbatim. Only caller mistakes (bad limits, bad input) are `isError`. Verify before you trust: run it on any archive from an untrusted source before `extract_zip`.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `entries` | `'all'` \| `'failed'` \| `'skipped'` \| `'none'` | `'all'` | which per-entry rows to return |
| `maxEntries` | integer 1–100000 | `1000` | cap on returned rows (`entriesTruncated`); counts always cover every entry |
| `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: `ok`, `error` (or `null`), `entryCount`, `verifiedCount`, `failedCount`, `skippedCount`, `entries[]` (`{ name, ok, crcMatch, sizeMatch, localHeaderMatch, skipped? }`), `entriesTruncated`, `diagnostics[]`.

```jsonc
{ "zipBase64": "<base64 ZIP>", "entries": "failed", "verbosity": "summary" }
```

Errors (caller mistakes only): `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `SECURITY_VIOLATION`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `ZIP_LIMIT_INVALID`.

### `extract_zip`

Extract with every engine guard ON unless you name the relaxation: zip-slip / absolute / drive / UNC / NUL / ADS / Windows-device names → `ZIP_PATH_TRAVERSAL` (`rejectTraversal: false` SKIPS them, listed in `skipped`; an unsafe path is never emitted); symlinks → `ZIP_SYMLINK_REJECTED` (`rejectSymlinks: false` extracts the target text as data, never a link); duplicate sanitized paths → `ZIP_EXTRACT_DUPLICATE_PATH` (`onDuplicate`); declared sizes / ratios beyond `limits` → `ZIP_LIMIT_EXCEEDED`; overlapping entries and central/local divergence are always refused. The archive is opened **eagerly** before any plan in both modes, so the dry run runs the same open-time guards as the extraction: overlapping entries, entries reaching into the central directory or past EOF and Zip64 spoofing are refused with their `ZIP_*` code before a single plan row is returned (and a file-mode extraction fails before its first write, `data.writtenCount: 0`); a central/local divergence of method, CRC or sizes is detected when the entry is read — `verify_zip` (`localHeaderMatch`) is the one-call gate for it. In base64 mode the plan (filter, sanitize, symlink policy, duplicates, budgets) is then computed without touching any payload — `includeData: false` returns that plan as a dry run. In file mode every file is streamed under `outputDir` inside the sandbox: only the engine's sanitized path is joined, the parent's real path is checked, files are opened exclusively, and a symlink accepted through `rejectSymlinks: false` is written as a regular file holding the link target.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `outputMode` | `'base64'` \| `'file'` | `'base64'` | inline ≤ 16 MiB per file, ≤ 32 MiB total; file mode ≤ 4 GiB |
| `outputDir` | string | — | file mode: relative directory inside the sandbox (created; never overwrites) |
| `includeData` | boolean | `true` | base64 mode: `false` = dry run (paths, sizes, nothing decompressed; hostile extents refused first) |
| `filter` | object | — | as `list_zip_entries` (directories excluded unless `includeDirectories`) |
| `rejectTraversal` | boolean | `true` | `false` skips unsafe names into `skipped` |
| `rejectSymlinks` | boolean | `true` | `false` writes the target text as data |
| `onDuplicate` | `'error'` \| `'first'` \| `'last'` | `'error'` | two entries → one sanitized path |
| `emptyDirectories` | boolean | `false` | file mode: create explicit directory entries that hold no file |
| `strict`, `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: `mode`, `dryRun`, `fileCount`, `totalBytes`, `entries[]` (`{ path, entryName, index, sizeBytes, crc32, method, dataBase64? | filePath? }`), `skipped[]` (`{ entryName, reason: 'unsafe-path' }`), `outputDir`, `directoriesCreated`, `diagnostics[]`; file mode adds up to 50 `resource_link` content blocks. Summary: `mode`, `dryRun`, `fileCount`, `totalBytes`, `skippedCount`, `paths`.

```jsonc
{ "zipBase64": "<base64 ZIP>", "outputMode": "file", "outputDir": "unpacked/report", "filter": { "glob": ["docs/", "*.json"] } }
```

Errors: `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH`, `ZIP_LIMIT_EXCEEDED`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DECOMPRESSION_FAILED`, `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `MISSING_OUTPUT_PATH`, `SECURITY_VIOLATION`, plus the structural refusals and wrapper codes.

### `scan_zip_forward`

Walk LOCAL headers in stream order with bounded memory (zipnative's central-directory-less reader `iterateZipEntries`). The only tool that works on a truncated archive or a stream cut mid-way — the stream must **start at a local header**: it cannot skip an SFX / prepended prefix and refuses one with `ZIP_SIGNATURE_MISMATCH` (route prefixed archives to `inspect_zip`, which reports `prependedData` / `ZIP_PREPENDED_DATA` and shifts offsets; `modify_zip mode: 'compact'` drops the prefix) — and the only one whose result is **NOT authoritative**: forward iteration trusts local headers ALONE, so a hostile archive can present different content here than `inspect_zip` / `list_zip_entries` report (the upload-scanner differential). Prefer those tools whenever the whole archive is available; use this one for forensics. Names are NOT sanitized — `sanitizedPath` shows what the extraction gate would use. A `zipPath` is streamed from disk without the 1 GiB buffered cap. The wrapper never reads a PK signature: `stoppedAt` is derived from byte accounting (the engine leaves the rest of the stream unread when it meets a central directory).

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `data` | `'none'` \| `'verify'` \| `'include'` | `'none'` | `none` skips payloads (a data-descriptor entry still costs a decompress-and-discard); `verify` checks CRCs; `include` returns content (inline caps) |
| `filter` | object | — | as `list_zip_entries` (directories included when no filter is given) |
| `maxEntries` | integer ≥ 1 | `10000` | the default is clamped to the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling; an explicit value above it is `LIMIT_CEILING_EXCEEDED` (`data.remedy: 'maxEntries ≤ N'`) |
| `tolerateTruncation` | boolean | `false` | `true`: a truncated / corrupt stream ends the scan with `stoppedAt: 'error'` + `error` instead of failing |
| `strict`, `limits`, `verbosity`, `fields` | | | shared fragments |

Outputs: `trust: 'local-headers-only'`, `entryCount`, `keptCount`, `entries[]` (rows with `kept` and `data: { verified, bytesProduced, dataBase64? }`; `isSymlink` / `usesZip64` / `unixMode` are `null`), `stoppedAt` (`'central-directory'` — the reader met a central directory and left the rest unread | `'eof'` — the whole stream was consumed without one: truncated or CD-less | `'max-entries'` — more local headers remained past the budget (an archive with exactly `maxEntries` entries ends at `'central-directory'`) | `'error'`), `truncated`, `inputBytes`, `bytesDelivered`, `maxEntries` (the budget in force after clamping), `error`, `diagnostics[]`.

```jsonc
{ "zipBase64": "<base64 of a truncated download>", "tolerateTruncation": true, "verbosity": "summary" }
```

Errors: `ZIP_STREAM_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_RECORD_TRUNCATED`, `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DECOMPRESSION_FAILED`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_LIMIT_EXCEEDED`, `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE`, `LIMIT_CEILING_EXCEEDED` (all engine codes land in `error` under `tolerateTruncation: true`).

### `sanitize_entry_paths`

Apply zipnative's single traversal gate `sanitizeEntryPath()` to a list of names: the safe `/`-separated relative form each maps to (join it under your extraction root — never the raw name), or `null` with the rule that fired. Use it when you extract with another tool or plan an external filesystem sink. No archive needed.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `names` | string[] 1–10000 | — | each ≤ 4096 chars, as stored in an archive |
| `verbosity`, `fields` | | | projection |

Outputs: `count`, `rejectedCount`, `results[]` (`{ name, sanitized, rejected, reason? }` with `reason` ∈ `empty`, `nul`, `absolute`, `drive`, `unc`, `traversal`, `ads`, `device-name`, `no-segments`). Summary: `count`, `rejectedCount`, `rejectedNames`.

```jsonc
{ "names": ["docs/readme.md", "../../etc/passwd", "C:\\Windows\\win.ini", "aux.txt", "a/./b//c.txt"] }
```

Errors: `VALIDATION_ERROR`.

### `create_zip`

Write a ZIP from inline entries (`dataBase64` | `text` | `sourcePath` in the sandbox, or `directory: true`). Reproducible **on one runtime** by default: canonical order (raw UTF-8 name bytes), DOS-epoch timestamps, UTF-8 names, constant attributes — `defaultDate: 'now'` opts out (`ZIP_TIMESTAMP_NOT_PINNED` diagnostic). `compression.deterministic: true` pins the pure-TS encoder so the bytes are identical on every runtime (`summary.deflateTier: 'pure-pinned'`); the default `node-zlib` tier is byte-stable per environment only. Three determinism verdicts, read them where they apply: `summary.deterministic` is `true` **only** with `compression.deterministic: true` on every entry and no wall-clock date (cross-runtime identity — a default call reports `false` although its bytes are reproducible on the same runtime); `summary.sha256` (`includeSha256`, base64 **and** file mode) is the proof; `inspect_zip.determinism.deterministic` is the structural verdict against the canonical defaults (epoch timestamps + canonical order + UTF-8 flags — a pinned non-epoch date reproduces but reports `false` there). `order: 'insertion'` keeps call order for EPUB / JAR (mimetype first, stored). `stream: true` on a `sourcePath` feeds the file through `addStream` (data-descriptor layout, bounded memory, > 4 GiB refused). `parallel` compresses with the worker pool — byte-identical output; with no `workers` the engine default `max(1, min(cores − 1, 8))` applies, bounded by `ZIPNATIVE_MCP_WORKERS`. Zip64 is emitted exactly when a field overflows — reachable here: up to 100 000 entries per call (the engine default `maxEntries` and the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling remain the effective bound), so a 65 536-entry archive auto-promotes. A name ending in `/` denotes a directory and cannot carry a payload (`VALIDATION_ERROR` — drop the slash or pass `directory: true`). Every archive it writes is ISO/IEC 21320-1 conformant (CI-validated).

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `entries` | array 0–100000 | — | required; each: `name` (1–4096, `/`-separated; a trailing `/` means a directory and refuses a payload), exactly one of `dataBase64` / `text` / `sourcePath` or `directory: true`; per entry `compression`, `date` (ISO-8601 instant, `pattern` `^\d{4}-\d{2}-\d{2}`, 1980–2107), `comment` (≤ 65535), `unixMode` (`pattern` `^(?:0o)?[0-7]{3,4}$` — 3–4 octal digits such as `'0644'`, `'755'`, `'0o755'`, no surrounding whitespace) xor `externalAttributes` (uint32), `extraFields` (≤ 16 `{ id 0–65535 except 1, dataBase64 }`), `stream` (with `sourcePath`) |
| `order` | `'canonical'` \| `'insertion'` | `'canonical'` | |
| `defaultDate` | string | DOS epoch | ISO-8601 instant or `'now'` (`pattern` `^(?:now\|\d{4}-\d{2}-\d{2})`) |
| `compression` | object | deflate 6 | `method` (`'store'` \| `'deflate'`), `level` 0–9, `deterministic` |
| `comment` | string ≤ 65535 | — | archive comment |
| `chunkSize` | integer 1024–16777216 | 64 KiB | file mode streaming chunk; never changes the bytes |
| `parallel` | object | — | `workers` 0–64 (≤ `ZIPNATIVE_MCP_WORKERS`; omitted = the engine default `max(1, min(cores − 1, 8))` bounded by the ceiling), `minWorkerJobSize` ≥ 1, `jobTimeout` 1000–600000 ms |
| `includeSha256` | boolean | `false` | `summary.sha256` in base64 and file mode (hashed while streaming — determinism proofs) |
| `outputMode` / `outputPath` | | `'base64'` | file mode: relative path ending in a container extension |
| `strict`, `limits` | | | shared fragments |

Outputs: the archive as an embedded `resource` (≤ 50 MiB) or a `resource_link`; `structuredContent`: `mode`, `sizeBytes`, `filePath`, `summary` (typed in the tool's `outputSchema`: `entryCount`, `fileCount`, `directoryCount`, `streamedCount`, `uncompressedBytes`, `order`, `deterministic`, `deflateTier`, `parallel: { requested, workers }`, `sha256`), `diagnostics[]`.

```jsonc
{
  "entries": [
    { "name": "mimetype", "text": "application/epub+zip", "compression": { "method": "store" } },
    { "name": "META-INF/container.xml", "text": "<container/>" },
    { "name": "OEBPS/", "directory": true }
  ],
  "order": "insertion",
  "compression": { "deterministic": true },
  "includeSha256": true,
  "outputMode": "file",
  "outputPath": "books/sample.epub"
}
```

Errors: `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `SECURITY_VIOLATION`, `LIMIT_CEILING_EXCEEDED`, `ZIP_INVALID_ENTRY_NAME`, `ZIP_INVALID_OPTION`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_ZIP64_STREAMING`, `ZIP_INPUT_TOO_LARGE`, `ZIP_STRICT_DIAGNOSTIC`, `ZIP_API_MISUSE`.

### `modify_zip`

Edit an existing archive without recompressing anything: `operations` add / replace / remove / rename / setComment applied in order. `mode: 'append'` (default) = `save()`: the original bytes stay verbatim and edits are appended — fast and byte-preserving, BUT removed or replaced payloads **remain in the file** (data remanence: recoverable by anyone; a `ZIP_DEAD_BYTES_RATIO` diagnostic fires past 50 % dead bytes, and 7-Zip is known to read the stale payload). `mode: 'compact'` = `saveCompact()`: canonical rewrite, still no recompression, removed data truly gone, SFX prefix dropped. No edits and an unchanged comment return the same bytes (`summary.noOp`). Archives with duplicate entry names are refused.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `zipBase64` / `zipPath` | string | — | exactly one |
| `operations` | array 1–1000 | — | `{ op: 'add' \| 'replace', name, dataBase64 \| text \| sourcePath, compression?, date?, comment?, unixMode? \| externalAttributes?, extraFields?, directory? (add only) }`, `{ op: 'remove', name }`, `{ op: 'rename', from, to }`, `{ op: 'setComment', comment }` — the payload rules and `pattern`s are those of `create_zip` (a `/`-terminated name with a payload is `VALIDATION_ERROR`) |
| `mode` | `'append'` \| `'compact'` | `'append'` | |
| `compression` | object | engine default | for new payloads (same shape as `create_zip`: `method`, `level`, `deterministic`) |
| `defaultDate` | string | DOS epoch | for new payloads; ISO-8601 instant or `'now'` (`pattern` `^(?:now\|\d{4}-\d{2}-\d{2})`; `'now'` → `ZIP_TIMESTAMP_NOT_PINNED`) |
| `includeSha256` | boolean | `false` | |
| `outputMode` / `outputPath` | | `'base64'` | |
| `strict`, `limits` | | | shared fragments |

Outputs: the archive as an embedded `resource` or a `resource_link`; `summary` (`saveMode`, `operationsApplied`, `entryCountBefore`, `entryCountAfter`, `inputBytes`, `outputBytes`, `grewByBytes`, `noOp`, `sha256`), `diagnostics[]`.

```jsonc
{ "zipBase64": "<base64 ZIP>", "operations": [{ "op": "remove", "name": ".env" }, { "op": "rename", "from": "config.json", "to": "config/app.json" }], "mode": "compact" }
```

Errors: `ZIP_ENTRY_NOT_FOUND`, `ZIP_ENTRY_EXISTS`, `ZIP_DUPLICATE_ENTRY_NAME`, `ZIP_INVALID_ENTRY_NAME`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_LIMIT_EXCEEDED`, `ZIP_STRICT_DIAGNOSTIC`, plus the structural refusals, the output codes and the wrapper codes (`data.operationIndex` / `data.op` name the failing operation).

### `compute_crc32`

The ZIP checksum (IEEE 802.3 CRC-32, the engine's slice-by-8 implementation) of inline bytes / text or a sandbox file (streamed in 1 MiB chunks, ≤ 1 GiB). `seed` continues a running CRC across consecutive chunks; `expect` compares against a known value. Use it to cross-check an entry's `crc32` from `list_zip_entries` against a file on disk.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `dataBase64` / `text` / `sourcePath` | string | — | exactly one |
| `seed` | integer 0–4294967295 | `0` | running CRC to continue from |
| `expect` | string | — | 1–8 hex digits, optional `0x` (`pattern` `^(?:0x)?[0-9a-fA-F]{1,8}$`) |

Outputs: `crc32` (unsigned), `hex` (8 lowercase digits), `byteLength`, `seed`, `matches` (when `expect` was given).

```jsonc
{ "text": "hello world", "expect": "0d4a1185" }
```

Errors: `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `SECURITY_VIOLATION`.

### `inflate_raw`

Decompress a raw DEFLATE (RFC 1951) stream — e.g. the payload from `read_zip_entry mode: 'raw'` — with a **mandatory** `maxOutput` bound through zipnative's resumable inflater (constant memory, exact `bytesConsumed`, trailing bytes reported as `leftover`; `ZIP_INFLATE_OUTPUT_OVERFLOW` past the bound). `method: 'store'` is a bounded pass-through; a numeric method id selects a registered codec (none beyond 0 / 8 in this server → `ZIP_UNSUPPORTED_METHOD`).

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `dataBase64` / `sourcePath` | string | — | exactly one |
| `maxOutput` | integer ≥ 1 | — | required; inline results further capped at 50 MiB, file results at 4 GiB |
| `method` | string | `'deflate'` | `'deflate'`, `'store'` or a numeric id (`pattern` `^(?:deflate\|store\|[0-9]+)$`) |
| `allowTrailing` | boolean | `false` | accept bytes after the stream silently (always reported as `leftover`) |
| `outputMode` / `outputPath` | | `'base64'` | file mode: `.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw` |

Outputs: the inflated bytes as an embedded `resource` (`application/octet-stream`) or a `resource_link`; `summary` (`method`, `methodName`, `bytesIn`, `bytesOut`, `bytesConsumed`, `leftover`, `finished`, `maxOutput`, `trailingWarning`).

```jsonc
{ "dataBase64": "<raw deflate payload>", "maxOutput": 1048576 }
```

Errors: `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_CODEC_MODE`, `ZIP_API_MISUSE`, `OUTPUT_TOO_LARGE`, and the input / output wrapper codes.

### `describe_engine`

Offline preflight (no archive needed): server / engine / tool-API versions and the protocol string, the deflate tier in use and the pinned deterministic tier, runtime codecs (`node:zlib`, `CompressionStream`, `DecompressionStream`) and worker threads, the codec registry, the engine's default `limits`, the operator ceilings (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`), every server cap, whether the sandbox and the cache are enabled, the 39 frozen `ZIP_*` error codes and 11 diagnostic codes, and the engine exports this server deliberately does not expose (with why). `network` is always `'none'`. Never cached.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `verbosity`, `fields` | | | projection only |

Outputs: `server`, `engine`, `capabilities`, `codecs[]`, `defaultLimits`, `ceilings`, `caps`, `sandbox`, `network`, `errorCodes[]`, `diagnosticCodes[]`, `unexposed[]`.

```jsonc
{ "fields": ["defaultLimits", "ceilings", "caps", "sandbox"] }
```

Errors: `VALIDATION_ERROR`.

### `draft_governance_issue`

Draft a governance-compliant GitHub issue **locally** for a human to review and submit — for `zipnative` (engine behaviour: parsing, writing, limits, codecs) or `zipnative-mcp` (wrapper behaviour: schemas, sandbox, transport). The server never contacts GitHub — it has no network code path at all; it returns the draft Markdown plus a machine-readable compliance report. Present both to the user, then STOP: they review and submit under their own identity.

| Input | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `title` | string 8–160 | — | required |
| `summary` | string ≥ 16 | — | required |
| `issueType` | `'bug'` \| `'feature'` \| `'security'` \| `'docs'` \| `'performance'` | — | required |
| `targetRepo` | string 1–100 | `'zipnative-mcp'` | documentation only |
| `reproduction` | `{ command, result }` | — | required, both non-empty |
| `expectedBehavior` | string ≥ 4 | — | required |
| `actualBehavior` | string | the reproduction result | |
| `affectedPackages` | string[] ≤ 16 | `['zipnative-mcp']` | |
| `duplicateSearchPerformed` | boolean | — | required, MUST be `true` |
| `outputMode` / `outputPath` | `'inline'` \| `'file'` | `'inline'` | file mode also writes a relative `.md` inside `ZIPNATIVE_MCP_OUTPUT_DIR` (copy it to `.github/drafts/` for review — the tool never writes there) |

Outputs: `title`, `issueType`, `targetRepo`, `outputMode`, `filePath`, `sizeBytes`, `draftMarkdown`, `warnings[]`, `compliance` (`zeroDependencyConfirmed`, `reproductionCommand`, `reproductionResult`, `duplicateSearchPerformed`, `affectedPackages`, `identityReminderShown`, `humanGate`, `environment`).

```jsonc
{
  "title": "scan_zip_forward mis-detects the descriptor of a stored entry",
  "issueType": "bug",
  "targetRepo": "zipnative",
  "summary": "A stored entry followed by a signed data descriptor is reported as truncated by the forward reader.",
  "reproduction": { "command": "scan_zip_forward on an archive written with compression.method 'store' and stream: true", "result": "ZIP_STREAM_TRUNCATED" },
  "expectedBehavior": "The entry is read and its CRC verified.",
  "affectedPackages": ["zipnative", "zipnative-mcp"],
  "duplicateSearchPerformed": true
}
```

A draft that proposes a runtime dependency, omits a reproduction, or sets `duplicateSearchPerformed: false` is rejected with `GOVERNANCE_VIOLATION`. Other errors: `VALIDATION_ERROR`, `MISSING_OUTPUT_PATH`, `INVALID_EXTENSION`, `OUTPUT_EXISTS`, `SECURITY_VIOLATION`. See the `governance_contract` and `draft_issue_workflow` prompts for the full human-in-the-loop contract.

---

## 🔐 Security model

`zipnative-mcp` runs **inside the host process** and exposes a stdio MCP server (or a loopback-only HTTP endpoint). It treats every archive as untrusted input and performs no I/O outside the configured sandbox other than the opt-in response cache under `ZIPNATIVE_MCP_CACHE_DIR`.

| Threat | Defence | CWE |
| ------ | ------- | --- |
| Zip-slip path traversal (`../`, absolute paths, drive letters, UNC, backslashes, NUL, NTFS ADS) and Windows reserved device names (`CON`, `NUL`, `AUX`, `COM1`…`LPT9`) | `rejectTraversal: true` by default → `ZIP_PATH_TRAVERSAL`; `false` skips, never emits; `sanitize_entry_paths` exposes the same gate for external sinks; the writer refuses such names too | CWE-22 / CWE-67 |
| Decompression bombs (declared size, total, ratio, entry floods) | the eight `ZipLimits` bounds enforced **while inflating**, not after → `ZIP_LIMIT_EXCEEDED`; per-call `limits` can never exceed the operator ceilings; `inflate_raw` has a mandatory `maxOutput` | CWE-400 / CWE-409 |
| Symlink entries redirecting extraction | `rejectSymlinks: true` by default → `ZIP_SYMLINK_REJECTED`; `false` writes the target **text** as a regular file — a link is never materialised | CWE-59 |
| Overlapping entries (one payload claimed by many entries) | always-on overlap detection → `ZIP_ENTRY_OVERLAP`, no opt-out | CWE-405 |
| Parser-differential smuggling (central directory vs local headers) | the central directory is authoritative; method / size / CRC divergence → `ZIP_CD_LFH_MISMATCH` (no opt-out), name divergence → `ZIP_NAME_MISMATCH` diagnostic; `scan_zip_forward` says `trust: 'local-headers-only'` | CWE-436 |
| Zip64 sentinel spoofing | Zip64 records cross-checked against every non-sentinel classic field → `ZIP_ZIP64_CONTRADICTION`, no opt-out | CWE-1288 |
| Duplicate entry names (shadowing during extraction) | `onDuplicate: 'error'` by default → `ZIP_EXTRACT_DUPLICATE_PATH`; `'first'` / `'last'` resolve it deliberately | CWE-694 |
| Ambiguous EOCD / trailing garbage, 64-bit fields above 2^53 | refused (`ZIP_EOCD_NOT_FOUND`, `ZIP_VALUE_UNREPRESENTABLE`), never guessed | CWE-190 |

- **The sandbox** (`ZIPNATIVE_MCP_OUTPUT_DIR`) is the one filesystem boundary for reads (`zipPath`, `sourcePath`, `resources/read`) and writes (`outputPath`, `outputDir`, extracted files, governance drafts). Paths must be relative; absolute / UNC paths, `..`, NUL bytes and non-container extensions are rejected; the **real** path of the file read and of the parent written must stay inside (a symlink or junction planted in the sandbox is `SECURITY_VIOLATION` on both sides — the check is on the file itself for reads, so a file symlink cannot slip past a parent-only check); files are opened exclusively (`OUTPUT_EXISTS` — never overwritten); a failed write removes the partial file. Unset ⇒ base64 only (the opt-in response cache under `ZIPNATIVE_MCP_CACHE_DIR` is the only other file I/O).
- **Inputs** are validated against strict JSON Schemas + Zod at the boundary of every tool — unknown or misspelt keys (top-level or nested) are `VALIDATION_ERROR`; base64 is sanity-checked (`data:` prefix tolerated, base64-twice rejected) before any parser runs.
- **Encryption** is never performed: encrypted entries are detected, honestly `skipped` by `verify_zip`, refused by the read paths with `ZIP_UNSUPPORTED_ENCRYPTION`. There is no password input.
- **Every engine diagnostic** goes through a sink — nothing is ever printed to stdout on the stdio transport.
- **HTTP transport** (`ZIPNATIVE_MCP_PORT`) binds loopback only with a Host / Origin guard; it has **no authentication** unless `ZIPNATIVE_MCP_HTTP_TOKEN` is set (then `401` without a valid bearer token).

### Network & egress

**None, ever.** The server has no network code path: no telemetry, no GitHub, no update check, no URL from any tool argument, and — unlike its PDF sibling — no operator-configurable endpoint of any kind. `describe_engine` reports `network: 'none'`. Archive bytes only ever flow back in the JSON-RPC response or into the sandbox. The engine itself never opens a socket, never touches the filesystem and never evals.

| Cap | Value |
| --- | ----- |
| stdio frame / HTTP body | 256 MiB |
| decoded `zipBase64` / inline payloads per call | 128 MiB |
| buffered `zipPath` / `sourcePath` | 1 GiB (`scan_zip_forward` streams a `zipPath` uncapped) |
| inline output (archive, inflated bytes, resource read) | 50 MiB |
| file output | 4 GiB (enforced while streaming) |
| inline entry (`read_zip_entry`, `extract_zip`, `scan_zip_forward`) | 16 MiB |
| inline extraction total | 32 MiB |
| `list_zip_entries` page | 200 default / 2000 max |
| `create_zip` entries / `modify_zip` operations / `sanitize_entry_paths` names | 100000 / 1000 / 10000 |
| `filter.names` / `filter.glob` / `extraFields` per entry / `fields` paths | 1000 / 32 / 16 / 16 |
| `scan_zip_forward` `maxEntries` default / `read_zip_entry` range length / `extract_zip` resource links | 10000 (clamped to the ceiling) / 16 MiB / 50 |
| `resources/list` entries / walk depth / `resources/read` | 1000 / 8 / 50 MiB |
| response cache (`ZIPNATIVE_MCP_CACHE_DIR`) TTL / size | 3600 s / 256 MiB |
| diagnostics per result | 200 (de-duplicated by code + entry) |
| engine defaults (`limits`) | 100000 entries · 1 GiB per entry · 8 GiB total · ratio 1024 · 4096-byte names · 65535-byte extra fields and comments · 256 MiB central directory |

Every row is a constant in `src/caps.ts` and is advertised by `describe_engine.caps` (`stdioMaxFrameBytes`, `maxBase64InputBytes`, `maxPathInputBytes`, `maxBase64OutputBytes`, `maxFileOutputBytes`, `maxEntryInlineBytes`, `maxExtractInlineTotalBytes`, `maxListLimit`, `defaultListLimit`, `maxCreateEntries`, `maxModifyOperations`, `maxSanitizeNames`, `maxDiagnostics`, `maxFilterNames`, `maxFilterGlobs`, `maxExtraFields`, `maxFieldsPaths`, `defaultScanMaxEntries`, `maxResourceLinks`, `maxRangeLength`, `maxListedResources`, `maxResourceWalkDepth`, `maxResourceReadBytes`, `cacheTtlSeconds`, `cacheMaxBytes`).

See [SECURITY.md](SECURITY.md) for the responsible disclosure process.

---

## 🧪 Conformance (veraZIP)

ZIP has no veraPDF — JHOVE never shipped a ZIP module and no ISO/IEC 21320-1 validator existed — so the zipnative ecosystem ships its own gate, **veraZIP**: an ISO/IEC 21320-1:2015 (Document Container File) validator vendored from the engine (`scripts/verazip-core.mjs`) that **raw-parses the bytes with its own EOCD / central-directory / local-header reader and never imports `zipnative`** — a validator that shared the engine's parser would attest the engine with the engine.

`npm run validate:zip` builds the server, drives the **real `tools/call` handler** (`create_zip` and `modify_zip` across every writer path — buffered, `stream: true`, `parallel`, `compression.deterministic`, `order: 'insertion'`, extra fields, comments, Unix modes, append and `compact`) plus raw-crafted archives to write a **38-archive corpus**, then validates every file clause by clause (22 check ids). The conformant set includes four **hostile-but-conformant** archives (zip-slip, a Windows device name, duplicate paths, a symlink entry): the ISO profile constrains the container, not the meaning of names, so they PASS the validator and `extract_zip` **must refuse** them — the gate checks both. **4 raw-crafted negative canaries** must be rejected with a declared clause id. Level 0 (the ISO clauses) needs no external tool and always runs; level 1 re-tests every conformant archive with the foreign integrity tools present on the machine (`unzip -t`, `7z t`, `python -m zipfile -t`, `tar -tf`, `jar tf`) and **skips** the absent ones visibly; `VERAZIP_REQUIRED=1` (set in CI) fails closed. The corpus definition is recorded in [`docs/data/verazip.json`](docs/data/verazip.json) and the manifest of each run in `test-output/zip/manifest.json`.

A PASS proves that every archive this server writes is a well-formed ISO/IEC 21320-1 document container: one self-consistent end-of-central-directory record, a central directory that agrees with every local header, only store / deflate methods, no encryption, no multi-disk fields, valid Zip64 records exactly where a field overflows. It is **not a certification** — validation evidence against a specific validator revision — and **conformant does not mean safe**: the security guards exist on top of conformance.

The gate is **blocking** in [`verazip.yml`](.github/workflows/verazip.yml) on Linux and Windows on every pull request and runs again before every publish. Every archive a test produces through a tool must also pass `assertValidZip` (ISO conformance included). See [`docs/guides/CONFORMANCE.md`](docs/guides/CONFORMANCE.md).

---

## 🧪 Local development

```bash
git clone https://github.com/Nizoka/zipnative-mcp.git
cd zipnative-mcp
npm install
npm run typecheck:all
npm run lint
npm test
npm run test:coverage
npm run build
npm run examples:check    # runs examples/*.json live through the tools/call handler
npm run validate:zip      # BLOCKING: build + corpus + ISO/IEC 21320-1 validation (VERAZIP_REQUIRED=1 fails closed on missing foreign tools)
node scripts/tool-shape.mjs --write   # only after a deliberate tools/list schema change (catalogue parity fixture)
```

Quality gate (all PRs, one line):

```bash
npm run typecheck:all && npm run lint && npm run test && npm run test:coverage && npm run build && npm run validate:zip
```

Smoke-test the server over stdio:

```bash
node dist/cli.js
# In another terminal, send a JSON-RPC initialize request via stdin (e.g. with the MCP Inspector).
npx @modelcontextprotocol/inspector --cli node dist/cli.js --method tools/list
```

Drive the built server from **Claude Code** with the repository's `.mcp.json` (run `npm run build` first; Claude Code asks for approval on first use and injects `${CLAUDE_PROJECT_DIR}`), from **Claude Desktop** with absolute paths, or from the **MCP Inspector** — the scenario to replay and the expected results are in [`docs/guides/LOCAL_TESTING.md`](docs/guides/LOCAL_TESTING.md) § "Drive it from Claude Code / Claude Desktop / MCP Inspector".

Run it over HTTP with a bearer token and a sandbox:

```bash
ZIPNATIVE_MCP_PORT=3000 ZIPNATIVE_MCP_HTTP_TOKEN=change-me-to-a-real-secret ZIPNATIVE_MCP_OUTPUT_DIR=/tmp/zips npx zipnative-mcp
# POST http://127.0.0.1:3000/mcp with Authorization: Bearer …
```

> **Contributors:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the full local-verification workflow — the quality gate, examples-as-tests, `assertValidZip` on every archive a test writes, the veraZIP corpus, and the MCP Inspector.

## 📣 Release process

`zipnative-mcp` follows the same release formalism as `zipnative` and `pdfnative-mcp`:

- One release note file per tag in `release-notes/vX.Y.Z.md` (no emojis)
- `CHANGELOG.md` mirrors each release bullet list
- `package.json`, `server.json`, `src/version.ts` and `CITATION.cff` move in lock-step; `TOOL_API_VERSION` bumps only when a schema or error code changes
- The veraZIP gate runs again before publish
- GitHub Release body is copied from `release-notes/vX.Y.Z.md`
- npm publication is handled by GitHub Actions Trusted Publishing (OIDC), without `NPM_TOKEN`, with provenance and a CycloneDX SBOM

See `release-notes/TEMPLATE.md` for the canonical structure and publication checklist.

---

## 📚 Project structure

```
src/
├── cli.ts                      # entrypoint: stdio (default, 256 MiB frames) or Streamable HTTP (ZIPNATIVE_MCP_PORT); reads the ceilings once
├── http.ts                     # Node http <-> Web Request/Response bridge, 256 MiB body cap, Host/Origin loopback guard
├── auth.ts                     # opt-in HTTP bearer token (ZIPNATIVE_MCP_HTTP_TOKEN)
├── server.ts                   # Server factory, TOOLS registry, dispatchOutput, cache hints, SERVER_INSTRUCTIONS, 7 prompts, resources
├── caps.ts                     # every byte / count cap + the operator ceilings (MAX_UNCOMPRESSED_BYTES, MAX_ENTRIES, WORKERS)
├── limits.ts                   # the eight ZipLimits bounds as an input fragment; LIMIT_CEILING_EXCEEDED
├── sandbox.ts                  # the single filesystem boundary (ZIPNATIVE_MCP_OUTPUT_DIR): container extensions, realpath check, wx writes
├── archive-input.ts            # zipBase64 XOR zipPath; buffered load or streamed ByteSource
├── base64.ts                   # base64 boundary decoding with agent-facing diagnostics
├── zip-errors.ts               # ZipError -> ToolError (the 39 frozen ZIP_* codes verbatim), zlib mapping, guard()
├── diagnostics.ts              # engine diagnostic sink (de-duplicated, capped at 200) -> diagnostics[]
├── entry.ts                    # EntryView: the CLI's --json row shape (flags, unixMode, sanitizedPath, extra fields, rawNameHex)
├── filter.ts                   # names / prefix / glob entry filter (glob matcher vendored from zipnative-cli)
├── entry-spec.ts               # create / modify payloads: compression, dates, unixMode / externalAttributes, extra fields
├── engine.ts                   # initNodeZipCodecs once; runtime capability probe
├── output.ts                   # base64 emitter / sandboxed exclusive file writer (buffered + streamed)
├── resources.ts                # zipnative://output/{+path} over every sandbox file (MIME by extension)
├── projection.ts               # verbosity / fields projection for the read tools
├── cache.ts                    # opt-in SHA-256 response cache (ZIPNATIVE_MCP_CACHE_DIR)
├── governance.ts               # AI-governance / HITL contract text + draft validation
├── errors.ts                   # ToolError, SecurityError, GovernanceError, absolute-path redaction
├── wrapper-codes.ts            # the wrapper's own error codes with meaning and remedy
├── version.ts                  # ZIPNATIVE_MCP_VERSION, TOOL_API_VERSION
├── index.ts                    # public library exports
└── tools/
    ├── _shared.ts              # parseInput, ProjectionShape, EngineOptionsShape, sha256Hex
    ├── inspect-zip.ts
    ├── list-zip-entries.ts
    ├── read-zip-entry.ts
    ├── verify-zip.ts
    ├── extract-zip.ts
    ├── scan-zip-forward.ts
    ├── sanitize-entry-paths.ts
    ├── create-zip.ts
    ├── modify-zip.ts
    ├── compute-crc32.ts
    ├── inflate-raw.ts
    ├── describe-engine.ts
    └── draft-governance-issue.ts
scripts/
├── verazip-core.mjs            # vendored engine-independent ISO/IEC 21320-1 validator (never imports zipnative)
├── verazip-core.d.mts          # its type declarations
├── generate-zip-corpus.mjs     # writes the veraZIP corpus through the real tools + raw-crafted canaries (npm run corpus:zip)
├── validate-zip.mjs            # the gate: level 0 (ISO clauses) + level 1 (foreign integrity tools) (npm run validate:zip)
├── helpers/zip-corpus.mjs      # the corpus definition (every writer path + the hostile-but-conformant quartet + the canaries)
├── helpers/zip-corpus.d.mts    # its type declarations
├── helpers/raw-zip-builder.mjs # engine-independent raw ZIP writer for the crafted canaries (vendored from zipnative)
├── helpers/interop-tools.mjs   # unzip / 7z / python zipfile / tar / jar probes for level 1
├── verify-issue.mjs            # governance draft checker (npm run verify:issue)
└── tool-shape.mjs              # structural tools/list fingerprint (--write refreshes tests/_fixtures/tool-shape.json)
docs/
├── AI_GUIDE.md                 # decision tree + pitfalls for agents
├── API_STABILITY.md            # the tool-API stability charter (versioning, bump rules, per-tool matrix)
├── KNOWLEDGE_BASE.md           # architecture reference + the 77-export coverage ledger (§8)
├── guides/AI_GOVERNANCE.md     # the human-in-the-loop contract, narrated
├── guides/CONFORMANCE.md       # the veraZIP gate explained
├── guides/DETERMINISM.md       # the three determinism levels and how to prove them
├── guides/INCREMENTAL.md       # modify_zip: append vs compact, remanence, the 7-Zip differential
├── guides/LOCAL_TESTING.md     # the quality gate, assertValidZip, veraZIP locally, driving the server from Claude Code / Inspector
├── guides/SECURITY.md          # threat model and defences with CWE ids
└── data/                       # errors.json (39 codes + 11 diagnostics), core-exports.json (77 exports), verazip.json (corpus counts)
examples/                       # executable tool invocations (run by tests/examples.test.ts)
tests/                          # vitest suites, one per tool / module (<tool>.test.ts, <module>.test.ts) plus:
├── _zip-fixtures.ts            # benign archives via the engine + hostile ones via _fixtures/raw-zip-builder.ts (vendored)
├── _zip-assert.ts              # assertValidZip / assertIsoConformant / expectCheck
├── _mcp-harness.ts             # in-memory legacy-handshake client
├── _http-fixture.ts            # loopback HTTP fixture (2026-07-28 envelope + legacy initialize)
├── _agent-client.ts            # the scripted MCP client of the autonomy scenario (stdio / HTTP × legacy / modern)
├── autonomy.test.ts            # S0–S17 agent scenario on stdio legacy / stdio modern / HTTP legacy / HTTP modern + bearer token
├── protocol-revisions.test.ts  # the five legacy revisions (2024-10-07 … 2025-11-25) negotiated on both transports
├── stdio-modern.test.ts        # 2026-07-28 server/discover + _meta envelope over the built CLI
├── http-modern.test.ts         # 2026-07-28 over HTTP: cache hints, Mcp-Method / Mcp-Name, -32602, batches
├── http-shutdown.test.ts       # SIGTERM in HTTP mode exits cleanly and releases the port
├── schema-lockstep.test.ts     # Zod input schemas ↔ advertised JSON Schemas (keys, required, enums, defaults, bounds, patterns)
├── catalogue-parity.test.ts    # tools/list vs tests/_fixtures/tool-shape.json (frozen baseline: tool-shape.v1.0.0.json)
├── docs-consistency.test.ts    # counts / names / codes quoted in the docs, the SFX guard, the 77-export ledger + 62 / 9 / 6 reach counts, the veraZIP corpus counts, the SECURITY cache clause, this tree
├── diagnostics-inventory.test.ts # every one of the 11 diagnostics produced by a tool call
├── zip64.test.ts               # 70 000-entry reads and a 65 536-entry create_zip (auto-promotion)
└── fixtures/interop/           # foreign-tool archives (bsdtar, PowerShell)
.mcp.json                       # drives the built server from Claude Code (stdio, sandbox under test-output/mcp-sandbox)
.github/workflows/ci.yml        # Linux (Node 22 / 24) + Windows quality gate
.github/workflows/verazip.yml   # BLOCKING veraZIP job on Linux and Windows (VERAZIP_REQUIRED=1)
.github/workflows/codeql.yml    # CodeQL static analysis
.github/workflows/scorecard.yml # OpenSSF Scorecard
.github/workflows/publish.yml   # Release-triggered Trusted Publishing (OIDC) with provenance + CycloneDX SBOM
```

---

## 🗺 Roadmap

v1.0.0 is the first release, on zipnative 1.0.0. The full plan — released milestones, in-progress work and long-term direction — lives in [ROADMAP.md](ROADMAP.md).

- **Zip64 streaming** — `create_zip` `stream: true` entries above 4 GiB are refused today (`ZIP_UNSUPPORTED_ZIP64_STREAMING`); the per-entry opt-in lands with the engine's post-1.0 decision record.
- **Encryption** — none in 1.x by engine policy (ZipCrypto is broken); AES (AE-2) may come in a later major behind an injected crypto provider, and only then will a password input exist here.
- **HTTP page streaming** — MCP 2026-07-28 still has no partial `structuredContent`, so large listings stay paged (`offset` / `limit`) rather than streamed.

Have a feature idea? Open an issue or PR.

---

## ⭐ Star the project

If `zipnative-mcp` is useful to you, please ⭐ this repository — and consider also starring the underlying engine [Nizoka/zipnative](https://github.com/Nizoka/zipnative). Stars help others discover the project and motivate continued development.

---

## 🤝 Contributing

Contributions are very welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), check the [open issues](https://github.com/Nizoka/zipnative-mcp/issues), and follow the [code of conduct](CODE_OF_CONDUCT.md).

---

## 📄 License

[MIT](LICENSE) © 2026 Nizoka

`zipnative-mcp` is built on top of [`zipnative`](https://github.com/Nizoka/zipnative) and the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
