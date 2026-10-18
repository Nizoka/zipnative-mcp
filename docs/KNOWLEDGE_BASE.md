# zipnative-mcp — Knowledge Base

> Reference for AI assistants (GitHub Copilot, Claude, Cursor, Continue, Zed, Windsurf, Cline, Roo Code)
> and human contributors. Captures the full context needed to understand, extend, and debug
> zipnative-mcp **v1.1.0** without reading every source file.
>
> Verified on 2026-10-18 against zipnative-mcp 1.1.0 and zipnative 1.1.0: 15 tools, 7 prompts, 17 wrapper codes,
> 39 frozen `ZIP_*` codes, 12 diagnostic codes, 9 `ZipLimits` keys, 8 environment variables, 106 exports in the
> coverage ledger. Every count quoted here comes from [`assets/ecosystem.json`](assets/ecosystem.json) and is held
> to it by `npm run verify:docs`.

> If you are an AI agent calling zipnative-mcp from a chat session, also read
> [`AI_GUIDE.md`](AI_GUIDE.md) — the short, action-oriented decision tree.

---

## 1. Context

**What is zipnative-mcp?**
An MCP (Model Context Protocol) server that bridges the zero-dependency
[`zipnative`](https://github.com/Nizoka/zipnative) ZIP engine (v1.1.x — 106 exports across its two entry
points, 39 frozen error codes, a frozen `deterministic: true` byte contract) to AI clients (Claude Desktop,
ChatGPT, Cursor, Continue, Zed, Windsurf, Cline, Roo Code, …). It exposes **15** tools over a stdio (or
loopback Streamable HTTP) transport so AI agents can **inspect** and **list** archives without
extracting, **read** single entries by random access (in memory, or by byte ranges for archives above the
1 GiB in-memory cap), **verify** integrity in one call, **extract** with every security guard on by
default, **scan** truncated or unseekable streams forward, **sanitize** entry paths for their own sinks,
**create** deterministic, reproducible archives (store / deflate, worker-parallel, streamed sources, Zip64
streaming on request), **modify** archives incrementally without recompression, **canonicalize** any
archive into the engine's canonical deterministic form, **merge** several archives without recompression,
compute **CRC-32**, **inflate** raw DEFLATE under a mandatory bound, **describe** the engine and server
capabilities offline, and **draft** governance-compliant GitHub issues for human review. Files written in
the sandbox are exposed as native MCP resources. Long calls honour MCP cancellation and report progress — every tool whose work scales with its input, except `verify_zip` (the engine's `verifyZip` takes no signal).

**Philosophy:**
- Three runtime dependencies (`zipnative`, the MCP SDK `@modelcontextprotocol/server`, `zod`) — every byte of ZIP structure belongs to `zipnative`; the server never parses a `PK` signature (the vendored conformance validator in `scripts/verazip-core.mjs` and the test-only raw builder are the sanctioned exceptions, outside `src/`).
- A faithful, thin, secure dispatch layer: validate inputs with strict Zod → call the engine → shape the result → emit bytes as an embedded resource or into the sandbox.
- Engine security defaults stay on; every relaxation is a named input; `limits` can never exceed operator ceilings.
- **No network, ever** — there is no network code path in the server. No telemetry, no GitHub, no URL from any argument; the byte-range reader is fed by a sandbox file's own handle, never by a remote source.
- Every tool is self-contained (its own file in [src/tools/](../src/tools)), ships `_meta.apiVersion = '1.1.0'` and ≤ 2 executable `_meta.examples` (the rest live in `examples/*.json`) — see [`API_STABILITY.md`](API_STABILITY.md).
- Honest envelopes: what the server reports (`summary.deflateTier`, `summary.deterministic`, `summary.canonicalForm`, `trust`, `crcVerified`, `skipped`, `access`) is what the engine did.
- Every archive the server writes is ISO/IEC 21320-1:2015 conformant, validated in CI by an engine-independent validator ("veraZIP", [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md)).

**Runtime:** Node.js ≥ 22 (ESM, strict TypeScript). Transport: stdio (default) or Streamable HTTP. Protocol: MCP 2026-07-28 with automatic legacy fallback (2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25).

**Repositories**
- MCP server: <https://github.com/Nizoka/zipnative-mcp>
- Engine: <https://github.com/Nizoka/zipnative> — docs at <https://zipnative.dev>
- CLI companion: <https://github.com/Nizoka/zipnative-cli>
- npm: <https://www.npmjs.com/package/zipnative-mcp>

---

## 2. Architecture

```
src/
├── cli.ts             # Entry point: ensureEngineReady() + the four ceilings read once; port / sandbox validated; stdio (serveStdio) or HTTP; signals
├── http.ts            # node:http <-> web Request/Response bridge, 256 MiB body cap (413), Host/Origin loopback guard + Origin port pin,
│                      #   server timeouts + header-count bound, nosniff / no-store on every response
├── auth.ts            # opt-in HTTP bearer token (ZIPNATIVE_MCP_HTTP_TOKEN), constant-time compare, RFC 6750 401 challenge
├── server.ts          # createServer(): TOOLS registry (kind, schemas, annotations, examples), SERVER_INSTRUCTIONS, PROMPTS, cache hints,
│                      #   callToolDirect (cache → handler → dispatchOutput by kind → projection), the coded error boundary, resources/prompts handlers
├── call-context.ts    # CallContext { signal, onProgress }: CANCELLED (cancelledError / throwIfCancelled), progressReporter (notifications/progress)
├── version.ts         # ZIPNATIVE_MCP_VERSION + TOOL_API_VERSION (both '1.1.0')
├── errors.ts          # ToolError(code, message, data?) + SecurityError + GovernanceError; redactAbsolutePaths
├── wrapper-codes.ts   # the 17 wrapper codes with meaning and remedy (one table for the docs and the tests)
├── caps.ts            # every byte / count cap + the four operator ceilings (readCeilings / getCeilings)
├── limits.ts          # the `limits` fragment (nine ZipLimits keys) → resolveCallLimits (LIMIT_CEILING_EXCEEDED) / effectiveLimits
├── base64.ts          # decodeBase64Field / decodeZipBase64 (data: prefix tolerated; PEM / nested URI / double-encoding hints) / encodeBase64
├── sandbox.ts         # THE filesystem boundary: ZIPNATIVE_MCP_OUTPUT_DIR, ZIP_CONTAINER_EXTENSIONS, openInputFile / readInputFile (one handle per read),
│                      #   resolveOutputFile / resolveOutputDir, assertRealpathInside, writeExclusive / openExclusiveWriteStream (wx), discardPartial
├── archive-input.ts   # zipBase64 XOR zipPath: loadArchive (buffered), openArchive (access auto | memory | range), openArchiveSource (scanner), isPathInput
├── canonical.ts       # the canonical options shared by canonicalize_zip and modify_zip `canonical` → zipnative CanonicalOptions
├── entry-spec.ts      # create/modify entry payloads: compression, dates (DOS range, read as UTC), unixMode → externalAttributesFromUnixMode, extraFields, loadPayload
├── entry.ts           # EntryView (the shared per-entry JSON row): viewFromEntry / viewFromHeader, decodeFlags, methodName, crcHex, ENTRY_VIEW_SCHEMA
├── filter.ts          # compileGlob (linear-time token NFA, ≤ 1024 chars) / compileEntryFilter (names, prefix, glob, includeDirectories)
├── diagnostics.ts     # createDiagnosticSink: onDiagnostic → DiagnosticRow[] (dedup by code+entry, cap 200), counts, strict,
│                      #   dosTimeMode 'utc', and the call's signal / onProgress handed to every engine call taking them (not verifyZip)
├── zip-errors.ts      # mapZipError / guard / guardAsync — the ONLY place that reads err.code; ZIP_ERROR_CLASS (39), ZIP_DIAGNOSTIC_CODES (12)
├── engine.ts          # ensureEngineReady() (memoised initNodeZipCodecs), probeRuntime()
├── output.ts          # emitArchive (base64 ≤ 50 MiB | exclusive file ≤ the file-output ceiling), emitArchiveStream, writeSandboxedText (.md)
├── resources.ts       # zipnative://output/{+path}: listResources (walk ≤ 8 deep, ≤ 1000), readResource (≤ 50 MiB), MIME by extension
├── projection.ts      # token-frugal verbosity / fields projection (own properties only; prototype segments refused)
├── governance.ts      # AI-governance contract: validateIssueMarkdown (linear-time patterns), IDENTITY_REMINDER, HUMAN_GATE, prompt copy
├── cache.ts           # opt-in content-addressed response cache (ZIPNATIVE_MCP_CACHE_DIR; 1 h TTL; 256 MiB, oldest written evicted first)
├── index.ts           # library entry: createServer, ensureEngineReady, callToolDirect, listToolsPayload, ToolError types
└── tools/
    ├── _shared.ts                 # ProjectionShape, EngineOptionsShape (strict, limits), STRICT_INPUT_PROPERTY, parseInput, sha256Hex
    ├── inspect-zip.ts             # inspect_zip — eager open, stats, determinism from analyzeDeterminism, determinismReport, check[] / assert
    ├── list-zip-entries.ts        # list_zip_entries — paged EntryView inventory (memory or byte ranges)
    ├── read-zip-entry.ts          # read_zip_entry — readEntry / readEntryStream (range) / readEntryRaw / verifyEntry (memory or byte ranges)
    ├── verify-zip.ts              # verify_zip — verifyZip report, counted by the engine's archive rule, never isError for archive problems
    ├── extract-zip.ts             # extract_zip — extractZip (inline) / extractZipStream (plan + file mode), sandbox sink
    ├── scan-zip-forward.ts        # scan_zip_forward — iterateZipEntries over a ByteSource, tolerateTruncation
    ├── sanitize-entry-paths.ts    # sanitize_entry_paths — sanitizeEntryPath + reason re-derivation
    ├── create-zip.ts              # create_zip — createZip / createParallelZip, add / addDirectory / addStream (zip64 opt-in), toBytes / stream
    ├── modify-zip.ts              # modify_zip — eager open, createZipModifier, save (append) / saveCompact (compact, canonical)
    ├── canonicalize-zip.ts        # canonicalize_zip — canonicalizeZip, verdict re-checked with analyzeDeterminism
    ├── merge-zip.ts               # merge_zip — ZipWriter.addFromReader over 1–32 sources, onConflict, verify
    ├── compute-crc32.ts           # compute_crc32 — crc32 chained over 1 MiB chunks
    ├── inflate-raw.ts             # inflate_raw — createInflator (resumable, bounded) / store pass-through / codec.decompressSync
    ├── describe-engine.ts         # describe_engine — capability manifest incl. UNEXPOSED_EXPORTS
    └── draft-governance-issue.ts  # draft_governance_issue — local HITL draft + compliance report

scripts/
├── gate.ts                    # the quality gate: fast / ci / publish profiles, --require-all (npm run gate, npm run gate:fast)
├── tool-shape.ts              # structural fingerprint of tools/list (--write / --check / --stats) → tests/_fixtures/tool-shape.json
├── verify-docs.ts             # 28 offline documentation rules over docs/assets/ecosystem.json (npm run verify:docs)
├── release-prepare.ts         # one-pass version bump of every reference (npm run release:prepare)
├── generate-samples.ts        # every examples/*.json through the built server, hermetic (npm run test:generate)
├── verify-samples.ts          # the samples against tests/_fixtures/samples.sha256.json (npm run verify:samples)
├── verify-issue.mjs           # CLI twin of validateIssueMarkdown (npm run verify:issue)
├── verazip-core.mjs (+ .d.mts) # the vendored ISO/IEC 21320-1 validator core (validateArchive, CHECK_IDS (23), REQUIRED_NEGATIVE_CHECKS (4))
├── generate-zip-corpus.mjs    # drives the tool handlers + the raw builder → test-output/zip/ + manifest.json (npm run corpus:zip)
├── validate-zip.mjs           # veraZIP driver: level 0 (ISO profile) + level 1 (foreign integrity tools) over the corpus
├── build-claude-rules.ts      # renders .github/instructions/ into .claude/rules/ (npm run agents:rules)
├── install-git-hooks.mjs      # opt-in .githooks/ pre-commit / pre-push (npm run hooks:install)
├── lib/                       # shared tooling: mcp-surface, tool-shape, example-runner, sample-fingerprint, markdown-anchors, prose-language, …
└── helpers/                   # zip-corpus.mjs (the corpus definition), raw-zip-builder.mjs, interop-tools.mjs, hermetic.ts, io.ts, server.ts, tz.ts

tests/                          # vitest (globals: false); one tests/<name>.test.ts per tool / module; _-prefixed shared fixtures
├── _mcp-harness.ts             # in-memory legacy-handshake client (connectLegacy, McpRpcError); captures notifications
├── _http-fixture.ts            # loopback HTTP fixture (2026-07-28 envelope + legacy initialize)
├── _agent-client.ts            # the scripted MCP client of the autonomy scenario (stdio / HTTP × legacy / modern)
├── _sandbox.ts                 # temporary-sandbox helper for file-mode tests
├── _fuzz.ts                    # the seeded fuzz helpers behind tests/zip-fuzz.test.ts
├── _zip-fixtures.ts            # benign fixtures (basicZip, richZip, highRatioZip, streamedZip, incrementalZip, zip64ManyEntries)
│                               #   + hostile ones built in-test (ZIP_SLIP, DEVICE_NAME, OVERLAP, CD_MISMATCH, DECLARED_BOMB, …)
├── _zip-assert.ts              # assertValidZip (PK magic + eager open + verifyZip ok + ISO conformance), assertIsoConformant, expectCheck
├── _fixtures/                  # raw-zip-builder.ts, tool-shape.json (parity), tool-shape.v1.0.0.json (frozen), samples.sha256.json,
│                               #   server.schema.2025-12-11.json (the vendored MCP registry schema)
├── tools/                      # the tooling suites: gate, verify-docs, tool-shape, release-prepare, workflows, guard, agent-config, …
└── fixtures/                   # interop/ (bsdtar, PowerShell Compress-Archive), examples/ (the frozen example inputs), SHA256SUMS, PROVENANCE.md
```

Catalogue gates: `scripts/tool-shape.ts` computes a structural fingerprint of `tools/list` (description strings stripped; `--write` refreshes `tests/_fixtures/tool-shape.json`, `--check` compares, `--stats` prints the sizes) and `tests/catalogue-parity.test.ts` fails on any structural drift (types, enums, defaults, constraints, `required`, `additionalProperties`, example count). Wording — descriptions, examples, `SERVER_INSTRUCTIONS` — may change freely; a structural change needs a deliberate fixture refresh reviewed under `API_STABILITY.md` §5. The published 1.0.0 catalogue is frozen as `tests/_fixtures/tool-shape.v1.0.0.json`, and `tests/catalogue-superset.test.ts` holds every later catalogue to it: no tool, input property, enum value or default removed, nothing made required, no bound tightened, no annotation flipped — except the reviewed deltas it lists (`ACCEPTED_DELTAS`, declared in `API_STABILITY.md` §2). `scripts/verify-docs.ts` holds the counts, tool / error / environment parity, links, anchors and stamps of the documentation to `docs/assets/ecosystem.json` and the source tree, and `tests/docs-consistency.test.ts` pins the counts and names quoted across README, AGENTS.md, `llms.txt`, `server.json`, `CITATION.cff`, `CLAUDE.md` and `docs/data/*.json` to the code (the 106-export ledger in §8 with its 88 / 9 / 9 reach counts, every `UNEXPOSED_EXPORTS` entry graded unexposed, the `zipnativeVersion` pins, the veraZIP corpus counts against `docs/data/verazip.json`). `tests/schema-lockstep.test.ts` compares `z.toJSONSchema` of every Zod input schema with the advertised `inputSchema` (keys, `required`, enums, defaults, bounds, `pattern`s) so the two hand-kept schemas cannot drift.

Catalogue size: `tools/list` is ≈ 118944 bytes and `SERVER_INSTRUCTIONS` ≈ 5954 bytes (re-measured with `npx tsx scripts/tool-shape.ts --stats`, which prints the `tools/list` bytes, the `SERVER_INSTRUCTIONS` bytes and the tool / prompt / `ZIP_*` code / diagnostic counts). The schemas use no `$ref` / `$defs` (some hosts forward `inputSchema` to function-calling APIs that reject references) and no `$schema` keyword (MCP ≥ 2025-11-25 defaults to JSON Schema 2020-12); the shared fragments (`ARCHIVE_INPUT_PROPERTIES`, `ACCESS_INPUT_PROPERTY`, `FILTER_INPUT_SCHEMA`, `LIMITS_INPUT_SCHEMA`, `ENTRY_VIEW_SCHEMA`, `ENTRY_PAYLOAD_PROPERTIES`, `CANONICAL_OPTION_PROPERTIES`, `DIAGNOSTICS_OUTPUT_PROPERTIES`, `PROJECTION_INPUT_PROPERTIES`) are therefore repeated inline per tool.

### Request Dispatch Flow

```
AI client (Claude / Cursor / Copilot / etc.)
    │  MCP JSON-RPC over stdio (frame ≤ 256 MiB), or POST /mcp (Streamable HTTP, body ≤ 256 MiB)
    ▼
src/cli.ts
  ensureEngineReady()   ← initNodeZipCodecs() awaited once (node:zlib tier for every sync codec path, incl. the worker pool)
  getCeilings()         ← ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES / _MAX_ENTRIES / _WORKERS / _MAX_FILE_OUTPUT_BYTES read once; invalid → one `fatal:` line, exit 1
                          (so does a ZIPNATIVE_MCP_PORT outside 1..65535 or a relative ZIPNATIVE_MCP_OUTPUT_DIR)
  stdio: serveStdio(createServer, { legacy: 'serve', transport: StdioServerTransport({ maxBufferSize: 256 MiB }) })  ← one Server per process
  HTTP : guardLoopback → guardBearer → createMcpHandler(createServer, { legacy: 'stateless' })                       ← fresh Server per request
    │
    ▼
src/server.ts  (createServer)
  tools/list        → TOOLS registry → JSON schemas + annotations + _meta { apiVersion, examples }; cache hint public / 24 h
  tools/call        → callToolDirect(name, args, context { signal, onProgress? }) → server.projectCallToolResult(result, outputSchema)
                      unknown tool name → JSON-RPC −32602 `[UNKNOWN_TOOL] Unknown tool: <name>` (protocol error, not isError)
  prompts/list|get  → PROMPTS (governance_contract, draft_issue_workflow, secure_extraction, reproducible_archive, incremental_update,
                      forensic_scan, verify_before_trust); unknown → −32602 `[UNKNOWN_PROMPT]`
  resources/*       → src/resources.ts (private, ttlMs 0); template zipnative://output/{+path}; unknown URI → UNKNOWN_RESOURCE (−32602)
  server/discover   → SDK-generated (versions, capabilities, instructions, cache hint public / 1 h)
    │
    ▼
callToolDirect(name, input, context)
  isCacheable(name, input)?         ← false for zipPath / sourcePath (top level, entries[], operations[], sources[]), outputMode:'file',
                                       defaultDate:'now', parallel, describe_engine, draft_governance_issue
    hit → dispatchOutput(cached) + _meta.cached: true
  tool.handler(input, context)      ← src/tools/<tool>.ts
    parseInput(Zod .strictObject)   ← unknown keys / bad shapes → ToolError('VALIDATION_ERROR')
    loadArchive / openArchive / openArchiveSource ← zipBase64 (decoded ≤ 128 MiB) or zipPath (sandbox, container extension, one handle;
                                       ≤ 1 GiB in memory, byte ranges above it for the three random-access read tools)
    createDiagnosticSink(strict, context) ← every engine call taking ZipCommonOptions receives { onDiagnostic, strict, dosTimeMode: 'utc', signal, onProgress? } (verifyZip takes limits only)
    resolveCallLimits(limits)       ← merged over DEFAULT_ZIP_LIMITS, ceilings enforced (LIMIT_CEILING_EXCEEDED)
    guard('context', () => engine call)   ← src/zip-errors.ts: ZipError → ToolError(err.code verbatim, message, data)
    emitArchive / emitArchiveStream ← src/output.ts (archive-producing tools)
  setCached(...)                    ← only when cacheable and not cancelled
  dispatchOutput(output, tool, input) by tool.kind:
    'archive-output' | 'inflate' → buildArchiveResult: text + embedded `resource` (data:<mime>;base64,…) | resource_link; structuredContent { mode, sizeBytes, filePath?, summary, diagnostics, … }
    'extract'                    → buildExtractResult: projected result + up to 50 resource_links (file mode)
    'inspect' | 'list' | 'read-entry' | 'verify' | 'scan' | 'sanitize' | 'engine' → projected(text, full, summary, input)
    'crc32'                      → text + structuredContent (no projection)
    'governance'                 → two text blocks (human-gate notice + draft) + structuredContent
  catch → buildErrorResult: content[0].text = "<tool> failed [CODE]: message", isError: true, _meta.error { code, message, data? }
          an aborted request → CANCELLED; anything that is not a ToolError → ENGINE_ERROR (errorClass 'internal', absolute paths redacted)
```

The projection layer (`src/projection.ts`) runs inside `projected()`: `verbosity: 'summary'` swaps the full result for the tool's summary function (`inspectSummary`, `listSummary`, `readEntrySummary`, `verifySummary`, `extractSummary`, `scanSummary`, `sanitizeSummary`, `describeSummary`), then `fields: ['a', 'b.c']` projects to named dot-paths (array segments map over elements; a `__proto__` / `constructor` / `prototype` segment is `VALIDATION_ERROR`); unmatched paths are reported additively in `_meta.unmatchedFields` + `_meta.availableFields`. Defaults (`'full'`, no `fields`) are unchanged. The projectable `outputSchema` (every property optional, `additionalProperties: false`, summary scalars declared) is built once per tool by `projectableOutputSchema()` in `src/server.ts`.

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
    outputSchema?: unknown;           // projectable for the read tools; ARCHIVE_OUTPUT_SCHEMA + a typed summary for the archive producers
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    examples?: ReadonlyArray<{ title: string; input: Record<string, unknown> }>;   // ≤ 2, executable
    handler: (args: unknown, context: CallContext) => Promise<ToolOutput>;
}
```

`kind` selects the result shaper in `dispatchOutput` (`create_zip`, `modify_zip`, `canonicalize_zip` and `merge_zip` share `'archive-output'`). A `TOOL_INDEX: ReadonlyMap<string, ToolDefinition>` is derived from the array for O(1) lookup; `toolNames()` returns the registration order; `__setToolCount(TOOLS.length)` feeds `describe_engine.server.toolCount`.

Registration order (= `tools/list` order): `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `compute_crc32`, `inflate_raw`, `describe_engine`, `draft_governance_issue`.

Annotations: `READ_ONLY` = `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }` on `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `compute_crc32` and `describe_engine`; `WRITES` = `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }` on `extract_zip`, `create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw` (file mode writes the inflated bytes into the sandbox) and `draft_governance_issue` (file mode writes a `.md`). `openWorldHint` is `false` everywhere: nothing leaves the process.

**`_meta` per tool** — emitted in the `tools/list` response: `_meta.apiVersion = '1.1.0'` and `_meta.examples` (one or two executable inputs; `<zip-base64>` is the placeholder the examples runner substitutes).

**Server metadata:**
- `SERVER_NAME = 'zipnative-mcp'`, `SERVER_VERSION = ZIPNATIVE_MCP_VERSION` (`'1.1.0'`).
- `serverInfo` carries `title`, `description` (mirrors `server.json`) and `websiteUrl` (`https://github.com/Nizoka/zipnative-mcp#readme` = `package.json` `homepage`).
- `SERVER_CACHE_HINTS` — MCP 2026-07-28 `ttlMs` / `cacheScope` per method: `tools/list` + `prompts/list` public 24 h, `server/discover` public 1 h, `resources/*` private 0 (2025-era clients never see these fields).
- Registry ID `io.github.Nizoka/zipnative-mcp` (`package.json` `mcpName`, `server.json` `name`; canonical GitHub login casing).
- `SERVER_INSTRUCTIONS` — compact decision tree + security posture + common pitfalls returned in the `instructions` field of the opening exchange (initialize / server/discover result) (5744 bytes on the 1.1.0 build).

**Boot:** `ensureEngineReady()` is awaited by the CLI before serving and defensively by the tools that need the node:zlib tier (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw`, `describe_engine`).

---

## 4. Tools — Full Reference

Every archive-consuming tool starts with `parseInput` (strict Zod), `loadArchive` / `openArchive` (or `openArchiveSource` for the scanner), a diagnostic sink and `resolveCallLimits`, then wraps every engine call in `guard` / `guardAsync` / `mapZipError`. The shared fragments: `ARCHIVE_INPUT_PROPERTIES` (`zipBase64` XOR `zipPath`), `ACCESS_INPUT_PROPERTY` (`access: 'auto' | 'memory' | 'range'` on the three random-access read tools), `FILTER_INPUT_SCHEMA` (`names[]` ≤ 1000, `prefix`, `glob[]` ≤ 32 of ≤ 1024 characters each, `includeDirectories`), `LIMITS_INPUT_SCHEMA` (the nine `ZipLimits` keys), `STRICT_INPUT_PROPERTY`, `PROJECTION_INPUT_PROPERTIES` (`verbosity`, `fields` ≤ 16), `OUTPUT_INPUT_PROPERTIES` (`outputMode`, `outputPath`), `ENTRY_PAYLOAD_PROPERTIES` (`name`, `directory`, `dataBase64` | `text` | `sourcePath`, `compression`, `date`, `comment`, `externalAttributes` | `unixMode`, `extraFields[]` ≤ 16), `CANONICAL_OPTION_PROPERTIES` (`date`, `keepComments`, `keepExternalAttributes`), `DIAGNOSTICS_OUTPUT_PROPERTIES` (`diagnostics[]`, `diagnosticCounts`, `diagnosticsTruncated`).

**Dates are UTC.** Every engine call receives `dosTimeMode: 'utc'` (the diagnostic sink): a pinned `date` / `defaultDate` / canonical `date` is written as the same DOS fields on every host, and `lastModified` reads back as the same instant. An offset-less date-time is taken as the UTC wall clock (the DOS fields 1.0.0 wrote for it in any zone); a `Z` / `±hh:mm` instant is converted to UTC (1.0.0 wrote it in the host's zone, so such a call differs from 1.0.0 on a non-UTC host and is identical under UTC). The read side moved too: every DOS date is read as UTC, so on a non-UTC host every archive's `lastModified` and `earliestDate` / `latestDate` differ from what 1.0.0 reported on that host by the zone offset (the DOS epoch reads `1980-01-01T00:00:00.000Z`, where 1.0.0 in Paris reported `1979-12-31T23:00:00.000Z`), and an archive another tool wrote in local time reads shifted by its producer's offset.

### `inspect_zip`

**Purpose:** read-only archive report in one call, the `zipnative inspect --json` shape, plus CI assertions. Opens **eagerly** by default (`validate: 'eager'` — every entry's real extent checked up front: overlapping entries, entries reaching into the central directory or past EOF, and Zip64 spoofing are refused with their `ZIP_*` code rather than summarised); `validate: 'lazy'` defers to first read (cheaper on huge archives). Eager does **not** compare the central directory with each local header's method / CRC / sizes — that divergence is detected when an entry is read (`ZIP_CD_LFH_MISMATCH` / `ZIP_SIZE_MISMATCH`), and `verify_zip` (`localHeaderMatch`) is the one-call gate for it.

**Report:** counts (entries / files / directories), `isZip64`, the comment (lossy UTF-8 + `commentHex`), `prependedData` / `multipleEocd` (derived from the `ZIP_PREPENDED_DATA` / `ZIP_MULTIPLE_EOCD` diagnostics), compressed vs uncompressed totals and `ratio`, per-method counts, encrypted / symlink / data-descriptor / Zip64 / UTF-8 / cp437 / duplicate / unsafe-name counts (`sanitizedPathOf(name) === null`), the date range, and the **determinism verdict**, whose sub-checks come from the engine's `analyzeDeterminism()`: `deterministic = epochTimestamps && canonicalOrder && utf8Flags` (the 1.0.0 formula, unchanged — no CI gate flips) and `canonicalLayout = noDataDescriptors` (form) — a streamed archive is reproducible but not canonical. Opt-in `determinismReport: true` adds the engine's full report: the stricter canonical form `canonicalize_zip` produces (also Zip64-only extras and version-made-by `0x032D`), `pinnedDate`, `offenderCount` and `offenders[] { name, concern }` (`timestamp`, `order`, `utf8-flag`, `extra-field`, `version-made-by`, `data-descriptor`; at most 200, `offendersTruncated`); `canonicalDate` re-targets the canonical-form verdict at a pinned date. `check[]` (18 named assertions — the 15 of 1.0.0 plus `canonical-form`, `canonical-extras`, `canonical-version-made-by`) and `assert { maxEntries, minEntries, maxUncompressedBytes, maxRatio, has[], method }` produce `checks[] { check, ok, detail }` + `checksPassed`. With `access: 'range'` (or a `zipPath` above the 1 GiB in-memory cap under `'auto'`) the result carries `access: 'range'`, `determinism` is absent, the determinism checks fail closed with that reason, and `determinismReport` / `canonicalDate` are `VALIDATION_ERROR` (the analysis needs the whole archive in memory).

**zipnative API used:** `openZip(bytes, { validate, limits, strict, onDiagnostic })` or `openZipRange(source, options)` → `entries()`, `entryCount`, `isZip64`, `comment`; per entry `ZipEntry` (`rawName`, `dosDate` / `dosTime`, `flags`, `compressionMethod`, sizes, `isEncrypted`, `usesDataDescriptor`, `usesZip64`, `nameEncoding`, `lastModified`), `isSymlinkEntry`, `sanitizeEntryPath`, `FLAG_UTF8`, `METHOD_STORE` / `METHOD_DEFLATE`, `getCodec` (method names); `analyzeDeterminism(bytes, { limits, date?, dosTimeMode: 'utc' })` → `DeterminismReport`.

### `list_zip_entries`

**Purpose:** the paged central-directory inventory; nothing is decompressed. Every entry (duplicates included) in directory order, projected through the shared `EntryView` (`src/entry.ts`, vendored from the CLI's `entryfmt.ts` so an agent that knows `zipnative list --json --long` reads the same field names). `filter` selects; `offset` + `limit` (default 200, max 2000) page; `hasMore` tells you to page; `includeExtraData` adds each extra field's payload as base64; `includeExtendedTimestamps` adds `extendedTimestamps { mtime, atime, ctime, source: 'ut' | 'ntfs' | 'dos' }` and `includeUnixIds` adds `unixIds { uid, gid } | null` (both absent by default, so the default row is the 1.0.0 row). Directories are listed unless the filter excludes them (`includeDirectories` default `false` — listing and scanning include directories when no filter object is given; extraction never does). `validate` defaults to `'lazy'`; `access` as in `inspect_zip` (the rows are identical, plus `access: 'range'`).

**zipnative API used:** `openZip` / `openZipRange` → `entries()`, `entryCount`, `isZip64`; per row `getUnixMode`, `isSymlinkEntry`, `sanitizeEntryPath`, `getCodec`, `FLAG_*` masks, `ZipExtraField`, `getExtendedTimestamps`, `getUnixIds`.

### `read_zip_entry`

**Purpose:** random access to one entry by `name` (exact; the last duplicate wins — `reader.getEntry`) or `index` (central-directory position; disambiguates duplicates). `mode: 'data'` (default) returns the decompressed content as base64 or UTF-8 `text` (`ENTRY_NOT_UTF8` on invalid UTF-8), CRC-verified (`verifyCrc`); a `range { offset, length }` reads a byte window through `readEntryStream` (bounded memory, `crcVerified: false`). `mode: 'raw'` returns the compressed payload verbatim (`readEntryRaw`, zero-copy) for `inflate_raw`. `mode: 'verify'` runs `reader.verifyEntry` and returns `{ ok, crcMatch, sizeMatch, localHeaderMatch, skipped? }` without a payload (the engine's real `localHeaderMatch` and skip reason). Inline cap 16 MiB (`ENTRY_TOO_LARGE`, `data.remedy: 'range'`): in `mode: 'data'` a `range` window or `extract_zip` file mode; a raw payload above the cap is not retrievable inline (the same remedies yield the decompressed content). An out-of-range `index` is `ZIP_ENTRY_NOT_FOUND` naming the valid range (`data.remedy: 'list_zip_entries'`). `access`, `includeExtendedTimestamps` and `includeUnixIds` as in `list_zip_entries`; over byte ranges only the end record, the central directory and this entry's bytes are read, and `limits.maxEntryCompressedSize` bounds the fetched payload.

**zipnative API used:** `openZip` / `openZipRange` → `entries()`, `getEntry(name)`, `readEntry(entry, { verifyCrc })`, `readEntryStream(entry, { verifyCrc: false })`, `readEntryRaw(entry)`, `verifyEntry(entry)` (`EntryVerification`, `EntrySkipReason`).

### `verify_zip`

**Purpose:** one-call deep verification — the engine's `verifyZip` report: eager structural validation, then every entry's CRC-32 / size / local-header agreement. The contract that makes it agent-grade: it **never** fails for a problem with the archive. A structural refusal lands in `error { code: ZIP_*, message }` (`ok: false`, no entries); an unverifiable entry carries `skipped: 'encrypted' | 'stream-only-codec' | 'unsupported-method'`. The counts follow the engine's archive rule: an entry passes when it is `ok`, or when it is a design-time skip (`encrypted`, `stream-only-codec`) whose local header agrees with the central directory — `skippedCount` counts those; every other entry that is not `ok` is **failed**: an unknown method (`skipped: 'unsupported-method'`, failed as in 1.0.0) and, since 1.1.0, an encrypted entry whose local header contradicts the central directory (1.0.0 trusted a fabricated `localHeaderMatch`). `entries: 'all' | 'failed' | 'skipped' | 'none'` selects the rows; `maxEntries` (default 1000) caps them (`entriesTruncated`), the counts always cover every entry. Only caller mistakes throw.

**zipnative API used:** `verifyZip(bytes, { limits })` → `ZipVerificationReport { ok, error, entryCount, entries: VerifiedEntry[], diagnostics }`.

### `extract_zip`

**Purpose:** secure-by-default extraction. Every engine guard stays on unless the caller names the relaxation: `rejectTraversal` (zip-slip, absolute, drive / UNC, NUL, ADS, Windows device names — CWE-22 / CWE-67; `false` skips such entries and lists them in `skipped`, never emits them), `rejectSymlinks` (CWE-59; `false` writes the link target text as ordinary data, never a link), `onDuplicate` (CWE-694; `'first'` / `'last'`), `limits` (CWE-400 / CWE-409); overlap and central/local divergence detection has no opt-out. `filter` keeps a subset.

- **pre-flight (both modes)** — the archive is opened **eagerly** (`openZip(bytes, { validate: 'eager', … })`) before any plan, so every entry's real extent is checked first: an overlapping, offset-into-CD / past-EOF or Zip64-spoofed archive is refused with its `ZIP_*` code before a single plan row, and a file-mode extraction fails before its first write (`data.writtenCount: 0`). A method / CRC / size divergence between the central directory and a local header is detected when the entry is read, not here.
- **base64 mode** — the plan runs next through `extractZipStream` (sanitized paths, entries, no payload touched); `includeData: false` returns it as a dry run (`dryRun: true`). Otherwise the inline caps are checked against the declared sizes (16 MiB per entry, 32 MiB total) and `extractZip` produces the rows with `dataBase64`.
- **file mode** — `outputDir` (relative, inside the sandbox, created, realpath-checked) and a streamed write per entry: the engine's sanitized path is the only thing ever joined, the parent's real path is re-checked after every `mkdir -p`, files are opened `wx` (never overwritten), the file-output ceiling (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`, default 4 GiB) is enforced on the running total while writing, a partial file is removed on failure or cancellation. `emptyDirectories: true` also creates the explicit directory entries that hold no file. The result carries `filePath` per row and up to 50 `resource_link` blocks.

**zipnative API used:** `openZip(bytes, { validate: 'eager' })` (index + extent + `sanitizeEntryPath` pre-flight), `extractZipStream(bytes, options)` (plan + file mode, `ExtractedStreamEntry { path, entry, stream() }`), `extractZip(bytes, options)` (inline, `ExtractedEntry { path, entry, data }`), `ExtractOptions { rejectTraversal, rejectSymlinks, onDuplicate, filter, limits, strict, onDiagnostic }`.

### `scan_zip_forward`

**Purpose:** the engine's forward, central-directory-less reader over the archive bytes — local headers walked in stream order with bounded memory. The one tool that works on a truncated archive or a stream cut mid-way, and the one whose result is **not authoritative** (`trust: 'local-headers-only'`): forward iteration trusts local headers alone, so a hostile archive can present different content here than `inspect_zip` / `list_zip_entries` report (the upload-scanner differential). The stream must **start at a local header**: the tool cannot skip an SFX / prepended prefix and refuses one with `ZIP_SIGNATURE_MISMATCH` — `inspect_zip` (and every random-access tool) handles prefixed archives and reports `prependedData`; `modify_zip mode: 'compact'` drops the prefix. `data: 'none'` skips payloads (a data-descriptor entry still costs a decompress-and-discard), `'verify'` decompresses to check CRCs, `'include'` returns content under the inline caps. `maxEntries` (default 10 000, **clamped** to `ZIPNATIVE_MCP_MAX_ENTRIES` — only an explicit value above the ceiling is refused; the budget in force is returned as `maxEntries`) bounds the work; when the budget is reached the reader looks for one more header (never reads its payload) so an archive with exactly `maxEntries` entries still ends at `'central-directory'` and `'max-entries'` means more headers remained. `tolerateTruncation: true` turns a mid-stream failure into `stoppedAt: 'error'` + `error { code, message }` + the partial inventory. `stoppedAt: 'central-directory'` vs `'eof'` is classified **without the wrapper reading a PK signature** (CLAUDE.md convention 7): the engine's cursor pulls chunks on demand and leaves the rest of the stream unconsumed when it meets a central directory, so the source is handed over in pieces small enough (the final chunk in 16-byte slices) that a clean stop with bytes still undelivered means a central directory was reached, and a clean stop after the last byte means `'eof'` (truncated or CD-less). Names are not sanitized here; `sanitizedPath` shows what the extraction gate would use. `zipPath` input is streamed from disk through one sandbox handle (no buffered cap); `zipBase64` is chunked from memory.

**zipnative API used:** `iterateZipEntries(source, { limits, strict, onDiagnostic })` → `StreamedZipEntry { header: StreamedZipHeader, data(), skip() }`; `ByteSource` built by `openArchiveSource`.

### `sanitize_entry_paths`

**Purpose:** the engine's single traversal gate `sanitizeEntryPath()` over a list of names (1–10 000): the safe `/`-separated relative form each maps to, or `null` with the rule that fired (`empty`, `nul`, `absolute`, `drive`, `unc`, `traversal`, `ads`, `device-name`, `no-segments` — re-derived in the same order as the engine; the gate is the `sanitized` value, `reason` is explanatory). No archive needed. Use it when you extract with another tool or plan an external filesystem sink.

**zipnative API used:** `sanitizeEntryPath(name)`.

### `create_zip`

**Purpose:** deterministic archive creation through `createZip` (or the worker-pool `createParallelZip` from `zipnative/worker` when `parallel` is given — byte-identical per tier). Every option of the engine's writer is reachable: `order` (`canonical` raw-name-byte order by default; `insertion` for EPUB / JAR mimetype-first layouts), `defaultDate` (omitted = DOS epoch; an ISO instant in 1980–2107, read as UTC; `'now'` = wall clock, `ZIP_TIMESTAMP_NOT_PINNED`), archive and per-entry `compression { method, level, deterministic }`, `comment`, per-entry `comment` / `unixMode` (`'0644'` → the engine's `externalAttributesFromUnixMode`: `(S_IFREG | mode) << 16`; directories get `S_IFDIR` + the DOS directory bit) or raw `externalAttributes` / `extraFields` (embedded verbatim; id `0x0001` refused — the engine owns Zip64), explicit directories, and streamed sources (`stream: true` on a `sourcePath` → `addStream` over 64 KiB chunks; data-descriptor layout; an entry above 4 GiB is refused with `ZIP_UNSUPPORTED_ZIP64_STREAMING` unless `zip64: true`, which writes the APPNOTE 4.3.9.2 Zip64 streaming layout — version 45, a Zip64 extra in the local header, a 24-byte data descriptor; `zip64` without `stream` is `VALIDATION_ERROR`). A `/`-terminated name is a directory by ZIP convention and refuses a payload (`VALIDATION_ERROR`, shared with `modify_zip` add / replace through `refineEntryPayload`). Up to 100 000 entries per call (`MAX_CREATE_ENTRIES`, aligned with the engine default `maxEntries` so Zip64 output stays reachable — 65 536 entries auto-promote; the 256 MiB frame and the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling remain the effective bounds). Inline payloads share the 128 MiB decoded budget; `sourcePath` files up to 1 GiB buffered (no cap when streamed). base64 mode assembles with `toBytes()` (or collects `stream()` when an entry was streamed); file mode streams the archive to disk with `stream({ chunkSize })` and bounded memory, up to the file-output ceiling (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`, default 4 GiB — raise it for an archive above 4 GiB), hashing the chunks on the fly when `includeSha256` is set. `parallel.workers` defaults to the engine's `max(1, min(cores − 1, 8))` (`probeRuntime().defaultWorkers`) bounded by `ZIPNATIVE_MCP_WORKERS`, and is passed explicitly so `summary.parallel.workers` stays truthful; the pool is worth it only for many large entries. `includeSha256` adds `summary.sha256` in both output modes. `summary.deterministic` is `true` only when the pure-TS encoder is pinned for every entry and no wall-clock date is used (level-3 determinism, [`guides/DETERMINISM.md`](guides/DETERMINISM.md)) — a default call is reproducible on the same runtime and reports `false`; `summary.deflateTier` is `activeDeflateTier(deterministic)` (`pure-pinned` or `node-zlib`).

**zipnative API used:** `createZip(options)` / `createParallelZip(options)` → `ZipWriter` / `ParallelZipWriter` `add`, `addDirectory`, `addStream`, `toBytes`, `stream({ chunkSize })`; `CreateZipOptions { order, defaultDate, compression, comment, limits, strict, onDiagnostic }`; `AddEntryOptions` (incl. `zip64`); `externalAttributesFromUnixMode`; `ParallelZipOptions { workers, minWorkerJobSize, jobTimeout }`; `activeDeflateTier`.

### `modify_zip`

**Purpose:** incremental modification through `createZipModifier` without recompressing anything. The input is opened **eagerly** (`validate: 'eager'`, as `inspect_zip` by default — since 1.1.0): the overlap table and every entry's extent are checked before any operation runs, so an archive with overlapping entries or a truncated local header is refused instead of being re-emitted by the append path, which never re-reads the existing entries. Because that eager pass checks extents only, `mode: 'append'` also runs `reader.readEntryRaw()` over every non-encrypted entry before saving (no decompression): a method / CRC / size divergence between the central directory and a local header is `ZIP_CD_LFH_MISMATCH` and a declared-size bomb `ZIP_LIMIT_EXCEEDED`, as compaction (which reads every entry anyway) and the other writers refuse them. Names and payloads already in the archive are copied verbatim — an unsafe name such as `../../x` is carried into the output (`extract_zip` still refuses it). `operations[]` (1–1000) applied in order — `add` (`ZIP_ENTRY_EXISTS` if present; `directory: true` adds an explicit directory; a `/`-terminated name with a payload is `VALIDATION_ERROR`, as in `create_zip`), `replace` (`ZIP_ENTRY_NOT_FOUND` otherwise), `remove`, `rename` (never overwrites — remove the target first), `setComment`. `mode: 'append'` (default) = `save()`: the original bytes verbatim + appended entries + a new central directory — fast and byte-preserving, and the superseded payloads **remain in the file** (data remanence; `ZIP_DEAD_BYTES_RATIO` past 50 % dead bytes; 7-Zip reads the stale payload). `mode: 'compact'` = `saveCompact()`: a rewrite sorted by raw name bytes (an insertion-ordered EPUB / JAR layout is not preserved — rebuild it with `create_zip` `order: 'insertion'`), still no recompression, removed data truly gone, SFX prefix dropped; with `canonical: { date?, keepComments?, keepExternalAttributes? }` (compact only, `{}` takes the defaults) the rewrite is `saveCompact({ canonical })` — the canonical deterministic form of `canonicalize_zip`, applied after the edits — and `summary.canonical: true` says so. `summary.noOp` is `true` when the engine returned the same buffer (no edits, unchanged comment); `entryCountAfter` is read by re-opening the output. Archives with duplicate names are refused by the engine. New payloads take `compression` / `defaultDate` like `create_zip`. Full guide: [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md).

**zipnative API used:** `openZip(bytes, { validate: 'eager' })` → `createZipModifier(reader, { compression, defaultDate, limits, strict, onDiagnostic })` → `ZipModifier.addEntry / replaceEntry / removeEntry / renameEntry / setComment / save / saveCompact(CompactOptions)`; `CanonicalOptions`; `reader.bytes` (identity check for `noOp`), `reader.entryCount`.

### `canonicalize_zip`

**Purpose:** make any archive reproducible. zipnative's `canonicalizeZip()` rewrites an archive from any producer (Gradle, Maven, `zip`, Explorer, 7-Zip, an append-mode save) into the canonical deterministic form the engine's own writer emits — entries sorted by raw name bytes, one timestamp (the DOS epoch, or `date`, read as UTC), the UTF-8 flag on every name, no extra field but Zip64, version-made-by `0x032D`, no data descriptor — **without recompressing a payload**: compressed bytes are copied bit for bit, so nothing is decoded and no codec runs (byte-stable across runtimes). Names are copied verbatim as well: an unsafe name (`../../evil.txt`) stays in the output with `canonicalForm: true`, while `merge_zip`, which writes names through the checked writer, refuses it (`ZIP_INVALID_ENTRY_NAME`). Idempotent: canonicalising the result again yields the same bytes. Inputs: `zipBase64` | `zipPath`, `date`, `keepComments` (default `false`: the canonical form carries no comment), `keepExternalAttributes` (default `true`; `false` writes `0o100644` / `0o40755`), `includeSha256`, `strict`, `limits`, `outputMode` / `outputPath`. `summary { entryCount, inputBytes, outputBytes, alreadyCanonical, canonicalForm, pinnedDate, keepComments, keepExternalAttributes, sha256? }`: `alreadyCanonical` is `true` when the output bytes equal the input bytes; `canonicalForm` is the engine's `analyzeDeterminism()` verdict on the output with the same pinned date — the result is checked, not trusted. Duplicate-name archives are refused as the modifier refuses them. Verify later with `inspect_zip { check: ['canonical-form'], canonicalDate }`.

**zipnative API used:** `canonicalizeZip(bytes, CanonicalizeOptions)`, `analyzeDeterminism(output, AnalyzeDeterminismOptions)`, `openZip` (entry count of the output).

### `merge_zip`

**Purpose:** several archives into one without recompressing anything. `sources[]` (1–32, each `zipBase64` XOR `zipPath` with an optional per-source `filter`; total ≤ 1 GiB, inline payloads ≤ 128 MiB in all) are opened and every selected entry is transplanted by `ZipWriter.addFromReader()` with its method, CRC, sizes, timestamp, attributes, comment and extra fields (Zip64 recomputed), in O(bytes copied). `verify: true` (default) decompresses each entry once to check its CRC and size before copying it, so a corrupt payload is refused (`ZIP_CRC_MISMATCH` / `ZIP_SIZE_MISMATCH`) instead of being propagated; the engine copies an entry whose method has no registered codec without checking it, so under `verify: true` the tool first reads such an entry and the engine refuses it (`ZIP_UNSUPPORTED_METHOD`) — `summary.verified: true` therefore means every copied payload was checked; `false` trusts the sources. Each name passes the writer's name rules: a source entry it refuses (the `./` entry `bsdtar` writes, a `..` segment, a device name) is `ZIP_INVALID_ENTRY_NAME` with `data.sourceIndex` — the remedy is that source's `filter`. Encrypted entries are refused by the engine (`ZIP_UNSUPPORTED_ENCRYPTION`). Name collisions: `onConflict: 'error'` (default) lets the engine refuse the second occurrence (`ZIP_DUPLICATE_ENTRY_NAME`); `'first'` / `'last'` keep the first / last occurrence across the sources in order and report the others in `summary.dropped[] { name, source }`. `order: 'canonical'` (default — deterministic given the same sources) or `'insertion'`; `comment` (the sources' comments are not merged); `includeSha256`, `strict`, `limits`, `outputMode` / `outputPath`. `summary { sourceCount, entryCount, inputBytes, outputBytes, onConflict, verified, order, perSource[] { index, label, entryCount, taken, filteredOut, dropped }, dropped[], sha256? }`. Run `canonicalize_zip` on the result for the full canonical form (one timestamp, Zip64-only extras). The checked transplant is the only form exposed: `addRaw()` (the caller vouches for CRC and sizes) stays unexposed. `_meta.error.data.sourceIndex` names the failing source.

**zipnative API used:** `openZip` per source → `ZipReader` as `RawEntryReader`; `createZip({ order, comment, … })` → `ZipWriter.addFromReader(reader, entry, AddFromReaderOptions { verify })`.

### `compute_crc32`

**Purpose:** the ZIP checksum (IEEE 802.3 CRC-32, the engine's slice-by-8 `crc32`) of inline bytes / text or a sandbox file streamed in 1 MiB chunks. `seed` continues a running CRC across consecutive chunks; `expect` (8 hex digits, `0x` tolerated) compares and sets `matches`. Cross-check an entry's `crc32` from `list_zip_entries` against a file on disk.

**zipnative API used:** `crc32(bytes, seed)`.

### `inflate_raw`

**Purpose:** decompress a raw DEFLATE (RFC 1951) stream — e.g. the payload from `read_zip_entry mode: 'raw'` — with a **mandatory** `maxOutput` bound through the engine's resumable `createInflator`, fed chunk by chunk (64 KiB): constant memory, exact `bytesConsumed`, trailing bytes reported as `leftover` (`summary.trailingWarning` unless `allowTrailing`), `ZIP_INFLATE_OUTPUT_OVERFLOW` past the bound (further capped at 50 MiB inline / the file-output ceiling in file mode). `method: 'store'` is a bounded pass-through; a numeric method id selects a registered codec's `decompressSync` — this server registers none beyond 0 / 8, so it yields `ZIP_UNSUPPORTED_METHOD` (or `ZIP_UNSUPPORTED_CODEC_MODE` for a stream-only codec). Output as an embedded `application/octet-stream` resource or a sandbox file (`.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`).

**zipnative API used:** `createInflator(maxOutput)` → `Inflator.push / finished / leftover / bytesConsumed / end`; `getCodec(method)`; `METHOD_STORE` / `METHOD_DEFLATE`.

### `describe_engine`

**Purpose:** an offline capability preflight (the `zipnative doctor --json` of this server): server / engine / tool-API versions and the protocol string, the deflate tier in use and the pinned deterministic tier, runtime codecs (node:zlib, `CompressionStream`, `DecompressionStream`) and worker threads (`cpuCount`, `defaultWorkers`), the codec registry (store / deflate: `sync`, `stream`, `incremental` — the codec exposes `createDecompressor`, so the forward and byte-range readers decode it in O(chunk)), `DEFAULT_ZIP_LIMITS`, the four operator ceilings (`maxUncompressedBytes`, `maxEntries`, `maxWorkers`, `maxFileOutputBytes`) with their environment variable names, every server cap (`CAPS`), whether the sandbox and the cache are enabled, `network: 'none'`, the 39 `ZIP_*` codes, the 12 diagnostic codes, and `UNEXPOSED_EXPORTS` (the engine surfaces this server deliberately does not expose, with the rationale — §8). Never cached.

**zipnative API used:** `VERSION`, `activeDeflateTier(false | true)`, `getCodec`, `DEFAULT_ZIP_LIMITS`, `METHOD_STORE` / `METHOD_DEFLATE`; `initNodeZipCodecs` via `ensureEngineReady`.

### `draft_governance_issue`

**Purpose:** drafts a governance-compliant GitHub issue **locally** for human review (`src/tools/draft-governance-issue.ts`). It performs no network I/O (the server has no network code path) and never submits — the agent is a draftsman, a human is the only gate. Inputs: `title` (8–160), `issueType` (`bug` | `feature` | `security` | `docs` | `performance`), `summary`, `reproduction { command, result }`, `expectedBehavior`, optional `actualBehavior` (the free-text fields bounded at 16 384 characters each — `MAX_ISSUE_TEXT_CHARS`), `targetRepo` (default `zipnative-mcp`; `zipnative` for engine behaviour), `affectedPackages` (default `['zipnative-mcp']`), `duplicateSearchPerformed` (**must be `true`**), plus `outputMode` (`'inline' | 'file'`) / `outputPath` (`.md`). Returns `{ draftMarkdown, compliance, warnings, … }`. Contract enforcement lives in `src/governance.ts` (`validateIssueMarkdown`, linear-time patterns): proposing a runtime dependency or `duplicateSearchPerformed: false` throws `GovernanceError('GOVERNANCE_VIOLATION')`; `reproduction` is a required input, so omitting it is `VALIDATION_ERROR` before the policy runs (the tool always fences the command, so the "no reproduction block" check fires only on a hand-written draft through `npm run verify:issue`). In file mode the draft is written through `writeSandboxedText()` (same sandbox guards as archive output, `.md` extension). The contract source of truth is under `.github/` (`ai-governance.json`, `AGENT_RULES.md`); the narrative guide is [`guides/AI_GOVERNANCE.md`](guides/AI_GOVERNANCE.md).

### Cancellation and progress

Every `tools/call` carries a `CallContext` (`src/call-context.ts`) whose `signal` and, when the request's `_meta` holds a `progressToken`, `onProgress` ride the diagnostic sink into every engine call that accepts them (zipnative 1.1.0 takes both on `ZipCommonOptions`); `compute_crc32` and `inflate_raw` check the signal and report progress between their own chunks, and the multi-step handlers call `throwIfCancelled` between steps. `verifyZip` is the exception: its options hold only `limits`, so `verify_zip` checks the signal once before the verification starts and then runs to completion (an engine limitation). `sanitize_entry_paths`, `describe_engine` and `draft_governance_issue` do no work worth cancelling. A client `notifications/cancelled` (or an HTTP client that goes away) aborts the signal: the engine stops between chunks and releases what it held (stream locks, worker pools), a partial output file is removed, nothing is cached, and the call ends as the wrapper code `CANCELLED` (`data.remedy: 'retry'`) in-process and in the log — over MCP the SDK sends no response for a cancelled request. Work that completed before the abort is returned, not cached. The engine's monotonic `ZipProgress` snapshots become `notifications/progress` with `progress` strictly increasing across the whole call (a tool that runs several engine operations, such as `merge_zip` reading several sources, never goes backwards) and throttled to one per 200 ms plus the one that completes a known entry count. Without a `progressToken` no notification is sent; the result is the same either way. Full walk-through: [`guides/LARGE_ARCHIVES.md`](guides/LARGE_ARCHIVES.md).

### MCP resources

Files in the sandbox are exposed as native MCP resources (`src/resources.ts`). `resources/list` walks `ZIPNATIVE_MCP_OUTPUT_DIR` (≤ 8 levels deep, ≤ 1000 entries, sorted) and returns `zipnative://output/<relative>` URIs for **every regular file** — archives written by `create_zip` / `modify_zip` / `canonicalize_zip` / `merge_zip`, files written by `extract_zip`, drafts written by `draft_governance_issue`, and archives the operator dropped in for `zipPath` — with a MIME type by extension (`application/zip`, `application/java-archive`, the OOXML / ODF types, `application/epub+zip`, `text/markdown`, …, `application/octet-stream` when unknown). `resources/templates/list` advertises `zipnative://output/{+path}` (RFC 6570 reserved expansion). `resources/read` re-validates the path through the sandbox resolver (traversal / NUL / absolute guards), reads it through one handle and returns the base64 blob (≤ 50 MiB, `OUTPUT_TOO_LARGE` beyond); an unknown URI → JSON-RPC `-32602` carrying `UNKNOWN_RESOURCE`. File-producing tools also emit `resource_link` content blocks. When the sandbox is disabled there are no resources and no template. Capability advertised as `resources: {}`.

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
| `'base64'` | Bytes inline as an embedded `resource` content block — in `resource.blob` and again in `resource.uri` (`data:<mime>;base64,…`, the 1.0.0 shape), so the archive travels twice; ≤ 50 MiB (`OUTPUT_TOO_LARGE`) | No |
| `'file'`   | Streamed into the sandbox with `wx`; returns `filePath` (the absolute host path) + `sizeBytes` + a `resource_link` — the token-frugal mode; ≤ the file-output ceiling (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`, default 4 GiB) | Yes — `ZIPNATIVE_MCP_OUTPUT_DIR` |

`extract_zip` file mode writes under `outputDir` (a relative directory); `draft_governance_issue` writes a `.md` through `writeSandboxedText`.

### The sandbox (reads **and** writes)

`src/sandbox.ts` is the single filesystem boundary. Every path a tool reads (`zipPath`, `sourcePath`, `merge_zip` sources) or writes (`outputPath`, `outputDir`, extracted files, governance drafts) resolves through it against `ZIPNATIVE_MCP_OUTPUT_DIR`. Unset ⇒ every file input and output is disabled (`SECURITY_VIOLATION`) and the tools work on base64 only. Guards, in order:

1. `INVALID_PATH` — empty or non-string.
2. `SECURITY_VIOLATION` — NUL byte; absolute, Windows-absolute (`C:\`) or UNC (`\\`) path (checked even on POSIX); `path.relative(sandbox, resolved)` empty, starting with `..` or absolute.
3. `INVALID_EXTENSION` — `zipPath` / `outputPath` must end in one of `ZIP_CONTAINER_EXTENSIONS` (`.zip`, `.jar`, `.war`, `.ear`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, `.vsix`, `.nupkg`, `.whl`, `.apk`, `.ipa`, `.xpi`, `.crx`, `.kmz`); `.md` for drafts; the `inflate_raw` list for inflated output; `sourcePath` and extracted files are unconstrained.
4. `INPUT_NOT_FOUND` — a read target is absent or not a regular file (the message carries the relative path only).
5. **One handle per read** (`openInputFile` / `readInputFile`) — the file is opened, `fstat`-ed, its real path proven inside the real sandbox and bound to the handle by device and inode; then only the handle is read (buffered reads, streamed chunks, the byte-range reader). A file swapped while it is being opened is `SECURITY_VIOLATION`; a file that grows or shrinks under the read is `IO_ERROR` (`data.remedy: 'retry'`).
6. `assertRealpathInside` — after `mkdir -p`, the **real** path of the parent must still live inside the real sandbox (a pre-existing symlinked directory inside the sandbox cannot redirect a write outside it).
7. `wx` — `writeExclusive` / `openExclusiveWriteStream` never overwrite (`OUTPUT_EXISTS`); other fs errors map to `IO_ERROR` with the errno (never the absolute path); a partial file is removed on failure or cancellation (`discardPartial`).

Streaming caps: `emitArchiveStream` and the `extract_zip` file writer enforce the file-output ceiling while writing (backpressure-aware); a `zipPath` for the buffered tools is checked against 1 GiB before it is read, and above it `inspect_zip` / `list_zip_entries` / `read_zip_entry` switch to byte ranges under `access: 'auto'`; `scan_zip_forward` streams a `zipPath` with no size cap.

### `OutputResult` type

```typescript
interface OutputResult {
    mode: 'base64' | 'file';
    sizeBytes: number;
    filePath?: string;                    // when mode='file' (absolute sandbox path)
    base64?: string;                      // when mode='base64' (delivered as the resource block, not in structuredContent)
    summary?: Record<string, unknown>;    // tool-specific: create_zip / modify_zip / canonicalize_zip / merge_zip / inflate_raw summaries
    mimeType?: string;                    // application/zip by default; application/octet-stream for inflate_raw
}
```

---

## 6. Caching ([src/cache.ts](../src/cache.ts))

An opt-in, content-addressed on-disk cache for tool results. Disabled by default; set `ZIPNATIVE_MCP_CACHE_DIR` to enable it. Key = SHA-256 of the canonical JSON `{ tool, apiVersion, input }`, where `apiVersion` is `TOOL_API_VERSION/ZIPNATIVE_MCP_VERSION/zipnative VERSION` (`CACHE_API_VERSION` in `src/server.ts`) — engine lock-step, so an upgrade never serves bytes written by the previous engine. The namespace also carries the four operator ceilings, so a result stored under a looser ceiling is never served once the operator lowers it; the directory must be absolute (a relative value refuses to start). Entries live 1 h (TTL) under a 256 MiB cap; eviction removes the oldest-written entries first (by mtime — a hit does not refresh it, so the order is write order, not use order); every I/O error degrades to a miss, an entry's age and bytes are read through one descriptor, and the cache never throws to the client. A hit is re-shaped through `dispatchOutput` and carries `_meta.cached: true`. **Never cached** (`isCacheable()`): any input carrying `zipPath` / `sourcePath` — at the top level or inside `entries[]`, `operations[]` or `sources[]` (a path is a reference, not content — the file may change), `outputMode: 'file'` (the filesystem side-effect is part of the contract), `defaultDate: 'now'` (wall clock), any `parallel` request (timing-dependent fallbacks), `describe_engine` (environment-dependent), `draft_governance_issue` (embeds the environment), and any cancelled call. The cache stores tool output as plaintext at rest — protect the directory like the sandbox.

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

**Wrapper codes (17,** `src/wrapper-codes.ts`**):** `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `UNKNOWN_RESOURCE`, `GOVERNANCE_VIOLATION`, `CANCELLED` (new in 1.1.0), `ENGINE_ERROR`. Full table with remedies: [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6 / [`AI_GUIDE.md`](AI_GUIDE.md) §5.

**`ToolError` → MCP `CallToolResult`:** `content[0].text = "<tool> failed [CODE]: message"`, `isError: true`, `_meta.error = { code, message, data? }`. A throw that is not a `ToolError` (a bug) is `ENGINE_ERROR` with `data.errorClass: 'internal'` and its message stripped of absolute paths (`redactAbsolutePaths`).
**Protocol-level** (JSON-RPC errors, not tool results): `tools/call` with an unknown tool name → `-32602` `[UNKNOWN_TOOL] Unknown tool: <name>` (`callToolDirect`, in-process, keeps `isError`); `prompts/get` unknown → `-32602` `[UNKNOWN_PROMPT]`; `resources/read` unknown URI → `-32602` carrying `UNKNOWN_RESOURCE`, other resource failures → `-32602` `[CODE] message`.

### The `ZIP_*` mapping (`mapZipError`)

`src/zip-errors.ts` is the **only** place that reads `err.code` from the engine (vendored from zipnative-cli's `ziperr.ts` and reshaped for MCP). Every engine call is wrapped: `guard('Failed to open archive', () => openZip(...))` / `guardAsync` / `mapZipError(err, context, entryName?, extra?)`. The rules:

- A `ToolError` passes through unchanged.
- A `ZipError` becomes `ToolError(err.code, '<context>: <engine message>', data)` — the code **verbatim** (39 frozen codes: 7 base, 13 format, 6 security, 5 data, 2 limit, 6 unsupported), the message keeps the engine text (which names the remedy), and `data` carries `errorClass` (`ZIP_ERROR_CLASS[code]`: `usage` / `limit` / `not-found` / `input` / `internal` / `check` / `parse` / `security` / `data` / `unsupported`), `engineError` (the class name: `ZipError`, `ZipFormatError`, `ZipSecurityError`, `ZipDataError`, `ZipLimitError`, `ZipUnsupportedError`), `entryName` (from `ZipSecurityError` / `ZipDataError`, else the caller's), and per class `{ limit, configured, observed }` (`ZipLimitError`), `{ feature }` (`ZipUnsupportedError`), `{ expectedCrc, actualCrc }` as 8-hex (`ZipDataError`), plus the caller's `extra` (`operationIndex` / `op`, `entryIndex`, `sourceIndex`, `writtenCount`).
- zipnative 1.1.0 normalises a corrupt or truncated deflate stream to `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` on every inflate tier, so the wrapper no longer maps `node:zlib` errors itself and the code never depends on the codec tier; `ZIP_DECOMPRESSION_FAILED` is therefore unreachable here.
- Anything else → `ENGINE_ERROR` (`errorClass: 'internal'`).
- `ZIP_ERROR_CLASS` is typed `satisfies Record<ZipErrorCode, string>`: an engine minor that adds a code fails `tsc` here instead of leaking as `ENGINE_ERROR`. Two tools raise a `ZIP_*` code themselves without an engine throw, with the same shape: `read_zip_entry` (`ZIP_ENTRY_NOT_FOUND` for a missing name / out-of-range index) and `inflate_raw` (`ZIP_INFLATE_OUTPUT_OVERFLOW` for store above the bound, `ZIP_UNSUPPORTED_METHOD` / `ZIP_UNSUPPORTED_CODEC_MODE` for the codec registry).

**Diagnostics are not errors.** The 12 diagnostic codes (`ZIP_PREPENDED_DATA`, `ZIP_MULTIPLE_EOCD`, `ZIP_NAME_MISMATCH`, `ZIP_UNICODE_PATH_CONFLICT`, `ZIP_INVALID_UTF8_NAME`, `ZIP_DUPLICATE_NAME`, `ZIP_EXTRA_FIELD_MALFORMED`, `ZIP_ZIP64_EXTRA_IGNORED`, `ZIP_TIMESTAMP_NOT_PINNED`, `ZIP_NONDETERMINISTIC_CODEC`, `ZIP_DEAD_BYTES_RATIO`, `ZIP_TIMESTAMP_CLAMPED`) flow through `createDiagnosticSink` into every result's `diagnostics[]` (`{ code, severity, message, entryName? }`, de-duplicated by code + entry, capped at 200 with `diagnosticsTruncated`) and `diagnosticCounts` (every occurrence). `ZIP_TIMESTAMP_CLAMPED` (new in zipnative 1.1.0) is listed but unreachable through this server by design: a date outside 1980–2107 is `VALIDATION_ERROR` before the engine sees it. `strict: true` asks the engine to escalate the first diagnostic into `ZIP_STRICT_DIAGNOSTIC`. The sink is always installed, so the engine's `console.warn` fallback never touches stdout (a stdio server's wire). Registry with `raisedWhen` / `remedy` per code: [`data/errors.json`](data/errors.json).

---

## 8. The 106-export coverage ledger (zipnative API mapping)

Every one of the 106 exports of zipnative 1.1.0 (101 from `zipnative`, 5 from `zipnative/worker` — [`data/core-exports.json`](data/core-exports.json), derived from the engine's `docs/assets/api.json`) mapped to its MCP touchpoint: the tool and the input / output field that exercises it. The **Reach** column grades each row honestly: **capability** — the behaviour behind the export is exercisable through a tool; **type** — re-exported (or aliased) upstream for typing only, nothing an agent can observe depends on it beyond `tsc`; **unexposed** — deliberately not reachable from a tool argument, with the reason. The counts are 88 capability / 9 type / 9 unexposed = 106. Nine exports carry reach `unexposed` (`registerCodec`, `ZipCodec`, `CodecCompressOptions`, `setInflateImpl`, `setDeflateImpl`, `initNodeZipCodecs`, `RawEntryMeta`, `ZipNameDecoder`, `ZipDecompressor`) and several members of capability rows are likewise unexposed (`ParallelZipOptions.workerUrl`, `ZipCommonOptions.onDiagnostic`, `ZipCommonOptions.nameDecoder`, `ZipReader.bytes` / `ZipModifier.reader`, `ZipWriter.addRaw`, `ZipCodec.createDecompressor`, an external `ByteSource` / `ReadableStream`, a remote `ByteRangeSource`) — the eleven entries `describe_engine.unexposed` reports at runtime (`UNEXPOSED_EXPORTS` in `src/tools/describe-engine.ts`, listed in the last table). Enforced by `tests/docs-consistency.test.ts` and `scripts/verify-docs.ts`: the `name` + `subpath` pairs of `core-exports.json` equal the engine's `docs/assets/api.json` when it is reachable, every name appears in backticks in this section, every `UNEXPOSED_EXPORTS` entry is graded unexposed here, and the `zipnativeVersion` of `core-exports.json` and `errors.json` equals the engine's `VERSION`.

### Reading, random access, streams

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `openZip` | function | capability | `inspect_zip`, `list_zip_entries`, `read_zip_entry` (in memory — `access: 'memory'`, or `'auto'` up to the 1 GiB cap), `extract_zip` (index pre-flight), `modify_zip` (eager), `merge_zip` (each source), `canonicalize_zip` (re-open of the output), through `guard('Failed to open archive', …)` |
| `OpenZipOptions` | interface | capability | `inspect_zip.validate` (`'eager'` default) and `list_zip_entries.validate` (`'lazy'` default) → `validate`; `modify_zip` / `extract_zip` open with `'eager'`; `limits`, `strict`, `onDiagnostic` from the shared fragments; also the options of `openZipRange` |
| `ReadEntryOptions` | interface | capability | `read_zip_entry.verifyCrc` → `{ verifyCrc }` on `readEntry`; `{ verifyCrc: false }` on `readEntryStream` for a `range` — on both readers |
| `ZipReader` | interface | capability | `entries()` (every read tool), `getEntry(name)` (`read_zip_entry.name`), `readEntry` / `readEntryStream` / `readEntryRaw` (`read_zip_entry` modes `data` / `range` / `raw`), `verifyEntry` (`read_zip_entry mode: 'verify'` → `verification`), `entryCount` / `isZip64` / `comment` (`inspect_zip`, `list_zip_entries`; `comment` → `comment` + `commentHex`); each `merge_zip` source is a `ZipReader` handed to `addFromReader`. `bytes` is used only for `modify_zip.summary.noOp` (same-buffer identity) — **unexposed** as a field: it is the input itself |
| `openZipRange` | function | capability | `inspect_zip`, `list_zip_entries`, `read_zip_entry` with `access: 'range'`, or `'auto'` on a `zipPath` above the 1 GiB in-memory cap — over the sandbox file's own handle (never a URL); results carry `access: 'range'`. Over a remote source it is **unexposed** (no network path) |
| `ZipRangeReader` | interface | capability | The `ZipReader` surface with asynchronous reads and no `bytes` behind `access: 'range'` (`src/archive-input.ts` `rangeHandle`); `limits.maxEntryCompressedSize` bounds one fetched payload |
| `ByteRangeSource` | interface | capability | Built **internally** from the sandbox file's single handle (`{ size, read(offset, length) }`) or from inline bytes; a source that delivers fewer bytes than asked is `ZIP_RECORD_TRUNCATED`. A remote / URL `ByteRangeSource` is **unexposed** |
| `rangeSourceFromBytes` | function | capability | `access: 'range'` on inline `zipBase64` input — the same byte-range reader on bytes already in memory (`tests/range-access.test.ts` holds it equal to the in-memory reader) |
| `iterateZipEntries` | function | capability | `scan_zip_forward` — the forward reader over the `ByteSource` built by `openArchiveSource` |
| `IterateZipOptions` | type | capability | `scan_zip_forward.limits` / `strict` + the diagnostics sink passed to `iterateZipEntries` |
| `StreamedZipEntry` | interface | capability | `scan_zip_forward`: `header` / `data()` (`data: 'verify' | 'include'`) / `skip()` (`data: 'none'`, filtered-out and directory entries) per local entry |
| `StreamedZipHeader` | interface | capability | `viewFromHeader()` in `src/entry.ts` — the `scan_zip_forward.entries[]` row (`isSymlink`, `usesZip64`, `unixMode` are `null`; `rawName` → `rawNameHex`; descriptor headers carry zero sizes) |
| `ByteSource` | type | capability | Built **internally** by `openArchiveSource` (`zipBase64` chunked from memory, `zipPath` streamed from the one sandbox handle in 64 KiB chunks) for `scan_zip_forward`, and from the sandbox file's chunks for `create_zip` `stream: true` entries. An external `ByteSource` / Web `ReadableStream` is **unexposed**: JSON-RPC has no stream channel |

### Extraction

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `extractZip` | function | capability | `extract_zip` base64 mode with `includeData: true` (the in-memory extractor; rows carry `dataBase64`) |
| `extractZipStream` | function | capability | `extract_zip` — the plan phase of base64 mode (`includeData: false` = dry run, nothing decompressed) and the whole of file mode (`stream()` per entry into the sandbox sink) |
| `sanitizeEntryPath` | function | capability | `sanitize_entry_paths.results[].sanitized`; `sanitizedPath` on every `EntryView` row (`list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`); `inspect_zip.unsafeNameCount`; the `skipped` list of `extract_zip rejectTraversal: false`; explicit directories under `emptyDirectories` |
| `ExtractOptions` | interface | capability | `extract_zip.rejectTraversal` / `rejectSymlinks` / `onDuplicate` / `filter` (→ `filter(entry)`) / `limits` / `strict` / `onDiagnostic` |
| `ExtractedEntry` | interface | capability | `extract_zip` base64 rows (`{ path, data, entry }` → `path`, `entryName`, `index`, `sizeBytes`, `crc32`, `method`, `dataBase64`) |
| `ExtractedStreamEntry` | interface | capability | `extract_zip` plan rows and file-mode rows (`{ path, entry, stream() }` → `filePath` after the streamed write) |

### Writing and merging

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `createZip` | function | capability | `create_zip` (sequential writer; `toBytes()` in base64 mode, `stream()` in file mode or when an entry is streamed); the `merge_zip` writer |
| `ZipWriter` | interface | capability | `create_zip.entries[]` → `add` (`dataBase64` / `text` / `sourcePath`), `addDirectory` (`directory: true`), `addStream` (`stream: true`, `zip64` opt-in), `toBytes`, `stream({ chunkSize })`; `addFromReader` (`merge_zip`, the checked transplant); `addRaw` is **unexposed** (the caller would vouch for the CRC and the sizes); the archive comment is expressed through `CreateZipOptions.comment` |
| `CreateZipOptions` | interface | capability | `create_zip.order` / `defaultDate` (ISO instant read as UTC, or `'now'`) / `compression` / `comment` / `limits` / `strict` / `onDiagnostic`; `merge_zip.order` / `comment` |
| `AddEntryOptions` | interface | capability | Per entry on `create_zip.entries[]` and `modify_zip` `add` / `replace`: `compression`, `date`, `comment`, `externalAttributes` (raw uint32) or `unixMode`, `extraFields[] { id, dataBase64 }`, `zip64` (`create_zip` `stream: true` entries only) (`toAddEntryOptions` in `src/entry-spec.ts`) |
| `AddFromReaderOptions` | interface | capability | `merge_zip.verify` → `addFromReader(reader, entry, { verify })` (default `true`: CRC and size checked before the copy) |
| `RawEntryReader` | interface | capability | The read side `merge_zip` hands to `addFromReader` — every opened source `ZipReader` satisfies it |
| `externalAttributesFromUnixMode` | function | capability | `unixMode` on `create_zip` entries and `modify_zip` add / replace (`parseUnixMode` → `externalAttributesFromUnixMode(mode, { directory })`) |
| `UnixModeOptions` | interface | capability | The `{ directory }` option passed with `unixMode` (directories get `S_IFDIR` + the DOS directory bit) |
| `ZipCompressionOptions` | interface | capability | `compression { method: 'store' | 'deflate', level 0–9, deterministic }` at archive level (`create_zip`, `modify_zip`) and per entry |
| `StreamOptions` | interface | capability | `create_zip.chunkSize` → `writer.stream({ chunkSize })` (file mode; 1 KiB … 16 MiB) |
| `createParallelZip` (`./worker`) | function | capability | `create_zip.parallel` → dynamic `import('zipnative/worker')`; byte-identical to `createZip` per tier |
| `ParallelZipOptions` (`./worker`) | interface | capability | `create_zip.parallel { workers (≤ ZIPNATIVE_MCP_WORKERS, `LIMIT_CEILING_EXCEEDED` above), minWorkerJobSize, jobTimeout }` + every `CreateZipOptions` field. `workerUrl` is **unexposed**: a filesystem / bundler path from a tool argument would point the worker at arbitrary code; the packaged worker resolves itself |
| `ParallelZipWriter` (`./worker`) | interface | capability | The `create_zip` writer under `parallel` (same `add` / `addDirectory` / `addStream` / `toBytes` / `stream` surface; `toBytes()` awaited); `summary.parallel { requested, workers }` |
| `ByteSource` (`./worker`) | type | type | The worker subpath re-exports the root declaration unchanged; the server imports `ByteSource` from the root entry only, so this row is a re-export alias, not a second touchpoint |
| `StreamOptions` (`./worker`) | interface | type | Same as the row above — the root `StreamOptions` is the one `create_zip.chunkSize` uses, also under `parallel` in file mode |

### Verification, modification and determinism

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `verifyZip` | function | capability | `verify_zip` — the report, counted by the engine's archive rule (never `isError` for an archive problem) |
| `VerifyZipOptions` | interface | capability | `verify_zip.limits` → `{ limits }` |
| `ZipVerificationReport` | interface | capability | The `verify_zip` result body: `ok`, `error { code, message } | null`, `entryCount`, `entries`, `diagnostics` (plus the wrapper's `verifiedCount` / `failedCount` / `skippedCount` / `entriesTruncated`) |
| `VerifiedEntry` | interface | capability | `verify_zip.entries[]` (`name`, `ok`, `crcMatch`, `sizeMatch`, `localHeaderMatch`, `skipped?`), selectable with `entries: 'all' | 'failed' | 'skipped' | 'none'` |
| `EntryVerification` | interface | capability | `read_zip_entry mode: 'verify'` → `verification { ok, crcMatch, sizeMatch, localHeaderMatch, skipped? }` (base of `VerifiedEntry`) |
| `EntrySkipReason` | type | capability | The value set of `skipped`: `'encrypted'` / `'stream-only-codec'` (counted as skipped when the local header agrees) and `'unsupported-method'` (counted as failed) |
| `createZipModifier` | function | capability | `modify_zip` — over the eagerly opened reader; `save()` (`mode: 'append'`) / `saveCompact()` (`mode: 'compact'`) |
| `ZipModifier` | interface | capability | `modify_zip.operations[]` → `addEntry` (`add`, incl. `directory: true` as `name/` + empty payload), `replaceEntry` (`replace`), `removeEntry` (`remove`), `renameEntry` (`rename { from, to }`), `setComment` (`setComment { comment }`), `save` / `saveCompact` (`mode`). `reader` is **unexposed**: it is the input itself |
| `ZipModifierOptions` | interface | capability | `modify_zip.compression` / `defaultDate` (for new payloads) / `limits` / `strict` / `onDiagnostic` |
| `CompactOptions` | interface | capability | `modify_zip mode: 'compact'` with `canonical: {…}` → `saveCompact({ canonical })` |
| `CanonicalOptions` | interface | capability | `canonicalize_zip` `date` / `keepComments` / `keepExternalAttributes` and `modify_zip.canonical` (`toCanonicalOptions` in `src/canonical.ts`) |
| `canonicalizeZip` | function | capability | `canonicalize_zip` — the canonical deterministic form without recompression; idempotent |
| `CanonicalizeOptions` | interface | capability | `canonicalize_zip`: the canonical options + `limits` / `strict` and the diagnostic sink |
| `analyzeDeterminism` | function | capability | `inspect_zip` determinism sub-checks, `determinismReport`, `canonicalDate`, `check: 'canonical-form' | 'canonical-extras' | 'canonical-version-made-by'` (in-memory access only); `canonicalize_zip.summary.canonicalForm` |
| `AnalyzeDeterminismOptions` | interface | capability | `inspect_zip.canonicalDate` → `analyzeDeterminism(bytes, { date, limits, dosTimeMode: 'utc' })`; the same pinned date in `canonicalize_zip` |
| `DeterminismReport` | interface | capability | `inspect_zip.determinismReport { deterministic, epochTimestamps, canonicalOrder, utf8Flags, canonicalExtras, canonicalVersionMadeBy, noDataDescriptors, pinnedDate, offenderCount, offenders, offendersTruncated? }` |
| `DeterminismOffender` | interface | capability | `inspect_zip.determinismReport.offenders[] { name, concern }` (at most 200) |
| `DeterminismConcern` | type | capability | The value set of `offenders[].concern` (`timestamp`, `order`, `utf8-flag`, `extra-field`, `version-made-by`, `data-descriptor`) and of the `canonical-form` check detail |

### Entry attributes, entries and shared types

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `getUnixMode` | function | capability | `unixMode` (four octal digits, or `null` for a non-Unix producer) on every central-directory `EntryView` row (`list_zip_entries`, `read_zip_entry.entry`, `extract_zip` planning) |
| `isSymlinkEntry` | function | capability | `isSymlink` on every `EntryView` row; `inspect_zip.symlinkCount` and `check: 'no-symlinks'` |
| `getExtendedTimestamps` | function | capability | `list_zip_entries` / `read_zip_entry` `includeExtendedTimestamps: true` (UT, then NTFS, then the DOS fields — Info-ZIP's precedence) |
| `ExtendedTimestamps` | interface | capability | The row field `extendedTimestamps { mtime, atime, ctime, source: 'ut' | 'ntfs' | 'dos' }` (ISO-8601, UTC) |
| `getUnixIds` | function | capability | `list_zip_entries` / `read_zip_entry` `includeUnixIds: true` |
| `UnixIds` | interface | capability | The row field `unixIds { uid, gid }`, or `null` when the archive carries no Info-ZIP `ux` (0x7875) extra |
| `ZipEntry` | interface | capability | `viewFromEntry()` in `src/entry.ts` — the `EntryView` row (`rawName` → `rawNameHex`, raw `comment` → `commentHex`, `nameEncoding`, `dosDate` / `dosTime`, `localHeaderOffset`, `versionMadeBy` → `hostSystem`, …); `inspect_zip` statistics and determinism verdict; `read_zip_entry` / `extract_zip` / `modify_zip` / `merge_zip` planning |
| `ZipNameEncoding` | type | capability | `nameEncoding` on every `EntryView` row (`'utf-8'` / `'cp437'`; `'custom'` never occurs here — `nameDecoder` is unexposed) |
| `ZipExtraField` | interface | capability | Read: `extraFields[] { id, idHex, name, length, dataBase64? }` on `EntryView` rows (`list_zip_entries.includeExtraData` adds the payload); write: `extraFields[] { id, dataBase64 }` on `create_zip` entries and `modify_zip` add / replace (`toExtraFields`; id `0x0001` refused) |
| `ZipCommonOptions` | interface | capability | `strict` and `limits` on every engine-touching tool (`EngineOptionsShape`); `dosTimeMode` pinned to `'utc'`, `signal` (MCP cancellation) and `onProgress` (`notifications/progress`) installed by the diagnostic sink on every engine call that takes `ZipCommonOptions` (`verifyZip` takes only `limits`, so `verify_zip` cannot be interrupted once it starts). `onDiagnostic` is **unexposed** as an input: the server always installs its own sink so every archive tool's result carries `diagnostics[]`; `nameDecoder` is **unexposed** in 1.1.0 (a decoder is a function; a label-based, closed-enum input is a later candidate) |
| `DosTimeMode` | type | capability | Fixed to `'utc'` on every engine call (a pinned date is the same DOS fields on every host); `'local'` is not offered as an input |
| `ZipProgress` | interface | capability | The engine snapshots `progressReporter` (`src/call-context.ts`) turns into `notifications/progress` when the request carries `_meta.progressToken` |
| `ZipProgressHandler` | type | capability | The `onProgress` the diagnostic sink installs when the request asked for progress |
| `ZipDiagnostic` | interface | capability | `createDiagnosticSink()` converts each one to a `DiagnosticRow { code, severity, message, entryName? }` (de-duplicated by code + entry, capped at 200) |
| `ZipDiagnosticCode` | type | capability | The 12-code vocabulary in `ZIP_DIAGNOSTIC_CODES` (`src/zip-errors.ts`, checked exhaustive against this type) → `describe_engine.diagnosticCodes`; `diagnostics[].code` on every result; `inspect_zip.prependedData` / `multipleEocd` derived from two of them; `ZIP_TIMESTAMP_CLAMPED` unreachable by design |
| `ZipDiagnosticHandler` | type | capability | The sink's `onDiagnostic` |
| `ZipLimits` | interface | capability | The `limits` input on every engine-touching tool (`LIMITS_INPUT_SCHEMA`, nine keys); `describe_engine.defaultLimits`; the operator ceilings bound `maxEntries` (`ZIPNATIVE_MCP_MAX_ENTRIES`) and `maxEntryUncompressedSize` / `maxEntryCompressedSize` / `maxTotalUncompressedSize` (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`) |
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
| `ZipDataErrorCode` | type | type | The 5 data-code rows (`ZIP_DECOMPRESSION_FAILED` unreachable since the engine normalises every inflate tier to `ZIP_DEFLATE_*`) |
| `ZipLimitErrorCode` | type | type | The 2 limit-code rows (`ZIP_LIMIT_INVALID` pre-empted by the Zod `limits` schema) |
| `ZipUnsupportedErrorCode` | type | type | The 6 unsupported-code rows (`ZIP_UNSUPPORTED_ZIP64_STREAMING` needs a streamed `sourcePath` above 4 GiB without `zip64: true`) |
| `ZipUnsupportedFeature` | type | capability | `_meta.error.data.feature` (`zipcrypto`, `strong-encryption`, `aes`, `multi-disk`, `zip64-streaming`, `cd-less-descriptor`, `method:<n>`) |

### Codecs, checksums, constants, metadata

| Export | Kind | Reach | MCP touchpoint |
|--------|------|-------|----------------|
| `crc32` | function | capability | `compute_crc32` (chained over 1 MiB chunks with `seed`; `expect` → `matches`) |
| `createInflator` | function | capability | `inflate_raw` (`method: 'deflate'`, the resumable bounded path fed in 64 KiB chunks) |
| `Inflator` | interface | capability | `push()` / `finished` / `leftover` / `bytesConsumed` / `end()` in `inflate_raw` → `summary.bytesConsumed` / `leftover` / `finished` |
| `getCodec` | function | capability | `inflate_raw` numeric `method` (`decompressSync`), `methodName()` on every `EntryView` row, `describe_engine.codecs[] { sync, stream, incremental }` |
| `registerCodec` | function | unexposed | A codec is executable code; JSON cannot carry one and zipnative ships no extra codec by policy — `inflate_raw` with a method beyond 0 / 8 answers `ZIP_UNSUPPORTED_METHOD` |
| `ZipCodec` | interface | unexposed | The codec contract (same reason); the built-in store / deflate codecs are visible through `describe_engine.codecs` |
| `CodecCompressOptions` | interface | unexposed | Only handed to an injected codec's `compressSync`; no codec can be injected |
| `ZipDecompressor` | interface | unexposed | The incremental decoder of the codec contract (`ZipCodec.createDecompressor`); no codec can be registered here — `describe_engine.codecs[].incremental` reports it for the built-in store and deflate |
| `setDeflateImpl` | function | unexposed | Runtime code injection; the server owns tier selection and reports it (`summary.deflateTier`, `describe_engine.engine.deflateTier`) |
| `setInflateImpl` | function | unexposed | Same — the reader paths run on the tier `initNodeZipCodecs` selected |
| `initNodeZipCodecs` | function | unexposed | A startup concern, not a tool input: `ensureEngineReady()` (`src/engine.ts`) calls it once before serving so every sync codec path — the worker pool included — runs on the `node-zlib` tier |
| `RawEntryMeta` | interface | unexposed | The metadata of `ZipWriter.addRaw`, where the caller vouches for the CRC and the sizes — an agent could forge an inconsistent archive; `merge_zip` exposes the checked `addFromReader` instead |
| `ZipNameDecoder` | type | unexposed | A decoder is a function (`ZipCommonOptions.nameDecoder`); legacy code-page names (Shift-JIS, CP866) stay CP437-decoded with `rawNameHex` kept for forensics |
| `activeDeflateTier` | function | capability | `create_zip.summary.deflateTier` (`activeDeflateTier(compression.deterministic === true)`); `describe_engine.engine.deflateTier { default, deterministic }` |
| `DeflateTier` | type | capability | The value set of those two fields (`pure-pinned` \| `node-zlib` \| `injected` \| `pure`; `injected` never occurs in this server) |
| `METHOD_STORE` / `METHOD_DEFLATE` | const | capability | `methodName()`, `inspect_zip check: 'store-only' / 'deflate-only'` and `assert.method`, `inflate_raw.method` (`'store'` / `'deflate'`), `describe_engine.codecs` |
| `FLAG_DATA_DESCRIPTOR` / `FLAG_ENCRYPTED` / `FLAG_STRONG_ENCRYPTION` / `FLAG_UTF8` | const | capability | `decodeFlags()` → `flags { encrypted, dataDescriptor, strongEncryption, utf8 }` on every `EntryView` row; `inspect_zip.determinism.utf8Flags`; forward `usesDataDescriptor` |
| `VERSION` | const | capability | `describe_engine.engine.version`; the `instructions` field of the opening exchange (initialize / server/discover result) and `__serverMetadata.engineVersion`; the cache key namespace (`CACHE_API_VERSION`); the `zipnativeVersion` pin of `docs/data/*.json` |

### Deliberately unexposed (`UNEXPOSED_EXPORTS`)

The eleven entries `describe_engine.unexposed` returns, verbatim. Every one is unexposed: a whole export is an `unexposed` row above, a member of an exposed export is named unexposed on its owner's row.

| `unexposed[].export` | Reach | Rationale |
|---|---|---|
| `registerCodec` / `ZipCodec` / `CodecCompressOptions` | unexposed | A codec is executable code; JSON cannot carry one and zipnative ships no extra codec by policy. |
| `setInflateImpl` / `setDeflateImpl` | unexposed | Runtime code injection; the server owns tier selection and reports it. |
| `initNodeZipCodecs` | unexposed | Startup concern — called once by the server before serving. |
| `ParallelZipOptions.workerUrl` | unexposed | Filesystem / bundler path injection from a tool argument; the packaged worker resolves itself. |
| `ZipCommonOptions.onDiagnostic` | unexposed | Always installed by the server (every result carries `diagnostics[]`); `strict` is exposed. |
| `ZipReader.bytes` / `ZipModifier.reader` | unexposed | The input itself. |
| `ByteSource` (external `ReadableStream`) | unexposed | JSON-RPC has no stream channel; the server builds ByteSources internally from `zipPath` / `sourcePath`. |
| `ZipWriter.addRaw` / `RawEntryMeta` | unexposed | The caller vouches for the CRC and the sizes; `merge_zip` exposes `addFromReader`, the checked transplant. |
| `ZipCommonOptions.nameDecoder` / `ZipNameDecoder` | unexposed | A decoder is a function; legacy code-page names stay CP437-decoded with `rawNameHex` kept. A label-based input is a later candidate. |
| `ZipCodec.createDecompressor` / `ZipDecompressor` | unexposed | Part of the codec contract; no codec can be registered here. `codecs[].incremental` reports it for store and deflate. |
| `openZipRange over a remote ByteRangeSource` (`rangeSourceFromBytes`) | unexposed | No network path, ever: the byte-range reader is fed only by a sandbox file (`access: 'range'` on `inspect_zip`, `list_zip_entries`, `read_zip_entry`) or by inline bytes. |

The last label names `rangeSourceFromBytes` only to say what the remote source is not: that function **is** exposed (`access: 'range'` on an inline `zipBase64`, its capability row above); what stays unexposed is a remote `ByteRangeSource`. The `nameDecoder` row is the one stance on names everywhere: no name-encoding input in 1.1.0; a label-based, closed-enum input (never a free-form decoder) is a later candidate.

---

## 9. Transport & Environment

Two transports. Default = stdio. Set `ZIPNATIVE_MCP_PORT` to expose a Streamable HTTP endpoint on `http://127.0.0.1:<port>/mcp` instead.

> **MCP protocol version.** The server is built on the MCP TypeScript SDK v2
> (`@modelcontextprotocol/server` ^2.3.1, Apache-2.0) and speaks **MCP 2026-07-28**: stateless serving
> (`server/discover` instead of a session handshake; over HTTP a fresh `Server` per request),
> `resultType` on every result, `ttlMs` / `cacheScope` cache hints (`SERVER_CACHE_HINTS`), the
> `_meta` `serverInfo` envelope, `Mcp-Method` / `Mcp-Name` headers on HTTP (a 2026-07-28 request
> without the `MCP-Protocol-Version` header, or with a header that disagrees with the body, is 400 /
> `-32020`), and resource-not-found reported as `-32602`. Clients that open with `initialize`
> (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) are served by the SDK's
> automatic legacy fallback (`legacy: 'serve'` on stdio, `legacy: 'stateless'` on HTTP), so Claude
> Desktop, Cursor, Continue, Zed, ChatGPT and other existing hosts work unchanged. HTTP `GET` /
> `DELETE` answer 405 (no SSE resumability); any path other than `/mcp` is 404; a body above 256 MiB
> is 413. The low-level `Server` + `setRequestHandler` surface is used deliberately:
> `McpServer.registerTool` would require Standard-Schema inputs and validate `structuredContent`
> against `outputSchema`, breaking the hand-written JSON Schemas, the `verbosity` / `fields`
> projections and the `isError` contract. The stdio transport raises the SDK's default 10 MiB frame
> cap to `STDIO_MAX_FRAME_BYTES` (256 MiB) so multi-MiB base64 archives fit in one frame. On stdio, a
> request sent before the opening exchange is dropped, and JSON-RPC batch arrays are not accepted
> (they are over HTTP).

| Variable | Required | Description |
|----------|----------|-------------|
| `ZIPNATIVE_MCP_OUTPUT_DIR` | No | Absolute path of the sandbox (a relative value refuses to start): the only directory the server reads (`zipPath`, `sourcePath`) or writes (`outputMode: 'file'`, `outputDir`, drafts). Unset = every file input and output disabled; base64 only. |
| `ZIPNATIVE_MCP_CACHE_DIR` | No | Absolute path for the opt-in response cache (§6); a relative value refuses to start. Unset = disabled. |
| `ZIPNATIVE_MCP_PORT` | No | An integer in 1–65535 switches the transport to Streamable HTTP on `127.0.0.1` (any other value refuses to start). Unset = stdio. |
| `ZIPNATIVE_MCP_HTTP_TOKEN` | No | HTTP only, **secret**. Bearer token (≥ 16 chars, no whitespace; a weaker value aborts startup). When set, every `/mcp` request must carry `Authorization: Bearer <token>` or gets 401 + `WWW-Authenticate: Bearer realm="zipnative-mcp"` (`, error="invalid_token"` only when credentials were sent — RFC 6750 §3.1) with a JSON-RPC `-32600` body; compared constant-time (SHA-256 + `timingSafeEqual`), never logged. Unset = no authentication (loopback bind + Host / Origin guard only). |
| `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` | No | Operator ceiling (default 8 GiB = the engine default, minimum 1024) for `limits.maxEntryUncompressedSize`, `limits.maxEntryCompressedSize` and `limits.maxTotalUncompressedSize`. A ceiling below the engine default tightens the default silently. Read once at boot; an invalid value refuses to start. |
| `ZIPNATIVE_MCP_MAX_ENTRIES` | No | Operator ceiling (default 100 000, minimum 1) for `limits.maxEntries` and `scan_zip_forward.maxEntries`. |
| `ZIPNATIVE_MCP_WORKERS` | No | Operator ceiling (default 8, minimum 0) for `create_zip.parallel.workers`; `0` disables worker threads (every `parallel` request runs on the calling thread). |
| `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` | No | The largest file a tool writes in file mode (default 4 GiB = the 1.0.0 cap, minimum 1 MiB), enforced while streaming (`OUTPUT_TOO_LARGE` naming the variable). Raise it for an archive above 4 GiB in the sandbox (the Zip64 streaming opt-in of `create_zip`). |

### Privacy & data handling

- **No telemetry; no network egress, ever.** There is no network code path in the server — no `fetch`, no socket other than the opt-in loopback HTTP listener itself. Archive bytes never leave the process except in the JSON-RPC response to the caller (or into the sandbox the operator configured). `describe_engine.network` is the constant `'none'`; every tool advertises `openWorldHint: false`.
- **Transit.** stdio (default) is a local pipe to the parent process. The opt-in HTTP transport binds **`127.0.0.1`** only **and** enables the SDK's DNS-rebinding protection: `Host` and `Origin` are pinned to the loopback authority, so a web page that reaches the port via a rebound DNS name is rejected with 403; the SDK's Origin check is port-agnostic, so `src/http.ts` additionally requires the `Origin` port to equal the server port. Every response carries `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`; the listener has headers / request / keep-alive timeouts (30 s / 300 s / 5 s) and accepts at most 100 headers. Without `ZIPNATIVE_MCP_HTTP_TOKEN` the endpoint has **no authentication** — any local process can reach it — so set the token whenever that matters. Client-disconnect detection hangs off the per-request response, so keep-alive connections do not accumulate listeners. Terminate TLS in a reverse proxy if you expose it beyond localhost.
- **Extracted content is passed through verbatim.** The server does not execute, render or scan extracted files. Treat content from an untrusted archive as untrusted in the caller.
- **No secret retention.** `ZIPNATIVE_MCP_HTTP_TOKEN` is never logged or echoed; the engine holds no key material (no encryption in 1.x). The response cache stores tool output as plaintext at rest — protect `ZIPNATIVE_MCP_CACHE_DIR` like the sandbox.
- **The engine never touches the filesystem or a socket**; the server's only filesystem access is the sandbox (§5) and the opt-in cache.

---

## 10. Adding a New Tool

1. Create `src/tools/my-tool.ts` exporting `MY_TOOL_NAME`, `MY_TOOL_INPUT_SCHEMA` (hand-written JSON Schema `as const`, `additionalProperties: false`), optionally `MY_TOOL_OUTPUT_SCHEMA` (+ `MY_TOOL_SUMMARY_PROPERTIES` and a `mySummary()` for a read tool), a Zod `.strictObject` twin, and `myTool(args: unknown, context: CallContext): Promise<MyResult>`. Reuse the shared fragments (`ARCHIVE_INPUT_PROPERTIES` / `ARCHIVE_INPUT_SHAPE` + `refineArchiveInput`, `ACCESS_INPUT_PROPERTY`, `LIMITS_INPUT_SCHEMA`, `FILTER_INPUT_SCHEMA`, `PROJECTION_INPUT_PROPERTIES` / `ProjectionShape`, `OUTPUT_INPUT_PROPERTIES`). Wrap every engine call in `guard` / `guardAsync`; install a diagnostic sink with the call context; go through `loadArchive` / `openArchive` / `readInputFile` / `emitArchive` for every byte in and out — never touch the filesystem directly.
2. Register in [src/server.ts](../src/server.ts): the `TOOLS` array (`kind` — add a `dispatchOutput` branch if none fits, `title`, `description`, `annotations`, ≤ 2 executable `examples`), the `ToolOutput` union, and the `SERVER_INSTRUCTIONS` decision tree.
3. Add `tests/<tool-name>.test.ts`: happy path (base64), file mode, every error code the tool raises, the hostile fixtures it must refuse; every archive it produces must pass `assertValidZip` (`tests/_zip-assert.ts` — ISO conformance included). Add a corpus entry in `scripts/helpers/zip-corpus.mjs` if the tool writes archives.
4. Refresh the catalogue fingerprint (`npm run build && npx tsx scripts/tool-shape.ts --write`) so `tests/catalogue-parity.test.ts` passes, and review the structural diff under `API_STABILITY.md` §5 (a new tool is a minor). Never regenerate `tests/_fixtures/tool-shape.v1.0.0.json`; `tests/catalogue-superset.test.ts` must stay green.
5. Update this document (§2 tree, §4, §8 if a new engine export is touched — and `docs/data/core-exports.json` with it), [`AI_GUIDE.md`](AI_GUIDE.md), the README matrix and tool reference, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) (§1 catalogue, §2 decision tree, §6 for every new error code), `llms.txt`, `server.json`, `API_STABILITY.md` §5, a worked example under `examples/` (and its sample with `npm run test:generate`), `docs/assets/ecosystem.json` (`derived.tools`, `toolGroups`), and `CHANGELOG.md` `[Unreleased]`. `npm run verify:docs` and `tests/docs-consistency.test.ts` enforce the counts.
6. Decide whether the change bumps `_meta.apiVersion` — see [`API_STABILITY.md`](API_STABILITY.md).

---

## 11. Development Quick Reference

```bash
npm install
npm run gate              # the CI profile: every step, one line each (logs under test-output/.gate/)
npm run gate:fast         # typecheck:all, lint, test, server-json, verify:docs
npm run typecheck:all
npm run lint              # eslint src --max-warnings 0
npm run test
npm run test:coverage     # thresholds 94 / 90 / 95 / 94 (vitest.config.ts)
npm run build             # tsc -p tsconfig.build.json → dist/
npm run examples:check    # tests/examples.test.ts only
npm run test:generate && npm run verify:samples   # the examples through the built server, against the sample baseline
npm run verify:docs       # the 28 documentation rules
npm run validate:zip      # build + corpus:zip + veraZIP (level 0 always; level 1 with the foreign tools present)
npm run verify:issue -- <draft.md>
npx tsx scripts/tool-shape.ts --write   # refresh the catalogue fixture after a deliberate schema change
```

CI (`ci.yml`) runs `npx tsx scripts/gate.ts --ci --require-all` on Linux (Node 22 / 24) and on Windows and macOS; `verazip.yml` runs the conformance gate on Linux **and** Windows with `VERAZIP_REQUIRED=1` and is **blocking**; `sample-regression.yml` regenerates the samples and verifies them against the baseline chain; `docs.yml` runs `verify:docs`; `publish.yml` runs four jobs on a published GitHub Release — verify (`gate.ts --publish --require-all`, one `npm pack`, the SBOM, the digests) → publish (npm Trusted Publishing with provenance) → attest → registry (the MCP registry). Full local workflow: [`guides/LOCAL_TESTING.md`](guides/LOCAL_TESTING.md).

---

## 12. Security Design Notes

- **One filesystem boundary** — `src/sandbox.ts`: reads and writes resolve against `ZIPNATIVE_MCP_OUTPUT_DIR`; relative paths only; NUL, absolute, UNC and `..` rejected; container-extension allow-list on archive paths; realpath re-check on every parent after `mkdir -p`; every read goes through **one open handle** whose real path is proven inside the sandbox and bound to the handle by device and inode (`zipPath`, `sourcePath`, `merge_zip` sources, `resources/read`, the scanner and the byte-range reader — a planted symlink or junction is `SECURITY_VIOLATION`, a dangling link stays `INPUT_NOT_FOUND`, a file that changes under the read is `IO_ERROR`); `wx` opens (never overwrite); partial files removed on failure or cancellation; absolute paths never leak into messages. Unset sandbox = no file I/O except the opt-in response cache under `ZIPNATIVE_MCP_CACHE_DIR`.
- **Engine defaults never weakened** — `rejectTraversal`, `rejectSymlinks`, `onDuplicate: 'error'` and the `ZipLimits` bounds are the engine's; opt-outs are named inputs that *skip* (unsafe names) or *degrade to data* (symlink targets), never write anything unsafe; overlap and central/local divergence have no opt-out. The engine's sanitized path is the only thing ever joined onto a directory. `modify_zip` opens its input eagerly, `merge_zip` verifies every entry before the copy by default, and `addRaw` stays unexposed.
- **Limits under ceilings** — `limits.*` per call, capped by the operator ceilings (`LIMIT_CEILING_EXCEEDED` names the variable); the engine enforces sizes and ratios while inflating (CWE-400 / CWE-409); `limits.maxEntryCompressedSize` bounds what the byte-range reader fetches into memory for one entry (CWE-770).
- **Memory envelope** — every inline byte counted (`src/caps.ts`): 128 MiB decoded input, 16 MiB per inline entry, 32 MiB per inline extraction, 50 MiB per inline output, 1 GiB buffered path input (byte ranges above it), 1 GiB in all for the `merge_zip` sources, the file-output ceiling (default 4 GiB) for streamed file output, 256 MiB frame / body; JSON-shaped inputs bounded (100 000 entries, 1000 operations, 32 merge sources, 10 000 names, 1000 filter names, 32 globs of ≤ 1024 characters, 16 extra fields, 16 `fields` paths, 16 384 characters per governance text field); the `resources/list` walk (1000 entries, depth 8, 50 MiB per read) and the cache (3600 s, 256 MiB) bounded from the same module; diagnostics capped at 200 and determinism offenders at 200 per result. Every one of these constants is a key of `CAPS` and therefore of `describe_engine.caps`.
- **Linear-time matching** — `compileGlob` is a Thompson NFA over a token list, not a backtracking `RegExp` (CWE-1333); the governance dependency pattern does not backtrack either; an inverted class range is `VALIDATION_ERROR`.
- **Input validation** — strict Zod at every boundary (unknown keys rejected); base64 diagnosed before the engine sees it; dates bounded to the DOS range; extra field `0x0001` refused; `maxOutput` mandatory on `inflate_raw`; `fields` paths refuse prototype segments and the projection walks own properties only.
- **No network** — no network code path; `openWorldHint: false` on every tool; the byte-range reader takes a sandbox file only; `draft_governance_issue` never submits.
- **HTTP hardening** — loopback bind, Host / Origin guard with the Origin port pinned, 405 on GET / DELETE, 413 above 256 MiB, server timeouts and a header-count bound, `nosniff` / `no-store` headers, opt-in constant-time bearer token, per-response disconnect detection.
- **Coded error boundary** — an escaped non-`ToolError` is `ENGINE_ERROR` with `errorClass: 'internal'` and absolute paths redacted; a cancelled call is `CANCELLED` in-process (over MCP it gets no response).
- **Cache hygiene** — path inputs, file mode, wall-clock and worker calls, cancelled calls, `describe_engine` and `draft_governance_issue` are never cached; the key is namespaced by tool API + package + engine version and the four operator ceilings.
- **Diagnostics never on stdout** — the sink is always installed, so the engine's `console.warn` fallback cannot corrupt the stdio wire; ESLint `no-console` holds `src/` to it.
- **Configuration errors fail loud** — a weak token, an invalid ceiling, a port outside 1–65535 or a relative sandbox path prints one clean `fatal:` line and exits 1; never a silent fallback.
- **Strict TypeScript** — `strict: true`, no `any`, `unknown` + narrowing, explicit return types on exports; ESLint with zero warnings.
- **Conformance is not safety** — every archive the server writes passes the ISO/IEC 21320-1 validator, and the four hostile-but-conformant corpus entries (zip-slip, device name, duplicate paths, a symlink entry) are exactly why the guards above exist on top of it.

See [`guides/SECURITY.md`](guides/SECURITY.md) for the threat table with CWE ids, [`guides/DETERMINISM.md`](guides/DETERMINISM.md), [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md), [`guides/LARGE_ARCHIVES.md`](guides/LARGE_ARCHIVES.md), [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md) and [`AI_GUIDE.md`](AI_GUIDE.md) for usage-oriented notes.
