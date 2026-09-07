# AI Agent Guide — zipnative-mcp

> **Read this first if you are an AI agent (Claude, Copilot, Cursor, Continue, Zed, Windsurf, Cline, Roo Code, …) about to call zipnative-mcp.**
> It tells you which of the 13 tools to pick and how to avoid the retry loops that ZIP archives cause.

The server returns the same decision tree in `serverInfo.instructions`. The full reference lives in [`KNOWLEDGE_BASE.md`](KNOWLEDGE_BASE.md); the stability charter in [`API_STABILITY.md`](API_STABILITY.md); the topic guides in [`guides/`](guides/) (security, determinism, incremental modification, conformance, governance, local testing). Worked invocations are in [`../examples/`](../examples).

---

## 1. Decision tree — pick the right tool in one step

| You want to… | Tool |
|---|---|
| Know what an archive is (sizes, counts, methods, Zip64, encryption, symlinks, duplicates, unsafe names, a determinism verdict, every diagnostic) in one call | `inspect_zip` *(opens eagerly by default — every entry's real extent is checked: overlaps, reach into the central directory or past EOF, Zip64 spoofing are refused, not summarised; a method / CRC / size divergence is `verify_zip`'s job)* |
| Gate an archive in CI ("reproducible?", "no encryption?", "safe names?", "at most N entries?") | `inspect_zip` with `check: [...]` / `assert: {...}` → `checksPassed` |
| The entry inventory, paged and filterable, without decompressing anything | `list_zip_entries` *(`filter` by names / prefix / globs; `offset` + `limit`, `hasMore`)* |
| Read one file without extracting the archive (text or bytes, a byte window, the compressed payload, or a single-entry check) | `read_zip_entry` *(`name` or `index`; `encoding: 'utf8'`; `range`; `mode: 'raw'` / `'verify'`)* |
| Know whether the archive is intact and safe to trust before doing anything else | `verify_zip` *(never `isError` for an archive problem — branch on `ok` and `error.code`)* |
| Get files out — inline, or onto disk | `extract_zip` *(every guard ON; `includeData: false` = dry run that opens eagerly and refuses hostile extents before any plan; `outputMode: 'file'` + `outputDir` for the sandbox)* |
| A truncated download, a stream cut mid-way, forensics (it cannot skip an SFX prefix — it refuses one with `ZIP_SIGNATURE_MISMATCH`) | `scan_zip_forward` *(local headers only — NOT authoritative; `tolerateTruncation: true`)* |
| A self-extractor or any prepended prefix | `inspect_zip` *(reports `prependedData` / `ZIP_PREPENDED_DATA`; every random-access tool shifts the offsets; `modify_zip mode: 'compact'` drops the prefix)* |
| Plan your own extraction sink (another tool writes the files) | `sanitize_entry_paths` *(no archive needed)* |
| Build an archive from inline content or sandbox files | `create_zip` *(reproducible on one runtime by default; `compression.deterministic: true` for cross-runtime identical bytes — the only case where `summary.deterministic` is `true`; `order: 'insertion'` for EPUB / JAR; `parallel` for many large entries)* |
| Change an existing archive without recompressing what you keep | `modify_zip` *(`add` / `replace` / `remove` / `rename` / `setComment`; `mode: 'compact'` to truly delete)* |
| A CRC-32 of some bytes, a string or a sandbox file (chained, or compared with a known value) | `compute_crc32` |
| Decompress a raw DEFLATE stream (for example the payload from `read_zip_entry mode: 'raw'`) | `inflate_raw` *(`maxOutput` is mandatory)* |
| What this server can do *here* (limits, ceilings, caps, sandbox, deflate tier, error codes) | `describe_engine` *(no archive needed, never cached)* |
| Draft a GitHub issue for a human to submit | `draft_governance_issue` *(local draft, never submitted)* |

Ambiguities resolved:

- `inspect_zip` vs `list_zip_entries` vs `verify_zip` — `inspect_zip` is the one-shot summary and CI gate; `list_zip_entries` is the paged inventory (rows); `verify_zip` decompresses every entry to check CRC / size / local-header agreement and is the only "is it intact?" answer. Inspecting or listing never verifies content.
- `scan_zip_forward` vs the others — every other read tool needs the whole archive and trusts the central directory. `scan_zip_forward` trusts local headers alone; use it only when the central directory is unreachable, and compare with `list_zip_entries` whenever it is reachable.
- `read_zip_entry` vs `extract_zip` — one entry vs many; inline caps are per entry (16 MiB) and per extraction (32 MiB total). Above them, `extract_zip` in file mode or a `range` window.
- `modify_zip mode: 'append'` vs `'compact'` — both avoid recompression; only `compact` removes superseded bytes from the file.
- `compute_crc32` vs `read_zip_entry mode: 'verify'` — the first checksums bytes you already have; the second checks an entry inside an archive against its recorded CRC.

Input validation is strict: unknown top-level or nested keys are rejected with `VALIDATION_ERROR` ("Unrecognized key"), matching `additionalProperties: false`. Calling a tool name that does not exist is a JSON-RPC protocol error (`-32602`, `[UNKNOWN_TOOL] Unknown tool: <name>`), not an `isError` result.

---

## 2. Common pitfalls (these cause the most retries)

### Input forms and caps

- Every archive-consuming tool takes **exactly one** of `zipBase64` / `zipPath`. `zipBase64` is the raw archive as base64 **exactly once** — a `data:…;base64,` prefix is tolerated, but PEM text, a nested `data:` URI or base64 encoded twice are refused with `VALIDATION_ERROR` and a hint. `zipPath` is a path **relative to the sandbox** (`ZIPNATIVE_MCP_OUTPUT_DIR`) ending in a container extension (`.zip`, `.jar`, `.war`, `.ear`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, `.vsix`, `.nupkg`, `.whl`, `.apk`, `.ipa`, `.xpi`, `.crx`, `.kmz`); it is never usable when the sandbox is unset (`SECURITY_VIOLATION`).
- Entry payloads for `create_zip` / `modify_zip` take exactly one of `dataBase64` / `text` / `sourcePath` (or `directory: true`). `compute_crc32` takes one of `dataBase64` / `text` / `sourcePath`; `inflate_raw` one of `dataBase64` / `sourcePath`.
- Caps (all reported by `describe_engine.caps`): decoded `zipBase64` and the sum of inline payloads per call 128 MiB (`INPUT_TOO_LARGE`); a buffered `zipPath` / `sourcePath` 1 GiB; one inline entry 16 MiB (`ENTRY_TOO_LARGE`); inline extraction total 32 MiB and inline archive / inflate output 50 MiB (`OUTPUT_TOO_LARGE`); file output 4 GiB; `list_zip_entries` page 200 by default, 2000 at most; `create_zip` at most 100 000 entries (Zip64 auto-promotes past 65 535; the engine default `maxEntries` and the operator ceiling remain the effective bound), `modify_zip` 1000 operations, `sanitize_entry_paths` 10 000 names; `filter.names` 1000, `filter.glob` 32, `extraFields` 16 per entry, `fields` 16 paths, `scan_zip_forward` default `maxEntries` 10 000 (clamped to the ceiling), 50 resource links, `range.length` 16 MiB, `resources/list` 1000 entries / depth 8 / 50 MiB per read, cache 3600 s / 256 MiB; 200 distinct diagnostics per result (`diagnosticsTruncated`). The JSON-RPC frame itself is capped at 256 MiB on stdio and HTTP (413).
- Above an inline cap the remedy is always the same: `outputMode: 'file'` (needs the sandbox), a `filter`, or a `range` — and the refusal names it in `_meta.error.data.remedy`. One exception to know: a **raw** payload (`read_zip_entry mode: 'raw'`) above 16 MiB is not retrievable inline at all; a `range` in `mode: 'data'` or `extract_zip` file mode gives you the *decompressed* content instead.

### `verify_zip`: `ok: false` is not `isError`

`verify_zip` never fails for a problem *with the archive*. Read `structuredContent`:

- `error: { code: 'ZIP_*', message }` — the structure was refused (not a ZIP, truncated, overlapping entries, central/local divergence, Zip64 spoofing…). `ok` is `false`, no entries were checked.
- `error: null`, `ok: false` — the structure opened but at least one entry failed its CRC / size / local-header check (`failedCount`, `entries: 'failed'` to see which).
- `skipped: 'encrypted' | 'stream-only-codec'` rows are unverifiable and **do not** fail the archive.

Only caller mistakes (bad `limits`, bad input) are `isError`. `verbosity: 'summary'` with `fields: ['ok', 'error', 'failedCount', 'skippedCount']` is the smallest probe.

### Extraction guards (`extract_zip`)

- Every guard is ON by default and the refusal carries a frozen `ZIP_*` code: zip-slip / absolute / drive / UNC / NUL / NTFS ADS / Windows device names → `ZIP_PATH_TRAVERSAL`; symlinks → `ZIP_SYMLINK_REJECTED`; two entries mapping to one sanitized path → `ZIP_EXTRACT_DUPLICATE_PATH`; declared sizes or ratios beyond `limits` → `ZIP_LIMIT_EXCEEDED`. Overlapping entries (`ZIP_ENTRY_OVERLAP`) and central/local divergence (`ZIP_CD_LFH_MISMATCH`) are always refused — there is no opt-out.
- Relaxations are named inputs, never silent: `rejectTraversal: false` **skips** unsafe names (listed in `skipped`, never emitted); `rejectSymlinks: false` extracts the link **target text as data**, never a link; `onDuplicate: 'first' | 'last'` resolves shadowing deliberately.
- `includeData: false` is a dry run: the plan (sanitized paths, sizes, CRCs) with nothing decompressed. The archive is opened **eagerly** before the plan in both modes, so the dry run runs the same open-time guards as the extraction — overlapping entries, entries reaching into the central directory or past EOF and Zip64 spoofing are refused before any plan row (and a file-mode extraction fails before its first write). A central/local divergence of method, CRC or sizes is *not* an extent problem: it is detected when the entry is read, and `verify_zip` (`localHeaderMatch`) is the one-call gate for it. Directories are implied by paths; `emptyDirectories: true` (file mode) also creates the explicit ones.
- File mode needs `outputDir` (relative, inside the sandbox) and never overwrites (`OUTPUT_EXISTS`); the result carries a `resource_link` per written file (at most 50 — the rest are in `entries[].filePath`).
- Encrypted entries are refused (`ZIP_UNSUPPORTED_ENCRYPTION`); there is no decryption in this engine. Filter them out (`filter`) or read the rest.

### Data remanence (`modify_zip mode: 'append'`)

- `mode: 'append'` (the default) is the engine's `save()`: the original bytes stay **verbatim** as a prefix, the edits are appended, a new central directory is written. Fast and byte-preserving — and every `remove`d or `replace`d payload **remains inside the file**, recoverable by anyone with a hex editor. The `ZIP_DEAD_BYTES_RATIO` diagnostic fires past 50 % dead bytes, and 7-Zip is known to read the **stale** payload of a replaced entry instead of the new one.
- `mode: 'compact'` is `saveCompact()`: a canonical rewrite, still without recompression, removed data truly gone, an SFX prefix dropped. Use it to delete secrets, to interoperate with 7-Zip, or when dead bytes pile up.
- Operations run in order. `add` fails on an existing name (`ZIP_ENTRY_EXISTS`), `replace` on a missing one (`ZIP_ENTRY_NOT_FOUND`), `rename` **never overwrites** — `remove` the target first. No edits and an unchanged comment return the same bytes (`summary.noOp: true`). Archives with duplicate entry names are refused (`ZIP_DUPLICATE_ENTRY_NAME`): rebuild them with `create_zip`.

### Reproducibility and the deterministic pin (`create_zip`)

- Defaults are reproducible on one runtime: canonical order (raw UTF-8 name bytes), DOS-epoch timestamps (1980-01-01), UTF-8 names with the EFS flag, constant attributes, Zip64 exactly when a field overflows.
- `defaultDate: 'now'` (or a wall-clock per-entry `date`) opts out: the `ZIP_TIMESTAMP_NOT_PINNED` diagnostic fires and `summary.deterministic` is `false`. Pin an ISO instant instead (1980-01-01 … 2107-12-31, 2-second DOS granularity).
- `compression: { deterministic: true }` pins the pure-TS deflate encoder so the bytes are identical on every runtime (slower); `summary.deflateTier` reports `pure-pinned`. Without it the bytes are stable per environment only (`node-zlib`) and `summary.deterministic` stays `false` even though the *layout* is reproducible — `inspect_zip` `determinism.deterministic` reports that structural verdict separately (it requires epoch timestamps, so a pinned non-epoch date reproduces but reports `false` there). Three verdicts, three questions: `summary.deterministic` = "identical on every runtime?", `summary.sha256` = "the proof", `inspect_zip.determinism` = "canonical structure, whoever wrote it?".
- `stream: true` entries use the data-descriptor layout: reproducible, but `inspect_zip` reports `canonicalLayout: false`. `parallel` is byte-identical to the sequential writer (per tier). Extra fields you pass are embedded verbatim — their determinism is yours.
- Proof: `includeSha256: true` twice → equal `summary.sha256`; or `inspect_zip check: ['deterministic', 'canonical-layout']` on the result. Full contract: [`guides/DETERMINISM.md`](guides/DETERMINISM.md).

### Forward-scan trust (`scan_zip_forward`)

- It reads local headers **alone**. A hostile archive can present different names, sizes and methods here than `inspect_zip` / `list_zip_entries` report — the upload-scanner differential. The result says so (`trust: 'local-headers-only'`). Treat disagreements as hostile.
- `data: 'none'` (default) skips payloads — but a data-descriptor (bit 3) entry still costs a full decompress-and-discard, and store + bit 3 / encrypted + bit 3 are refused (`ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`). `data: 'verify'` checks CRCs; `data: 'include'` returns content (inline caps).
- `stoppedAt` tells you how the scan ended: `'central-directory'` (normal), `'eof'` (no central directory — truncated or CD-less), `'max-entries'`, `'error'` (with `tolerateTruncation: true`, plus `error: { code, message }` and the partial inventory). Descriptor rows carry zero sizes and CRC `00000000` in their local header.
- Names are **not** sanitized here — use `sanitizedPath` (or `sanitize_entry_paths`) before touching a filesystem.

### Entry names

- Names are `/`-separated and **case-sensitive** (`README.md` ≠ `readme.md`). `ZIP_ENTRY_NOT_FOUND` names the remedy: call `list_zip_entries` for the exact names.
- `read_zip_entry` by `name` returns the **last** duplicate; pass `index` (the central-directory position from `list_zip_entries`) to pick another. Duplicates are reported by `inspect_zip.duplicateNameCount` and the `ZIP_DUPLICATE_NAME` diagnostic.
- Directory entries end in `/`; `filter.includeDirectories` (default `false` for extraction, `true` for listing and scanning) controls whether they appear.

### `limits` vs ceilings

- `limits.*` (the engine's eight `ZipLimits` bounds: `maxEntries`, `maxEntryUncompressedSize`, `maxTotalUncompressedSize`, `maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`, `maxCommentBytes`, `maxCentralDirectoryBytes`) raise or lower the engine's bounds for **this call** — for trusted input only. The engine enforces them *while* inflating, not after.
- They can never exceed the operator ceilings: `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` (default 8 GiB; bounds the two size limits), `ZIPNATIVE_MCP_MAX_ENTRIES` (default 100 000; also bounds `scan_zip_forward.maxEntries`, whose default of 10 000 is clamped to the ceiling — only an explicit value above it is refused), `ZIPNATIVE_MCP_WORKERS` (default 8; bounds `create_zip.parallel.workers`, whose default is the engine's `max(1, min(cores − 1, 8))`; 0 disables workers). A request above a ceiling is `LIMIT_CEILING_EXCEEDED` and `_meta.error.data.env` names the variable the operator would raise — you cannot raise it yourself. A ceiling below an engine default tightens the default silently.
- `describe_engine` reports both (`defaultLimits`, `ceilings`).

### File mode and the sandbox

- `outputMode: 'file'`, `outputDir`, `zipPath` and `sourcePath` only work when the host set `ZIPNATIVE_MCP_OUTPUT_DIR`. Otherwise every file input and output is `SECURITY_VIOLATION` and the tools work on base64 only.
- Paths are **relative**, no `..`, no absolute / UNC / drive prefix, no NUL. `outputPath` must end in a container extension (`.zip` recommended; `.md` for `draft_governance_issue`; `inflate_raw` accepts `.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`). `sourcePath` may have any extension.
- The **real** path of every file read (`zipPath`, `sourcePath`, `resources/read`) and of every parent written must stay inside the sandbox: a symlink or junction planted there is `SECURITY_VIOLATION` on both sides.
- The server **never overwrites** (`OUTPUT_EXISTS`) — choose another path. A file written in file mode is listed under `resources/list` as `zipnative://output/<path>` and the result carries a `resource_link`; a path you wrote can be read back by any tool through `zipPath` without re-sending the bytes.
- `draft_governance_issue` uses `outputMode: 'inline' | 'file'` (not `'base64'`).

### Token-frugal projections

The read tools (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `describe_engine`) accept two optional inputs:

- `verbosity: 'summary'` swaps the full result for a scalar-only subset: `inspect_zip` → `{ archiveBytes, entryCount, isZip64, compressedBytes, uncompressedBytes, encryptedCount, unsafeNameCount, duplicateNameCount, deterministic, canonicalLayout, diagnosticCount, checksPassed? }`; `list_zip_entries` → counts + `names[]`; `read_zip_entry` → `{ name, index, mode, sizeBytes, crcVerified, textLength?, range?, verification?, diagnosticCount }`; `verify_zip` → the verdict + counts; `extract_zip` → counts + `paths[]`; `scan_zip_forward` → `{ trust, entryCount, keptCount, stoppedAt, truncated, names[], error?, diagnosticCount }`; `sanitize_entry_paths` → counts + `rejectedNames[]`; `describe_engine` → `{ server, engine, capabilities, sandbox, network }`.
- `fields: ['a', 'b.c']` projects to named dot-paths (an array segment maps over every element, e.g. `['entries.name', 'entries.uncompressedSize']`). It composes **after** `verbosity`; unmatched paths are omitted leniently and reported in `_meta.unmatchedFields` + `_meta.availableFields`.

Defaults are unchanged: omit both and you get the full shape. Produced archives (base64 mode) arrive **once** as an embedded `resource` content block (a `data:application/zip;base64,…` URI, `application/octet-stream` for `inflate_raw`), not duplicated into `structuredContent` (which is `{ mode, sizeBytes, summary, diagnostics, … }`).

### Response cache

With `ZIPNATIVE_MCP_CACHE_DIR` set, a repeated identical call (same tool, same input) may be answered from cache — the result carries `_meta.cached: true` — within a 1 h TTL. Never cached: any `zipPath` / `sourcePath` input (a path is a reference, not content), `outputMode: 'file'`, `defaultDate: 'now'`, any `parallel` request, `describe_engine`, `draft_governance_issue`. The key is namespaced by the tool API version, the package version **and** the engine version, so an upgrade never serves old bytes.

### Protocol eras

- The server speaks MCP 2026-07-28 (stateless, `server/discover`, `resultType`, cache hints) and falls back automatically to the 2025-era `initialize` handshake. Whatever your host negotiates, the `tools/call` payload is the same.
- `tools/list` and `prompts/list` are safe to cache for 24 h (`cacheScope: 'public'`); `resources/*` results are private and must not be cached.
- Seven MCP prompts are advertised — `governance_contract`, `draft_issue_workflow`, `secure_extraction`, `reproducible_archive`, `incremental_update`, `forensic_scan`, `verify_before_trust` — read the one matching your workflow before the first call.
- Over HTTP (`ZIPNATIVE_MCP_PORT`), the operator may require a bearer token (`ZIPNATIVE_MCP_HTTP_TOKEN`): send `Authorization: Bearer <token>` or every `/mcp` request is answered 401. Without it HTTP mode has no authentication (loopback bind + Host / Origin guard only). stdio is unaffected.
- Operator environment, for reference (an agent never sets these): `ZIPNATIVE_MCP_OUTPUT_DIR`, `ZIPNATIVE_MCP_CACHE_DIR`, `ZIPNATIVE_MCP_PORT`, `ZIPNATIVE_MCP_HTTP_TOKEN`, `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`. Full table: `AGENTS.md` §4.
- There is **no network path** in this server: no telemetry, no GitHub, no URL from any argument, ever.

### Drafting a GitHub issue (human-in-the-loop)

- `draft_governance_issue` produces a **local** draft + a compliance report. It never submits and makes no network call — you are a draftsman; a human is the only gate.
- Always set `duplicateSearchPerformed: true` (after actually searching) and include `reproduction: { command, result }`. Proposing a runtime dependency, omitting the reproduction, or `duplicateSearchPerformed: false` is `GOVERNANCE_VIOLATION`.
- `targetRepo: 'zipnative'` for engine behaviour (parsing, writing, limits, codecs), `'zipnative-mcp'` for wrapper behaviour (schemas, sandbox, transport). Contract: [`guides/AI_GOVERNANCE.md`](guides/AI_GOVERNANCE.md).

---

## 3. Recipes (multi-tool workflows)

### Untrusted-archive intake (every guard stays on)

1. `verify_zip { zipBase64, verbosity: 'summary' }` — branch on `ok` and `error.code`. `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION` are active-attack shapes: stop here.
2. `inspect_zip { check: ['safe-names', 'no-encryption', 'no-symlinks', 'no-duplicates'], assert: { maxUncompressedBytes: 268435456, maxRatio: 100 } }` → `checksPassed`.
3. `extract_zip { includeData: false }` — the dry-run plan: sanitized paths, sizes, nothing decompressed; the archive is opened eagerly first, so an overlapping / offset-into-CD / Zip64-spoofed shape is refused here before any plan (a method / CRC / size divergence is what step 1 caught).
4. `extract_zip { outputMode: 'file', outputDir: 'intake/<id>' }` (or inline with a `filter`). Keep the guard defaults; relax only when you have read the entry list and accept the consequence.

The `secure_extraction` and `verify_before_trust` prompts return these steps.

### Reproducible build with proof

1. `create_zip { entries, compression: { deterministic: true }, includeSha256: true }` — omit `defaultDate` (epoch) or pass one fixed ISO instant.
2. Repeat the call (or run it on another machine): `summary.sha256` must be equal; `summary.deterministic` is `true` and `summary.deflateTier` is `pure-pinned`.
3. *(optional)* `inspect_zip { check: ['deterministic', 'canonical-layout', 'utf8-names'] }` on the result.

### EPUB / JAR layout (mimetype first, stored)

1. `create_zip { entries: [{ name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } }, { name: 'META-INF/container.xml', text: '…' }, …], order: 'insertion', outputMode: 'file', outputPath: 'book.epub' }` — `order: 'insertion'` keeps the call order (still deterministic given the same calls).
2. `list_zip_entries { zipPath: 'book.epub', limit: 1, fields: ['entries.name', 'entries.methodName'] }` — confirm `mimetype` is first and stored.

### Incremental update, then compact

1. `modify_zip { zipBase64, operations: [{ op: 'replace', name: 'config.json', text: '…' }, { op: 'add', name: 'CHANGES.md', text: '…' }] }` — append mode: fast, original bytes preserved, superseded payload still inside.
2. Later, or before shipping: `modify_zip { …, operations: [{ op: 'remove', name: '.env' }], mode: 'compact' }` — the canonical rewrite; removed data truly gone. Watch `ZIP_DEAD_BYTES_RATIO` in `diagnostics` as the signal that compaction is due. Details: [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md).

### Manifest peek (read one file without extracting)

1. `list_zip_entries { zipBase64, filter: { glob: ['META-INF/*.MF', '**/package.json'] }, verbosity: 'summary' }` — find the exact name.
2. `read_zip_entry { zipBase64, name: 'META-INF/MANIFEST.MF', encoding: 'utf8' }` — the text; `ENTRY_NOT_UTF8` means read it as base64. For a large log, `range: { offset: 0, length: 4096 }` reads a window through the chunked stream.

### Forensic scan of a damaged or streamed archive

1. `inspect_zip` fails with `ZIP_EOCD_NOT_FOUND` / `ZIP_RECORD_TRUNCATED` → the central directory is unreachable.
2. `scan_zip_forward { zipBase64, tolerateTruncation: true, data: 'verify' }` — the partial inventory in stream order, CRCs checked where a payload is complete, `stoppedAt` + `error` for the cut.
3. Compare names with `sanitize_entry_paths` before writing anything; never trust the sizes of descriptor rows. The `forensic_scan` prompt returns these steps.

### Chain via `zipPath` (never re-send the bytes)

1. `create_zip { …, outputMode: 'file', outputPath: 'build/app.zip' }` → `resource_link zipnative://output/build/app.zip`.
2. `modify_zip { zipPath: 'build/app.zip', operations: […], outputMode: 'file', outputPath: 'build/app-v2.zip' }`.
3. `verify_zip { zipPath: 'build/app-v2.zip' }` → `extract_zip { zipPath: 'build/app-v2.zip', outputMode: 'file', outputDir: 'unpacked' }`. Every step stays inside `ZIPNATIVE_MCP_OUTPUT_DIR`; a path input is never cached.

### CI gate

1. `inspect_zip { zipPath: 'dist/release.zip', check: ['deterministic', 'canonical-layout', 'no-encryption', 'safe-names', 'no-duplicates', 'deflate-only'], assert: { has: ['META-INF/MANIFEST.MF'], maxEntries: 5000 }, verbosity: 'summary', fields: ['checksPassed', 'checks'] }`.
2. `verify_zip { zipPath: 'dist/release.zip', entries: 'failed', verbosity: 'summary' }` — fail the job on `ok: false` or `checksPassed: false`. `strict: true` on `inspect_zip` turns the first diagnostic (an SFX prefix, a name mismatch, …) into `ZIP_STRICT_DIAGNOSTIC`.

### Raw payload → inflate

1. `read_zip_entry { zipBase64, name: 'data.bin', mode: 'raw' }` — the compressed payload verbatim (`entry.methodName` tells you `deflate` or `store`).
2. `inflate_raw { dataBase64: <that payload>, maxOutput: <entry.uncompressedSize> }` — bounded decompression; `summary.bytesConsumed`, `leftover`, `finished`. `compute_crc32 { dataBase64: <inflated>, expect: <entry.crc32> }` → `matches: true` closes the loop.

### Propose an upstream change (human submits)

1. Search existing issues, then `draft_governance_issue` with a reproduction and `duplicateSearchPerformed: true`; `targetRepo: 'zipnative'` when the engine is at fault.
2. Present the returned `draftMarkdown` and `compliance` report to the user; a **human** copies the draft into GitHub and submits it. The server never does.

---

## 4. Self-documenting metadata

Every tool ships:

- `_meta.apiVersion` = `'1.0.0'` — see [`API_STABILITY.md`](API_STABILITY.md).
- `_meta.examples` — one or two executable worked examples per tool (the rest live in [`../examples/`](../examples), executed by `tests/examples.test.ts`). Inspect the `tools/list` response to discover them.
- `annotations` — `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`; `openWorldHint` is `false` on every tool (no network).
- `outputSchema` — the read tools declare a **projectable** schema (every property optional, `additionalProperties: false`, summary-only scalars declared) so `structuredContent` validates under `verbosity` / `fields` as well; `create_zip`, `modify_zip` and `inflate_raw` extend the shared `ARCHIVE_OUTPUT_SCHEMA` with their own typed `summary` (`deterministic` / `deflateTier` / `parallel` / `sha256`, `saveMode` / `noOp` / `grewByBytes`, `bytesConsumed` / `leftover` / `finished` — every key optional).
- Every result carries `diagnostics[]` (de-duplicated by code + entry, at most 200) and `diagnosticCounts` — for ZIP they **are** the signal (an SFX prefix, a name mismatch, duplicate names, an unpinned timestamp, dead bytes after an incremental save).

Error results carry `_meta.error = { code, message, data? }` next to `content[0].text` (`<tool> failed [CODE]: message`) and `isError: true`, so a structured consumer never has to parse the text.

---

## 5. When things fail

### The error envelope

```jsonc
{
  "isError": true,
  "content": [{ "type": "text", "text": "extract_zip failed [ZIP_PATH_TRAVERSAL]: Failed to extract archive: zipnative: entry \"../../etc/passwd\" escapes the extraction root …" }],
  "_meta": { "error": { "code": "ZIP_PATH_TRAVERSAL", "message": "…", "data": { "errorClass": "security", "engineError": "ZipSecurityError", "entryName": "../../etc/passwd" } } }
}
```

- `code` is either one of the **wrapper codes** below or one of the engine's **39 frozen `ZIP_*` codes**, carried verbatim. Branch on the code, never on the message.
- `message` keeps the engine's text, which **names the remedy** (the option to pass, the tool to call, or "re-obtain the archive").
- `data` carries the machine-readable detail: `errorClass` (`parse` / `security` / `data` / `limit` / `unsupported` / `not-found` / `input` / `usage` / `check` / `internal`), `engineError` (the engine class name), `entryName`, and per class `limit` / `configured` / `observed` (`ZIP_LIMIT_EXCEEDED`), `feature` (`ZIP_UNSUPPORTED_*`), `expectedCrc` / `actualCrc` (`ZIP_CRC_MISMATCH`), `operationIndex` / `op` (`modify_zip`), `entryIndex` (`create_zip`), `writtenCount` (`extract_zip` file mode), `cap` (the inline caps), `ceiling` / `env` (`LIMIT_CEILING_EXCEEDED`), and `remedy` — an optional machine-actionable hint from a closed vocabulary: `outputMode:'file'` (`extract_zip` above an inline cap), `range` (`read_zip_entry` above 16 MiB), `filter`, `encoding:'base64'`, `data:'verify'` (`scan_zip_forward` `data: 'include'` above the caps), `list_zip_entries` (an out-of-range `index`), `resources/list` (a missing `zipPath` / `sourcePath`), `maxEntries ≤ N` (`scan_zip_forward` above the ceiling). Branch on `code`; use `remedy` to pick the retry without parsing the message.

### Wrapper codes

| `code` | Meaning | Fix |
|---|---|---|
| `VALIDATION_ERROR` | Zod rejected the input: wrong type, unknown key (strict), both or neither of `zipBase64` / `zipPath`, malformed base64 (PEM, nested `data:` URI, double-encoded, empty), a `date` outside 1980–2107, an unparsable `unixMode`, extra field id `0x0001` | Re-read the field's schema (the message lists the offending path); pass the raw archive bytes as base64 exactly once. |
| `INPUT_TOO_LARGE` | Decoded input above 128 MiB (inline) or 1 GiB (`zipPath` / `sourcePath`) | Use the sandbox (`zipPath`, `sourcePath`, file mode) or split the input. |
| `INPUT_NOT_FOUND` | `zipPath` / `sourcePath` does not exist in the sandbox or is not a regular file | List `resources/list`; fix the relative path. |
| `ENTRY_TOO_LARGE` | One entry above the 16 MiB inline cap (`read_zip_entry` — uncompressed in `mode: 'data'`, compressed in `mode: 'raw'` —, `extract_zip`, `scan_zip_forward data: 'include'`) | Pass a `range` (`mode: 'data'`), use `outputMode: 'file'`, or `data: 'verify'` — `data.remedy` names it. A raw payload above the cap is not retrievable inline; the range and file mode give the decompressed content. |
| `ENTRY_NOT_UTF8` | `encoding: 'utf8'` on bytes that are not valid UTF-8 | Read it with `encoding: 'base64'`. |
| `OUTPUT_TOO_LARGE` | Inline output above 50 MiB, inline extraction above 32 MiB, file output above 4 GiB, a `resources/read` above 50 MiB | `outputMode: 'file'`, a `filter`, or a `range`. |
| `OUTPUT_EXISTS` | The target file already exists in the sandbox | The server never overwrites — choose another `outputPath` / `outputDir`. |
| `IO_ERROR` | The filesystem refused the write (permissions, disk full, …) | The message carries the errno; check the sandbox directory. |
| `SECURITY_VIOLATION` | Sandbox unset, absolute / UNC / `..` / NUL path, or a symlink / junction that would redirect a write (parent) or a read (`zipPath`, `sourcePath`, `resources/read` — the file itself) outside the sandbox | Set `ZIPNATIVE_MCP_OUTPUT_DIR`; pass a relative path without traversal; remove the link. |
| `MISSING_OUTPUT_PATH` | `outputMode: 'file'` without `outputPath` (`outputDir` for `extract_zip`) | Pass a relative path. |
| `INVALID_PATH` | A path input is empty or not a string | Pass a non-empty relative path. |
| `INVALID_EXTENSION` | `zipPath` / `outputPath` does not end in an allowed extension | Container extensions for archives (`.zip` recommended), `.md` for the governance draft. |
| `LIMIT_CEILING_EXCEEDED` | `limits.*`, an explicit `scan_zip_forward.maxEntries` (the default is clamped, never refused) or `parallel.workers` above an operator ceiling | `data.env` names the variable; an agent cannot raise it — ask the operator, or lower / omit the request (`data.remedy: 'maxEntries ≤ N'` for the scanner). |
| `GOVERNANCE_VIOLATION` | `draft_governance_issue` draft breaks the contract (runtime dependency proposed, no reproduction, `duplicateSearchPerformed: false`) | Fix the draft and call again. |
| `ENGINE_ERROR` | The engine threw something that is not a `ZipError` (an internal fault) | Report it with a reproduction (`draft_governance_issue`, `targetRepo: 'zipnative'`). |
| `UNKNOWN_RESOURCE` | **Protocol error** (`-32602`): `resources/read` with an unknown `zipnative://output/` URI | List URIs with `resources/list`. |
| `[UNKNOWN_TOOL]` | **Protocol error** (`-32602`): `tools/call` with a name that does not exist | Pick a name from `tools/list` (13 tools). |

### The 39 `ZIP_*` codes, by class

The full table with cause and remedy per code is in `AGENTS.md` §6 and in the machine-readable [`data/errors.json`](data/errors.json); the engine's own guide is [zipnative `docs/guides/errors.md`](https://github.com/Nizoka/zipnative/blob/main/docs/guides/errors.md).

| `data.errorClass` | Codes | What to do |
|---|---|---|
| `parse` (format) | `ZIP_EOCD_NOT_FOUND`, `ZIP_EOCD_INCONSISTENT`, `ZIP_ZIP64_LOCATOR_MISSING`, `ZIP_ZIP64_EOCD_MISPLACED`, `ZIP_CD_INCONSISTENT`, `ZIP_RECORD_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_STREAM_TRUNCATED`, `ZIP_VALUE_UNREPRESENTABLE`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DEFLATE_CORRUPT` | The bytes are not a ZIP, are truncated, or are corrupt: re-obtain the archive. `scan_zip_forward tolerateTruncation: true` salvages the inventory of a truncated one. |
| `security` | `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION` (no opt-out) · `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH` (named relaxations) | The first three are active-attack shapes: stop. The last three name the relaxation (`rejectTraversal: false` skips, `rejectSymlinks: false` writes the target text, `onDuplicate: 'first' | 'last'`). |
| `data` | `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_DECOMPRESSION_FAILED` | The content or its metadata lies: treat as corrupt or hostile. `verify_zip` reports these as rows instead of failing. |
| `limit` | `ZIP_LIMIT_EXCEEDED` (`data.limit`, `configured`, `observed`), `ZIP_INPUT_TOO_LARGE` | Raise `limits.<limit>` for trusted input only (within the ceilings). |
| `unsupported` | `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_UNSUPPORTED_ZIP64_STREAMING`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_UNSUPPORTED_CODEC_MODE` | Deliberate refusals; `data.feature` says which. No encryption in this engine; no codec beyond store / deflate in this server; buffer instead of `stream: true` above 4 GiB; use the whole archive instead of a forward scan. |
| `not-found` / `input` / `usage` | `ZIP_ENTRY_NOT_FOUND` · `ZIP_ENTRY_EXISTS`, `ZIP_INVALID_ENTRY_NAME`, `ZIP_DUPLICATE_ENTRY_NAME` · `ZIP_INVALID_OPTION`, `ZIP_LIMIT_INVALID` | Names are case-sensitive (`list_zip_entries`); use `replace` over an existing name; relative `/`-separated names without `..`; unique names. |
| `check` / `internal` | `ZIP_STRICT_DIAGNOSTIC` · `ZIP_API_MISUSE`, `ZIP_INTERNAL` | `strict: true` escalated a diagnostic (drop `strict`, or fix the producer it names). The internal pair is a bug: draft an upstream issue with the archive. |

### When to draft an upstream issue

- **Engine root cause** (`ZIP_INTERNAL`, `ZIP_API_MISUSE`, `ENGINE_ERROR`, a wrong verdict from `verify_zip` / `inspect_zip`, a non-conformant archive from `create_zip`, a parse refusal on an archive every other tool opens): `draft_governance_issue` with `targetRepo: 'zipnative'`, the archive (or the `create_zip` arguments that produce it) as the reproduction, and the `_meta.error` block as the result. Then hand the draft to a human.
- **Wrapper root cause** (a schema mismatch, a sandbox refusal on a legitimate path, a projection that drops a field, a wrong `_meta.error.data` shape): `targetRepo: 'zipnative-mcp'`.
- **Not a bug:** a refusal whose message names a relaxation or a limit — that is the security posture working; relax it deliberately or ask the operator.

If a tool returns an archive that a downstream reader rejects, run `verify_zip` and `inspect_zip` on it first — and remember that ISO/IEC 21320-1 conformance (which every archive this server writes has, validated in CI) does not make a *hostile* archive safe: see [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md).
