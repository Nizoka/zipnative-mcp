@AGENTS.md

# Claude Code addendum

Everything in AGENTS.md applies (15 tools, the gate, the conventions). This file adds what is specific to Claude Code sessions here.
Current release: **1.1.0** (on zipnative 1.1.0).

## Token discipline

- Run tests through `npx tsx scripts/gate.ts --fast` or `npx vitest run <file>`; never paste a full test run into context.
- Never Read `dist/`, `coverage/`, `test-output/`, `package-lock.json`, `node_modules/`, `tests/_fixtures/tool-shape*.json` or
  `tests/_fixtures/samples.sha256.json` (`.claude/settings.json` denies them) — ask the built server (`tools/list`, `describe_engine`) instead.
- Read README.md, docs/KNOWLEDGE_BASE.md and docs/AGENT_CONTRACT.md by section (`grep -n "^## "` first); CHANGELOG.md: the top entry only.
- `.github/instructions/*.md` are the per-area rules (generated into `.claude/rules/`): open the ONE matching the area you touch.

## Commands

`npm run build` (tsc → dist/) · `npm run typecheck:all` (src, tests, scripts) · `npm run lint` (`--max-warnings 0`) · `npm test` ·
`npm run test:coverage` (94 / 90 / 95 / 94) · `npm run examples:check` · `npm run validate:zip` (build + corpus + ISO/IEC 21320-1, blocking) ·
`npm run verify:docs` (28 rules over `docs/assets/ecosystem.json`) · `npm run verify:issue` · `npm run agents:rules` · `npm run gate[:fast]`.

## Architecture map

- `src/cli.ts` stdio (frame cap 256 MiB) or HTTP (`ZIPNATIVE_MCP_PORT`); reads the four ceilings once. `src/http.ts` bridge, body cap, Host/Origin guard; `src/auth.ts` bearer token.
- `src/server.ts` the `TOOLS` registry (`kind`, annotations, ≤ 2 `_meta.examples`), `dispatchOutput`, `callToolDirect`, `listToolsPayload`, `SERVER_INSTRUCTIONS`,
  the 7 `PROMPTS`, resources, `isCacheable`, the `ENGINE_ERROR` boundary (absolute paths redacted). Low-level `Server`, not `McpServer.registerTool`.
- `src/tools/<name>.ts` one per tool: `<NAME>_NAME`, `<NAME>_INPUT_SCHEMA` `as const`, the Zod twin, output schema (+ summary projection for read tools), handler.
- `src/call-context.ts` cancellation signal + progress sink (`CANCELLED`); `src/canonical.ts` the canonical options of `canonicalize_zip` / `modify_zip`;
  `src/wrapper-codes.ts` the 17 wrapper codes with meaning and remedy; `src/zip-errors.ts` the only reader of `err.code` (39 codes, 12 diagnostics).
- `src/caps.ts` every cap (all in `CAPS`) + the ceilings; `src/limits.ts` the nine keys; `src/sandbox.ts` the one boundary (one-handle reads, `wx` writes);
  `src/archive-input.ts` `zipBase64` XOR `zipPath`, `access` auto / memory / range; `src/filter.ts` linear-time globs; `src/entry-spec.ts`, `src/entry.ts`,
  `src/output.ts`, `src/projection.ts`, `src/resources.ts`, `src/cache.ts`, `src/diagnostics.ts`, `src/engine.ts`, `src/governance.ts`, `src/version.ts`.
- `scripts/gate.ts`, `scripts/verify-docs.ts` (+ `scripts/lib/`), `scripts/release-prepare.ts`, `scripts/tool-shape.ts`, `scripts/build-claude-rules.ts`,
  the samples pair (`generate-samples.ts`, `verify-samples.ts`), the veraZIP set (`verazip-core.mjs`, `validate-zip.mjs`, `generate-zip-corpus.mjs`, `helpers/`).
- `tests/` one suite per tool / module; `tests/tools/` the tooling suites (gate, verify-docs, release-prepare, guard, workflows);
  `tests/zip-fuzz.test.ts` the seeded fuzz suite; `tests/catalogue-superset.test.ts` against the frozen 1.0.0 catalogue; `tests/autonomy.test.ts` on `dist/cli.js`.

## Conventions that bite

- Zod `strictObject` + the hand-written JSON Schema in lock-step; no `$schema` / `$ref` / `$defs`; base64 inputs through `src/base64.ts`.
- No ZIP parsing in `src/`: the sanctioned raw parsers are `scripts/verazip-core.mjs` (never imports zipnative) and the raw builders of hostile fixtures.
- Never cache path inputs, file output, wall-clock dates, `parallel`, a cancelled call, `describe_engine`, `draft_governance_issue`.
- Lock tests are named after their finding id (`it('F-001: …')`). Windows is a first-class host: `node:path` helpers, green on win32 and linux.

## Adding a tool (Claude specifics)

Follow AGENTS.md §Architecture. Then: add the writer path to `scripts/helpers/zip-corpus.mjs`; refresh the catalogue with
`npm run build && npx tsx scripts/tool-shape.ts --write` (reviewed; never touch `tool-shape.v1.0.0.json`); update the counts in
`docs/assets/ecosystem.json` and run `npx tsx scripts/verify-docs.ts` until it is clean; add the `CHANGELOG.md` `[Unreleased]` line.

## Release

`npx tsx scripts/release-prepare.ts --version X.Y.Z` moves every version reference (package.json, src/version.ts, server.json, CITATION.cff,
the ecosystem manifest, the "Verified on" stamps, the `Current release` prose) and scaffolds the release note and the PR draft. Then
`npx tsx scripts/gate.ts --publish --require-all`, and stop: the maintainer pushes, tags and publishes. `publish.yml` runs four jobs —
verify (gate, one `npm pack`, SBOM) → publish (npm Trusted Publishing, OIDC, no `NPM_TOKEN`) → attest → registry (MCP registry).

## Hooks and HITL

`.claude/hooks/guard.mjs` (PreToolUse on Bash **and** PowerShell) denies `npm publish`, writing `gh` commands and any `git push`, even
inside a quoted string — write such text with Edit. The server is a draftsman: no GitHub write path and no network path; issue drafts
come from `draft_governance_issue` / `npm run verify:issue` and a human submits them. No `Co-Authored-By` trailers.
