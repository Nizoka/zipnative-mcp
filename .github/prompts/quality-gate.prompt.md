---
description: "Run the full quality gate for zipnative-mcp and report pass/fail by step."
agent: "agent"
---
# Quality Gate

Run the full project quality gate and report results.

## Steps

1. `npx tsx scripts/gate.ts --ci --require-all` — the single definition of green: typecheck:all,
   lint, build, dist-check, dist-probe, smoke, verify:tool-shape, server-json, test:generate,
   test:coverage, verify:docs, verify:samples, corpus:zip, verazip, examples:check (one line per
   step; the logs land in `test-output/.gate/<step>.log`)
2. For a release, `npx tsx scripts/gate.ts --publish --require-all` (the profile publish.yml runs)
3. `npm audit --audit-level=high` (outside the gate: the gate is hermetic, the audit needs the network)
4. Summarize pass/fail for each step, quoting the gate's summary line

## Thresholds
- Zero TypeScript errors (src, tests and scripts)
- Zero ESLint errors (warnings fail)
- All tests passing; coverage thresholds of `vitest.config.ts` respected
- Build output present and the built server answers over stdio with JSON-RPC frames only
- veraZIP: 0 FAIL, 0 XPASS, 0 INFRA; the count canary matches docs/data/verazip.json
- Samples match the baseline chain; verify-docs reports 0 errors
- `--require-all`: a skipped step is a failure
