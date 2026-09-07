---
description: "Use when preparing releases, changelog entries, version bumps, server.json / CITATION.cff metadata and GitHub release notes."
applyTo: "release-notes/**,CHANGELOG.md,server.json,CITATION.cff,src/version.ts,package.json"
---
# Release Note Standards

## Structure
- One file per release: release-notes/vX.Y.Z.md. No emojis. English.
- Keep sections ordered and omit empty sections.
- Use conventional prefixes in bullets: feat(scope), fix(scope), chore(scope), docs(scope), ci(scope).
- Name the engine version shipped (`zipnative x.y.z`) and the tool API version.

## Required parity
- CHANGELOG entry must mirror release bullets.
- GitHub Release body should come from release-notes/vX.Y.Z.md.
- Include a compatibility statement for patch/minor releases: tool names, schemas (additive only), byte-identity of default output, `compression.deterministic: true` bytes (a change is semver-major).
- package.json, server.json, CITATION.cff and `src/version.ts` (`ZIPNATIVE_MCP_VERSION`) carry the same version (asserted by tests/metadata.test.ts); bump `TOOL_API_VERSION` only when a cached response would become unsafe.

## Publication flow
1. Write release-notes/vX.Y.Z.md.
2. Mirror into CHANGELOG.md.
3. Bump the version in the four files above.
4. Run the quality gate (`examples:check` runs as part of `test:coverage` in CI — keep it green) and `npm run validate:zip`.
5. Tag vX.Y.Z.
6. Publish GitHub Release (`vX.Y.Z - short description`).
7. Let the publish workflow re-run the gate + the veraZIP gate, attach the CycloneDX SBOM and publish to npm via OIDC.

## Pre-publish dry run & rollback
- **Dry run the registry payload** before tagging: `tests/schema-conformance.test.ts` (registry name regex + description ≤ 100 chars) and the `mcp-publisher` CLI (https://github.com/modelcontextprotocol/registry, `mcp-publisher --help`)
  (or the repo's `mcp-publish` step) to catch `name`/version drift early.
- **npm:** Trusted Publishing runs from the tag — do **not** publish manually. If a
  bad version ships, do **not** unpublish; cut a superseding patch (vX.Y.Z+1) and,
  if within npm's 72 h window and truly broken, `npm deprecate zipnative-mcp@X.Y.Z "use X.Y.Z+1"`.
- **Tags are immutable once released.** A mistake = new patch tag, never a force-moved tag.
- **Engine bump:** a zipnative upgrade is a patch of this server only when the veraZIP gate and the
  full suite stay green and no `ZIP_*` code or diagnostic code was added (the `zip-errors.ts` table
  fails `tsc` otherwise — then it is a minor with docs updates).
