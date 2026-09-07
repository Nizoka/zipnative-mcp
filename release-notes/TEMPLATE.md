# Release Notes Template

This directory contains release notes for each published version of zipnative-mcp.

## File naming

- One file per version: release-notes/vMAJOR.MINOR.PATCH.md
- Examples: v1.0.0.md, v1.1.0.md, v1.1.1.md

## Template

Copy this structure into a new release-notes/vX.Y.Z.md file.
Omit sections that do not apply (do not leave empty headings).

```markdown
# zipnative-mcp vX.Y.Z

<!-- GitHub Release title: vX.Y.Z - short description -->

_Released YYYY-MM-DD_

**Built on:** zipnative vA.B.C

<!-- One paragraph summary + compatibility statement (tool API version, byte-identity of produced archives). -->

## Highlights

- ...

## Security

- **fix(security):** ...

## Breaking Changes

- **BREAKING:** ...

## Added

- **feat(scope):** ...

## Changed

- **chore(scope):** ...

## Fixed

- **fix(scope):** ... ([#NN])

## Deprecated

- **deprecate(scope):** ...

## Removed

- **remove(scope):** ...

## Performance

- **perf(scope):** ...

## Documentation

- **docs(scope):** ...

## Install

npm install zipnative-mcp@X.Y.Z

## Upgrade

No breaking changes. Drop-in replacement for vX.Y.Z-1. Produced bytes are identical for every input that was valid before.

## Known limitations

- ... (engine refusals that remain typed refusals in this release, inline caps, gates not yet active)

## Downstream integration notes

- ... (what hosts, the CLI sibling and the engine's ecosystem registry need to know: error envelope, resource URIs, environment variables, pins)

## Verification

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck:all` | ... |
| Lint | `npm run lint` | ... |
| Tests | `npm run test:coverage` | N files, N tests; statements / branches / functions / lines |
| Build | `npm run build` | ... |
| Audit | `npm audit --audit-level=high` | ... |
| Pack | `npm pack --dry-run` | N files, N kB |
| Catalogue | `node scripts/tool-shape.mjs --stats` | `tools/list` N bytes, `SERVER_INSTRUCTIONS` N bytes, N tools, N prompts, N `ZIP_*` error codes, N diagnostics |
| ISO 21320-1 | `npm run validate:zip` | N PASS / N XFAIL / 0 FAIL / 0 XPASS on Linux and Windows |
| Attribution | `git log --format=%B \| grep -ic claude` | 0 |

## Links

- CHANGELOG: ../CHANGELOG.md
- Full diff: https://github.com/Nizoka/zipnative-mcp/compare/vX.Y.Z-1...vX.Y.Z
- zipnative release notes: https://github.com/Nizoka/zipnative/blob/main/release-notes/vA.B.C.md
```

## Conventions

- GitHub Release title format: vX.Y.Z - short description.
- Decide SemVer level first (major / minor / patch) under docs/API_STABILITY.md section 3 — a change to the bytes create_zip / modify_zip / inflate_raw produce for the same input is major.
- Mirror bullets in CHANGELOG.md.
- Use conventional prefixes: feat(scope), fix(scope), chore(scope), docs(scope), ci(scope).
- No emojis in release notes.
- Include the compatibility statement for patch and minor releases, and the "Built on" engine version.
- Numbers in the Verification table are measured on the release commit, never estimated.

## Publication workflow

1. Draft release-notes/vX.Y.Z.md.
2. Mirror bullets into CHANGELOG.md.
3. Bump package version (package.json, server.json, CITATION.cff, src/version.ts in lock-step).
4. Merge to main.
5. Tag vX.Y.Z and publish the GitHub Release (title from the comment on line 3, body = this file).
6. publish.yml re-runs the full gate and veraZIP, attaches the SBOM, and releases to npm via OIDC Trusted Publishing with provenance.
7. Validate and publish the MCP registry entry from server.json; update the engine's docs/assets/ecosystem.json.
