## Description

<!-- What does this PR change and why? -->

## Related Issues

<!-- Link related issues: Fixes #123, Relates to #456 -->

## Checklist

- [ ] Tests pass (`npm run test`)
- [ ] Type check passes (`npm run typecheck:all`)
- [ ] Lint passes (`npm run lint`)
- [ ] New code has tests (every archive a test produces through a tool passes `assertValidZip`)
- [ ] veraZIP gate green (`npm run validate:zip`) when a change touches what the tools write (create_zip, modify_zip, inflate_raw, the sandbox, the engine version)
- [ ] Tool schema changed? JSON Schema and Zod kept aligned, `node scripts/tool-shape.mjs --write` run, `_meta.apiVersion` reviewed
- [ ] Docs kept in sync (counts and names in README.md / AGENTS.md / llms.txt are checked by `tests/docs-consistency.test.ts`)
- [ ] release-notes / CHANGELOG updated (if user-facing change)
- [ ] No runtime dependency added; no security default weakened (or documented in description with a human decision)
- [ ] No breaking changes (or documented in description; `compression.deterministic: true` bytes changing is semver-major)

## AI assistance

<!-- If AI tooling drafted part of this PR, say so — see .github/AGENT_RULES.md:
     what was drafted by AI, which instructions files were followed, the
     quality-gate results, and any rule this draft bends (with justification). -->
