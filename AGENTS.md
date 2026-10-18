# AGENTS.md

Condensed, editor-agnostic guidance for AI coding agents working **on** zipnative-mcp.
Canonical detail: [.github/copilot-instructions.md](.github/copilot-instructions.md) + [.github/instructions/](.github/instructions/).
Claude Code loads [CLAUDE.md](CLAUDE.md), which imports this file. Keep the three consistent.
Agents that **use** the server read [docs/AGENT_CONTRACT.md](docs/AGENT_CONTRACT.md) (catalogue, decision tree, token economy, error codes) instead.

## Mission and constraints

zipnative-mcp is the Model Context Protocol server of the zipnative ZIP engine: 15 tools (read and inspect, extract and forensics,
write and modify, primitives, meta), 7 prompts and resources over the sandbox, on stdio and Streamable HTTP.
Current release: **1.1.0** (on zipnative 1.1.0, `TOOL_API_VERSION` 1.1.0; MCP 2026-07-28 with the legacy handshake fallback).

- **Three runtime dependencies, no more.** `zipnative`, `@modelcontextprotocol/server`, `zod`. Another runtime package is a hard block (`npm run verify:issue`).
- **Faithful thin wrapper.** Every ZIP decision lives in the engine; `src/` never reads a PK signature and never over-promises
  (`modify_zip` append keeps removed bytes, `scan_zip_forward` is not authoritative, there is no decryption — say so; `describe_engine.unexposed`).
- **Validate at the boundary.** Zod `.strictObject()` at every depth, in step with the advertised JSON Schema (`tests/schema-lockstep.test.ts`);
  every failure is one documented code (`src/wrapper-codes.ts`, `src/zip-errors.ts` — the only reader of `err.code`).
- **No network, ever.** No `fetch` / `https` / `dns` / socket code (`tests/no-network.test.ts`); no tool argument names a URL or an endpoint;
  the byte-range reader reads the sandbox file's own handle. File I/O stays under `ZIPNATIVE_MCP_OUTPUT_DIR` (`src/sandbox.ts`).
- **Engine security defaults stay on.** `rejectTraversal`, `rejectSymlinks`, `onDuplicate`, the nine `ZipLimits` bounds, the overlap / CD-LFH / Zip64 checks;
  a relaxation is a named input the caller sets. Weakening a default is a human decision (AGENT_RULES rule 6).
- **Additive and byte-identical.** Default responses and the bytes written for pinned inputs do not change within a major
  (`compression.deterministic: true` bytes are the engine's semver-major contract); read `docs/API_STABILITY.md` first.
- **Operator knobs are read once at boot**, declared in `server.json` (eight `ZIPNATIVE_MCP_*` variables); an invalid value refuses to start;
  a per-call `limits.*` value never exceeds a ceiling (`LIMIT_CEILING_EXCEEDED`).
- **ESM-first TypeScript strict.** Relative imports carry `.js`; no `any`; no unused locals; on stdio, stdout carries JSON-RPC frames only
  (every engine call goes through a diagnostic sink). Never log or echo `ZIPNATIVE_MCP_HTTP_TOKEN` or an absolute path.
- **Conformant output.** Every archive a tool writes is ISO/IEC 21320-1 conformant; tests check each with `assertValidZip`.
- **Human-in-the-loop.** Agents draft and verify; the maintainer pushes, opens PRs/issues, tags and publishes. **English everywhere** (`verify:docs` `prose-language`).

## The gate

`npm run gate` is THE quality gate (`scripts/gate.ts`; the step list is its `STEPS` table). Logs land in `test-output/.gate/<step>.log`; the summary is ≤ 20 lines.

| Profile | Command | Runs |
|---|---|---|
| Fast — before every commit | `npm run gate:fast` | typecheck:all, lint, test, server-json, verify:docs |
| CI — the default | `npm run gate` | fast minus `test`, plus build, dist-check, dist-probe, smoke, verify:tool-shape, test:generate, test:coverage, verify:samples, corpus:zip, verazip, examples:check |
| Publish — release branches | `npx tsx scripts/gate.ts --publish --require-all` | the CI steps; `--require-all` turns every skip (a missing foreign interop tool) into a failure |

PowerShell swallows a bare `--`: call the script with `--fast`, `--only <step>`, `--from <step>`, `--json`. One suite: `npx vitest run tests/<name>.test.ts`.
Drive the **built** server (`node dist/cli.js`) before claiming a change works. veraZIP (`scripts/verazip-core.mjs`, engine-independent) is the external judge.

## Where is what

| Path | Purpose | Read first |
|---|---|---|
| `src/cli.ts`, `src/http.ts`, `src/auth.ts`, `src/server.ts` | Entry, transports, boot-time knobs; the `TOOLS` registry, dispatch, the cache gate, `SERVER_INSTRUCTIONS`, prompts | `mcp-server.instructions.md` |
| `src/tools/` | One file per tool (JSON Schema, Zod twin, handler, output schema); `_shared.ts` | `tools.instructions.md` |
| `src/*.ts` | Shared fragments: `archive-input`, `limits`, `filter`, `entry-spec`, `canonical`, `projection`, `output`, `sandbox`, `caps`, `call-context`, `zip-errors` | `security.instructions.md` |
| `scripts/` | gate, samples and baseline, the veraZIP corpus and validator, tool-shape, verify-docs, release-prepare, build-claude-rules | `testing.instructions.md` |
| `tests/`, `examples/` | vitest suites, `_`-prefixed helpers, `_fixtures/`, `fixtures/interop/`, `tools/` (the tooling suites); executable `tools/call` examples | `testing.instructions.md` |
| `docs/` | `AGENT_CONTRACT.md`, `AI_GUIDE.md`, `KNOWLEDGE_BASE.md` (export ledger), `API_STABILITY.md`, `guides/`, `data/`, `assets/ecosystem.json` | — |

## Architecture

`JSON-RPC frame → src/server.ts → callToolDirect → tool handler (Zod parse → shared fragments → zipnative) → result by kind → content + structuredContent`.
Handlers are thin: parse, load inputs through the sandbox and the caps, call the engine under `guard()` / `guardAsync()` with a diagnostic sink
(which also carries the request's cancellation signal and progress), return a report or an archive (delivered once: an embedded resource or a `resource_link`).

Adding or changing a tool touches ALL of these (`verify:docs` rules `tool-parity`, `error-parity`, `env-var-parity` fail on a missed step):

1. `src/tools/<name>.ts` and its entry in the `TOOLS` array of `src/server.ts`; a new result shape also needs a `ToolKind` and a dispatch branch.
2. `tests/<name>.test.ts` (success, each code, projection, file mode, `assertValidZip` on every archive) and `examples/<name>.json`;
   a writer path also gets a corpus entry in `scripts/helpers/zip-corpus.mjs`.
3. `npm run build && npx tsx scripts/tool-shape.ts --write` — only for a deliberate structural change; `TOOL_API_VERSION` moves when a schema or a code changes.
4. README, `SERVER_INSTRUCTIONS`, `docs/AGENT_CONTRACT.md`, `docs/AI_GUIDE.md`, `docs/KNOWLEDGE_BASE.md`, `llms.txt`, `docs/assets/ecosystem.json`, `CHANGELOG.md`.

## Consumer contract in brief

A tool succeeds with `content` + `structuredContent` or fails with `isError: true`, `[CODE] message` and `_meta.error`, `CODE` being one of the 17 wrapper codes
or the 39 frozen `ZIP_*` codes of `docs/AGENT_CONTRACT.md` §6; the 12 diagnostic codes are reported, not thrown, unless `strict: true`.
`verify_zip` never fails for an archive problem (`ok` + `error`). An unknown tool is JSON-RPC `-32602` `[UNKNOWN_TOOL]`.
`outputMode: 'file'` writes under the sandbox, never overwrites; `verbosity: 'summary'` / `fields` shrink results.

## Never touch

- `tests/fixtures/interop/` + `tests/fixtures/SHA256SUMS` (foreign-provenance archives), shipped `release-notes/v*.md`, the frozen `tests/_fixtures/tool-shape.v1.0.0.json`.
- The vendored veraZIP scripts (`scripts/verazip-core.mjs` and its companions) except as a 1:1 re-port.
- `dist/`, `coverage/`, `test-output/`, `node_modules/`, `package-lock.json` and the generated files below: never hand-edit.
- Any figure in `docs/assets/ecosystem.json` without `npm run verify:docs` afterwards; the `zipnative` pin without a release note; the coverage thresholds downwards.

## Generated files

`.claude/rules/*.md` ← `npm run agents:rules`; `tests/_fixtures/tool-shape.json` ← `npx tsx scripts/tool-shape.ts --write` (only with a declared schema change);
`tests/_fixtures/samples.sha256.json` ← `npx tsx scripts/verify-samples.ts --update` after `npm run build && npm run test:generate` (only with a declared rebaseline);
`dist/`, `coverage/`, `test-output/` ← the build, coverage, samples and corpus scripts.

## Counts and versions

15 tools, 7 prompts, 17 wrapper codes, 39 frozen `ZIP_*` codes, 12 diagnostic codes, 9 `ZipLimits` keys, 8 environment variables,
38 examples, 1612 tests, 54 samples in the baseline, 43 corpus entries (39 conformant + 4 negative canaries), 23 check ids.
`docs/assets/ecosystem.json` is the source of every count and version. Coverage floors: 94 / 90 / 95 / 94.
Engine zipnative 1.1.0 (`^1.1.0`, 106 exports); SDK `@modelcontextprotocol/server` ^2.3.1; Node ≥ 22.

## Releasing and governance

Follow CONTRIBUTING.md and `scripts/release-prepare.ts`; Conventional Commits, never with a `Co-Authored-By` trailer. Every runtime change gets a CHANGELOG line
and a line in the next `release-notes/vX.Y.Z.md`; the version moves in lock-step (`tests/metadata.test.ts`). Agents never push, never open PRs/issues/releases,
never publish, never tag: [.github/AGENT_RULES.md](.github/AGENT_RULES.md), [.github/ai-governance.json](.github/ai-governance.json).
Issue drafts go to `.github/drafts/` (`draft_governance_issue`, `npm run verify:issue`). Engine root causes belong in
[zipnative](https://github.com/Nizoka/zipnative); siblings: zipnative-cli, pdfnative-mcp, pkinative-mcp. See also [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).
