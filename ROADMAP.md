# Roadmap

This document outlines the planned development direction for **zipnative-mcp**, the
Model Context Protocol server bridging [zipnative](https://github.com/Nizoka/zipnative)
to AI clients (Claude Desktop, Cursor, Continue, ChatGPT, Zed, …).

Priorities may shift based on community feedback and sponsorship. Engine-level items
live in [zipnative's ROADMAP](https://github.com/Nizoka/zipnative/blob/main/ROADMAP.md);
this server is a faithful thin wrapper and never implements ZIP structure on its own.

---

## Released

### v1.0.0 — First stable release

- [x] **13 tools on zipnative 1.0.0** — `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `create_zip`, `modify_zip`, `compute_crc32`, `inflate_raw`, `describe_engine`, `draft_governance_issue`; every tool with typed input / output schemas, annotations, `_meta.apiVersion = '1.0.0'` and ≤ 2 executable `_meta.examples`.
- [x] **Full engine coverage** — all 77 exports mapped to a tool touchpoint or deliberately unexposed with a reason (`docs/KNOWLEDGE_BASE.md` §8, `describe_engine.unexposed`); the 39 `ZIP_*` error codes passed through verbatim with `_meta.error.data` detail; the 11 diagnostics on every result.
- [x] **Secure-by-default extraction** — zip-slip / device names, symlinks, duplicate paths, declared-size and ratio bombs, overlapping entries and central/local divergence refused with frozen codes; relaxations are named inputs; one sandbox (`ZIPNATIVE_MCP_OUTPUT_DIR`) for reads and writes, `wx` writes, realpath checks; operator ceilings `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` / `_MAX_ENTRIES` / `_WORKERS`.
- [x] **Deterministic, reproducible creation** — canonical layout by default, `compression.deterministic: true` for cross-runtime identical bytes, worker-parallel byte-identity, streamed sources, `includeSha256` proofs; `inspect_zip` determinism verdict and CI `check` / `assert`.
- [x] **Incremental modification** — `modify_zip` append / compact without recompression, remanence documented, `ZIP_DEAD_BYTES_RATIO` surfaced.
- [x] **Forward scanning** — `scan_zip_forward` over truncated / unseekable input with `tolerateTruncation`, `trust: 'local-headers-only'`.
- [x] **Conformance gate ("veraZIP")** — ISO/IEC 21320-1:2015 asserted on every archive a test produces and over a 38-archive corpus (4 negative canaries, hostile-but-conformant entries with `refusedBy`), blocking on Linux and Windows and before every publish.
- [x] **MCP 2026-07-28 + legacy fallback** — SDK v2, stateless serving, cache hints, projectable output schemas, `verbosity` / `fields` projections, resources (`zipnative://output/{+path}`), 7 prompts, opt-in response cache, opt-in HTTP bearer token.
- [x] **AI governance / HITL** — `draft_governance_issue`, `governance_contract` + `draft_issue_workflow` prompts, `.github/ai-governance.json`, `verify:issue`; no network code path.
- [x] **Governance docs** — AGENTS.md, `llms.txt`, `docs/AI_GUIDE.md`, `docs/API_STABILITY.md`, `docs/KNOWLEDGE_BASE.md`, six guides; docs-consistency and catalogue-parity tests; `tests/_fixtures/tool-shape.v1.0.0.json` frozen.
- [x] **Release integrity** — npm Trusted Publishing (OIDC), provenance, CycloneDX SBOM, SHA-pinned actions, CodeQL, Scorecard.

_v1.0.0 is the active release._

---

## Planned

### v1.1.0

- [ ] **Catalogue superset gate** — `tests/catalogue-superset.test.ts` comparing the live `tools/list` with the frozen `tests/_fixtures/tool-shape.v1.0.0.json`: no removal, no narrowing, no new `required`, no tighter bound; accepted deltas enumerated in the test. The fixture already exists; the comparison starts with the first release that has something to compare.
- [ ] **Automated MCP registry publish** — run `mcp-publisher validate` / `publish` from `publish.yml` after the npm publication instead of the manual step in the go-live runbook.
- [ ] **Per-entry Zip64 streaming** — surface the engine's per-entry `zip64` opt-in on `create_zip` `stream: true` entries once zipnative ships it (today an `addStream` entry above 4 GiB is refused with `ZIP_UNSUPPORTED_ZIP64_STREAMING`; buffered entries are fully Zip64 already).
- [ ] **AES read-only** — if the engine adds AES decryption behind an injected crypto provider, expose it as an opt-in read path (`read_zip_entry`, `extract_zip`, `verify_zip`) with the key material never cached or echoed; ZipCrypto stays unsupported by policy.
- [ ] **Upstream findings** — file the engine-side observations recorded in the guides through `draft_governance_issue` (human-submitted).

### Longer term

- [ ] **Resource subscriptions** — `resources/subscribe` on the sandbox listing once hosts consume it.
- [ ] **Larger inline envelopes behind an operator switch** — the inline caps (16 / 32 / 50 MiB) are host-friendly defaults; an opt-in ceiling could raise them for hosts that can carry more.

---

## Blocked upstream

Everything below waits on a zipnative export; implementing it on raw primitives in the wrapper would contradict the faithful-thin-wrapper philosophy and reintroduce ZIP parsing in `src/`.

- [ ] **Zip64 streaming** (`addStream` > 4 GiB) — designed upstream (per-entry `zip64` opt-in, ADR in zipnative's ROADMAP); typed refusal until it lands.
- [ ] **Encryption** — none in 1.x by policy (ZipCrypto is broken); AES behind an injected provider is a later-major candidate upstream, read-only here first.
- [ ] **Custom compression methods** — `registerCodec` is executable code and stays unexposed; a method beyond store / deflate would need an engine-shipped codec, which zipnative does not provide by policy.
- [ ] **Forward-read custom-method payloads** — the engine's forward reader can only pump store and deflate; `scan_zip_forward` inherits the limitation.

---

## How to influence the roadmap

- **Feature requests:** [open an issue](https://github.com/Nizoka/zipnative-mcp/issues/new?labels=enhancement) — or let an agent draft one with `draft_governance_issue` and submit it yourself.
- **Pull requests:** community contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Engine features:** open them on [Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues); the wrapper follows the engine within a minor.
- **Sponsorship:** sponsored features get prioritised — see [funding options](https://github.com/sponsors/Nizoka).
- **Discussion:** weigh in on the [open milestones](https://github.com/Nizoka/zipnative-mcp/milestones).
