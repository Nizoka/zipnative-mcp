# Agent contract — zipnative-mcp

The consumer contract for AI agents **using** the server (Copilot, Claude, Cursor,
Cline, …): the tool catalogue, the decision tree, token-frugal responses, output modes
and operator environment, recipes, and the error reference. Section numbers §1–§7 are
stable anchors — tests, prompts and other documents cite them.

Agents **contributing** to this repository read [AGENTS.md](../AGENTS.md) instead.

Verified on 2026-10-18 against zipnative-mcp 1.1.0 and zipnative 1.1.0.

The server also returns the §2 decision tree in the `instructions` field of the opening
exchange (initialize / server/discover result). Deeper references:
[AI_GUIDE.md](AI_GUIDE.md) (pitfalls + recipes),
[guides/CONFORMANCE.md](guides/CONFORMANCE.md) (the veraZIP gate),
[guides/DETERMINISM.md](guides/DETERMINISM.md) (what to pin for identical bytes),
[guides/INCREMENTAL.md](guides/INCREMENTAL.md) (append, compact, remanence),
[guides/SECURITY.md](guides/SECURITY.md) (the threat model),
[KNOWLEDGE_BASE.md](KNOWLEDGE_BASE.md) (architecture and the export ledger),
[API_STABILITY.md](API_STABILITY.md) (versioning charter),
[data/errors.json](data/errors.json) (the frozen error registry). Worked invocations live
under [examples/](../examples/).

---

## 1. Tool catalogue (15 tools)

Registration order, five groups: read and inspect (4), extract and forensics (3), write
and modify (4), primitives (2), meta (2).

| # | Tool | Use it for | Read-only |
|---|------|-----------|:---:|
| 1 | `inspect_zip` | ONE-call archive report: sizes, entry / file / directory counts, Zip64, comment (+ `commentHex`), compressed vs uncompressed totals, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date range, `prependedData` / `multipleEocd`, a `determinism` verdict (`deterministic` = epoch timestamps + canonical order + UTF-8 flags, the 1.0.0 formula; `canonicalLayout` = no data descriptors; sub-checks taken from the engine's `analyzeDeterminism()`) and every diagnostic. `validate` 'eager' (default — every entry's real extent checked up front: overlapping entries, entries reaching into the central directory or past EOF and Zip64 spoofing are refused with their `ZIP_*` code; a method / CRC / size divergence between central and local headers is caught by `verify_zip` and on read, not here) / 'lazy'. `check: […]` (18 named assertions, among them `canonical-form` = the engine's canonical form, `canonical-extras`, `canonical-version-made-by`) and `assert: {maxEntries, minEntries, maxUncompressedBytes, maxRatio, has, method}` → `checks[]` + `checksPassed`. `determinismReport: true` adds the engine's full `analyzeDeterminism()` report (canonical form + offending entries); `canonicalDate` verifies an archive canonicalised with a pinned date. `access`⁷, `strict`, `limits`², projection⁴. | ✓ |
| 2 | `list_zip_entries` | Paged central-directory inventory, nothing decompressed: every entry (duplicates included) in directory order as a full row (name + `nameEncoding`, sizes, `ratio`, `crc32`, `method` / `methodName`, `lastModified`, decoded `flags`, `unixMode`, `isSymlink`, `usesZip64`, `usesDataDescriptor`, `hostSystem`, `localHeaderOffset`, named `extraFields`, `sanitizedPath` (null = unsafe name), `comment`, `rawNameHex`). `filter`³, `offset` + `limit` (default 200, max 2000, `hasMore`), `includeExtraData`, `includeExtendedTimestamps` (UT, then NTFS, then DOS; ISO-8601 UTC), `includeUnixIds` (Info-ZIP uid / gid), `validate` 'lazy' (default) / 'eager', `access`⁷, `strict`, `limits`², projection⁴ (summary → names only). | ✓ |
| 3 | `read_zip_entry` | ONE entry by `name` (exact, case-sensitive; the LAST duplicate wins) or `index` (disambiguates duplicates). `mode` 'data' (default): decompressed content as `dataBase64` or `text` (`encoding: 'utf8'` → `ENTRY_NOT_UTF8` otherwise), CRC-verified (`verifyCrc`); `range: {offset, length}` reads a byte window through the chunked stream (bounded memory, no CRC, length ≤ 16 MiB); 'raw': the compressed payload verbatim (→ `inflate_raw`); 'verify': `verification: {ok, crcMatch, sizeMatch, localHeaderMatch, skipped?}` only. Inline cap 16 MiB (`ENTRY_TOO_LARGE`). `includeExtendedTimestamps`, `includeUnixIds`, `access`⁷, `strict`, `limits`², projection⁴. | ✓ |
| 4 | `verify_zip` | Deep verification in one call — zipnative's `verifyZip` report verbatim: `ok`, `error` {code, message} for a structural refusal, `entryCount` / `verifiedCount` / `failedCount` / `skippedCount`, per-entry rows (`crcMatch`, `sizeMatch`, `localHeaderMatch`, `skipped` 'encrypted' / 'stream-only-codec' / 'unsupported-method'). A design-time skip ('encrypted', 'stream-only-codec') whose local header agrees with the central directory counts as skipped; an 'unsupported-method' entry (anything but 0 store / 8 deflate) and an encrypted entry whose local header contradicts the central directory are FAILED — the engine's verdict verbatim. NEVER `isError` for an archive problem. `entries` 'all' (default) / 'failed' / 'skipped' / 'none', `maxEntries` (default 1000, `entriesTruncated`), `limits`², projection⁴. | ✓ |
| 5 | `extract_zip` | Secure-by-default extraction. `rejectTraversal` (default true → `ZIP_PATH_TRAVERSAL`; false SKIPS unsafe names into `skipped`, never emits them), `rejectSymlinks` (default true → `ZIP_SYMLINK_REJECTED`; false writes the target TEXT as data), `onDuplicate` 'error' (default) / 'first' / 'last', `limits`², overlaps and central/local divergence always refused. The archive is opened EAGERLY before any plan in both modes: the dry run refuses an overlapping, offset-into-CD / past-EOF or Zip64-spoofed archive with its `ZIP_*` code before a single plan row (a file-mode extraction fails before its first write); a central/local divergence of method, CRC or sizes is detected on read — `verify_zip` `localHeaderMatch` is the one-call gate. `filter`³. `outputMode` 'base64' (default): rows with `path` (sanitized), `entryName`, `index`, `sizeBytes`, `crc32`, `method`, `dataBase64` (≤ 16 MiB each, ≤ 32 MiB total; `includeData: false` = dry run of the plan, `dryRun: true`); 'file': streams under a relative `outputDir` inside `ZIPNATIVE_MCP_OUTPUT_DIR` (never overwrites; the total is bounded by the file-output cap, default 4 GiB), `filePath` per row + up to 50 `resource_link`s, `emptyDirectories`. `strict`, projection⁴. | |
| 6 | `scan_zip_forward` | Walk LOCAL headers in stream order with bounded memory (`iterateZipEntries`) — the only tool that works on a truncated download or a cut / unseekable stream that starts at a local header, and the only one whose result is NOT authoritative (`trust: 'local-headers-only'`; `isSymlink` / `usesZip64` / `unixMode` are null). It cannot skip an SFX / prepended prefix and refuses one (`ZIP_SIGNATURE_MISMATCH`) — `inspect_zip` handles it (`prependedData`, `ZIP_PREPENDED_DATA`), `modify_zip mode: 'compact'` drops it. `data` 'none' (default; a bit-3 entry still costs a decompress-and-discard) / 'verify' / 'include' (inline caps), `filter`³, `maxEntries` (default 10000, clamped to the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling; an explicit value above it → `LIMIT_CEILING_EXCEEDED`), `tolerateTruncation: true` → partial inventory + `error` {code, message} + `stoppedAt: 'error'`. `stoppedAt` 'central-directory' (a central directory was met, the rest left unread) / 'eof' (whole stream consumed, none met — truncated or CD-less) / 'max-entries' (more headers remained; an archive with exactly `maxEntries` entries ends at 'central-directory') / 'error', `truncated`, `inputBytes`, `bytesDelivered`, `maxEntries` (the budget in force). `strict`, `limits`², projection⁴. | ✓ |
| 7 | `sanitize_entry_paths` | The engine's single traversal gate `sanitizeEntryPath()` over `names` (1–10000): each → `sanitized` (safe '/'-relative path to join under YOUR root) or null with `rejected: true` and `reason` (empty, nul, absolute, drive, unc, traversal, ads, device-name, no-segments). No archive needed. Projection⁴ (summary → `rejectedNames`). | ✓ |
| 8 | `create_zip` | Write a ZIP from `entries` (0–100000 — Zip64 auto-promotes past 65 535; the engine default `maxEntries` and the `ZIPNATIVE_MCP_MAX_ENTRIES` ceiling remain the effective bound; each `name` + exactly one of `dataBase64` / `text` / `sourcePath`¹, or `directory: true` — a `/`-terminated name with a payload is `VALIDATION_ERROR`; per entry `compression`, `date` (ISO-8601, `pattern`; read as UTC — an offset-less value is the UTC wall clock), `comment`, `unixMode` (3–4 octal digits, `pattern`) xor `externalAttributes`, `extraFields` [{id, dataBase64}] ≤ 16, `stream: true` with a sourcePath → `addStream` (data-descriptor layout; above 4 GiB refused with `ZIP_UNSUPPORTED_ZIP64_STREAMING` unless the entry also sets `zip64: true` — the APPNOTE 4.3.9.2 Zip64 streaming layout)). Reproducible on one runtime by default, and the same DOS fields on every host (every date is written in UTC); `order` 'canonical' (default) / 'insertion' (EPUB / JAR), `defaultDate` ISO instant or 'now', `compression` {method 'store' / 'deflate', level 0–9, deterministic: true = cross-runtime identical bytes}, `comment`, `chunkSize` (file mode), `parallel` {workers 0–64 (≤ `ZIPNATIVE_MCP_WORKERS`; omitted = the engine default max(1, min(cores − 1, 8)) bounded by the ceiling), minWorkerJobSize, jobTimeout} (byte-identical), `includeSha256` (base64 and file mode), `strict`, `limits`², `outputMode` 'base64' / 'file' + `outputPath`. `summary` (typed in the output schema): entryCount, fileCount, directoryCount, streamedCount, uncompressedBytes, order, `deterministic` (true ONLY with `compression.deterministic: true`; a default call reports false with `deflateTier` 'node-zlib' — `inspect_zip.determinism` is the separate structural verdict), `deflateTier`, parallel, `sha256`. Every archive written is ISO/IEC 21320-1 conformant. | |
| 9 | `modify_zip` | Edit an existing archive without recompressing: `operations` (1–1000, applied in order) — `{op: 'add' \| 'replace', name, payload¹ + entry options}` (same rules and `pattern`s as `create_zip`; a `/`-terminated name with a payload is `VALIDATION_ERROR`), `{op: 'remove', name}`, `{op: 'rename', from, to}`, `{op: 'setComment', comment}`. The input is opened EAGERLY: an overlapping or truncated-header archive is refused before any operation runs. `mode` 'append' (default; save(): original bytes verbatim, edits appended, removed / replaced payloads REMAIN — data remanence, `ZIP_DEAD_BYTES_RATIO` past 50 %) / 'compact' (saveCompact(): rewrite without the dead bytes, still no recompression, removed data truly gone, SFX prefix dropped; `canonical: {date, keepComments, keepExternalAttributes}` writes the canonical form of `canonicalize_zip` after the edits). `compression` / `defaultDate` for new payloads, `includeSha256`, `strict`, `limits`², output base64 / file. `summary`: saveMode, operationsApplied, entryCountBefore / After, inputBytes, outputBytes, grewByBytes, `noOp`, sha256. Duplicate-name archives refused. | |
| 10 | `canonicalize_zip` | Make ANY archive reproducible (zipnative's `canonicalizeZip()`): an archive from Gradle, Maven, `zip`, Explorer or 7-Zip rewritten into the canonical form zipnative itself writes — entries sorted by raw name bytes, one timestamp (the DOS epoch, or a pinned `date` read as UTC), the UTF-8 flag on every name, no extra field but Zip64, the constant version-made-by, no data descriptor — WITHOUT recompressing a payload (nothing is decoded, so the result is identical on every runtime). Idempotent (`summary.alreadyCanonical` when the input was canonical already). `keepComments` (default false), `keepExternalAttributes` (default true), `includeSha256`, `strict`, `limits`², output base64 / file. `summary`: entryCount, inputBytes, outputBytes, alreadyCanonical, `canonicalForm` (the engine's `analyzeDeterminism()` verdict on the output), pinnedDate, keepComments, keepExternalAttributes, sha256. Duplicate-name archives refused. | |
| 11 | `merge_zip` | Merge 1–32 `sources` (each `zipBase64` XOR `zipPath`¹ with an optional `filter`³; ≤ 1 GiB in all) into one archive WITHOUT recompressing (`ZipWriter.addFromReader()`: compressed bytes, method, CRC, sizes, timestamps, attributes, comments and extra fields travel as they are). `verify` (default true) CRC- and size-checks every entry before it is copied, so a corrupt payload is refused with its `ZIP_*` code instead of being propagated; encrypted entries are refused. `onConflict` 'error' (default, `ZIP_DUPLICATE_ENTRY_NAME`) / 'first' / 'last' (`summary.dropped` lists what was not kept, ≤ 200 rows). `order` 'canonical' (default) / 'insertion', `comment`, `includeSha256`, `strict`, `limits`², output base64 / file. `summary`: sourceCount, entryCount, inputBytes, outputBytes, onConflict, verified, order, `perSource` [{index, label, entryCount, taken, filteredOut, dropped}], `dropped`, sha256. Run `canonicalize_zip` on the result for the full canonical form. | |
| 12 | `compute_crc32` | IEEE 802.3 CRC-32 (the engine's slice-by-8) of exactly one of `text` / `dataBase64` / `sourcePath`¹ (streamed in 1 MiB chunks, ≤ 1 GiB). `seed` (0–0xffffffff) continues a running CRC; `expect` (1–8 hex digits, optional `0x`; `pattern` `^(?:0x)?[0-9a-fA-F]{1,8}$`) → `matches`. Result `crc32`, `hex`, `byteLength`, `seed`. | ✓ |
| 13 | `inflate_raw` | Raw DEFLATE (RFC 1951) from `dataBase64` or `sourcePath`¹ with a MANDATORY `maxOutput` through the resumable inflater: constant memory, exact `bytesConsumed`, trailing bytes as `leftover` (`allowTrailing` silences the warning), `ZIP_INFLATE_OUTPUT_OVERFLOW` past the bound. `method` 'deflate' (default) / 'store' (bounded pass-through) / a numeric id (`pattern` `^(?:deflate\|store\|[0-9]+)$`; no codec registered here → `ZIP_UNSUPPORTED_METHOD`). Output base64 (≤ 50 MiB, `application/octet-stream`) or a sandbox file (`.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw`; bounded by the file-output cap). | ⁵ |
| 14 | `describe_engine` | Offline preflight (no archive): `server` {name, version, toolApiVersion, protocol, toolCount}, `engine` {version, deflateTier {default, deterministic}}, `capabilities` (nodeZlib, compressionStream, decompressionStream, workerThreads, cpuCount, defaultWorkers), `codecs` (with `incremental`), `defaultLimits` (the nine keys), `ceilings` (the four operator ceilings + the env names), `caps`, `sandbox` {enabled, cacheEnabled}, `network: 'none'`, `errorCodes` (39), `diagnosticCodes` (12), `unexposed` engine exports with the rationale. Projection⁴. Never cached. | ✓ |
| 15 | `draft_governance_issue` | Draft a governance-compliant GitHub issue for **human** review: `title`, `summary`, `issueType` (bug / feature / security / docs / performance), `targetRepo` ('zipnative-mcp' default, or 'zipnative' for engine behaviour), `reproduction` {command, result}, `expectedBehavior`, `actualBehavior`, `affectedPackages`, `duplicateSearchPerformed` (MUST be true). Returns `draftMarkdown` + `compliance` report + `warnings`; **never submits**, no network. `outputMode` 'inline' (default) / 'file' (+ `.md` `outputPath`). | ⁶ |

¹ **Input forms.** Archive input is exactly one of `zipBase64` (the raw archive as base64 exactly once; a `data:…;base64,` prefix is tolerated; decoded ≤ 128 MiB) or `zipPath` (a relative path inside `ZIPNATIVE_MCP_OUTPUT_DIR`; container extensions only — `.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix .nupkg .whl .apk .ipa .xpi .crx .kmz`; buffered ≤ 1 GiB, or read by byte ranges above that — see ⁷; never cached). Payloads are exactly one of `dataBase64` / `text` / `sourcePath` (a relative sandbox path, any extension, ≤ 1 GiB). Every sandbox read goes through ONE open handle whose **real** path is proven inside the sandbox: a symlink or junction planted in the sandbox that points outside it is `SECURITY_VIOLATION` on `zipPath` / `sourcePath` / `resources/read`, exactly as on writes, and a file that grows or shrinks during the read is `IO_ERROR`. Without the sandbox variable every path input is refused with `SECURITY_VIOLATION` and the tools work on base64 only.
² **`limits` fragment** (every engine-touching tool): the nine named `ZipLimits` keys — `maxEntries`, `maxEntryUncompressedSize`, `maxEntryCompressedSize` (the byte-range reader's bound on one fetched payload; the in-memory reader never consults it), `maxTotalUncompressedSize`, `maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`, `maxCommentBytes`, `maxCentralDirectoryBytes` (engine defaults 100000 · 1 GiB · 1 GiB + 1 MiB · 8 GiB · 1024 · 4096 · 65535 · 65535 · 256 MiB). Raise a bound for trusted input only; a value above the operator ceilings (`ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` for the three size keys, `ZIPNATIVE_MCP_MAX_ENTRIES`) is refused with `LIMIT_CEILING_EXCEEDED` naming the variable; a ceiling below the engine default tightens it silently. `strict: true` escalates the first diagnostic to `ZIP_STRICT_DIAGNOSTIC`.
³ **`filter` fragment** (`list_zip_entries`, `extract_zip`, `scan_zip_forward`, each `merge_zip` source): `names` (exact, ≤ 1000), `prefix`, `glob` (≤ 32 patterns of ≤ 1024 characters, matched in linear time; `*` within a segment, `**` across, `?` one char; a pattern without `/` matches at any depth, a trailing `/` a whole subtree), `includeDirectories` (default false — listing and scanning include directories when no filter is given). Several keys are ANDed.
⁴ **Projection** (the read tools and `extract_zip`): `verbosity: 'summary'` and `fields: [dot.paths]` — see §3. Server caps: 256 MiB stdio frame / HTTP body; 50 MiB inline output; file output 4 GiB by default (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`); 16 MiB inline entry; 32 MiB inline extraction total; diagnostics capped at 200 rows per result (`diagnosticsTruncated`). Every cap — these and the JSON-shape bounds (`create_zip` ≤ 100000 entries, `modify_zip` ≤ 1000 operations, `merge_zip` ≤ 32 sources, `sanitize_entry_paths` ≤ 10000 names, `filter.names` ≤ 1000, `filter.glob` ≤ 32, `extraFields` ≤ 16, `fields` ≤ 16, `scan_zip_forward` default `maxEntries` 10000, ≤ 50 resource links, `range.length` ≤ 16 MiB), the `resources/list` bounds (1000 entries, walk depth 8, 50 MiB per `resources/read`) and the cache bounds (3600 s TTL, 256 MiB) — is advertised by `describe_engine.caps`.
⁵ `inflate_raw` is not annotated `readOnlyHint` (like `draft_governance_issue`): its default inline mode is side-effect free, but `outputMode: 'file'` writes the inflated bytes into the sandbox.
⁶ `draft_governance_issue` is read-only in the default inline mode; `outputMode: 'file'` writes a `.md` into the sandbox, so its `readOnlyHint` is `false`.
⁷ **`access` fragment** (`inspect_zip`, `list_zip_entries`, `read_zip_entry`): 'auto' (default — buffered in memory, and a `zipPath` above the 1 GiB in-memory cap is opened by byte ranges instead of being refused), 'range' (always by byte ranges: zipnative's `openZipRange` over the sandbox file's own handle — never a URL; memory stays at the size of the central directory, `limits.maxEntryCompressedSize` bounds one fetched payload), 'memory' (always buffered; `INPUT_TOO_LARGE` above the cap). A range-read result carries `access: 'range'`; `inspect_zip` then omits `determinism`, its determinism checks fail closed, and `determinismReport` / `canonicalDate` are `VALIDATION_ERROR` (`data.remedy: "access:'memory'"`). The other tools that take an archive stay buffered (≤ 1 GiB).

**Long calls:** every `tools/call` honours `notifications/cancelled` (the engine stops between chunks; the call ends with `CANCELLED`, nothing is cached and a partial output file is removed) and, when the request carries `_meta.progressToken`, reports strictly increasing, throttled `notifications/progress`.

**Known limitations (engine-side, zipnative 1.1.0):** no encryption, read or write, in 1.x — encrypted entries are detected (`isEncrypted`, `encryptedCount`), reported as `skipped: 'encrypted'` by `verify_zip`, and refused by `read_zip_entry` / `extract_zip` / `merge_zip` with the typed `ZIP_UNSUPPORTED_ENCRYPTION`; there is no password input (`canonicalize_zip` and `modify_zip` copy an encrypted payload without decoding it). The forward reader (`scan_zip_forward`) refuses data-descriptor (bit 3) entries it cannot delimit without a central directory — store + bit 3, encrypted + bit 3, custom codec + bit 3 — with `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, and `skip()` on a deflate bit-3 entry costs a full decompress-and-discard. Windows reserved device names (`CON`, `NUL`, `AUX`, `COM1`…`LPT9`) are refused by the traversal gate on **every** platform — a POSIX-authored archive holding `aux.h` fails `extract_zip` by default (`rejectTraversal: false` skips it), and `create_zip` / `modify_zip` refuse to write such a name. Archives with duplicate entry names cannot be modified or canonicalised. Deliberately not exposed: a `nameEncoding` input / custom `nameDecoder`, `addRaw()` (the caller would vouch for CRC and sizes — `merge_zip` is the checked transplant), codec injection (a codec is executable code, JSON cannot carry one — only methods 0 store and 8 deflate are readable and writable), and any URL or remote byte-range source (no network path, ever). 64-bit fields above `Number.MAX_SAFE_INTEGER` are refused (`ZIP_VALUE_UNREPRESENTABLE`). Archive repair is out of scope: a broken structure is reported, never guessed at.

## 2. Decision tree

```
What is in this archive?
 ├─ facts + determinism verdict + diagnostics → inspect_zip        (check:[…] / assert:{…} for a CI gate; verbosity:'summary' for the verdict)
 ├─ the rows (paged, filtered)               → list_zip_entries   (filter by names / prefix / glob; offset + limit; summary → names only)
 └─ a zipPath larger than 1 GiB              → access:'auto' (default) or 'range': byte-range reads, memory = the central directory
Is it intact / safe to trust?  (the verify_before_trust prompt)
 ├─ 1. verify_zip           → never throws for archive problems: branch on ok, error.code, failedCount, skippedCount
 ├─ 2. inspect_zip          → check:['safe-names','no-encryption','no-symlinks','no-duplicates'] (+ assert:{maxUncompressedBytes, maxRatio}) → checksPassed
 ├─ 3. list_zip_entries     → eyeball the names (sanitizedPath null = the extraction gate will refuse it)
 └─ 4. extract_zip          → includeData:false first (the dry-run plan — opens eagerly, so a hostile extent is refused before any plan), then the real extraction with the defaults
Read ONE file without extracting?  → read_zip_entry
 ├─ text?                            → encoding:'utf8'   (ENTRY_NOT_UTF8 → fall back to base64)
 ├─ only a window of a big file?     → range:{offset,length}   (no CRC for a window)
 ├─ one entry of a multi-GiB zipPath → access:'range'   (only that entry's bytes are fetched)
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
 ├─ identical bytes on every runtime → compression:{deterministic:true} (+ includeSha256 to prove it) — the only case where summary.deterministic is true
 ├─ EPUB / JAR (mimetype first, stored) → order:'insertion', first entry compression:{method:'store'}
 ├─ many large entries               → parallel:{workers}  (byte-identical; capped by ZIPNATIVE_MCP_WORKERS)
 ├─ a multi-GiB sandbox file         → sourcePath + stream:true + outputMode:'file' (data-descriptor layout; > 4 GiB needs zip64:true and an operator-raised ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES)
 └─ real timestamps                  → defaultDate:'<ISO>' (still reproducible, read as UTC) — never 'now' unless you accept ZIP_TIMESTAMP_NOT_PINNED
Make an EXISTING archive reproducible?  → canonicalize_zip  (no recompression, idempotent; date:'<ISO>' to pin one release timestamp)
 └─ prove it                         → inspect_zip check:['canonical-form'] (+ canonicalDate when a date was pinned), or compare summary.sha256
Combine several archives?  → merge_zip  (no recompression; verify:true checks every CRC first)
 ├─ name collisions                  → onConflict:'error' (default) | 'first' | 'last' (summary.dropped)
 ├─ only part of a source            → sources[i].filter
 └─ a canonical result               → canonicalize_zip on the merged bytes
Change an existing archive?  → modify_zip  (the incremental_update prompt)
 ├─ add / replace / remove / rename / setComment, in order; rename never overwrites (remove the target first)
 ├─ must the removed content be GONE? → mode:'compact'   ('append' keeps every original byte — data remanence)
 ├─ edited AND canonical in one call → mode:'compact' + canonical:{…}
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
  `_meta.unmatchedFields` + `_meta.availableFields` so a typo is visible instead of an empty
  object. A path segment naming a prototype member (`__proto__`, `constructor`, `prototype`) is
  `VALIDATION_ERROR`.

Smallest "is this archive intact?" probe: `{ zipBase64, verbosity: 'summary', fields: ['ok', 'error', 'failedCount'] }` on `verify_zip`.
The output schemas of the projectable tools declare every property optional, so a projected
`structuredContent` always validates against `outputSchema`; the summary-only scalars
(`deterministic`, `diagnosticCount`, `names`, `paths`, `rejectedNames`, …) are declared there too.

Produced archives (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, and the
inflated bytes of `inflate_raw`) in base64 mode are delivered **once** as an embedded
`resource` content block (`data:application/zip;base64,…` / `application/octet-stream` for
`inflate_raw`), never duplicated into `structuredContent` — which carries `{ mode, sizeBytes,
summary, diagnostics, diagnosticCounts }`. Read the bytes from
`content.find(c => c.type === 'resource').resource.blob`. In file mode the result carries a
`resource_link` instead. `verify_zip` `entries: 'failed'` / `'none'` and `maxEntries`,
`list_zip_entries` `limit`, `scan_zip_forward` `maxEntries` and `extract_zip`
`includeData: false` bound the payload before projection.

## 4. Output modes & environment

- `outputMode: 'base64'` (default) — bytes in the embedded `resource` block (≤ 50 MiB inline; `OUTPUT_TOO_LARGE` beyond, with `outputMode: 'file'` as the remedy). `extract_zip` returns each file inline (≤ 16 MiB each, ≤ 32 MiB total).
- `outputMode: 'file'` — writes inside `ZIPNATIVE_MCP_OUTPUT_DIR`. `outputPath` (`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw`, `draft_governance_issue`) must be **relative**, end in a container extension (`.zip` recommended; `.md` for the governance draft; `.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw` for `inflate_raw`), no traversal / absolute / UNC paths / NUL bytes; `outputDir` (`extract_zip`) is a relative directory created on demand. The parent's **real** path must stay inside the sandbox (a pre-planted symlinked directory is `SECURITY_VIOLATION`), files are opened exclusively (`OUTPUT_EXISTS` — the server never overwrites), archives are streamed to disk under the file-output cap, and a failure or a cancellation removes the partial file.

The eight environment variables (every one declared in `server.json`; each is read once at
startup and an invalid value refuses to start — never a silent fallback):

- `ZIPNATIVE_MCP_OUTPUT_DIR` — the ONE filesystem boundary (an absolute path): `zipPath` / `sourcePath` inputs are read from it (the **real** path of the file itself must stay inside — a planted symlink / junction is `SECURITY_VIOLATION` on reads as on writes), file outputs are written under it. Unset ⇒ every path input and every file output is refused (`SECURITY_VIOLATION`) and the tools work on base64 only; the only other file I/O is the opt-in cache below.
- `ZIPNATIVE_MCP_CACHE_DIR` — opt-in SHA-256 response cache (1 h TTL, 256 MiB LRU, plaintext at rest; key namespaced by `TOOL_API_VERSION/ZIPNATIVE_MCP_VERSION/zipnative VERSION`, so an engine upgrade never serves old bytes). Never caches: `zipPath` / `sourcePath` inputs (also nested in `entries`, `operations`, `sources` — a path is a reference, not content), `outputMode: 'file'`, `defaultDate: 'now'`, `parallel`, a cancelled call, `describe_engine`, `draft_governance_issue`. A hit carries `_meta.cached: true` and returns the **earlier** call's result for identical inputs.
- `ZIPNATIVE_MCP_PORT` — opt-in Streamable HTTP transport on `127.0.0.1:<port>/mcp` (stdio otherwise; an integer in 1..65535). `POST` only; `GET` / `DELETE` → 405; foreign `Host` / `Origin` → 403 (the `Origin` port must equal the server port); bodies above 256 MiB → 413; every response carries `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- `ZIPNATIVE_MCP_HTTP_TOKEN` — opt-in bearer token for the HTTP transport (≥ 16 characters, no whitespace; a weaker value aborts startup). When set, every request to `/mcp` must carry `Authorization: Bearer <token>` or is answered `401` + `WWW-Authenticate: Bearer realm="zipnative-mcp"`. Compared constant-time, never logged. Without it the HTTP endpoint has **no authentication** — any local process can reach it.
- `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` — operator ceiling for `limits.maxEntryUncompressedSize`, `limits.maxEntryCompressedSize` and `limits.maxTotalUncompressedSize` (default 8 GiB = the engine default; integer ≥ 1024).
- `ZIPNATIVE_MCP_MAX_ENTRIES` — operator ceiling for `limits.maxEntries` and `scan_zip_forward` `maxEntries` (default 100000; integer ≥ 1). The scanner's default budget (10000) is clamped to the ceiling, so a call without `maxEntries` succeeds under any valid ceiling; only an explicit value above it is refused.
- `ZIPNATIVE_MCP_WORKERS` — operator ceiling for `create_zip` `parallel.workers` (default 8; `0` disables worker threads — compression stays on the calling thread). With no explicit `workers` the engine default `max(1, min(cores − 1, 8))` applies, bounded by the ceiling.
- `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` — the largest file a tool writes in `outputMode: 'file'` (and the total of a file-mode extraction), enforced while streaming (default 4 GiB, the 1.0.0 cap; integer ≥ 1 MiB). Raise it to write a Zip64 archive above 4 GiB into the sandbox (`create_zip` `stream: true` + `zip64: true`).

The four ceilings (the last four variables) are reported by `describe_engine.ceilings`; a
per-call value above a ceiling is `LIMIT_CEILING_EXCEEDED` naming the variable; a ceiling
below the engine default tightens the default silently.

**Privacy / network policy:** none, ever. The server has no network code path — no
telemetry, no GitHub, no URL from any argument, no operator-configurable endpoint of any
kind (`describe_engine` reports `network: 'none'`; the byte-range reader reads the sandbox
file's own handle, never a remote source). Archive bytes only ever flow back in the JSON-RPC
response or into the sandbox. The optional HTTP transport (`ZIPNATIVE_MCP_PORT`) binds
`127.0.0.1` only and enables DNS-rebinding protection; that guard does not stop *other local
processes* — set `ZIPNATIVE_MCP_HTTP_TOKEN` for that. Extracted files are written verbatim —
the server never executes, renders or scans them, so scan untrusted content in the caller.
Every engine diagnostic goes through a sink: nothing is ever printed to stdout on the stdio
transport. An error message never carries an absolute path.

**Protocol:** MCP 2026-07-28 (stateless, `server/discover`, `resultType`, cache hints —
`tools/list` and `prompts/list` public 24 h, `server/discover` public 1 h, `resources/*`
private 0) on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` ^2.3.1; a 2026-07-28
HTTP request without the `MCP-Protocol-Version` header is refused with 400), with automatic
fallback to the legacy `initialize` handshake on stdio and HTTP for every revision the SDK
negotiates — existing hosts need no change:

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
modern, HTTP legacy and HTTP modern with a bearer token — no interaction, no unexpected
`isError`, a code and a remedy on every refusal, a cache hit over the wire, JSON-only stdout,
clean exit. Replay it by hand with the repository's `.mcp.json`
([guides/LOCAL_TESTING.md](guides/LOCAL_TESTING.md)). The stdio frame cap is raised from the
SDK's 10 MiB to 256 MiB so multi-MiB base64 archives fit. A `tools/call` naming an unknown
tool is a JSON-RPC protocol error (`-32602`, `[UNKNOWN_TOOL] Unknown tool: …`), not an
`isError` result; an unknown resource URI is `-32602` too. Every regular file in the sandbox
(archives written by the archive-producing tools, files written by `extract_zip`, archives
dropped in for `zipPath`) is listed as `zipnative://output/<path>` (template
`zipnative://output/{+path}`, MIME by extension, 50 MiB read cap). Seven prompts ship as
ready-made recipes: `secure_extraction`, `reproducible_archive`, `incremental_update`,
`forensic_scan`, `verify_before_trust`, plus the governance pair `governance_contract` /
`draft_issue_workflow`.

## 5. Recipes

- **Untrusted intake (the `secure_extraction` prompt):** `verify_zip` `{ verbosity: 'summary' }` → branch on `ok` and `error.code` (`ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION` are active-attack shapes: stop) → `inspect_zip` `{ check: ['safe-names', 'no-encryption', 'no-symlinks', 'no-duplicates'], assert: { maxUncompressedBytes: 268435456, maxRatio: 100 } }` → `checksPassed` → `extract_zip` `{ includeData: false }` (the plan: sanitized paths, sizes, nothing decompressed — the archive is opened eagerly first, so an overlapping / offset-into-CD / Zip64-spoofed shape is refused before any plan; a method / CRC / size divergence is what `verify_zip` caught in step 1) → `extract_zip` `{ outputMode: 'file', outputDir: 'intake/<id>' }` with the defaults. Relax `rejectTraversal` / `rejectSymlinks` / `onDuplicate` only after reading the entry list; `limits.*` widen the bounds for trusted input only. Conformance is not safety: zip-slip, device names and duplicate paths are spec-valid archives.
- **Reproducible build + proof (the `reproducible_archive` prompt):** `create_zip` `{ entries, compression: { deterministic: true }, includeSha256: true }` twice → equal `summary.sha256` (`summary.deflateTier: 'pure-pinned'`, `summary.deterministic: true`); or `inspect_zip` `{ check: ['deterministic', 'canonical-layout'] }` on the result. Three verdicts, read them where they apply: `summary.deterministic` is true **only** with `compression.deterministic: true` (cross-runtime identity) — a default call is reproducible on the same runtime (`deflateTier: 'node-zlib'`) and reports `false`; `summary.sha256` (base64 and file mode) is the proof; `inspect_zip.determinism.deterministic` is the structural verdict (epoch timestamps + canonical order + UTF-8 flags — a pinned non-epoch date reproduces but reports `false` there). Keep dates pinned (omit `defaultDate`, or one fixed ISO instant — read as UTC, so the bytes are the same in every time zone); `parallel` is byte-identical; `stream: true` entries are reproducible but `canonicalLayout: false`.
- **Canonicalise a third-party archive:** `canonicalize_zip` `{ zipPath: 'build/app.jar', date: '2026-10-08T00:00:00Z', includeSha256: true }` → `summary.canonicalForm: true`, `summary.sha256`; prove it later with `inspect_zip` `{ zipPath, check: ['canonical-form'], canonicalDate: '2026-10-08T00:00:00Z' }` or `determinismReport: true` (every offending entry with the rule it breaks). Running `canonicalize_zip` again returns the same bytes (`summary.alreadyCanonical: true`). Compressed payloads are copied bit for bit — nothing is recompressed or decoded.
- **Merge archives:** `merge_zip` `{ sources: [{ zipPath: 'a.zip' }, { zipPath: 'b.zip', filter: { prefix: 'docs/' } }], onConflict: 'last', includeSha256: true }` → `summary.perSource[]` (taken / filteredOut / dropped per source), `summary.dropped` (the collisions resolved); `verify: true` (default) refuses a corrupt source entry with `ZIP_CRC_MISMATCH` / `ZIP_SIZE_MISMATCH`. Follow with `canonicalize_zip` for one timestamp and Zip64-only extras.
- **EPUB / JAR layout:** `create_zip` `{ order: 'insertion', entries: [{ name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } }, { name: 'META-INF/container.xml', text: '…' }, …] }` — the stored `mimetype` lands first; `inspect_zip` `{ assert: { has: ['mimetype'] } }` + `list_zip_entries` `{ limit: 1, fields: ['entries.name', 'entries.methodName'] }` proves it. `outputPath: 'book.epub'` keeps the container extension.
- **Incremental update + compact (the `incremental_update` prompt):** `modify_zip` `{ operations: [{ op: 'replace', name: 'config.json', text: '…' }, { op: 'add', name: 'CHANGELOG.md', text: '…' }] }` (append: fast, byte-preserving, old payloads still inside — `ZIP_DEAD_BYTES_RATIO` past 50 %) → when a secret must be gone or 7-Zip must read the file: `modify_zip` `{ operations: [{ op: 'remove', name: '.env' }], mode: 'compact' }` (add `canonical: {}` for the canonical form in the same call). `summary.noOp: true` means nothing changed and the same bytes came back.
- **Manifest peek without extracting:** `read_zip_entry` `{ name: 'META-INF/MANIFEST.MF', encoding: 'utf8' }` (or `package.json`, `[Content_Types].xml`, `mimetype`); the first 4 KiB of a large log: `{ name: 'logs/app.log', encoding: 'utf8', range: { offset: 0, length: 4096 } }`; one entry of a 6 GiB sandbox archive: `{ zipPath: 'big.zip', name: 'manifest.json', access: 'range' }`; a duplicate name: `list_zip_entries` `{ filter: { names: ['x'] } }` → `read_zip_entry` `{ index }`.
- **Forensic scan of a truncated download (the `forensic_scan` prompt):** `inspect_zip` fails with `ZIP_EOCD_NOT_FOUND` / `ZIP_RECORD_TRUNCATED` → `scan_zip_forward` `{ tolerateTruncation: true, verbosity: 'summary' }` → `names`, `stoppedAt: 'error'` + `error.code` (`ZIP_STREAM_TRUNCATED`), `bytesDelivered`; `data: 'verify'` checks the CRCs of what arrived. Treat every row as local-headers-only; `sanitize_entry_paths` (or the rows' `sanitizedPath`) before touching a filesystem.
- **Chain via `zipPath` without re-sending bytes:** `create_zip` `{ …, outputMode: 'file', outputPath: 'build/release.zip' }` → `modify_zip` `{ zipPath: 'build/release.zip', operations: […], outputMode: 'file', outputPath: 'build/release-v2.zip' }` → `verify_zip` `{ zipPath: 'build/release-v2.zip' }` → `extract_zip` `{ zipPath: 'build/release-v2.zip', outputMode: 'file', outputDir: 'staging' }` — all inside `ZIPNATIVE_MCP_OUTPUT_DIR`; the files are also `zipnative://output/build/…` resources (`resources/list`, `resources/read`).
- **CI gate with `inspect_zip` check / assert:** `inspect_zip` `{ zipPath: 'dist/app.zip', check: ['deterministic', 'canonical-layout', 'no-encryption', 'no-symlinks', 'safe-names', 'no-duplicates', 'no-zip64', 'deflate-only'], assert: { maxEntries: 5000, maxUncompressedBytes: 1073741824, maxRatio: 100, has: ['manifest.json'] }, verbosity: 'summary', fields: ['checksPassed', 'checks'] }` → fail the pipeline on `checksPassed: false` (each `checks[]` row carries `check`, `ok`, `detail`); `strict: true` additionally fails on any diagnostic (`ZIP_STRICT_DIAGNOSTIC`).
- **Raw payload → `inflate_raw`:** `read_zip_entry` `{ name: 'big.bin', mode: 'raw' }` → `structuredContent.dataBase64` (the compressed payload; `entry.methodName` must be `deflate` — a stored entry's raw payload is already the plain bytes) → `inflate_raw` `{ dataBase64, maxOutput: <entry.uncompressedSize> }` → `summary.bytesOut`, `bytesConsumed`, `leftover`; `compute_crc32` on the result with `expect: entry.crc32` cross-checks it.
- **Propose an upstream change:** `draft_governance_issue` `{ title, summary, issueType, targetRepo: 'zipnative' | 'zipnative-mcp', reproduction: { command, result }, expectedBehavior, duplicateSearchPerformed: true }` → present `draftMarkdown` + `compliance` to the user → a **human** submits it (the server never does). See [guides/AI_GOVERNANCE.md](guides/AI_GOVERNANCE.md).

## 6. Error reference

A refused call is `isError: true` with `content[0].text` = `<tool> failed [CODE]: message` and
`_meta.error = { code, message, data? }`. Branch on `_meta.error.code` (also the `[CODE]` in
`content[0].text`), never on the message. Wrapper codes come from the server's own boundary
(`src/wrapper-codes.ts`); the 39 `ZIP_*` codes are zipnative's frozen vocabulary passed
through verbatim, with `data.errorClass` (the coarse class), `data.engineError` (the engine
class name), `data.entryName`, `limit` / `configured` / `observed`, `feature`, `expectedCrc` /
`actualCrc` and, from `modify_zip`, `operationIndex` / `op` when known. `verify_zip` never
raises a `ZIP_*` code for the archive — it lands in `error.code`; the same holds for
`scan_zip_forward` under `tolerateTruncation: true`.

`data.remedy` (optional string) is the machine-actionable hint some refusals carry next to the
prose remedy in `message`, drawn from a closed vocabulary: `outputMode:'file'` (`extract_zip`
above the inline caps), `range` (`read_zip_entry` above the 16 MiB cap), `encoding:'base64'`,
`data:'verify'` (`scan_zip_forward` `data: 'include'` above the caps), `list_zip_entries` (an
out-of-range `index`), `resources/list` (a missing `zipPath` / `sourcePath`), `zipPath` (an
inline payload above the 128 MiB cap — route the bytes through a sandbox file),
`access:'memory'` (`inspect_zip` `determinismReport` / `canonicalDate` on a range-read
archive), `maxEntries ≤ N` (`scan_zip_forward` above the ceiling), `retry` (`CANCELLED`, and
`IO_ERROR` for a file that changed during the read). Absent when no single input change lifts
the refusal. Branch on `code` first; `remedy` only refines the retry.

### 6.1 Wrapper codes (17)

| `code` | Meaning | Fix |
|--------|---------|-----|
| `VALIDATION_ERROR` | The input failed the schema: wrong type / bound / enum / `pattern`, an **unknown or misspelt key** (top-level or nested — every object is strict), none or several of the exclusive input forms (`zipBase64` / `zipPath`, `name` / `index`, `dataBase64` / `text` / `sourcePath`), an empty or non-base64 payload (a `data:` prefix is tolerated, base64-twice is not), an invalid glob, a prototype segment in a `fields` path, a `range` outside `mode: 'data'`, `stream: true` without `sourcePath`, `zip64: true` without `stream: true`, a duplicate name in `create_zip.entries`, a date outside 1980–2107 or not ISO-8601, `unixMode` together with `externalAttributes`, an extra field with id `0x0001`, a `/`-terminated name carrying a payload, `determinismReport` / `canonicalDate` on a range-read archive | Re-read the field schema (the message names the path); pass exactly one input form. |
| `INPUT_TOO_LARGE` | A decoded inline payload or the sum of inline payloads exceeds 128 MiB, or a `zipPath` / `sourcePath` file exceeds 1 GiB on a buffered tool (`merge_zip`: the sources in all) | Route the bytes through a sandbox file (`data.remedy: 'zipPath'`), or split the input; `inspect_zip` / `list_zip_entries` / `read_zip_entry` read a larger `zipPath` by byte ranges (`access`), `scan_zip_forward` streams it. |
| `INPUT_NOT_FOUND` | A `zipPath` / `sourcePath` does not exist in the sandbox (a dangling link too) or is not a regular file | Check the relative path with `resources/list` (`data.remedy: 'resources/list'`); drop the file into `ZIPNATIVE_MCP_OUTPUT_DIR`. |
| `ENTRY_TOO_LARGE` | An entry above the 16 MiB inline cap: `read_zip_entry` (uncompressed in `mode: 'data'`, or compressed in `mode: 'raw'`), `extract_zip` base64 mode, `scan_zip_forward` `data: 'include'` | A `range` (`data.remedy: 'range'`), `extract_zip` `outputMode: 'file'`, a `filter`, or `scan_zip_forward` `data: 'verify'` — `data.remedy` names it; a raw payload above the cap is not retrievable inline. |
| `ENTRY_NOT_UTF8` | `encoding: 'utf8'` on content that is not valid UTF-8 | Read it with `encoding: 'base64'`. |
| `OUTPUT_TOO_LARGE` | An inline result above its cap (50 MiB archive or inflated bytes, 32 MiB extraction), a file output above the file-output cap (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`, enforced while streaming), a resource above the 50 MiB read cap | `outputMode: 'file'` with `ZIPNATIVE_MCP_OUTPUT_DIR` set; a `filter` or `includeData: false`; the operator raises the file-output ceiling for a larger archive. |
| `OUTPUT_EXISTS` | The target file already exists in the sandbox — the server never overwrites | Choose another `outputPath` / `outputDir`, or remove the file yourself. |
| `IO_ERROR` | A filesystem operation failed (permissions, disk full, …), or a sandbox file grew or shrank while it was being read; the message never carries an absolute path | Fix the sandbox directory, or retry once the file is complete (`data.remedy: 'retry'`); a partial output file was removed. |
| `SECURITY_VIOLATION` | File I/O with `ZIPNATIVE_MCP_OUTPUT_DIR` unset; a NUL byte; an absolute / drive / UNC path; a path escaping the sandbox (`..`); a **real** path (symlink, junction) outside it on a read or a write; a file swapped while it was being opened | Set `ZIPNATIVE_MCP_OUTPUT_DIR`; pass relative paths only; remove the link. |
| `MISSING_OUTPUT_PATH` | `outputMode: 'file'` without `outputPath` (or without `outputDir` for `extract_zip`) | Pass a relative `outputPath` / `outputDir`. |
| `INVALID_PATH` | A path member (`outputPath`, `outputDir`, `zipPath`, `sourcePath`) is empty or not a string | Pass a non-empty relative path. |
| `INVALID_EXTENSION` | An `outputPath` / `zipPath` that does not end in a container extension (`.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix .nupkg .whl .apk .ipa .xpi .crx .kmz`); `.md` for a governance draft; the `inflate_raw` allow-list | Fix the extension (`sourcePath` and extracted files are not subject to it). |
| `LIMIT_CEILING_EXCEEDED` | A `limits.*` value, an **explicit** `scan_zip_forward` `maxEntries` or `parallel.workers` above its operator ceiling (`data.env` names the variable; `data.remedy: 'maxEntries ≤ N'` for the scanner; the scanner's default is clamped, never refused) | Lower the value (or omit it), or the operator raises the ceiling for trusted input only. |
| `UNKNOWN_RESOURCE` | `resources/read` with a URI outside `zipnative://output/`, an empty path, or a missing file — surfaced as JSON-RPC error **`-32602`** (Invalid params), the code carried in the message | List URIs with `resources/list`. |
| `GOVERNANCE_VIOLATION` | A `draft_governance_issue` draft breaks the AI-governance contract (proposes a runtime dependency, has no reproduction block, or `duplicateSearchPerformed: false`) | Remove the dependency proposal, include the reproduction, confirm the duplicate search. |
| `CANCELLED` | The client cancelled the request (`notifications/cancelled`, or the HTTP client went away) before it completed: the engine stopped between chunks, nothing was cached and a partial output file was removed. Work that completed before the abort reached the engine is returned as a result (cancellation is best-effort), never cached | Retry the call if the result is still wanted (`data.remedy: 'retry'`). |
| `ENGINE_ERROR` | Something that is not a `ZipError` escaped the engine or the runtime (a bug — `data.errorClass: 'internal'`); the message is stripped of absolute paths | Report it with a reproduction via `draft_governance_issue`. |
| `[UNKNOWN_TOOL]` | **Protocol error, not a tool result:** `tools/call` named a tool that does not exist — JSON-RPC error **`-32602`** with message `[UNKNOWN_TOOL] Unknown tool: <name>` (MCP classifies unknown tools as protocol errors; `isError: true` is reserved for execution failures) | List tools with `tools/list`; names are lower-snake-case. |

### 6.2 Engine error codes (39 frozen `ZIP_*` codes)

| `code` | Meaning | Fix |
|--------|---------|-----|
| `ZIP_INVALID_OPTION` | An option value fails validation: compression.level outside 0-9, a non-positive chunkSize, or an argument shape the API forbids (class `usage`). Raised by: `create_zip`, `modify_zip`, `inflate_raw` — the wrapper's own validation catches the known shapes first as `VALIDATION_ERROR` | Fix the option value at the call site — the message names the offending option and the accepted range. |
| `ZIP_INPUT_TOO_LARGE` | The pure-TS deflate encoder received more than 2 GiB of input in one call (class `limit`; unreachable below the 1 GiB `sourcePath` cap). Raised by: `create_zip`, `modify_zip` with `compression.deterministic: true` | Split the input, or stream it entry by entry. |
| `ZIP_ENTRY_NOT_FOUND` | A named entry does not exist where one is required, or an `index` is out of range (class `not-found`). Raised by: `read_zip_entry`, `modify_zip` (replace / remove / rename) | Names are case-sensitive — call `list_zip_entries` for the exact names. |
| `ZIP_ENTRY_EXISTS` | A named entry already exists where absence is required (`add` over an existing name; `rename` onto an existing name) (class `input`). Raised by: `modify_zip` | Use `replace` to overwrite, or `remove` the target first — renames never overwrite implicitly. |
| `ZIP_API_MISUSE` | A usage contract was violated inside the engine (drain-order violations in forward iteration, single-shot reuse, push after finish) — a wrapper bug (class `internal`). Raised by: `create_zip`, `scan_zip_forward`, `inflate_raw` | The message names the contract; report it with a reproduction. |
| `ZIP_STRICT_DIAGNOSTIC` | `strict: true` escalated the first conformance diagnostic of the operation into a thrown error (class `check`). Raised by: every tool taking `strict` | The message embeds the underlying diagnostic code; handle the archive shape it names, or drop `strict` and read `diagnostics[]`. |
| `ZIP_INTERNAL` | An internal invariant broke — this is a zipnative bug, not an input problem (class `internal`). Raised by: any tool | Report it with a reproduction archive via `draft_governance_issue` (`targetRepo: 'zipnative'`). |
| `ZIP_EOCD_NOT_FOUND` | The input is smaller than 22 bytes, no end-of-central-directory record exists in the trailing scan window, or no candidate is self-consistent (trailing garbage / hostile ambiguity — zipnative refuses to guess) (class `parse`). Raised by: every random-access tool (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `extract_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`; `verify_zip` → `error`) | The bytes are not a ZIP archive, are truncated, or carry trailing bytes — verify the source; `scan_zip_forward` still lists what is there. |
| `ZIP_EOCD_INCONSISTENT` | The end-of-central-directory record contradicts the archive layout: entries-on-disk differs from the total, or the central directory overlaps the record itself (class `parse`). Raised by: the random-access tools | The archive is corrupt or hostile — re-obtain it from the source. |
| `ZIP_ZIP64_LOCATOR_MISSING` | A zip64 sentinel is set but the zip64 end-of-central-directory locator is absent (class `parse`). Raised by: the random-access tools | The archive is truncated or corrupt — re-obtain it. |
| `ZIP_ZIP64_EOCD_MISPLACED` | The zip64 end-of-central-directory record is not where the locator points (and not at the fallback position) (class `parse`). Raised by: the random-access tools | Corrupt archive, or an unsupported prepended-data layout — rebuild the archive without the prefix. |
| `ZIP_CD_INCONSISTENT` | The central-directory walk contradicts the declared counts or size: it ends early, a record extends past the declared size, or bytes remain beyond the declared entries (class `parse`). Raised by: the random-access tools | The archive is corrupt or hostile — re-obtain it from the source. |
| `ZIP_RECORD_TRUNCATED` | A fixed or variable-length ZIP record (EOCD, zip64 EOCD, central or local header) or an entry's payload overruns the available bytes (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | The archive is truncated — verify the transfer completed; `scan_zip_forward` `tolerateTruncation: true` recovers the partial inventory. |
| `ZIP_SIGNATURE_MISMATCH` | An expected PK signature is absent: no local file header at the offset the central directory declares, no EOCD signature at the resolved offset, or a forward stream that does not start with a local header (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | The archive is corrupt or the bytes are not a ZIP stream. |
| `ZIP_STREAM_TRUNCATED` | A forward byte stream ended mid-record or mid-entry (class `parse`). Raised by: `scan_zip_forward` (in `error` under `tolerateTruncation: true`) | The stream was cut — verify the producer sent the complete archive. |
| `ZIP_VALUE_UNREPRESENTABLE` | A 64-bit field exceeds Number.MAX_SAFE_INTEGER (2^53 - 1) (class `parse`). Raised by: the random-access tools, `scan_zip_forward` | Archives this large are not supported — the public API uses number, not bigint. |
| `ZIP_INVALID_ENTRY_NAME` | A writer-side entry name violates the name rules: empty, NUL bytes, backslashes, absolute paths, '..' segments or a reserved device name (zipnative never writes traversal-capable archives) (class `input`). Raised by: `create_zip`, `modify_zip` (add / rename) | Use relative, forward-slash paths without traversal segments; check names with `sanitize_entry_paths`. |
| `ZIP_DUPLICATE_ENTRY_NAME` | Duplicate entry names where uniqueness is required: adding over an existing name, opening a duplicate-name archive for modification or canonicalisation, or a `merge_zip` collision under `onConflict: 'error'` (class `input`). Raised by: `modify_zip`, `canonicalize_zip`, `merge_zip` (`create_zip` catches duplicates as `VALIDATION_ERROR`) | Every archive path must be unique; for duplicate-name sources, extract and rebuild with `create_zip`; `merge_zip` `onConflict: 'first'` / `'last'`. |
| `ZIP_DEFLATE_TRUNCATED` | A deflate stream ends mid-block: the data ran out before the final block completed (every inflate tier is normalised to this code) (class `parse`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include), `merge_zip` (`verify`), `inflate_raw` | The compressed payload is truncated — re-obtain the archive. |
| `ZIP_DEFLATE_CORRUPT` | A deflate stream is structurally invalid: bad Huffman codes, invalid symbols, out-of-range back-references, LEN/NLEN mismatches, or an unsupported block type (every inflate tier is normalised to this code) (class `parse`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `merge_zip` (`verify`), `inflate_raw` | The compressed payload is corrupt — re-obtain the archive. |
| `ZIP_ENTRY_OVERLAP` | Two entries share bytes: duplicate local-header offsets, an entry extending into another, or an entry claiming to start inside the central directory (class `security`, CWE-405). Raised by: `inspect_zip` (eager), `list_zip_entries` (eager), `read_zip_entry`, `extract_zip`, `modify_zip` (always eager) (`verify_zip` → `error`) | Overlapping-entry archives are a decompression-bomb/smuggling shape and are always rejected — there is no opt-out. |
| `ZIP_CD_LFH_MISMATCH` | A local file header contradicts the central directory on the compression method (class `security`, CWE-436). Raised by: `inspect_zip`, `read_zip_entry`, `extract_zip`, `modify_zip` (`verify_zip` → `error` / row) | Parser-differential archives are rejected — rebuild the archive with a sane tool. |
| `ZIP_ZIP64_CONTRADICTION` | A zip64 value contradicts a non-sentinel classic field (zip64 may only REPLACE sentinel fields) (class `security`, CWE-1288). Raised by: the random-access tools | Parser-differential archives are rejected — rebuild the archive. |
| `ZIP_PATH_TRAVERSAL` | An entry name cannot be made safe: it escapes the extraction root (zip-slip — '..' segments, absolute paths, drive letters, UNC prefixes, backslash tricks, NTFS alternate data streams) or is a Windows reserved device name (CON, NUL, COM1..LPT9) (class `security`, CWE-22 / CWE-67). Raised by: `extract_zip` | The archive is hostile, corrupt, or POSIX-authored with device-name files; pass `rejectTraversal: false` to skip such entries instead (they are never emitted — read `skipped`). |
| `ZIP_SYMLINK_REJECTED` | An entry is a Unix symlink and `rejectSymlinks` is on (the default) (class `security`, CWE-59). Raised by: `extract_zip` | Pass `rejectSymlinks: false` to receive the link target as ordinary data (never materialized as a link). |
| `ZIP_EXTRACT_DUPLICATE_PATH` | Two entries resolve to the same output path under `onDuplicate: 'error'` (the default) (class `security`, CWE-694). Raised by: `extract_zip` | Pass `onDuplicate: 'first'` or `'last'` to resolve the shadowing deliberately. |
| `ZIP_CRC_MISMATCH` | Decompressed bytes fail the declared CRC-32 (central directory, local header, or data descriptor) (class `data`; `data.expectedCrc` / `actualCrc`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include), `merge_zip` (`verify`); `verify_zip` reports it as a row | The data is corrupt; `read_zip_entry` `verifyCrc: false` only if you accept corrupt output. |
| `ZIP_SIZE_MISMATCH` | Sizes contradict: the decompressed size differs from the declared size, or local-header sizes/CRC contradict the central directory (class `data`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `merge_zip` (`verify`); `verify_zip` reports it as a row | The archive metadata lies — treat the archive as corrupt or hostile. |
| `ZIP_INFLATE_OUTPUT_OVERFLOW` | Inflate produced more output than the declared or permitted bound (class `data`). Raised by: `inflate_raw` (past `maxOutput`, also for `method: 'store'`), `read_zip_entry`, `extract_zip`, `scan_zip_forward` | The archive metadata lies about this entry, or raise `maxOutput` / the relevant limit if the data is trusted. |
| `ZIP_DESCRIPTOR_MISMATCH` | No data-descriptor form (signed/signless × 32/64-bit) matches the measured CRC and sizes of a bit-3 entry (class `data`). Raised by: `scan_zip_forward` | The stream is corrupt or hostile — use the random-access tools on the complete archive for the authoritative view. |
| `ZIP_DECOMPRESSION_FAILED` | The active codec failed mid-decompression (class `data`). Unreachable through this server since zipnative 1.1.0: every inflate tier is normalised to `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED`; listed because the vocabulary is frozen | Treat it as corrupt or hostile data — the wrapped detail is in the message. |
| `ZIP_LIMIT_EXCEEDED` | A configured security bound from ZipLimits was exceeded (class `limit`, CWE-400 / CWE-409 / CWE-770; `data.limit`, `configured`, `observed`). Raised by: every tool taking `limits` (`verify_zip` → `error`); `maxEntryCompressedSize` only on a range-read archive | Raise `limits.<limit>` explicitly if this archive is trusted — the message names the key and both values; the operator ceilings still apply. |
| `ZIP_LIMIT_INVALID` | The limits override itself is invalid: an unknown key, or a non-positive/NaN value (class `usage`; normally caught earlier as `VALIDATION_ERROR`). Raised by: the `limits`-taking tools | Fix the limits object at the call site — valid keys are listed in the message. |
| `ZIP_UNSUPPORTED_ENCRYPTION` | An entry is encrypted (ZipCrypto or strong encryption) — encryption is unsupported in 1.x by policy (class `unsupported`; `data.feature`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward` (`data` verify / include), `merge_zip`; `verify_zip` reports `skipped: 'encrypted'` | Check `isEncrypted` (`list_zip_entries`) to route around such entries with a `filter`; there is no password input; `modify_zip` and `canonicalize_zip` copy encrypted entries without decoding them. |
| `ZIP_UNSUPPORTED_METHOD` | An entry uses a compression method with no registered codec (only 0 store and 8 deflate exist in this server) (class `unsupported`). Raised by: `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `inflate_raw` (numeric `method`); `verify_zip` reports `skipped: 'unsupported-method'` as failed | Re-save the archive with store/deflate using another tool, or `filter` the entry out. |
| `ZIP_UNSUPPORTED_MULTI_DISK` | The archive is multi-disk/spanned (EOCD disk fields, zip64 locator disk count, or an entry starting on another disk) (class `unsupported`). Raised by: the random-access tools | Multi-disk archives are an explicit anti-goal — rebuild as a single archive. |
| `ZIP_UNSUPPORTED_ZIP64_STREAMING` | An `addStream()` entry without `zip64: true` exceeds 4 GiB (class `unsupported`). Raised by: `create_zip` (`stream: true`) | Set `zip64: true` on that entry (the Zip64 streaming layout), drop `stream: true` (buffered entries are fully Zip64), or split it. |
| `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR` | Forward reading met a data-descriptor (bit 3) entry whose payload cannot be delimited without the central directory: store+bit3, encrypted+bit3, or a custom codec (class `unsupported`). Raised by: `scan_zip_forward` | Use `list_zip_entries` / `read_zip_entry` / `extract_zip` on the complete archive instead. |
| `ZIP_UNSUPPORTED_CODEC_MODE` | A registered codec supports only the other access mode (stream-only via a buffered read, or no streaming decompressor via a stream read) (class `unsupported`; unreachable with the built-in codecs). Raised by: `inflate_raw`, `read_zip_entry` | The message names the compliant call; with the built-in codecs this cannot occur. |

### 6.3 Diagnostics (12)

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
| `ZIP_TIMESTAMP_CLAMPED` | info | none through this server (zipnative 1.1.0) | The engine clamps a date outside the DOS range (1980-01-01 … 2107-12-31 23:59:58). Every date this server writes is checked first, so an out-of-range date is a `VALIDATION_ERROR` instead. | Pass a date inside the DOS range. |

## 7. Contributing to this repo

Agents working **on** this repository — adding a tool, changing a schema, running the gate,
preparing a release — follow [AGENTS.md](../AGENTS.md) (the repository rule file),
[CLAUDE.md](../CLAUDE.md) (commands and the architecture map), the scoped rules under
[.github/instructions/](../.github/instructions/), the human-in-the-loop protocol of
[.github/AGENT_RULES.md](../.github/AGENT_RULES.md) and the narrative in
[guides/AI_GOVERNANCE.md](guides/AI_GOVERNANCE.md). This contract is checked: the
catalogue order, the error rows and the environment variables are held to the source by
`npm run verify:docs` (rules `tool-parity`, `error-parity`, `env-var-parity`).
