---
description: "Use when editing MCP transport, tool registration, JSON schemas, prompts, resources or request/response handling."
applyTo: "src/server.ts,src/tools/**,src/cli.ts,src/http.ts,src/auth.ts,src/resources.ts,src/projection.ts"
---
# MCP Server Standards

## Transport and lifecycle
- stdio transport by default; Streamable HTTP when `ZIPNATIVE_MCP_PORT` is set (loopback bind + Host/Origin guard; opt-in bearer token via `ZIPNATIVE_MCP_HTTP_TOKEN`, see `src/auth.ts`).
- SDK: `@modelcontextprotocol/server` ^2.0.0 (MCP 2026-07-28, automatic 2025-era fallback). Stay on the low-level `Server` + `setRequestHandler` surface — `McpServer.registerTool` would validate `structuredContent` against the projected output schemas and break the `verbosity` / `fields` contract.
- Operator ceilings (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`) are read once at boot; an invalid value refuses to start.
- Gracefully close the server on SIGINT/SIGTERM.
- Never write to stdout except MCP protocol payloads (use stderr for logs); every engine call goes through a diagnostic sink (`src/diagnostics.ts`) so the engine's `console.warn` fallback can never fire.

## Tool contract
- Each tool module exports `<NAME>_NAME`, `<NAME>_INPUT_SCHEMA`, optional `<NAME>_OUTPUT_SCHEMA` (+ `_SUMMARY_PROPERTIES` for projectable read tools), a handler `(args: unknown) => Promise<Result>` and its result type.
- Keep JSON Schema and Zod validation aligned; Zod schemas are `.strictObject` (unknown top-level or nested keys → `VALIDATION_ERROR`, matching `additionalProperties: false`). Shared fragments: `ARCHIVE_INPUT_PROPERTIES` / `ARCHIVE_INPUT_SHAPE` (`zipBase64` XOR `zipPath`), `LIMITS_INPUT_SCHEMA`, `FILTER_INPUT_SCHEMA`, `PROJECTION_INPUT_PROPERTIES`, `OUTPUT_INPUT_PROPERTIES`, `ENTRY_PAYLOAD_PROPERTIES`, `STRICT_INPUT_PROPERTY`.
- Decode `zipBase64` / `dataBase64` through `src/base64.ts` (agent-facing hints for data: URIs, PEM, double encoding).
- Return tool-level errors as `isError` results — `"<tool> failed [CODE]: message"` + `_meta.error` — never throw across the MCP boundary. Engine errors are mapped ONLY in `src/zip-errors.ts` (`guard` / `guardAsync` / `mapZipError`), keeping the frozen `ZIP_*` code verbatim. The one protocol-level exception: an unknown tool name on `tools/call` is a JSON-RPC `-32602` `[UNKNOWN_TOOL] Unknown tool: <name>`.
- `verify_zip` never returns isError for an archive problem: structural refusals land in `error{code}`, unverifiable entries in `skipped`.
- Every tool registered in `src/server.ts` ships `_meta.apiVersion` (`TOOL_API_VERSION`) and one or two executable `_meta.examples` (validated against `inputSchema` in tests; more examples belong in `examples/*.json`).
- Read tools are projectable: `verbosity:'summary'` collapses to the tool's summary (`*Summary()` in the tool module) and `fields:[…]` keeps dot-paths; their advertised `outputSchema` is the full shape with every property optional (`projectableOutputSchema`). Archive-producing tools return the bytes as an embedded `resource` block (base64) or a `resource_link` (file mode) and never duplicate them in `structuredContent`.
- `tools/list` structure is pinned by `tests/_fixtures/tool-shape.json`; any change to types, enums, defaults, constraints, `required`, `additionalProperties` or example count needs `npm run build && node scripts/tool-shape.mjs --write` and a review; `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen baseline the live catalogue must stay a superset of.
- No `$ref` / `$defs` and no `$schema` keyword in input schemas (host compatibility).
- Update `SERVER_INSTRUCTIONS` (decision tree + pitfalls), AGENTS.md, README.md and llms.txt together whenever you add a tool or change its behaviour — the counts are asserted.

## Caching
- `callToolDirect` serves the opt-in cache (`ZIPNATIVE_MCP_CACHE_DIR`); `isCacheable` excludes `zipPath` / `sourcePath` inputs, `outputMode:'file'`, `defaultDate:'now'`, `parallel`, `describe_engine` and `draft_governance_issue`. The key namespace includes the tool API, package and engine versions. Add a new tool to `NON_CACHEABLE_TOOLS` when its output depends on the environment.

## Safety
- Never trust tool arguments — validate at the boundary with Zod; every path goes through `src/sandbox.ts`; every size through `src/caps.ts`.
- Keep output bounded (50 MiB inline, 4 GiB file, 16 MiB per inline entry, 32 MiB per inline extraction) and deterministic by default.
- Never echo `ZIPNATIVE_MCP_HTTP_TOKEN` or absolute sandbox paths in error messages or stderr.

## Compatibility
- Keep tool names stable across patch releases; additive changes only within a major.
- Bump `TOOL_API_VERSION` when a cached response would become unsafe to serve.
- Breaking changes require explicit migration notes in release-notes.
