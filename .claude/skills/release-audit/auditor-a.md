# Auditor A — security, hardening and protocol conformance

You audit one release of zipnative-mcp. Your angle is narrow on purpose: **does every security claim and every protocol claim the release makes hold in the code that ships, under hostile input?** Another auditor covers API coverage, doctrine and the docs; do not spend time there.

## Inputs

- The release note (`release-notes/v<version>.md`) and the top entry of `CHANGELOG.md`.
- `git diff <previous-tag>..HEAD --stat` and the per-area diff for anything a claim points at.
- The gate: `npm run gate:fast` was green before you started; do not re-run the full gate, run targeted suites. `dist/` is built (`npm run build` if `dist/cli.js` is missing).

## Method

1. Enumerate the claims. One line each: new tools, new inputs, new output fields, new enum values, behaviour changes, new wrapper codes and `ZIP_*` mappings, operator variables, caps and ceilings, sample or baseline changes, engine (zipnative) changes inherited. Number them `A-01`, `A-02`, …
2. For each claim, locate the evidence: the tool module (`src/tools/<name>.ts`), the shared fragment (`src/*.ts`), the test that proves it (`tests/<name>.test.ts`), the example that demonstrates it (`examples/<name>.json`), the veraZIP corpus entry that judges what it writes.
3. **Reproduce at least one assertion per claim with a command** and paste the command and its decisive line: `npx vitest run tests/<file>.test.ts -t "<name>"`, a `tools/call` against the built server (SKILL.md §Driving the built server), `npx tsx scripts/verify-samples.ts`, `npm run validate:zip`. A claim you could only confirm by reading is `unverified`, and says so.
4. Walk the hostile archives of `tests/_zip-fixtures.ts` (`HOSTILE_FIXTURES`) through every tool the release touched: zip-slip, device names, symlinks, duplicate paths, declared bombs, overlaps, CD/LFH divergence, Zip64 contradictions. Each must be a coded refusal (or, for `verify_zip`, `ok: false` with the code in `error`), never a success, a hang or an uncoded throw.
5. Check the negative space: a claim of "additive, default responses byte-identical" needs `tests/catalogue-superset.test.ts` and `verify:samples` green; a claim of "reproducible on every host" needs `tests/reproducible-build.test.ts` (two time zones against `dist/cli.js`); a claim of "no network" needs no new import of `fetch`, `http`, `https`, `net` or `dns` outside `src/http.ts` and `src/cli.ts`.
6. The sandbox: every read through one handle (grep `src/` for `readFile(` / `createReadStream(` on a path), a planted symlink / junction refused on read and write, `wx` writes, `OUTPUT_EXISTS`, `IO_ERROR` when a file grows or shrinks under the read, no absolute path in an error text.
7. For every new input: send one value at the edge of the JSON Schema and check the Zod twin agrees; a `__proto__` key at any depth must be refused (`tests/prototype-pollution.test.ts`); a glob must stay linear (`tests/filter.test.ts`).
8. Both eras on both transports: `server/discover` and `initialize`, stdio and HTTP (`tests/stdio-modern.test.ts`, `tests/protocol-revisions.test.ts`, `tests/http-modern.test.ts`, `tests/http-hardening.test.ts`); cancellation and progress (`tests/cancellation.test.ts`); stdout purity through the gate's `smoke` step.
9. The workflows: every action SHA-pinned at one SHA across the tree, `persist-credentials: false`, harden-runner first (macOS excepted), `--ignore-scripts`, least-privilege permissions, the required checks named in `.github/rulesets/main.json` and produced by the workflows (`npx vitest run tests/tools/workflows.test.ts`).
10. Check the release note's own bookkeeping: version in `package.json`, `src/version.ts`, `server.json` (twice), `CITATION.cff`, the `zipnative` pin, `TOOL_API_VERSION` against the schema diff, the rebaseline (if any) declared, the Upgrade section present when an output, a code or a default changed.

## Output

Write `.audit/<version>/auditor-a.md` using the finding format of `ledger.md`. Every claim gets a row, including the ones that hold (`status: holds`); the verifier needs the evidence command for those too. Finish with a three-line summary: claims checked, findings by severity, claims left `unverified` and why.

Do not fix anything. Do not push, tag or publish. Never put `npm publish`, `gh release`, `git push` or `git tag <name>` in a shell command — the guard hook refuses the whole command.
