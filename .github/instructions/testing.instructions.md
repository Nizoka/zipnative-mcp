---
description: "Use when writing tests, fixtures, extending coverage, debugging failures, or touching the veraZIP corpus scripts."
applyTo: "tests/**,scripts/**,vitest.config.ts"
---
# Testing Standards

## Framework
- vitest, `globals: false` (import `describe` / `it` / `expect`), one `tests/<name>.test.ts` per tool/module, `_`-prefixed shared fixtures, deterministic, < 60 s per file.
- Commands:
  - npm run test
  - npm run test:watch
  - npm run test:coverage (thresholds in vitest.config.ts — never lower them)
  - npm run typecheck:all (src + tests)
  - npm run examples:check (runs every examples/*.json live; multi-step examples are chained)
  - npm run validate:zip (veraZIP: build + corpus + ISO/IEC 21320-1 validation; counts in docs/data/verazip.json; `VERAZIP_REQUIRED=1` to fail closed on a machine without foreign tools)
  - npm run lint (`eslint src --max-warnings 0` — warnings fail)

## Fixtures and anti-circularity
- Benign archives come from the engine (`tests/_zip-fixtures.ts`: `basicZip`, `richZip`, `highRatioZip`, `streamedZip`, `incrementalZip`, `zip64ManyEntries`); hostile archives come from the engine-independent raw builder (`tests/_fixtures/raw-zip-builder.ts`, vendored from zipnative) so the reader is never tested only against our own writer.
- `tests/fixtures/interop/*.zip` are foreign-provenance (bsdtar, PowerShell) and are never regenerated.
- Every archive a test produces through a tool must pass `assertValidZip` (`tests/_zip-assert.ts`: PK magic + eager engine open + `verifyZip` ok + ISO conformance by the vendored core). Negatives use `expectCheck(bytes, '<check id>')`.
- Prefer `callToolDirect` for tool behaviour; use `tests/_mcp-harness.ts` (`connectLegacy`) / `tests/_http-fixture.ts` only for transport contracts.

## veraZIP (conformance gate)
- The corpus is defined ONCE in `scripts/helpers/zip-corpus.mjs` and run twice: in-process by `tests/verazip.test.ts` (src/) and by `scripts/generate-zip-corpus.mjs` + `scripts/validate-zip.mjs` (dist/, plus the foreign-tool level) in CI (`.github/workflows/verazip.yml`, blocking on Linux and Windows).
- Adding a sample: add the entry (tool call + `after` assertion, or a raw-builder recipe with `expectedCheck` / `refusedBy`), update `declared` in `docs/data/verazip.json`, and let the docs agents update the quoted total. `tests/verazip-vendor.test.ts` fails on any drift.
- The vendored scripts (`verazip-core.mjs`, `validate-zip.mjs`, `helpers/interop-tools.mjs`, `helpers/raw-zip-builder.mjs`) pin their upstream commit + blob; re-port 1:1 and bump the hashes in the same PR. They never import `zipnative`, `src/` or `dist/`.

## Catalogue parity
- `tests/catalogue-parity.test.ts` compares the live `tools/list` structure with `tests/_fixtures/tool-shape.json`. After a deliberate schema change: `npm run build && node scripts/tool-shape.mjs --write`, then review the fixture diff. Never refresh it to silence an accidental change.
- `tests/_fixtures/tool-shape.v1.0.0.json` is the frozen baseline: no tool / property / enum value removed, no new `required`, no tighter bound. Never regenerate it.
- `tests/docs-consistency.test.ts` asserts the counts and names README.md / AGENTS.md / llms.txt / server.json / docs/data quote; `tests/governance.test.ts` asserts `src/governance.ts` and `scripts/verify-issue.mjs` stay aligned.

## Test focus
- Validate tool success and tool error paths (`isError`, `[CODE]` in the text, `_meta.error.code`).
- Validate schema constraints for each MCP tool (unknown keys → `VALIDATION_ERROR`; `zipBase64` XOR `zipPath`).
- Validate sandbox protections (`src/sandbox.ts`): traversal, absolute / UNC paths, NUL bytes, extension allow-list, symlinked parent, never-overwrite, file I/O disabled when the env var is unset.
- Validate the security defaults of `extract_zip` on the hostile fixtures and each documented relaxation.
- Windows dev host: use `path` helpers; tests must pass on win32 and linux.

## Style
- Use describe/it structure. One behavior per test.
- Avoid brittle snapshot tests for binary output; assert structure (magic, entry list, CRCs, `verify_zip` ok, ISO conformance) and byte identity where determinism is the contract.

## Quality gate
- All tests must pass; coverage must not regress in touched modules (aim ≥ 90 % statements on `src/`).
