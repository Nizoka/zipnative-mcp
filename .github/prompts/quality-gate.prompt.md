---
description: "Run the full quality gate for zipnative-mcp and report pass/fail by step."
agent: "agent"
---
# Quality Gate

Run the full project quality gate and report results.

## Steps

1. npm run typecheck:all
2. npm run lint
3. npm run test
4. npm run test:coverage
5. npm run build
6. Verify dist output contains:
   - dist/index.js
   - dist/index.d.ts
   - dist/cli.js
   - dist/server.js
7. npm run validate:zip (veraZIP: corpus from the built server + ISO/IEC 21320-1 validation; level 1 uses the foreign tools present on the machine)
8. Summarize pass/fail for each step

## Thresholds
- Zero TypeScript errors
- Zero ESLint errors (warnings fail)
- All tests passing
- Coverage thresholds respected
- Build output present
- veraZIP: 0 FAIL, 0 XPASS, 0 INFRA; the count canary matches docs/data/verazip.json
