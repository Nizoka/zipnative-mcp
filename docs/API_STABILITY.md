# API Stability — zipnative-mcp

> Stability charter for the **tool API** (tool names, input/output schemas, error codes, runtime semantics, the bytes the archive-producing tools emit).
> The server binary itself follows standard SemVer for npm releases.

---

## 1. Versioning

Every tool emits `_meta.apiVersion` in the `tools/list` response.

Current value: **`1.1.0`** (stable, since zipnative-mcp 1.1.0; `TOOL_API_VERSION` in `src/version.ts`). The previous value, `1.0.0`, shipped with the first release.

The tool API version is **independent of the npm release version**, although 1.0.0 and 1.1.0 ship both at the same number. Server releases that ship only documentation, refactoring, or non-breaking ergonomic improvements (richer descriptions, additional `_meta.examples`, new optional output fields) **do not** bump `_meta.apiVersion`. 1.1.0 bumps it because it adds two tools, new optional inputs, a new wrapper code and the reviewed tightenings of §2 — and because the response-cache key is namespaced by `TOOL_API_VERSION`, so no 1.0.0 response is ever served by 1.1.0.

A bump of `_meta.apiVersion` happens **only** in the cases listed in §3.

> **Engine alignment.** zipnative-mcp 1.1.0 pins `zipnative ^1.1.0`. The engine's own freeze is a
> precondition of this charter: its API surface (106 exports in 1.1.0, mapped one by one in
> [`KNOWLEDGE_BASE.md`](KNOWLEDGE_BASE.md) §8), its 39-code error vocabulary and its
> `deterministic: true` output bytes are frozen under semver by
> [zipnative's SECURITY.md](https://github.com/Nizoka/zipnative/blob/main/SECURITY.md). An engine
> **major** bumps this server's major; an engine **minor** that adds an error code fails `tsc` in
> `src/zip-errors.ts` (`ZIP_ERROR_CLASS satisfies Record<ZipErrorCode, …>`) until the wrapper maps
> it, and one that adds a diagnostic fails the exhaustiveness check of `ZIP_DIAGNOSTIC_CODES` —
> either is then an additive minor here.
>
> **MCP protocol alignment.** The tool API version is orthogonal to the MCP wire-protocol
> revision. The server runs on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` ^2.3.1)
> and speaks **MCP 2026-07-28** — stateless serving, `server/discover`, `resultType`,
> `ttlMs` / `cacheScope` cache hints, the `_meta` `serverInfo` envelope, `Mcp-Method` /
> `Mcp-Name` headers over HTTP — with automatic fallback to the legacy `initialize` handshake for
> every revision the SDK negotiates — `2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18` and
> `2025-11-25` — on both stdio and HTTP (`tests/protocol-revisions.test.ts` proves each legacy
> revision negotiates exactly that revision and serves the 15 tools; `tests/stdio-modern.test.ts`
> and `tests/http-modern.test.ts` prove the 2026-07-28 path). The `tools/call`
> payload (`content`, `structuredContent`, `isError`, `_meta`) is identical on both paths. Tool
> schemas are JSON Schema **2020-12** (no `$schema`, `$ref` or `$defs` keyword by policy — some
> hosts forward `inputSchema` verbatim to function-calling APIs), `serverInfo` advertises `title`
> + `description` + `websiteUrl`, and input-validation failures are returned as tool-execution
> errors (`isError: true`) — none of which affect `_meta.apiVersion`.
>
> **Protocol-level errors** are JSON-RPC codes, not `ToolError` codes, and sit outside the §2
> matrix: `tools/call` naming a tool that does not exist is `-32602` with the message
> `[UNKNOWN_TOOL] Unknown tool: <name>` (the in-process `callToolDirect` helper keeps returning
> `isError`); `prompts/get` on an unknown prompt is `-32602` `[UNKNOWN_PROMPT]`;
> `resources/read` on an unknown URI is `-32602` carrying `UNKNOWN_RESOURCE` in the message.
> A request cancelled with `notifications/cancelled` gets no response (SDK behaviour); the
> in-process `callToolDirect` reports it as the wrapper code `CANCELLED`.
>
> **Output-schema conformance.** `structuredContent` always validates against the tool's
> `outputSchema` — a 2026-07-28 MUST — including `verbosity: 'summary'` and `fields`
> projections and file mode. The eight read tools (`inspect_zip`, `list_zip_entries`,
> `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`,
> `describe_engine`) therefore declare **projectable** output schemas: every property optional,
> no `required`, `additionalProperties: false` kept, and the summary-only scalars declared
> (`deterministic`, `canonicalLayout`, `diagnosticCount`, `names`, `name`, `index`,
> `skippedCount`, `paths`, `rejectedNames`). `create_zip`, `modify_zip`, `canonicalize_zip`,
> `merge_zip` and `inflate_raw` extend the shared `ARCHIVE_OUTPUT_SCHEMA` with a typed,
> tool-specific `summary` (every key optional, `additionalProperties: false`), so their
> `structuredContent` validates too.
>
> **Transport facts that are SDK behaviour:** on **stdio**, a request sent before the opening
> exchange is dropped without a reply, and JSON-RPC batch arrays (2025-03-26) are not accepted on
> stdio (they are over HTTP). A single stdio frame or HTTP body is capped at 256 MiB
> (`STDIO_MAX_FRAME_BYTES`; HTTP answers 413) — large enough for the 128 MiB decoded base64 input
> cap plus JSON overhead. Over HTTP a 2026-07-28 request without the `MCP-Protocol-Version`
> header is refused by the SDK handler (400 / `-32020`).

---

## 2. What is covered

| Surface | Scope |
|---------|-------|
| Tool **names** (15) | Stable. Renaming a tool is a major bump. |
| Required **input fields** | Stable. Removing or renaming is a major bump. |
| Required **output fields** | Stable. Removing or renaming is a major bump. |
| Field **types** (string / number / bool / enum / object shape) | Stable. Narrowing accepted values or tightening a numeric / length bound is a major bump — except a reviewed security tightening declared below. |
| **Wrapper error codes** (`code` on `ToolError`, 17: `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `UNKNOWN_RESOURCE`, `GOVERNANCE_VIOLATION`, `CANCELLED`, `ENGINE_ERROR`; meaning and remedy in `src/wrapper-codes.ts`) | Stable. Removing, renaming or repurposing is a major bump. `CANCELLED` is new in 1.1.0 (minor). |
| **Engine error codes** (the 39 `ZIP_*` codes, passed through verbatim) | Stable **upstream** — frozen under the engine's 1.x semver contract; removing or renaming one is a zipnative major, which is a zipnative-mcp major. The wrapper never rewrites, drops or remaps a `ZIP_*` code. Since zipnative 1.1.0 the engine itself normalises a corrupt or truncated deflate stream to `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` on every inflate tier, so the code an agent sees does not depend on the codec tier and the wrapper's former `node:zlib` mapping is gone (`ZIP_DECOMPRESSION_FAILED` is unreachable here). The 12 diagnostic codes are informational and likewise frozen upstream (`ZIP_TIMESTAMP_CLAMPED`, new in the engine 1.1.0, is listed and unreachable here). Machine-readable registry: [`data/errors.json`](data/errors.json). |
| `_meta.error` **envelope** (`{ code, message, data? }`) | The three keys and `data.errorClass` / `engineError` / `entryName` are stable; further `data` keys are additive (`sourceIndex` for `merge_zip` is new in 1.1.0). `data.remedy` (optional string) is a machine-actionable hint from a closed vocabulary — `outputMode:'file'`, `range`, `encoding:'base64'`, `data:'verify'`, `list_zip_entries`, `resources/list`, `maxEntries ≤ N`, `zipPath`, and since 1.1.0 `retry` (`IO_ERROR` on a file that changed under the read, `CANCELLED`) and `access:'memory'` (`inspect_zip` determinism inputs over byte ranges) — emitted on the inline-cap, ceiling, index-out-of-range, missing-path and retryable refusals; adding a value is a minor, changing or removing one is a major. An `ENGINE_ERROR` for an input nested deeper than the process can walk carries a free-text remedy. |
| **Produced bytes** (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw`) | Covered — see §3: the bytes an archive-producing tool emits for a given input are byte-identical across patch and minor releases (per deflate tier); `compression.deterministic: true` bytes are identical across runtimes and are part of the engine's frozen contract; `canonicalize_zip` runs no codec, so its bytes are identical across runtimes as well. The one 1.1.0 timestamp change is declared below. |
| `_meta.examples` | **Not** covered. May change at any time (at most two per tool; every one is executable against its `inputSchema`). |
| `description` strings, `title`, the `instructions` field of the opening exchange, prompt texts, `_meta.error.message` wording | **Not** covered. May be reworded at any time — the `tools/list` *wording* is outside the byte-identical charter; tool-result `structuredContent` defaults are inside it. |
| `tools/list` **structure** (types, enums, bounds, defaults, `required`, `additionalProperties`, annotations, example count) | Covered, and enforced by the catalogue gates below. |
| Schema **`default`** values | Documented; changes are minor unless they alter produced bytes silently — then major. |
| Unknown input keys | Rejected with `VALIDATION_ERROR` at every nesting level (Zod `.strictObject`), exactly as the published `additionalProperties: false` declares. |
| Server **caps** (`src/caps.ts`, reported by `describe_engine.caps`) | Raising a cap is a patch; lowering one is a major (it rejects previously-accepted input) — except a reviewed security bound declared below. |
| Operator **environment variables** (8) and their defaults | Renaming or removing one is a major; a new one is a minor (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` is new in 1.1.0, defaulting to the 1.0.0 cap of 4 GiB). |
| MCP **prompts** (7) and **resource URI scheme** (`zipnative://output/{+path}`) | Names and the scheme are stable; prompt texts are wording. |

**Catalogue gates.** `scripts/tool-shape.ts` fingerprints the `tools/list` catalogue with every `description` string stripped (names, titles, annotations, input / output schema shapes, example count); `npm run build && npx tsx scripts/tool-shape.ts --write` refreshes `tests/_fixtures/tool-shape.json`, `npm run verify:tool-shape` compares, and `tests/catalogue-parity.test.ts` fails on any structural drift — a change there is a deliberate, reviewed fixture refresh under §3 / §5. The published 1.0.0 catalogue is frozen as `tests/_fixtures/tool-shape.v1.0.0.json` (never regenerated within the 1.x line), and the **superset gate** `tests/catalogue-superset.test.ts` is active from 1.1.0: every 1.0.0 tool must still exist, and every 1.0.0 input property, enum value, default and bound must still be accepted — no property removed, no enum value dropped, no default changed, nothing made required, no `additionalProperties` loosened (the gate checks loosening only), no previously unbounded field given a bound, no bound tightened, no annotation flipped, the output only grown. The gate fails on anything else, and also fails when an accepted delta no longer occurs (a stale exemption).

**Accepted deltas (1.1.0).** The superset gate lists exactly these reviewed exceptions (`ACCEPTED_DELTAS`), every one a security tightening that refuses no input a working 1.0.0 call relied on:

| Delta | Tools | Why |
|---|---|---|
| `fields.items`: `pattern` introduced — a `fields` path may no longer name a prototype segment (`__proto__`, `constructor`, `prototype`) | `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `describe_engine` | Prototype-pollution hardening (CWE-1321): the projection never resolved such a segment to data, so no working call is refused. |
| `filter.glob.items`: `maxLength` introduced (1024) | `list_zip_entries`, `extract_zip`, `scan_zip_forward` | Globs are matched in linear time and bounded (CWE-1333); a pattern longer than 1 024 characters is the only input refused. A literal glob for a legal entry name of 1 025–4 096 bytes is refused with it; such a name is still selected with `filter.names` or `filter.prefix`. |
| `summary`, `expectedBehavior`, `actualBehavior`, `reproduction.command`, `reproduction.result`: `maxLength` introduced (16384) | `draft_governance_issue` | The policy scan is linear and the bound keeps a draft reviewable. |

`merge_zip.sources[].filter.glob` carries the same 1 024-character bound from its first release, so it is not a delta.

**Behaviour changes in 1.1.0** (declared, not schema deltas):

- **`verify_zip` counts by the engine's archive rule.** An entry passes when it is `ok`, or when it is a design-time skip (`encrypted`, `stream-only-codec`) whose local header agrees with the central directory. An encrypted entry whose local header **contradicts** the central directory is now counted in `failedCount` (1.0.0 trusted a fabricated `localHeaderMatch` and counted it as skipped). An entry with an unknown method now carries `skipped: 'unsupported-method'` (a new enum value) and stays failed, as in 1.0.0. `read_zip_entry mode: 'verify'` relays `skipped` and the engine's real `localHeaderMatch`. The counts of every archive without such an encrypted entry are unchanged.
- **DOS timestamps are UTC.** Every engine call runs with `dosTimeMode: 'utc'`. A pinned `Z` / `±hh:mm` date (`create_zip` `defaultDate` / `date`, `modify_zip` new payloads) is written as its UTC wall clock: the bytes are identical to 1.0.0 on a UTC host and differ from what 1.0.0 wrote on a non-UTC host (1.0.0 used the host zone, so the same cached call produced different bytes in Paris and on a UTC runner). An offset-less date-time is read as the UTC wall clock — the DOS fields 1.0.0 wrote for it in every zone. `lastModified` reads back as the same instant on every host. 39 of the 41 baseline samples of 1.0.0 are byte-identical on 1.1.0 under `TZ=UTC`; the other two (`describe_engine`, `draft_governance_issue`) quote the package version and are re-anchored at 1.1.0. On a non-UTC host the read side moves as well: every DOS date is read as UTC, so `lastModified` and `earliestDate` / `latestDate` of every archive differ from what 1.0.0 reported on that host by the zone offset (the DOS epoch reads `1980-01-01T00:00:00.000Z`, where 1.0.0 in Paris reported `1979-12-31T23:00:00.000Z`), and an archive another tool wrote in local time reads shifted by its producer's offset.
- **`modify_zip` validates its input eagerly.** The input is opened with `validate: 'eager'`: an archive with overlapping entries or a truncated local header is now refused with its `ZIP_*` code (`ZIP_ENTRY_OVERLAP`, `ZIP_RECORD_TRUNCATED`, …) instead of being re-emitted by the append path, which never re-reads the existing entries. Before an append-mode save, every non-encrypted entry is also checked against its local header and its declared sizes (a raw read, nothing decompressed), so a method / CRC / size divergence (`ZIP_CD_LFH_MISMATCH`) or a declared-size bomb (`ZIP_LIMIT_EXCEEDED`) is refused there too, as compaction and the other writers refuse it. The check applies the engine's default limits, as compaction always did: an archive beyond a default bound (for example a compression ratio above 1024:1) that 1.0.0 appended unchecked now needs the matching `limits` in append mode as well.
- **`verify_zip` diagnostics are capped.** `diagnostics[]` is de-duplicated by code and entry and capped at 200 rows like every other tool's; `diagnosticsTruncated: true` appears only when the cap bites, and no `diagnosticCounts` is added, so an ordinary result keeps its 1.0.0 bytes.
- **`scan_zip_forward` deflate codes.** Corrupt deflate data is `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` on every tier (1.0.0 surfaced `ZIP_DECOMPRESSION_FAILED`); the engine normalises the code, and the three share one error class.
- **Sandbox reads.** A sandbox file that grows or shrinks during a read is `IO_ERROR` (`data.remedy: 'retry'`), and one swapped while it is opened is `SECURITY_VIOLATION`.
- **HTTP.** Request bodies up to the documented 256 MiB are accepted (1.0.0 kept the SDK's 4 MiB default, so inline archives above about 3 MiB failed over HTTP), with request timeouts and `nosniff` / `no-store` headers; the `Host` / `Origin` guard and the bearer token are checked before the body is read; a 2026-07-28 request must carry `MCP-Protocol-Version` (SDK 2.3).
- **Large `zipPath`.** On `inspect_zip`, `list_zip_entries` and `read_zip_entry`, a sandbox `zipPath` above 1 GiB is read by byte ranges (`access: 'auto'`) instead of being refused with `INPUT_TOO_LARGE`.
- **Cancellation.** `compute_crc32`, `inflate_raw` and the archive tools stop between chunks when the request is cancelled; `verify_zip` cannot be interrupted once it starts (zipnative's `verifyZip` takes no signal).
- **Globs.** A glob longer than 1 024 characters (`MAX_GLOB_LENGTH`) and a glob with an inverted class range (`[z-a]`) are `VALIDATION_ERROR`; the second was an uncaught `SyntaxError` in 1.0.0. Matching semantics are unchanged (held equal to the 1.0.0 translation over 20 000 seeded pairs).
- **`draft_governance_issue` text bounds.** `summary`, `expectedBehavior`, `actualBehavior` and the two `reproduction` fields are bounded at 16 384 characters (`MAX_ISSUE_TEXT_CHARS`, `VALIDATION_ERROR` above).
- **The error boundary.** A throw that is not a `ToolError` is now `ENGINE_ERROR` with `data.errorClass: 'internal'` and absolute paths redacted from the message (1.0.0 returned an `isError` text without `_meta.error`).
- **Startup.** `ZIPNATIVE_MCP_PORT` must be an integer in 1–65535 and `ZIPNATIVE_MCP_OUTPUT_DIR` and `ZIPNATIVE_MCP_CACHE_DIR` absolute, or the server refuses to start (one `fatal:` line, exit 1) — a configuration that 1.0.0 accepted silently.
- **`inspect_zip` determinism** comes from the engine's `analyzeDeterminism()`; the default verdict keeps the 1.0.0 formula, so no CI gate flips.

---

## 3. Bump rules

### Patch (`1.1.x`)
- New optional output fields added to existing tools (additive only).
- Looser input validation (accept a previously rejected payload); a server cap raised.
- Internal hardening or cache changes that do not alter response shape.
- Documentation, examples, and description refreshes; an engine patch bump.
- **Produced bytes unchanged:** the default output of `create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip` and `inflate_raw` for a given input is byte-identical before and after a patch (per deflate tier — the `node-zlib` tier is stable per environment by the engine's contract, and `compression.deterministic: true` is stable everywhere).

### Minor (`1.x.0`)
- New tool added.
- New optional input field with a backward-compatible default.
- New value added to an existing enum (when older clients can safely ignore it).
- A new wrapper error code, or a new engine `ZIP_*` code mapped after an engine minor; a new diagnostic code surfaced.
- A new environment variable, prompt or resource kind.
- A reviewed security tightening listed in the superset gate's `ACCEPTED_DELTAS` and in §2.
- **Produced bytes unchanged** for every input that was valid before (a new option may produce different bytes only when it is used), save a declared engine-contract correction such as the 1.1.0 UTC timestamps.

### Major (`x.0.0`)
- Tool removed or renamed.
- Required field added or removed.
- Field type narrowed, a bound tightened, or semantics changed (outside a reviewed security tightening).
- Error code removed, renamed, or repurposed (wrapper or engine).
- **A change to the default bytes** of `create_zip` / `modify_zip` / `canonicalize_zip` / `merge_zip` / `inflate_raw` for the same input — including a change to the engine's `deterministic: true` encoder, a different canonical order, different default timestamps, attributes or Zip64 decisions, or a different `saveCompact()` / `canonicalizeZip()` layout. The engine records the same rule (`ecosystem.json → deterministic_bytes_are_semver_major`).
- A security default weakened (`rejectTraversal`, `rejectSymlinks`, `onDuplicate`, a `ZipLimits` default, the sandbox rules, the no-overwrite rule, `merge_zip` `verify`).
- An operator ceiling default lowered, a server cap lowered, or an environment variable renamed.
- An engine major.

---

## 4. Deprecation policy

When a tool, field, enum value, error code or environment variable is scheduled for removal:

1. Mark it deprecated in `description` and in this document (§5).
2. Keep it functional for **at least one minor release** before removal.
3. Provide a migration note in the next `release-notes/vX.Y.Z.md` and under `### Deprecated` in `CHANGELOG.md`.
4. Drop only on the next major bump.

An engine deprecation (zipnative marks an export or option deprecated) is surfaced here in the same release the wrapper picks up that engine version, with the same ladder. Nothing is deprecated in 1.1.0.

---

## 5. Per-tool stability matrix

All 15 tools of zipnative-mcp 1.1.0 are at `_meta.apiVersion = '1.1.0'` and are considered **stable**: the thirteen tools of 1.0.0 and the two added in 1.1.0 (`canonicalize_zip`, `merge_zip`). For every tool: `_meta.error` carries the wrapper codes marked *common* — `VALIDATION_ERROR` (every tool), and for the archive-consuming tools `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `INVALID_PATH`, `INVALID_EXTENSION`, `SECURITY_VIOLATION` (the `zipPath` form), `IO_ERROR` (a sandbox file that changed under the read), `LIMIT_CEILING_EXCEEDED` (the `limits` input) and `ENGINE_ERROR`; and `CANCELLED` (a cancelled request; in-process only — over MCP the request gets no response) on the tools whose work stops on the request's signal — `inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `compute_crc32`, `inflate_raw`; `verify_zip` checks the signal only before the verification starts (zipnative's `verifyZip` is synchronous and takes no signal). "ZIP_*" below lists the engine codes a tool is expected to surface; any of the 39 may in principle pass through an engine call. The `limits` input of every engine-touching tool takes nine keys since 1.1.0 (`maxEntryCompressedSize` added, bounded by `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`).

### `inspect_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `validate` (`eager` default | `lazy`); `access` (`auto` default | `memory` | `range`, 1.1.0); `check[]` (18 assertions: `deterministic`, `epoch-timestamps`, `canonical-order`, `utf8-names`, `no-data-descriptor`, `canonical-layout`, `no-zip64`, `zip64`, `no-encryption`, `no-symlinks`, `safe-names`, `no-duplicates`, `no-diagnostics`, `store-only`, `deflate-only`, and since 1.1.0 `canonical-form`, `canonical-extras`, `canonical-version-made-by`); `determinismReport` (default false, 1.1.0); `canonicalDate` (1.1.0); `assert` (`maxEntries`, `minEntries`, `maxUncompressedBytes`, `maxRatio`, `has[]`, `method`); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `archiveBytes`, `entryCount`, `fileCount`, `directoryCount`, `isZip64`, `comment`, `commentBytes`, `commentHex?`, `prependedData`, `multipleEocd`, `compressedBytes`, `uncompressedBytes`, `ratio`, `methods[]`, `encryptedCount`, `symlinkCount`, `dataDescriptorCount`, `zip64EntryCount`, `utf8NameCount`, `cp437NameCount`, `duplicateNameCount`, `unsafeNameCount`, `earliestDate`, `latestDate`, `determinism { epochTimestamps, canonicalOrder, utf8Flags, noDataDescriptors, canonicalLayout, deterministic }` (absent over byte ranges), `determinismReport { deterministic, epochTimestamps, canonicalOrder, utf8Flags, canonicalExtras, canonicalVersionMadeBy, noDataDescriptors, pinnedDate, offenderCount, offenders[] { name, concern }, offendersTruncated? }?` (1.1.0), `access?: 'range'` (1.1.0), `diagnostics[]`, `diagnosticCounts`, `diagnosticsTruncated?`, `checks[]?`, `checksPassed?` (present when `check` / `assert` was supplied). Summary scalars: `deterministic`, `canonicalLayout`, `diagnosticCount`.
- **Error codes:** common; `VALIDATION_ERROR` for `determinismReport` / `canonicalDate` over byte ranges (`data.remedy: "access:'memory'"`); ZIP_* structural refusals (`ZIP_EOCD_NOT_FOUND`, `ZIP_RECORD_TRUNCATED`, `ZIP_CD_INCONSISTENT`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_LIMIT_EXCEEDED`, …), `ZIP_STRICT_DIAGNOSTIC` under `strict`.
- **Semantics:** the default `determinism` verdict keeps the 1.0.0 formula; over byte ranges the determinism checks fail closed with a reason.
- **Annotations:** read-only, idempotent. **Cacheable** (base64 input).

### `list_zip_entries` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `offset` (≥ 0, default 0); `limit` (1–2000, default 200); `filter { names[], prefix, glob[] (≤ 1024 chars each), includeDirectories }`; `includeExtraData`; `includeExtendedTimestamps` and `includeUnixIds` (default false, 1.1.0); `validate` (`lazy` default | `eager`); `access` (1.1.0); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `entryCount`, `matchedCount`, `offset`, `limit`, `returnedCount`, `hasMore`, `isZip64`, `access?` (1.1.0), `entries[]` (the shared `EntryView` row: `index`, `name`, `nameEncoding`, `isDirectory`, `isSymlink`, `method`, `methodName`, `compressedSize`, `uncompressedSize`, `ratio`, `crc32`, `lastModified`, `isEncrypted`, `usesZip64`, `usesDataDescriptor`, `unixMode`, `sanitizedPath`, `comment?`, `flags { raw, encrypted, dataDescriptor, strongEncryption, utf8 }`, `versionMadeBy`, `versionNeeded`, `hostSystem`, `internalAttributes`, `externalAttributes`, `localHeaderOffset`, `dosDate`, `dosTime`, `extraFields[] { id, idHex, name, length, dataBase64? }`, `rawNameHex`, `commentHex?`, and on request `extendedTimestamps { mtime, atime, ctime, source }`, `unixIds { uid, gid } | null`), `diagnostics[]`, `diagnosticCounts`. Summary scalars: `names[]`, `diagnosticCount`.
- **Error codes:** common; ZIP_* structural refusals.
- **Annotations:** read-only, idempotent. Cacheable.

### `read_zip_entry` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; exactly one of `name` / `index`; `mode` (`data` default | `raw` | `verify`); `encoding` (`base64` default | `utf8`, mode `data` only); `verifyCrc` (default true); `range { offset, length ≤ 16 MiB }` (mode `data` only); `includeExtendedTimestamps`, `includeUnixIds`, `access` (1.1.0); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `entry` (`EntryView`), `mode`, `sizeBytes`, `crcVerified`, `encoding?`, `dataBase64?`, `text?`, `textLength?`, `range { offset, length, returned }?`, `verification { ok, crcMatch, sizeMatch, localHeaderMatch, skipped? }?` (mode `verify`; `skipped` 1.1.0), `access?` (1.1.0), `diagnostics[]`, `diagnosticCounts`. Summary scalars: `name`, `index`, `diagnosticCount`.
- **Error codes:** common; `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`; `ZIP_ENTRY_NOT_FOUND` (name or out-of-range index), `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_CODEC_MODE`, `ZIP_LIMIT_EXCEEDED` (incl. `maxEntryCompressedSize` over byte ranges).
- **Annotations:** read-only, idempotent. Cacheable.

### `verify_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `entries` (`all` default | `failed` | `skipped` | `none`); `maxEntries` (1–100 000, default 1000); `limits`; `verbosity`; `fields`.
- **Outputs:** `ok`, `error { code, message } | null`, `entryCount`, `verifiedCount`, `failedCount`, `skippedCount`, `entries[] { name, ok, crcMatch, sizeMatch, localHeaderMatch, skipped? ('encrypted' | 'stream-only-codec' | 'unsupported-method') }`, `entriesTruncated?`, `diagnostics[]` (de-duplicated, ≤ 200 rows), `diagnosticsTruncated?` (1.1.0, only when the cap bites). Summary scalar: `diagnosticCount`.
- **Error codes:** common only — the tool **never** returns `isError` for a problem with the archive (structural refusals land in `error`, entry problems in `ok: false`). `ZIP_LIMIT_INVALID` is theoretically reachable through `limits` but pre-empted by the schema.
- **Semantics:** counted by the engine's archive rule (§2, behaviour changes).
- **Annotations:** read-only, idempotent. Cacheable.

### `extract_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `outputMode` (`base64` default | `file`); `outputDir` (file mode, required); `includeData` (default true; `false` = dry run); `filter`; `rejectTraversal` (default true); `rejectSymlinks` (default true); `onDuplicate` (`error` default | `first` | `last`); `emptyDirectories` (default false, file mode); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `mode`, `dryRun`, `fileCount`, `totalBytes`, `entries[] { path, entryName, index, sizeBytes, crc32, method, dataBase64?, filePath? }`, `skipped[] { entryName, reason: 'unsafe-path' }`, `outputDir?`, `directoriesCreated?`, `diagnostics[]`, `diagnosticCounts`; in file mode up to 50 `resource_link` content blocks. Summary scalars: `skippedCount`, `paths[]`, `diagnosticCount`.
- **Error codes:** common; `MISSING_OUTPUT_PATH`, `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE` (inline caps; the file-output ceiling in file mode), `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION` (sandbox / realpath); `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH`, `ZIP_LIMIT_EXCEEDED`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, structural refusals.
- **Annotations:** writes (`readOnlyHint` false — file mode writes), not destructive (never overwrites), idempotent. Cacheable in base64 mode only.

### `scan_zip_forward` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `data` (`none` default | `verify` | `include`); `filter`; `maxEntries` (≥ 1, default 10 000 **clamped** to `ZIPNATIVE_MCP_MAX_ENTRIES` — the JSON Schema keeps the default as documentation, the Zod side is optional and the code resolves `min(10000, ceiling)`; only an explicit value above the ceiling is refused); `tolerateTruncation` (default false); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `trust: 'local-headers-only'`, `entryCount`, `keptCount`, `entries[]` (`EntryView` from the local header — `isSymlink`, `usesZip64`, `unixMode` are `null` — plus `kept` and `data { verified, bytesProduced, dataBase64? }?`), `stoppedAt` (`central-directory` — a central directory was met and the rest left unread | `eof` — the whole stream was consumed without one | `max-entries` — more local headers remained past the budget | `error`), `truncated`, `inputBytes`, `bytesDelivered`, `maxEntries` (the budget in force after clamping), `error { code, message }?`, `diagnostics[]`, `diagnosticCounts`. Summary scalars: `names[]`, `diagnosticCount`. The verdict is derived from byte accounting — the wrapper reads no PK signature.
- **Error codes:** common; `LIMIT_CEILING_EXCEEDED` (an explicit `maxEntries` above the ceiling; `data.remedy: 'maxEntries ≤ N'`), `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE` (`data: 'include'`; `data.remedy: "data:'verify'"`); without `tolerateTruncation`: `ZIP_STREAM_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH` (also for an SFX / prepended prefix — the tool refuses one; the stream must start at a local header), `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_DEFLATE_CORRUPT`, `ZIP_CRC_MISMATCH`, `ZIP_LIMIT_EXCEEDED`.
- **Annotations:** read-only, idempotent. Cacheable (base64 input).

### `sanitize_entry_paths` — since 1.0.0
- **Inputs:** `names[]` (1–10 000 strings, ≤ 4096 chars each); `verbosity`; `fields`.
- **Outputs:** `count`, `rejectedCount`, `results[] { name, sanitized: string | null, rejected, reason? ('empty' | 'nul' | 'absolute' | 'drive' | 'unc' | 'traversal' | 'ads' | 'device-name' | 'no-segments') }`. Summary scalar: `rejectedNames[]`.
- **Error codes:** `VALIDATION_ERROR` only.
- **Annotations:** read-only, idempotent. Cacheable.

### `create_zip` — since 1.0.0
- **Inputs:** `entries[]` (0–100 000 — aligned with the engine default `maxEntries` so Zip64 output stays reachable; each `name` (a trailing `/` denotes a directory and refuses a payload — `VALIDATION_ERROR`), `directory`, exactly one of `dataBase64` / `text` / `sourcePath`, `stream` (with `sourcePath`), `zip64` (default false, `stream: true` only, 1.1.0), `compression { method, level, deterministic }`, `date` (`pattern` `^\d{4}-\d{2}-\d{2}`, 1980–2107 at runtime, read as UTC), `comment`, `externalAttributes` | `unixMode` (`pattern` `^(?:0o)?[0-7]{3,4}$`, no surrounding whitespace), `extraFields[] { id, dataBase64 }` ≤ 16); `order` (`canonical` default | `insertion`); `defaultDate` (`pattern` `^(?:now|\d{4}-\d{2}-\d{2})`: ISO instant or `'now'`; omitted = DOS epoch); `compression`; `comment` (≤ 65 535); `chunkSize` (1024–16 777 216, file mode); `parallel { workers ≤ 64 (omitted = the engine default `max(1, min(cores − 1, 8))` bounded by `ZIPNATIVE_MCP_WORKERS`), minWorkerJobSize, jobTimeout }`; `includeSha256` (honoured in base64 **and** file mode — the file is hashed while streaming); `strict`; `limits`; `outputMode` (`base64` default | `file`); `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { entryCount, fileCount, directoryCount, streamedCount, uncompressedBytes, order, deterministic, deflateTier, parallel { requested, workers }, sha256? }` (typed in the tool's `outputSchema`, every key optional), `diagnostics[]`, `diagnosticCounts`; the bytes as an embedded `resource` (base64 mode) or a `resource_link` (file mode).
- **Error codes:** common; `INPUT_TOO_LARGE` (inline payload total), `LIMIT_CEILING_EXCEEDED` (`parallel.workers`), `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE` (inline cap; `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` in file mode), `IO_ERROR`; `ZIP_INVALID_ENTRY_NAME`, `ZIP_DUPLICATE_ENTRY_NAME`, `ZIP_INVALID_OPTION`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_ZIP64_STREAMING` (a streamed entry above 4 GiB without `zip64: true`), `ZIP_INPUT_TOO_LARGE`, `ZIP_API_MISUSE`.
- **Bytes:** covered (§3). Default output is reproducible per environment (`summary.deterministic: false`, `deflateTier: 'node-zlib'`); `compression.deterministic: true` output is frozen across runtimes and is the only case reporting `summary.deterministic: true`; `inspect_zip.determinism` is the separate structural verdict. Pinned dates are UTC since 1.1.0 (§2). `zip64: true` writes the APPNOTE 4.3.9.2 streaming layout only when asked; without it the bytes are those of 1.0.0.
- **Annotations:** writes (`readOnlyHint` false), not destructive, idempotent. Never cached with `defaultDate: 'now'`, `parallel`, `sourcePath` or file mode.

### `modify_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `operations[]` (1–1000: `{ op: 'add' | 'replace', name, … entry payload … }` under the same rules and `pattern`s as `create_zip` — a `/`-terminated name with a payload is `VALIDATION_ERROR`, `{ op: 'remove', name }`, `{ op: 'rename', from, to }`, `{ op: 'setComment', comment }`); `mode` (`append` default | `compact`); `canonical { date?, keepComments (default false), keepExternalAttributes (default true) }` (mode `compact` only, 1.1.0); `compression`; `defaultDate` (`pattern` `^(?:now|\d{4}-\d{2}-\d{2})`); `includeSha256`; `strict`; `limits`; `outputMode`; `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { saveMode, operationsApplied, entryCountBefore, entryCountAfter, inputBytes, outputBytes, grewByBytes, noOp, canonical? (1.1.0), sha256? }` (typed in the tool's `outputSchema`), `diagnostics[]` (incl. `ZIP_DEAD_BYTES_RATIO`), `diagnosticCounts`; the bytes as an embedded `resource` or a `resource_link`.
- **Error codes:** common; `INPUT_TOO_LARGE`, `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`; `ZIP_ENTRY_NOT_FOUND`, `ZIP_ENTRY_EXISTS`, `ZIP_DUPLICATE_ENTRY_NAME` (duplicate-name source archive), `ZIP_INVALID_ENTRY_NAME`, `ZIP_LIMIT_EXCEEDED`, structural refusals — since 1.1.0 including `ZIP_ENTRY_OVERLAP` and a truncated local header at open time (eager validation), and in append mode `ZIP_CD_LFH_MISMATCH` / `ZIP_LIMIT_EXCEEDED` from the per-entry local-header check; `_meta.error.data` carries `operationIndex` and `op`.
- **Bytes:** covered (§3). Append mode preserves the input bytes as a prefix; compact mode is a rewrite sorted by raw name bytes (an insertion order is not kept); names and payloads already in the input are copied verbatim in both modes; `canonical` adds the canonical deterministic form and is opt-in.
- **Annotations:** writes (`readOnlyHint` false), not destructive (the input is never touched; the output is never overwritten), idempotent.

### `canonicalize_zip` — since 1.1.0
- **Inputs:** `zipBase64` | `zipPath`; `date` (ISO-8601, 1980–2107, read as UTC; default the DOS epoch); `keepComments` (default false); `keepExternalAttributes` (default true); `includeSha256` (default false); `strict`; `limits`; `outputMode` (`base64` default | `file`); `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { entryCount, inputBytes, outputBytes, alreadyCanonical, canonicalForm, pinnedDate (ISO-8601 or null), keepComments, keepExternalAttributes, sha256? }`, `diagnostics[]`, `diagnosticCounts`; the bytes as an embedded `resource` or a `resource_link`.
- **Error codes:** common; `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`; `VALIDATION_ERROR` for a date outside the DOS range; `ZIP_DUPLICATE_ENTRY_NAME` (duplicate-name input), `ZIP_LIMIT_EXCEEDED`, `ZIP_CD_LFH_MISMATCH`, structural refusals (`ZIP_ENTRY_OVERLAP` included).
- **Bytes:** covered (§3). Payloads and names are copied verbatim (an unsafe name stays in the output). No codec runs, so the output is identical on every runtime; idempotent (canonicalising the output again returns the same bytes).
- **Annotations:** writes (`readOnlyHint` false — file mode writes), not destructive, idempotent. Cacheable in base64 mode with inline input.

### `merge_zip` — since 1.1.0
- **Inputs:** `sources[]` (1–32: each `zipBase64` | `zipPath` with an optional `filter { names[], prefix, glob[], includeDirectories }`; total ≤ 1 GiB, inline ≤ 128 MiB in all); `onConflict` (`error` default | `first` | `last`); `verify` (default true); `order` (`canonical` default | `insertion`); `comment` (≤ 65 535); `includeSha256`; `strict`; `limits`; `outputMode`; `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { sourceCount, entryCount, inputBytes, outputBytes, onConflict, verified, order, perSource[] { index, label, entryCount, taken, filteredOut, dropped }, dropped[] { name, source }, sha256? }`, `diagnostics[]`, `diagnosticCounts`; the bytes as an embedded `resource` or a `resource_link`.
- **Error codes:** common; `INPUT_TOO_LARGE` (source totals), `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`; `ZIP_DUPLICATE_ENTRY_NAME` (`onConflict: 'error'`), `ZIP_CRC_MISMATCH` / `ZIP_SIZE_MISMATCH` / `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` (`verify: true`), `ZIP_UNSUPPORTED_METHOD` (`verify: true` on an entry with no codec here — refused rather than copied unchecked), `ZIP_UNSUPPORTED_ENCRYPTION` (an encrypted entry cannot be transplanted), `ZIP_INVALID_ENTRY_NAME` (a source name the writer refuses, such as the `./` entry `bsdtar` writes — exclude it with that source's `filter`), `ZIP_CD_LFH_MISMATCH`, `ZIP_ENTRY_OVERLAP`, `ZIP_LIMIT_EXCEEDED`, structural refusals of a source; `_meta.error.data.sourceIndex` names the source.
- **Bytes:** covered (§3) — payloads are copied without recompression; with `order: 'canonical'` the output is deterministic given the same sources.
- **Annotations:** writes (`readOnlyHint` false — file mode writes), not destructive, idempotent. Never cached when a source names a `zipPath`.

### `compute_crc32` — since 1.0.0
- **Inputs:** exactly one of `dataBase64` / `text` / `sourcePath`; `seed` (0–4 294 967 295, default 0); `expect` (1–8 hex digits, optional `0x`; `pattern` `^(?:0x)?[0-9a-fA-F]{1,8}$`).
- **Outputs:** `crc32`, `hex` (8 lowercase digits), `byteLength`, `seed`, `matches?`.
- **Error codes:** `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `INVALID_PATH`, `SECURITY_VIOLATION`, `IO_ERROR`, `CANCELLED` (1.1.0, between 1 MiB chunks), `ENGINE_ERROR`.
- **Annotations:** read-only, idempotent. Cacheable (inline input).

### `inflate_raw` — since 1.0.0
- **Inputs:** exactly one of `dataBase64` / `sourcePath`; `maxOutput` (≥ 1, **required**); `method` (`deflate` default | `store` | numeric id; `pattern` `^(?:deflate|store|[0-9]+)$`); `allowTrailing` (default false); `outputMode`; `outputPath` (`.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`).
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { method, methodName, bytesIn, bytesOut, bytesConsumed, leftover, finished, maxOutput, trailingWarning? }` (typed in the tool's `outputSchema`), `diagnostics: []`; the bytes as an embedded `resource` (`application/octet-stream`) or a `resource_link`.
- **Error codes:** common; `INPUT_TOO_LARGE`, `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `IO_ERROR`, `CANCELLED` (1.1.0, between input chunks); `ZIP_INFLATE_OUTPUT_OVERFLOW` (also for a result above the inline / file cap — `maxOutput` is lowered to the cap, so `OUTPUT_TOO_LARGE` cannot occur), `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_UNSUPPORTED_METHOD` (no codec beyond 0 / 8 is registered), `ZIP_UNSUPPORTED_CODEC_MODE`, `ZIP_INVALID_OPTION`.
- **Bytes:** covered (§3) — inflation is a pure function of the input.
- **Annotations:** writes (`readOnlyHint` false — file mode writes the inflated bytes into the sandbox), not destructive, idempotent. Cacheable in base64 mode only.

### `describe_engine` — since 1.0.0
- **Inputs:** `verbosity`; `fields`.
- **Outputs:** `server { name, version, toolApiVersion, protocol, toolCount }`, `engine { name, version, deflateTier { default, deterministic } }`, `capabilities { nodeZlib, compressionStream, decompressionStream, workerThreads, cpuCount, defaultWorkers }`, `codecs[] { id, name, sync, stream, incremental (1.1.0) }`, `defaultLimits` (nine keys), `ceilings { maxUncompressedBytes, maxEntries, maxWorkers, maxFileOutputBytes (1.1.0), env[] }`, `caps`, `sandbox { enabled, cacheEnabled }`, `network: 'none'`, `errorCodes[]` (39), `diagnosticCodes[]` (12), `unexposed[] { export, rationale }` (eleven entries in 1.1.0). Summary: `server`, `engine`, `capabilities`, `sandbox`, `network`.
- **Error codes:** `VALIDATION_ERROR` only.
- **Annotations:** read-only, idempotent. **Never cached** (environment-dependent).

### `draft_governance_issue` — since 1.0.0
- **Inputs:** `title` (8–160), `summary` (16–16 384), `issueType` (`bug` | `feature` | `security` | `docs` | `performance`), `targetRepo` (default `zipnative-mcp`), `reproduction { command, result }` (each ≤ 16 384), `expectedBehavior` (4–16 384), `actualBehavior?` (≤ 16 384), `affectedPackages[]` (default `['zipnative-mcp']`), `duplicateSearchPerformed` (must be `true`), `outputMode` (`inline` default | `file`), `outputPath` (`.md`). The 16 384-character bounds are new in 1.1.0 (§2).
- **Outputs:** `title`, `issueType`, `targetRepo`, `outputMode`, `filePath?`, `sizeBytes`, `draftMarkdown`, `warnings[]`, `compliance { zeroDependencyConfirmed, reproductionCommand, reproductionResult, duplicateSearchPerformed, affectedPackages, identityReminderShown, humanGate, environment { node, os, zipnativeMcp } }`; two text content blocks (the human-gate notice and the draft).
- **Error codes:** `VALIDATION_ERROR`, `GOVERNANCE_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`, `SECURITY_VIOLATION`.
- **Annotations:** writes (`readOnlyHint` false — file mode writes a `.md`), not destructive, idempotent. **Never cached** (embeds the environment). The `draftMarkdown` and `compliance.humanGate` texts are governance-charter wording carried verbatim and are not promised byte-stable.

> **Deliberate, stable refusals.** No encryption (`ZIP_UNSUPPORTED_ENCRYPTION` — detected, never
> decrypted; the engine 1.x has no AES), no codec beyond store / deflate (`ZIP_UNSUPPORTED_METHOD`),
> no external `ByteSource` / `ReadableStream` input (JSON-RPC has no stream channel), no remote or
> URL byte-range source (the byte-range reader takes a sandbox file only), no `workerUrl`,
> `onDiagnostic` always installed by the server, no `nameDecoder` / `nameEncoding` input (legacy
> code-page names stay CP437-decoded with `rawNameHex` kept), no `addRaw` (`merge_zip` exposes the
> checked `addFromReader`). The JSON `pattern`s (`compute_crc32.expect`, `inflate_raw.method`,
> `date` / `defaultDate`, `unixMode`, `fields` paths) are each mirrored by the identical Zod
> `.regex()` so the advertised schema and the runtime validation cannot drift
> (`tests/schema-lockstep.test.ts` compares `z.toJSONSchema` of every input schema with
> `tools/list`). `describe_engine.unexposed` reports the deliberate omissions with their rationale;
> `docs/KNOWLEDGE_BASE.md` §8 maps all 106 engine exports.

---

## 6. Reporting a breaking change

If you believe a change in a release silently broke a stable contract, please open an issue with:
- the affected tool name,
- the input that worked previously (for a byte change: the `create_zip` / `modify_zip` / `canonicalize_zip` / `merge_zip` arguments and the two `summary.sha256` values, plus the host time zone),
- the new response or error (`_meta.error` verbatim),
- the previous release version where it worked.

We treat unintended breaking changes as bugs and fix them in a patch release. An engine-side byte change is a zipnative bug and belongs upstream ([Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues)); the `draft_governance_issue` tool produces a compliant draft for a human to submit.
