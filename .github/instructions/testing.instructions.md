---
description: "Use when writing tests, fixtures, extending coverage, debugging failures, or touching the veraZIP corpus scripts."
applyTo: "tests/**,scripts/**,vitest.config.ts"
---
# Testing Standards

## Framework
- vitest, `globals: false` (import `describe` / `it` / `expect`), one `tests/<name>.test.ts` per tool/module,
  `_`-prefixed shared fixtures, deterministic (TZ=UTC), < 60 s per file.
- Commands:
  - npm run gate:fast (typecheck:all, lint, test, server-json, verify:docs) — before every commit
  - npm run gate (the CI profile; `npx tsx scripts/gate.ts --only <step>` for one step, logs in test-output/.gate/)
  - npm run test / npx vitest run tests/<name>.test.ts
  - npm run test:coverage (thresholds in vitest.config.ts — never lower them)
  - npm run typecheck:all (src, tests, scripts)
  - npm run examples:check (runs every examples/*.json live; multi-step examples are chained)
  - npm run test:generate + npm run verify:samples (the sample baseline, against the BUILT server)
  - npm run validate:zip (veraZIP: build + corpus + ISO/IEC 21320-1 validation; counts in docs/data/verazip.json;
    `VERAZIP_REQUIRED=1` to fail closed on a machine without foreign tools)
  - npm run lint (`eslint src --max-warnings 0` — warnings fail)

## Fixtures and anti-circularity
- Benign archives come from the engine (`tests/_zip-fixtures.ts`: `basicZip`, `richZip`, `highRatioZip`, `streamedZip`,
  `incrementalZip`, `zip64ManyEntries`); hostile archives come from the engine-independent raw builder
  (`tests/_fixtures/raw-zip-builder.ts`, vendored from zipnative) so the reader is never tested only against our own writer.
- `tests/fixtures/interop/*.zip` are foreign-provenance (bsdtar, PowerShell) and are never regenerated;
  `tests/fixtures/SHA256SUMS` pins them and the frozen example inputs (`tests/fixtures/PROVENANCE.md`).
- Every archive a test produces through a tool must pass `assertValidZip` (`tests/_zip-assert.ts`: PK magic + eager
  engine open + `verifyZip` ok + ISO conformance by the vendored core). Negatives use `expectCheck(bytes, '<check id>')`.
- Prefer `callToolDirect` for tool behaviour; use `tests/_mcp-harness.ts` (`connectLegacy`, which also captures
  notifications) / `tests/_http-fixture.ts` only for transport contracts.
- `tests/zip-fuzz.test.ts` (with `tests/_fuzz.ts`) is the seeded fuzz suite over every tool; a finding becomes a lock
  test named after its id (`it('F-001: …')`).

## veraZIP (conformance gate)
- The corpus is defined ONCE in `scripts/helpers/zip-corpus.mjs` and run twice: in-process by `tests/verazip.test.ts`
  (src/) and by `scripts/generate-zip-corpus.mjs` + `scripts/validate-zip.mjs` (dist/, plus the foreign-tool level) in CI
  (`.github/workflows/verazip.yml`, blocking on Linux and Windows).
- Adding a sample: add the entry (tool call + `after` assertion, or a raw-builder recipe with `expectedCheck` /
  `refusedBy`), update `declared` in `docs/data/verazip.json` and the corpus figures of `docs/assets/ecosystem.json`;
  `npm run verify:docs` (`verazip-counts`) and `tests/verazip-vendor.test.ts` fail on any drift.
- The vendored scripts (`verazip-core.mjs`, `validate-zip.mjs`, `helpers/interop-tools.mjs`, `helpers/raw-zip-builder.mjs`)
  pin their upstream commit + blob; re-port 1:1 and bump the hashes in the same PR. They never import `zipnative`,
  `src/` or `dist/`.

## Catalogue parity
- `tests/catalogue-parity.test.ts` compares the live `tools/list` structure with `tests/_fixtures/tool-shape.json`.
  After a deliberate schema change: `npm run build && npx tsx scripts/tool-shape.ts --write`, then review the fixture diff
  (`npm run verify:tool-shape` is the gate's check). Never refresh it to silence an accidental change.
- `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen baseline (`tests/catalogue-superset.test.ts`): no tool /
  property / enum value removed, no new `required`, no tighter bound outside the listed accepted deltas. Never regenerate it.
- `npm run verify:docs` holds every count and name the docs quote to `docs/assets/ecosystem.json` and the source;
  `tests/docs-consistency.test.ts` asserts the contract tables; `tests/governance.test.ts` asserts `src/governance.ts` and
  `scripts/verify-issue.mjs` stay aligned; `tests/tools/` covers the tooling scripts (gate, verify-docs, release-prepare,
  tool-shape, the guard hook, the workflows).

## Test focus
- Validate tool success and tool error paths (`isError`, `[CODE]` in the text, `_meta.error.code`).
- Validate schema constraints for each MCP tool (unknown keys → `VALIDATION_ERROR`; `zipBase64` XOR `zipPath`).
- Validate sandbox protections (`src/sandbox.ts`): traversal, absolute / UNC paths, NUL bytes, extension allow-list,
  symlinked parent, a file swapped or resized during a read, never-overwrite, file I/O disabled when the env var is unset.
- Validate the security defaults of `extract_zip` on the hostile fixtures and each documented relaxation.
- Validate cancellation (`CANCELLED`, partial file removed, nothing cached) and progress where a tool streams.
- Windows dev host: use `path` helpers; tests must pass on win32 and linux.

## Style
- Use describe/it structure. One behavior per test.
- Avoid brittle snapshot tests for binary output; assert structure (magic, entry list, CRCs, `verify_zip` ok, ISO
  conformance) and byte identity where determinism is the contract.

## Quality gate
- All tests must pass; coverage must not regress in touched modules (global floors 94 / 90 / 95 / 94).
