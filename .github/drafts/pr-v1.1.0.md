# release: v1.1.0 — zipnative 1.1.0 parity, canonicalize and merge, byte-range reads, supply-chain hardening

> **Branch:** `release/v1.1.0` → `main`
> **Type:** Minor release (additive, backward-compatible with v1.0.0 for every valid call; the tightenings are listed in the release note's ledger)
> **zipnative pin:** `^1.0.0` → `^1.1.0`
> **Prepared:** 2026-10-18 — release note: `release-notes/v1.1.0.md`

## Summary

zipnative-mcp 1.1.0 brings the server to zipnative 1.1.0. An MCP host gets two new tools — `canonicalize_zip` (any
archive into the engine's canonical reproducible form, without recompression) and `merge_zip` (up to 32 source
archives into one, every entry verified, without recompression) — byte-range reads of sandbox archives larger than
memory, the Zip64 streaming opt-in, cancellation and progress (every tool whose work grows with its input; `verify_zip` only before it starts), extended timestamps and Unix ids,
and identical archive bytes on every host (`dosTimeMode: 'utc'`; 1.0.0 depended on the host time zone while declaring
those calls cacheable). Every 1.0.0 call keeps working: the live catalogue is a checked superset of the frozen 1.0.0
one, 39 of the 41 1.0.0 samples are unchanged (the other two quote the version), and `compression.deterministic: true`
bytes are untouched.

An agent calling the tools gets the engine's own determinism verdict (`determinismReport`), the engine's `skipped`
reasons in `verify_zip`, the 17th wrapper code `CANCELLED`, and a contract that moved to `docs/AGENT_CONTRACT.md`
(`AGENTS.md` is now the 120-line brief). The audit of this release closed two ReDoS paths (globs, governance scan), a
sandbox read race (every read through one handle bound by device and inode), an uncoded error path, and — found by the
new seeded fuzz suite — an unchecked `modify_zip` append path that re-emitted overlapping archives.

The repository adopted the hardening of pkinative-mcp 1.0.0 and zipnative 1.1.0: `scripts/gate.ts` as the single
definition of green, `scripts/verify-docs.ts` (28 rules), `scripts/release-prepare.ts`, the sample baseline chain, the
catalogue superset gate, harden-runner and `--ignore-scripts` on every job, a four-job `publish.yml`
(verify → publish → attest → registry) with the MCP registry publication, CodeQL `security-extended`, dependency
review, a weekly audit, committed rulesets and the guarded agent layer. ROADMAP items delivered: the superset gate,
the MCP registry publication job, Zip64 streaming, the engine's 1.1.0 asks (UTC timestamps, `skipped`, determinism by
the engine, the zlib table removed).

Counts (`docs/assets/ecosystem.json`): 15 tools (13 → 15), 7 prompts, 17 wrapper codes (16 → 17), 8 operator variables
(7 → 8); examples 30 → 38; samples in the baseline 41 → 54; veraZIP corpus 38 → 43 archives; tests 1641 across
79 files.

## What changed

### Engine surface (`src/tools/`, shared fragments in `src/*.ts`)
- `canonicalize_zip` (new): `date`, `keepComments`, `keepExternalAttributes`, `includeSha256`, `limits`, output modes; summary with the engine's `analyzeDeterminism()` verdict.
- `merge_zip` (new): `sources[]` (1–32, `zipBase64` | `zipPath`, per-source `filter`), `onConflict`, `verify`, `order`, `comment`, `includeSha256`, streamed file output.
- `access: 'auto' | 'memory' | 'range'` on `inspect_zip`, `list_zip_entries`, `read_zip_entry` (`src/archive-input.ts`, `openZipRange` over the sandbox file's handle).
- `inspect_zip` `determinismReport`, `canonicalDate`, checks `canonical-form` / `canonical-extras` / `canonical-version-made-by`.
- `modify_zip` `canonical` on `mode: 'compact'`; the input is opened eagerly.
- `create_zip` `zip64: true` on stream entries; `limits.maxEntryCompressedSize`; `includeExtendedTimestamps` / `includeUnixIds`.
- `verify_zip` / `read_zip_entry` relay `skipped` (`'unsupported-method'` new); `verify_zip` fails an encrypted entry with a lying local header.
- `dosTimeMode: 'utc'` on every engine call; the node:zlib table removed; `ZIP_TIMESTAMP_CLAMPED` listed.
- Globs: linear-time NFA, 1 024-character bound; `fields` paths refuse prototype segments; `draft_governance_issue` text bounds.

### Server (`src/server.ts`, transports, prompts, resources)
- Cancellation and progress (`src/call-context.ts`), `CANCELLED`; a cancelled result is never cached.
- `ENGINE_ERROR` boundary with absolute paths redacted (`src/errors.ts`); `src/wrapper-codes.ts` (code, meaning, remedy).
- One-handle sandbox reads (`src/sandbox.ts`); the cache reads through one descriptor.
- `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` (fourth ceiling); `ZIPNATIVE_MCP_PORT` / `ZIPNATIVE_MCP_OUTPUT_DIR` validated at boot.
- HTTP: SDK body bound raised to 256 MiB, timeouts, header-count bound, `nosniff`, `no-store`.
- `describe_engine`: `codecs[].incremental`, the fourth ceiling, the new caps and unexposed exports; `SERVER_INSTRUCTIONS` for 15 tools.

### Tooling (`scripts/`)
- `gate.ts`, `verify-docs.ts`, `release-prepare.ts`, `tool-shape.ts` (replaces `tool-shape.mjs`), `generate-samples.ts` / `verify-samples.ts`, `build-claude-rules.ts`, `install-git-hooks.mjs`, `scripts/lib/*`, `scripts/helpers/*`.
- veraZIP core re-vendored from zipnative 1.1.0 (`WF/DESCRIPTOR-WIDTH`, 23 check ids); five new corpus entries.

### CI / repository (`.github/`, root)
- All workflows hardened (harden-runner, SHA pins, `persist-credentials: false`, `--ignore-scripts`, least privilege); `ci.yml` runs the gate on Node 22 / 24, Windows and macOS; `verazip.yml` is one matrix job.
- New: `sample-regression.yml`, `docs.yml`, `audit.yml`, `dependency-review.yml`, `node-current.yml`, `.github/codeql/codeql-config.yml`, `.github/rulesets/{main,tags}.json`, `.github/SECURITY-INSIGHTS.yml`.
- `publish.yml`: verify → publish → attest → registry; dry run on `workflow_dispatch`.
- `.npmrc`, `.node-version`, `.editorconfig`, `.gitattributes`, `.gitignore`, CODEOWNERS, the PR template (renamed to `pull_request_template.md`), Dependabot groups and ignores.
- Dependencies: zipnative ^1.1.0, `@modelcontextprotocol/server` ^2.3.1 (Apache-2.0), zod ^4.6.5, vitest 4.1.11, typescript-eslint 8.71.1, tsx; `@cyclonedx/cyclonedx-npm` removed; js-yaml override.

### Agent layer
- `AGENTS.md` (the 120-line brief), `CLAUDE.md` (`@AGENTS.md` + addendum), `docs/AGENT_CONTRACT.md` (the consumer contract), the instruction files and their rendered rules, the deny list and the guard hook, the release-audit skill, `.github/ai-governance.json` within the 16 KiB always-loaded budget, `.github/prompts/compliance-audit.prompt.md`.

### Tests, examples and samples
- New suites: canonicalize-zip, merge-zip, range-access, cancellation, zip64-streaming, catalogue-superset, zip-fuzz, no-network, prototype-pollution, errors, samples-regression, example-fixtures, reproducible-build, and `tests/tools/` (workflows, gate, guard, verify-docs, release-prepare, tool-shape, agent-config, hermetic-env, json-schema-lite, markdown-anchors, mcp-surface, prose-language).
- Examples 30 → 38; baseline 41 → 54 samples; corpus 38 → 43 archives; frozen example inputs under `tests/fixtures/examples/` with `tests/fixtures/PROVENANCE.md`.

### Documentation
- README, `llms.txt`, SECURITY (supply chain, reproducibility, 1.1.x support), CONTRIBUTING (the gate, release), ROADMAP, SUPPORT, THIRD-PARTY-NOTICES, the knowledge base (106-export ledger), AI guide, API stability (superset gate, 1.1.0 deltas), the guides and the new `docs/guides/LARGE_ARCHIVES.md`, CHANGELOG, CITATION, the release note.

## Verification

What actually ran on the release branch (Windows 11, Node 22.23.2):

| Command | Result |
|---|---|
| `npx tsx scripts/gate.ts --publish --require-all` | 15 steps passed, 0 skipped (typecheck:all, lint, build, dist-check, dist-probe, smoke — 15 tools, verify:tool-shape, server-json, test:generate — 54 samples, test:coverage, verify:docs, verify:samples, corpus:zip — 39 conformant, 4 canaries, verazip, examples:check) |
| `npm run test:coverage` — tests | 1633 passed, 8 skipped (the slow tests, run apart), 0 failed (1641) across 79 files |
| `npm run test:coverage` — coverage | 98.16 % statements / 94.78 % branches / 98.74 % functions / 98.8 % lines (thresholds 94 / 90 / 95 / 94) |
| `npm run build && npm run test:generate && npm run verify:samples` | 54 tracked samples match the baseline (16 byte-exact, 38 semantic) |
| `npm run validate:zip` | 39 PASS, 4 XFAIL, 0 FAIL, 0 XPASS, 0 INFRA (of 43); level 1 locally: Info-ZIP unzip 6.00, 39/39 (the CI images add 7z, python, jar and bsdtar) |
| `npx tsx scripts/tool-shape.ts --check` | tools/list matches tests/_fixtures/tool-shape.json (15 tools, 118944 bytes; instructions 5954 bytes) |
| `npm run verify:docs` | 27 rules passed over 34 documents, 1 skipped (npm-drift, online only) |
| `npm audit --audit-level=high` | found 0 vulnerabilities (full tree) |
| Built server over stdio (`node dist/cli.js`) | `initialize` 2025-06-18 → `zipnative-mcp 1.1.0`, `tools/list` 15 tools, stdout carries JSON-RPC frames only (2 lines, 0 other) |

Linux and macOS are proven by the CI of this pull request (no local Linux host); the `publish.yml` dry run
(`workflow_dispatch`, `dry-run: true`) is the maintainer's pre-tag check.

Independent audit (the `.claude/skills/release-audit/` process, run on the branch from `v1.0.0`; reports under the git-ignored
`.audit/1.1.0/`): two auditors (A — security, hardening, protocol, breaking changes; B — core coverage, documentation
truth, token economy, agent autonomy), an adversarial verifier, then a second verifier pass on the fixes. 73 findings
stamped: 57 confirmed, 7 downgraded, 2 rejected, 7 duplicates — 0 blocker, 7 major, 33 minor, 24 note. Every confirmed
blocker / major / minor finding is fixed on this branch with a lock test named after it (`tests/audit-v1.1.0.test.ts`,
`tests/sandbox.test.ts` A-013, `tests/cli-stdio.test.ts` A-020, `tests/tools/workflows.test.ts` A-004 / A-009 / A-010)
or a documentation fix; A-005 and A-008 are repository settings (steps 3 and 4 below); three engine root causes are
drafted for zipnative (`.github/drafts/issue-zipnative-{verifyzip-signal,eager-local-headers,diagnostic-doc-path}.md`).
A final independent review (fresh reviewer, the artefact, the fix commits, the blind spots) followed: its findings are
closed on the branch — a real 4 GiB + 1 Zip64 stream and the 256 MiB stdio frame now run in the publish gate and
weekly (`ZIPNATIVE_MCP_SLOW_TESTS`), a `__proto__` key is tested over a real stdio frame (the SDK strips a root-level
one before the server; a nested one is `VALIDATION_ERROR`; an object whose prototype was replaced is refused by
`parseInput`), and `release-prepare` re-dates the CHANGELOG heading and the Security Insights stamps.
The 30 v1.0.0 examples replayed against the 1.1.0 build keep their shape. `tools/list` went from 134 857 to 118 944 bytes (`tool-shape.ts --stats`)
(shorter shared descriptions, same schema shape).

## API stability

- `TOOL_API_VERSION`: `1.0.0` → `1.1.0` because two tools, new optional inputs and output fields and one wrapper code were added (docs/API_STABILITY.md).
- Superset gate: the live catalogue is still a superset of the frozen `tests/_fixtures/tool-shape.v1.0.0.json` —
  no tool, property or enum value removed, no new `required`, no tighter bound outside `ACCEPTED_DELTAS`.
- Accepted deltas: a `pattern` on `fields` items (8 read tools, prototype segments refused); `maxLength: 1024` on glob
  items (`list_zip_entries`, `extract_zip`, `scan_zip_forward`); `maxLength: 16384` on five free-text fields of
  `draft_governance_issue`.
- `tests/_fixtures/tool-shape.json`: refreshed in the tools commit for the 15-tool catalogue; unchanged by the version bump.
- Error codes: `CANCELLED` (any tool whose request is cancelled; documented in `docs/AGENT_CONTRACT.md` §6); no `ZIP_*` code added; `ZIP_TIMESTAMP_CLAMPED` joins the diagnostics (unreachable here).

## Output changes and rebaseline

- Default archives of existing tools: byte-identical for every valid input on a UTC host; on another zone, a pinned
  `Z` / offset date now encodes in UTC (1.0.0 wrote host-local fields — ledger C1).
- Bytes inherited from the engine: `compression.deterministic: true` bytes unchanged (the 1.0.0 UTC hash prefix
  `019548d7fb0d676a` is asserted under Kiritimati and Anchorage by `tests/reproducible-build.test.ts`).
- `tests/_fixtures/samples.sha256.json`: 2 entries re-anchored at 1.1.0 (`describe-engine`, `draft-governance-issue` —
  they quote the version), 13 new, 39 unchanged — reason in the manifest's `provenance` note.
- Every item above is declared in the Upgrade section of `release-notes/v1.1.0.md` (C1–C17).

## Out of scope (tracked in ROADMAP.md)

- Decryption (AES / ZipCrypto; engine 2.0 candidate), custom codecs, the `nameEncoding` / `nameDecoder` input, `addRaw`,
  any remote archive source; byte-range reads for `verify_zip` / `extract_zip`; harden-runner `egress-policy: block`.
- `compat-previous` (running the 1.0.0 suite against 1.1.0) is not ported: the 1.0.0 suite exercises internal modules and
  hard-coded counts, so backward compatibility is held by the catalogue superset gate and the sample baseline chain.

## Repository triage (verified with `gh` on 2026-10-18)

| Item | Verdict | Action |
|---|---|---|
| PR #13 (dev-dependencies group: vitest 4.1.11, typescript-eslint, …) | legitimate | integrated here; closes on merge |
| PR #12 js-yaml 4.3.2 | legitimate (dev) | integrated as an `overrides` entry; closes on merge |
| PR #11 vitest 5.0.3 | not mergeable | close: leaves `@vitest/coverage-v8` on 4.x (exact peer), the advisory is fixed in 4.1.11, majors are held back in Dependabot |
| PR #8 upload-artifact 7.0.1, #7 scorecard-action 2.4.4, #6 setup-node 7.0.0 | legitimate | integrated (one SHA per action); close as superseded |
| PR #5 codeql init 4.37.9, #3 upload-sarif 4.37.9 | legitimate but partial | integrated for all four codeql-action sub-actions on one SHA; close as superseded |
| PR #4 @eslint/js 10 | not mergeable | close: eslint stays on 9; the major is ignored in `dependabot.yml` |
| PR #2 @types/node 26 | not mergeable | close: `engines` is `>= 22`; the major is ignored in `dependabot.yml` |
| Dependabot #1, #2 (vitest, @vitest/mocker) | legitimate, dev only | fixed by vitest 4.1.11 |
| Dependabot #3 js-yaml | legitimate, dev only | fixed by the 4.3.2 override |
| Dependabot #4 ip-address, #6 http-cache-semantics | legitimate, dev only, no patch upstream | fixed by removing `@cyclonedx/cyclonedx-npm` (the SBOM is `npm sbom`) |
| Dependabot #7 brace-expansion (GHSA-q2hr-2g5m-vwhr) | legitimate, dev only | the branch lockfile carries 1.1.21; closes on merge |
| Code scanning #8 CodeQL `js/redos` (tests/governance.test.ts) | legitimate | fixed; two real ReDoS in `src/` fixed too |
| Code scanning #9 Scorecard Vulnerabilities | legitimate | resolved by the dependency fixes on the next scan |
| Code scanning #3 Token-Permissions (codeql.yml) | legitimate | fixed: `security-events: write` on the job |
| Code scanning #2 Token-Permissions (publish.yml) | partial | `contents: write` confined to the `attest` job; dismiss the remainder as "won't fix" (id-token and attestations are required by Trusted Publishing and provenance) |
| Code scanning #1 Branch-Protection | legitimate | the live ruleset 22472183 targets no branch; import `.github/rulesets/main.json` (below) |
| Code scanning #4 Code-Review | legitimate | resolves over time through the pull-request flow the ruleset now requires |
| Code scanning #5 Maintained | structural | resolves on its own after 90 days of activity; dismiss or leave |
| Code scanning #6 CII-Best-Practices | structural | optional bestpractices.dev registration; otherwise dismiss |
| Code scanning #7 Fuzzing | partial | the seeded fuzz suite is real value but not what Scorecard detects; leave open (no fuzzing dependency added) |

## Maintainer steps after merge

Agents stop at this draft; everything below is done by the maintainer (`.github/AGENT_RULES.md`).

0. If the tag is not created on 2026-10-18, re-run `npx tsx scripts/release-prepare.ts --version 1.1.0 --previous v1.0.0 --date <YYYY-MM-DD>`: it re-dates CITATION.cff, the ecosystem manifest and its stamps, the `## [1.1.0]` CHANGELOG heading and the Security Insights review dates; then set `_Released …_` in `release-notes/v1.1.0.md` by hand and commit.
1. Push the branch, open the pull request with this body, wait for `ci (22)`, `ci (24)`, `os (windows-latest)`, `os (macos-latest)`, `sample-regression`, `verazip (ubuntu-latest)` and `verazip (windows-latest)`, merge.
2. Close PRs #2, #4, #11 with the reasons above, and #3, #5, #6, #7, #8, #12, #13 as integrated if they do not close themselves; dismiss code-scanning #2 (won't fix, reason above) and, at your discretion, #5 and #6.
3. Replace the live ruleset (it targets no branch): `gh api -X PUT repos/Nizoka/zipnative-mcp/rulesets/22472183 --input .github/rulesets/main.json`, then create the tag ruleset with `gh api -X POST repos/Nizoka/zipnative-mcp/rulesets --input .github/rulesets/tags.json`.
4. Protect the `npm-publish` environment (audit A-005: today it has no protection rule and admins can bypass): Settings → Environments → npm-publish → required reviewer = the maintainer, deployment branches and tags = `v*` tags only, "Allow administrators to bypass" off. Then run `publish.yml` once with `workflow_dispatch` and `dry-run: true` from `main`.
5. Tag `v1.1.0` on the merge commit and publish the GitHub Release (title `v1.1.0 - zipnative 1.1.0 parity, canonicalize and merge, byte-range reads, supply-chain hardening`, body = `release-notes/v1.1.0.md`).
6. Approve the `npm-publish` environment: `publish.yml` re-runs the publish gate, publishes through npm Trusted Publishing, attests the tarball and the SBOM, attaches them to the release and publishes `server.json` to the MCP registry. Confirm with `npm view zipnative-mcp version`.
7. Update the `zipnative-mcp` entry of `docs/assets/ecosystem.json` in the sibling repositories (zipnative, zipnative-cli).
8. Review and file the three upstream drafts under `.github/drafts/issue-zipnative-*.md` in Nizoka/zipnative under your own identity.

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
- [ ] If docs, README, llms.txt, AGENTS.md, CLAUDE.md, `.github/instructions/` or the agent settings changed: `npm run agents:rules` regenerated the rendered rules and `npm run verify:docs` passes
- [ ] CHANGELOG.md updated if user-facing changes
- [ ] For releases: `release-notes/v1.1.0.md` and this draft written, and `npx tsx scripts/gate.ts --publish --require-all` passes locally, which runs every individual gate: `typecheck:all`, `lint`, `build`, `dist-check`, `dist-probe`, `smoke`, `verify:tool-shape`, `server-json`, `test:generate`, `test:coverage`, `verify:docs`, `verify:samples`, `corpus:zip`, `verazip`, `examples:check`
- [ ] Every figure above was produced by a command on this branch, not typed from memory
- [ ] `release-notes/v1.1.0.md` and the CHANGELOG entry for 1.1.0 say the same things as this body
- [ ] No `Co-Authored-By` trailer and no "generated with" footer anywhere on the branch
