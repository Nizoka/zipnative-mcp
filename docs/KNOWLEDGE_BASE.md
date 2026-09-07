# zipnative-mcp — Knowledge Base

> Reference for AI assistants (GitHub Copilot, Claude, Cursor, Continue, Zed, Windsurf, Cline, Roo Code)
> and human contributors. Captures the full context needed to understand, extend, and debug
> zipnative-mcp **v1.0.0** without reading every source file.

> If you are an AI agent calling zipnative-mcp from a chat session, also read
> [`AI_GUIDE.md`](AI_GUIDE.md) — the short, action-oriented decision tree.

---

## 1. Context

**What is zipnative-mcp?**
An MCP (Model Context Protocol) server that bridges the zero-dependency
[`zipnative`](https://github.com/Nizoka/zipnative) ZIP engine (v1.0.x — 77 frozen exports, 39 frozen
error codes, a frozen `deterministic: true` byte contract) to AI clients (Claude Desktop, ChatGPT,
Cursor, Continue, Zed, Windsurf, Cline, Roo Code, …). It exposes **13** tools over a stdio (or
loopback Streamable HTTP) transport so AI agents can **inspect** and **list** archives without
extracting, **read** single entries by random access, **verify** integrity in one call, **extract**
with every security guard on by default, **scan** truncated or unseekable streams forward,
**sanitize** entry paths for their own sinks, **create** deterministic, reproducible archives
(store / deflate, worker-parallel, streamed sources), **modify** archives incrementally without
recompression, compute **CRC-32**, **inflate** raw DEFLATE under a mandatory bound, **describe** the
engine and server capabilities offline, and **draft** governance-compliant GitHub issues for human
review. Files written in the sandbox are exposed as native MCP resources.

**Philosophy:**
- Three runtime dependencies (`zipnative`, the MCP SDK `@modelcontextprotocol/server`, `zod`) — every byte of ZIP structure belongs to `zipnative`; the server never parses a `PK` signature (the vendored conformance validator in `scripts/verazip-core.mjs` and the test-only raw builder are the sanctioned exceptions, outside `src/`).
- A faithful, thin, secure dispatch layer: validate inputs with strict Zod → call the engine → shape the result → emit bytes as an embedded resource or into the sandbox.
- Engine security defaults stay on; every relaxation is a named input; `limits` can never exceed operator ceilings.
- **No network, ever** — there is no network code path in the server. No telemetry, no GitHub, no URL from any argument.
- Every tool is self-contained (its own file in [src/tools/](../src/tools)), ships `_meta.apiVersion = '1.0.0'` and ≤ 2 executable `_meta.examples` (the rest live in `examples/*.json`) — see [`API_STABILITY.md`](API_STABILITY.md).
- Honest envelopes: what the server reports (`summary.deflateTier`, `summary.deterministic`, `trust`, `crcVerified`, `skipped`) is what the engine did.
- Every archive the server writes is ISO/IEC 21320-1:2015 conformant, validated in CI by an engine-independent validator ("veraZIP", [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md)).

**Runtime:** Node.js ≥ 22 (ESM, strict TypeScript). Transport: stdio (default) or Streamable HTTP. Protocol: MCP 2026-07-28 with automatic 2025-era fallback.

**Repositories**
- MCP server: <https://github.com/Nizoka/zipnative-mcp>
- Engine: <https://github.com/Nizoka/zipnative> — docs at <https://zipnative.dev>
- CLI companion: <https://github.com/Nizoka/zipnative-cli>
- npm: <https://www.npmjs.com/package/zipnative-mcp>

---

## 2. Architecture

```
src/
├── cli.ts             # Entry point: ensureEngineReady() + ceilings read once; stdio (serveStdio) or HTTP (createMcpHandler); signals
├── http.ts            # node:http <-> web Request/Response bridge, 256 MiB body cap (413), Host/Origin loopback guard + Origin port pin
├── auth.ts            # opt-in HTTP bearer token (ZIPNATIVE_MCP_HTTP_TOKEN), constant-time compare, RFC 6750 401 challenge
├── server.ts          # createServer(): TOOLS registry (kind, schemas, annotations, examples), SERVER_INSTRUCTIONS, PROMPTS, cache hints,
│                      #   callToolDirect (cache → handler → dispatchOutput by kind → projection), resources/prompts handlers
├── version.ts         # ZIPNATIVE_MCP_VERSION + TOOL_API_VERSION (both '1.0.0')
├── errors.ts          # ToolError(code, message, data?) + SecurityError (SECURITY_VIOLATION) + GovernanceError (GOVERNANCE_VIOLATION)
├── caps.ts            # every byte / count cap + the three operator ceilings (readCeilings / getCeilings)
├── limits.ts          # the `limits` fragment (eight ZipLimits keys) → resolveCallLimits (LIMIT_CEILING_EXCEEDED) / effectiveLimits
├── base64.ts          # decodeBase64Field / decodeZipBase64 (data: prefix tolerated; PEM / nested URI / double-encoding hints) / encodeBase64
├── sandbox.ts         # THE filesystem boundary: ZIPNATIVE_MCP_OUTPUT_DIR, ZIP_CONTAINER_EXTENSIONS, resolveInputFile / resolveOutputFile /
│                      #   resolveOutputDir, assertRealpathInside, writeExclusive / openExclusiveWriteStream (wx), discardPartial
├── archive-input.ts   # zipBase64 XOR zipPath: loadArchive (buffered), openArchiveSource (ByteSource for the scanner), isPathInput
├── entry-spec.ts      # create/modify entry payloads: compression, dates (DOS range), unixMode → externalAttributes, extraFields, loadPayload
├── entry.ts           # EntryView (the shared per-entry JSON row): viewFromEntry / viewFromHeader, decodeFlags, methodName, crcHex, ENTRY_VIEW_SCHEMA
├── filter.ts          # compileGlob / compileEntryFilter (names, prefix, glob, includeDirectories) — vendored from zipnative-cli
├── diagnostics.ts     # createDiagnosticSink: onDiagnostic → DiagnosticRow[] (dedup by code+entry, cap 200), counts, strict
├── zip-errors.ts      # mapZipError / guard / guardAsync — the ONLY place that reads err.code; ZIP_ERROR_CLASS (39), ZIP_DIAGNOSTIC_CODES (11)
├── engine.ts          # ensureEngineReady() (memoised initNodeZipCodecs), probeRuntime()
├── output.ts          # emitArchive (base64 ≤ 50 MiB | exclusive file ≤ 4 GiB), emitArchiveStream, writeSandboxedText (.md)
├── resources.ts       # zipnative://output/{+path}: listResources (walk ≤ 8 deep, ≤ 1000), readResource (≤ 50 MiB), MIME by extension
├── projection.ts      # token-frugal verbosity / fields projection (selectFields, readVerbosity, readFields)
├── governance.ts      # AI-governance contract: validateIssueMarkdown, IDENTITY_REMINDER, HUMAN_GATE, prompt copy
├── cache.ts           # opt-in content-addressed response cache (ZIPNATIVE_MCP_CACHE_DIR; 1 h TTL; 256 MiB LRU)
├── index.ts           # library entry: createServer, ensureEngineReady, callToolDirect, listToolsPayload, ToolError types
└── tools/
    ├── _shared.ts                 # ProjectionShape, EngineOptionsShape (strict, limits), STRICT_INPUT_PROPERTY, parseInput, sha256Hex
    ├── inspect-zip.ts             # inspect_zip — eager openZip, stats, determinism verdict, check[] / assert
    ├── list-zip-entries.ts        # list_zip_entries — paged EntryView inventory
    ├── read-zip-entry.ts          # read_zip_entry — readEntry / readEntryStream (range) / readEntryRaw / verifyEntry
    ├── verify-zip.ts              # verify_zip — verifyZip report verbatim, never isError for archive problems
    ├── extract-zip.ts             # extract_zip — extractZip (inline) / extractZipStream (plan + file mode), sandbox sink
    ├── scan-zip-forward.ts        # scan_zip_forward — iterateZipEntries over a ByteSource, tolerateTruncation
    ├── sanitize-entry-paths.ts    # sanitize_entry_paths — sanitizeEntryPath + reason re-derivation
    ├── create-zip.ts              # create_zip — createZip / createParallelZip, add / addDirectory / addStream, toBytes / stream
    ├── modify-zip.ts              # modify_zip — createZipModifier, save (append) / saveCompact
    ├── compute-crc32.ts           # compute_crc32 — crc32 chained over 1 MiB chunks
    ├── inflate-raw.ts             # inflate_raw — createInflator (resumable, bounded) / store pass-through / codec.decompressSync
    ├── describe-engine.ts         # describe_engine — capability manifest incl. UNEXPOSED_EXPORTS
    └── draft-governance-issue.ts  # draft_governance_issue — local HITL draft + compliance report

scripts/
├── tool-shape.mjs             # structural fingerprint of tools/list (--write → tests/_fixtures/tool-shape.json)
├── verify-issue.mjs           # CLI twin of validateIssueMarkdown (npm run verify:issue)
├── verazip-core.mjs (+ .d.mts) # the vendored ISO/IEC 21320-1 validator core (validateArchive, CHECK_IDS (22), REQUIRED_NEGATIVE_CHECKS (4))
├── generate-zip-corpus.mjs    # drives the tool handlers + the raw builder → test-output/zip/ + manifest.json (npm run corpus:zip)
├── validate-zip.mjs           # veraZIP driver: level 0 (ISO profile) + level 1 (foreign integrity tools) over the corpus
└── helpers/interop-tools.mjs  # level-1 tool probes (bsdtar, unzip, 7z, python-zipfile, jar) — vendored from zipnative-cli

tests/                          # vitest (globals: false); one tests/<name>.test.ts per tool / module; _-prefixed shared fixtures
├── _mcp-harness.ts             # in-memory legacy-handshake client (connectLegacy, McpRpcError)
├── _http-fixture.ts            # loopback HTTP fixture (2026-07-28 envelope + legacy initialize)
├── _zip-fixtures.ts            # benign fixtures (basicZip, richZip, highRatioZip, streamedZip, incrementalZip, zip64ManyEntries)
│                               #   + hostile ones built in-test (ZIP_SLIP, DEVICE_NAME, OVERLAP, CD_MISMATCH, DECLARED_BOMB, …)
├── _zip-assert.ts              # assertValidZip (PK magic + eager open + verifyZip ok + ISO conformance), assertIsoConformant, expectCheck
├── _fixtures/                  # raw-zip-builder.ts (vendored from zipnative), tool-shape.json (parity), tool-shape.v1.0.0.json (frozen)
└── fixtures/interop/           # two foreign-provenance archives (bsdtar, PowerShell Compress-Archive) — the only committed archives
```

Catalogue parity gate: `scripts/tool-shape.mjs` computes a structural fingerprint of `tools/list` (description strings stripped; `--write` refreshes `tests/_fixtures/tool-shape.json`) and `tests/catalogue-parity.test.ts` fails on any structural drift (types, enums, defaults, constraints, `required`, `additionalProperties`, example count). Wording — descriptions, examples, `SERVER_INSTRUCTIONS` — may change freely; a structural change needs a deliberate fixture refresh reviewed under `API_STABILITY.md` §5. The catalogue is also frozen as `tests/_fixtures/tool-shape.v1.0.0.json` for the superset gate that starts in 1.1.0. `tests/docs-consistency.test.ts` pins the counts and names quoted across README, AGENTS.md, `llms.txt`, `server.json`, `CITATION.cff`, `CLAUDE.md` and `docs/data/*.json` to the code (13 tools in registration order, 7 prompts, 7 environment variables, the 16 wrapper codes, the 39 `ZIP_*` codes and 11 diagnostics, the 77-export ledger in §8).

Catalogue size: `tools/list` is ≈ 94,357 bytes (≈ 94 kB) and `SERVER_INSTRUCTIONS` ≈ 4,727 bytes (≈ 4.7 kB). The schemas use no `$ref` / `$defs` (some hosts forward `inputSchema` to function-calling APIs that reject references) and no `$schema` keyword (MCP ≥ 2025-11-25 defaults to JSON Schema 2020-12); the shared fragments (`ARCHIVE_INPUT_PROPERTIES`, `FILTER_INPUT_SCHEMA`, `LIMITS_INPUT_SCHEMA`, `ENTRY_VIEW_SCHEMA`, `ENTRY_PAYLOAD_PROPERTIES`, `DIAGNOSTICS_OUTPUT_PROPERTIES`, `PROJECTION_INPUT_PROPERTIES`) are therefore repeated inline per tool.

### Request Dispatch Flow

```
AI client (Claude / Cursor / Copilot / etc.)
    │  MCP JSON-RPC over stdio (frame ≤ 256 MiB), or POST /mcp (Streamable HTTP, body ≤ 256 MiB)
    ▼
src/cli.ts
  ensureEngineReady()   ← initNodeZipCodecs() awaited once (node:zlib tier for every sync codec path, incl. the worker pool)
  getCeilings()         ← ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES / _MAX_ENTRIES / _WORKERS read once; invalid → one `fatal:` line, exit 1
  stdio: serveStdio(createServer, { legacy: 'serve', transport: StdioServerTransport({ maxBufferSize: 256 MiB }) })  ← one Server per process
  HTTP : guardLoopback → guardBearer → createMcpHandler(createServer, { legacy: 'stateless' })                       ← fresh Server per request
    │
    ▼
src/server.ts  (createServer)
  tools/list        → TOOLS registry → JSON schemas + annotations + _meta { apiVersion, examples }; cache hint public / 24 h
  tools/call        → callToolDirect(name, args) → server.projectCallToolResult(result, outputSchema)
                      unknown tool name → JSON-RPC −32602 `[UNKNOWN_TOOL] Unknown tool: <name>` (protocol error, not isError)
  prompts/list|get  → PROMPTS (governance_contract, draft_issue_workflow, secure_extraction, reproducible_archive, incremental_update,
                      forensic_scan, verify_before_trust); unknown → −32602 `[UNKNOWN_PROMPT]`
  resources/*       → src/resources.ts (private, ttlMs 0); template zipnative://output/{+path}; unknown URI → UNKNOWN_RESOURCE (−32602)
  server/discover   → SDK-generated (versions, capabilities, instructions, cache hint public / 1 h)
    │
    ▼
callToolDirect(name, input)
  isCacheable(name, input)?         ← false for zipPath / sourcePath, outputMode:'file', defaultDate:'now', parallel, describe_engine, draft_governance_issue
    hit → dispatchOutput(cached) + _meta.cached: true
  tool.handler(input)               ← src/tools/<tool>.ts
    parseInput(Zod .strictObject)   ← unknown keys / bad shapes → ToolError('VALIDATION_ERROR')
    loadArchive / openArchiveSource ← zipBase64 (decoded ≤ 128 MiB) or zipPath (sandbox, container extension, ≤ 1 GiB buffered)
    createDiagnosticSink(strict)    ← every engine call receives { onDiagnostic, strict }
    resolveCallLimits(limits)       ← merged over DEFAULT_ZIP_LIMITS, ceilings enforced (LIMIT_CEILING_EXCEEDED)
    guard('context', () => engine call)   ← src/zip-errors.ts: ZipError → ToolError(err.code verbatim, message, data)
    emitArchive / emitArchiveStream ← src/output.ts (archive-producing tools)
  setCached(...)                    ← only when cacheable
  dispatchOutput(output, tool, input) by tool.kind:
    'archive-output' | 'inflate' → buildArchiveResult: text + embedded `resource` (data:<mime>;base64,…) | resource_link; structuredContent { mode, sizeBytes, filePath?, summary, diagnostics, … }
    'extract'                    → buildExtractResult: projected result + up to 50 resource_links (file mode)
    'inspect' | 'list' | 'read-entry' | 'verify' | 'scan' | 'sanitize' | 'engine' → projected(text, full, summary, input)
    'crc32'                      → text + structuredContent (no projection)
    'governance'                 → two text blocks (human-gate notice + draft) + structuredContent
  catch → buildErrorResult: content[0].text = "<tool> failed [CODE]: message", isError: true, _meta.error { code, message, data? }
```

The projection layer (`src/projection.ts`) runs inside `projected()`: `verbosity: 'summary'` swaps the full result for the tool's summary function (`inspectSummary`, `listSummary`, `readEntrySummary`, `verifySummary`, `extractSummary`, `scanSummary`, `sanitizeSummary`, `describeSummary`), then `fields: ['a', 'b.c']` projects to named dot-paths (array segments map over elements); unmatched paths are reported additively in `_meta.unmatchedFields` + `_meta.availableFields`. Defaults (`'full'`, no `fields`) are unchanged. The projectable `outputSchema` (every property optional, `additionalProperties: false`, summary scalars declared) is built once per tool by `projectableOutputSchema()` in `src/server.ts`.

---

## 3. Tool Registry ([src/server.ts](../src/server.ts))

Each tool is registered in the `TOOLS: readonly ToolDefinition[]` array with:

```typescript
interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    kind: 'archive-output' | 'extract' | 'inspect' | 'list' | 'read-entry' | 'verify' | 'scan' | 'sanitize' | 'crc32' | 'inflate' | 'engine' | 'governance';
    inputSchema: unknown;             // hand-written JSON Schema 2020-12, `as const`, additionalProperties: false
    outputSchema?: unknown;           // projectable for the read tools; ARCHIVE_OUTPUT_SCHEMA for the archive producers
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    examples?: ReadonlyArray<{ title: string; input: Record<string, unknown> }>;   // ≤ 2, executable
    handler: (args: unknown) => Promise<ToolOutput>;
}
```

`kind` selects the result shaper in `dispatchOutput`. A `TOOL_INDEX: ReadonlyMap<string, ToolDefinition>` is derived from the array for O(1) lookup; `toolNames()` returns the registration order (the docs-consistency canary); `__setToolCount(TOOLS.length)` feeds `describe_engine.server.toolCount`.

Registration order (= `tools/list` order): `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `create_zip`, `modify_zip`, `compute_crc32`, `inflate_raw`, `describe_engine`, `draft_governance_issue`.

Annotations: `READ_ONLY` = `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` on the read tools, `compute_crc32`, `inflate_raw` and `describe_engine`; `WRITES` = `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }` on `extract_zip`, `create_zip`, `modify_zip` and `draft_governance_issue` (file mode writes). `openWorldHint` is `false` everywhere: nothing leaves the process.

**`_meta` per tool** — emitted in the `tools/list` response: `_meta.apiVersion = '1.0.0'` and `_meta.examples` (one or two executable inputs; `<zip-base64>` is the placeholder the examples runner substitutes).

**Server metadata:**
- `SERVER_NAME = 'zipnative-mcp'`, `SERVER_VERSION = ZIPNATIVE_MCP_VERSION` (`'1.0.0'`).
- `serverInfo` carries `title`, `description` (mirrors `server.json`) and `websiteUrl` (`https://github.com/Nizoka/zipnative-mcp#readme` = `package.json` `homepage`).
- `SERVER_CACHE_HINTS` — MCP 2026-07-28 `ttlMs` / `cacheScope` per method: `tools/list` + `prompts/list` public 24 h, `server/discover` public 1 h, `resources/*` private 0 (2025-era clients never see these fields).
- Registry ID `io.github.Nizoka/zipnative-mcp` (`package.json` `mcpName`, `server.json` `name`; canonical GitHub login casing).
- `SERVER_INSTRUCTIONS` — compact decision tree + security posture + common pitfalls returned in `serverInfo.instructions` (≈ 4,727 bytes (≈ 4.7 kB)).

**Boot:** `ensureEngineReady()` is awaited by the CLI before serving and defensively by the tools that need the node:zlib tier (`create_zip`, `modify_zip`, `inflate_raw`, `describe_engine`).

---

## 4. Tools — Full Reference

Every archive-consuming tool starts with `parseInput` (strict Zod), `loadArchive` (or `openArchiveSource` for the scanner), a diagnostic sink and `resolveCallLimits`, then wraps every engine call in `guard` / `guardAsync` / `mapZipError`. The shared fragments: `ARCHIVE_INPUT_PROPERTIES` (`zipBase64` XOR `zipPath`), `FILTER_INPUT_SCHEMA` (`names[]` ≤ 1000, `prefix`, `glob[]` ≤ 32, `includeDirectories`), `LIMITS_INPUT_SCHEMA` (the eight `ZipLimits` keys), `STRICT_INPUT_PROPERTY`, `PROJECTION_INPUT_PROPERTIES` (`verbosity`, `fields` ≤ 16), `OUTPUT_INPUT_PROPERTIES` (`outputMode`, `outputPath`), `ENTRY_PAYLOAD_PROPERTIES` (`name`, `directory`, `dataBase64` | `text` | `sourcePath`, `compression`, `date`, `comment`, `externalAttributes` | `unixMode`, `extraFields[]` ≤ 16), `DIAGNOSTICS_OUTPUT_PROPERTIES` (`diagnostics[]`, `diagnosticCounts`, `diagnosticsTruncated`).

### `inspect_zip`

**Purpose:** read-only archive report in one call, the `zipnative inspect --json` shape, plus CI assertions. Opens **eagerly** by default (`validate: 'eager'` — every local header cross-checked, the overlap table built up front) so a hostile shape is refused with its `ZIP_*` code rather than summarised; `validate: 'lazy'` defers to first read (cheaper on huge archives).

**Report:** counts (entries / files / directories), `isZip64`, the comment (lossy UTF-8 + `commentHex`), `prependedData` / `multipleEocd` (derived from the `ZIP_PREPENDED_DATA` / `ZIP_MULTIPLE_EOCD` diagnostics), compressed vs uncompressed totals and `ratio`, per-method counts, encrypted / symlink / data-descriptor / Zip64 / UTF-8 / cp437 / duplicate / unsafe-name counts (`sanitizedPathOf(name) === null`), the date range, and the **determinism verdict**: `deterministic = epochTimestamps && canonicalOrder && utf8Flags` (reproducibility) and `canonicalLayout = noDataDescriptors` (form) — a streamed archive is reproducible but not canonical. `check[]` (15 named assertions) and `assert { maxEntries, minEntries, maxUncompressedBytes, maxRatio, has[], method }` produce `checks[] { check, ok, detail }` + `checksPassed`.

**zipnative API used:** `openZip(bytes, { validate, limits, strict, onDiagnostic })` → `ZipReader.entries()`, `entryCount`, `isZip64`, `comment`; per entry `ZipEntry` (`rawName`, `dosDate` / `dosTime`, `flags`, `compressionMethod`, sizes, `isEncrypted`, `usesDataDescriptor`, `usesZip64`, `nameEncoding`, `lastModified`), `isSymlinkEntry`, `sanitizeEntryPath`, `FLAG_UTF8`, `METHOD_STORE` / `METHOD_DEFLATE`, `getCodec` (method names).

### `list_zip_entries`

**Purpose:** the paged central-directory inventory; nothing is decompressed. Every entry (duplicates included) in directory order, projected through the shared `EntryView` (`src/entry.ts`, vendored from the CLI's `entryfmt.ts` so an agent that knows `zipnative list --json --long` reads the same field names). `filter` selects; `offset` + `limit` (default 200, max 2000) page; `hasMore` tells you to page; `includeExtraData` adds each extra field's payload as base64. Directories are listed unless the filter excludes them (`includeDirectories` defaults to `true` here, `false` for extraction). `validate` defaults to `'lazy'`.

**zipnative API used:** `openZip` → `entries()`, `entryCount`, `isZip64`; per row `getUnixMode`, `isSymlinkEntry`, `sanitizeEntryPath`, `getCodec`, `FLAG_*` masks, `ZipExtraField`.

### `read_zip_entry`

**Purpose:** random access to one entry by `name` (exact; the last duplicate wins — `reader.getEntry`) or `index` (central-directory position; disambiguates duplicates). `mode: 'data'` (default) returns the decompressed content as base64 or UTF-8 `text` (`ENTRY_NOT_UTF8` on invalid UTF-8), CRC-verified (`verifyCrc`); a `range { offset, length }` reads a byte window through `readEntryStream` (bounded memory, `crcVerified: false`). `mode: 'raw'` returns the compressed payload verbatim (`readEntryRaw`, zero-copy) for `inflate_raw`. `mode: 'verify'` runs `reader.verifyEntry` and returns `{ ok, crcMatch, sizeMatch, localHeaderMatch }` without a payload. Inline cap 16 MiB (`ENTRY_TOO_LARGE`, remedy `range` or `extract_zip` file mode).

**zipnative API used:** `openZip` → `entries()`, `getEntry(name)`, `readEntry(entry, { verifyCrc })`, `readEntryStream(entry, { verifyCrc: false })`, `readEntryRaw(entry)`, `verifyEntry(entry)` (`EntryVerification`).

### `verify_zip`

**Purpose:** one-call deep verification — the engine's `verifyZip` report verbatim: eager structural validation, then every entry's CRC-32 / size / local-header agreement. The contract that makes it agent-grade: it **never** fails for a problem with the archive. A structural refusal lands in `error { code: ZIP_*, message }` (`ok: false`, no entries); an unverifiable entry is `skipped: 'encrypted' | 'stream-only-codec'` and does not fail the archive. `entries: 'all' | 'failed' | 'skipped' | 'none'` selects the rows; `maxEntries` (default 1000) caps them (`entriesTruncated`), the counts always cover every entry. Only caller mistakes throw.

**zipnative API used:** `verifyZip(bytes, { limits })` → `ZipVerificationReport { ok, error, entryCount, entries: VerifiedEntry[], diagnostics }`.

### `extract_zip`

**Purpose:** secure-by-default extraction. Every engine guard stays on unless the caller names the relaxation: `rejectTraversal` (zip-slip, absolute, drive / UNC, NUL, ADS, Windows device names — CWE-22 / CWE-67; `false` skips such entries and lists them in `skipped`, never emits them), `rejectSymlinks` (CWE-59; `false` writes the link target text as ordinary data, never a link), `onDuplicate` (CWE-694; `'first'` / `'last'`), `limits` (CWE-400 / CWE-409); overlap and central/local divergence detection has no opt-out. `filter` keeps a subset.

- **base64 mode** — the plan runs first through `extractZipStream` (sanitized paths, entries, no payload touched); `includeData: false` returns it as a dry run (`dryRun: true`). Otherwise the inline caps are checked against the declared sizes (16 MiB per entry, 32 MiB total) and `extractZip` produces the rows with `dataBase64`.
- **file mode** — `outputDir` (relative, inside the sandbox, created, realpath-checked) and a streamed write per entry: the engine's sanitized path is the only thing ever joined, the parent's real path is re-checked after every `mkdir -p`, files are opened `wx` (never overwritten), the 4 GiB file-output cap is enforced while writing, a partial file is removed on failure. `emptyDirectories: true` also creates the explicit directory entries that hold no file. The result carries `filePath` per row and up to 50 `resource_link` blocks.

**zipnative API used:** `openZip` (index + `sanitizeEntryPath` pre-flight), `extractZipStream(bytes, options)` (plan + file mode, `ExtractedStreamEntry { path, entry, stream() }`), `extractZip(bytes, options)` (inline, `ExtractedEntry { path, entry, data }`), `ExtractOptions { rejectTraversal, rejectSymlinks, onDuplicate, filter, limits, strict, onDiagnostic }`.

### `scan_zip_forward`

**Purpose:** the engine's forward, central-directory-less reader over the archive bytes — local headers walked in stream order with bounded memory. The one tool that works on a truncated archive, a stream cut mid-way or an SFX prefix you cannot seek past, and the one whose result is **not authoritative** (`trust: 'local-headers-only'`): forward iteration trusts local headers alone, so a hostile archive can present different content here than `inspect_zip` / `list_zip_entries` report (the upload-scanner differential). `data: 'none'` skips payloads (a data-descriptor entry still costs a decompress-and-discard), `'verify'` decompresses to check CRCs, `'include'` returns content under the inline caps. `maxEntries` (default 10 000, bounded by `ZIPNATIVE_MCP_MAX_ENTRIES`) bounds the work; `tolerateTruncation: true` turns a mid-stream failure into `stoppedAt: 'error'` + `error { code, message }` + the partial inventory. `stoppedAt: 'central-directory'` vs `'eof'` is classified by counting the bytes the reader consumed and looking for a CFH / EOCD signature in the last chunk. Names are not sanitized here; `sanitizedPath` shows what the extraction gate would use. `zipPath` input is streamed from disk (no buffered cap); `zipBase64` is chunked from memory.

**zipnative API used:** `iterateZipEntries(source, { limits, strict, onDiagnostic })` → `StreamedZipEntry { header: StreamedZipHeader, data(), skip() }`; `ByteSource` built by `openArchiveSource`.

### `sanitize_entry_paths`

**Purpose:** the engine's single traversal gate `sanitizeEntryPath()` over a list of names (1–10 000): the safe `/`-separated relative form each maps to, or `null` with the rule that fired (`empty`, `nul`, `absolute`, `drive`, `unc`, `traversal`, `ads`, `device-name`, `no-segments` — re-derived in the same order as the engine; the gate is the `sanitized` value, `reason` is explanatory). No archive needed. Use it when you extract with another tool or plan an external filesystem sink.

**zipnative API used:** `sanitizeEntryPath(name)`.

### `create_zip`

**Purpose:** deterministic archive creation through `createZip` (or the worker-pool `createParallelZip` from `zipnative/worker` when `parallel` is given — byte-identical per tier). Every option of the engine's writer is reachable: `order` (`canonical` raw-name-byte order by default; `insertion` for EPUB / JAR mimetype-first layouts), `defaultDate` (omitted = DOS epoch; an ISO instant in 1980–2107; `'now'` = wall clock, `ZIP_TIMESTAMP_NOT_PINNED`), archive and per-entry `compression { method, level, deterministic }`, `comment`, per-entry `comment` / `unixMode` (`'0644'` → `(S_IFREG | mode) << 16`; directories get `S_IFDIR` + the DOS directory bit) or raw `externalAttributes` / `extraFields` (embedded verbatim; id `0x0001` refused — the engine owns Zip64), explicit directories, and streamed sources (`stream: true` on a `sourcePath` → `addStream` over 64 KiB chunks; data-descriptor layout; > 4 GiB refused by the engine). Inline payloads share the 128 MiB decoded budget; `sourcePath` files up to 1 GiB buffered (no cap when streamed). base64 mode assembles with `toBytes()` (or collects `stream()` when an entry was streamed); file mode streams the archive to disk with `stream({ chunkSize })` and bounded memory. `parallel.workers` is bounded by `ZIPNATIVE_MCP_WORKERS`; the pool is worth it only for many large entries. `includeSha256` adds `summary.sha256`. `summary.deterministic` is `true` only when the pure-TS encoder is pinned for every entry and no wall-clock date is used (level-3 determinism, [`guides/DETERMINISM.md`](guides/DETERMINISM.md)); `summary.deflateTier` is `activeDeflateTier(deterministic)` (`pure-pinned` or `node-zlib`).

**zipnative API used:** `createZip(options)` / `createParallelZip(options)` → `ZipWriter` / `ParallelZipWriter` `add`, `addDirectory`, `addStream`, `toBytes`, `stream({ chunkSize })`; `CreateZipOptions { order, defaultDate, compression, comment, limits, strict, onDiagnostic }`; `AddEntryOptions`; `ParallelZipOptions { workers, minWorkerJobSize, jobTimeout }`; `activeDeflateTier`.

### `modify_zip`

**Purpose:** incremental modification through `createZipModifier` without recompressing anything: `operations[]` (1–1000) applied in order — `add` (`ZIP_ENTRY_EXISTS` if present; `directory: true` adds an explicit directory), `replace` (`ZIP_ENTRY_NOT_FOUND` otherwise), `remove`, `rename` (never overwrites — remove the target first), `setComment`. `mode: 'append'` (default) = `save()`: the original bytes verbatim + appended entries + a new central directory — fast and byte-preserving, and the superseded payloads **remain in the file** (data remanence; `ZIP_DEAD_BYTES_RATIO` past 50 % dead bytes; 7-Zip reads the stale payload). `mode: 'compact'` = `saveCompact()`: canonical rewrite, still no recompression, removed data truly gone, SFX prefix dropped. `summary.noOp` is `true` when the engine returned the same buffer (no edits, unchanged comment); `entryCountAfter` is read by re-opening the output. Archives with duplicate names are refused by the engine. New payloads take `compression` / `defaultDate` like `create_zip`. Full guide: [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md).

**zipnative API used:** `openZip` → `createZipModifier(reader, { compression, defaultDate, limits, strict, onDiagnostic })` → `ZipModifier.addEntry / replaceEntry / removeEntry / renameEntry / setComment / save / saveCompact`; `reader.bytes` (identity check for `noOp`), `reader.entryCount`.

### `compute_crc32`

**Purpose:** the ZIP checksum (IEEE 802.3 CRC-32, the engine's slice-by-8 `crc32`) of inline bytes / text or a sandbox file streamed in 1 MiB chunks. `seed` continues a running CRC across consecutive chunks; `expect` (8 hex digits, `0x` tolerated) compares and sets `matches`. Cross-check an entry's `crc32` from `list_zip_entries` against a file on disk.

**zipnative API used:** `crc32(bytes, seed)`.

### `inflate_raw`

**Purpose:** decompress a raw DEFLATE (RFC 1951) stream — e.g. the payload from `read_zip_entry mode: 'raw'` — with a **mandatory** `maxOutput` bound through the engine's resumable `createInflator`, fed chunk by chunk (64 KiB): constant memory, exact `bytesConsumed`, trailing bytes reported as `leftover` (`summary.trailingWarning` unless `allowTrailing`), `ZIP_INFLATE_OUTPUT_OVERFLOW` past the bound (further capped at 50 MiB inline / 4 GiB file). `method: 'store'` is a bounded pass-through; a numeric method id selects a registered codec's `decompressSync` — this server registers none beyond 0 / 8, so it yields `ZIP_UNSUPPORTED_METHOD` (or `ZIP_UNSUPPORTED_CODEC_MODE` for a stream-only codec). Output as an embedded `application/octet-stream` resource or a sandbox file (`.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`).

**zipnative API used:** `createInflator(maxOutput)` → `Inflator.push / finished / leftover / bytesConsumed / end`; `getCodec(method)`; `METHOD_STORE` / `METHOD_DEFLATE`.

### `describe_engine`

**Purpose:** an offline capability preflight (the `zipnative doctor --json` of this server): server / engine / tool-API versions and the protocol string, the deflate tier in use and the pinned deterministic tier, runtime codecs (node:zlib, `CompressionStream`, `DecompressionStream`) and worker threads (`cpuCount`, `defaultWorkers`), the codec registry (store / deflate: sync / stream), `DEFAULT_ZIP_LIMITS`, the operator ceilings with their environment variable names, every server cap (`CAPS`), whether the sandbox and the cache are enabled, `network: 'none'`, the 39 `ZIP_*` codes, the 11 diagnostic codes, and `UNEXPOSED_EXPORTS` (the engine surfaces this server deliberately does not expose, with the rationale — §8). Never cached.

**zipnative API used:** `VERSION`, `activeDeflateTier(false | true)`, `getCodec`, `DEFAULT_ZIP_LIMITS`, `METHOD_STORE` / `METHOD_DEFLATE`; `initNodeZipCodecs` via `ensureEngineReady`.

### `draft_governance_issue`

**Purpose:** drafts a governance-compliant GitHub issue **locally** for human review (`src/tools/draft-governance-issue.ts`). It performs no network I/O (the server has no network code path) and never submits — the agent is a draftsman, a human is the only gate. Inputs: `title`, `issueType` (`bug` | `feature` | `security` | `docs` | `performance`), `summary`, `reproduction { command, result }`, `expectedBehavior`, optional `actualBehavior`, `targetRepo` (default `zipnative-mcp`; `zipnative` for engine behaviour), `affectedPackages` (default `['zipnative-mcp']`), `duplicateSearchPerformed` (**must be `true`**), plus `outputMode` (`'inline' | 'file'`) / `outputPath` (`.md`). Returns `{ draftMarkdown, compliance, warnings, … }`. Contract enforcement lives in `src/governance.ts` (`validateIssueMarkdown`): proposing a runtime dependency, omitting the reproduction, or `duplicateSearchPerformed: false` throws `GovernanceError('GOVERNANCE_VIOLATION')`. In file mode the draft is written through `writeSandboxedText()` (same sandbox guards as archive output, `.md` extension). The contract source of truth is under `.github/` (`ai-governance.json`, `AGENT_RULES.md`); the narrative guide is [`guides/AI_GOVERNANCE.md`](guides/AI_GOVERNANCE.md).

### MCP resources

Files in the sandbox are exposed as native MCP resources (`src/resources.ts`). `resources/list` walks `ZIPNATIVE_MCP_OUTPUT_DIR` (≤ 8 levels deep, ≤ 1000 entries, sorted) and returns `zipnative://output/<relative>` URIs for **every regular file** — archives written by `create_zip` / `modify_zip`, files written by `extract_zip`, drafts written by `draft_governance_issue`, and archives the operator dropped in for `zipPath` — with a MIME type by extension (`application/zip`, `application/java-archive`, the OOXML / ODF types, `application/epub+zip`, `text/markdown`, …, `application/octet-stream` when unknown). `resources/templates/list` advertises `zipnative://output/{+path}` (RFC 6570 reserved expansion). `resources/read` re-validates the path through the sandbox resolver (traversal / NUL / absolute guards) and returns the base64 blob (≤ 50 MiB, `OUTPUT_TOO_LARGE` beyond); an unknown URI → JSON-RPC `-32602` carrying `UNKNOWN_RESOURCE`. File-producing tools also emit `resource_link` content blocks. When the sandbox is disabled there are no resources and no template. Capability advertised as `resources: {}`.

### MCP prompts

The server advertises the `prompts` capability. Seven prompts (`PROMPTS` in `src/server.ts`), read-only text with no arguments:
- `governance_contract` — the AI-governance / Human-In-The-Loop contract (from `src/governance.ts`).
- `draft_issue_workflow` — the step-by-step recipe for `draft_governance_issue`.
- `secure_extraction` — untrusted-archive intake: verify, inspect with CI checks, dry-run the plan, extract with every guard on, when (not) to relax a guard.
- `reproducible_archive` — byte-identical archives: pinned dates, canonical order, the deterministic encoder pin, and how to prove it.
- `incremental_update` — how `modify_zip` edits without recompression, what append mode leaves behind, when to compact.
- `forensic_scan` — when and how to use `scan_zip_forward`, what its local-headers-only result can and cannot tell you.
- `verify_before_trust` — the minimal read-only sequence to run on any archive before extracting it.

---

## 5. Output System ([src/output.ts](../src/output.ts), [src/sandbox.ts](../src/sandbox.ts))

| Mode | Description | Env var required |
|------|-------------|-----------------|
| `'base64'` | Bytes inline as an embedded `resource` content block (`data:<mime>;base64,…`), ≤ 50 MiB (`OUTPUT_TOO_LARGE`) | No |
| `'file'`   | Streamed into the sandbox with `wx`; returns `filePath` + `sizeBytes` + a `resource_link`; ≤ 4 GiB | Yes — `ZIPNATIVE_MCP_OUTPUT_DIR` |

`extract_zip` file mode writes under `outputDir` (a relative directory); `draft_governance_issue` writes a `.md` through `writeSandboxedText`.

### The sandbox (reads **and** writes)

`src/sandbox.ts` is the single filesystem boundary. Every path a tool reads (`zipPath`, `sourcePath`) or writes (`outputPath`, `outputDir`, extracted files, governance drafts) resolves through it against `ZIPNATIVE_MCP_OUTPUT_DIR`. Unset ⇒ every file input and output is disabled (`SECURITY_VIOLATION`) and the tools work on base64 only. Guards, in order:

1. `INVALID_PATH` — empty or non-string.
2. `SECURITY_VIOLATION` — NUL byte; absolute, Windows-absolute (`C:\`) or UNC (`\\`) path (checked even on POSIX); `path.relative(sandbox, resolved)` empty, starting with `..` or absolute.
3. `INVALID_EXTENSION` — `zipPath` / `outputPath` must end in one of `ZIP_CONTAINER_EXTENSIONS` (`.zip`, `.jar`, `.war`, `.ear`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, `.vsix`, `.nupkg`, `.whl`, `.apk`, `.ipa`, `.xpi`, `.crx`, `.kmz`); `.md` for drafts; the `inflate_raw` list for inflated output; `sourcePath` and extracted files are unconstrained.
4. `INPUT_NOT_FOUND` — a read target is absent or not a regular file (the message carries the relative path only).
5. `assertRealpathInside` — after `mkdir -p`, the **real** path of the parent must still live inside the real sandbox (a pre-existing symlinked directory inside the sandbox cannot redirect a write outside it).
6. `wx` — `writeExclusive` / `openExclusiveWriteStream` never overwrite (`OUTPUT_EXISTS`); other fs errors map to `IO_ERROR` with the errno (never the absolute path); a partial file is removed on failure (`discardPartial`).

Streaming caps: `emitArchiveStream` and the `extract_zip` file writer enforce the 4 GiB cap while writing (backpressure-aware); a `zipPath` for the buffered tools is stat-checked against 1 GiB before it is read; `scan_zip_forward` streams a `zipPath` with no size cap.

### `OutputResult` type

```typescript
interface OutputResult {
    mode: 'base64' | 'file';
    sizeBytes: number;
    filePath?: string;                    // when mode='file' (absolute sandbox path)
    base64?: string;                      // when mode='base64' (delivered as the resource block, not in structuredContent)
    summary?: Record<string, unknown>;    // tool-specific: create_zip / modify_zip / inflate_raw summaries
    mimeType?: string;                    // application/zip by default; application/octet-stream for inflate_raw
}
```

---

## 6. Caching ([src/cache.ts](../src/cache.ts))

An opt-in, content-addressed on-disk cache for tool results. Disabled by default; set `ZIPNATIVE_MCP_CACHE_DIR` to enable it. Key = SHA-256 of the canonical JSON `{ tool, apiVersion, input }`, where `apiVersion` is `TOOL_API_VERSION/ZIPNATIVE_MCP_VERSION/zipnative VERSION` (`CACHE_API_VERSION` in `src/server.ts`) — engine lock-step, so an upgrade never serves bytes written by the previous engine. Entries live 1 h (TTL) under a 256 MiB cap with LRU eviction by mtime; every I/O error degrades to a miss and the cache never throws to the client. A hit is re-shaped through `dispatchOutput` and carries `_meta.cached: true`. **Never cached** (`isCacheable()`): any input carrying `zipPath` / `sourcePath` (a path is a reference, not content — the file may change), `outputMode: 'file'` (the filesystem side-effect is part of the contract), `defaultDate: 'now'` (wall clock), any `parallel` request (timing-dependent fallbacks), `describe_engine` (environment-dependent) and `draft_governance_issue` (embeds the environment). The cache stores tool output as plaintext at rest — protect the directory like the sandbox.

---

## 7. Error Types ([src/errors.ts](../src/errors.ts), [src/zip-errors.ts](../src/zip-errors.ts))

```typescript
class ToolError extends Error {
    code: string;   // a wrapper code, or one of zipnative's 39 frozen ZIP_* codes verbatim
    data?: Readonly<Record<string, unknown>>;   // machine-readable detail, surfaced as _meta.error.data — never a secret
}
class SecurityError extends ToolError   { code = 'SECURITY_VIOLATION'; }
class GovernanceError extends ToolError { code = 'GOVERNANCE_VIOLATION'; }
```

**Wrapper codes (16):** `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `UNKNOWN_RESOURCE`, `GOVERNANCE_VIOLATION`, `ENGINE_ERROR`. Full table with remedies: `AGENTS.md` §6 / [`AI_GUIDE.md`](AI_GUIDE.md) §5.

**`ToolError` → MCP `CallToolResult`:** `content[0].text = "<tool> failed [CODE]: message"`, `isError: true`, `_meta.error = { code, message, data? }`. A non-`ToolError` throw (should not happen) → `content[0].text = "<tool> failed: message"`, `isError: true`, no `_meta`.
**Protocol-level** (JSON-RPC errors, not tool results): `tools/call` with an unknown tool name → `-32602` `[UNKNOWN_TOOL] Unknown tool: <name>` (`callToolDirect`, in-process, keeps `isError`); `prompts/get` unknown → `-32602` `[UNKNOWN_PROMPT]`; `resources/read` unknown URI → `-32602` carrying `UNKNOWN_RESOURCE`, other resource failures → `-32602` `[CODE] message`.

### The `ZIP_*` mapping (`mapZipError`)

`src/zip-errors.ts` is the **only** place that reads `err.code` from the engine (vendored from zipnative-cli's `ziperr.ts` and reshaped for MCP). Every engine call is wrapped: `guard('Failed to open archive', () => openZip(...))` / `guardAsync` / `mapZipError(err, context, entryName?, extra?)`. The rules:

- A `ToolError` passes through unchanged.
- A `ZipError` becomes `ToolError(err.code, '<context>: <engine message>', data)` — the code **verbatim** (39 frozen codes: 7 base, 13 format, 6 security, 5 data, 2 limit, 6 unsupported), the message keeps the engine text (which names the remedy), and `data` carries `errorClass` (`ZIP_ERROR_CLASS[code]`: `usage` / `limit` / `not-found` / `input` / `internal` / `check` / `parse` / `security` / `data` / `unsupported`), `engineError` (the class name: `ZipError`, `ZipFormatError`, `ZipSecurityError`, `ZipDataError`, `ZipLimitError`, `ZipUnsupportedError`), `entryName` (from `ZipSecurityError` / `ZipDataError`, else the caller's), and per class `{ limit, configured, observed }` (`ZipLimitError`), `{ feature }` (`ZipUnsupportedError`), `{ expectedCrc, actualCrc }` as 8-hex (`ZipDataError`), plus the caller's `extra` (`operationIndex` / `op`, `entryIndex`, `writtenCount`).
- The node:zlib errors of the sync tier (`Z_DATA_ERROR` / `Z_NEED_DICT` → `ZIP_DEFLATE_CORRUPT`, `Z_BUF_ERROR` → `ZIP_DEFLATE_TRUNCATED`, `engineError: 'ZlibError'`) are mapped so the code never depends on the codec tier.
- Anything else → `ENGINE_ERROR` (`errorClass: 'internal'`).
- `ZIP_ERROR_CLASS` is typed `satisfies Record<ZipErrorCode, string>`: an engine minor that adds a code fails `tsc` here instead of leaking as `ENGINE_ERROR`. Three tools raise a `ZIP_*` code themselves without an engine throw, with the same shape: `read_zip_entry` (`ZIP_ENTRY_NOT_FOUND` for a missing name / out-of-range index) and `inflate_raw` (`ZIP_INFLATE_OUTPUT_OVERFLOW` for store above the bound, `ZIP_UNSUPPORTED_METHOD` / `ZIP_UNSUPPORTED_CODEC_MODE` for the codec registry).

**Diagnostics are not errors.** The 11 diagnostic codes (`ZIP_PREPENDED_DATA`, `ZIP_MULTIPLE_EOCD`, `ZIP_NAME_MISMATCH`, `ZIP_UNICODE_PATH_CONFLICT`, `ZIP_INVALID_UTF8_NAME`, `ZIP_DUPLICATE_NAME`, `ZIP_EXTRA_FIELD_MALFORMED`, `ZIP_ZIP64_EXTRA_IGNORED`, `ZIP_TIMESTAMP_NOT_PINNED`, `ZIP_NONDETERMINISTIC_CODEC`, `ZIP_DEAD_BYTES_RATIO`) flow through `createDiagnosticSink` into every result's `diagnostics[]` (`{ code, severity, message, entryName? }`, de-duplicated by code + entry, capped at 200 with `diagnosticsTruncated`) and `diagnosticCounts` (every occurrence). `strict: true` asks the engine to escalate the first one into `ZIP_STRICT_DIAGNOSTIC`. The sink is always installed, so the engine's `console.warn` fallback never touches stdout (a stdio server's wire). Registry with `raisedWhen` / `remedy` per code: [`data/errors.json`](data/errors.json).

---

## 8. The 77-export coverage ledger (zipnative API mapping)

Every one of the 77 exports of zipnative 1.0.0 (72 from `zipnative`, 5 from `zipnative/worker` — [`data/core-exports.json`](data/core-exports.json), derived from the engine's `docs/assets/api.json`) mapped to its MCP touchpoint: the tool and the input / output field that exercises it. The **Reach** column grades each row honestly: **capability** — the behaviour behind the export is exercisable through a tool; **type** — re-exported (or aliased) upstream for typing only, nothing an agent can observe depends on it beyond `tsc`; **unexposed** — deliberately not reachable from a tool argument, with the reason. Six exports carry reach `unexposed` (`registerCodec`, `ZipCodec`, `CodecCompressOptions`, `setInflateImpl`, `setDeflateImpl`, `initNodeZipCodecs`) and four sub-surfaces of capability rows are likewise unexposed (`ParallelZipOptions.workerUrl`, `ZipCommonOptions.onDiagnostic`, `ZipReader.bytes` / `ZipModifier.reader`, an external `ByteSource` / `ReadableStream`) — the same seven entries `describe_engine.unexposed` reports at runtime (`UNEXPOSED_EXPORTS` in `src/tools/describe-engine.ts`). Nine rows are `type`. `tests/docs-consistency.test.ts` checks that every name below stays present in this section and in `core-exports.json`.

### Reading, random access, streams

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `openZip` | function | capability | `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip` (index pre-flight), `modify_zip` — every random-access tool, through `guard('Failed to open archive', …)` |
| `OpenZipOptions` | interface | capability | `inspect_zip.validate` (`'eager'` default) and `list_zip_entries.validate` (`'lazy'` default) → `validate`; `limits`, `strict`, `onDiagnostic` from the shared fragments |
| `ReadEntryOptions` | interface | capability | `read_zip_entry.verifyCrc` → `{ verifyCrc }` on `readEntry`; `{ verifyCrc: false }` on `readEntryStream` for a `range` |
| `ZipReader` | interface | capability | `entries()` (every read tool), `getEntry(name)` (`read_zip_entry.name`), `readEntry` / `readEntryStream` / `readEntryRaw` (`read_zip_entry` modes `data` / `range` / `raw`), `verifyEntry` (`read_zip_entry mode: 'verify'` → `verification`), `entryCount` / `isZip64` / `comment` (`inspect_zip`, `list_zip_entries`; `comment` → `comment` + `commentHex`). `bytes` is used only for `modify_zip.summary.noOp` (same-buffer identity) — **unexposed** as a field: it is the input itself |
| `iterateZipEntries` | function | capability | `scan_zip_forward` — the forward reader over the `ByteSource` built by `openArchiveSource` |
| `IterateZipOptions` | type | capability | `scan_zip_forward.limits` / `strict` + the diagnostics sink passed to `iterateZipEntries` |
| `StreamedZipEntry` | interface | capability | `scan_zip_forward`: `header` / `data()` (`data: 'verify' | 'include'`) / `skip()` (`data: 'none'`, filtered-out and directory entries) per local entry |
| `StreamedZipHeader` | interface | capability | `viewFromHeader()` in `src/entry.ts` — the `scan_zip_forward.entries[]` row (`isSymlink`, `usesZip64`, `unixMode` are `null`; `rawName` → `rawNameHex`; descriptor headers carry zero sizes) |
| `ByteSource` | type | capability | Built **internally** by `openArchiveSource` (`zipBase64` chunked from memory, `zipPath` streamed from disk in 64 KiB chunks) for `scan_zip_forward`, and by `fileChunks()` for `create_zip` `stream: true` entries. An external `ByteSource` / Web `ReadableStream` is **unexposed**: JSON-RPC has no stream channel |

### Extraction

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `extractZip` | function | capability | `extract_zip` base64 mode with `includeData: true` (the in-memory extractor; rows carry `dataBase64`) |
| `extractZipStream` | function | capability | `extract_zip` — the plan phase of base64 mode (`includeData: false` = dry run, nothing decompressed) and the whole of file mode (`stream()` per entry into the sandbox sink) |
| `sanitizeEntryPath` | function | capability | `sanitize_entry_paths.results[].sanitized`; `sanitizedPath` on every `EntryView` row (`list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`); `inspect_zip.unsafeNameCount`; the `skipped` list of `extract_zip rejectTraversal: false`; explicit directories under `emptyDirectories` |
| `ExtractOptions` | interface | capability | `extract_zip.rejectTraversal` / `rejectSymlinks` / `onDuplicate` / `filter` (→ `filter(entry)`) / `limits` / `strict` / `onDiagnostic` |
| `ExtractedEntry` | interface | capability | `extract_zip` base64 rows (`{ path, data, entry }` → `path`, `entryName`, `index`, `sizeBytes`, `crc32`, `method`, `dataBase64`) |
| `ExtractedStreamEntry` | interface | capability | `extract_zip` plan rows and file-mode rows (`{ path, entry, stream() }` → `filePath` after the streamed write) |

### Writing

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `createZip` | function | capability | `create_zip` (sequential writer; `toBytes()` in base64 mode, `stream()` in file mode or when an entry is streamed) |
| `ZipWriter` | interface | capability | `create_zip.entries[]` → `add` (`dataBase64` / `text` / `sourcePath`), `addDirectory` (`directory: true`), `addStream` (`stream: true`), `toBytes`, `stream({ chunkSize })`; the archive comment is expressed through `CreateZipOptions.comment` |
| `CreateZipOptions` | interface | capability | `create_zip.order` / `defaultDate` (ISO instant or `'now'`) / `compression` / `comment` / `limits` / `strict` / `onDiagnostic` |
| `AddEntryOptions` | interface | capability | Per entry on `create_zip.entries[]` and `modify_zip` `add` / `replace`: `compression`, `date`, `comment`, `externalAttributes` (raw uint32) or `unixMode` (`'0644'` → `(S_IFREG | mode) << 16`), `extraFields[] { id, dataBase64 }` (`toAddEntryOptions` in `src/entry-spec.ts`) |
| `ZipCompressionOptions` | interface | capability | `compression { method: 'store' | 'deflate', level 0–9, deterministic }` at archive level (`create_zip`, `modify_zip`) and per entry |
| `StreamOptions` | interface | capability | `create_zip.chunkSize` → `writer.stream({ chunkSize })` (file mode; 1 KiB … 16 MiB) |
| `createParallelZip` (`./worker`) | function | capability | `create_zip.parallel` → dynamic `import('zipnative/worker')`; byte-identical to `createZip` per tier |
| `ParallelZipOptions` (`./worker`) | interface | capability | `create_zip.parallel { workers (≤ ZIPNATIVE_MCP_WORKERS, `LIMIT_CEILING_EXCEEDED` above), minWorkerJobSize, jobTimeout }` + every `CreateZipOptions` field. `workerUrl` is **unexposed**: a filesystem / bundler path from a tool argument would point the worker at arbitrary code; the packaged worker resolves itself |
| `ParallelZipWriter` (`./worker`) | interface | capability | The `create_zip` writer under `parallel` (same `add` / `addDirectory` / `addStream` / `toBytes` / `stream` surface; `toBytes()` awaited); `summary.parallel { requested, workers }` |
| `ByteSource` (`./worker`) | type | type | The worker subpath re-exports the root declaration unchanged; the server imports `ByteSource` from the root entry only, so this row is a re-export alias, not a second touchpoint |
| `StreamOptions` (`./worker`) | interface | type | Same as the row above — the root `StreamOptions` is the one `create_zip.chunkSize` uses, also under `parallel` in file mode |

### Verification and modification

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `verifyZip` | function | capability | `verify_zip` — the report is returned verbatim (never `isError` for an archive problem) |
| `VerifyZipOptions` | interface | capability | `verify_zip.limits` → `{ limits }` |
| `ZipVerificationReport` | interface | capability | The `verify_zip` result body: `ok`, `error { code, message } | null`, `entryCount`, `entries`, `diagnostics` (plus the wrapper's `verifiedCount` / `failedCount` / `skippedCount` / `entriesTruncated`) |
| `VerifiedEntry` | interface | capability | `verify_zip.entries[]` (`name`, `ok`, `crcMatch`, `sizeMatch`, `localHeaderMatch`, `skipped?: 'encrypted' | 'stream-only-codec'`), selectable with `entries: 'all' | 'failed' | 'skipped' | 'none'` |
| `EntryVerification` | interface | capability | `read_zip_entry mode: 'verify'` → `verification { ok, crcMatch, sizeMatch, localHeaderMatch }` (base of `VerifiedEntry`) |
| `createZipModifier` | function | capability | `modify_zip` — over the opened reader; `save()` (`mode: 'append'`) / `saveCompact()` (`mode: 'compact'`) |
| `ZipModifier` | interface | capability | `modify_zip.operations[]` → `addEntry` (`add`, incl. `directory: true` as `name/` + empty payload), `replaceEntry` (`replace`), `removeEntry` (`remove`), `renameEntry` (`rename { from, to }`), `setComment` (`setComment { comment }`), `save` / `saveCompact` (`mode`). `reader` is **unexposed**: it is the input itself |
| `ZipModifierOptions` | interface | capability | `modify_zip.compression` / `defaultDate` (for new payloads) / `limits` / `strict` / `onDiagnostic` |

### Entry attributes, entries and shared types

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `getUnixMode` | function | capability | `unixMode` (four octal digits, or `null` for a non-Unix producer) on every central-directory `EntryView` row (`list_zip_entries`, `read_zip_entry.entry`, `extract_zip` planning) |
| `isSymlinkEntry` | function | capability | `isSymlink` on every `EntryView` row; `inspect_zip.symlinkCount` and `check: 'no-symlinks'` |
| `ZipEntry` | interface | capability | `viewFromEntry()` in `src/entry.ts` — the `EntryView` row (`rawName` → `rawNameHex`, raw `comment` → `commentHex`, `dosDate` / `dosTime`, `localHeaderOffset`, `versionMadeBy` → `hostSystem`, …); `inspect_zip` statistics and determinism verdict; `read_zip_entry` / `extract_zip` / `modify_zip` planning |
| `ZipExtraField` | interface | capability | Read: `extraFields[] { id, idHex, name, length, dataBase64? }` on `EntryView` rows (`list_zip_entries.includeExtraData` adds the payload); write: `extraFields[] { id, dataBase64 }` on `create_zip` entries and `modify_zip` add / replace (`toExtraFields`; id `0x0001` refused) |
| `ZipCommonOptions` | interface | capability | `strict` and `limits` on every engine-touching tool (`EngineOptionsShape`). `onDiagnostic` is **unexposed** as an input: the server always installs its own sink so every result carries `diagnostics[]` |
| `ZipDiagnostic` | interface | capability | `createDiagnosticSink()` converts each one to a `DiagnosticRow { code, severity, message, entryName? }` (de-duplicated by code + entry, capped at 200) |
| `ZipDiagnosticCode` | type | capability | The 11-code vocabulary in `ZIP_DIAGNOSTIC_CODES` (`src/zip-errors.ts`) → `describe_engine.diagnosticCodes`; `diagnostics[].code` on every result; `inspect_zip.prependedData` / `multipleEocd` derived from two of them |
| `ZipDiagnosticHandler` | type | capability | The sink's `onDiagnostic` |
| `ZipLimits` | interface | capability | The `limits` input on every engine-touching tool (`LIMITS_INPUT_SCHEMA`, eight keys); `describe_engine.defaultLimits`; the operator ceilings bound `maxEntries` / `maxEntryUncompressedSize` / `maxTotalUncompressedSize` |
| `DEFAULT_ZIP_LIMITS` | const | capability | `describe_engine.defaultLimits`; the baseline `resolveCallLimits` / `effectiveLimits` merge over; quoted in the `limits` description |

### Errors

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `ZipError` | class | capability | `mapZipError()` — the `instanceof` root; `err.code` → `ToolError.code` verbatim, `err.name` → `_meta.error.data.engineError` |
| `ZipFormatError` | class | capability | → `_meta.error.data.errorClass: 'parse'` (or `'input'` for the two entry-name codes) |
| `ZipSecurityError` | class | capability | → `errorClass: 'security'`; supplies `entryName` |
| `ZipDataError` | class | capability | → `errorClass: 'data'`; supplies `entryName` and `{ expectedCrc, actualCrc }` (8-hex) |
| `ZipLimitError` | class | capability | → `errorClass: 'limit'` (`ZIP_LIMIT_INVALID`: `'usage'`); supplies `{ limit, configured, observed }` |
| `ZipUnsupportedError` | class | capability | → `errorClass: 'unsupported'`; supplies `{ feature }` |
| `ZipErrorCode` | type | type | `ZIP_ERROR_CLASS satisfies Record<ZipErrorCode, …>` — a compile-time guard: a new engine code fails `tsc` (the codes themselves reach `_meta.error.code` and `describe_engine.errorCodes`) |
| `ZipBaseErrorCode` | type | type | The 7 base-code rows of `ZIP_ERROR_CLASS` (`ZIP_API_MISUSE` and `ZIP_INTERNAL` unreachable by design; `ZIP_INPUT_TOO_LARGE` needs > 2 GiB in one deflate call, above the inline caps) |
| `ZipFormatErrorCode` | type | type | The 13 format-code rows (all reachable through the hostile fixtures) |
| `ZipSecurityErrorCode` | type | type | The 6 security-code rows (all reachable) |
| `ZipDataErrorCode` | type | type | The 5 data-code rows (all reachable) |
| `ZipLimitErrorCode` | type | type | The 2 limit-code rows (`ZIP_LIMIT_INVALID` pre-empted by the Zod `limits` schema) |
| `ZipUnsupportedErrorCode` | type | type | The 6 unsupported-code rows (`ZIP_UNSUPPORTED_ZIP64_STREAMING` needs a streamed `sourcePath` > 4 GiB) |
| `ZipUnsupportedFeature` | type | capability | `_meta.error.data.feature` (`zipcrypto`, `strong-encryption`, `multi-disk`, `zip64-streaming`, `cd-less-descriptor`, `method:<n>`) |

### Codecs, checksums, constants, metadata

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `crc32` | function | capability | `compute_crc32` (chained over 1 MiB chunks with `seed`; `expect` → `matches`) |
| `createInflator` | function | capability | `inflate_raw` (`method: 'deflate'`, the resumable bounded path fed in 64 KiB chunks) |
| `Inflator` | interface | capability | `push()` / `finished` / `leftover` / `bytesConsumed` / `end()` in `inflate_raw` → `summary.bytesConsumed` / `leftover` / `finished` |
| `getCodec` | function | capability | `inflate_raw` numeric `method` (`decompressSync`), `methodName()` on every `EntryView` row, `describe_engine.codecs[] { sync, stream }` |
| `registerCodec` | function | unexposed | A codec is executable code; JSON cannot carry one and zipnative ships no extra codec by policy — `inflate_raw` with a method beyond 0 / 8 answers `ZIP_UNSUPPORTED_METHOD` |
| `ZipCodec` | interface | unexposed | The codec contract (same reason); the built-in store / deflate codecs are visible through `describe_engine.codecs` |
| `CodecCompressOptions` | interface | unexposed | Only handed to an injected codec's `compressSync`; no codec can be injected |
| `setDeflateImpl` | function | unexposed | Runtime code injection; the server owns tier selection and reports it (`summary.deflateTier`, `describe_engine.engine.deflateTier`) |
| `setInflateImpl` | function | unexposed | Same — the reader paths run on the tier `initNodeZipCodecs` selected |
| `initNodeZipCodecs` | function | unexposed | A startup concern, not a tool input: `ensureEngineReady()` (`src/engine.ts`) calls it once before serving so every sync codec path — the worker pool included — runs on the `node-zlib` tier |
| `activeDeflateTier` | function | capability | `create_zip.summary.deflateTier` (`activeDeflateTier(compression.deterministic === true)`); `describe_engine.engine.deflateTier { default, deterministic }` |
| `DeflateTier` | type | capability | The value set of those two fields (`pure-pinned` \| `node-zlib` \| `injected` \| `pure`; `injected` never occurs in this server) |
| `METHOD_STORE` / `METHOD_DEFLATE` | const | capability | `methodName()`, `inspect_zip check: 'store-only' / 'deflate-only'` and `assert.method`, `inflate_raw.method` (`'store'` / `'deflate'`), `describe_engine.codecs` |
| `FLAG_DATA_DESCRIPTOR` / `FLAG_ENCRYPTED` / `FLAG_STRONG_ENCRYPTION` / `FLAG_UTF8` | const | capability | `decodeFlags()` → `flags { encrypted, dataDescriptor, strongEncryption, utf8 }` on every `EntryView` row; `inspect_zip.determinism.utf8Flags`; forward `usesDataDescriptor` |
| `VERSION` | const | capability | `describe_engine.engine.version`; `serverInfo.instructions` and `__serverMetadata.engineVersion`; the cache key namespace (`CACHE_API_VERSION`); `tests/docs-consistency.test.ts` pins `docs/data/*.json` `zipnativeVersion` to it |

---

## 9. Transport & Environment

Two transports. Default = stdio. Set `ZIPNATIVE_MCP_PORT` to expose a Streamable HTTP endpoint on `http://127.0.0.1:<port>/mcp` instead.

> **MCP protocol version.** The server is built on the MCP TypeScript SDK v2
> (`@modelcontextprotocol/server` ^2.0.0) and speaks **MCP 2026-07-28**: stateless serving
> (`server/discover` instead of a session handshake; over HTTP a fresh `Server` per request),
> `resultType` on every result, `ttlMs` / `cacheScope` cache hints (`SERVER_CACHE_HINTS`), the
> `_meta` `serverInfo` envelope, `Mcp-Method` / `Mcp-Name` headers on HTTP, and resource-not-found
> reported as `-32602`. Clients that open with `initialize` (`2025-11-25`, `2025-06-18`,
> `2025-03-26`) are served by the SDK's automatic legacy fallback (`legacy: 'serve'` on stdio,
> `legacy: 'stateless'` on HTTP), so Claude Desktop, Cursor, Continue, Zed, ChatGPT and other
> existing hosts work unchanged. HTTP `GET` / `DELETE` answer 405 (no SSE resumability); any path
> other than `/mcp` is 404; a body above 256 MiB is 413. The low-level `Server` +
> `setRequestHandler` surface is used deliberately: `McpServer.registerTool` would require
> Standard-Schema inputs and validate `structuredContent` against `outputSchema`, breaking the
> hand-written JSON Schemas, the `verbosity` / `fields` projections and the `isError` contract.
> The stdio transport raises the SDK's default 10 MiB frame cap to `STDIO_MAX_FRAME_BYTES`
> (256 MiB) so multi-MiB base64 archives fit in one frame. On stdio, a request sent before the
> opening exchange is dropped, and JSON-RPC batch arrays are not accepted (they are over HTTP).

| Variable | Required | Description |
|----------|----------|-------------|
| `ZIPNATIVE_MCP_OUTPUT_DIR` | No | Absolute path of the sandbox: the only directory the server reads (`zipPath`, `sourcePath`) or writes (`outputMode: 'file'`, `outputDir`, drafts). Unset = every file input and output disabled; base64 only. |
| `ZIPNATIVE_MCP_CACHE_DIR` | No | Absolute path for the opt-in response cache (§6). Unset = disabled. |
| `ZIPNATIVE_MCP_PORT` | No | When set to a valid port (1–65535), switches the transport to Streamable HTTP on `127.0.0.1`. Unset = stdio. |
| `ZIPNATIVE_MCP_HTTP_TOKEN` | No | HTTP only, **secret**. Bearer token (≥ 16 chars, no whitespace; a weaker value aborts startup). When set, every `/mcp` request must carry `Authorization: Bearer <token>` or gets 401 + `WWW-Authenticate: Bearer realm="zipnative-mcp"` (`, error="invalid_token"` only when credentials were sent — RFC 6750 §3.1) with a JSON-RPC `-32600` body; compared constant-time (SHA-256 + `timingSafeEqual`), never logged. Unset = no authentication (loopback bind + Host / Origin guard only). |
| `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` | No | Operator ceiling (default 8 GiB = the engine default, minimum 1024) for `limits.maxEntryUncompressedSize` and `limits.maxTotalUncompressedSize`. A ceiling below the engine default tightens the default silently. Read once at boot; an invalid value refuses to start. |
| `ZIPNATIVE_MCP_MAX_ENTRIES` | No | Operator ceiling (default 100 000, minimum 1) for `limits.maxEntries` and `scan_zip_forward.maxEntries`. |
| `ZIPNATIVE_MCP_WORKERS` | No | Operator ceiling (default 8, minimum 0) for `create_zip.parallel.workers`; `0` disables worker threads (every `parallel` request runs on the calling thread). |

### Privacy & data handling

- **No telemetry; no network egress, ever.** There is no network code path in the server — no `fetch`, no socket other than the opt-in loopback HTTP listener itself. Archive bytes never leave the process except in the JSON-RPC response to the caller (or into the sandbox the operator configured). `describe_engine.network` is the constant `'none'`; every tool advertises `openWorldHint: false`.
- **Transit.** stdio (default) is a local pipe to the parent process. The opt-in HTTP transport binds **`127.0.0.1`** only **and** enables the SDK's DNS-rebinding protection: `Host` and `Origin` are pinned to the loopback authority, so a web page that reaches the port via a rebound DNS name is rejected with 403; the SDK's Origin check is port-agnostic, so `src/http.ts` additionally requires the `Origin` port to equal the server port. Without `ZIPNATIVE_MCP_HTTP_TOKEN` the endpoint has **no authentication** — any local process can reach it — so set the token whenever that matters. Client-disconnect detection hangs off the per-request response, so keep-alive connections do not accumulate listeners. Terminate TLS in a reverse proxy if you expose it beyond localhost.
- **Extracted content is passed through verbatim.** The server does not execute, render or scan extracted files. Treat content from an untrusted archive as untrusted in the caller.
- **No secret retention.** `ZIPNATIVE_MCP_HTTP_TOKEN` is never logged or echoed; the engine holds no key material (no encryption in 1.x). The response cache stores tool output as plaintext at rest — protect `ZIPNATIVE_MCP_CACHE_DIR` like the sandbox.
- **The engine never touches the filesystem or a socket**; the server's only filesystem access is the sandbox (§5).

---

## 10. Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `MY_TOOL_NAME`, `MY_TOOL_INPUT_SCHEMA` (hand-written JSON Schema `as const`, `additionalProperties: false`), optionally `MY_TOOL_OUTPUT_SCHEMA` (+ `MY_TOOL_SUMMARY_PROPERTIES` and a `mySummary()` for a read tool), a Zod `.strictObject` twin, and `myTool(args: unknown): Promise<MyResult>`. Reuse the shared fragments (`ARCHIVE_INPUT_PROPERTIES` / `ARCHIVE_INPUT_SHAPE` + `refineArchiveInput`, `LIMITS_INPUT_SCHEMA`, `FILTER_INPUT_SCHEMA`, `PROJECTION_INPUT_PROPERTIES` / `ProjectionShape`, `OUTPUT_INPUT_PROPERTIES`). Wrap every engine call in `guard` / `guardAsync`; install a diagnostic sink; go through `loadArchive` / `resolveInputFile` / `emitArchive` for every byte in and out — never touch the filesystem directly.
2. Register in [src/server.ts](../src/server.ts): the `TOOLS` array (`kind` — add a `dispatchOutput` branch if none fits, `title`, `description`, `annotations`, ≤ 2 executable `examples`), the `ToolOutput` union, and the `SERVER_INSTRUCTIONS` decision tree.
3. Add `tests/<tool-name>.test.ts`: happy path (base64), file mode, every error code the tool raises, the hostile fixtures it must refuse; every archive it produces must pass `assertValidZip` (`tests/_zip-assert.ts` — ISO conformance included). Add a corpus entry in `scripts/generate-zip-corpus.mjs` if the tool writes archives.
4. Refresh the catalogue fingerprint (`npm run build && node scripts/tool-shape.mjs --write`) so `tests/catalogue-parity.test.ts` passes, and review the structural diff under `API_STABILITY.md` §5 (a new tool is a minor). Never regenerate `tests/_fixtures/tool-shape.v1.0.0.json`.
5. Update this document (§2 tree, §4, §8 if a new engine export is touched — and `docs/data/core-exports.json` with it), [`AI_GUIDE.md`](AI_GUIDE.md), the README matrix and tool reference, `AGENTS.md` (catalogue, decision tree, §6 for every new error code), `llms.txt`, `server.json`, `API_STABILITY.md` §5, a worked example under `examples/`, and `CHANGELOG.md` `[Unreleased]`. `tests/docs-consistency.test.ts` enforces the counts.
6. Decide whether the change bumps `_meta.apiVersion` — see [`API_STABILITY.md`](API_STABILITY.md).

---

## 11. Development Quick Reference

```bash
npm install
npm run typecheck:all
npm run lint              # eslint src --max-warnings 0
npm run test
npm run test:coverage     # thresholds 94 / 90 / 95 / 94 (vitest.config.ts)
npm run build             # tsc -p tsconfig.build.json → dist/
npm run examples:check    # tests/examples.test.ts only
npm run validate:zip      # build + corpus:zip + veraZIP (level 0 always; level 1 with the foreign tools present)
npm run verify:issue -- <draft.md>
node scripts/tool-shape.mjs --write   # refresh the catalogue fixture after a deliberate schema change
```

CI (`ci.yml`) runs the gate on Linux (Node 22 / 24) and Windows (Node 22); `verazip.yml` runs the conformance gate on Linux **and** Windows with `VERAZIP_REQUIRED=1` and is **blocking**; `publish.yml` re-runs everything (veraZIP included) between the GitHub Release and `npm publish --provenance`. Full local workflow: [`guides/LOCAL_TESTING.md`](guides/LOCAL_TESTING.md).

---

## 12. Security Design Notes

- **One filesystem boundary** — `src/sandbox.ts`: reads and writes resolve against `ZIPNATIVE_MCP_OUTPUT_DIR`; relative paths only; NUL, absolute, UNC and `..` rejected; container-extension allow-list on archive paths; realpath re-check on every parent after `mkdir -p`; `wx` opens (never overwrite); partial files removed on failure; absolute paths never leak into messages. Unset sandbox = no file I/O at all.
- **Engine defaults never weakened** — `rejectTraversal`, `rejectSymlinks`, `onDuplicate: 'error'` and the `ZipLimits` bounds are the engine's; opt-outs are named inputs that *skip* (unsafe names) or *degrade to data* (symlink targets), never write anything unsafe; overlap and central/local divergence have no opt-out. The engine's sanitized path is the only thing ever joined onto a directory.
- **Limits under ceilings** — `limits.*` per call, capped by the three operator ceilings (`LIMIT_CEILING_EXCEEDED` names the variable); the engine enforces sizes and ratios while inflating (CWE-400 / CWE-409).
- **Memory envelope** — every inline byte counted (`src/caps.ts`): 128 MiB decoded input, 16 MiB per inline entry, 32 MiB per inline extraction, 50 MiB per inline output, 1 GiB buffered path input, 4 GiB streamed file output, 256 MiB frame / body; JSON-shaped inputs bounded (entries, operations, names, globs, extra fields, fields paths); diagnostics capped at 200 per result.
- **Input validation** — strict Zod at every boundary (unknown keys rejected); base64 diagnosed before the engine sees it; dates bounded to the DOS range; extra field `0x0001` refused; `maxOutput` mandatory on `inflate_raw`.
- **No network** — no network code path; `openWorldHint: false` on every tool; `draft_governance_issue` never submits.
- **HTTP hardening** — loopback bind, Host / Origin guard with the Origin port pinned, 405 on GET / DELETE, 413 above 256 MiB, opt-in constant-time bearer token, per-response disconnect detection.
- **Cache hygiene** — path inputs, file mode, wall-clock and worker calls, `describe_engine` and `draft_governance_issue` are never cached; the key is namespaced by tool API + package + engine version.
- **Diagnostics never on stdout** — the sink is always installed, so the engine's `console.warn` fallback cannot corrupt the stdio wire.
- **Configuration errors fail loud** — a weak token or an invalid ceiling prints one clean `fatal:` line and exits 1; never a silent fallback.
- **Strict TypeScript** — `strict: true`, no `any`, `unknown` + narrowing, explicit return types on exports; ESLint with zero warnings.
- **Conformance is not safety** — every archive the server writes passes the ISO/IEC 21320-1 validator, and the hostile-but-conformant corpus entries (zip-slip, device name, duplicate paths) are exactly why the guards above exist on top of it.

See [`guides/SECURITY.md`](guides/SECURITY.md) for the threat table with CWE ids, [`guides/DETERMINISM.md`](guides/DETERMINISM.md), [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md), [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md) and [`AI_GUIDE.md`](AI_GUIDE.md) for usage-oriented notes.
