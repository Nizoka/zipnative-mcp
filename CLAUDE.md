# CLAUDE.md

Guidance for Claude Code (and other Claude-based agents) working in this repository.
For the runtime tool catalogue and end-user recipes, read [`AGENTS.md`](AGENTS.md);
for the conformance gate, [`docs/guides/CONFORMANCE.md`](docs/guides/CONFORMANCE.md). This
file is about *contributing to* the codebase, not *using* the server.

## What this is

`zipnative-mcp` is a thin, faithful **Model Context Protocol** server wrapping the
zero-dependency [`zipnative`](https://github.com/Nizoka/zipnative) ZIP engine.
TypeScript (strict, ESM-only), Node ≥ 22, `@modelcontextprotocol/server` (MCP SDK v2,
protocol 2026-07-28 with automatic 2025-era fallback). **13 tools**, 7 MCP prompts +
resources. Three runtime dependencies (zipnative, the MCP SDK, zod). No network code
path exists. Current release: **1.0.0** (on zipnative 1.0.0).

## Commands

```bash
npm run build          # tsc -p tsconfig.build.json  (emits dist/)
npm run typecheck:all  # tsc --noEmit  (covers src + tests)
npm run lint           # eslint src --max-warnings 0
npm test               # vitest run
npm run test:coverage  # vitest run --coverage  (enforces thresholds)
npm run examples:check # runs examples/*.json live through the tools/call handler
npm run verify:issue   # governance draft checker (scripts/verify-issue.mjs)
npm run corpus:zip     # writes the veraZIP corpus through the real tools (test-output/zip/)
npm run validate:zip   # BLOCKING: build + corpus + ISO/IEC 21320-1 validation of every archive the server writes
node scripts/tool-shape.mjs --write   # ONLY after a deliberate tools/list schema change — refreshes tests/_fixtures/tool-shape.json (catalogue parity gate)
```

**Quality gate (run before every commit/PR):**

```bash
npm run typecheck:all && npm run lint && npm run test && npm run test:coverage && npm run build && npm run validate:zip
```

Coverage thresholds (global, in `vitest.config.ts`): statements 94 · branches 90 ·
functions 95 · lines 94. New code must keep the aggregate above these; never lower them.

## Architecture map

- `src/cli.ts` — entry point (stdio via `serveStdio` by default with the frame cap raised to 256 MiB; Streamable HTTP via `createMcpHandler` when `ZIPNATIVE_MCP_PORT` is set; both with the SDK's legacy fallback). Reads the three operator ceilings once at boot — an invalid value refuses to start.
- `src/http.ts` — Node `http` ↔ Web `Request`/`Response` bridge, the 256 MiB body cap (413) and the Host/Origin loopback guard for the HTTP transport. `src/auth.ts` — opt-in bearer token (`ZIPNATIVE_MCP_HTTP_TOKEN`, ≥ 16 chars, constant-time compare).
- `src/server.ts` — the `TOOLS` registry (with `kind`, MCP `annotations`, ≤ 2 `_meta.examples`), request handlers on the low-level `Server` (not `McpServer.registerTool`; the read tools' output schemas are projectable — every property optional — so `structuredContent` always validates), `dispatchOutput` (kind → content builder: archives arrive once as an embedded `resource` block, file mode as a `resource_link`), `callToolDirect` (transport-agnostic `tools/call`, used by tests and the corpus generator), `listToolsPayload`, `toolNames`, `SERVER_INSTRUCTIONS`, `SERVER_CACHE_HINTS`, the 7 `PROMPTS`, the `resources` capability, the cache gate (`isCacheable`).
- `src/tools/<name>.ts` — one file per tool: `<NAME>_NAME`, a hand-written JSON Schema `<NAME>_INPUT_SCHEMA` `as const`, a **parallel Zod schema** (kept in lock-step), an optional `<NAME>_OUTPUT_SCHEMA` (+ `<NAME>_SUMMARY_PROPERTIES` and a `…Summary()` projection for the read tools), the handler and its result type. Registration order: `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `create_zip`, `modify_zip`, `compute_crc32`, `inflate_raw`, `describe_engine`, `draft_governance_issue`. `src/tools/_shared.ts` — `parseInput` (→ `VALIDATION_ERROR`), `ProjectionShape`, `EngineOptionsShape`, `STRICT_INPUT_PROPERTY`, `sha256Hex`.
- Shared modules: `src/caps.ts` (every byte / count cap as a constant + the operator ceilings `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` / `ZIPNATIVE_MCP_MAX_ENTRIES` / `ZIPNATIVE_MCP_WORKERS`, `readCeilings` / `getCeilings`, `CAPS` for `describe_engine`), `src/limits.ts` (the eight `ZipLimits` keys as `LIMITS_INPUT_SCHEMA` / `LimitsSchema`, `resolveCallLimits` → `LIMIT_CEILING_EXCEEDED`), `src/sandbox.ts` (the single filesystem boundary `ZIPNATIVE_MCP_OUTPUT_DIR`: `ZIP_CONTAINER_EXTENSIONS`, `resolveOutputFile` / `resolveOutputDir` / `resolveInputFile`, `assertRealpathInside`, exclusive `wx` writes, `mapWriteError`), `src/archive-input.ts` (`zipBase64` XOR `zipPath`, `loadArchive`, `openArchiveSource` for the forward scanner, `isPathInput`), `src/base64.ts` (boundary decoding with agent-facing diagnostics — use it for every base64 input), `src/zip-errors.ts` (the ONLY place that reads `err.code`: `mapZipError` / `guard` / `guardAsync`, `ZIP_ERROR_CLASS` typed `satisfies Record<ZipErrorCode, …>`, `ZIP_ERROR_CODES` (39), `ZIP_DIAGNOSTIC_CODES` (11), zlib → ZIP mapping), `src/diagnostics.ts` (`createDiagnosticSink` — every engine call goes through it so nothing reaches stdout; `diagnostics[]` de-duplicated, capped at 200), `src/entry.ts` (`EntryView`, `viewFromEntry` / `viewFromHeader`, `ENTRY_VIEW_SCHEMA` — the CLI's row shape), `src/filter.ts` (`compileGlob`, `compileEntryFilter`, `FILTER_INPUT_SCHEMA`), `src/entry-spec.ts` (create / modify payloads: compression, dates, unixMode / externalAttributes, extra fields, `loadPayload`), `src/engine.ts` (`ensureEngineReady` — `initNodeZipCodecs` once; `probeRuntime`), `src/output.ts` (`emitArchive`, `emitArchiveStream`, `writeSandboxedText`, `OUTPUT_INPUT_PROPERTIES`), `src/resources.ts` (`zipnative://output/{+path}` over every regular sandbox file, MIME by extension, 50 MiB read cap), `src/projection.ts` (token-frugal `verbosity` / `fields`), `src/cache.ts` (`ZIPNATIVE_MCP_CACHE_DIR`, SHA-256 keyed, 1 h TTL, 256 MiB LRU), `src/governance.ts` (HITL contract text + `validateIssueMarkdown`), `src/errors.ts` (`ToolError`, `SecurityError`, `GovernanceError`), `src/version.ts` (`ZIPNATIVE_MCP_VERSION`, `TOOL_API_VERSION`), `src/index.ts` (library exports).
- `scripts/` — `verazip-core.mjs` (+ `.d.mts`): the vendored engine-independent ISO/IEC 21320-1 validator (`validateArchive`, `CHECK_IDS` (22), `REQUIRED_NEGATIVE_CHECKS` (4)); `generate-zip-corpus.mjs` (writes `test-output/zip/` + `manifest.json` through `callToolDirect` and the raw builder); `validate-zip.mjs` (the gate; level 1 uses `helpers/interop-tools.mjs`); `tool-shape.mjs`; `verify-issue.mjs`.
- `tests/` — one `*.test.ts` per tool/module; shared fixtures are `_`-prefixed (`_zip-fixtures.ts` — benign archives built through the engine, hostile ones through the vendored raw builder `_fixtures/raw-zip-builder.ts`; `_zip-assert.ts` — `assertValidZip` / `assertIsoConformant` / `expectCheck`; `_http-fixture.ts`; `_mcp-harness.ts`). `tests/http-modern.test.ts` asserts the MCP 2026-07-28 conformance; `tests/catalogue-parity.test.ts` compares `tools/list` with `tests/_fixtures/tool-shape.json`; `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen baseline for the future superset gate (never regenerate it); `tests/docs-consistency.test.ts` checks the counts and names quoted in the docs against the code; `tests/examples.test.ts` runs `examples/*.json`; `tests/fixtures/interop/*.zip` are foreign-tool archives (bsdtar, PowerShell).

## Non-negotiable conventions

1. **Zero new runtime dependencies.** Only `zipnative`, `@modelcontextprotocol/server`, `zod`. Adding one is a governance blocker (`.github/AGENT_RULES.md`).
2. **Faithful thin wrapper.** Surface zipnative behaviour honestly; don't reimplement engine features on raw primitives, and don't over-promise (e.g. `modify_zip` mode `'append'` leaves removed content recoverable; `scan_zip_forward` is not authoritative; there is no decryption — say so). Engine security defaults stay on; every relaxation is an explicit, named input.
3. **Strict TypeScript.** No `any` (use `unknown` + narrowing). No unused locals/params. ESM with `.js` suffixes on relative imports, explicit return types on exports, 4-space indent, single quotes, trailing commas.
4. **Validate every input** at the boundary with Zod — every object schema is `.strictObject()` (unknown keys → `VALIDATION_ERROR`), matching `additionalProperties: false`; keep the JSON Schema and Zod schema aligned (they are hand-kept in sync; shared fragments live in `limits.ts`, `filter.ts`, `entry-spec.ts`, `projection.ts`, `output.ts`, `archive-input.ts`). No `$schema`, no `$ref` / `$defs` in input schemas. Unknown tool names are a JSON-RPC `-32602` protocol error (`[UNKNOWN_TOOL]`), not an `isError` result.
5. **Additive & byte-identical.** Default responses for existing tools stay byte-identical across releases; new behaviour is opt-in with backward-compatible defaults. A schema or error-code change may require a `TOOL_API_VERSION` bump and always needs a reviewed `tests/_fixtures/tool-shape.json` refresh. Wording (descriptions, `_meta.examples` ≤ 2 per tool, `SERVER_INSTRUCTIONS`, prompt texts) is free to change. The archives the tools write are ISO/IEC 21320-1 conformant — a change to what gets written must keep `npm run validate:zip` green.
6. **Security.** Never write or read outside `ZIPNATIVE_MCP_OUTPUT_DIR` (use `src/sandbox.ts` — it rejects absolute / UNC paths, traversal, NUL bytes, non-container extensions, checks the parent's real path and opens files exclusively). Never add a network path: this server has none, and no tool argument may ever name a URL or an endpoint. Never weaken an engine default silently (`rejectTraversal`, `rejectSymlinks`, `onDuplicate`, the `ZipLimits` bounds, overlap / CD-LFH / Zip64 checks) — a relaxation is a named input the caller sets. Operator ceilings are read once at boot (`src/caps.ts`; an invalid value must refuse to start, never fall back silently) and a per-call `limits.*` value can never exceed them. Never log or echo `ZIPNATIVE_MCP_HTTP_TOKEN`. Never cache path inputs, file output, wall-clock dates, `parallel` or the two non-cacheable tools. Every engine call goes through a diagnostic sink (nothing may reach stdout on the stdio transport).
7. **No ZIP parsing of its own.** All ZIP logic lives in zipnative; the wrapper never reads a PK signature. The only sanctioned raw parsers are `scripts/verazip-core.mjs` (the engine-independent validator — it must never import zipnative) and the raw builders (`tests/_fixtures/raw-zip-builder.ts`, used only to craft hostile / negative fixtures). `src/zip-errors.ts` is the only module that reads `err.code`.
8. **Version lock-step.** `tests/metadata.test.ts` asserts `package.json`, `server.json`, `src/version.ts` and `CITATION.cff` agree. Update all together.

## Adding a tool (the pattern)

1. Create `src/tools/<name>.ts`: export `<NAME>_NAME`, `<NAME>_INPUT_SCHEMA` (`as const`, `additionalProperties: false`, composed from the shared fragments), the parallel Zod `strictObject`, optional `<NAME>_OUTPUT_SCHEMA` (+ `<NAME>_SUMMARY_PROPERTIES` and a summary projection for a read tool), and the async handler (`parseInput` → `loadArchive` / `loadPayload` → engine call under `guard` / `guardAsync` with a diagnostic sink → return a result object or `emitArchive(...)`).
2. Register it in the `TOOLS` array in `src/server.ts` with `kind`, `annotations` and ≤ 2 `_meta.examples`. If it returns a **new result shape**, add a `ToolKind`, a `dispatchOutput` branch and a `build…Result` / summary function; if it is projectable, wrap its output schema with `projectableOutputSchema`.
3. If the tool writes archives, add a corpus entry to `scripts/generate-zip-corpus.mjs` so every writer path is validated by `npm run validate:zip`, and assert `assertValidZip` on every archive its tests produce.
4. Add `tests/<name>.test.ts` (success, each error code, projection, file mode against a temporary sandbox) and an `examples/<name>.json` (placeholder-free or using the documented placeholder vocabulary; file-mode examples are documentation-only).
5. Run `npm run build && node scripts/tool-shape.mjs --write` to refresh the catalogue-parity fixture (reviewed, deliberate).
6. Update the docs: README tool table + `### \`<tool>\`` reference, `AGENTS.md` §1 catalogue (`## 1. Tool catalogue (N tools)`) + §2 decision tree + §6 error table, `llms.txt` (`## Tools (N)`), the `13 tools` phrase in `package.json`, `server.json`, `CITATION.cff` and this file, `SERVER_INSTRUCTIONS`.
7. Bump `TOOL_API_VERSION` if a schema or error code changed; add the `CHANGELOG.md` `[Unreleased]` entry.
8. Run the full quality gate including `npm run validate:zip`; `tests/docs-consistency.test.ts` and `tests/examples.test.ts` must stay green.

## Release process

- Decide SemVer level first (new tool / new optional field ⇒ **minor**; a byte change in what `create_zip` writes with `compression.deterministic: true` is the engine's semver-major contract — never absorb one silently).
- `release-notes/vX.Y.Z.md` is **mandatory** and mirrored into `CHANGELOG.md` (no emojis in release notes).
- Bump the four version references in lock-step; bump `TOOL_API_VERSION` only when a schema or error code changes.
- The veraZIP gate (`npm run validate:zip`) is blocking on Linux and Windows and runs again before publish.
- Publishing is automated via GitHub Actions **Trusted Publishing (OIDC)** on a published GitHub Release — no `NPM_TOKEN`, `--provenance`, CycloneDX SBOM attached.

## Human-in-the-loop governance

This server is a **draftsman, never an autonomous submitter**. It has no GitHub write
path and no network code path at all — no telemetry, no URL from any argument, no
operator-configurable endpoint. To propose an upstream change, use the
`draft_governance_issue` tool (or `npm run verify:issue`) to produce a local,
policy-checked draft — a human reviews and submits it under their own identity. Engine
root causes (parser, writer, limits, codecs) belong in `Nizoka/zipnative`; wrapper
behaviour (schemas, sandbox, transport) in `Nizoka/zipnative-mcp`. See
[`.github/AGENT_RULES.md`](.github/AGENT_RULES.md) and the `governance_contract` /
`draft_issue_workflow` prompts.

## Working style (token-aware)

Gather context in parallel, then act. Make targeted edits — don't reprint whole
files. Let the diff speak: no change-summary essays, no new top-level docs unless
asked. Reuse the scoped rules in `.github/instructions/*.md` rather than re-deriving
conventions. Windows is a first-class dev host: use `node:path` helpers, never
hard-code separators, and keep every test green on win32 and linux.
