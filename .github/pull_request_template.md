<!--
Thank you for contributing to zipnative-mcp. Describe the change, then walk
the checklist. The items mirror CONTRIBUTING.md §Pull Request Checklist word
for word; keep the two in step when you change either (tests/tools/workflows.test.ts
checks it).
-->

## What and why

<!-- One paragraph: what changes, why, and which issue it closes (`Closes #…`). -->

## Checklist

- [ ] `npm run gate` passes — the CI profile in one command (`npm run gate:fast` for a quick loop while iterating; PowerShell swallows a bare `--`, so call `npx tsx scripts/gate.ts --fast` there)
- [ ] All tests pass (`npm run test`)
- [ ] Type check passes (`npm run typecheck:all`)
- [ ] Lint passes (`npm run lint`)
- [ ] New code has tests (coverage thresholds in `vitest.config.ts` must not regress); every archive a test produces through a tool passes `assertValidZip`
- [ ] No `any` types introduced
- [ ] No new runtime dependencies added (`zipnative`, `@modelcontextprotocol/server` and `zod` stay the only three)
- [ ] No ZIP parsing in `src/` (every byte of ZIP structure belongs to the engine) and no security default weakened: a relaxation is a named input the caller sets
- [ ] A new or changed tool touches every wiring point: `src/tools/<name>.ts` (JSON Schema and the parallel Zod `strictObject` in lock-step), the `TOOLS` registry in `src/server.ts`, `tests/<name>.test.ts`, `examples/`, README, `docs/AGENT_CONTRACT.md`, `llms.txt`, `docs/API_STABILITY.md`
- [ ] If a tool schema, a wrapper code or a `ZIP_*` mapping changed: `npm run build && npx tsx scripts/tool-shape.ts --write` refreshed `tests/_fixtures/tool-shape.json` deliberately, the live catalogue is still a superset of the frozen `tests/_fixtures/tool-shape.v1.0.0.json`, and `TOOL_API_VERSION` was reviewed under `docs/API_STABILITY.md`
- [ ] If what the tools write changed (create_zip, modify_zip, canonicalize_zip, merge_zip, inflate_raw, the sandbox, the engine version): `npm run validate:zip` passes, the writer path has a corpus entry in `scripts/helpers/zip-corpus.mjs`, and `npm run build && npm run test:generate && npm run verify:samples` passes; an intended output change is rebaselined with `npx tsx scripts/verify-samples.ts --update` and declared in the release note (`compression.deterministic: true` bytes changing is semver-major)
- [ ] If docs, README, llms.txt, AGENTS.md, CLAUDE.md, `.github/instructions/` or `.claude/` changed: `npm run agents:rules` regenerated `.claude/rules/` and `npm run verify:docs` passes
- [ ] CHANGELOG.md updated if user-facing changes
- [ ] For releases: follow [Release](../CONTRIBUTING.md#release) — `release-notes/vX.Y.Z.md` and `.github/drafts/pr-vX.Y.Z.md` written, and `npx tsx scripts/gate.ts --publish --require-all` passes locally, which runs every individual gate: `typecheck:all`, `lint`, `build`, `dist-check`, `dist-probe`, `smoke`, `verify:tool-shape`, `server-json`, `test:generate`, `test:coverage`, `verify:docs`, `verify:samples`, `corpus:zip`, `verazip`, `examples:check`

## AI assistance

<!-- If AI tooling drafted part of this PR, say so — see .github/AGENT_RULES.md:
     what was drafted by AI, which instructions files were followed, the
     quality-gate results, and any rule this draft bends (with justification).
     Runtime changes also need a ROADMAP.md entry and a line in the next
     release-notes/vX.Y.Z.md. Pull requests, tags and releases are submitted by
     the maintainer, never by an agent (.github/AGENT_RULES.md). -->
