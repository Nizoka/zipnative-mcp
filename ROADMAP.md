# Roadmap

This document outlines the planned development direction for **zipnative-mcp**, the
Model Context Protocol server bridging [zipnative](https://github.com/Nizoka/zipnative)
to AI clients (Claude Desktop, Cursor, Continue, ChatGPT, Zed, …).

Priorities may shift based on community feedback and sponsorship. Engine-level items
live in [zipnative's ROADMAP](https://github.com/Nizoka/zipnative/blob/main/ROADMAP.md);
this server is a faithful thin wrapper and never implements ZIP structure on its own.

---

## Released

### v1.1.0 — First minor release, on zipnative 1.1.0

Every 1.0.0 call keeps working: the live catalogue is a checked superset of the frozen 1.0.0 one, and the default output of every existing tool is byte-identical for every valid input on a UTC host (the compatibility ledger is in [release-notes/v1.1.0.md](release-notes/v1.1.0.md)).

- [x] **15 tools** — two new: `canonicalize_zip` (any archive into the engine's canonical deterministic form without recompression, with the engine's `analyzeDeterminism()` verdict on the result) and `merge_zip` (1 to 32 source archives into one without recompression, every entry CRC- and size-checked first — an entry with no codec here is refused, not copied unchecked —, `onConflict` `error` | `first` | `last`).
- [x] **Byte-range reads** — `access: 'auto' | 'memory' | 'range'` on `inspect_zip`, `list_zip_entries` and `read_zip_entry`: the engine's `openZipRange` over the sandbox file's own handle (never a URL), so a `zipPath` above the 1 GiB in-memory cap is read instead of refused; `limits.maxEntryCompressedSize`, the ninth `ZipLimits` key, bounds one fetched payload.
- [x] **Zip64 streaming** — `create_zip` stream entries take `zip64: true` (the engine's per-entry opt-in, APPNOTE 4.3.9.2), and the fourth operator ceiling `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` (default 4 GiB, unchanged) lets an operator write an archive above 4 GiB into the sandbox.
- [x] **Cancellation and progress** — the request's signal and, with a `progressToken`, a progress sink reach every tool whose work scales with its input except `verify_zip` (the engine's `verifyZip` takes no signal — see *Blocked upstream*); a cancelled call is the 17th wrapper code `CANCELLED` in-process (over MCP it gets no response), never cached, its partial output file removed; `notifications/progress` are strictly increasing and throttled.
- [x] **Engine parity** — UTC DOS timestamps on every host (`dosTimeMode: 'utc'`), `verify_zip` / `read_zip_entry` relaying the engine's `skipped` reason, `inspect_zip` determinism from `analyzeDeterminism()` with the opt-in `determinismReport` / `canonicalDate` and three `canonical-*` checks, `modify_zip` `canonical` on `mode: 'compact'`, opt-in extended timestamps and Unix owner ids, `describe_engine` `codecs[].incremental`; 106 engine exports mapped to a touchpoint or deliberately unexposed (`docs/KNOWLEDGE_BASE.md` §8), 12 diagnostic codes.
- [x] **Catalogue superset gate** — `tests/catalogue-superset.test.ts` compares the live `tools/list` with the frozen `tests/_fixtures/tool-shape.v1.0.0.json`: no removal, no narrowing, no new `required`, no tighter bound; the accepted deltas are enumerated in the test.
- [x] **MCP registry publication job** — `publish.yml` publishes `server.json` to the MCP registry in its fourth job (`registry`), with `mcp-publisher` pinned by version and SHA-256 and the workflow's GitHub OIDC identity — the manual step of 1.0.0 is gone.
- [x] **Security fixes** — linear-time globs and governance patterns (CWE-1333), one-handle sandbox reads bound by device and inode (CWE-367), the coded `ENGINE_ERROR` boundary with absolute paths redacted, `modify_zip` opening its input eagerly, HTTP timeouts and security headers, a startup refusal on an invalid port or a relative sandbox path.
- [x] **One gate and docs as code** — `scripts/gate.ts` (fast / CI / publish profiles, `--require-all`) run by CI on Linux (Node 22 and 24), Windows and macOS; `scripts/verify-docs.ts` holding every count to `docs/assets/ecosystem.json`; `scripts/release-prepare.ts`; `scripts/tool-shape.ts` with size budgets; the 54-sample baseline with a `since` chain; the seeded fuzz suite; `docs/AGENT_CONTRACT.md`.
- [x] **Release integrity** — the four-job publish workflow (`verify` → `publish` → `attest` → `registry`), npm Trusted Publishing with provenance, an `npm sbom` CycloneDX SBOM and a build-provenance attestation, harden-runner and `--ignore-scripts` on every job, one SHA per action, dependency review, CodeQL `security-extended`, Scorecard, committed rulesets, Security Insights.
- [x] **Conformance** — the veraZIP core re-vendored from zipnative 1.1.0 (23 check ids, `WF/DESCRIPTOR-WIDTH` new); the corpus covers canonicalisation, merging, compact + canonical and a Zip64 streamed entry: 43 archives, 39 conformant and 4 negative canaries.

### v1.0.0 — First stable release

- [x] **13 tools on zipnative 1.0.0** — `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `create_zip`, `modify_zip`, `compute_crc32`, `inflate_raw`, `describe_engine`, `draft_governance_issue`; every tool with typed input / output schemas, annotations and ≤ 2 executable `_meta.examples`. <!-- verify-docs:allow stale-token -->
- [x] **Full engine coverage** — all 77 exports of the engine 1.0.0 mapped to a tool touchpoint or deliberately unexposed with a reason; the 39 `ZIP_*` error codes passed through verbatim; the 11 diagnostics of the engine 1.0.0 on every result. <!-- verify-docs:allow stale-token -->
- [x] **Secure-by-default extraction**, **deterministic creation**, **incremental modification**, **forward scanning**, the **veraZIP conformance gate**, **MCP 2026-07-28 + legacy fallback**, the **AI governance / HITL** layer and npm Trusted Publishing with provenance.

_v1.1.0 is the active release._

---

## Upstream engine findings closed in zipnative 1.1.0

The engine-side observations recorded while building 1.0.0 are closed in zipnative 1.1.0, and this release consumes each fix:

- [x] **DOS timestamps depended on the process time zone** ([zipnative#9](https://github.com/Nizoka/zipnative/issues/9)) — `dosTimeMode: 'utc'`, used on every call here.
- [x] **node:zlib and `DecompressionStream` errors leaked a runtime-dependent class** ([zipnative#10](https://github.com/Nizoka/zipnative/issues/10)) — every inflate tier now raises `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED`; the wrapper's own zlib error table is gone.
- [x] **`iterateZipEntries()` ignored registered codecs** ([zipnative#11](https://github.com/Nizoka/zipnative/issues/11)) — the incremental codec contract (`createDecompressor`), reported by `describe_engine` `codecs[].incremental`.
- [x] **`verifyEntry()` reported encrypted and stream-only entries as failed without a reason, with a fabricated `localHeaderMatch`** ([zipnative#12](https://github.com/Nizoka/zipnative/issues/12)) — the `skipped` reason, relayed by `verify_zip` and `read_zip_entry`.
- [x] **Zip64 streaming** (`addStream` above 4 GiB refused) — the per-entry `zip64` opt-in, exposed on `create_zip` stream entries.

---

## Planned

### Still planned

- [ ] **Resource subscriptions** — `resources/subscribe` on the sandbox listing once hosts consume it.
- [ ] **Larger inline envelopes behind an operator switch** — the inline caps (16 MiB per entry, 32 MiB per extraction, 50 MiB per output) are host-friendly defaults; an opt-in ceiling could raise them for hosts that can carry more.
- [ ] **Byte-range reads for the remaining whole-archive tools** — `verify_zip`, `extract_zip` and the determinism analysis of `inspect_zip` take the whole archive in memory today (≤ 1 GiB for a `zipPath`); they follow when the engine offers the same operations over a `ByteRangeSource`.
- [ ] **`harden-runner` from audit to block mode** — switch the Linux jobs to `egress-policy: block` with the endpoints each job reaches (listed in `publish.yml`); Windows and macOS runners support audit mode only (the macOS gate leg runs without the action today).
- [ ] **Transport-layer fuzz** — the seeded fuzz suite stops at tool arguments; a seeded generator of frame mutations over both transports is still open. There is no coverage-guided fuzzing here, and none is planned in the wrapper.
- [ ] **Per-tool HTTP streaming** — MCP 2026-07-28 still has no partial `structuredContent`, so large listings stay paged (`offset` / `limit`) rather than streamed.

### Blocked upstream

Everything below waits on a zipnative export; implementing it on raw primitives in the wrapper would contradict the faithful-thin-wrapper philosophy and reintroduce ZIP parsing in `src/`.

- [ ] **AES / decryption** — none in the engine 1.x by policy (ZipCrypto is broken); AES (AE-2) behind an injected crypto provider is an engine 2.0 candidate. Only then would a read-only path with a password input exist here, the key material never cached or echoed.
- [ ] **Custom compression methods** — `registerCodec` is executable code and stays unexposed; a method beyond store / deflate would need an engine-shipped codec, which zipnative does not provide by policy.
- [ ] **A cancellable `verify_zip`** — `verifyZip()` is synchronous and its options hold only `limits` (no `signal`, no `onProgress`, no `onDiagnostic`), so a started verification runs to completion; the tool follows when the engine takes the common options there.
- [ ] **Eager validation that compares local headers** — `validate: 'eager'` checks every entry's extent but not its method / CRC / sizes against the central directory (the engine's own documentation says it cross-checks the local headers); `modify_zip` compensates with a raw read of every entry in append mode.
- [ ] **Engine 1.1.0 limitations that bite here** — a deterministic streamed entry (`stream: true` + `compression.deterministic: true`) is capped at 2 GiB by the pure-TS encoder (`ZIP_INPUT_TOO_LARGE`); the forward reader refuses store + bit 3 and encrypted + bit 3 entries (`ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`); `addFromReader()` transplants from in-memory readers only, which is why `merge_zip` holds its sources in memory (1 GiB in all); a `zip64: true` streamed entry below 4 GiB still carries Zip64 records that Java's `ZipInputStream` cannot read.

### Deliberately not exposed

- **`nameEncoding` input / `nameDecoder`** — deliberately not exposed in 1.1.0: a decoder is a function, which JSON cannot carry safely; legacy names are decoded as cp437 (`rawNameHex` keeps the bytes), and `nameEncoding: 'custom'` never appears in a result. Never a free-form input; a label-based, closed-enum input (a fixed list of code pages) is a later candidate.
- **`addRaw()`** — the caller would vouch for CRC and sizes; `merge_zip` exposes the checked transplant (`addFromReader`) only.
- **A remote byte-range source** — `openZipRange` runs over a sandbox file handle or inline bytes; no URL, no network path, ever.

---

## How to influence the roadmap

- **Feature requests:** [open an issue](https://github.com/Nizoka/zipnative-mcp/issues/new?labels=enhancement) — or let an agent draft one with `draft_governance_issue` and submit it yourself.
- **Pull requests:** community contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Engine features:** open them on [Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues); the wrapper follows the engine within a minor.
- **Sponsorship:** sponsored features get prioritised — see [funding options](https://github.com/sponsors/Nizoka).
- **Discussion:** weigh in on the [open milestones](https://github.com/Nizoka/zipnative-mcp/milestones).
