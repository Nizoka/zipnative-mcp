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
- Include a compatibility statement for patch/minor releases: tool names, schemas (additive only), byte-identity of
  default output, `compression.deterministic: true` bytes (a change is semver-major).
- package.json, server.json, CITATION.cff and `src/version.ts` (`ZIPNATIVE_MCP_VERSION`) carry the same version
  (asserted by tests/metadata.test.ts and `verify:docs` `manifest-shape`); bump `TOOL_API_VERSION` only when a schema or
  an error code changes — release-prepare never moves it.

## Publication flow
1. `npx tsx scripts/release-prepare.ts --version X.Y.Z`: bumps every version reference (package.json, src/version.ts,
   server.json, CITATION.cff, docs/assets/ecosystem.json, the "Verified on" stamps, SECURITY.md, the `Current release`
   prose) and scaffolds release-notes/vX.Y.Z.md and the PR draft under `.github/drafts/`.
2. Write the release note; mirror it into CHANGELOG.md (`verify:docs` `changelog-ladder` checks the compare links).
3. Run `npx tsx scripts/gate.ts --publish --require-all` (the release profile; no skip allowed).
4. The maintainer pushes, tags vX.Y.Z and publishes the GitHub Release (`vX.Y.Z - short description`) — agents stop before this.
5. `publish.yml` runs four jobs: verify (the gate, one `npm pack`, a CycloneDX SBOM from `npm sbom`, digests) → publish
   (`npm-publish` environment, npm Trusted Publishing via OIDC with provenance, no `NPM_TOKEN`) → attest (registry bytes
   compared, build provenance, release assets) → registry (`mcp-publisher`, GitHub OIDC). `workflow_dispatch` is a dry run.

## Pre-publish dry run & rollback
- **Dry run the registry payload** before tagging: `tests/schema-conformance.test.ts` (registry name regex + description
  ≤ 100 chars) and the gate's `server-json` step (the vendored registry schema).
- **npm:** Trusted Publishing runs from the release — do **not** publish manually. If a bad version ships, do **not**
  unpublish; cut a superseding patch (vX.Y.Z+1) and, if within npm's 72 h window and truly broken, the maintainer
  deprecates the bad version.
- **Tags are immutable once released.** A mistake = new patch tag, never a force-moved tag.
- **Engine bump:** a zipnative upgrade is a patch of this server only when the veraZIP gate and the full suite stay green
  and no `ZIP_*` code or diagnostic code was added (the `zip-errors.ts` table fails `tsc` otherwise — then it is a minor
  with docs updates).
