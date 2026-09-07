# zipnative-mcp - Project Guidelines

> Full context (tool catalogue, decision tree, output modes, error reference):
> [`AGENTS.md`](../AGENTS.md) and [`docs/guides/*.md`](../docs/guides/). Don't duplicate it here.

## Overview

MCP server bridging the zipnative ZIP engine (v1.0.x, zero dependencies, pure
TypeScript) to AI clients over stdio or Streamable HTTP, on the MCP TypeScript SDK
v2 (`@modelcontextprotocol/server`, MCP 2026-07-28 with automatic 2025-era
fallback). 13 tools, 7 prompts, native resources over the sandbox. Current release
1.0.0. Three runtime dependencies (zipnative, the MCP SDK, zod) — never add one.
Quality bar: production-grade OSS (strict TypeScript, strong validation, secure
file IO inside ONE sandbox, no network code path at all, deterministic releases,
ISO/IEC 21320-1 conformance validated in CI — the veraZIP gate).

## Architecture (one line each)

- src/cli.ts — stdio (`serveStdio`) / Streamable HTTP (`createMcpHandler`) entry point; reads the operator ceilings once (an invalid value refuses to start).
- src/http.ts — Node http ↔ Web Request/Response bridge + Host/Origin loopback guard (DNS-rebinding protection).
- src/auth.ts — opt-in HTTP bearer token (`ZIPNATIVE_MCP_HTTP_TOKEN`, ≥ 16 chars, constant-time compare, 401 + WWW-Authenticate).
- src/server.ts — tool registry (`kind`, MCP annotations, `_meta.examples`) + request handlers on the low-level `Server` + SERVER_INSTRUCTIONS + SERVER_CACHE_HINTS + prompts; `callToolDirect` runs one call exactly as `tools/call` does; `listToolsPayload`, `toolNames`.
- src/tools/* — one file per tool (JSON Schema `as const` + parallel Zod `.strictObject` + handler + result type); `_shared.ts` has `parseInput`, `ProjectionShape`, `EngineOptionsShape`, `sha256Hex`.
  - inspect-zip.ts — eager archive report, determinism verdict, `check:[…]` / `assert:{…}` CI gate.
  - list-zip-entries.ts — paged central-directory inventory (filter, offset/limit, eager option).
  - read-zip-entry.ts — one entry by name/index: data (base64/utf8, `range` window), raw payload, or verify.
  - verify-zip.ts — the engine's `verifyZip` report verbatim; never isError for an archive problem (`ok` / `error{code}` / `skipped`).
  - extract-zip.ts — secure-by-default extraction (rejectTraversal / rejectSymlinks / onDuplicate / limits); inline (dry run with `includeData:false`) or streamed under a sandbox `outputDir`.
  - scan-zip-forward.ts — the forward, central-directory-less reader; NOT authoritative (local headers only); `tolerateTruncation`.
  - sanitize-entry-paths.ts — `sanitizeEntryPath()` over a list of names (the traversal gate) with the rule that fired.
  - create-zip.ts — deterministic archive creation (`createZip` / `createParallelZip`): order, dates, compression + `deterministic` pin, comments, attributes, extra fields, `stream:true` sources, base64 or streamed file output.
  - modify-zip.ts — incremental edits via `createZipModifier` (add/replace/remove/rename/setComment), `append` (remanence) vs `compact`.
  - compute-crc32.ts — CRC-32 of inline data or a sandbox file (1 MiB chunks, `seed`, `expect`).
  - inflate-raw.ts — bounded raw-DEFLATE inflation through the resumable inflater (`maxOutput` mandatory, `leftover`).
  - describe-engine.ts — offline capability preflight (versions, deflate tier, codecs, limits, ceilings, caps, sandbox/cache state, error + diagnostic vocabularies).
  - draft-governance-issue.ts — LOCAL governance-compliant issue draft + compliance report; never submits (HITL).
- src/archive-input.ts — `zipBase64` XOR `zipPath` (sandbox), `loadArchive`, `openArchiveSource` (bounded ByteSource), `isPathInput`.
- src/base64.ts — base64 boundary helpers with agent-facing diagnostics (data: URI, PEM, double encoding).
- src/cache.ts — opt-in content-addressed response cache (`ZIPNATIVE_MCP_CACHE_DIR`, SHA-256 key, 1 h TTL, LRU sweep); never for paths, file output, `defaultDate:'now'`, `parallel`, describe_engine, draft_governance_issue.
- src/caps.ts — every byte/count bound on top of the engine's `ZipLimits` (frames, inline caps, list/create/modify/sanitize/diagnostics caps) + the operator ceilings (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`; `readCeilings` / `getCeilings`).
- src/diagnostics.ts — `createDiagnosticSink`: every engine call's `onDiagnostic` goes through a sink; every result carries `diagnostics[]` (de-duplicated, capped at 200) + `diagnosticCounts`.
- src/engine.ts — `ensureEngineReady` (node:zlib codec tier, memoised) and `probeRuntime`.
- src/entry.ts — the shared `EntryView` JSON row (`viewFromEntry` / `viewFromHeader`, `ENTRY_VIEW_SCHEMA`): decoded flags, methodName, CRC hex, unix mode, named extra fields, sanitizedPath.
- src/entry-spec.ts — the per-entry payload for create/modify (`dataBase64` | `text` | `sourcePath` | `directory`, compression, date, comment, unixMode / externalAttributes, extraFields) → `AddEntryOptions`.
- src/errors.ts — `ToolError(code, message, data?)`, `SecurityError`, `GovernanceError`.
- src/filter.ts — entry filters (exact names / prefix / globs, vendored glob matcher) shared by list / extract / scan / verify.
- src/governance.ts — runtime source of truth for the AI-governance / HITL contract (`validateIssueMarkdown`, `DEPENDENCY_PATTERNS` byte-identical to `scripts/verify-issue.mjs`, prompt texts).
- src/limits.ts — the `limits` input fragment (the eight `ZipLimits` keys) + `resolveCallLimits` → `LIMIT_CEILING_EXCEEDED` naming the env var.
- src/output.ts — `emitArchive` / `emitArchiveStream` (base64 ≤ 50 MiB or exclusive sandbox file ≤ 4 GiB, streamed) + `writeSandboxedText`.
- src/projection.ts — token-frugal `verbosity:'summary'` / `fields:[…]` projection (`selectFields`, `_meta.unmatchedFields`).
- src/resources.ts — native MCP resources `zipnative://output/{+path}` over the sandbox (any regular file, MIME by extension) + `resource_link`s.
- src/sandbox.ts — the single filesystem boundary (`ZIPNATIVE_MCP_OUTPUT_DIR`): NUL / absolute / UNC / `..` guards, `ZIP_CONTAINER_EXTENSIONS` allow-list, realpath check on the parent for writes and on the file itself for reads (`zipPath` / `sourcePath` / `resources/read`), `wx` exclusive writes (never overwrites).
- src/version.ts — `ZIPNATIVE_MCP_VERSION` and `TOOL_API_VERSION` (both 1.0.0; in lock-step with package.json / server.json / CITATION.cff).
- src/zip-errors.ts — the ONLY place that reads `err.code`: 39 frozen `ZIP_*` codes passed through verbatim (`mapZipError`, `guard`, `guardAsync`), 11 diagnostic codes.
- src/index.ts — public library entry (server factory + types).
- scripts/ — veraZIP: `verazip-core.mjs` (vendored ISO/IEC 21320-1 validator, no imports), `validate-zip.mjs` (driver, levels 0/1), `generate-zip-corpus.mjs` (drives dist/server.js), `helpers/zip-corpus.mjs` (the corpus, shared with tests), `helpers/raw-zip-builder.mjs` (engine-independent raw writer), `helpers/interop-tools.mjs` (foreign tools); `tool-shape.mjs` (catalogue fixture); `verify-issue.mjs` (draft verifier).
- tests/* — one `tests/<name>.test.ts` per tool/module; `_`-prefixed shared fixtures (`_zip-fixtures.ts` builds benign archives through the engine and hostile ones with the raw builder; `_zip-assert.ts` = magic + eager open + verifyZip + ISO conformance); `verazip.test.ts` runs the corpus in-process; `verazip-vendor.test.ts` pins the vendored scripts; `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen catalogue baseline (never regenerate it).

## Core conventions

- Strict TypeScript, ESM, `.js` suffix in relative imports; no `any` (use `unknown` + narrowing); explicit return types on exports; 4-space indent, single quotes, trailing commas.
- Validate every tool input at the boundary with Zod (`.strictObject` — unknown keys are a
  `VALIDATION_ERROR`); keep the hand-written JSON Schema (`as const`, `additionalProperties: false`)
  and the Zod schema aligned. No `$ref` / `$defs` in input schemas (host compatibility).
- Faithful thin wrapper: no ZIP logic in `src/` — every byte-level operation is an engine call;
  engine security defaults stay ON; relaxations are explicit, named inputs; `limits.*` can never
  exceed the operator ceilings.
- Error contract: `content[0].text = "<tool> failed [CODE]: message"`, `isError: true`,
  `_meta.error = { code, message, data? }`. Codes are the 39 `ZIP_*` engine codes verbatim plus the
  wrapper codes listed in AGENTS.md §6. Unknown tool name on `tools/call` is a JSON-RPC `-32602`
  `[UNKNOWN_TOOL]` protocol error.
- `tools/list` is structurally fingerprinted: after a deliberate schema change run
  `npm run build && node scripts/tool-shape.mjs --write` (refreshes `tests/_fixtures/tool-shape.json`)
  and bump `TOOL_API_VERSION` when a cached response would become unsafe.
- Never read or write outside `ZIPNATIVE_MCP_OUTPUT_DIR`; unset = base64 only. File outputs are
  exclusive (`wx`), never overwritten; `outputPath` must end in a container extension.
- Never echo `ZIPNATIVE_MCP_HTTP_TOKEN` or absolute sandbox paths in errors or logs.
- No network code path, ever — not even behind an env var. `describe_engine.network` is `'none'`.
- Operator env vars (7): ZIPNATIVE_MCP_OUTPUT_DIR, ZIPNATIVE_MCP_CACHE_DIR, ZIPNATIVE_MCP_PORT,
  ZIPNATIVE_MCP_HTTP_TOKEN, ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES, ZIPNATIVE_MCP_MAX_ENTRIES,
  ZIPNATIVE_MCP_WORKERS.
- Docs are contracts: counts and names quoted in README.md / AGENTS.md / llms.txt / server.json /
  docs/data/*.json are asserted by `tests/docs-consistency.test.ts`. English everywhere; no emojis in
  release notes.
- Every archive a test produces through a tool must pass `assertValidZip` (ISO conformance included).
- `npm run lint` is `eslint src --max-warnings 0` — warnings fail the gate. CI runs on Linux (Node 22 / 24) and Windows; the veraZIP gate is blocking on both.

## Quality gate (all PRs)

`npm run typecheck:all && npm run lint && npm run test && npm run test:coverage && npm run build`

Plus `npm run validate:zip` (build + corpus + ISO/IEC 21320-1 validation, level 1 with whatever
foreign tools the machine has) for anything touching what the tools write: create_zip, modify_zip,
inflate_raw, the sandbox / output modules, or the engine version.

## Release process

- release-notes/vX.Y.Z.md is mandatory; CHANGELOG.md mirrors it.
- Bump package.json, server.json, CITATION.cff and `src/version.ts` together (asserted by tests).
- GitHub Release title: `vX.Y.Z - short description`.
- npm publish via GitHub Actions Trusted Publishing (OIDC), no NPM_TOKEN; the publish job re-runs the
  full gate + the veraZIP gate and attaches a CycloneDX SBOM to the release.

## Working efficiently (token-aware)

Optimize for minimal tokens in both planning and implementation, without lowering
quality:

- Gather context in parallel, then act; don't re-read files already in context.
- Make targeted edits — don't reprint whole files or restate unchanged code.
- Keep replies concise: no preambles, no change-summary essays, no new markdown
  docs unless asked. Let the diff speak.
- Reuse the scoped `.github/instructions/*.md` rather than re-deriving conventions.
- Prefer `verbosity:'summary'` / `fields:[…]` when calling the read tools yourself.
