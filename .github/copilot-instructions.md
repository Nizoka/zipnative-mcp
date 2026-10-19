# zipnative-mcp - Project Guidelines

> Repository rules shared by every coding agent: [`AGENTS.md`](../AGENTS.md) — keep this file consistent with it.
> Contract for agents that *use* the server (tool catalogue, decision tree, token economy, error codes):
> [`docs/AGENT_CONTRACT.md`](../docs/AGENT_CONTRACT.md); the guides: [`docs/guides/`](../docs/guides/). Don't duplicate them here.

## Overview

MCP server bridging the zipnative ZIP engine (1.1.x, zero dependencies, pure
TypeScript) to AI clients over stdio or Streamable HTTP, on the MCP TypeScript SDK
v2 (`@modelcontextprotocol/server`, MCP 2026-07-28 with automatic 2025-era
fallback). 15 tools, 7 prompts, native resources over the sandbox. Current release
1.1.0 (`TOOL_API_VERSION` 1.1.0). Three runtime dependencies (zipnative, the MCP SDK, zod) — never add one.
Quality bar: production-grade OSS (strict TypeScript, strong validation, secure
file IO inside ONE sandbox, no network code path at all, deterministic releases,
ISO/IEC 21320-1 conformance validated in CI — the veraZIP gate).

## Architecture (one line each)

- src/cli.ts — stdio (`serveStdio`) / Streamable HTTP (`createMcpHandler`) entry point; reads the four operator ceilings once
  (an invalid value refuses to start; `ZIPNATIVE_MCP_PORT` must be 1..65535, `ZIPNATIVE_MCP_OUTPUT_DIR` absolute).
- src/http.ts — Node http ↔ Web Request/Response bridge, body cap, timeouts, Host/Origin loopback guard (DNS-rebinding protection).
- src/auth.ts — opt-in HTTP bearer token (`ZIPNATIVE_MCP_HTTP_TOKEN`, ≥ 16 chars, constant-time compare, 401 + WWW-Authenticate).
- src/server.ts — tool registry (`kind`, MCP annotations, `_meta.examples`) + request handlers on the low-level `Server` +
  SERVER_INSTRUCTIONS + SERVER_CACHE_HINTS + prompts; `callToolDirect` runs one call exactly as `tools/call` does;
  `listToolsPayload`, `toolNames`; an escaped non-ZipError becomes `ENGINE_ERROR` with absolute paths redacted.
- src/tools/* — one file per tool (JSON Schema `as const` + parallel Zod `.strictObject` + handler + result type);
  `_shared.ts` has `parseInput`, `ProjectionShape`, `EngineOptionsShape`, `sha256Hex`.
  - inspect-zip.ts — eager archive report, determinism verdict (+ `determinismReport`, `canonicalDate`), `check:[…]` / `assert:{…}` CI gate.
  - list-zip-entries.ts — paged central-directory inventory (filter, offset/limit, eager option, extended timestamps, Unix ids).
  - read-zip-entry.ts — one entry by name/index: data (base64/utf8, `range` window), raw payload, or verify.
  - verify-zip.ts — the engine's `verifyZip` report verbatim; never isError for an archive problem (`ok` / `error{code}` / `skipped`).
  - extract-zip.ts — secure-by-default extraction (rejectTraversal / rejectSymlinks / onDuplicate / limits); inline
    (dry run with `includeData:false`) or streamed under a sandbox `outputDir`.
  - scan-zip-forward.ts — the forward, central-directory-less reader; NOT authoritative (local headers only); `tolerateTruncation`.
  - sanitize-entry-paths.ts — `sanitizeEntryPath()` over a list of names (the traversal gate) with the rule that fired.
  - create-zip.ts — deterministic archive creation (`createZip` / `createParallelZip`): order, dates, compression +
    `deterministic` pin, comments, attributes, extra fields, `stream:true` sources (+ `zip64`), base64 or streamed file output.
  - modify-zip.ts — incremental edits via `createZipModifier` (add/replace/remove/rename/setComment), `append` (remanence)
    vs `compact` (+ `canonical`); the input is opened eagerly.
  - canonicalize-zip.ts — `canonicalizeZip()`: any archive into the canonical deterministic form, no recompression, idempotent.
  - merge-zip.ts — `ZipWriter.addFromReader()`: 1–32 sources merged without recompression, verified first, `onConflict`.
  - compute-crc32.ts — CRC-32 of inline data or a sandbox file (1 MiB chunks, `seed`, `expect`).
  - inflate-raw.ts — bounded raw-DEFLATE inflation through the resumable inflater (`maxOutput` mandatory, `leftover`).
  - describe-engine.ts — offline capability preflight (versions, deflate tier, codecs, limits, ceilings, caps,
    sandbox/cache state, error + diagnostic vocabularies, unexposed exports).
  - draft-governance-issue.ts — LOCAL governance-compliant issue draft + compliance report; never submits (HITL).
- src/archive-input.ts — `zipBase64` XOR `zipPath` (sandbox), `loadArchive`, `openArchive` (`access` auto / memory / range:
  zipnative's `openZipRange` over the sandbox file's own handle), `openArchiveSource` (bounded ByteSource), `isPathInput`.
- src/base64.ts — base64 boundary helpers with agent-facing diagnostics (data: URI, PEM, double encoding).
- src/cache.ts — opt-in content-addressed response cache (`ZIPNATIVE_MCP_CACHE_DIR`, absolute; SHA-256 key namespaced by the
  versions and the four ceilings, 1 h TTL, oldest-written evicted first); never for paths, file output, `defaultDate:'now'`,
  `parallel`, describe_engine, draft_governance_issue.
- src/call-context.ts — the request's cancellation signal and progress sink (`CANCELLED`, `notifications/progress`).
- src/canonical.ts — the canonical-form options (`date`, `keepComments`, `keepExternalAttributes`) shared by canonicalize_zip and modify_zip.
- src/caps.ts — every byte/count bound on top of the engine's `ZipLimits` + the four operator ceilings
  (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`,
  `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`; `readCeilings` / `getCeilings`); every constant is in `CAPS`.
- src/diagnostics.ts — `createDiagnosticSink`: every engine call's `onDiagnostic`, `dosTimeMode: 'utc'`, signal and progress go
  through a sink; every archive tool's result carries `diagnostics[]` (de-duplicated, capped at 200) + `diagnosticCounts`
  (verify_zip: the report's diagnostics through the same cap, no `diagnosticCounts` — `verifyZip` takes no sink).
- src/engine.ts — `ensureEngineReady` (node:zlib codec tier, memoised) and `probeRuntime`.
- src/entry.ts — the shared `EntryView` JSON row (`viewFromEntry` / `viewFromHeader`, `ENTRY_VIEW_SCHEMA`).
- src/entry-spec.ts — the per-entry payload for create/modify (`dataBase64` | `text` | `sourcePath` | `directory`, compression,
  date read as UTC, comment, unixMode / externalAttributes, extraFields) → `AddEntryOptions`.
- src/errors.ts — `ToolError(code, message, data?)`, `SecurityError`, `GovernanceError`.
- src/filter.ts — entry filters (exact names / prefix / linear-time globs) shared by list / extract / scan / merge.
- src/governance.ts — runtime source of truth for the AI-governance / HITL contract (`validateIssueMarkdown`,
  `DEPENDENCY_PATTERNS` byte-identical to `scripts/verify-issue.mjs`, prompt texts).
- src/limits.ts — the `limits` input fragment (the nine `ZipLimits` keys) + `resolveCallLimits` → `LIMIT_CEILING_EXCEEDED` naming the env var.
- src/output.ts — `emitArchive` / `emitArchiveStream` (base64 ≤ 50 MiB or exclusive sandbox file under the file-output ceiling) + `writeSandboxedText`.
- src/projection.ts — token-frugal `verbosity:'summary'` / `fields:[…]` projection (`selectFields`, `_meta.unmatchedFields`).
- src/resources.ts — native MCP resources `zipnative://output/{+path}` over the sandbox (any regular file, MIME by extension) + `resource_link`s.
- src/sandbox.ts — the single filesystem boundary (`ZIPNATIVE_MCP_OUTPUT_DIR`): NUL / absolute / UNC / `..` guards,
  `ZIP_CONTAINER_EXTENSIONS`, realpath check on the parent for writes, one-handle reads (real path bound to the handle), `wx` writes.
- src/version.ts — `ZIPNATIVE_MCP_VERSION` and `TOOL_API_VERSION` (in lock-step with package.json / server.json / CITATION.cff).
- src/wrapper-codes.ts — the 17 wrapper codes with meaning and remedy (every `ToolError` code raised in `src/` is listed).
- src/zip-errors.ts — the ONLY place that reads `err.code`: 39 frozen `ZIP_*` codes passed through verbatim
  (`mapZipError`, `guard`, `guardAsync`), 12 diagnostic codes.
- src/index.ts — public library entry (server factory + types).
- scripts/ — TypeScript run by tsx: `gate.ts` (the quality gate), `verify-docs.ts` (+ `lib/`), `release-prepare.ts`,
  `tool-shape.ts` (catalogue fixture), `generate-samples.ts` + `verify-samples.ts` (the sample baseline), `build-claude-rules.ts`;
  veraZIP: `verazip-core.mjs` (vendored ISO/IEC 21320-1 validator, no imports), `validate-zip.mjs`, `generate-zip-corpus.mjs`,
  `helpers/zip-corpus.mjs` (the corpus), `helpers/raw-zip-builder.mjs`, `helpers/interop-tools.mjs`; `verify-issue.mjs` (draft verifier).
- tests/* — one `tests/<name>.test.ts` per tool/module; `_`-prefixed shared fixtures (`_zip-fixtures.ts`, `_zip-assert.ts`);
  `tests/tools/` the tooling suites; `zip-fuzz.test.ts` the seeded fuzz suite; `verazip.test.ts` runs the corpus in-process;
  `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen catalogue baseline (never regenerate it).

## Core conventions

- Strict TypeScript, ESM, `.js` suffix in relative imports; no `any` (use `unknown` + narrowing); explicit return types on exports;
  4-space indent, single quotes, trailing commas.
- Validate every tool input at the boundary with Zod (`.strictObject` — unknown keys are a
  `VALIDATION_ERROR`); keep the hand-written JSON Schema (`as const`, `additionalProperties: false`)
  and the Zod schema aligned. No `$ref` / `$defs` in input schemas (host compatibility).
- Faithful thin wrapper: no ZIP logic in `src/` — every byte-level operation is an engine call;
  engine security defaults stay ON; relaxations are explicit, named inputs; `limits.*` can never
  exceed the operator ceilings.
- Error contract: `content[0].text = "<tool> failed [CODE]: message"`, `isError: true`,
  `_meta.error = { code, message, data? }`. Codes are the 39 `ZIP_*` engine codes verbatim plus the
  17 wrapper codes of `src/wrapper-codes.ts` (docs/AGENT_CONTRACT.md §6). Unknown tool name on `tools/call` is a
  JSON-RPC `-32602` `[UNKNOWN_TOOL]` protocol error.
- `tools/list` is structurally fingerprinted: after a deliberate schema change run
  `npm run build && npx tsx scripts/tool-shape.ts --write` (refreshes `tests/_fixtures/tool-shape.json`)
  and bump `TOOL_API_VERSION` when a schema or an error code changes.
- Never read or write outside `ZIPNATIVE_MCP_OUTPUT_DIR`; unset = base64 only. File outputs are
  exclusive (`wx`), never overwritten; `outputPath` must end in a container extension.
- Never echo `ZIPNATIVE_MCP_HTTP_TOKEN` or absolute sandbox paths in errors or logs.
- No network code path, ever — not even behind an env var. `describe_engine.network` is `'none'`.
- Operator env vars (8): ZIPNATIVE_MCP_OUTPUT_DIR, ZIPNATIVE_MCP_CACHE_DIR, ZIPNATIVE_MCP_PORT,
  ZIPNATIVE_MCP_HTTP_TOKEN, ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES, ZIPNATIVE_MCP_MAX_ENTRIES,
  ZIPNATIVE_MCP_WORKERS, ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES.
- Docs are contracts: counts and names are held to `docs/assets/ecosystem.json` and the source by
  `npm run verify:docs` (and `tests/docs-consistency.test.ts`). English everywhere; no emojis in release notes.
- Every archive a test produces through a tool must pass `assertValidZip` (ISO conformance included).
- `npm run lint` is `eslint src --max-warnings 0` — warnings fail the gate. CI runs the gate on Linux (Node 22 / 24),
  Windows and macOS; the veraZIP gate is blocking on Linux and Windows.

## Quality gate (all PRs)

`npm run gate` (`scripts/gate.ts`: typecheck, lint, build, dist checks, stdio smoke, tool-shape, samples, coverage,
docs, the veraZIP corpus and validation, examples). `npm run gate:fast` before every commit;
`npx tsx scripts/gate.ts --publish --require-all` on release branches. `npm run validate:zip` alone for anything touching
what the tools write: create_zip, modify_zip, canonicalize_zip, merge_zip, inflate_raw, the sandbox / output modules, or the engine version.

## Release process

- `npx tsx scripts/release-prepare.ts --version X.Y.Z` bumps every version reference in lock-step and scaffolds the note.
- release-notes/vX.Y.Z.md is mandatory; CHANGELOG.md mirrors it.
- GitHub Release title: `vX.Y.Z - short description`.
- `publish.yml` runs four jobs: verify (gate, one `npm pack`, SBOM) → publish (npm Trusted Publishing, OIDC, no NPM_TOKEN)
  → attest → registry (the MCP registry).

## Working efficiently (token-aware)

Optimize for minimal tokens in both planning and implementation, without lowering
quality:

- Gather context in parallel, then act; don't re-read files already in context.
- Make targeted edits — don't reprint whole files or restate unchanged code.
- Keep replies concise: no preambles, no change-summary essays, no new markdown
  docs unless asked. Let the diff speak.
- Reuse the scoped `.github/instructions/*.md` rather than re-deriving conventions.
- Prefer `verbosity:'summary'` / `fields:[…]` when calling the read tools yourself.
