# Contributing to zipnative-mcp

Thanks for considering a contribution! This project is intentionally small, focused, and high-quality — the bar is **exactly three runtime dependencies — `zipnative`, the MCP SDK (`@modelcontextprotocol/server` ^2.0.0) and `zod` — and no new one, ever**, and **no ZIP parsing in `src/`**: every byte of ZIP structure belongs to the engine.

## Quick start

```bash
git clone https://github.com/Nizoka/zipnative-mcp.git
cd zipnative-mcp
npm install
npm run typecheck && npm run lint && npm run build && npm test
```

Node.js ≥ 22 is required. Build before the tests: the stdio smoke test drives `dist/cli.js`. For the full local-verification workflow — quality gate, examples-as-tests, checking that produced archives are actually valid (ISO conformance included), writing output to disk, the veraZIP corpus gate, and the MCP Inspector — see [docs/guides/LOCAL_TESTING.md](docs/guides/LOCAL_TESTING.md).

## Workflow

1. **Open an issue first** for non-trivial changes (new tools, breaking changes, dependency additions). The `draft_governance_issue` tool produces a compliant draft; a human submits it.
2. **Branch from `main`**: `git checkout -b feat/my-feature` (use Conventional Commit prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`).
3. **Keep diffs small and focused**. One logical change per PR.
4. **Add tests** for any new behaviour. The CI pipeline runs `npm run typecheck`, `npm run lint`, `npm test` with coverage and `npm run build` on every PR on Linux (Node 22 and 24); the Windows job (Node 22) runs install, `npm run build` and `npm test` only (no audit / typecheck / lint / coverage) — plus the veraZIP conformance gate on Linux and Windows. **Documentation changes run CI too**: `tests/docs-consistency.test.ts` reads README, AGENTS.md, `llms.txt`, `server.json`, `CITATION.cff`, `CLAUDE.md` and `docs/data/*.json`.
5. **Update the changelog** under the `## [Unreleased]` section.

## Coding standards

- TypeScript **strict** mode is mandatory; ESM with `.js` suffixes in relative imports; explicit return types on exports; 4-space indent, single quotes, trailing commas.
- ESLint must pass with **zero warnings** — enforced: `npm run lint` is `eslint src --max-warnings 0`.
- No `any`. Use `unknown` + narrowing.
- Public APIs (anything exported from `src/index.ts`) require TSDoc comments.
- All tool inputs MUST be validated with a Zod `.strictObject` inside the handler, kept in lock-step with the hand-written JSON Schema (`as const`, `additionalProperties: false`) served to clients — the JSON Schema is for clients, the Zod schema is for safety.
- Every engine call goes through `guard` / `guardAsync` / `mapZipError` (`src/zip-errors.ts`) — the only module allowed to read the engine's `err.code`; every result carries `diagnostics[]` from a `createDiagnosticSink`; every byte in or out of the filesystem goes through `src/sandbox.ts` / `src/output.ts`.
- **Never loosen a security default.** Opt-outs skip, they never write anything unsafe; a symlink is never materialised; a file is never overwritten; `limits` never exceed the operator ceilings.
- **No network path.** No command may open a socket. Do not add one.
- Tests: vitest with `globals: false` (import `describe` / `it` / `expect`), one `tests/<name>.test.ts` per tool or module, `_`-prefixed shared fixtures. Hostile archives are built in-test by `tests/_fixtures/raw-zip-builder.ts` and are never committed (the only committed archives are the two foreign-provenance interop fixtures). **Every archive a test produces through a tool must pass `assertValidZip`** (`tests/_zip-assert.ts`) — eager engine open, `verifyZip`, and ISO/IEC 21320-1 conformance by the vendored validator. Tests must be deterministic, run under 60 s per file, and pass on Windows and Linux.

## Adding a new tool

1. Create `src/tools/<tool-name>.ts` exporting:
   - `<TOOL>_NAME` constant
   - `<TOOL>_INPUT_SCHEMA` (JSON Schema, served to clients) and its Zod twin; `<TOOL>_OUTPUT_SCHEMA` (+ `_SUMMARY_PROPERTIES` and a summary function for a read tool)
   - `<toolName>` handler `(args: unknown) => Promise<…Result>`
2. Register the tool in `src/server.ts` (`TOOLS` array with `kind`, `title`, `description`, `annotations`, ≤ 2 executable `examples`; the `ToolOutput` union; the `SERVER_INSTRUCTIONS` decision tree).
3. Add tests in a dedicated `tests/<tool-name>.test.ts` (success, each error code, file mode, the hostile fixtures it must refuse). Every new `ToolError` code must appear in `AGENTS.md` §6 and be named by a test.
4. Document the tool: README matrix and `### \`<tool_name>\`` reference, `AGENTS.md` (catalogue, decision tree, §6), `docs/AI_GUIDE.md` decision table, `llms.txt`, `server.json`, `docs/KNOWLEDGE_BASE.md` (§4, and §8 + `docs/data/core-exports.json` if a new engine export is touched), `docs/API_STABILITY.md` §5, `CLAUDE.md` / `CITATION.cff` / `package.json` counts.
5. Add a worked example under `examples/` (`{ description, tool, arguments }` or `{ description, steps: [...] }`; placeholders limited to `<zip-base64>`, `<rich-zip-base64>`, `<truncated-zip-base64>`, `<hostile-zip-slip-base64>`, `<raw-deflate-base64>`, `<base64 from step N>`) — it is automatically executed by `tests/examples.test.ts` (`npm run examples:check`).
6. If the tool writes archives, add a corpus entry in `scripts/helpers/zip-corpus.mjs` — the corpus definition `scripts/generate-zip-corpus.mjs` drives (see *Conformance validation* below).
7. Refresh the catalogue-parity fixture: `npm run build && node scripts/tool-shape.mjs --write` updates `tests/_fixtures/tool-shape.json`, which `tests/catalogue-parity.test.ts` compares against the live `tools/list` (structure only — descriptions are stripped, so wording never trips it). Any fixture diff is a deliberate schema change and is reviewed under [docs/API_STABILITY.md](docs/API_STABILITY.md) §5 (a new tool is a minor; it may need a `TOOL_API_VERSION` bump). **Never regenerate `tests/_fixtures/tool-shape.v1.0.0.json`** — it is the frozen published 1.0.0 catalogue that the superset gate compares against from 1.1.0 on.
8. Bump the changelog.

## Conformance validation (veraZIP)

ZIP has no reference validator the way PDF/A has veraPDF, so the server ships its own gate, inherited from the engine. `npm run validate:zip` builds `dist/`, drives the **built** tool handlers (plus an engine-independent raw builder for the canaries) to write a **38-archive corpus** to `test-output/zip/` with a `manifest.json` (`scripts/generate-zip-corpus.mjs`), then validates every archive against **ISO/IEC 21320-1:2015** (Document Container File — the ISO-standardised ZIP profile) with `scripts/validate-zip.mjs` and compares each verdict with the manifest's expectation. The expected verdict is every conformant entry `PASS`, the four negative canaries `XFAIL`, `0 FAIL`, `0 XPASS`.

**Independence.** The validator core (`scripts/verazip-core.mjs`) is **vendored** from the engine (`zipnative/scripts/validate-zip.ts`, commit `4f1bc36`, via the 1:1 `.mjs` port in zipnative-cli; the upstream commit and blob hashes are recorded in its header, and `tests/verazip-vendor.test.ts` pins them together with the 22-id check vocabulary and the anti-circularity rule — it never imports `zipnative`, `src/` or `dist/` for parsing). A validator that shared the engine's parser would attest the engine with the engine. When upstream's `validate-zip.ts` changes, re-port the parser body 1:1 (types erased) and bump both hashes in the same PR. The same core backs `assertIsoConformant` in the test suite, so ISO conformance is asserted on every archive a test produces, not only on the corpus.

**The corpus.** The conformant entries cover every writer path the tools expose (`create_zip` buffered, `stream: true`, `parallel`, `compression.deterministic`, store / deflate, comments, `order: 'insertion'` (an EPUB-style `mimetype`-first layout), `extraFields`, `unixMode`, directory entries; `modify_zip` `append` and `compact`) plus the raw-crafted files — a forced-Zip64 layout crafted by the raw builder (`create_zip` Zip64 auto-promotion is covered by `tests/zip64.test.ts`). Four of them are **hostile-but-conformant** (zip-slip, a Windows device name, duplicate paths, a symlink entry): the ISO profile constrains the container's structure, not the meaning of entry names, so they PASS the validator — and the manifest records that `extract_zip` **must refuse** them and with which code (`refusedBy`), which the gate also checks. Four **raw-crafted negative canaries** (`expectConformant: false`) must be rejected with their declared check id — `WF/ENTRY-OVERLAP`, `WF/CD-COUNT`, `WF/LFH-SIZE-MISMATCH`, `WF/LFH-NAME-MISMATCH` (the well-formedness cross-checks lenient extractors forgive). A coverage canary fails the run if a manifest file is missing, is not a ZIP, or a required check id has no canary — a corpus generator that silently dropped a canary would otherwise shrink the gate without anyone noticing. `docs/data/verazip.json` pins the declared counts; the docs-consistency test quotes them.

**Levels.**

- **Level 0** — the ISO/IEC 21320-1 clause checks (no multi-volume, no encryption, no digital-signature record, version needed ≤ 45, forbidden general-purpose bits, UTF-8 discipline, methods 0 / 8 only, no volume labels) plus the APPNOTE well-formedness cross-checks (central directory ↔ local header agreement, offsets, counts, overlaps, data-descriptor validation). **Needs nothing** — pure byte parsing — and **always runs**.
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

**CI is blocking**: the same scripts run with `VERAZIP_REQUIRED=1` on Linux and Windows on **every push and pull request** — `.github/workflows/verazip.yml` carries no `paths:` filter, so it can be a required check without the "Expected — Waiting for status" trap — and again as a pre-publish gate in `.github/workflows/publish.yml`. No dependency is added — the validator is a script and the foreign tools are external.

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

**PR checklist**: if you change anything the server **writes** (`create_zip`, `modify_zip`, `inflate_raw`, entry naming, `src/entry-spec.ts`, the corpus generator) or the validator itself, make sure `npm run validate:zip` passes locally — and remember that exit 0 without any level-1 tool is a skip of level 1, not a proof of it. A new writer path deserves a new corpus entry; a new refusal deserves a new canary.

## Reporting bugs

Use [GitHub Issues](https://github.com/Nizoka/zipnative-mcp/issues) with:
- Reproduction steps (ideally a `tools/call` payload, or the `create_zip` arguments that produce the archive in question — never attach an archive you would not want public).
- Expected vs. actual output (the `_meta.error` block verbatim).
- Node version (`node -v`), OS, and the `describe_engine` result.

**Engine root causes go upstream.** A parse refusal on an archive every other tool opens, a wrong `verify_zip` verdict, a non-conformant archive from `create_zip`, `ZIP_INTERNAL` / `ZIP_API_MISUSE` / `ENGINE_ERROR`, or a `deterministic: true` byte change belong to [Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues); schema, sandbox, projection and transport problems belong here. The `draft_governance_issue` tool (and `npm run verify:issue -- <draft.md>`) produces a compliant draft either way — a human submits it, see [docs/guides/AI_GOVERNANCE.md](docs/guides/AI_GOVERNANCE.md).

## Security issues

**Do not open public issues for security problems.** See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
