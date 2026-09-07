# API Stability — zipnative-mcp

> Stability charter for the **tool API** (tool names, input/output schemas, error codes, runtime semantics, the bytes the archive-producing tools emit).
> The server binary itself follows standard SemVer for npm releases.

---

## 1. Versioning

Every tool emits `_meta.apiVersion` in the `tools/list` response.

Current value: **`1.0.0`** (stable, since zipnative-mcp 1.0.0; `TOOL_API_VERSION` in `src/version.ts`).

The tool API version is **independent of the npm release version**, although 1.0.0 ships both at the same number. Server releases that ship only documentation, refactoring, or non-breaking ergonomic improvements (richer descriptions, additional `_meta.examples`, new optional output fields) **do not** bump `_meta.apiVersion`.

A bump of `_meta.apiVersion` happens **only** in the cases listed in §3.

> **Engine alignment.** zipnative-mcp 1.0.0 pins `zipnative ^1.0.0`. The engine's own freeze is a
> precondition of this charter: its 77-export API surface, its 39-code error vocabulary and its
> `deterministic: true` output bytes are frozen under semver by
> [zipnative's SECURITY.md](https://github.com/Nizoka/zipnative/blob/main/SECURITY.md). An engine
> **major** bumps this server's major; an engine **minor** that adds an error code fails `tsc` in
> `src/zip-errors.ts` (`ZIP_ERROR_CLASS satisfies Record<ZipErrorCode, …>`) until the wrapper maps
> it, which is then an additive minor here.
>
> **MCP protocol alignment.** The tool API version is orthogonal to the MCP wire-protocol
> revision. The server runs on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` ^2.0.0)
> and speaks **MCP 2026-07-28** — stateless serving, `server/discover`, `resultType`,
> `ttlMs` / `cacheScope` cache hints, the `_meta` `serverInfo` envelope, `Mcp-Method` /
> `Mcp-Name` headers over HTTP — with automatic fallback to the legacy `initialize` handshake for
> `2025-11-25`, `2025-06-18` and `2025-03-26` clients on both stdio and HTTP. The `tools/call`
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
>
> **Output-schema conformance.** `structuredContent` always validates against the tool's
> `outputSchema` — a 2026-07-28 MUST — including `verbosity: 'summary'` and `fields`
> projections and file mode. The eight read tools (`inspect_zip`, `list_zip_entries`,
> `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`,
> `describe_engine`) therefore declare **projectable** output schemas: every property optional,
> no `required`, `additionalProperties: false` kept, and the summary-only scalars declared
> (`deterministic`, `canonicalLayout`, `diagnosticCount`, `names`, `name`, `index`,
> `skippedCount`, `paths`, `rejectedNames`). `create_zip`, `modify_zip` and `inflate_raw` share
> `ARCHIVE_OUTPUT_SCHEMA` (`summary` is `additionalProperties: true` because it is
> tool-specific).
>
> **Transport facts that are SDK behaviour:** on **stdio**, a request sent before the opening
> exchange is dropped without a reply, and JSON-RPC batch arrays (2025-03-26) are not accepted on
> stdio (they are over HTTP). A single stdio frame or HTTP body is capped at 256 MiB
> (`STDIO_MAX_FRAME_BYTES`; HTTP answers 413) — large enough for the 128 MiB decoded base64 input
> cap plus JSON overhead.

---

## 2. What is covered

| Surface | Scope |
|---------|-------|
| Tool **names** (13) | Stable. Renaming a tool is a major bump. |
| Required **input fields** | Stable. Removing or renaming is a major bump. |
| Required **output fields** | Stable. Removing or renaming is a major bump. |
| Field **types** (string / number / bool / enum / object shape) | Stable. Narrowing accepted values or tightening a numeric / length bound is a major bump. |
| **Wrapper error codes** (`code` on `ToolError`, 16: `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `UNKNOWN_RESOURCE`, `GOVERNANCE_VIOLATION`, `ENGINE_ERROR`) | Stable. Removing, renaming or repurposing is a major bump. |
| **Engine error codes** (the 39 `ZIP_*` codes, passed through verbatim) | Stable **upstream** — frozen since zipnative 0.8.0; removing or renaming one is a zipnative major, which is a zipnative-mcp major. The wrapper never rewrites, drops or remaps a `ZIP_*` code (the node:zlib `Z_DATA_ERROR` / `Z_BUF_ERROR` mapping to `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` in `src/zip-errors.ts` is the one place a non-`ZipError` is *given* a `ZIP_*` code, so the code an agent sees does not depend on the codec tier). The 11 diagnostic codes are informational and likewise frozen upstream. Machine-readable registry: [`data/errors.json`](data/errors.json). |
| `_meta.error` **envelope** (`{ code, message, data? }`) | The three keys and `data.errorClass` / `engineError` / `entryName` are stable; further `data` keys are additive. |
| **Produced bytes** (`create_zip`, `modify_zip`, `inflate_raw`) | Covered — see §3: the bytes an archive-producing tool emits for a given input are byte-identical across patch and minor releases (per deflate tier); `compression.deterministic: true` bytes are identical across runtimes and are part of the engine's frozen contract. |
| `_meta.examples` | **Not** covered. May change at any time (at most two per tool; every one is executable against its `inputSchema`). |
| `description` strings, `title`, `serverInfo.instructions`, prompt texts, `_meta.error.message` wording | **Not** covered. May be reworded at any time — the `tools/list` *wording* is outside the byte-identical charter; tool-result `structuredContent` defaults are inside it. |
| `tools/list` **structure** (types, enums, bounds, defaults, `required`, `additionalProperties`, annotations, example count) | Covered, and enforced by the catalogue gates below. |
| Schema **`default`** values | Documented; changes are minor unless they alter produced bytes silently — then major. |
| Unknown input keys | Rejected with `VALIDATION_ERROR` at every nesting level (Zod `.strictObject`), exactly as the published `additionalProperties: false` declares. |
| Server **caps** (`src/caps.ts`, reported by `describe_engine.caps`) | Raising a cap is a patch; lowering one is a major (it rejects previously-accepted input). |
| Operator **environment variables** (7) and their defaults | Renaming or removing one is a major; a new one is a minor. |
| MCP **prompts** (7) and **resource URI scheme** (`zipnative://output/{+path}`) | Names and the scheme are stable; prompt texts are wording. |

**Catalogue gates.** `scripts/tool-shape.mjs` fingerprints the `tools/list` catalogue with every `description` string stripped (names, titles, annotations, input / output schema shapes, example count); `npm run build && node scripts/tool-shape.mjs --write` refreshes `tests/_fixtures/tool-shape.json`, and `tests/catalogue-parity.test.ts` fails on any structural drift — a change there is a deliberate, reviewed fixture refresh under §3 / §5. The same catalogue is frozen as `tests/_fixtures/tool-shape.v1.0.0.json` (never regenerated); a **superset gate** (`tests/catalogue-superset.test.ts`, planned for 1.1.0) will compare every later release with it and fail on any removal or narrowing — tool, input property, enum value, default, `required` added, `additionalProperties` tightened, or a numeric / length bound made stricter. In 1.0.0 the frozen file exists and the parity gate runs; the superset comparison itself starts with the first release that has something to compare against.

---

## 3. Bump rules

### Patch (`1.0.x`)
- New optional output fields added to existing tools (additive only).
- Looser input validation (accept a previously rejected payload); a server cap raised.
- Internal hardening or cache changes that do not alter response shape.
- Documentation, examples, and description refreshes; an engine patch bump.
- **Produced bytes unchanged:** the default output of `create_zip`, `modify_zip` and `inflate_raw` for a given input is byte-identical before and after a patch (per deflate tier — the `node-zlib` tier is stable per environment by the engine's contract, and `compression.deterministic: true` is stable everywhere).

### Minor (`1.x.0`)
- New tool added.
- New optional input field with a backward-compatible default.
- New value added to an existing enum (when older clients can safely ignore it).
- A new wrapper error code, or a new engine `ZIP_*` code mapped after an engine minor; a new diagnostic code surfaced.
- A new environment variable, prompt or resource kind.
- **Produced bytes unchanged** for every input that was valid before (a new option may produce different bytes only when it is used).

### Major (`x.0.0`)
- Tool removed or renamed.
- Required field added or removed.
- Field type narrowed, a bound tightened, or semantics changed.
- Error code removed, renamed, or repurposed (wrapper or engine).
- **A change to the default bytes** of `create_zip` / `modify_zip` / `inflate_raw` for the same input — including a change to the engine's `deterministic: true` encoder, a different canonical order, different default timestamps, attributes or Zip64 decisions, or a different `saveCompact()` layout. The engine records the same rule (`ecosystem.json → deterministic_bytes_are_semver_major`).
- A security default weakened (`rejectTraversal`, `rejectSymlinks`, `onDuplicate`, a `ZipLimits` default, the sandbox rules, the no-overwrite rule).
- An operator ceiling default lowered, a server cap lowered, or an environment variable renamed.
- An engine major.

---

## 4. Deprecation policy

When a tool, field, enum value, error code or environment variable is scheduled for removal:

1. Mark it deprecated in `description` and in this document (§5).
2. Keep it functional for **at least one minor release** before removal.
3. Provide a migration note in the next `release-notes/vX.Y.Z.md` and under `### Deprecated` in `CHANGELOG.md`.
4. Drop only on the next major bump.

An engine deprecation (zipnative marks an export or option deprecated) is surfaced here in the same release the wrapper picks up that engine version, with the same ladder.

---

## 5. Per-tool stability matrix

All 13 tools shipped in zipnative-mcp 1.0.0 are at `_meta.apiVersion = '1.0.0'` and are considered **stable**. For every tool: `_meta.error` carries the wrapper codes marked *common* — `VALIDATION_ERROR` (every tool), and for the archive-consuming tools `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `INVALID_PATH`, `INVALID_EXTENSION`, `SECURITY_VIOLATION` (the `zipPath` form), `LIMIT_CEILING_EXCEEDED` (the `limits` input) and `ENGINE_ERROR`. "ZIP_*" below lists the engine codes a tool is expected to surface; any of the 39 may in principle pass through an engine call.

### `inspect_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `validate` (`eager` default | `lazy`); `check[]` (15 assertions: `deterministic`, `epoch-timestamps`, `canonical-order`, `utf8-names`, `no-data-descriptor`, `canonical-layout`, `no-zip64`, `zip64`, `no-encryption`, `no-symlinks`, `safe-names`, `no-duplicates`, `no-diagnostics`, `store-only`, `deflate-only`); `assert` (`maxEntries`, `minEntries`, `maxUncompressedBytes`, `maxRatio`, `has[]`, `method`); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `archiveBytes`, `entryCount`, `fileCount`, `directoryCount`, `isZip64`, `comment`, `commentBytes`, `commentHex?`, `prependedData`, `multipleEocd`, `compressedBytes`, `uncompressedBytes`, `ratio`, `methods[]`, `encryptedCount`, `symlinkCount`, `dataDescriptorCount`, `zip64EntryCount`, `utf8NameCount`, `cp437NameCount`, `duplicateNameCount`, `unsafeNameCount`, `earliestDate`, `latestDate`, `determinism { epochTimestamps, canonicalOrder, utf8Flags, noDataDescriptors, canonicalLayout, deterministic }`, `diagnostics[]`, `diagnosticCounts`, `diagnosticsTruncated?`, `checks[]?`, `checksPassed?` (present when `check` / `assert` was supplied). Summary scalars: `deterministic`, `canonicalLayout`, `diagnosticCount`.
- **Error codes:** common; ZIP_* structural refusals (`ZIP_EOCD_NOT_FOUND`, `ZIP_RECORD_TRUNCATED`, `ZIP_CD_INCONSISTENT`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_LIMIT_EXCEEDED`, …), `ZIP_STRICT_DIAGNOSTIC` under `strict`.
- **Annotations:** read-only, idempotent. **Cacheable** (base64 input).

### `list_zip_entries` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `offset` (≥ 0, default 0); `limit` (1–2000, default 200); `filter { names[], prefix, glob[], includeDirectories }`; `includeExtraData`; `validate` (`lazy` default | `eager`); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `entryCount`, `matchedCount`, `offset`, `limit`, `returnedCount`, `hasMore`, `isZip64`, `entries[]` (the shared `EntryView` row: `index`, `name`, `nameEncoding`, `isDirectory`, `isSymlink`, `method`, `methodName`, `compressedSize`, `uncompressedSize`, `ratio`, `crc32`, `lastModified`, `isEncrypted`, `usesZip64`, `usesDataDescriptor`, `unixMode`, `sanitizedPath`, `comment?`, `flags { raw, encrypted, dataDescriptor, strongEncryption, utf8 }`, `versionMadeBy`, `versionNeeded`, `hostSystem`, `internalAttributes`, `externalAttributes`, `localHeaderOffset`, `dosDate`, `dosTime`, `extraFields[] { id, idHex, name, length, dataBase64? }`, `rawNameHex`, `commentHex?`), `diagnostics[]`, `diagnosticCounts`. Summary scalars: `names[]`, `diagnosticCount`.
- **Error codes:** common; ZIP_* structural refusals.
- **Annotations:** read-only, idempotent. Cacheable.

### `read_zip_entry` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; exactly one of `name` / `index`; `mode` (`data` default | `raw` | `verify`); `encoding` (`base64` default | `utf8`, mode `data` only); `verifyCrc` (default true); `range { offset, length ≤ 16 MiB }` (mode `data` only); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `entry` (`EntryView`), `mode`, `sizeBytes`, `crcVerified`, `encoding?`, `dataBase64?`, `text?`, `textLength?`, `range { offset, length, returned }?`, `verification { ok, crcMatch, sizeMatch, localHeaderMatch }?` (mode `verify`), `diagnostics[]`, `diagnosticCounts`. Summary scalars: `name`, `index`, `diagnosticCount`.
- **Error codes:** common; `ENTRY_TOO_LARGE`, `ENTRY_NOT_UTF8`; `ZIP_ENTRY_NOT_FOUND` (name or out-of-range index), `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DECOMPRESSION_FAILED`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_CODEC_MODE`, `ZIP_LIMIT_EXCEEDED`.
- **Annotations:** read-only, idempotent. Cacheable.

### `verify_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `entries` (`all` default | `failed` | `skipped` | `none`); `maxEntries` (1–100 000, default 1000); `limits`; `verbosity`; `fields`.
- **Outputs:** `ok`, `error { code, message } | null`, `entryCount`, `verifiedCount`, `failedCount`, `skippedCount`, `entries[] { name, ok, crcMatch, sizeMatch, localHeaderMatch, skipped? ('encrypted' | 'stream-only-codec') }`, `entriesTruncated?`, `diagnostics[]`. Summary scalar: `diagnosticCount`.
- **Error codes:** common only — the tool **never** returns `isError` for a problem with the archive (structural refusals land in `error`, entry problems in `ok: false`). `ZIP_LIMIT_INVALID` is theoretically reachable through `limits` but pre-empted by the schema.
- **Annotations:** read-only, idempotent. Cacheable.

### `extract_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `outputMode` (`base64` default | `file`); `outputDir` (file mode, required); `includeData` (default true; `false` = dry run); `filter`; `rejectTraversal` (default true); `rejectSymlinks` (default true); `onDuplicate` (`error` default | `first` | `last`); `emptyDirectories` (default false, file mode); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `mode`, `dryRun`, `fileCount`, `totalBytes`, `entries[] { path, entryName, index, sizeBytes, crc32, method, dataBase64?, filePath? }`, `skipped[] { entryName, reason: 'unsafe-path' }`, `outputDir?`, `directoriesCreated?`, `diagnostics[]`, `diagnosticCounts`; in file mode up to 50 `resource_link` content blocks. Summary scalars: `skippedCount`, `paths[]`, `diagnosticCount`.
- **Error codes:** common; `MISSING_OUTPUT_PATH`, `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`, `SECURITY_VIOLATION` (sandbox / realpath); `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH`, `ZIP_LIMIT_EXCEEDED`, `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, structural refusals.
- **Annotations:** not read-only (file mode writes), not destructive (never overwrites), idempotent. Cacheable in base64 mode only.

### `scan_zip_forward` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `data` (`none` default | `verify` | `include`); `filter`; `maxEntries` (≥ 1, default 10 000, ≤ `ZIPNATIVE_MCP_MAX_ENTRIES`); `tolerateTruncation` (default false); `strict`; `limits`; `verbosity`; `fields`.
- **Outputs:** `trust: 'local-headers-only'`, `entryCount`, `keptCount`, `entries[]` (`EntryView` from the local header — `isSymlink`, `usesZip64`, `unixMode` are `null` — plus `kept` and `data { verified, bytesProduced, dataBase64? }?`), `stoppedAt` (`central-directory` | `eof` | `max-entries` | `error`), `truncated`, `inputBytes`, `bytesDelivered`, `error { code, message }?`, `diagnostics[]`, `diagnosticCounts`. Summary scalars: `names[]`, `diagnosticCount`.
- **Error codes:** common; `LIMIT_CEILING_EXCEEDED` (`maxEntries`), `ENTRY_TOO_LARGE`, `OUTPUT_TOO_LARGE` (`data: 'include'`); without `tolerateTruncation`: `ZIP_STREAM_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DECOMPRESSION_FAILED`, `ZIP_CRC_MISMATCH`, `ZIP_LIMIT_EXCEEDED`.
- **Annotations:** read-only, idempotent. Cacheable (base64 input).

### `sanitize_entry_paths` — since 1.0.0
- **Inputs:** `names[]` (1–10 000 strings, ≤ 4096 chars each); `verbosity`; `fields`.
- **Outputs:** `count`, `rejectedCount`, `results[] { name, sanitized: string | null, rejected, reason? ('empty' | 'nul' | 'absolute' | 'drive' | 'unc' | 'traversal' | 'ads' | 'device-name' | 'no-segments') }`. Summary scalar: `rejectedNames[]`.
- **Error codes:** `VALIDATION_ERROR` only.
- **Annotations:** read-only, idempotent. Cacheable.

### `create_zip` — since 1.0.0
- **Inputs:** `entries[]` (0–10 000; each `name`, `directory`, exactly one of `dataBase64` / `text` / `sourcePath`, `stream` (with `sourcePath`), `compression { method, level, deterministic }`, `date`, `comment`, `externalAttributes` | `unixMode`, `extraFields[] { id, dataBase64 }` ≤ 16); `order` (`canonical` default | `insertion`); `defaultDate` (ISO instant or `'now'`; omitted = DOS epoch); `compression`; `comment` (≤ 65 535); `chunkSize` (1024–16 777 216, file mode); `parallel { workers ≤ 64, minWorkerJobSize, jobTimeout }`; `includeSha256`; `strict`; `limits`; `outputMode` (`base64` default | `file`); `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { entryCount, fileCount, directoryCount, streamedCount, uncompressedBytes, order, deterministic, deflateTier, parallel { requested, workers }, sha256? }`, `diagnostics[]`, `diagnosticCounts`; the bytes as an embedded `resource` (base64 mode) or a `resource_link` (file mode).
- **Error codes:** common; `INPUT_TOO_LARGE` (inline payload total), `LIMIT_CEILING_EXCEEDED` (`parallel.workers`), `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`; `ZIP_INVALID_ENTRY_NAME`, `ZIP_DUPLICATE_ENTRY_NAME`, `ZIP_INVALID_OPTION`, `ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_ZIP64_STREAMING` (a streamed entry > 4 GiB), `ZIP_INPUT_TOO_LARGE`, `ZIP_API_MISUSE`.
- **Bytes:** covered (§3). Default output is reproducible per environment; `compression.deterministic: true` output is frozen across runtimes.
- **Annotations:** not read-only, not destructive, idempotent. Never cached with `defaultDate: 'now'`, `parallel`, `sourcePath` or file mode.

### `modify_zip` — since 1.0.0
- **Inputs:** `zipBase64` | `zipPath`; `operations[]` (1–1000: `{ op: 'add' | 'replace', name, … entry payload … }`, `{ op: 'remove', name }`, `{ op: 'rename', from, to }`, `{ op: 'setComment', comment }`); `mode` (`append` default | `compact`); `compression`; `defaultDate`; `includeSha256`; `strict`; `limits`; `outputMode`; `outputPath`.
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { saveMode, operationsApplied, entryCountBefore, entryCountAfter, inputBytes, outputBytes, grewByBytes, noOp, sha256? }`, `diagnostics[]` (incl. `ZIP_DEAD_BYTES_RATIO`), `diagnosticCounts`; the bytes as an embedded `resource` or a `resource_link`.
- **Error codes:** common; `INPUT_TOO_LARGE`, `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`; `ZIP_ENTRY_NOT_FOUND`, `ZIP_ENTRY_EXISTS`, `ZIP_DUPLICATE_ENTRY_NAME` (duplicate-name source archive), `ZIP_INVALID_ENTRY_NAME`, `ZIP_LIMIT_EXCEEDED`, structural refusals; `_meta.error.data` carries `operationIndex` and `op`.
- **Bytes:** covered (§3). Append mode preserves the input bytes as a prefix; compact mode is the canonical rewrite.
- **Annotations:** not read-only, not destructive (the input is never touched; the output is never overwritten), idempotent.

### `compute_crc32` — since 1.0.0
- **Inputs:** exactly one of `dataBase64` / `text` / `sourcePath`; `seed` (0–4 294 967 295, default 0); `expect` (1–8 hex digits, optional `0x`).
- **Outputs:** `crc32`, `hex` (8 lowercase digits), `byteLength`, `seed`, `matches?`.
- **Error codes:** `VALIDATION_ERROR`, `INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `INVALID_PATH`, `SECURITY_VIOLATION`, `ENGINE_ERROR`.
- **Annotations:** read-only, idempotent. Cacheable (inline input).

### `inflate_raw` — since 1.0.0
- **Inputs:** exactly one of `dataBase64` / `sourcePath`; `maxOutput` (≥ 1, **required**); `method` (`deflate` default | `store` | numeric id); `allowTrailing` (default false); `outputMode`; `outputPath` (`.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`).
- **Outputs:** `mode`, `sizeBytes`, `filePath?`, `summary { method, methodName, bytesIn, bytesOut, bytesConsumed, leftover, finished, maxOutput, trailingWarning? }`, `diagnostics: []`; the bytes as an embedded `resource` (`application/octet-stream`) or a `resource_link`.
- **Error codes:** common; `INPUT_TOO_LARGE`, `MISSING_OUTPUT_PATH`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`; `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DEFLATE_CORRUPT`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_UNSUPPORTED_METHOD` (no codec beyond 0 / 8 is registered), `ZIP_UNSUPPORTED_CODEC_MODE`, `ZIP_INVALID_OPTION`.
- **Bytes:** covered (§3) — inflation is a pure function of the input.
- **Annotations:** read-only (base64 mode), idempotent.

### `describe_engine` — since 1.0.0
- **Inputs:** `verbosity`; `fields`.
- **Outputs:** `server { name, version, toolApiVersion, protocol, toolCount }`, `engine { name, version, deflateTier { default, deterministic } }`, `capabilities { nodeZlib, compressionStream, decompressionStream, workerThreads, cpuCount, defaultWorkers }`, `codecs[] { id, name, sync, stream }`, `defaultLimits`, `ceilings { maxUncompressedBytes, maxEntries, maxWorkers, env[] }`, `caps`, `sandbox { enabled, cacheEnabled }`, `network: 'none'`, `errorCodes[]` (39), `diagnosticCodes[]` (11), `unexposed[] { export, rationale }`. Summary: `server`, `engine`, `capabilities`, `sandbox`, `network`.
- **Error codes:** `VALIDATION_ERROR` only.
- **Annotations:** read-only, idempotent. **Never cached** (environment-dependent).

### `draft_governance_issue` — since 1.0.0
- **Inputs:** `title` (8–160), `summary` (≥ 16), `issueType` (`bug` | `feature` | `security` | `docs` | `performance`), `targetRepo` (default `zipnative-mcp`), `reproduction { command, result }`, `expectedBehavior`, `actualBehavior?`, `affectedPackages[]` (default `['zipnative-mcp']`), `duplicateSearchPerformed` (must be `true`), `outputMode` (`inline` default | `file`), `outputPath` (`.md`).
- **Outputs:** `title`, `issueType`, `targetRepo`, `outputMode`, `filePath?`, `sizeBytes`, `draftMarkdown`, `warnings[]`, `compliance { zeroDependencyConfirmed, reproductionCommand, reproductionResult, duplicateSearchPerformed, affectedPackages, identityReminderShown, humanGate, environment { node, os, zipnativeMcp } }`; two text content blocks (the human-gate notice and the draft).
- **Error codes:** `VALIDATION_ERROR`, `GOVERNANCE_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`, `INVALID_EXTENSION`, `OUTPUT_EXISTS`, `OUTPUT_TOO_LARGE`, `IO_ERROR`, `SECURITY_VIOLATION`.
- **Annotations:** not read-only (file mode writes a `.md`), not destructive, idempotent. **Never cached** (embeds the environment). The `draftMarkdown` and `compliance.humanGate` texts are governance-charter wording carried verbatim and are not promised byte-stable.

> **1.0.0 baseline.** There is no earlier tool API to compare with; the deltas recorded by future
> releases start from `tests/_fixtures/tool-shape.v1.0.0.json`. Known refusals that are
> deliberate and stable: no encryption (`ZIP_UNSUPPORTED_ENCRYPTION` — detected, never
> decrypted), no codec beyond store / deflate (`ZIP_UNSUPPORTED_METHOD`), no external
> `ByteSource` / `ReadableStream` input (JSON-RPC has no stream channel), no `workerUrl`,
> `onDiagnostic` always installed by the server. `describe_engine.unexposed` reports the same list
> with its rationale; `docs/KNOWLEDGE_BASE.md` §8 maps all 77 engine exports.

---

## 6. Reporting a breaking change

If you believe a change in a release silently broke a stable contract, please open an issue with:
- the affected tool name,
- the input that worked previously (for a byte change: the `create_zip` / `modify_zip` arguments and the two `summary.sha256` values),
- the new response or error (`_meta.error` verbatim),
- the previous release version where it worked.

We treat unintended breaking changes as bugs and fix them in a patch release. An engine-side byte change is a zipnative bug and belongs upstream ([Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues)); the `draft_governance_issue` tool produces a compliant draft for a human to submit.
