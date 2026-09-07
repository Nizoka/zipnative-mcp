---
description: "Investigate and fix a GitHub issue or CI failure in zipnative-mcp with minimal, test-backed changes."
agent: "agent"
---
# GitHub Fix Workflow

Given an issue or CI failure, execute this workflow:

1. Reproduce the issue locally (an MCP tool call through `callToolDirect`, a vitest case, or the failing CI command — `npm run validate:zip` for a veraZIP failure).
2. Isolate root cause with file-level evidence. Decide whether it is wrapper behaviour (this repo) or engine behaviour (`zipnative`): an engine root cause becomes a governance draft for `Nizoka/zipnative` (`draft_governance_issue`, `targetRepo: 'zipnative'`), not a workaround in `src/`.
3. Apply the smallest safe fix. Keep JSON Schema and Zod aligned; never weaken a security default; never add a runtime dependency.
4. Add or update tests proving the fix (archives produced through a tool pass `assertValidZip`).
5. Run quality gate:
   - npm run typecheck:all
   - npm run lint
   - npm run test
   - npm run build
   - npm run validate:zip (when the fix touches what the tools write)
6. Update CHANGELOG, release-notes, AGENTS.md / README.md counts and `tests/_fixtures/tool-shape.json` if user-visible.
7. Provide a concise summary:
   - root cause
   - fix
   - tests added
   - risk assessment (byte-identity, schema, security defaults)
