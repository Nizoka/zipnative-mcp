# scripts/ — the quality gate, the sample set, the veraZIP corpus and the verifiers

Maintenance scripts run with `tsx` (TypeScript, no build step) or `node` (the vendored
`.mjs` validators) and drive the **built** server (`dist/server.js`, the same
`callToolDirect()` the `tools/call` handler delegates to — never `src/`) wherever an
artefact is produced. The tool catalogue is discovered at run time (`toolNames()`,
`listToolsPayload()`): no script hard-codes a tool list. The npm aliases in `package.json`
are the public names; call a script directly to pass flags (PowerShell swallows a bare `--`
after `npm run`). `scripts/tsconfig.json` extends `../tsconfig.scripts.json` so an editor
types these files as `typecheck:scripts` does.

The external judge of this server is veraZIP (the role veraPDF plays for pdfnative-mcp):
`verazip-core.mjs`, an ISO/IEC 21320-1 validator vendored from the engine with its own raw
parser, never imports `zipnative`, `src/` or `dist/` — the engine does not attest itself.

## Quick start

```bash
npx tsx scripts/gate.ts --fast                  # typecheck:all, lint, test, server-json, verify:docs — the loop while you work
npm run gate                                    # the CI profile (default)
npx tsx scripts/gate.ts --publish --require-all # the release profile (publish.yml): a skip is a failure
npm run build && npm run test:generate && npx tsx scripts/verify-samples.ts   # the sample baseline
npm run validate:zip                            # build + corpus + ISO/IEC 21320-1 validation
```

## The scripts

| Script | npm alias | What it does |
|---|---|---|
| `gate.ts` | `gate`, `gate:fast` | The single definition of green: the `STEPS` table, three profiles, `--only` / `--from` / `--json` / `--require-all`, logs under `test-output/.gate/`. |
| `verify-docs.ts` | `verify:docs` | 28 offline rules holding every count, version, link, anchor and parity claim of the docs to `docs/assets/ecosystem.json` and the source (`--online` adds the npm drift check). |
| `tool-shape.ts` | `verify:tool-shape` | `tools/list` structure against `tests/_fixtures/tool-shape.json` and the size budgets (`--write` refreshes it deliberately, `--stats` measures). |
| `generate-samples.ts` / `verify-samples.ts` | `test:generate` / `verify:samples` | Every `examples/*.json` through the built server under the hermetic environment, fingerprinted against `tests/_fixtures/samples.sha256.json` (a `since` chain; `--update` rebaselines, `--strict` refuses an untracked sample). |
| `generate-zip-corpus.mjs` | `corpus:zip` | Writes the veraZIP corpus (`helpers/zip-corpus.mjs`) to `test-output/zip/` with its manifest. |
| `validate-zip.mjs` | `verazip` | Level 0 (ISO/IEC 21320-1 clauses, `verazip-core.mjs`) and level 1 (the foreign extractors present, `helpers/interop-tools.mjs`) over the corpus; `VERAZIP_REQUIRED=1` fails closed without a level-1 tool. |
| `release-prepare.ts` | `release:prepare` | The version bump in one pass (`--version`, `--date`, `--previous`, `--dry-run`): manifests, lock-step files, stamps, CITATION, SECURITY table, the CHANGELOG heading date, Security Insights dates; scaffolds the release note and the PR draft. |
| `verify-issue.mjs` | `verify:issue` | The governance policy check of an issue draft (the same rules as `draft_governance_issue`). |
| `build-claude-rules.ts` | `agents:rules` | Renders `.github/instructions/*.md` into the agent rules (`--check` compares). |
| `install-git-hooks.mjs` | `hooks:install` / `hooks:uninstall` | Opt-in `core.hooksPath` to `.githooks/`. |
| `helpers/` | — | `hermetic.ts` (TZ=UTC, operator variables scrubbed), `io.ts` (placeholder vocabulary, fixture inputs), `server.ts` (the built server without a transport), `tz.ts`, `zip-corpus.mjs`, `raw-zip-builder.mjs` (hostile canaries, engine-independent), `interop-tools.mjs`. |
| `lib/` | — | Shared logic of the verifiers: `mcp-surface.ts`, `agent-config.ts`, `markdown-anchors.ts`, `prose-language.ts`, `secret-needles.ts`, `tool-shape.ts`, `json-schema-lite.ts`, `example-runner.ts`, `sample-fingerprint.ts`. |

## Exit codes

Every script follows the same convention, so the gate can tell "the check failed" from
"the tool is missing": `0` every expectation met · `1` a check failed (the output names it)
· `2` usage error · `3` infrastructure (a required external tool is unusable — never a
verdict). The vendored validators pin their upstream commit and blob in their header;
re-port 1:1 and bump the hashes in the same change (`tests/verazip-vendor.test.ts`).
