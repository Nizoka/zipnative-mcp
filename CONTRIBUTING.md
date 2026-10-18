# Contributing to zipnative-mcp

Thanks for considering a contribution! This project is intentionally small, focused, and high-quality — the bar is **exactly three runtime dependencies — `zipnative`, the MCP SDK (`@modelcontextprotocol/server` ^2.3.1) and `zod` — and no new one, ever**, and **no ZIP parsing in `src/`**: every byte of ZIP structure belongs to the engine.

## Quick start

```bash
git clone https://github.com/Nizoka/zipnative-mcp.git
cd zipnative-mcp
npm ci --ignore-scripts      # what CI runs; `.npmrc` sets ignore-scripts=true anyway
npm run build                # the gate's smoke step, the sample generator and the corpus drive dist/
npm run gate:fast            # typecheck, lint, tests, server.json, docs checks — the loop while you work
npm run gate                 # the CI profile, before you open a pull request
```

Requirements: Node.js ≥ 22 (CI runs the gate on Linux with Node 22 and 24, and on Windows and macOS with the pinned Node line of `.nvmrc` — all four are required checks). The level-1 foreign extractors of the veraZIP gate (`unzip`, `7z`, `python`, `tar`, `jar`) are optional locally — see [Conformance validation](#conformance-validation-verazip).

For the full local-verification workflow — the gate, examples-as-tests, the sample baseline, checking that produced archives are actually valid (ISO conformance included), writing output to disk, and driving the built server from Claude Code or the MCP Inspector — see [docs/guides/LOCAL_TESTING.md](docs/guides/LOCAL_TESTING.md).

Windows notes: the Bash one-liners run under Git Bash; PowerShell swallows a bare `--` after `npm run`, so pass script flags by calling the script directly (`npx tsx scripts/gate.ts --fast`). Every text file uses LF line endings (`.gitattributes`); the opt-in pre-commit hook refuses a new CRLF text blob.

## Workflow

1. **Open an issue first** for non-trivial changes (new tools, breaking changes, dependency additions). The `draft_governance_issue` tool produces a compliant draft; a human submits it.
2. **Branch from `main`**: `git checkout -b feat/my-feature` (use Conventional Commit prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`). Commits carry no `Co-Authored-By` or "generated with" trailer.
3. **Keep diffs small and focused**. One logical change per PR.
4. **Add tests** for any new behaviour. CI runs [the gate](#the-gate) on every PR: `ci.yml` runs `npx tsx scripts/gate.ts --ci --require-all` on Linux (Node 22 and 24, plus `npm audit --audit-level=high`) and on Windows and macOS; `verazip.yml` repeats the veraZIP corpus on Linux and Windows with `VERAZIP_REQUIRED=1`; `sample-regression.yml` regenerates the sample set and compares it with the baseline whenever a pull request touches what can change an output. All seven jobs are required checks (`.github/rulesets/main.json`). **Documentation changes run CI too**: `npm run verify:docs` (inside the gate, and in `docs.yml`) and `tests/docs-consistency.test.ts` hold README, AGENTS.md, `docs/AGENT_CONTRACT.md`, `llms.txt`, `server.json`, `CITATION.cff`, `CLAUDE.md` and `docs/data/*.json` to the code.
5. **Update the changelog** under the `## [Unreleased]` section.

## The gate

`npm run gate` is THE quality gate — one command, one summary line per step, logs under `test-output/.gate/<step>.log`. The step table is `STEPS` in [`scripts/gate.ts`](scripts/gate.ts):

| Profile | Command | Steps |
|---|---|---|
| Fast — before every commit | `npm run gate:fast` | `typecheck:all`, `lint`, `test`, `server-json`, `verify:docs` |
| CI — the default | `npm run gate` | `typecheck:all`, `lint`, `build`, `dist-check`, `dist-probe`, `smoke`, `verify:tool-shape`, `server-json`, `test:generate`, `test:coverage`, `verify:docs`, `verify:samples`, `corpus:zip`, `verazip`, `examples:check` — the build and the samples come before the coverage run, so the suites that need `dist/` execute (and fail, not skip, when their input is missing) |
| Publish — release branches | `npx tsx scripts/gate.ts --publish --require-all` | the same steps, named for the release workflow; `--require-all` turns any skipped step into a failure |

`--only <step>` runs one step, `--from <step>` resumes from one, `--json` emits a machine-readable result. Four steps are inline: `dist-check` (entry points, the shebang), `dist-probe` (no `console.log` in emitted JavaScript, only `src/` under `dist/`), `smoke` (the **built** server over stdio: handshake, `tools/list`, `describe_engine`, and stdout carrying JSON-RPC frames only) and `server-json` (offline validation against the vendored MCP registry schema). The gate is hermetic: `TZ=UTC`, every inherited `ZIPNATIVE_MCP_*` variable scrubbed, no network (`npm audit` runs beside it in CI). Backward compatibility with 1.0.0 is held by two of its steps: `test:coverage` runs `tests/catalogue-superset.test.ts` (the live `tools/list` against the frozen 1.0.0 catalogue) and `verify:samples` holds every published example to the bytes the release that introduced it emitted. The individual scripts still exist:

```bash
npm run typecheck:all      # tsc over src/ + tests/, then scripts/
npm run lint               # eslint src --max-warnings 0 (a warning fails)
npm run test               # vitest run
npm run test:coverage      # vitest with v8 coverage — thresholds in vitest.config.ts
npm run build              # tsc → dist/
npm run verify:tool-shape  # the built tools/list against tests/_fixtures/tool-shape.json (and the 192 KiB / 8 KiB budgets)
npm run verify:docs        # every count, version, link and parity rule (docs/assets/ecosystem.json)
npm run test:generate      # write the sample set to test-output/samples/ with the BUILT server
npm run verify:samples     # compare it with tests/_fixtures/samples.sha256.json
npm run corpus:zip         # write the veraZIP corpus to test-output/zip/
npm run verazip            # validate it (npm run validate:zip = build + corpus + validation)
npm run examples:check     # run examples/*.json live through the tools/call handler
```

All new code must include tests. Coverage thresholds are enforced once, in `vitest.config.ts` (94 / 90 / 95 / 94 for statements / branches / functions / lines), mirrored in `docs/assets/ecosystem.json`, and **never lowered** to make a change pass — add tests.

Opt-in git hooks: `npm run hooks:install` sets `core.hooksPath` to `.githooks/` for this clone (pre-commit and pre-push checks); `npm run hooks:uninstall` removes them. They are never activated automatically.

Slow tests: the 256 MiB stdio frame edge and the real 4 GiB + 1 Zip64 stream (written into the sandbox, read back by byte ranges; about 8 GiB of disk and several minutes) run only under `ZIPNATIVE_MCP_SLOW_TESTS=1`. The publish gate and the weekly veraZIP run set it; run `ZIPNATIVE_MCP_SLOW_TESTS=1 npx vitest run tests/zip64-streaming.test.ts tests/cli-stdio.test.ts` before a release ([docs/guides/LOCAL_TESTING.md](docs/guides/LOCAL_TESTING.md) §2).

## Coding standards

- TypeScript **strict** mode is mandatory; ESM with `.js` suffixes in relative imports; explicit return types on exports; 4-space indent, single quotes, trailing commas.
- ESLint must pass with **zero warnings** — enforced: `npm run lint` is `eslint src --max-warnings 0`. `no-console` holds: on stdio, stdout is the JSON-RPC channel.
- No `any`. Use `unknown` + narrowing.
- Public APIs (anything exported from `src/index.ts`) require TSDoc comments.
- All tool inputs MUST be validated with a Zod `.strictObject` inside the handler, kept in lock-step with the hand-written JSON Schema (`as const`, `additionalProperties: false`) served to clients — the JSON Schema is for clients, the Zod schema is for safety (`tests/schema-lockstep.test.ts` compares them).
- Every engine call goes through `guard` / `guardAsync` / `mapZipError` (`src/zip-errors.ts`) — the only module allowed to read the engine's `err.code`; every archive tool's result carries `diagnostics[]` from a `createDiagnosticSink`, which also carries `dosTimeMode: 'utc'`, the cancellation signal and the progress sink into every engine call that takes them (`verifyZip` takes only `limits`, so `verify_zip` runs its report's diagnostics through a sink afterwards and cannot be interrupted once it starts); every byte in or out of the filesystem goes through `src/sandbox.ts` / `src/output.ts` (one open handle per read); every size through `src/caps.ts`; every bound through `src/limits.ts`.
- **Never loosen a security default.** Opt-outs skip, they never write anything unsafe; a symlink is never materialised; a file is never overwritten; `limits` never exceed the operator ceilings.
- **No network path.** No module may open a socket, and no input may name a URL (`tests/no-network.test.ts`). Do not add one.
- English everywhere — code, comments, tests, examples, docs and release notes (`verify:docs` rule `prose-language`).
- Tests: vitest with `globals: false` (import `describe` / `it` / `expect`), one `tests/<name>.test.ts` per tool or module, `_`-prefixed shared fixtures. Hostile archives are built in-test by `tests/_fixtures/raw-zip-builder.ts` and are never committed (the only committed archives are the foreign-provenance interop fixtures and the frozen example inputs, pinned by `tests/fixtures/SHA256SUMS`). **Every archive a test produces through a tool must pass `assertValidZip`** (`tests/_zip-assert.ts`) — eager engine open, `verifyZip`, and ISO/IEC 21320-1 conformance by the vendored validator. Tests must be deterministic (the fuzz suite is seeded), run under 60 s per file, and pass on Windows, macOS and Linux.

## Adding a new tool

A new or changed tool touches **all** of these (`verify:docs` rules `tool-parity`, `error-parity` and `env-var-parity` fail on a missed step):

1. `src/tools/<tool-name>.ts` exporting the `<TOOL>_NAME` constant, `<TOOL>_INPUT_SCHEMA` (JSON Schema `as const`, served to clients, composed from the shared fragments in `limits.ts`, `filter.ts`, `entry-spec.ts`, `canonical.ts`, `projection.ts`, `output.ts`, `archive-input.ts`) and its Zod twin, `<TOOL>_OUTPUT_SCHEMA` (+ `_SUMMARY_PROPERTIES` and a summary function for a read tool), and the handler `(args: unknown, context?: CallContext) => Promise<…Result>` that hands the call context to its diagnostic sink.
2. Register the tool in `src/server.ts` (`TOOLS` array with `kind`, `title`, `description`, `annotations`, ≤ 2 executable `examples`; the `ToolOutput` union; the `SERVER_INSTRUCTIONS` decision tree).
3. Add tests in a dedicated `tests/<tool-name>.test.ts` (success, each error code, file mode, the hostile fixtures it must refuse). Every new wrapper code must appear in `src/wrapper-codes.ts` with a remedy, in `docs/AGENT_CONTRACT.md` §6 and be named by a test — `tests/error-codes.test.ts` enforces it.
4. Add a worked example under `examples/` (`{ description, tool, arguments }` or `{ description, steps: [...] }`; placeholders limited to the documented vocabulary — `<zip-base64>`, `<rich-zip-base64>`, `<truncated-zip-base64>`, `<hostile-zip-slip-base64>`, `<raw-deflate-base64>`, `<base64 from step N>`) — it is executed by `tests/examples.test.ts` (`npm run examples:check`) and rendered into the sample baseline (`npm run build && npm run test:generate && npx tsx scripts/verify-samples.ts --update` records a new sample).
5. If the tool writes archives, add a corpus entry in `scripts/helpers/zip-corpus.mjs` — the corpus definition `scripts/generate-zip-corpus.mjs` drives (see *Conformance validation* below).
6. Refresh the catalogue fixture: `npm run build && npx tsx scripts/tool-shape.ts --write` updates `tests/_fixtures/tool-shape.json`, which `tests/catalogue-parity.test.ts` and the gate step `verify:tool-shape` compare against the live `tools/list` (structure only — descriptions are stripped, so wording never trips it; the 192 KiB catalogue and 8 KiB instructions budgets are checked too). Any fixture diff is a deliberate schema change reviewed under [docs/API_STABILITY.md](docs/API_STABILITY.md) §5 (a new tool is a minor; it may need a `TOOL_API_VERSION` bump). **Never regenerate `tests/_fixtures/tool-shape.v1.0.0.json`** — it is the frozen published 1.0.0 catalogue that `tests/catalogue-superset.test.ts` compares against for the whole 1.x line.
7. Document the tool: README matrix and `### \`<tool_name>\`` reference, [`docs/AGENT_CONTRACT.md`](docs/AGENT_CONTRACT.md) (catalogue, decision tree, §6), `docs/AI_GUIDE.md` decision table, `llms.txt`, `server.json`, `docs/KNOWLEDGE_BASE.md` (§4, and §8 + `docs/data/core-exports.json` if a new engine export is touched), `docs/API_STABILITY.md` §5, the counts in `docs/assets/ecosystem.json`, `CLAUDE.md` / `CITATION.cff` / `package.json` — then run `npm run verify:docs`.
8. Bump the changelog.

## Conformance validation (veraZIP)

ZIP has no reference validator the way PDF/A has veraPDF, so the server ships its own gate, inherited from the engine. `npm run validate:zip` builds `dist/`, drives the **built** tool handlers (plus an engine-independent raw builder for the canaries) to write a **43-archive corpus** to `test-output/zip/` with a `manifest.json` (`scripts/generate-zip-corpus.mjs`), then validates every archive against **ISO/IEC 21320-1:2015** (Document Container File — the ISO-standardised ZIP profile) with `scripts/validate-zip.mjs` and compares each verdict with the manifest's expectation. The expected verdict is 39 PASS (every conformant entry), 4 XFAIL (the negative canaries), `0 FAIL`, `0 XPASS`.

**Independence.** The validator core (`scripts/verazip-core.mjs`) is **vendored** from the engine (`zipnative/scripts/validate-zip.ts` at commit `e6f0b3f`, the zipnative 1.1.0 commit, via the 1:1 `.mjs` port in zipnative-cli 1.0.0; the upstream commit and blob hashes are recorded in its header, and `tests/verazip-vendor.test.ts` pins them together with the 23-id check vocabulary and the anti-circularity rule — it never imports `zipnative`, `src/` or `dist/` for parsing). The 1.1.0 re-port carries the one parser change since 1.0.0: the data-descriptor width is keyed on the local header's Zip64 extra (APPNOTE 4.3.9.2, `WF/DESCRIPTOR-WIDTH`), the layout of the Zip64 streaming opt-in. A validator that shared the engine's parser would attest the engine with the engine. When upstream's `validate-zip.ts` changes, re-port the parser body 1:1 (types erased) and bump both hashes in the same PR. The raw builder and the interop probes are unchanged upstream since 1.0.0 (their pinned blobs are the same at the 1.1.0 tag). The same core backs `assertIsoConformant` in the test suite, so ISO conformance is asserted on every archive a test produces, not only on the corpus.

**The corpus.** The conformant entries cover every writer path the tools expose (`create_zip` buffered, `stream: true`, a `zip64: true` streamed entry, `parallel`, `compression.deterministic`, store / deflate, comments, `order: 'insertion'` (an EPUB-style `mimetype`-first layout), `extraFields`, `unixMode`, directory entries; `modify_zip` `append`, `compact` and `compact` with `canonical`; `canonicalize_zip` over an append-mode archive — idempotence asserted — and with a pinned date; `merge_zip`) plus the raw-crafted files — a forced-Zip64 layout crafted by the raw builder (`create_zip` Zip64 auto-promotion is covered by `tests/zip64.test.ts`). Four of them are **hostile-but-conformant** (zip-slip, a Windows device name, duplicate paths, a symlink entry): the ISO profile constrains the container's structure, not the meaning of entry names, so they PASS the validator — and the manifest records that `extract_zip` **must refuse** them and with which code (`refusedBy`), which the gate also checks. Four **raw-crafted negative canaries** (`expectConformant: false`) must be rejected with their declared check id — `WF/ENTRY-OVERLAP`, `WF/CD-COUNT`, `WF/LFH-SIZE-MISMATCH`, `WF/LFH-NAME-MISMATCH` (the well-formedness cross-checks lenient extractors forgive). A coverage canary fails the run if a manifest file is missing, is not a ZIP, or a required check id has no canary — a corpus generator that silently dropped a canary would otherwise shrink the gate without anyone noticing. `docs/data/verazip.json` pins the declared counts; `verify:docs` (rule `verazip-counts`) and the docs-consistency test hold every quoted figure to them.

**Levels.**

- **Level 0** — the ISO/IEC 21320-1 clause checks (no multi-volume, no encryption, no digital-signature record, version needed ≤ 45, forbidden general-purpose bits, UTF-8 discipline, methods 0 / 8 only, no volume labels) plus the APPNOTE well-formedness cross-checks (central directory ↔ local header agreement, offsets, counts, overlaps, data-descriptor validation and width). **Needs nothing** — pure byte parsing — and **always runs**.
- **Level 1** — every conformant archive is re-tested with the foreign integrity tools present on the machine (`scripts/helpers/interop-tools.mjs`, vendored from the engine): `tar -tf` (bsdtar), `unzip -t`, `7z t`, `python -m zipfile -t`, `jar tf`. Exit codes are read per each tool's own contract (unzip's and 7-Zip's documented exit 1 "warnings" count as a pass). Absent tools are reported as `SKIP integrity <tool>` — never simulated; documented per-file exclusions (`integrityExclude`) carry known tool limitations instead of loosened exit codes (7-Zip on SFX prefixes and on append-mode `modify_zip` output, where it reads the stale payload — see [docs/guides/INCREMENTAL.md](docs/guides/INCREMENTAL.md)).
- Level 2 (the differential-extraction matrix) stays in zipnative's own interop suite.

**Outcomes** per manifest file: `PASS` (conformant as expected, and refused by the named tool when `refusedBy` is set), `FAIL` (non-conformant although expected conformant, a negative that failed with the *wrong* check id, or a `refusedBy` tool that did not refuse), `XFAIL` (negative canary rejected with its declared id), `XPASS` (a negative canary accepted — the validator is not validating; always fatal), `INFRA` (parser exception / unreadable file — not a verdict), `SKIP` (a level-1 tool absent). Per-file JSON reports and a `summary.json` land in `test-output/zip/reports/`.

| Exit | Meaning |
|------|---------|
| 0 | Every expectation met — **or** no level-1 tool is usable and `VERAZIP_REQUIRED` is unset: level 1 is **SKIPPED** (exit 0 is a skip of level 1, not a pass of it; level 0 verdicts still hold) |
| 1 | A conformance expectation was not met (`FAIL` / `XPASS`), a level-1 tool rejected a conformant archive, the coverage canary tripped, the corpus has no negative canary, or a required check id has no canary |
| 2 | Corpus directory / manifest absent — run `npm run corpus:zip` first |
| 3 | `INFRA`: a file produced an INFRA outcome, or (`VERAZIP_REQUIRED=1` only) zero level-1 tools are usable |

Environment: `VERAZIP_REQUIRED=1` fails closed (no usable level-1 tool → exit 3 instead of a skip; set in CI, unset locally so a bare machine never blocks).

**CI is blocking**: the gate runs the corpus and its validation (`corpus:zip`, `verazip`) with `VERAZIP_REQUIRED=1` in `ci.yml` on Linux (Node 22 and 24), Windows and macOS; `.github/workflows/verazip.yml` repeats it on Linux and Windows on **every push and pull request to `main`** (plus manual dispatch) — it carries no `paths:` filter, so it can be a required check without the "Expected — Waiting for status" trap — and `publish.yml` runs it again inside the publish gate. No dependency is added — the validator is a script and the foreign tools are external.

Installing the level-1 tools locally (**level 0 needs nothing**):

```bash
# macOS (bsdtar, python3 and jar ship with the OS / Xcode / a JDK; unzip is built in)
brew install p7zip

# Debian / Ubuntu
sudo apt-get install unzip p7zip-full python3 default-jdk-headless   # bsdtar: libarchive-tools
```

```powershell
# Windows — tar.exe (bsdtar) is built in since Windows 10; Python from python.org or winget
winget install 7zip.7zip
winget install Python.Python.3.12
# jar comes with any JDK (e.g. winget install Microsoft.OpenJDK.21); Info-ZIP unzip is optional
```

**Before a PR**: if you change anything the server **writes** (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw`, entry naming, dates, `src/entry-spec.ts`, `src/canonical.ts`, the corpus generator) or the validator itself, make sure `npm run validate:zip` passes locally — and remember that exit 0 without any level-1 tool is a skip of level 1, not a proof of it. A new writer path deserves a new corpus entry; a new refusal deserves a new canary.

## Documentation and the ecosystem manifest

`docs/assets/ecosystem.json` is the single source of every count and version quoted in the docs (`packages`, `declared`, `derived`, `assertions`). `npm run verify:docs` (`scripts/verify-docs.ts`, 28 offline rules, `--rules` lists them) recomputes the derived counts from the source tree (the tool registry and the prompts, every wrapper code, the `ZIP_*` and diagnostic codes, the `ZipLimits` keys, the operator variables, `examples/`, `tests/`, the sample baseline, the veraZIP corpus) and holds README, `docs/`, `llms.txt`, AGENTS.md, CLAUDE.md, the Copilot file, the changelog ladder, the rulesets, the agent configuration and the PR template to it: stale counts, stale versions, tool / error-code / operator-variable parity between `src/` and the docs, links and heading anchors, `Verified on` stamps, English-only prose and no secret material.

A line that legitimately quotes a superseded figure (release history) opts out with `verify-docs:allow <rule>` — an HTML comment at the end of that line, or on the line above when the line is a table row or a heading. The marker is for genuine history only, never to silence a stale current claim.

Touching a count or a version means editing the manifest **and** running `verify:docs`. `declared` holds the figures no filesystem walk can derive (measured at release); `derived` is recomputed and fails on drift.

## Agent contract

Two documents, two audiences:

- [AGENTS.md](AGENTS.md) — the **repository rules** for coding agents working *on* the server (mission and constraints, the gate, where is what, the tool wiring, never-touch and generated files). [CLAUDE.md](CLAUDE.md) adds what is specific to Claude Code; [.github/copilot-instructions.md](.github/copilot-instructions.md) carries the same conventions for Copilot. Keep them consistent.
- [docs/AGENT_CONTRACT.md](docs/AGENT_CONTRACT.md) — the **consumer contract** for agents that *use* the server (tool catalogue, decision tree, token economy, recipes, error codes in §6). A tool input, output field or error-code change is a change to this contract and is reviewed under [docs/API_STABILITY.md](docs/API_STABILITY.md).

`.claude/rules/*.md` are generated from `.github/instructions/*.instructions.md` by `npm run agents:rules` and never edited by hand: edit the instruction file, regenerate, and `verify:docs` rule `claude-rules-sync` fails on drift. Agents never push, tag, open PRs or issues, or publish (`.github/AGENT_RULES.md`; enforced in Claude Code by `.claude/hooks/guard.mjs`); issue and PR drafts go to `.github/drafts/` and a human submits them.

## Pull Request Checklist

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
- [ ] For releases: follow [Release](#release) — `release-notes/vX.Y.Z.md` and `.github/drafts/pr-vX.Y.Z.md` written, and `npx tsx scripts/gate.ts --publish --require-all` passes locally, which runs every individual gate: `typecheck:all`, `lint`, `build`, `dist-check`, `dist-probe`, `smoke`, `verify:tool-shape`, `server-json`, `test:generate`, `test:coverage`, `verify:docs`, `verify:samples`, `corpus:zip`, `verazip`, `examples:check`

## Release

Releases are cut by the maintainer, never by an agent (`.github/AGENT_RULES.md`; the guard hook in `.claude/hooks/guard.mjs` refuses push, tag, release and publish commands).

1. Decide the SemVer level (a new tool or a new optional input is a minor; a byte change in what `create_zip` writes with `compression.deterministic: true` is semver-major).
2. Run `npx tsx scripts/release-prepare.ts --version X.Y.Z` (optionally `--date YYYY-MM-DD`, `--previous vA.B.C`; `--dry-run` previews). It applies the mechanical bump in one pass — `package.json` / `package-lock.json`, `src/version.ts` (`ZIPNATIVE_MCP_VERSION`), `server.json` (twice), `docs/assets/ecosystem.json` (version + `verifiedOn`) and the `Verified on` stamps, `CITATION.cff` (`version` + `date-released`), the supported-versions table of `SECURITY.md`, the README engine badge and the `Current release` prose — and scaffolds `release-notes/vX.Y.Z.md` and `.github/drafts/pr-vX.Y.Z.md`; it never commits, tags or publishes. Bump `TOOL_API_VERSION` by hand, only when a schema or an error code changed.
3. Write `release-notes/vX.Y.Z.md` (no emojis), mirror it into `CHANGELOG.md`, update `ROADMAP.md`, refresh every count the manifest governs (`declared.tests` and the coverage figures come from the last gate run), and fill the pull request draft in `.github/drafts/pr-vX.Y.Z.md`.
4. Run `npx tsx scripts/gate.ts --publish --require-all` locally; the same profile runs again in `publish.yml`.
5. Merge, tag `vX.Y.Z` on the merge commit and publish the GitHub Release. The release triggers `publish.yml`: `verify` (the publish gate, one `npm pack`, the CycloneDX SBOM, the digests) → `publish` (the `npm-publish` environment, Trusted Publishing over OIDC, `--provenance`) → `attest` (the registry bytes compared with the packed tarball, the build-provenance attestation, the tarball and SBOM attached to the release) → `registry` (`server.json` to the MCP registry through the pinned `mcp-publisher`). A `workflow_dispatch` with `dry-run: true` exercises the whole chain without uploading anything.

## Reporting bugs

Use [GitHub Issues](https://github.com/Nizoka/zipnative-mcp/issues) with:
- Reproduction steps (ideally a `tools/call` payload, or the `create_zip` arguments that produce the archive in question — never attach an archive you would not want public).
- Expected vs. actual output (the `_meta.error` block verbatim).
- Node version (`node -v`), OS, and the `describe_engine` result.

**Engine root causes go upstream.** A parse refusal on an archive every other tool opens, a wrong `verify_zip` verdict, a non-conformant archive from `create_zip`, `canonicalize_zip` or `merge_zip`, `ZIP_INTERNAL` / `ZIP_API_MISUSE` / `ENGINE_ERROR`, or a `deterministic: true` byte change belong to [Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues); schema, sandbox, projection and transport problems belong here. The `draft_governance_issue` tool (and `npm run verify:issue -- <draft.md>`) produces a compliant draft either way — a human submits it, see [docs/guides/AI_GOVERNANCE.md](docs/guides/AI_GOVERNANCE.md).

## Security issues

**Do not open public issues for security problems.** See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
