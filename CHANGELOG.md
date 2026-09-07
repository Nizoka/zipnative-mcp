# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-07

The first stable release — and the first npm publication — of the MCP server for
[zipnative v1.0.0](https://github.com/Nizoka/zipnative), the zero-dependency
TypeScript ZIP engine. **13 tools** expose the engine's full frozen surface (77
exports mapped, 39 error codes passed through verbatim, the `deterministic: true`
byte contract inherited) to any MCP client over stdio or loopback HTTP, speaking
**MCP 2026-07-28** with automatic fallback to the 2025-era handshake. **Three
runtime dependencies** (zipnative, the MCP SDK, zod), **no network code path**,
secure-by-default extraction with one sandbox for reads and writes, and every
archive the server writes validated against **ISO/IEC 21320-1:2015** by a blocking
engine-independent conformance gate ("veraZIP") on Linux and Windows and before
every publish.

### Added

#### Tools — read (5)
- **feat(tool): inspect_zip** — one-call archive report (counts, Zip64, comment, totals, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date range), a determinism verdict (`deterministic` = reproducible, `canonicalLayout` = no data descriptors), every diagnostic, `check[]` (15 assertions) + `assert {…}` → `checks[]` / `checksPassed`; opens eagerly by default so every entry's real extent (overlaps, reach into the central directory or past EOF, Zip64 spoofing) is refused with its `ZIP_*` code — a central/local method / CRC / size divergence is `verify_zip`'s and the read paths' verdict.
- **feat(tool): list_zip_entries** — paged central-directory inventory (default 200, max 2000, `hasMore`) with `filter` (names / prefix / globs), the shared `EntryView` row (decoded flags, Unix mode, `sanitizedPath`, named extra fields, `rawNameHex`), `includeExtraData`, lazy or eager validation.
- **feat(tool): read_zip_entry** — one entry by `name` (last duplicate wins) or `index`; `mode: 'data'` (base64 or UTF-8 `text`, CRC-verified, `range` window through the chunked stream), `'raw'` (compressed payload verbatim), `'verify'` (CRC / size / local-header agreement); 16 MiB inline cap.
- **feat(tool): verify_zip** — the engine's `verifyZip` report verbatim; never `isError` for an archive problem (structural refusal in `error { code, message }`, encrypted / stream-only-codec entries `skipped`, an unregistered-method entry reported failed); `entries: 'all' | 'failed' | 'skipped' | 'none'`, `maxEntries`.
- **feat(tool): scan_zip_forward** — forward, central-directory-less reader over truncated or unseekable input that starts at a local header (it cannot skip an SFX prefix and refuses one — `inspect_zip` reports it); `data: 'none' | 'verify' | 'include'`, `maxEntries` (default 10 000 clamped to the operator ceiling, echoed in the result), `tolerateTruncation` (partial inventory + `error` + `stoppedAt`), `trust: 'local-headers-only'` on every result; `stoppedAt` derived from byte accounting — the wrapper reads no PK signature.

#### Tools — write (3)
- **feat(tool): extract_zip** — every engine guard on by default (`rejectTraversal`, `rejectSymlinks`, `onDuplicate: 'error'`, `limits`; overlap and central/local divergence with no opt-out); eager pre-flight in both modes so the `includeData: false` dry run refuses hostile extents before returning a plan; base64 mode with 16 MiB / 32 MiB caps; file mode streamed under a relative `outputDir` in the sandbox (`wx`, realpath checks, `emptyDirectories`, up to 50 `resource_link`s); unsafe names skipped and listed under `rejectTraversal: false`, symlink targets written as data under `rejectSymlinks: false`.
- **feat(tool): create_zip** — reproducible creation (on one runtime by default; `compression.deterministic: true` for cross-runtime identical bytes and the only case reporting `summary.deterministic: true`): inline `dataBase64` / `text` / `sourcePath` entries or `directory: true` (up to 100 000 entries — Zip64 auto-promotion reachable; a `/`-terminated name refuses a payload), canonical or insertion `order`, pinned or wall-clock `defaultDate`, archive and per-entry `compression { method, level, deterministic }`, comments, `unixMode` / `externalAttributes`, raw `extraFields`, `stream: true` sources (data-descriptor layout), `parallel { workers, minWorkerJobSize, jobTimeout }` through `zipnative/worker` (byte-identical; the engine default worker count bounded by the ceiling), `chunkSize` for file mode, `includeSha256` in base64 and file mode; a typed `summary { deterministic, deflateTier, parallel, sha256 }`.
- **feat(tool): modify_zip** — `add` / `replace` / `remove` / `rename` / `setComment` in order without recompression; `mode: 'append'` (`save()`, original bytes verbatim, remanence documented, `ZIP_DEAD_BYTES_RATIO`) or `'compact'` (`saveCompact()`, removed data gone, SFX prefix dropped); `summary { saveMode, entryCountBefore / After, grewByBytes, noOp }`.

#### Tools — utilities (3)
- **feat(tool): sanitize_entry_paths** — the engine's traversal gate over a list of names with the rule that fired (`empty`, `nul`, `absolute`, `drive`, `unc`, `traversal`, `ads`, `device-name`, `no-segments`).
- **feat(tool): compute_crc32** — CRC-32 of inline bytes / text or a sandbox file streamed in 1 MiB chunks; `seed` chaining, `expect` → `matches`.
- **feat(tool): inflate_raw** — bounded raw-DEFLATE inflation through the resumable inflater (mandatory `maxOutput`, `bytesConsumed`, `leftover`, `allowTrailing`), `method: 'store'` pass-through, numeric method ids answered from the codec registry.

#### Tools — meta (2)
- **feat(tool): describe_engine** — offline capability manifest: versions, protocol, deflate tiers, runtime codecs and workers, codec registry, `DEFAULT_ZIP_LIMITS`, operator ceilings, server caps, sandbox / cache state, `network: 'none'`, the 39 error codes, the 11 diagnostic codes, and the deliberately unexposed engine surfaces with their rationale.
- **feat(tool): draft_governance_issue** — local, governance-compliant GitHub issue draft + compliance report (never submitted; `GOVERNANCE_VIOLATION` on a runtime-dependency proposal, a missing reproduction or `duplicateSearchPerformed: false`); `targetRepo` `zipnative` / `zipnative-mcp`; optional `.md` output in the sandbox.

#### Protocol and transport
- **feat(mcp):** MCP 2026-07-28 on `@modelcontextprotocol/server` ^2.0.0 with automatic legacy `initialize` fallback for every revision the SDK negotiates (2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25) on stdio and HTTP, proven by `tests/protocol-revisions.test.ts` (legacy) and `tests/stdio-modern.test.ts` / `tests/http-modern.test.ts` (modern); `server/discover`, `resultType`, `SERVER_CACHE_HINTS` (catalogue public 24 h, discover 1 h, resources private); `serverInfo` `title` / `description` / `websiteUrl`; unknown tool / prompt → JSON-RPC `-32602`; deterministic `tools/list` order.
- **feat(mcp):** projectable output schemas on the eight read tools (every property optional, summary scalars declared) so `structuredContent` validates under `verbosity: 'summary'` and `fields` projections; typed `summary` schemas on `create_zip` / `modify_zip` / `inflate_raw`; JSON `pattern`s mirrored by Zod `.regex()` on `compute_crc32.expect`, `inflate_raw.method`, `date` / `defaultDate` and `unixMode`; `_meta.unmatchedFields` / `availableFields`; `_meta.apiVersion` + ≤ 2 executable `_meta.examples` per tool; `_meta.error { code, message, data }` on every failure, with `data.remedy` from a closed vocabulary on the cap, ceiling, index and missing-path refusals.
- **feat(mcp):** native resources — every regular file in the sandbox as `zipnative://output/<path>` (`resources/list`, `resources/templates/list` with `{+path}`, `resources/read` ≤ 50 MiB, MIME by extension) and `resource_link` blocks from the file-producing tools; produced bytes delivered once as an embedded `resource` (`data:` URI).
- **feat(mcp):** seven prompts — `governance_contract`, `draft_issue_workflow`, `secure_extraction`, `reproducible_archive`, `incremental_update`, `forensic_scan`, `verify_before_trust`.
- **feat(transport):** stdio with a 256 MiB frame cap; loopback Streamable HTTP (`ZIPNATIVE_MCP_PORT`) through a dependency-free `node:http` bridge with Host / Origin guard, Origin port pin, 405 on GET / DELETE, 413 above 256 MiB, per-response disconnect detection; opt-in bearer token `ZIPNATIVE_MCP_HTTP_TOKEN` (constant-time, RFC 6750 challenge).
- **feat(cache):** opt-in content-addressed response cache (`ZIPNATIVE_MCP_CACHE_DIR`, 1 h TTL, 256 MiB LRU, key namespaced by tool API / package / engine version, `_meta.cached: true`); path inputs, file mode, `defaultDate: 'now'`, `parallel`, `describe_engine` and `draft_governance_issue` never cached.

#### Security posture
- **feat(security):** one filesystem boundary (`ZIPNATIVE_MCP_OUTPUT_DIR`) for `zipPath` / `sourcePath` / `resources/read` reads and `outputMode: 'file'` / `outputDir` writes — relative paths only, NUL / absolute / UNC / `..` refused, container-extension allow-list, realpath re-check after every `mkdir -p` and of every file read (a planted symlink or junction is `SECURITY_VIOLATION` on both sides), `wx` opens (never overwrite), partial files removed; unset = no file I/O beyond the opt-in cache.
- **feat(security):** the `limits` fragment (eight `ZipLimits` keys) on every engine tool, bounded by the operator ceilings `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` (8 GiB), `ZIPNATIVE_MCP_MAX_ENTRIES` (100 000), `ZIPNATIVE_MCP_WORKERS` (8) — `LIMIT_CEILING_EXCEEDED` names the variable; an invalid value refuses to start.
- **feat(security):** the `src/caps.ts` envelope (128 MiB decoded input, 1 GiB path input, 16 MiB inline entry, 32 MiB inline extraction, 50 MiB inline output, 4 GiB file output, bounded JSON shapes, the resources and cache bounds, 200 diagnostics — every constant advertised by `describe_engine.caps`); strict Zod at every nesting level; base64 boundary diagnostics; `registerCodec` / `setInflateImpl` / `setDeflateImpl` / `workerUrl` unexposed.
- **feat(errors):** the 16 wrapper codes and the 39 `ZIP_*` codes passed through verbatim by `mapZipError` (the only reader of `err.code`; node:zlib `Z_DATA_ERROR` / `Z_BUF_ERROR` mapped to `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` so the code never depends on the tier); `data.errorClass` / `engineError` / `entryName` / `limit` / `feature` / `expectedCrc`; the 11 diagnostics de-duplicated on every result.

#### Governance
- **feat(governance):** `.github/ai-governance.json` and `AGENT_RULES.md`, the `governance_contract` / `draft_issue_workflow` prompts, `scripts/verify-issue.mjs` (`npm run verify:issue`) mirroring `validateIssueMarkdown` byte-for-byte; the no-network charter stated as a property of the code, not a policy.

#### Conformance gate
- **feat(conformance):** `scripts/verazip-core.mjs` — the ISO/IEC 21320-1:2015 validator core vendored from zipnative (independent raw parser, 22 check ids, 4 required negative checks, upstream hashes pinned by `tests/verazip-vendor.test.ts`); `assertValidZip` (`tests/_zip-assert.ts`) applied to every archive a test produces; `npm run corpus:zip` / `npm run validate:zip` over a 38-archive corpus with a manifest (`expectConformant`, `expectedCheck`, `refusedBy`, `integrityExclude`), four raw-crafted negative canaries, hostile-but-conformant entries whose refusal is checked too, a coverage canary, and the level-1 foreign-integrity pass (bsdtar, unzip, 7z, python-zipfile, jar); `VERAZIP_REQUIRED=1` fails closed; `docs/data/verazip.json`.

#### Documentation
- **docs:** README, AGENTS.md (catalogue, decision tree, token-frugal responses, output modes and environment, recipes, the full error reference, contributing), `llms.txt`, `CLAUDE.md`, `server.json`, `CITATION.cff`; `docs/AI_GUIDE.md`, `docs/API_STABILITY.md`, `docs/KNOWLEDGE_BASE.md` (with the 77-export ledger); guides `AI_GOVERNANCE.md`, `SECURITY.md`, `DETERMINISM.md`, `INCREMENTAL.md`, `CONFORMANCE.md`, `LOCAL_TESTING.md`; `docs/data/errors.json` and `core-exports.json`; worked examples under `examples/` executed by `tests/examples.test.ts`; release notes and the go-live runbook.

#### CI and release
- **ci:** `ci.yml` (Linux Node 22 / 24, Windows Node 22: audit, typecheck, lint, coverage, build, stdio smoke), `verazip.yml` (blocking, Linux + Windows, no `paths:` filter), `codeql.yml`, `scorecard.yml`, `publish.yml` (Release-triggered: full gate + veraZIP re-run, CycloneDX SBOM, `npm publish --provenance` via Trusted Publishing); SHA-pinned actions; `tests/catalogue-parity.test.ts` with `tests/_fixtures/tool-shape.json`, the frozen `tool-shape.v1.0.0.json`, `tests/docs-consistency.test.ts`, `tests/schema-lockstep.test.ts`.
- **test:** `tests/autonomy.test.ts` — one scripted agent scenario (S0–S17) replayed against the built CLI on stdio legacy, stdio modern, HTTP legacy and HTTP modern with a bearer token; `tests/protocol-revisions.test.ts` (the five legacy revisions on both transports), `tests/stdio-modern.test.ts`, `tests/http-shutdown.test.ts`, `tests/zip64.test.ts` (70 000-entry reads and a 65 536-entry `create_zip`), `tests/diagnostics-inventory.test.ts` (every one of the 11 diagnostics produced by a tool call), per-key `ZipLimits` refusals, the three previously "unreachable" `ZIP_*` codes reached; `.mcp.json` for driving the built server from Claude Code.

#### Quality assurance
- **qa:** pre-release review cycle — two independent audits (A: conformance to the pdfnative-mcp architecture and MCP wire contract, 20 findings; B: engine coverage and semantic fidelity against zipnative 1.0.0, 20 findings), adversarial verification folding them into 34 canonical findings (30 legitimate, 1 partially legitimate, 3 not legitimate; 1 blocker and 8 majors fixed in this release, the minors and nits applied), every fix locked by a test named after its finding id. Details in `.github/drafts/pr-v1.0.0.md` § Review protocol.

### Security

- **No network code path** — no telemetry, no GitHub, no URL from any argument; `describe_engine.network` is `'none'` and every tool advertises `openWorldHint: false`.
- **Engine security defaults never weakened** — zip-slip / device names, symlinks, duplicate paths, bombs, overlaps and parser differentials refused with frozen codes; relaxations are explicit inputs that skip or degrade to data, never write anything unsafe.
- **No encryption by policy** — encrypted entries are detected (`ZIP_UNSUPPORTED_ENCRYPTION`), never decrypted, never silently skipped by default extraction.
- **Supply chain** — three runtime dependencies; OIDC Trusted Publishing with provenance attestations and a CycloneDX SBOM per Release; CodeQL, OpenSSF Scorecard, `npm audit --audit-level=high` in CI; secrets (`ZIPNATIVE_MCP_HTTP_TOKEN`) never logged or echoed.

[Unreleased]: https://github.com/Nizoka/zipnative-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nizoka/zipnative-mcp/releases/tag/v1.0.0
