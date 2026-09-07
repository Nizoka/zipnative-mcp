# AGENTS.md — zipnative-mcp

Operations manual for AI agents. Two audiences:

1. **Agents *using* the server** (Copilot, Claude, Cursor, Cline, …) — read §1–§6.
2. **Agents *contributing* to this repo** — read §7.

The server also returns the §2 decision tree in the `instructions` field of the opening exchange (initialize / server/discover result). Deeper
references: [docs/AI_GUIDE.md](docs/AI_GUIDE.md) (pitfalls + recipes),
[docs/guides/CONFORMANCE.md](docs/guides/CONFORMANCE.md) (the veraZIP gate),
[docs/data/errors.json](docs/data/errors.json) (the frozen error registry). Worked
invocations live under [examples/](examples/).

---

## 1. Tool catalogue (13 tools)

| # | Tool | Use it for | Read-only |
|---|------|-----------|:---:|
| 1 | `inspect_zip` | ONE-call archive report: sizes, entry / file / directory counts, Zip64, comment (+ `commentHex`), compressed vs uncompressed totals, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date range, `prependedData` / `multipleEocd`, a `determinism` verdict (`deterministic` = epoch timestamps + canonical order + UTF-8 flags; `canonicalLayout` = no data descriptors; the structural verdict — a pinned non-epoch date reproduces but reports false here) and every diagnostic. `validate` 'eager' (default — every entry's real extent checked up front: overlapping entries, entries reaching into the central directory or past EOF and Zip64 spoofing are refused with their `ZIP_*` code; a method / CRC / size divergence between central and local headers is caught by `verify_zip` and on read, not here) / 'lazy'. `check: […]` (15 named assertions) and `assert: {maxEntries, minEntries, maxUncompressedBytes, maxRatio, has, method}` → `checks[]` + `checksPassed`. `strict`, `limits`², projection⁴. | ✓ |
| 2 | `list_zip_entries` | Paged central-directory inventory, nothing decompressed: every entry (duplicates included) in directory order as a full row (name + `nameEncoding`, sizes, `ratio`, `crc32`, `method` / `methodName`, `lastModified`, decoded `flags`, `unixMode`, `isSymlink`, `usesZip64`, `usesDataDescriptor`, `hostSystem`, `localHeaderOffset`, named `extraFields`, `sanitizedPath` (null = unsafe name), `comment`, `rawNameHex`). `filter`³, `offset` + `limit` (default 200, max 2000, `hasMore`), `includeExtraData`, `validate` 'lazy' (default) / 'eager', `strict`, `limits`², projection⁴ (summary → names only). | ✓ |
| 3 | `read_zip_entry` | ONE entry by `name` (exact, case-sensitive; the LAST duplicate wins) or `index` (disambiguates duplicates). `mode` 'data' (default): decompressed content as `dataBase64` or `text` (`encoding: 'utf8'` → `ENTRY_NOT_UTF8` otherwise), CRC-verified (`verifyCrc`); `range: {offset, length}` reads a byte window through the chunked stream (bounded memory, no CRC, length ≤ 16 MiB); 'raw': the compressed payload verbatim (→ `inflate_raw`); 'verify': `verification: {ok, crcMatch, sizeMatch, localHeaderMatch}` only. Inline cap 16 MiB (`ENTRY_TOO_LARGE`). `strict`, `limits`², projection⁴. | ✓ |
| 4 | `verify_zip` | Deep verification in one call — zipnative's `verifyZip` report verbatim: `ok`, `error` {code, message} for a structural refusal, `entryCount` / `verifiedCount` / `failedCount` / `skippedCount`, per-entry rows (`crcMatch`, `sizeMatch`, `localHeaderMatch`, `skipped` 'encrypted' / 'stream-only-codec'; an entry whose method has no codec here — anything but 0 store / 8 deflate — is reported FAILED, not skipped: the engine's verdict verbatim), diagnostics. NEVER `isError` for an archive problem. `entries` 'all' (default) / 'failed' / 'skipped' / 'none', `maxEntries` (default 1000, `entriesTruncated`), `limits`², projection⁴. | ✓ |
| 5 | `extract_zip` | Secure-by-default extraction. `rejectTraversal` (default true → `ZIP_PATH_TRAVERSAL`; false SKIPS unsafe names into `skipped`, never emits them), `rejectSymlinks` (default true → `ZIP_SYMLINK_REJECTED`; false writes the target TEXT as data), `onDuplicate` 'error' (default) / 'first' / 'last', `limits`², overlaps and central/local divergence always refused. The archive is opened EAGERLY before any plan in both modes: the dry run refuses an overlapping, offset-into-CD / past-EOF or Zip64-spoofed archive with its `ZIP_*` code before a single plan row (a file-mode extraction fails before its first write); a central/local divergence of method, CRC or sizes is detected on read — `verify_zip` `localHeaderMatch` is the one-call gate. `filter`³. `outputMode` 'base64' (default): rows with `path` (sanitized), `entryName`, `index`, `sizeBytes`, `crc32`, `method`, `dataBase64` (≤ 16 MiB each, ≤ 32 MiB total; `includeData: false` = dry run of the plan, `dryRun: true`); 'file': streams under a relative `outputDir` inside `ZIPNATIVE_MCP_OUTPUT_DIR` (never overwrites, ≤ 4 GiB), `filePath` per row + up to 50 `resource_link`s, `emptyDirectories`. `strict`, projection⁴. | |
| 6 | `scan_zip_forward` | Walk LOCAL headers in stream order with bounded memory (`iterateZipEntries`) — the only tool that works on a truncated download or a cut / unseekable stream that starts at a local header, and the only one whose result is NOT authoritative (`trust: 'local-headers-only'`; `isSymlink` / `usesZip64` / `unixMode` are null). It cannot skip an SFX / prepended prefix and refuses one (`ZIP_SIGNATURE_MISMATCH`) — `inspect_zip` handles it (`prependedData`, `ZIP_PREPENDED_DATA`), `modify_zip mode: 'compact'` drops it. `data` 'none' (default; a bit-3 entry still costs a decompress-and-discard) / 'verify' / 'include' (inline caps), `filter`³, `maxEntries` (default 10000, clamped to the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling; an explicit value above it → `LIMIT_CEILING_EXCEEDED`), `tolerateTruncation: true` → partial inventory + `error` {code, message} + `stoppedAt: 'error'`. `stoppedAt` 'central-directory' (a central directory was met, the rest left unread) / 'eof' (whole stream consumed, none met — truncated or CD-less) / 'max-entries' (more headers remained; an archive with exactly `maxEntries` entries ends at 'central-directory') / 'error', `truncated`, `inputBytes`, `bytesDelivered`, `maxEntries` (the budget in force). `strict`, `limits`², projection⁴. | ✓ |
| 7 | `sanitize_entry_paths` | The engine's single traversal gate `sanitizeEntryPath()` over `names` (1–10000): each → `sanitized` (safe '/'-relative path to join under YOUR root) or null with `rejected: true` and `reason` (empty, nul, absolute, drive, unc, traversal, ads, device-name, no-segments). No archive needed. Projection⁴ (summary → `rejectedNames`). | ✓ |
| 8 | `create_zip` | Write a ZIP from `entries` (0–100000 — Zip64 auto-promotes past 65 535; the engine default `maxEntries` and the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling remain the effective bound; each `name` + exactly one of `dataBase64` / `text` / `sourcePath`¹, or `directory: true` — a `/`-terminated name with a payload is `VALIDATION_ERROR`; per entry `compression`, `date` (ISO instant, `pattern`), `comment`, `unixMode` (3–4 octal digits, `pattern`) xor `externalAttributes`, `extraFields` [{id, dataBase64}] ≤ 16, `stream: true` with a sourcePath → `addStream`, data-descriptor layout, > 4 GiB refused). Reproducible on one runtime by default; `order` 'canonical' (default) / 'insertion' (EPUB / JAR), `defaultDate` ISO instant or 'now', `compression` {method 'store' / 'deflate', level 0–9, deterministic: true = cross-runtime identical bytes}, `comment`, `chunkSize` (file mode), `parallel` {workers 0–64 (≤ `ZIPNATIVE_MCP_WORKERS`; omitted = the engine default max(1, min(cores − 1, 8)) bounded by the ceiling), minWorkerJobSize, jobTimeout} (byte-identical), `includeSha256` (base64 and file mode), `strict`, `limits`², `outputMode` 'base64' / 'file' + `outputPath`. `summary` (typed in the output schema): entryCount, fileCount, directoryCount, streamedCount, uncompressedBytes, order, `deterministic` (true ONLY with `compression.deterministic: true`; a default call reports false with `deflateTier` 'node-zlib' — `inspect_zip.determinism` is the separate structural verdict), `deflateTier`, parallel, `sha256`. Every archive written is ISO/IEC 21320-1 conformant. | |
| 9 | `modify_zip` | Edit an existing archive without recompressing: `operations` (1–1000, applied in order) — `{op: 'add' \| 'replace', name, payload¹ + entry options}` (same rules and `pattern`s as `create_zip`; a `/`-terminated name with a payload is `VALIDATION_ERROR`), `{op: 'remove', name}`, `{op: 'rename', from, to}`, `{op: 'setComment', comment}`. `mode` 'append' (default; save(): original bytes verbatim, edits appended, removed / replaced payloads REMAIN — data remanence, `ZIP_DEAD_BYTES_RATIO` past 50 %) / 'compact' (saveCompact(): canonical rewrite, still no recompression, removed data truly gone, SFX prefix dropped). `compression` / `defaultDate` for new payloads, `includeSha256`, `strict`, `limits`², output base64 / file. `summary`: saveMode, operationsApplied, entryCountBefore / After, inputBytes, outputBytes, grewByBytes, `noOp`, sha256. Duplicate-name archives refused. | |
| 10 | `compute_crc32` | IEEE 802.3 CRC-32 (the engine's slice-by-8) of exactly one of `text` / `dataBase64` / `sourcePath`¹ (streamed in 1 MiB chunks, ≤ 1 GiB). `seed` (0–0xffffffff) continues a running CRC; `expect` (1–8 hex digits, optional `0x`; `pattern` `^(?:0x)?[0-9a-fA-F]{1,8}$`) → `matches`. Result `crc32`, `hex`, `byteLength`, `seed`. | ✓ |
| 11 | `inflate_raw` | Raw DEFLATE (RFC 1951) from `dataBase64` or `sourcePath`¹ with a MANDATORY `maxOutput` through the resumable inflater: constant memory, exact `bytesConsumed`, trailing bytes as `leftover` (`allowTrailing` silences the warning), `ZIP_INFLATE_OUTPUT_OVERFLOW` past the bound. `method` 'deflate' (default) / 'store' (bounded pass-through) / a numeric id (`pattern` `^(?:deflate\|store\|[0-9]+)$`; no codec registered here → `ZIP_UNSUPPORTED_METHOD`). Output base64 (≤ 50 MiB, `application/octet-stream`) or a sandbox file (`.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw`). | ⁵ |
| 12 | `describe_engine` | Offline preflight (no archive): `server` {name, version, toolApiVersion, protocol, toolCount}, `engine` {version, deflateTier {default, deterministic}}, `capabilities` (nodeZlib, compressionStream, decompressionStream, workerThreads, cpuCount, defaultWorkers), `codecs`, `defaultLimits`, `ceilings` (+ the env names), `caps`, `sandbox` {enabled, cacheEnabled}, `network: 'none'`, `errorCodes` (39), `diagnosticCodes` (11), `unexposed` engine exports with the rationale. Projection⁴. Never cached. | ✓ |
| 13 | `draft_governance_issue` | Draft a governance-compliant GitHub issue for **human** review: `title`, `summary`, `issueType` (bug / feature / security / docs / performance), `targetRepo` ('zipnative-mcp' default, or 'zipnative' for engine behaviour), `reproduction` {command, result}, `expectedBehavior`, `actualBehavior`, `affectedPackages`, `duplicateSearchPerformed` (MUST be true). Returns `draftMarkdown` + `compliance` report + `warnings`; **never submits**, no network. `outputMode` 'inline' (default) / 'file' (+ `.md` `outputPath`). | ⁶ |

¹ **Input forms.** Archive input is exactly one of `zipBase64` (the raw archive as base64 exactly once; a `data:…;base64,` prefix is tolerated; decoded ≤ 128 MiB) or `zipPath` (a relative path inside `ZIPNATIVE_MCP_OUTPUT_DIR`; container extensions only — `.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix .nupkg .whl .apk .ipa .xpi .crx .kmz`; buffered ≤ 1 GiB; never cached). Payloads are exactly one of `dataBase64` / `text` / `sourcePath` (a relative sandbox path, any extension, ≤ 1 GiB). Every path read is checked by its **real** path: a symlink or junction planted in the sandbox that points outside it is `SECURITY_VIOLATION` on `zipPath` / `sourcePath` / `resources/read`, exactly as on writes. Without the sandbox variable every path input is refused with `SECURITY_VIOLATION` and the tools work on base64 only.
² **`limits` fragment** (every engine-touching tool): the eight named `ZipLimits` bounds — `maxEntries`, `maxEntryUncompressedSize`, `maxTotalUncompressedSize`, `maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`, `maxCommentBytes`, `maxCentralDirectoryBytes` (engine defaults 100000 · 1 GiB · 8 GiB · 1024 · 4096 · 65535 · 65535 · 256 MiB). Raise a bound for trusted input only; a value above the operator ceilings (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`) is refused with `LIMIT_CEILING_EXCEEDED` naming the variable; a ceiling below the engine default tightens it silently. `strict: true` escalates the first diagnostic to `ZIP_STRICT_DIAGNOSTIC`.
³ **`filter` fragment** (`list_zip_entries`, `extract_zip`, `scan_zip_forward`): `names` (exact, ≤ 1000), `prefix`, `glob` (≤ 32 patterns; `*` within a segment, `**` across, `?` one char; a pattern without `/` matches at any depth, a trailing `/` a whole subtree), `includeDirectories` (default false — listing and scanning include directories when no filter is given). Several keys are ANDed.
⁴ **Projection** (the read tools and `extract_zip`): `verbosity: 'summary'` and `fields: [dot.paths]` — see §3. Server caps: 256 MiB stdio frame / HTTP body; 50 MiB inline output; 4 GiB file output; 16 MiB inline entry; 32 MiB inline extraction total; diagnostics ≤ 200 per result (`diagnosticsTruncated`). Every cap — these and the JSON-shape bounds (`create_zip` ≤ 100000 entries, `modify_zip` ≤ 1000 operations, `sanitize_entry_paths` ≤ 10000 names, `filter.names` ≤ 1000, `filter.glob` ≤ 32, `extraFields` ≤ 16, `fields` ≤ 16, `scan_zip_forward` default `maxEntries` 10000, ≤ 50 resource links, `range.length` ≤ 16 MiB), the `resources/list` bounds (1000 entries, walk depth 8, 50 MiB per `resources/read`) and the cache bounds (3600 s TTL, 256 MiB) — is advertised by `describe_engine.caps`.
⁵ `inflate_raw` is not annotated `readOnlyHint` (like `draft_governance_issue`): its default inline mode is side-effect free, but `outputMode: 'file' writes the inflated bytes into the sandbox.
⁶ `draft_governance_issue` is read-only in the default inline mode; `outputMode: 'file'` writes a `.md` into the sandbox, so its `readOnlyHint` is `false`.

**Known limitations (engine-side, zipnative 1.0.0):** no encryption, read or write, in 1.x — encrypted entries are detected (`isEncrypted`, `encryptedCount`), reported as `skipped: 'encrypted'` by `verify_zip`, and refused by `read_zip_entry` / `extract_zip` with the typed `ZIP_UNSUPPORTED_ENCRYPTION`; there is no password input. The forward reader (`scan_zip_forward`) refuses data-descriptor (bit 3) entries it cannot delimit without a central directory — store + bit 3, encrypted + bit 3, custom codec + bit 3 — with `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, and `skip()` on a deflate bit-3 entry costs a full decompress-and-discard. `create_zip` `stream: true` entries above 4 GiB are refused with `ZIP_UNSUPPORTED_ZIP64_STREAMING` (buffered entries are fully Zip64). Windows reserved device names (`CON`, `NUL`, `AUX`, `COM1`…`LPT9`) are refused by the traversal gate on **every** platform — a POSIX-authored archive holding `aux.h` fails `extract_zip` by default (`rejectTraversal: false` skips it), and `create_zip` / `modify_zip` refuse to write such a name. `modify_zip` mode `'compact'` drops an SFX prefix; archives with duplicate entry names cannot be modified incrementally. Codec injection is not exposed at all (a codec is executable code, JSON cannot carry one) and would not cross into the worker bundle anyway — only methods 0 (store) and 8 (deflate) are readable and writable. 64-bit fields above `Number.MAX_SAFE_INTEGER` are refused (`ZIP_VALUE_UNREPRESENTABLE`). Archive repair is out of scope: a broken structure is reported, never guessed at.

## 2. Decision tree

```
What is in this archive?
 ├─ facts + determinism verdict + diagnostics → inspect_zip        (check:[…] / assert:{…} for a CI gate; verbosity:'summary' for the verdict)
 └─ the rows (paged, filtered)               → list_zip_entries   (filter by names / prefix / glob; offset + limit; summary → names only)
Is it intact / safe to trust?  (the verify_before_trust prompt)
 ├─ 1. verify_zip           → never throws for archive problems: branch on ok, error.code, failedCount, skippedCount
 ├─ 2. inspect_zip          → check:['safe-names','no-encryption','no-symlinks','no-duplicates'] (+ assert:{maxUncompressedBytes, maxRatio}) → checksPassed
 ├─ 3. list_zip_entries     → eyeball the names (sanitizedPath null = the extraction gate will refuse it)
 └─ 4. extract_zip          → includeData:false first (the dry-run plan — opens eagerly, so a hostile extent is refused before any plan), then the real extraction with the defaults
Read ONE file without extracting?  → read_zip_entry
 ├─ text?                            → encoding:'utf8'   (ENTRY_NOT_UTF8 → fall back to base64)
 ├─ only a window of a big file?     → range:{offset,length}   (no CRC for a window)
 ├─ the compressed bytes?            → mode:'raw'  → inflate_raw with a maxOutput
 ├─ just check it?                   → mode:'verify'
 └─ a duplicate name?                → index from list_zip_entries (name returns the LAST duplicate)
Get files out?  → extract_zip  (every guard ON; the secure_extraction prompt)
 ├─ into the sandbox                 → outputMode:'file' + outputDir (resource_link per file; never overwrites)
 ├─ a subset                         → filter
 ├─ hostile names present            → rejectTraversal:false SKIPS them (never emits an unsafe path) — read `skipped`
 ├─ symlink entries                  → rejectSymlinks:false writes the TARGET TEXT as a file (never a link)
 ├─ two entries → one path           → onDuplicate:'first' | 'last'
 └─ trusted but huge                 → limits.* (≤ the operator ceilings; LIMIT_CEILING_EXCEEDED names the variable)
Build an archive?  → create_zip  (the reproducible_archive prompt)
 ├─ identical bytes on every runtime → compression:{deterministic:true} (+ includeSha256 to prove it) — the only case where summary.deterministic is true; a default call is reproducible on one runtime and reports false
 ├─ EPUB / JAR (mimetype first, stored) → order:'insertion', first entry compression:{method:'store'}
 ├─ many large entries               → parallel:{workers}  (byte-identical; capped by ZIPNATIVE_MCP_WORKERS)
 ├─ a multi-GiB sandbox file         → sourcePath + stream:true + outputMode:'file' (data-descriptor layout, > 4 GiB refused)
 └─ real timestamps                  → defaultDate:'<ISO>' (still reproducible) — never 'now' unless you accept ZIP_TIMESTAMP_NOT_PINNED
Change an existing archive?  → modify_zip  (the incremental_update prompt)
 ├─ add / replace / remove / rename / setComment, in order; rename never overwrites (remove the target first)
 ├─ must the removed content be GONE? → mode:'compact'   ('append' keeps every original byte — data remanence)
 └─ duplicate names in the source?   → ZIP_DUPLICATE_ENTRY_NAME: extract and rebuild with create_zip
Truncated download, cut or unseekable stream, forensics?  → scan_zip_forward  (the forensic_scan prompt)
 ├─ NOT authoritative (local headers only) — compare with list_zip_entries whenever the whole file is readable
 ├─ the stream must START at a local header — an SFX / prepended prefix is refused (ZIP_SIGNATURE_MISMATCH)
 ├─ tolerateTruncation:true          → partial inventory + error{code} + stoppedAt:'error'
 └─ data:'verify' to check CRCs, data:'include' for content (inline caps)
Self-extractor / prepended prefix?   → inspect_zip (reports prependedData; the engine shifts offsets) — modify_zip mode:'compact' drops the prefix
Planning your own extraction sink?  → sanitize_entry_paths   (join `sanitized` under your root — never the raw name)
Checksum?                            → compute_crc32   (seed to chain chunks; expect → matches)
Raw DEFLATE payload?                 → inflate_raw     (maxOutput is mandatory; leftover = trailing bytes)
What can this server do here?        → describe_engine (limits, ceilings, caps, sandbox, cache, deflate tier, error codes)
Propose a bug / feature upstream?    → draft_governance_issue (local draft + compliance report; a human reviews & submits — governance_contract / draft_issue_workflow prompts)
```

## 3. Token-frugal responses

The read tools (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`,
`scan_zip_forward`, `sanitize_entry_paths`, `describe_engine`) and `extract_zip` accept
two optional inputs (defaults unchanged — `verbosity: 'full'`, no `fields`):

- `verbosity: 'summary'` — a compact scalar verdict that drops the arrays and payloads:
  - `inspect_zip` → `archiveBytes`, `entryCount`, `isZip64`, `compressedBytes`, `uncompressedBytes`, `encryptedCount`, `unsafeNameCount`, `duplicateNameCount`, `deterministic`, `canonicalLayout`, `diagnosticCount` (+ `checksPassed` when `check` / `assert` was given);
  - `list_zip_entries` → `entryCount`, `matchedCount`, `returnedCount`, `hasMore`, `isZip64`, `names` (this page), `diagnosticCount`;
  - `read_zip_entry` → `name`, `index`, `mode`, `sizeBytes`, `crcVerified` (+ `textLength`, `range`, `verification` when present), `diagnosticCount` — never the content;
  - `verify_zip` → `ok`, `error`, `entryCount`, `verifiedCount`, `failedCount`, `skippedCount`, `diagnosticCount`;
  - `extract_zip` → `mode`, `dryRun`, `fileCount`, `totalBytes`, `skippedCount`, `paths` (+ `outputDir`), `diagnosticCount`;
  - `scan_zip_forward` → `trust`, `entryCount`, `keptCount`, `stoppedAt`, `truncated`, `names` (kept), `error` when present, `diagnosticCount`;
  - `sanitize_entry_paths` → `count`, `rejectedCount`, `rejectedNames`;
  - `describe_engine` → `server`, `engine`, `capabilities`, `sandbox`, `network`.
- `fields: ['a', 'b.c']` — dot-path projection (an array segment maps over every element),
  applied **after** `verbosity`. Unmatched paths are omitted, and the result then carries
  `_meta.unmatchedFields` + `_meta.availableFields` so a typo is visible instead of an empty object.

Smallest "is this archive intact?" probe: `{ zipBase64, verbosity: 'summary', fields: ['ok', 'error', 'failedCount'] }` on `verify_zip`.
The output schemas of the projectable tools declare every property optional, so a projected
`structuredContent` always validates against `outputSchema`; the summary-only scalars
(`deterministic`, `diagnosticCount`, `names`, `paths`, `rejectedNames`, …) are declared there too.

Produced archives (`create_zip`, `modify_zip`, and the inflated bytes of `inflate_raw`) in
base64 mode are delivered **once** as an embedded `resource` content block
(`data:application/zip;base64,…` / `application/octet-stream` for `inflate_raw`), never
duplicated into `structuredContent` — which carries `{ mode, sizeBytes, summary, diagnostics,
diagnosticCounts }`. Read the bytes from `content.find(c => c.type === 'resource').resource.blob`.
In file mode the result carries a `resource_link` instead. `verify_zip` `entries: 'failed'` /
`'none'` and `maxEntries`, `list_zip_entries` `limit`, `scan_zip_forward` `maxEntries` and
`extract_zip` `includeData: false` bound the payload before projection.

## 4. Output modes & environment

- `outputMode: 'base64'` (default) — bytes in the embedded `resource` block (≤ 50 MiB inline; `OUTPUT_TOO_LARGE` beyond, with `outputMode: 'file'` as the remedy). `extract_zip` returns each file inline (≤ 16 MiB each, ≤ 32 MiB total).
- `outputMode: 'file'` — writes inside `ZIPNATIVE_MCP_OUTPUT_DIR`. `outputPath` (`create_zip`, `modify_zip`, `inflate_raw`, `draft_governance_issue`) must be **relative**, end in a container extension (`.zip` recommended; `.md` for the governance draft; `.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw` for `inflate_raw`), no traversal / absolute / UNC paths / NUL bytes; `outputDir` (`extract_zip`) is a relative directory created on demand. The parent's **real** path must stay inside the sandbox (a pre-planted symlinked directory is `SECURITY_VIOLATION`), files are opened exclusively (`OUTPUT_EXISTS` — the server never overwrites), archives are streamed to disk with a 4 GiB cap, and a failure removes the partial file.
- `ZIPNATIVE_MCP_OUTPUT_DIR` — the ONE filesystem boundary: `zipPath` / `sourcePath` inputs are read from it (the **real** path of the file itself must stay inside — a planted symlink / junction is `SECURITY_VIOLATION` on reads as on writes), file outputs are written under it. Unset ⇒ every path input and every file output is refused (`SECURITY_VIOLATION`) and the tools work on base64 only; the only other file I/O is the opt-in cache below.
- `ZIPNATIVE_MCP_CACHE_DIR` — opt-in SHA-256 response cache (1 h TTL, 256 MiB LRU, plaintext at rest; key namespaced by `TOOL_API_VERSION/ZIPNATIVE_MCP_VERSION/zipnative VERSION`, so an engine upgrade never serves old bytes). Never caches: `zipPath` / `sourcePath` inputs (a path is a reference, not content), `outputMode: 'file'`, `defaultDate: 'now'`, `parallel`, `describe_engine`, `draft_governance_issue`. A hit carries `_meta.cached: true` and returns the **earlier** call's result for identical inputs.
- `ZIPNATIVE_MCP_PORT` — opt-in Streamable HTTP transport on `127.0.0.1:<port>/mcp` (stdio otherwise). `POST` only; `GET` / `DELETE` → 405; foreign `Host` / `Origin` → 403 (the `Origin` port must equal the server port); bodies above 256 MiB → 413.
- `ZIPNATIVE_MCP_HTTP_TOKEN` — opt-in bearer token for the HTTP transport (≥ 16 characters, no whitespace; a weaker value aborts startup). When set, every request to `/mcp` must carry `Authorization: Bearer <token>` or is answered `401` + `WWW-Authenticate: Bearer realm="zipnative-mcp"`. Compared constant-time, never logged. Without it the HTTP endpoint has **no authentication** — any local process can reach it.
- `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` — operator ceiling for `limits.maxEntryUncompressedSize` and `limits.maxTotalUncompressedSize` (default 8 GiB = the engine default; integer ≥ 1024).
- `ZIPNATIVE_MCP_MAX_ENTRIES` — operator ceiling for `limits.maxEntries` and `scan_zip_forward` `maxEntries` (default 100000; integer ≥ 1). The scanner's default budget (10000) is clamped to the ceiling, so a call without `maxEntries` succeeds under any valid ceiling; only an explicit value above it is refused.
- `ZIPNATIVE_MCP_WORKERS` — operator ceiling for `create_zip` `parallel.workers` (default 8; `0` disables worker threads — compression stays on the calling thread). With no explicit `workers` the engine default `max(1, min(cores − 1, 8))` applies, bounded by the ceiling. The three ceilings are read **once at startup**; an invalid value refuses to start (never a silent fallback); a per-call value above a ceiling is `LIMIT_CEILING_EXCEEDED` naming the variable; a ceiling below the engine default tightens the default silently.

**Privacy / network policy:** none, ever. The server has no network code path — no
telemetry, no GitHub, no URL from any argument, no operator-configurable endpoint of any
kind (`describe_engine` reports `network: 'none'`). Archive bytes only ever flow back in the
JSON-RPC response or into the sandbox. The optional HTTP transport (`ZIPNATIVE_MCP_PORT`)
binds `127.0.0.1` only and enables DNS-rebinding protection; that guard does not stop *other
local processes* — set `ZIPNATIVE_MCP_HTTP_TOKEN` for that. Extracted files are written
verbatim — the server never executes, renders or scans them, so scan untrusted content in
the caller. Every engine diagnostic goes through a sink: nothing is ever printed to stdout on
the stdio transport.

**Protocol:** MCP 2026-07-28 (stateless, `server/discover`, `resultType`, cache hints —
`tools/list` and `prompts/list` public 24 h, `server/discover` public 1 h, `resources/*`
private 0) on the MCP TypeScript SDK v2, with automatic fallback to the legacy
`initialize` handshake on stdio and HTTP for every revision the SDK negotiates —
existing hosts need no change:

| Revision | Era | stdio | HTTP | Proven by |
|---|---|:---:|:---:|---|
| `2024-10-07` | legacy | ✓ | ✓ | `tests/protocol-revisions.test.ts` |
| `2024-11-05` | legacy | ✓ | ✓ | `tests/protocol-revisions.test.ts` |
| `2025-03-26` | legacy (batches over HTTP only) | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts` |
| `2025-06-18` | legacy | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts`, `tests/http-transport.test.ts` |
| `2025-11-25` | legacy | ✓ | ✓ | `tests/protocol-revisions.test.ts`, `tests/cli-stdio.test.ts`, `tests/http-modern.test.ts`, `tests/autonomy.test.ts` |
| `2026-07-28` | modern (`server/discover`, `_meta` envelope) | ✓ | ✓ (+ bearer token) | `tests/stdio-modern.test.ts`, `tests/http-modern.test.ts`, `tests/autonomy.test.ts` |

**Autonomy proof:** `tests/autonomy.test.ts` replays one scripted agent scenario
(S0 handshake, S1 `tools/list`, S2 `describe_engine`, S3 `create_zip` file / base64 /
parallel, S4 `verify_zip`, S5 `inspect_zip` checks, S6 `list_zip_entries`, S7
`read_zip_entry` → `inflate_raw` → `compute_crc32`, S8 `modify_zip` append then compact,
S9 `extract_zip` dry run then files, S10 `resources/*`, S11 `scan_zip_forward`, S12 hostile
refusals, S13 ceilings, S14 protocol errors, S15 `draft_governance_issue`, S16
`prompts/get`, S17 clean shutdown) against the built `dist/cli.js` on stdio legacy, stdio
modern, HTTP legacy and HTTP modern with a bearer token, under a sandbox, a cache
directory, `ZIPNATIVE_MCP_MAX_ENTRIES=5000` and `ZIPNATIVE_MCP_WORKERS=2` — no
interaction, no unexpected `isError`, a code and a remedy on every refusal, a cache hit
over the wire, JSON-only stdout, clean exit. Replay it by hand with the repository's
`.mcp.json` (docs/guides/LOCAL_TESTING.md). The stdio frame
cap is raised from the SDK's 10 MiB to 256 MiB so multi-MiB base64 archives fit. A
`tools/call` naming an unknown tool is a JSON-RPC protocol error (`-32602`,
`[UNKNOWN_TOOL] Unknown tool: …`), not an `isError` result; an unknown resource URI is
`-32602` too. Every regular file in the sandbox (archives written by `create_zip` /
`modify_zip`, files written by `extract_zip`, archives dropped in for `zipPath`) is listed as
`zipnative://output/<path>` (template `zipnative://output/{+path}`, MIME by extension, 50 MiB
read cap). Seven prompts ship as ready-made recipes: `secure_extraction`,
`reproducible_archive`, `incremental_update`, `forensic_scan`, `verify_before_trust`, plus
the governance pair `governance_contract` / `draft_issue_workflow`.

## 5. Recipes

- **Untrusted intake (the `secure_extraction` prompt):** `verify_zip` `{ verbosity: 'summary' }` → branch on `ok` and `error.code` (`ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION` are active-attack shapes: stop) → `inspect_zip` `{ check: ['safe-names', 'no-encryption', 'no-symlinks', 'no-duplicates'], assert: { maxUncompressedBytes: 268435456, maxRatio: 100 } }` → `checksPassed` → `extract_zip` `{ includeData: false }` (the plan: sanitized paths, sizes, nothing decompressed — the archive is opened eagerly first, so an overlapping / offset-into-CD / Zip64-spoofed shape is refused before any plan; a method / CRC / size divergence is what `verify_zip` caught in step 1) → `extract_zip` `{ outputMode: 'file', outputDir: 'intake/<id>' }` with the defaults. Relax `rejectTraversal` / `rejectSymlinks` / `onDuplicate` only after reading the entry list; `limits.*` widen the bounds for trusted input only. Conformance is not safety: zip-slip, device names and duplicate paths are spec-valid archives.
- **Reproducible build + proof (the `reproducible_archive` prompt):** `create_zip` `{ entries, compression: { deterministic: true }, includeSha256: true }` twice → equal `summary.sha256` (`summary.deflateTier: 'pure-pinned'`, `summary.deterministic: true`); or `inspect_zip` `{ check: ['deterministic', 'canonical-layout'] }` on the result. Three verdicts, read them where they apply: `summary.deterministic` is true **only** with `compression.deterministic: true` (cross-runtime identity) — a default call is reproducible on the same runtime (`deflateTier: 'node-zlib'`) and reports `false`; `summary.sha256` (base64 and file mode) is the proof; `inspect_zip.determinism.deterministic` is the structural verdict (epoch timestamps + canonical order + UTF-8 flags — a pinned non-epoch date reproduces but reports `false` there). Keep dates pinned (omit `defaultDate`, or one fixed ISO instant); `parallel` is byte-identical; `stream: true` entries are reproducible but `canonicalLayout: false`.
- **EPUB / JAR layout:** `create_zip` `{ order: 'insertion', entries: [{ name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } }, { name: 'META-INF/container.xml', text: '…' }, …] }` — the stored `mimetype` lands first; `inspect_zip` `{ assert: { has: ['mimetype'] } }` + `list_zip_entries` `{ limit: 1, fields: ['entries.name', 'entries.methodName'] }` proves it. `outputPath: 'book.epub'` keeps the container extension.
- **Incremental update + compact (the `incremental_update` prompt):** `modify_zip` `{ operations: [{ op: 'replace', name: 'config.json', text: '…' }, { op: 'add', name: 'CHANGELOG.md', text: '…' }] }` (append: fast, byte-preserving, old payloads still inside — `ZIP_DEAD_BYTES_RATIO` past 50 %) → when a secret must be gone or 7-Zip must read the file: `modify_zip` `{ operations: [{ op: 'remove', name: '.env' }], mode: 'compact' }`. `summary.noOp: true` means nothing changed and the same bytes came back.
- **Manifest peek without extracting:** `read_zip_entry` `{ name: 'META-INF/MANIFEST.MF', encoding: 'utf8' }` (or `package.json`, `[Content_Types].xml`, `mimetype`); the first 4 KiB of a large log: `{ name: 'logs/app.log', encoding: 'utf8', range: { offset: 0, length: 4096 } }`; a duplicate name: `list_zip_entries` `{ filter: { names: ['x'] } }` → `read_zip_entry` `{ index }`.
- **Forensic scan of a truncated download (the `forensic_scan` prompt):** `inspect_zip` fails with `ZIP_EOCD_NOT_FOUND` / `ZIP_RECORD_TRUNCATED` → `scan_zip_forward` `{ tolerateTruncation: true, verbosity: 'summary' }` → `names`, `stoppedAt: 'error'` + `error.code` (`ZIP_STREAM_TRUNCATED`), `bytesDelivered`; `data: 'verify'` checks the CRCs of what arrived. Treat every row as local-headers-only; `sanitize_entry_paths` (or the rows' `sanitizedPath`) before touching a filesystem.
- **Chain via `zipPath` without re-sending bytes:** `create_zip` `{ …, outputMode: 'file', outputPath: 'build/release.zip' }` → `modify_zip` `{ zipPath: 'build/release.zip', operations: […], outputMode: 'file', outputPath: 'build/release-v2.zip' }` → `verify_zip` `{ zipPath: 'build/release-v2.zip' }` → `extract_zip` `{ zipPath: 'build/release-v2.zip', outputMode: 'file', outputDir: 'staging' }` — all inside `ZIPNATIVE_MCP_OUTPUT_DIR`; the files are also `zipnative://output/build/…` resources (`resources/list`, `resources/read`).
- **CI gate with `inspect_zip` check / assert:** `inspect_zip` `{ zipPath: 'dist/app.zip', check: ['deterministic', 'canonical-layout', 'no-encryption', 'no-symlinks', 'safe-names', 'no-duplicates', 'no-zip64', 'deflate-only'], assert: { maxEntries: 5000, maxUncompressedBytes: 1073741824, maxRatio: 100, has: ['manifest.json'] }, verbosity: 'summary', fields: ['checksPassed', 'checks'] }` → fail the pipeline on `checksPassed: false` (each `checks[]` row carries `check`, `ok`, `detail`); `strict: true` additionally fails on any diagnostic (`ZIP_STRICT_DIAGNOSTIC`).
- **Raw payload → `inflate_raw`:** `read_zip_entry` `{ name: 'big.bin', mode: 'raw' }` → `structuredContent.dataBase64` (the compressed payload; `entry.methodName` must be `deflate` — a stored entry's raw payload is already the plain bytes) → `inflate_raw` `{ dataBase64, maxOutput: <entry.uncompressedSize> }` → `summary.bytesOut`, `bytesConsumed`, `leftover`; `compute_crc32` on the result with `expect: entry.crc32` cross-checks it.
- **Propose an upstream change:** `draft_governance_issue` `{ title, summary, issueType, targetRepo: 'zipnative' | 'zipnative-mcp', reproduction: { command, result }, expectedBehavior, duplicateSearchPerformed: true }` → present `draftMarkdown` + `compliance` to the user → a **human** submits it (the server never does).

## 6. Error reference

Branch on `_meta.error.code` (also the `[CODE]` in `content[0].text`), never on the message.
Wrapper codes come from the server's own boundary; the 39 `ZIP_*` codes are zipnative's frozen
vocabulary passed through verbatim, with `data.errorClass` (the coarse class), `data.engineError`
(the engine class name), `data.entryName`, `limit` / `configured` / `observed`, `feature`,
`expectedCrc` / `actualCrc` and, from `modify_zip`, `operationIndex` / `op` when known.
`verify_zip` never raises a `ZIP_*` code for the archive — it lands in `error.code`; the same
holds for `scan_zip_forward` under `tolerateTruncation: true`.

`data.remedy` (optional string) is the machine-actionable hint some wrapper refusals carry
next to the prose remedy in `message`, drawn from a closed vocabulary: `outputMode:'file'`
(`extract_zip` above the inline caps), `range` (`read_zip_entry` above the 16 MiB cap),
`filter`, `encoding:'base64'`, `data:'verify'` (`scan_zip_forward` `data: 'include'` above the
caps), `list_zip_entries` (an out-of-range `index`), `resources/list` (a missing `zipPath` /
`sourcePath`), `zipPath` (an inline payload above the 128 MiB cap — route the bytes through a
sandbox file), `maxEntries ≤ N` (`scan_zip_forward` above the ceiling). Absent when no
single input change lifts the refusal. Branch on `code` first; `remedy` only refines the
retry.

| `code` | Meaning | Fix |
|--------|---------|-----|
| `VALIDATION_ERROR` | Zod rejected the input: wrong type / bound / enum, an **unknown or misspelt key** (top-level or nested — schemas are strict), both or neither of `zipBase64` / `zipPath` (or `name` / `index`, `dataBase64` / `text` / `sourcePath`), an empty or non-base64 payload (a `data:` prefix is tolerated, base64-twice is not), a `range` outside `mode: 'data'`, `encoding: 'utf8'` with `mode: 'raw'`, `stream: true` without `sourcePath`, a duplicate name in `create_zip.entries`, a date outside 1980–2107 or not ISO-8601 (`pattern`), a `unixMode` that is not 3–4 octal digits (`pattern`, no surrounding whitespace), `unixMode` together with `externalAttributes`, an extra field with id `0x0001`, a `/`-terminated name carrying a payload (`create_zip` and `modify_zip` add / replace), a `compute_crc32` `expect` that is not 1–8 hex digits with an optional `0x`, an `inflate_raw` `method` that is not `deflate` / `store` / a number (`pattern`) | Re-read the field schema (the message names the path); pass exactly one input form; raw bytes as base64 once. |
| `INPUT_TOO_LARGE` | A decoded `zipBase64` / `dataBase64` or the sum of inline payloads exceeds 128 MiB, or a `zipPath` / `sourcePath` file exceeds 1 GiB (buffered tools) | Use `zipPath` / `sourcePath` in the sandbox for large archives (`data.remedy: 'zipPath'` on an inline payload); split the payload; `scan_zip_forward` streams a `zipPath` without the 1 GiB cap. |
| `INPUT_NOT_FOUND` | `zipPath` / `sourcePath` does not exist in the sandbox (a dangling link too) or is not a regular file | Check the relative path (`resources/list` shows the sandbox contents; `data.remedy: 'resources/list'`); drop the file into `ZIPNATIVE_MCP_OUTPUT_DIR`. |
| `ENTRY_TOO_LARGE` | An entry above the 16 MiB inline cap: `read_zip_entry` (uncompressed in `mode: 'data'`, or compressed in `mode: 'raw'`), `extract_zip` base64 mode, `scan_zip_forward` `data: 'include'` | `read_zip_entry` `mode: 'data'` with a `range` (`data.remedy: 'range'`) — a raw payload above the cap is not retrievable inline; the range and `extract_zip` `outputMode: 'file'` (`data.remedy: "outputMode:'file'"`) yield the *decompressed* content; `extract_zip` a `filter`; `scan_zip_forward` `data: 'verify'` (`data.remedy: "data:'verify'"`). |
| `ENTRY_NOT_UTF8` | `encoding: 'utf8'` on content that is not valid UTF-8 | Read it with `encoding: 'base64'`. |
| `OUTPUT_TOO_LARGE` | An inline archive / inflated result above 50 MiB, an inline extraction above 32 MiB total, a file output above 4 GiB (enforced while streaming), a resource above the 50 MiB read cap, a governance draft above 50 MiB | `outputMode: 'file'` with `ZIPNATIVE_MCP_OUTPUT_DIR` set; a `filter` or `includeData: false` for extraction. |
| `OUTPUT_EXISTS` | The target file already exists in the sandbox — the server never overwrites | Choose another `outputPath` / `outputDir`, or remove the file yourself. |
| `IO_ERROR` | A filesystem write failed (permissions, disk full, …); the message carries the errno, never an absolute path | Fix the sandbox directory; the partial file was removed. |
| `SECURITY_VIOLATION` | File I/O requested with `ZIPNATIVE_MCP_OUTPUT_DIR` unset; a path with a NUL byte; an absolute / drive / UNC path; a path escaping the sandbox (`..`); a parent directory whose **real** path lies outside the sandbox on a write, or a file (`zipPath`, `sourcePath`, `resources/read`) whose **real** path lies outside it on a read (a planted symlink or junction); a `resources/read` path escaping it | Set `ZIPNATIVE_MCP_OUTPUT_DIR`; pass relative paths only; remove the link. |
| `MISSING_OUTPUT_PATH` | `outputMode: 'file'` without `outputPath` (`create_zip`, `modify_zip`, `inflate_raw`, `draft_governance_issue`) or without `outputDir` (`extract_zip`) | Pass a relative `outputPath` / `outputDir`. |
| `INVALID_PATH` | `outputPath` / `outputDir` / `zipPath` / `sourcePath` empty or not a string | Pass a non-empty relative path. |
| `INVALID_EXTENSION` | `outputPath` / `zipPath` does not end in a container extension (`.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix .nupkg .whl .apk .ipa .xpi .crx .kmz`); `.md` for `draft_governance_issue`; the `inflate_raw` allow-list for its file output | Fix the extension (`sourcePath` and extracted files are not subject to it). |
| `LIMIT_CEILING_EXCEEDED` | A `limits.maxEntryUncompressedSize` / `limits.maxTotalUncompressedSize` above `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, a `limits.maxEntries` or an **explicit** `scan_zip_forward` `maxEntries` above `ZIPNATIVE_MCP_MAX_ENTRIES` (the scanner's default is clamped, never refused), or `parallel.workers` above `ZIPNATIVE_MCP_WORKERS` (`data.env` names the variable; `data.remedy: 'maxEntries ≤ N'` for the scanner) | Lower the value (or omit it), or the operator raises the ceiling in the server environment for trusted input only. |
| `UNKNOWN_RESOURCE` | `resources/read` with a URI outside `zipnative://output/`, an empty path, or a file that does not exist — surfaced as JSON-RPC error **`-32602`** (Invalid params), the code is carried in the message | List URIs with `resources/list`. |
| `GOVERNANCE_VIOLATION` | `draft_governance_issue` draft breaks the AI-governance contract (proposes a runtime dependency, has no reproduction code block, or `duplicateSearchPerformed: false`) | Remove the dependency proposal, include the reproduction, confirm the duplicate search. |
| `ENGINE_ERROR` | The engine threw something that is neither a `ZipError` nor a mapped zlib error (a bug — `data.errorClass: 'internal'`) | Report it with a reproduction via `draft_governance_issue`. |
| `[UNKNOWN_TOOL]` | **Protocol error, not a tool result:** `tools/call` named a tool that does not exist — JSON-RPC error **`-32602`** with message `[UNKNOWN_TOOL] Unknown tool: <name>` (MCP classifies unknown tools as protocol errors; `isError: true` is reserved for execution failures) | List tools with `tools/list`; names are lower-snake-case. |
| `ZIP_INVALID_OPTION` | An option value fails validation: compression.level outside 0-9, a non-positive chunkSize, or an argument shape the API forbids (class `usage`). Raised by: `create_zip`, `modify_zip`, `inflate_raw` — the wrapper's own validation catches the known shapes first as `VALIDATION_ERROR` (a `/`-terminated name carrying a payload on add / replace is the engine's own example of this code) | Fix the option value at the call site — the message names the offending option and the accepted range. |
| `ZIP_INPUT_TOO_LARGE` | The pure-TS deflate encoder received more than 2 GiB of input in one call (class `limit`; unreachable below the 1 GiB `sourcePath` cap). Raised by: `create_zip`, `modify_zip` with `compression.deterministic: true` | Split the input, or stream it entry by entry. |
| `ZIP_ENTRY_NOT_FOUND` | A named entry does not exist where one is required, or an `index` is out of range (class `not-found`). Raised by: `read_zip_entry`, `modify_zip` (replace / remove / rename) | Names are case-sensitive — call `list_zip_entries` for the exact names. |
| `ZIP_ENTRY_EXISTS` | A named entry already exists where absence is required (`add` over an existing name; `rename` onto an existing name) (class `input`). Raised by: `modify_zip` | Use `replace` to overwrite, or `remove` the target first — renames never overwrite implicitly. |
| `ZIP_API_MISUSE` | A usage contract was violated inside the engine (drain-order violations in forward iteration, single-shot reuse, push after finish) — a wrapper bug (class `internal`). Raised by: `create_zip`, `scan_zip_forward`, `inflate_raw` | The message names the contract; report it with a reproduction. |
| `ZIP_STRICT_DIAGNOSTIC` | `strict: true` escalated the first conformance diagnostic of the operation into a thrown error (class `check`). Raised by: every tool taking `strict` (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `create_zip`, `modify_zip`) | The message embeds the underlying diagnostic code; handle the archive shape it names, or drop `strict` and read `diagnostics[]`. |
| `ZIP_INTERNAL` | An internal invariant broke — this is a zipnative bug, not an input problem (class `internal`). Raised by: any tool | Report it with a reproduction archive via `draft_governance_issue` (`targetRepo: 'zipnative'`). |
| `ZIP_EOCD_NOT_FOUND` | The input is smaller than 22 bytes, no end-of-central-directory record exists in the trailing scan window, or no candidate is self-consistent (trailing garbage / hostile ambiguity — zipnative refuses to guess) (class `parse`). Raised by: every random-access tool (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip`, `modify_zip`; `verify_zip` → `error`) | The bytes are not a ZIP archive, are truncated, or carry trailing bytes — verify the source, or remove the trailing bytes if the archive is trusted; `scan_zip_forward` still lists what is there. |
| `ZIP_EOCD_INCONSISTENT` | The end-of-central-directory record contradicts the archive layout: entries-on-disk differs from the total, or the central directory overlaps the record itself (class `parse`). Raised by: the random-access tools | The archive is corrupt or hostile — re-obtain it from the source. |
| `ZIP_ZIP64_LOCATOR_MISSING` | A zip64 sentinel is set but the zip64 end-of-central-directory locator is absent (class `parse`). Raised by: the random-access tools | The archive is truncated or corrupt — re-obtain it. |
| `ZIP_ZIP64_EOCD_MISPLACED` | The zip64 end-of-central-directory record is not where the locator points (and not at the fallback position) (class `parse`). Raised by: the random-access tools | Corrupt archive, or an unsupported prepended-data layout — rebuild the archive without the prefix. |
| `ZIP_CD_INCONSISTENT` | The central-directory walk contradicts the declared counts or size: it ends early, a record extends past the declared size, or bytes remain beyond the declared entries (class `parse`). Raised by: the random-access tools | The archive is corrupt or hostile — re-obtain it from the source. |
| `ZIP_RECORD_TRUNCATED` | A fixed or variable-length ZIP record (EOCD, zip64 EOCD, central or local header) or an entry's payload overruns the available bytes (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | The archive is truncated — verify the transfer completed; `scan_zip_forward` `tolerateTruncation: true` recovers the partial inventory. |
| `ZIP_SIGNATURE_MISMATCH` | An expected PK signature is absent: no local file header at the offset the central directory declares, no EOCD signature at the resolved offset, or a forward stream that does not start with a local header (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | The archive is corrupt or the bytes are not a ZIP stream. |
| `ZIP_STREAM_TRUNCATED` | A forward byte stream ended mid-record or mid-entry (class `parse`). Raised by: `scan_zip_forward` (in `error` under `tolerateTruncation: true`) | The stream was cut — verify the producer sent the complete archive. |
| `ZIP_VALUE_UNREPRESENTABLE` | A 64-bit field exceeds Number.MAX_SAFE_INTEGER (2^53 - 1) (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | Archives this large are not supported — the public API uses number, not bigint. |
| `ZIP_INVALID_ENTRY_NAME` | A writer-side entry name violates the name rules: empty, NUL bytes, backslashes, absolute paths, '..' segments or a reserved device name (zipnative never writes traversal-capable archives) (class `input`). Raised by: `create_zip`, `modify_zip` (add / rename) | Use relative, forward-slash paths without traversal segments; check names with `sanitize_entry_paths`. |
| `ZIP_DUPLICATE_ENTRY_NAME` | Duplicate entry names where uniqueness is required: adding over an existing name, or opening a duplicate-name archive for modification (class `input`). Raised by: `modify_zip` (`create_zip` catches duplicates as `VALIDATION_ERROR`) | Every archive path must be unique; for duplicate-name source archives, extract and rebuild with `create_zip`. |
| `ZIP_DEFLATE_TRUNCATED` | A deflate stream ends mid-block: the data ran out before the final block completed (also a zlib `Z_BUF_ERROR` on the sync path) (class `parse`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include), `inflate_raw` | The compressed payload is truncated — re-obtain the archive. |
| `ZIP_DEFLATE_CORRUPT` | A deflate stream is structurally invalid: bad Huffman codes, invalid symbols, out-of-range back-references, LEN/NLEN mismatches, or an unsupported block type (also a zlib `Z_DATA_ERROR`) (class `parse`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `inflate_raw` | The compressed payload is corrupt — re-obtain the archive. |
| `ZIP_ENTRY_OVERLAP` | Two entries share bytes: duplicate local-header offsets, an entry extending into another, or an entry claiming to start inside the central directory (class `security`, CWE-405). Raised by: `inspect_zip` (eager), `list_zip_entries` (eager), `read_zip_entry`, `extract_zip`, `modify_zip` (`verify_zip` → `error`) | Overlapping-entry archives are a decompression-bomb/smuggling shape and are always rejected — there is no opt-out. |
| `ZIP_CD_LFH_MISMATCH` | A local file header contradicts the central directory on the compression method (class `security`, CWE-436). Raised by: `inspect_zip`, `read_zip_entry`, `extract_zip`, `modify_zip` (`verify_zip` → `error` / row) | Parser-differential archives are rejected — rebuild the archive with a sane tool. |
| `ZIP_ZIP64_CONTRADICTION` | A zip64 value contradicts a non-sentinel classic field (zip64 may only REPLACE sentinel fields) (class `security`, CWE-1288). Raised by: the random-access tools | Parser-differential archives are rejected — rebuild the archive. |
| `ZIP_PATH_TRAVERSAL` | An entry name cannot be made safe: it escapes the extraction root (zip-slip — '..' segments, absolute paths, drive letters, UNC prefixes, backslash tricks, NTFS alternate data streams) or is a Windows reserved device name (CON, NUL, COM1..LPT9) (class `security`, CWE-22 / CWE-67). Raised by: `extract_zip` | The archive is hostile, corrupt, or POSIX-authored with device-name files; pass `rejectTraversal: false` to silently skip such entries instead (they are never emitted — read `skipped`). |
| `ZIP_SYMLINK_REJECTED` | An entry is a Unix symlink and `rejectSymlinks` is on (the default) (class `security`, CWE-59). Raised by: `extract_zip` | Pass `rejectSymlinks: false` to receive the link target as ordinary data (never materialized as a link). |
| `ZIP_EXTRACT_DUPLICATE_PATH` | Two entries resolve to the same output path under `onDuplicate: 'error'` (the default) (class `security`, CWE-694). Raised by: `extract_zip` | Pass `onDuplicate: 'first'` or `'last'` to resolve the shadowing deliberately. |
| `ZIP_CRC_MISMATCH` | Decompressed bytes fail the declared CRC-32 (central directory, local header, or data descriptor) (class `data`; `data.expectedCrc` / `actualCrc`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include); `verify_zip` reports it as a row | The data is corrupt; `read_zip_entry` `verifyCrc: false` only if you accept corrupt output. |
| `ZIP_SIZE_MISMATCH` | Sizes contradict: the decompressed size differs from the declared size, or local-header sizes/CRC contradict the central directory (class `data`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`; `verify_zip` reports it as a row | The archive metadata lies — treat the archive as corrupt or hostile. |
| `ZIP_INFLATE_OUTPUT_OVERFLOW` | Inflate produced more output than the declared or permitted bound (class `data`). Raised by: `inflate_raw` (past `maxOutput`, also for `method: 'store'`), `read_zip_entry`, `extract_zip`, `scan_zip_forward` | The archive metadata lies about this entry, or raise `maxOutput` / the relevant limit if the data is trusted. |
| `ZIP_DESCRIPTOR_MISMATCH` | No data-descriptor form (signed/signless × 32/64-bit) matches the measured CRC and sizes of a bit-3 entry (class `data`). Raised by: `scan_zip_forward` | The stream is corrupt or hostile — use the random-access tools on the complete archive for the authoritative view. |
| `ZIP_DECOMPRESSION_FAILED` | The active codec failed mid-decompression (corrupt payload surfaced through node:zlib or DecompressionStream) (class `data`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` | The data is corrupt or hostile — the wrapped detail is in the message. |
| `ZIP_LIMIT_EXCEEDED` | A configured security bound from ZipLimits was exceeded (class `limit`, CWE-400 / CWE-409; `data.limit`, `configured`, `observed`). Raised by: every tool taking `limits` (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `create_zip`, `modify_zip`; `verify_zip` → `error`) | Raise `limits.<limit>` explicitly if this archive is trusted — the message names the key and both values; the operator ceilings still apply. |
| `ZIP_LIMIT_INVALID` | The limits override itself is invalid: an unknown key, or a non-positive/NaN value (class `usage`; normally caught earlier as `VALIDATION_ERROR`). Raised by: `verify_zip` and the other `limits`-taking tools | Fix the limits object at the call site — valid keys are listed in the message. |
| `ZIP_UNSUPPORTED_ENCRYPTION` | An entry is encrypted (ZipCrypto or strong encryption) — encryption is unsupported in 1.x by policy (class `unsupported`; `data.feature`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include); `verify_zip` reports `skipped: 'encrypted'` | Check `isEncrypted` (`list_zip_entries`) to route around such entries with a `filter`; there is no password input; encrypted entries remain copyable by `modify_zip` without decompression. |
| `ZIP_UNSUPPORTED_METHOD` | An entry uses a compression method with no registered codec (only 0 store and 8 deflate exist in this server) (class `unsupported`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `inflate_raw` (numeric `method`) | Re-save the archive with store/deflate using another tool, or `filter` the entry out. |
| `ZIP_UNSUPPORTED_MULTI_DISK` | The archive is multi-disk/spanned (EOCD disk fields, zip64 locator disk count, or an entry starting on another disk) (class `unsupported`). Raised by: the random-access tools | Multi-disk archives are an explicit anti-goal — rebuild as a single archive. |
| `ZIP_UNSUPPORTED_ZIP64_STREAMING` | An `addStream()` entry exceeds 4 GiB (Zip64 streaming is not implemented yet; the `stream: true` path is the one `sourcePath` input without the 1 GiB buffered cap, so this is reachable) (class `unsupported`). Raised by: `create_zip` (`stream: true`) | Drop `stream: true` for that entry (buffered entries are fully Zip64) or split it. |
| `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR` | Forward reading met a data-descriptor (bit 3) entry whose payload cannot be delimited without the central directory: store+bit3, encrypted+bit3, or a custom codec (class `unsupported`). Raised by: `scan_zip_forward` | Use `list_zip_entries` / `read_zip_entry` / `extract_zip` on the complete archive instead. |
| `ZIP_UNSUPPORTED_CODEC_MODE` | A registered codec supports only the other access mode (stream-only via a buffered read, or no streaming decompressor via a stream read) (class `unsupported`; unreachable with the built-in codecs). Raised by: `inflate_raw`, `read_zip_entry` | The message names the compliant call; with the built-in codecs this cannot occur. |

Diagnostics are informational: they never fail a call (unless `strict: true`) and arrive in
every result's `diagnostics[]` as `{ code, severity, message, entryName? }`, de-duplicated by
(code, entryName), with `diagnosticCounts` per code and `diagnosticsTruncated` past 200 rows.

| `code` | Severity | Raised by | Meaning | Fix |
|--------|----------|-----------|---------|-----|
| `ZIP_PREPENDED_DATA` | info | every random-access tool (`inspect_zip` also sets `prependedData`) | Bytes precede the archive (self-extractor stub or concatenation); all offsets were shifted accordingly. | Verify the prefix is expected for this file; `modify_zip` mode `'compact'` drops it. |
| `ZIP_MULTIPLE_EOCD` | info | every random-access tool (`inspect_zip` also sets `multipleEocd`) | More than one end-of-central-directory signature exists; the last self-consistent candidate was used. | Expected for archives whose comment embeds the signature, an append-mode `modify_zip` output or a nested zip; otherwise inspect the file. |
| `ZIP_NAME_MISMATCH` | warning | read paths only: `read_zip_entry`, `extract_zip`, `verify_zip`, `modify_zip` (`list_zip_entries` / `inspect_zip` never compare local-header names) | A local header's filename bytes differ from the central directory's; the central directory wins. | Rebuild the archive with a sane tool if the divergence is unexpected. |
| `ZIP_UNICODE_PATH_CONFLICT` | warning | every random-access tool | The 0x7075 Unicode Path extra field disagrees with the header name; the header name wins (0x7075 is never acted on). | None needed — informational about the producer's inconsistency. |
| `ZIP_INVALID_UTF8_NAME` | warning | every random-access tool and `scan_zip_forward` | Flag bit 11 claims UTF-8 but the name bytes are invalid UTF-8; decoded as CP437 instead. | The producer lied about the encoding — verify names look right (`rawNameHex` keeps the bytes). |
| `ZIP_DUPLICATE_NAME` | warning | name-keyed lookups: `read_zip_entry` by `name`, `verify_zip` (`inspect_zip` counts `duplicateNameCount`; `check: ['no-duplicates']` is the reliable gate) | The central directory holds duplicate entry names; a name lookup returns the last. | `list_zip_entries` shows every duplicate; pick one by `index`; `extract_zip` under `onDuplicate: 'error'` refuses. |
| `ZIP_EXTRA_FIELD_MALFORMED` | warning | every random-access tool | An extra field overruns its declared length and was skipped. | None needed — the malformed field is ignored, the rest is parsed. |
| `ZIP_ZIP64_EXTRA_IGNORED` | warning | every random-access tool | A zip64 extra supplied a value for a non-sentinel classic field; the header value wins. | Producer inconsistency — rebuild if unexpected. |
| `ZIP_TIMESTAMP_NOT_PINNED` | info | `create_zip`, `modify_zip` with `defaultDate: 'now'` | `defaultDate: 'now'` makes the output non-reproducible (`summary.deterministic: false`). | Pin an ISO instant (or accept the DOS-epoch default) for deterministic bytes. |
| `ZIP_NONDETERMINISTIC_CODEC` | info | `create_zip` with a pinned `defaultDate` on the `node-zlib` tier without `compression.deterministic: true` | Timestamps are pinned but a platform codec is in use — bytes are stable per environment, not across zlib builds. | Pass `compression: { deterministic: true }` to pin the pure-TS encoder for cross-runtime identical bytes. |
| `ZIP_DEAD_BYTES_RATIO` | info | `modify_zip` mode `'append'` | An incremental save() left more than 50% dead bytes; removed/replaced content remains recoverable in the file. | Use mode `'compact'` for true deletion and a canonical layout. |

## 7. Contributing to this repo

- Conventions and architecture: [CLAUDE.md](CLAUDE.md), [.github/copilot-instructions.md](.github/copilot-instructions.md)
  and the scoped rules under [.github/instructions/](.github/instructions/).
- Strict TypeScript (no `any`); validate every tool input at the boundary with Zod
  (`strictObject`), keeping the hand-written JSON Schema and the Zod schema aligned. ESM,
  `.js` suffixes on relative imports, 4-space indent, single quotes, trailing commas.
- Faithful thin wrapper: no ZIP parsing in `src/` — every ZIP decision is the engine's, every
  `ZIP_*` code passes through verbatim (`src/zip-errors.ts` is the only reader of `err.code`).
  The only sanctioned raw parsers are `scripts/verazip-core.mjs` (the engine-independent
  validator, which must never import zipnative) and the hostile-fixture builder under
  `tests/_fixtures/`.
- Never read or write outside `ZIPNATIVE_MCP_OUTPUT_DIR`; never add a network path (there is
  none); never weaken an engine security default silently — a relaxation is a named input; the
  operator ceilings are read once at boot and an invalid value refuses to start.
- Never echo `ZIPNATIVE_MCP_HTTP_TOKEN` in errors or logs; nothing may reach stdout on the
  stdio transport (every engine call goes through a diagnostic sink).
- veraZIP gate — `npm run validate:zip` (blocking): builds the server, writes the corpus
  through the real `tools/call` handler and the raw builder (38 archives: the
  conformant set, including hostile-but-conformant archives `extract_zip` must refuse, plus 4
  raw-crafted negative canaries; 22 check ids), and validates every file against ISO/IEC
  21320-1:2015 with the engine-independent validator. Level 1 re-tests with the foreign
  integrity tools present (`unzip`, `7z`, `python -m zipfile`, `tar`, `jar`) and skips the
  absent ones visibly; `VERAZIP_REQUIRED=1` fails closed as CI does. Run it for any change
  touching what the tools write. Every archive a test produces through a tool must pass
  `assertValidZip` (ISO conformance included).
- Catalogue parity: `tools/list` wording (descriptions, `_meta.examples`, instructions,
  prompt texts) may change freely; any structural change must be a deliberate refresh of
  `tests/_fixtures/tool-shape.json` (`npm run build && node scripts/tool-shape.mjs --write`)
  reviewed against the frozen baseline `tests/_fixtures/tool-shape.v1.0.0.json` (never
  regenerate that file): no tool, property or enum value removed, no new `required`, no
  tighter bound.
- Docs are contracts: the counts and names quoted here, in `README.md`, `llms.txt`,
  `CLAUDE.md`, `package.json`, `server.json` and `CITATION.cff` are checked by
  `tests/docs-consistency.test.ts` (it also refuses any line that routes an SFX /
  self-extracting prefix to `scan_zip_forward` without saying the tool refuses it, pins the
  77-export ledger of `docs/KNOWLEDGE_BASE.md` §8 to `docs/data/core-exports.json` with its
  62 / 9 / 6 reach counts and `UNEXPOSED_EXPORTS` ⊆ the unexposed rows, pins the veraZIP
  corpus counts quoted in the docs to `docs/data/verazip.json`, requires the cache clause on
  every "no I/O outside the sandbox" statement in README / SECURITY.md / `docs/guides/SECURITY.md`,
  and asserts every `docs/**/*.md`, `docs/data/*.json`, workflow, `src/**/*.ts` and
  `scripts/**/*.{mjs,mts}` file is named in the README project-structure block);
  `examples/*.json` are executed by `tests/examples.test.ts`.
- `npm run lint` runs `eslint src --max-warnings 0`: warnings fail the gate.
- Quality gate (all PRs):

  ```
  npm run typecheck:all && npm run lint && npm run test && npm run test:coverage && npm run build && npm run validate:zip
  ```

- Releases: `release-notes/vX.Y.Z.md` is mandatory (no emojis) and mirrored into
  `CHANGELOG.md`; `package.json`, `server.json`, `src/version.ts` and `CITATION.cff` move in
  lock-step; publish is via GitHub Actions Trusted Publishing (OIDC) — no `NPM_TOKEN`.
