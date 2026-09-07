# PR: v1.0.0 — zipnative-mcp, the MCP server on zipnative 1.0.0

<!-- This exact string is reused three times: the PR title, the squash-commit
     subject, and (with the "PR: " prefix dropped and the tail shortened) the
     GitHub Release title: "v1.0.0 — first stable release". -->

> **Branch:** `main` (first release, no release branch — the tag is the release)
> **Type:** first stable release (MAJOR — the initial tool API, `_meta.apiVersion = '1.0.0'`)
> **Distribution:** first npm publication via Trusted Publishing (OIDC) + provenance + SBOM

## Summary

zipnative-mcp 1.0.0 — the Model Context Protocol server for
[zipnative v1.0.0](https://github.com/Nizoka/zipnative), the zero-dependency
TypeScript ZIP engine. **13 tools** expose the engine's frozen 1.0 surface to any MCP
client over stdio or loopback HTTP: inspect and list without extracting, random-access
reads, one-call verification, secure-by-default extraction, forward scanning of
truncated streams, path sanitizing, deterministic and reproducible creation (store /
deflate, worker-parallel, streamed sources), incremental modification without
recompression, CRC-32, bounded raw-DEFLATE inflation, an offline capability manifest
and human-in-the-loop issue drafting. **MCP 2026-07-28** with automatic legacy
fallback, **three runtime dependencies**, **no network code path**, one sandbox for
reads and writes, operator ceilings over every per-call limit, and every archive the
server writes validated against **ISO/IEC 21320-1:2015** by a blocking,
engine-independent conformance gate ("veraZIP") on Linux and Windows and again before
`npm publish`.

Full notes: [`release-notes/v1.0.0.md`](../../release-notes/v1.0.0.md).

## Full engine coverage

Every one of zipnative's **77 exports** (72 from `zipnative`, 5 from `zipnative/worker`)
is mapped in `docs/KNOWLEDGE_BASE.md` §8 and `docs/data/core-exports.json` to the tool
and the input / output field that exercises it, or is deliberately unexposed with a
reason: **62 capability** rows, **9 type-only** rows, **6 unexposed** rows.

| Engine area | Tools |
|---|---|
| `openZip`, `ZipReader`, `ZipEntry`, `EntryVerification`, flags / mode / symlink helpers | `inspect_zip`, `list_zip_entries`, `read_zip_entry` |
| `verifyZip`, `ZipVerificationReport`, `VerifiedEntry` | `verify_zip` |
| `extractZip`, `extractZipStream`, `ExtractOptions`, `sanitizeEntryPath` | `extract_zip`, `sanitize_entry_paths` |
| `iterateZipEntries`, `StreamedZipEntry` / `Header`, `ByteSource` (internal) | `scan_zip_forward` |
| `createZip`, `createParallelZip`, `ZipWriter`, `AddEntryOptions`, `ZipCompressionOptions`, `StreamOptions`, `activeDeflateTier` | `create_zip` |
| `createZipModifier`, `ZipModifier`, `ZipModifierOptions` | `modify_zip` |
| `crc32` | `compute_crc32` |
| `createInflator`, `Inflator`, `getCodec`, `METHOD_*` | `inflate_raw` |
| `VERSION`, `DEFAULT_ZIP_LIMITS`, `ZipLimits`, `DeflateTier`, the error / diagnostic code types | `describe_engine`, the `limits` fragment, `_meta.error` |
| `ZipError` + five subclasses, `ZipErrorCode` families, `ZipDiagnostic*` | `src/zip-errors.ts` (`mapZipError`), `src/diagnostics.ts` — every tool |

**Deliberately unexposed** (the list `describe_engine.unexposed` reports at runtime):

1. `registerCodec` / `ZipCodec` / `CodecCompressOptions` — a codec is executable code; JSON cannot carry one and zipnative ships no extra codec by policy.
2. `setInflateImpl` / `setDeflateImpl` — runtime code injection; the server owns tier selection and reports it (`summary.deflateTier`, `describe_engine.engine.deflateTier`).
3. `initNodeZipCodecs` — a startup concern, called once by `ensureEngineReady()` before serving; not a tool input.
4. `ParallelZipOptions.workerUrl` — a filesystem / bundler path from a tool argument would point the worker at arbitrary code; the packaged worker resolves itself.
5. `ZipCommonOptions.onDiagnostic` — always installed by the server so every result carries `diagnostics[]`; `strict` **is** exposed.
6. `ZipReader.bytes` / `ZipModifier.reader` — the input itself (`bytes` serves only the `modify_zip.summary.noOp` identity check).
7. An external `ByteSource` / Web `ReadableStream` — JSON-RPC has no stream channel; the server builds `ByteSource`s internally from `zipBase64` / `zipPath` / `sourcePath`.
8. The type-only re-exports — `ZipErrorCode` and its six family types (the compile-time `satisfies` guard), `ByteSource` and `StreamOptions` from `zipnative/worker` (aliases of the root declarations).

Engine-side observations recorded in the guides for a future upstream draft
(human-submitted via `draft_governance_issue`): the forward reader's bit-3 exclusions,
the 7-Zip stale-payload differential on append-mode output, and the `deterministic`
verdict requiring epoch timestamps (a pinned non-epoch date is reproducible but
reports `false`).

## Scope

| Phase | Subject |
| --- | --- |
| 0 | Scaffold: `package.json` (three deps, scripts, `mcpName`), `tsconfig` / `eslint` / `vitest` configs copied from pdfnative-mcp, `.editorconfig`, `.nvmrc`, licence, code of conduct, `docs/data/errors.json` + `core-exports.json` from the engine / CLI |
| 1 | Protocol and transport: `src/cli.ts` (stdio with the 256 MiB frame, loopback HTTP), `src/http.ts` bridge + Host / Origin / port guard, `src/auth.ts` bearer token, `src/server.ts` (`TOOLS` registry, `dispatchOutput` by `kind`, `callToolDirect`, cache hints, prompts, resources), `src/resources.ts`, `src/cache.ts`, `src/projection.ts` |
| 2 | Core modules: `caps.ts` (envelope + ceilings), `limits.ts`, `sandbox.ts` (reads and writes, realpath, `wx`), `archive-input.ts`, `base64.ts`, `entry-spec.ts`, `entry.ts` (`EntryView`), `filter.ts`, `diagnostics.ts`, `zip-errors.ts` (`mapZipError`), `engine.ts`, `output.ts`, `governance.ts` |
| 3 | Read tools: `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `scan_zip_forward`, `sanitize_entry_paths` |
| 4 | Write tools: `extract_zip` (plan / inline / streamed file sink), `create_zip` (buffered, streamed, parallel), `modify_zip` (append / compact) |
| 5 | Utilities and governance: `compute_crc32`, `inflate_raw`, `describe_engine` (`UNEXPOSED_EXPORTS`), `draft_governance_issue`, `scripts/verify-issue.mjs`, `.github/ai-governance.json` + `AGENT_RULES.md`, the seven prompts |
| 6 | Tests: `_mcp-harness`, `_http-fixture`, `_zip-fixtures` (benign + hostile via the vendored raw builder), `_zip-assert` (`assertValidZip` incl. ISO conformance), one suite per tool / module, protocol conformance (legacy + 2026-07-28), stdio smoke, examples-as-tests, catalogue parity, docs consistency, error-code inventory |
| 7 | veraZIP: `scripts/verazip-core.mjs` (vendored, hash-pinned), `scripts/generate-zip-corpus.mjs` (manifest with `expectConformant` / `expectedCheck` / `refusedBy` / `integrityExclude`), `scripts/validate-zip.mjs` (levels 0 + 1, outcomes, exit codes, `VERAZIP_REQUIRED`), `scripts/helpers/interop-tools.mjs`, `docs/data/verazip.json`, `tests/verazip-vendor.test.ts` |
| 8 | CI: `ci.yml` (Linux 22 / 24, Windows 22), `verazip.yml` (blocking, both OSes, no `paths:` filter), `codeql.yml`, `scorecard.yml`, `publish.yml` (Release-triggered, gate + veraZIP + SBOM + `npm publish --provenance`), Dependabot, SHA-pinned actions |
| 9 | Docs: README, AGENTS.md, `llms.txt`, `CLAUDE.md`, `server.json`, `CITATION.cff`, `docs/AI_GUIDE.md`, `docs/API_STABILITY.md`, `docs/KNOWLEDGE_BASE.md` (77-export ledger), six guides, examples, SECURITY / CONTRIBUTING / SUPPORT / ROADMAP, CHANGELOG, release notes, this draft |
| 10 | Release: lock-step versions, `tests/_fixtures/tool-shape.json` + frozen `tool-shape.v1.0.0.json`, measured verification table, the go-live runbook below |

## Closes

- **zipnative `docs/assets/ecosystem.json`** — the `zipnative-mcp` slot moves from `"status": "planned"` (version `null`, repo `null`, pin `null`) to released: version `1.0.0`, repo `https://github.com/Nizoka/zipnative-mcp`, pin `^1.0.0` (upstream PR, see the runbook).
- **zipnative ROADMAP → "Post-1.0 satellites (separate repos)"** — the `zipnative-mcp — MCP server mirroring the CLI's JSON contract` item ships (the `EntryView` row, `limits` keys, `inspect` / `verify` reports, diagnostics rows and `errors.json` are shared with `zipnative-cli`).
- This repository's ROADMAP `## Released → v1.0.0` in full; the 1.1.0 items (superset gate, automated registry publish, per-entry Zip64 streaming, AES read-only) stay planned.

## Quality gate

Measured on the final `main` state (Windows 11, Node 22) — CI repeats it on ubuntu with Node 22 and 24 and on windows with Node 22; veraZIP on both.

- `npm run typecheck:all` — 0 errors
- `npm run lint` — 0 errors, 0 warnings (`eslint src --max-warnings 0`)
- `npm run test:coverage` — 45 files, 809 tests passed + 1 skipped (810; the skip is the CI-only dist presence guard); statements 98.22 %, branches 94.84 %, functions 99.00 %, lines 98.77 % (thresholds 94 / 90 / 95 / 94)
- `npm run build` — clean `dist/`; the stdio smoke test drives the built CLI (legacy handshake, 2026-07-28 `server/discover` probe, a multi-MiB frame); `tests/catalogue-parity.test.ts` asserts `tools/list` matches `tests/_fixtures/tool-shape.json` — `tools/list` 94,357 bytes (≈ 94 kB), `SERVER_INSTRUCTIONS` 4,727 bytes (≈ 4.7 kB), 13 tools, 7 prompts, 16 wrapper + 39 `ZIP_*` error codes, 11 diagnostics
- `npm run examples:check` — every `examples/*.json` references a live tool and validates against its `inputSchema`; resolvable single-tool examples execute end-to-end and archive-producing results pass `assertValidZip`; multi-step examples are chained; file-mode examples are shape-checked only
- `npm audit --audit-level=high` — 0 vulnerabilities
- `npm pack --dry-run` — 80 files, 159.5 kB packed (631.7 kB unpacked) (`dist/`, `LICENSE`, `README.md`, `CHANGELOG.md`, `server.json`, `llms.txt`, `package.json`); `server.json` lists the 7 environment variables
- `npm run validate:zip` — 34 PASS / 4 XFAIL / 0 FAIL / 0 XPASS / 0 INFRA of 38 archives, count canary green; level 1 on the release host (Windows 11): unzip 34/34, bsdtar / 7z / python / jar SKIP (not installed) — the CI runners contribute the full tool set on Linux and Windows; corpus of 38 archives (4 raw-crafted negative canaries `expectConformant: false`, hostile-but-conformant entries with `refusedBy` checked); outcomes `PASS` / `FAIL` / `XFAIL` / `XPASS` / `INFRA` / `SKIP`; `VERAZIP_REQUIRED=1` fails closed
- `git log --format=%B | grep -ic claude` — 0

## Byte-identity evidence

Method: fixed inputs through `callToolDirect`, `includeSha256: true`, SHA-256 compared between the two sides of each pair. Every pair is asserted by the test suite (the tool suites for `create_zip` and `modify_zip`) and reproduced by the corpus generator, so the evidence re-runs on every push rather than living in a scratchpad script.

| Pair | Expected | Reason |
| --- | --- | --- |
| `create_zip` with `compression.deterministic: true`, called twice (and across the Linux / Windows CI runners) | identical `summary.sha256` | the engine's frozen pure-TS encoder (level 3 of the determinism contract) |
| `create_zip` default tier, called twice on one runtime | identical | level 2: bytes stable per Node + zlib build |
| `create_zip` `parallel` vs sequential, same `compression` | identical | the worker pool moves `compressSync` to threads; the segment generator is the same |
| `create_zip` `stream: true` vs buffered, same content | different bytes, same content; `inspect_zip` `deterministic: true`, `canonicalLayout: false` | data-descriptor layout by engine contract |
| `modify_zip mode: 'append'` output vs its input | the input is a byte-exact prefix; `summary.grewByBytes ≥ 0`; `inspect_zip.multipleEocd: true` | append-only `save()` |
| `modify_zip mode: 'append'` with no effective edit (same-comment `setComment`) | identical bytes, `summary.noOp: true` | `save()` returns the same buffer |
| `modify_zip mode: 'compact'` vs `create_zip` of the same surviving entries with the same compression | identical entry set and `canonicalLayout: true`; bytes identical when the compressed payloads were produced by the same tier | `saveCompact()` copies compressed bytes into the canonical layout without recompression |
| `defaultDate: 'now'` twice | different bytes; `ZIP_TIMESTAMP_NOT_PINNED`; `summary.deterministic: false`; never cached | documented determinism loss |
| `inflate_raw` on the `read_zip_entry mode: 'raw'` payload vs the entry's content | identical bytes; `compute_crc32 expect: entry.crc32` → `matches: true` | inflation is a pure function of the input |

No unexpected byte change is possible in a first release; the table is the baseline the 1.1.0 superset gate and future byte-identity diffs start from.

## Reviewer checklist

- [ ] `CHANGELOG.md` `[1.0.0]` mirrors `release-notes/v1.0.0.md` bullet for bullet (Added grouped by family, Security).
- [ ] Lock-step versions: `package.json`, `server.json`, `CITATION.cff`, `src/version.ts` (`ZIPNATIVE_MCP_VERSION` and `TOOL_API_VERSION`) all `1.0.0`; `zipnative ^1.0.0`.
- [ ] Tool count 13 everywhere (`tests/docs-consistency.test.ts`: README `### \`<tool>\`` headings, AGENTS.md §1 table in registration order, `llms.txt` `## Tools (13)`, `package.json` / `server.json` / `CITATION.cff` / `CLAUDE.md` say `13 tools`); 7 prompts named in AGENTS.md and README; 7 env vars in `server.json`, README and AGENTS.md.
- [ ] `_meta.apiVersion = '1.0.0'` on every tool; ≤ 2 `_meta.examples` per tool, each validating against its `inputSchema`; every `examples/*.json` executes or is shape-checked.
- [ ] `server.json` validates (`tests/schema-conformance.test.ts` (registry name regex + description ≤ 100 chars) and the `mcp-publisher` CLI (https://github.com/modelcontextprotocol/registry, `mcp-publisher --help`)); description ≤ 100 chars; `llms.txt` and `server.json` are in `package.json` `files`.
- [ ] No `any` (`npm run typecheck:all`), `eslint src --max-warnings 0`, no ZIP parsing in `src/` (the vendored validator core and the raw builder live outside it).
- [ ] No CodeQL alerts; `npm audit --audit-level=high` 0; every workflow action SHA-pinned; `persist-credentials: false` on checkouts.
- [ ] veraZIP green on Linux **and** Windows (`verazip.yml`), corpus counts match `docs/data/verazip.json` and the docs quote them; the four negative canaries `XFAIL`; the hostile-but-conformant entries refused by `extract_zip` with the declared code.
- [ ] `docs/data/core-exports.json` has 77 rows and every name appears in `docs/KNOWLEDGE_BASE.md` §8; `describe_engine.unexposed` matches the "Deliberately unexposed" list above.
- [ ] `tests/_fixtures/tool-shape.json` regenerated on the final build and byte-identical to `tests/_fixtures/tool-shape.v1.0.0.json`.
- [ ] Release notes and CHANGELOG carry no emojis; no Claude co-author or attribution anywhere in the history (`git log --format=%B | grep -ic claude` = 0).

## Merge checklist (the human go-live runbook)

- [ ] Push `main` and the tag to the GitHub remote: `git push origin main --follow-tags`.
- [ ] Create a GitHub **Environment** `npm-publish` with a required reviewer and bind the `publish` job to it — the human-in-the-loop policy becomes a technical control.
- [ ] **npm Trusted Publishing — first-publish caveat.** Trusted Publishing is configured on an *existing* package (npmjs.com → package → Settings → Configure Trusted Publishing: repository `Nizoka/zipnative-mcp`, workflow `publish.yml`, environment `npm-publish`). The package `zipnative-mcp` does not exist yet, so decide **before** creating the Release: either (a) publish a first version manually with a granular, publish-scoped, short-lived token (`npm publish --access public` from a clean checkout of the tag — provenance is not attested for that upload; `publishConfig.provenance` must be temporarily bypassed with `--provenance=false`), then configure Trusted Publishing and let `publish.yml` publish the same version again only if npm allows a re-publish (it does not — so option (a) means 1.0.0 ships without provenance and 1.0.1 is the first attested release); or (b) publish a **placeholder** `0.0.0` (an empty package with the right `name`, `--provenance=false`) to create the package, configure Trusted Publishing on it, deprecate `0.0.0`, and let `publish.yml` publish `1.0.0` with provenance. Option (b) keeps 1.0.0 attested and is the recommended path; record the choice in the Release notes' Verification section.
- [ ] Verify CI is green on the pushed `main`: `ci` (Linux 22 / 24, Windows 22), `verazip-linux`, `verazip-windows`, `CodeQL`, `Scorecard`.
- [ ] Tag the release commit yourself — the tag is the go-live trigger: `git tag -a v1.0.0 -m "zipnative-mcp v1.0.0 — first stable release" && git push origin v1.0.0`.
- [ ] Create the GitHub Release from tag `v1.0.0`, title `v1.0.0 — first stable release`, body = `release-notes/v1.0.0.md` (with every `<TBD:…>` filled from the measured gate).
- [ ] The "Release published" event triggers `.github/workflows/publish.yml`: full gate re-run → veraZIP (Linux) → CycloneDX SBOM attached to the Release → `npm publish --provenance --access public` through the `npm-publish` environment.
- [ ] Post-publish: `npm view zipnative-mcp version` → `1.0.0`; `npm audit signatures` in a consumer project confirms the provenance attestation; `npx -y zipnative-mcp` starts and answers `tools/list` with 13 tools.
- [ ] MCP registry: `tests/schema-conformance.test.ts` (registry name regex + description ≤ 100 chars) and the `mcp-publisher` CLI (https://github.com/modelcontextprotocol/registry, `mcp-publisher --help`), then `mcp-publisher login github && mcp-publisher publish` (manual in 1.0.0; automated in 1.1.0).
- [ ] Upstream PR to `Nizoka/zipnative` updating `docs/assets/ecosystem.json`: `zipnative-mcp` `status` `planned` → `released`, `version` `1.0.0`, `repo` `https://github.com/Nizoka/zipnative-mcp`, `pin` `^1.0.0` (the engine's `verify:docs` pins the counts).
- [ ] GitHub repo settings: branch protection on `main` with the required checks above, secret scanning with push protection, Dependabot alerts; social preview if an asset exists.
