---
description: "Audit zipnative-mcp for security at the tools/call boundary, the sandbox, the agent contract, the veraZIP conformance gate and reproducible archives."
agent: "agent"
---
# Compliance Audit

Perform a compliance audit of zipnative-mcp. The server is the untrusted-input boundary
around the zipnative engine: every argument of every `tools/call` comes from a model, and
every archive it reads may be hostile. Every finding is reproduced with a command — a test,
a script, or a request sent to the built server (`node dist/cli.js`, after `npm run build`)
— and cited with `file:line`. Report findings with a severity (blocker / major / minor / note),
the reproduction command and the recommended fix; a finding without a reproducible command is
not a finding.

## Audit Areas

### 1. Protocol contract (docs/AGENT_CONTRACT.md, docs/API_STABILITY.md)
- On stdio, stdout carries JSON-RPC frames only; every log goes to stderr (gate steps
  `smoke` and `dist-probe`, `tests/cli-stdio.test.ts`)
- Both protocol eras are served by the same binary: MCP 2026-07-28 (`server/discover`) and
  the 2025-era `initialize` handshake, on stdio and on Streamable HTTP
  (`tests/protocol-revisions.test.ts`, `tests/stdio-modern.test.ts`, `tests/http-modern.test.ts`)
- A tool failure is an `isError` result carrying one documented code (a wrapper code of
  `src/wrapper-codes.ts` or the engine's `ZIP_*` code verbatim); an archive problem in
  `verify_zip` is `ok: false` + `error`, never `isError`; an unknown tool name is JSON-RPC
  `-32602` `[UNKNOWN_TOOL]`; an escaped non-`ToolError` is `ENGINE_ERROR` with
  `errorClass: 'internal'` and no absolute path. Nothing throws and no failure is uncoded
- `structuredContent` validates against the advertised `outputSchema` on the default,
  `verbosity: 'summary'` and `fields` paths (`tests/projection.test.ts`, `tests/schema-lockstep.test.ts`)
- `tools/list` is a superset of the frozen `tests/_fixtures/tool-shape.v1.0.0.json`
  (`tests/catalogue-superset.test.ts`, every tightening listed in `ACCEPTED_DELTAS`); default
  archives are byte-identical for the same deterministic inputs unless the release notes
  declare the change
- Cancellation and progress: a cancelled call is `CANCELLED`, is never cached and leaves no
  partial file; `notifications/progress` only with a `progressToken`, strictly increasing
  (`tests/cancellation.test.ts`)

### 2. Input boundary
- Every object schema is Zod `strictObject`, at every nesting level, and agrees with the JSON
  Schema advertised for it — send a value at the edge of each new input
- `zipBase64` XOR `zipPath` (`src/archive-input.ts`); base64 through `src/base64.ts`;
  `merge_zip` `sources[]` bounded by `maxMergeSources` / `maxMergeInputBytes`
- Size bounds hold (`src/caps.ts`, advertised by `describe_engine.caps`): 128 MiB decoded
  inline input, 1 GiB buffered `zipPath` (above it only `access: 'range'` on the three read
  tools), 50 MiB inline archive, 16 MiB inline entry, the file-output ceiling, 256 MiB
  frame and HTTP body; the nine `ZipLimits` keys are bounded by the operator ceilings
  (`tests/limits.test.ts`, `LIMIT_CEILING_EXCEEDED`)
- Globs match in linear time and are bounded at 1 024 characters (`tests/filter.test.ts`);
  no `__proto__` / `constructor` / `prototype` segment of a `fields` path or a nested spec
  reaches an object the server builds (`tests/prototype-pollution.test.ts`)
- Hostile archives (`HOSTILE_FIXTURES` of `tests/_zip-fixtures.ts`: zip-slip, device names,
  symlinks, duplicate paths, declared bombs, overlaps, CD/LFH divergence, Zip64
  contradictions) end in a coded `ZIP_*` refusal through every tool that reads them, never a
  success, a hang or an uncoded failure; the seeded fuzz suite (`tests/zip-fuzz.test.ts`) holds

### 3. Sandbox and network
- There is NO network code path: no `fetch`, `https`, `net`, `dns` import, and `node:http`
  only in the loopback listener (`tests/no-network.test.ts`); no tool argument names a URL;
  the byte-range reader is fed only by a sandbox file handle or inline bytes
- Every read goes through one handle bound to its real path (`src/sandbox.ts`); a planted
  symlink or junction is `SECURITY_VIOLATION` on a read and on a write; writes are exclusive
  (`wx`, `OUTPUT_EXISTS`); a file that changes under the read is `IO_ERROR`
- HTTP mode binds loopback, checks Host and Origin, honours the opt-in bearer token, applies
  the timeouts and the security headers; `ZIPNATIVE_MCP_HTTP_TOKEN` is never logged or echoed
- The response cache never persists a path input, a file output, a wall-clock date,
  `parallel`, `describe_engine` or `draft_governance_issue`, nor a result produced under an
  aborted signal (`tests/cache-policy.test.ts`)

### 4. Operator knobs
- Every `ZIPNATIVE_MCP_*` variable (eight) is read once at boot, declared in `server.json`,
  and an invalid value refuses to start (`tests/metadata.test.ts`, `tests/caps.test.ts`,
  `tests/cli-stdio.test.ts`)

### 5. Exactly three runtime dependencies
- `package.json` `dependencies` is `zipnative`, `@modelcontextprotocol/server`, `zod`
  (`tests/tools/workflows.test.ts`); the server parses no ZIP structure itself
  (`src/zip-errors.ts` is the only reader of `err.code`); engine security defaults stay on
  and every relaxation is a named input

### 6. Conformance gate (veraZIP, ISO/IEC 21320-1)
- `npm run validate:zip`: every conformant corpus entry PASS, every negative canary XFAIL,
  0 FAIL, 0 XPASS, the count canary equal to `docs/data/verazip.json`; every writer path
  (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`) has a corpus entry
- The vendored validator (`scripts/verazip-core.mjs`) never imports the engine and is pinned
  to its upstream blob (`tests/verazip-vendor.test.ts`)
- Every archive a test produces through a tool passes `assertValidZip`

### 7. Reproducible archives
- A pinned date plus `compression.deterministic: true` make an archive byte-identical across
  hosts and time zones (`dosTimeMode: 'utc'`, `tests/reproducible-build.test.ts`);
  `canonicalize_zip` is idempotent
- The sample baseline (`tests/_fixtures/samples.sha256.json`) holds; a rebaseline is declared
  in the release note; every `semantic`-mode sample is listed for a stated reason
- Generators run under `TZ=UTC` with the operator knobs scrubbed (`scripts/helpers/hermetic.ts`)

### 8. Documentation truth
- `npm run verify:docs` green: every count and version matches the tree; every tool, code and
  operator variable the docs name exists, and every one that exists is documented; every
  `#fragment` resolves; the rendered rules are in sync with `.github/instructions/`
- Every engine export is reached by a tool or listed in `UNEXPOSED_EXPORTS` with a true
  rationale (`docs/data/core-exports.json`, `docs/KNOWLEDGE_BASE.md` §8)

### 9. Governance
- No `Co-Authored-By` trailer, "Generated with" footer or mention of an AI assistant in the
  branch history, the PR draft or the release notes
- Nothing pushed, tagged, published or opened by an agent (the guard hook, wired to Bash and
  PowerShell)
- Issue drafts under `.github/drafts/` pass `npm run verify:issue`
