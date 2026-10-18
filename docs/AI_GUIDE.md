# AI Agent Guide — zipnative-mcp

> **Read this first if you are an AI agent (Claude, Copilot, Cursor, Continue, Zed, Windsurf, Cline, Roo Code, …) about to call zipnative-mcp.**
> It tells you which of the 15 tools to pick and how to avoid the retry loops that ZIP archives cause.

The server returns the same decision tree in the `instructions` field of the opening exchange (initialize / server/discover result). The full reference lives in [`KNOWLEDGE_BASE.md`](KNOWLEDGE_BASE.md); the stability charter in [`API_STABILITY.md`](API_STABILITY.md); the topic guides in [`guides/`](guides/) (security, determinism, incremental modification, large archives, conformance, governance, local testing). Worked invocations are in [`../examples/`](../examples).

---

## 1. Decision tree — pick the right tool in one step

| You want to… | Tool |
|---|---|
| Know what an archive is (sizes, counts, methods, Zip64, encryption, symlinks, duplicates, unsafe names, a determinism verdict, every diagnostic) in one call | `inspect_zip` *(opens eagerly by default — every entry's real extent is checked: overlaps, reach into the central directory or past EOF, Zip64 spoofing are refused, not summarised; a method / CRC / size divergence is `verify_zip`'s job)* |
| Gate an archive in CI ("reproducible?", "no encryption?", "safe names?", "at most N entries?") | `inspect_zip` with `check: [...]` / `assert: {...}` → `checksPassed` |
| Know *why* an archive is not reproducible (every offending entry and the rule it breaks) | `inspect_zip` with `determinismReport: true` *(the engine's `analyzeDeterminism()` report; `check: ['canonical-form']` gates on it)* |
| The entry inventory, paged and filterable, without decompressing anything | `list_zip_entries` *(`filter` by names / prefix / globs; `offset` + `limit`, `hasMore`; `includeExtendedTimestamps` / `includeUnixIds` on request)* |
| Read one file without extracting the archive (text or bytes, a byte window, the compressed payload, or a single-entry check) | `read_zip_entry` *(`name` or `index`; `encoding: 'utf8'`; `range`; `mode: 'raw'` / `'verify'`)* |
| Read from a sandbox archive larger than the 1 GiB in-memory cap | `inspect_zip` / `list_zip_entries` / `read_zip_entry` with `zipPath` *(`access: 'auto'` switches to byte ranges by itself; `access: 'range'` forces it — [`guides/LARGE_ARCHIVES.md`](guides/LARGE_ARCHIVES.md))* |
| Know whether the archive is intact and safe to trust before doing anything else | `verify_zip` *(never `isError` for an archive problem — branch on `ok` and `error.code`)* |
| Get files out — inline, or onto disk | `extract_zip` *(every guard ON; `includeData: false` = dry run that opens eagerly and refuses hostile extents before any plan; `outputMode: 'file'` + `outputDir` for the sandbox)* |
| A truncated download, a stream cut mid-way, forensics (it cannot skip an SFX prefix — it refuses one with `ZIP_SIGNATURE_MISMATCH`) | `scan_zip_forward` *(local headers only — NOT authoritative; `tolerateTruncation: true`)* |
| A self-extractor or any prepended prefix | `inspect_zip` *(reports `prependedData` / `ZIP_PREPENDED_DATA`; every random-access tool shifts the offsets; `modify_zip mode: 'compact'` drops the prefix)* |
| Plan your own extraction sink (another tool writes the files) | `sanitize_entry_paths` *(no archive needed)* |
| Build an archive from inline content or sandbox files | `create_zip` *(reproducible on one runtime by default; `compression.deterministic: true` for cross-runtime identical bytes — the only case where `summary.deterministic` is `true`; `order: 'insertion'` for EPUB / JAR; `parallel` for many large entries; `stream: true` + `zip64: true` for a sandbox file that may exceed 4 GiB)* |
| Change an existing archive without recompressing what you keep | `modify_zip` *(`add` / `replace` / `remove` / `rename` / `setComment`; `mode: 'compact'` to truly delete; `canonical: {}` with `compact` for the canonical form in the same call)* |
| Make an archive you did not build reproducible (Gradle, Maven, `zip`, Explorer, 7-Zip, an append-mode save) | `canonicalize_zip` *(the canonical deterministic form without recompression; idempotent; `summary.canonicalForm` is the engine's own re-check)* |
| Combine several archives into one without recompressing | `merge_zip` *(1–32 `sources`, each entry CRC- and size-checked first — an entry with no codec here is refused; `onConflict: 'error' | 'first' | 'last'`)* |
| A CRC-32 of some bytes, a string or a sandbox file (chained, or compared with a known value) | `compute_crc32` |
| Decompress a raw DEFLATE stream (for example the payload from `read_zip_entry mode: 'raw'`) | `inflate_raw` *(`maxOutput` is mandatory)* |
| What this server can do *here* (limits, ceilings, caps, sandbox, deflate tier, error codes) | `describe_engine` *(no archive needed, never cached)* |
| Draft a GitHub issue for a human to submit | `draft_governance_issue` *(local draft, never submitted)* |

Ambiguities resolved:

- `inspect_zip` vs `list_zip_entries` vs `verify_zip` — `inspect_zip` is the one-shot summary and CI gate; `list_zip_entries` is the paged inventory (rows); `verify_zip` decompresses every entry to check CRC / size / local-header agreement and is the only "is it intact?" answer. Inspecting or listing never verifies content.
- `scan_zip_forward` vs the others — every other read tool trusts the central directory, so it needs the archive's end: the whole archive in memory, or, for `inspect_zip` / `list_zip_entries` / `read_zip_entry` on a sandbox `zipPath`, byte ranges of the complete file (`access: 'range'`). `scan_zip_forward` trusts local headers alone; use it only when the central directory is unreachable, and compare with `list_zip_entries` whenever it is reachable.
- `read_zip_entry` vs `extract_zip` — one entry vs many; inline caps are per entry (16 MiB) and per extraction (32 MiB total). Above them, `extract_zip` in file mode or a `range` window.
- `modify_zip mode: 'append'` vs `'compact'` — both avoid recompression; only `compact` removes superseded bytes from the file.
- `compute_crc32` vs `read_zip_entry mode: 'verify'` — the first checksums bytes you already have; the second checks an entry inside an archive against its recorded CRC.
- `canonicalize_zip` vs `modify_zip mode: 'compact'` + `canonical` vs `create_zip` — `create_zip` builds from content (and is the only one that compresses); `canonicalize_zip` normalises an existing archive with no edit; `modify_zip` with `mode: 'compact'` and `canonical: {}` edits first, then normalises. The canonical form is the same in the last two.
- `merge_zip` vs `modify_zip` `add` — `merge_zip` takes entries from other archives as they are (compressed bytes, CRC, timestamps, attributes); `modify_zip` adds new content you supply.

Input validation is strict: unknown top-level or nested keys are rejected with `VALIDATION_ERROR` ("Unrecognized key"), matching `additionalProperties: false`. Calling a tool name that does not exist is a JSON-RPC protocol error (`-32602`, `[UNKNOWN_TOOL] Unknown tool: <name>`), not an `isError` result.

---

## 2. Common pitfalls (these cause the most retries)

### Input forms and caps

- Every archive-consuming tool takes **exactly one** of `zipBase64` / `zipPath`. `zipBase64` is the raw archive as base64 **exactly once** — a `data:…;base64,` prefix is tolerated, but PEM text, a nested `data:` URI or base64 encoded twice are refused with `VALIDATION_ERROR` and a hint. `zipPath` is a path **relative to the sandbox** (`ZIPNATIVE_MCP_OUTPUT_DIR`) ending in a container extension (`.zip`, `.jar`, `.war`, `.ear`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, `.vsix`, `.nupkg`, `.whl`, `.apk`, `.ipa`, `.xpi`, `.crx`, `.kmz`); it is never usable when the sandbox is unset (`SECURITY_VIOLATION`).
- Entry payloads for `create_zip` / `modify_zip` take exactly one of `dataBase64` / `text` / `sourcePath` (or `directory: true`). `compute_crc32` takes one of `dataBase64` / `text` / `sourcePath`; `inflate_raw` one of `dataBase64` / `sourcePath`.
- Caps (all reported by `describe_engine.caps`): decoded `zipBase64` and the sum of inline payloads per call 128 MiB (`INPUT_TOO_LARGE`); a buffered `zipPath` / `sourcePath` 1 GiB (above it, `inspect_zip` / `list_zip_entries` / `read_zip_entry` read by byte ranges instead of refusing); one inline entry 16 MiB (`ENTRY_TOO_LARGE`); inline extraction total 32 MiB and inline archive / inflate output 50 MiB (`OUTPUT_TOO_LARGE`); file output 4 GiB by default (the operator ceiling `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`); `list_zip_entries` page 200 by default, 2000 at most; `create_zip` at most 100 000 entries (Zip64 auto-promotes past 65 535; the engine default `maxEntries` and the operator ceiling remain the effective bound), `modify_zip` 1000 operations, `merge_zip` 32 sources and 1 GiB of sources in all, `sanitize_entry_paths` 10 000 names; `filter.names` 1000, `filter.glob` 32 patterns of at most 1024 characters (use `names` or `prefix` for a literal name longer than that), `extraFields` 16 per entry, `fields` 16 paths, `scan_zip_forward` default `maxEntries` 10 000 (clamped to the ceiling), 50 resource links, `range.length` 16 MiB, `resources/list` 1000 entries / depth 8 / 50 MiB per read, cache 3600 s / 256 MiB, 16 384 characters per `draft_governance_issue` text field; 200 distinct diagnostics and 200 determinism offenders per result. The JSON-RPC frame itself is capped at 256 MiB on stdio and HTTP (413).
- Above an inline cap the remedy is always the same: `outputMode: 'file'` (needs the sandbox), a `filter`, or a `range` — and the refusal names it in `_meta.error.data.remedy`. One exception to know: a **raw** payload (`read_zip_entry mode: 'raw'`) above 16 MiB is not retrievable inline at all; a `range` in `mode: 'data'` or `extract_zip` file mode gives you the *decompressed* content instead.

### `verify_zip`: `ok: false` is not `isError`

`verify_zip` never fails for a problem *with the archive*. Read `structuredContent`:

- `error: { code: 'ZIP_*', message }` — the structure was refused (not a ZIP, truncated, overlapping entries, central/local divergence, Zip64 spoofing…). `ok` is `false`, no entries were checked.
- `error: null`, `ok: false` — the structure opened but at least one entry failed its CRC / size / local-header check (`failedCount`, `entries: 'failed'` to see which).
- `skipped: 'encrypted' | 'stream-only-codec'` rows are unverifiable by design and **do not** fail the archive — provided their local header agrees with the central directory (`skippedCount`). An encrypted entry whose local header contradicts the central directory is counted **failed**, and so is `skipped: 'unsupported-method'` (no codec for the entry's method here): the engine's archive rule, verbatim.

Only caller mistakes (bad `limits`, bad input) are `isError`. `verbosity: 'summary'` with `fields: ['ok', 'error', 'failedCount', 'skippedCount']` is the smallest probe.

### Extraction guards (`extract_zip`)

- Every guard is ON by default and the refusal carries a frozen `ZIP_*` code: zip-slip / absolute / drive / UNC / NUL / NTFS ADS / Windows device names → `ZIP_PATH_TRAVERSAL`; symlinks → `ZIP_SYMLINK_REJECTED`; two entries mapping to one sanitized path → `ZIP_EXTRACT_DUPLICATE_PATH`; declared sizes or ratios beyond `limits` → `ZIP_LIMIT_EXCEEDED`. Overlapping entries (`ZIP_ENTRY_OVERLAP`) and central/local divergence (`ZIP_CD_LFH_MISMATCH`) are always refused — there is no opt-out.
- Relaxations are named inputs, never silent: `rejectTraversal: false` **skips** unsafe names (listed in `skipped`, never emitted); `rejectSymlinks: false` extracts the link **target text as data**, never a link; `onDuplicate: 'first' | 'last'` resolves shadowing deliberately.
- `includeData: false` is a dry run: the plan (sanitized paths, sizes, CRCs) with nothing decompressed. The archive is opened **eagerly** before the plan in both modes, so the dry run runs the same open-time guards as the extraction — overlapping entries, entries reaching into the central directory or past EOF and Zip64 spoofing are refused before any plan row (and a file-mode extraction fails before its first write). A central/local divergence of method, CRC or sizes is *not* an extent problem: it is detected when the entry is read, and `verify_zip` (`localHeaderMatch`) is the one-call gate for it. Directories are implied by paths; `emptyDirectories: true` (file mode) also creates the explicit ones.
- File mode needs `outputDir` (relative, inside the sandbox) and never overwrites (`OUTPUT_EXISTS`); the result carries a `resource_link` per written file (at most 50 — the rest are in `entries[].filePath`).
- Encrypted entries are refused (`ZIP_UNSUPPORTED_ENCRYPTION`); there is no decryption in this engine. Filter them out (`filter`) or read the rest.

### Data remanence (`modify_zip mode: 'append'`)

- `mode: 'append'` (the default) is the engine's `save()`: the original bytes stay **verbatim** as a prefix, the edits are appended, a new central directory is written. Fast and byte-preserving — and every `remove`d or `replace`d payload **remains inside the file**, recoverable by anyone with a hex editor. The `ZIP_DEAD_BYTES_RATIO` diagnostic fires past 50 % dead bytes, and 7-Zip is known to read the **stale** payload of a replaced entry instead of the new one.
- `mode: 'compact'` is `saveCompact()`: a rewrite sorted by raw name bytes (an insertion-ordered EPUB / JAR layout is not kept — rebuild it with `create_zip` `order: 'insertion'`), still without recompression, removed data truly gone, an SFX prefix dropped. Use it to delete secrets, to interoperate with 7-Zip, or when dead bytes pile up. Add `canonical: {}` (compact only) for the full canonical form of `canonicalize_zip` after the edits (`summary.canonical: true`).
- The input is opened **eagerly**: an archive with overlapping entries or a truncated local header is refused with its `ZIP_*` code before any operation runs, and before an append-mode save every non-encrypted entry is checked against its local header and declared sizes (`ZIP_CD_LFH_MISMATCH`, `ZIP_LIMIT_EXCEEDED`). Names and payloads already in the archive are copied verbatim in both modes — an unsafe name stays (`extract_zip` still refuses it).
- Operations run in order. `add` fails on an existing name (`ZIP_ENTRY_EXISTS`), `replace` on a missing one (`ZIP_ENTRY_NOT_FOUND`), `rename` **never overwrites** — `remove` the target first. No edits and an unchanged comment return the same bytes (`summary.noOp: true`). Archives with duplicate entry names are refused (`ZIP_DUPLICATE_ENTRY_NAME`): rebuild them with `create_zip`.

### Reproducibility and the deterministic pin (`create_zip`)

- Defaults are reproducible on one runtime: canonical order (raw UTF-8 name bytes), DOS-epoch timestamps (1980-01-01), UTF-8 names with the EFS flag, constant attributes, Zip64 exactly when a field overflows.
- `defaultDate: 'now'` (or a wall-clock per-entry `date`) opts out: the `ZIP_TIMESTAMP_NOT_PINNED` diagnostic fires and `summary.deterministic` is `false`. Pin an ISO instant instead (1980-01-01 … 2107-12-31, 2-second DOS granularity). Every date is written as its **UTC** wall clock, so a pinned call is the same bytes on every host whatever its time zone (an offset-less date-time is taken as the UTC wall clock).
- `compression: { deterministic: true }` pins the pure-TS deflate encoder so the bytes are identical on every runtime (slower); `summary.deflateTier` reports `pure-pinned`. Without it the bytes are stable per environment only (`node-zlib`) and `summary.deterministic` stays `false` even though the *layout* is reproducible — `inspect_zip` `determinism.deterministic` reports that structural verdict separately (it requires epoch timestamps, so a pinned non-epoch date reproduces but reports `false` there). Three verdicts, three questions: `summary.deterministic` = "identical on every runtime?", `summary.sha256` = "the proof", `inspect_zip.determinism` = "canonical structure, whoever wrote it?".
- `stream: true` entries use the data-descriptor layout: reproducible, but `inspect_zip` reports `canonicalLayout: false`. `parallel` is byte-identical to the sequential writer (per tier). Extra fields you pass are embedded verbatim — their determinism is yours.
- Proof: `includeSha256: true` twice → equal `summary.sha256`; or `inspect_zip check: ['deterministic', 'canonical-layout']` on the result. For an archive someone else built, `inspect_zip determinismReport: true` names every offending entry and `canonicalize_zip` fixes them without recompressing. Full contract: [`guides/DETERMINISM.md`](guides/DETERMINISM.md).

### Forward-scan trust (`scan_zip_forward`)

- It reads local headers **alone**. A hostile archive can present different names, sizes and methods here than `inspect_zip` / `list_zip_entries` report — the upload-scanner differential. The result says so (`trust: 'local-headers-only'`). Treat disagreements as hostile.
- `data: 'none'` (default) skips payloads — but a data-descriptor (bit 3) entry still costs a full decompress-and-discard, and store + bit 3 / encrypted + bit 3 are refused (`ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`). `data: 'verify'` checks CRCs; `data: 'include'` returns content (inline caps).
- `stoppedAt` tells you how the scan ended: `'central-directory'` (normal), `'eof'` (no central directory — truncated or CD-less), `'max-entries'`, `'error'` (with `tolerateTruncation: true`, plus `error: { code, message }` and the partial inventory). Descriptor rows carry zero sizes and CRC `00000000` in their local header.
- Names are **not** sanitized here — use `sanitizedPath` (or `sanitize_entry_paths`) before touching a filesystem.

### Entry names

- Names are `/`-separated and **case-sensitive** (`README.md` ≠ `readme.md`). `ZIP_ENTRY_NOT_FOUND` names the remedy: call `list_zip_entries` for the exact names.
- `read_zip_entry` by `name` returns the **last** duplicate; pass `index` (the central-directory position from `list_zip_entries`) to pick another. Duplicates are reported by `inspect_zip.duplicateNameCount` and the `ZIP_DUPLICATE_NAME` diagnostic.
- Directory entries end in `/`; `filter.includeDirectories` (default `false` — listing and scanning include directories when no filter object is given; extraction never does) controls whether they appear.

### `limits` vs ceilings

- `limits.*` (the engine's 9 `ZipLimits` bounds: `maxEntries`, `maxEntryUncompressedSize`, `maxEntryCompressedSize`, `maxTotalUncompressedSize`, `maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`, `maxCommentBytes`, `maxCentralDirectoryBytes`) raise or lower the engine's bounds for **this call** — for trusted input only. The engine enforces them *while* inflating, not after. `maxEntryCompressedSize` is read by the byte-range reader only (the payload it fetches into memory for one entry); the in-memory reader never consults it.
- They can never exceed the operator ceilings: `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` (default 8 GiB; bounds the three size limits), `ZIPNATIVE_MCP_MAX_ENTRIES` (default 100 000; also bounds `scan_zip_forward.maxEntries`, whose default of 10 000 is clamped to the ceiling — only an explicit value above it is refused), `ZIPNATIVE_MCP_WORKERS` (default 8; bounds `create_zip.parallel.workers`, whose default is the engine's `max(1, min(cores − 1, 8))`; 0 disables workers). A request above a ceiling is `LIMIT_CEILING_EXCEEDED` and `_meta.error.data.env` names the variable the operator would raise — you cannot raise it yourself. A ceiling below an engine default tightens the default silently. The fourth ceiling, `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` (default 4 GiB), bounds every file a tool writes (`OUTPUT_TOO_LARGE` names it).
- `describe_engine` reports both (`defaultLimits`, `ceilings`).

### File mode and the sandbox

- `outputMode: 'file'`, `outputDir`, `zipPath` and `sourcePath` only work when the host set `ZIPNATIVE_MCP_OUTPUT_DIR`. Otherwise every file input and output is `SECURITY_VIOLATION` and the tools work on base64 only.
- Paths are **relative**, no `..`, no absolute / UNC / drive prefix, no NUL. `outputPath` must end in a container extension (`.zip` recommended; `.md` for `draft_governance_issue`; `inflate_raw` accepts `.bin`, `.dat`, `.txt`, `.json`, `.xml`, `.md`, `.csv`, `.html`, `.zip`, `.tar`, `.raw`). `sourcePath` may have any extension.
- The **real** path of every file read (`zipPath`, `sourcePath`, `resources/read`) and of every parent written must stay inside the sandbox: a symlink or junction planted there is `SECURITY_VIOLATION` on both sides. A file is read through one open handle; one that grows or shrinks while it is read is `IO_ERROR` (`data.remedy: 'retry'`) — retry once it is complete.
- The server **never overwrites** (`OUTPUT_EXISTS`) — choose another path. A file written in file mode is listed under `resources/list` as `zipnative://output/<path>` and the result carries a `resource_link`; a path you wrote can be read back by any tool through `zipPath` without re-sending the bytes.
- `draft_governance_issue` uses `outputMode: 'inline' | 'file'` (not `'base64'`).

### Token-frugal projections

The read tools (`inspect_zip`, `list_zip_entries`, `read_zip_entry`, `verify_zip`, `extract_zip`, `scan_zip_forward`, `sanitize_entry_paths`, `describe_engine`) accept two optional inputs:

- `verbosity: 'summary'` swaps the full result for a scalar-only subset: `inspect_zip` → `{ archiveBytes, entryCount, isZip64, compressedBytes, uncompressedBytes, encryptedCount, unsafeNameCount, duplicateNameCount, deterministic, canonicalLayout, diagnosticCount, checksPassed? }`; `list_zip_entries` → counts + `names[]`; `read_zip_entry` → `{ name, index, mode, sizeBytes, crcVerified, textLength?, range?, verification?, diagnosticCount }`; `verify_zip` → the verdict + counts; `extract_zip` → counts + `paths[]`; `scan_zip_forward` → `{ trust, entryCount, keptCount, stoppedAt, truncated, names[], error?, diagnosticCount }`; `sanitize_entry_paths` → counts + `rejectedNames[]`; `describe_engine` → `{ server, engine, capabilities, sandbox, network }`.
- `fields: ['a', 'b.c']` projects to named dot-paths (an array segment maps over every element, e.g. `['entries.name', 'entries.uncompressedSize']`). It composes **after** `verbosity`; unmatched paths are omitted leniently and reported in `_meta.unmatchedFields` + `_meta.availableFields`.

Defaults are unchanged: omit both and you get the full shape. Produced archives (base64 mode) arrive as an embedded `resource` content block, not in `structuredContent` (which is `{ mode, sizeBytes, summary, diagnostics, … }`). The block carries the bytes twice — in `resource.blob` and again in `resource.uri`, a `data:application/zip;base64,…` URI (`application/octet-stream` for `inflate_raw`), the 1.0.0 shape — so prefer `outputMode: 'file'` (a `resource_link`) for any archive you do not need inline.

### Response cache

With `ZIPNATIVE_MCP_CACHE_DIR` set, a repeated identical call (same tool, same input) may be answered from cache — the result carries `_meta.cached: true` — within a 1 h TTL. Never cached: any `zipPath` / `sourcePath` input, including one inside `entries[]`, `operations[]` or `merge_zip` `sources[]` (a path is a reference, not content), `outputMode: 'file'`, `defaultDate: 'now'`, any `parallel` request, `describe_engine`, `draft_governance_issue`, and a cancelled call. The key is namespaced by the tool API version, the package version **and** the engine version, plus the four operator ceilings, so an upgrade never serves old bytes and a lowered ceiling never serves a result it would refuse.

### Protocol eras

- The server speaks MCP 2026-07-28 (stateless, `server/discover`, `resultType`, cache hints) and falls back automatically to the 2025-era `initialize` handshake. Whatever your host negotiates, the `tools/call` payload is the same.
- `tools/list` and `prompts/list` are safe to cache for 24 h (`cacheScope: 'public'`); `resources/*` results are private and must not be cached.
- Seven MCP prompts are advertised — `governance_contract`, `draft_issue_workflow`, `secure_extraction`, `reproducible_archive`, `incremental_update`, `forensic_scan`, `verify_before_trust` — read the one matching your workflow before the first call.
- Over HTTP (`ZIPNATIVE_MCP_PORT`), the operator may require a bearer token (`ZIPNATIVE_MCP_HTTP_TOKEN`): send `Authorization: Bearer <token>` or every `/mcp` request is answered 401. Without it HTTP mode has no authentication (loopback bind + Host / Origin guard only). stdio is unaffected.
- Long calls are cancellable: `notifications/cancelled` (or closing the HTTP request) stops every tool whose work scales with its input between chunks, removes a partial output file and caches nothing. Over MCP the SDK sends no response to the cancelled request (`CANCELLED`, `data.remedy: 'retry'`, is the in-process code). `verify_zip` is the exception: zipnative's `verifyZip` is synchronous and takes no signal, so a verify runs to completion and its result is returned. Send a `_meta.progressToken` with `tools/call` to receive `notifications/progress` (strictly increasing, at most one per 200 ms); without it no notification is sent and the result is the same.
- Operator environment, for reference (an agent never sets these): `ZIPNATIVE_MCP_OUTPUT_DIR`, `ZIPNATIVE_MCP_CACHE_DIR`, `ZIPNATIVE_MCP_PORT`, `ZIPNATIVE_MCP_HTTP_TOKEN`, `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS`, `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`. Full table: [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4.
- There is **no network path** in this server: no telemetry, no GitHub, no URL from any argument, ever — the byte-range reader takes a sandbox file only, never a remote source.

### Drafting a GitHub issue (human-in-the-loop)

- `draft_governance_issue` produces a **local** draft + a compliance report. It never submits and makes no network call — you are a draftsman; a human is the only gate.
- Always set `duplicateSearchPerformed: true` (after actually searching) and include `reproduction: { command, result }`. Proposing a runtime dependency or `duplicateSearchPerformed: false` is `GOVERNANCE_VIOLATION`; omitting `reproduction` (a required input) is `VALIDATION_ERROR`.
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
2. Later, or before shipping: `modify_zip { …, operations: [{ op: 'remove', name: '.env' }], mode: 'compact' }` — the compacting rewrite (add `canonical: {}` for the canonical form); removed data truly gone. Watch `ZIP_DEAD_BYTES_RATIO` in `diagnostics` as the signal that compaction is due. Details: [`guides/INCREMENTAL.md`](guides/INCREMENTAL.md).

### Make a third-party archive reproducible

1. `inspect_zip { zipBase64, determinismReport: true, check: ['canonical-form'], fields: ['checksPassed', 'determinismReport'] }` — which entries break which rule.
2. `canonicalize_zip { zipBase64, includeSha256: true }` (or `date: '2026-10-08T00:00:00Z'` for one release timestamp, read as UTC) — `summary.canonicalForm: true` is the engine's re-check; running it again returns the same bytes (`summary.alreadyCanonical: true`).
3. *(optional)* `inspect_zip { zipBase64: <the result>, check: ['canonical-form'], canonicalDate: <the same date> }` in CI.

### Merge archives

1. `merge_zip { sources: [{ zipBase64: <a> }, { zipPath: 'incoming/b.zip', filter: { prefix: 'docs/' } }], onConflict: 'last', includeSha256: true }` — every entry CRC- and size-checked before it is copied (`verify: true`; an entry with no codec here is `ZIP_UNSUPPORTED_METHOD`); `summary.dropped` names what a duplicate name cost. A `ZIP_INVALID_ENTRY_NAME` with `data.sourceIndex` is a source name the writer refuses (a `bsdtar` `./` entry): add a `filter` to that source.
2. *(optional)* `canonicalize_zip` on the result for the full canonical form.

### Large archive in the sandbox (above 1 GiB)

1. `inspect_zip { zipPath: 'incoming/huge.zip', verbosity: 'summary' }` — `access: 'auto'` reads it by byte ranges (the result carries `access: 'range'`; `determinism` is absent there).
2. `list_zip_entries { zipPath: 'incoming/huge.zip', filter: { glob: ['**/*.json'] } }`, then `read_zip_entry { zipPath: 'incoming/huge.zip', name: '…', encoding: 'utf8' }` — only the central directory and that entry's bytes are read.
3. `scan_zip_forward` streams any size; `verify_zip`, `extract_zip`, `modify_zip`, `canonicalize_zip` and `merge_zip` stay buffered (1 GiB). Details: [`guides/LARGE_ARCHIVES.md`](guides/LARGE_ARCHIVES.md).

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

1. `inspect_zip { zipPath: 'dist/release.zip', check: ['deterministic', 'canonical-layout', 'no-encryption', 'safe-names', 'no-duplicates', 'deflate-only'], assert: { has: ['META-INF/MANIFEST.MF'], maxEntries: 5000 }, fields: ['checksPassed', 'checks'] }` (no `verbosity: 'summary'`: it would drop `checks[]`, the rows that say which check failed).
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

- `_meta.apiVersion` = `'1.1.0'` — see [`API_STABILITY.md`](API_STABILITY.md).
- `_meta.examples` — one or two executable worked examples per tool (the rest live in [`../examples/`](../examples), executed by `tests/examples.test.ts`). Inspect the `tools/list` response to discover them.
- `annotations` — `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`; `openWorldHint` is `false` on every tool (no network).
- `outputSchema` — the read tools declare a **projectable** schema (every property optional, `additionalProperties: false`, summary-only scalars declared) so `structuredContent` validates under `verbosity` / `fields` as well; `create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip` and `inflate_raw` extend the shared `ARCHIVE_OUTPUT_SCHEMA` with their own typed `summary` (`deterministic` / `deflateTier` / `parallel` / `sha256`, `saveMode` / `noOp` / `grewByBytes` / `canonical`, `alreadyCanonical` / `canonicalForm` / `pinnedDate`, `perSource` / `dropped` / `verified`, `bytesConsumed` / `leftover` / `finished` — every key optional).
- Every archive tool's result carries `diagnostics[]` (de-duplicated by code + entry, at most 200, `diagnosticsTruncated: true` when the cap bites) and, on every one but `verify_zip`, `diagnosticCounts` — for ZIP they **are** the signal (an SFX prefix, a name mismatch, duplicate names, an unpinned timestamp, dead bytes after an incremental save).

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
- `data` carries the machine-readable detail: `errorClass` (`parse` / `security` / `data` / `limit` / `unsupported` / `not-found` / `input` / `usage` / `check` / `internal`), `engineError` (the engine class name), `entryName`, and per class `limit` / `configured` / `observed` (`ZIP_LIMIT_EXCEEDED`), `feature` (`ZIP_UNSUPPORTED_*`), `expectedCrc` / `actualCrc` (`ZIP_CRC_MISMATCH`), `operationIndex` / `op` (`modify_zip`), `entryIndex` (`create_zip`), `sourceIndex` (`merge_zip`), `writtenCount` (`extract_zip` file mode), `cap` (the inline caps), `ceiling` / `env` (`LIMIT_CEILING_EXCEEDED`; `env` also on a file-output refusal), and `remedy` — an optional machine-actionable hint from a closed vocabulary: `outputMode:'file'` (`extract_zip` above an inline cap), `range` (`read_zip_entry` above 16 MiB), `encoding:'base64'`, `data:'verify'` (`scan_zip_forward` `data: 'include'` above the caps), `list_zip_entries` (an out-of-range `index`), `resources/list` (a missing `zipPath` / `sourcePath`), `maxEntries ≤ N` (`scan_zip_forward` above the ceiling), `zipPath` (an inline payload above 128 MiB), `retry` (`IO_ERROR` on a file that changed under the read, `CANCELLED`), `access:'memory'` (`inspect_zip` determinism inputs over byte ranges). Branch on `code`; use `remedy` to pick the retry without parsing the message.

### Wrapper codes

| `code` | Meaning | Fix |
|---|---|---|
| `VALIDATION_ERROR` | Zod rejected the input: wrong type, unknown key (strict), both or neither of `zipBase64` / `zipPath`, malformed base64 (PEM, nested `data:` URI, double-encoded, empty), a `date` outside 1980–2107, an unparsable `unixMode`, extra field id `0x0001`, a glob above 1024 characters or with an inverted class range (`[z-a]`), a `fields` path naming a prototype segment, `zip64` without `stream`, `canonical` outside `mode: 'compact'`, `determinismReport` / `canonicalDate` over byte ranges | Re-read the field's schema (the message lists the offending path); pass the raw archive bytes as base64 exactly once. |
| `INPUT_TOO_LARGE` | Decoded input above 128 MiB (inline) or 1 GiB (`zipPath` / `sourcePath`) | Use the sandbox (`zipPath`, `sourcePath`, file mode — `data.remedy: 'zipPath'` on an inline payload) or split the input. |
| `INPUT_NOT_FOUND` | `zipPath` / `sourcePath` does not exist in the sandbox or is not a regular file | List `resources/list`; fix the relative path. |
| `ENTRY_TOO_LARGE` | One entry above the 16 MiB inline cap (`read_zip_entry` — uncompressed in `mode: 'data'`, compressed in `mode: 'raw'` —, `extract_zip`, `scan_zip_forward data: 'include'`) | Pass a `range` (`mode: 'data'`), use `outputMode: 'file'`, or `data: 'verify'` — `data.remedy` names it. A raw payload above the cap is not retrievable inline; the range and file mode give the decompressed content. |
| `ENTRY_NOT_UTF8` | `encoding: 'utf8'` on bytes that are not valid UTF-8 | Read it with `encoding: 'base64'`. |
| `OUTPUT_TOO_LARGE` | Inline output above 50 MiB, inline extraction above 32 MiB, file output above the file-output ceiling (4 GiB by default; `data.env` names `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`), a `resources/read` above 50 MiB | `outputMode: 'file'`, a `filter`, or a `range`; above the file ceiling, split the content or ask the operator. |
| `OUTPUT_EXISTS` | The target file already exists in the sandbox | The server never overwrites — choose another `outputPath` / `outputDir`. |
| `IO_ERROR` | The filesystem refused the operation (permissions, disk full, …), or a sandbox file grew or shrank while it was being read | The message carries the errno (never an absolute path); check the sandbox directory, or retry once the file is complete (`data.remedy: 'retry'`). |
| `SECURITY_VIOLATION` | Sandbox unset, absolute / UNC / `..` / NUL path, or a symlink / junction that would redirect a write (parent) or a read (`zipPath`, `sourcePath`, `resources/read` — the file itself) outside the sandbox | Set `ZIPNATIVE_MCP_OUTPUT_DIR`; pass a relative path without traversal; remove the link. |
| `MISSING_OUTPUT_PATH` | `outputMode: 'file'` without `outputPath` (`outputDir` for `extract_zip`) | Pass a relative path. |
| `INVALID_PATH` | A path input is empty or not a string | Pass a non-empty relative path. |
| `INVALID_EXTENSION` | `zipPath` / `outputPath` does not end in an allowed extension | Container extensions for archives (`.zip` recommended), `.md` for the governance draft. |
| `LIMIT_CEILING_EXCEEDED` | `limits.*`, an explicit `scan_zip_forward.maxEntries` (the default is clamped, never refused) or `parallel.workers` above an operator ceiling | `data.env` names the variable; an agent cannot raise it — ask the operator, or lower / omit the request (`data.remedy: 'maxEntries ≤ N'` for the scanner). |
| `GOVERNANCE_VIOLATION` | `draft_governance_issue` draft breaks the contract (runtime dependency proposed, `duplicateSearchPerformed: false`; a missing `reproduction` is `VALIDATION_ERROR` first) | Fix the draft and call again. |
| `CANCELLED` | The request was cancelled (`notifications/cancelled`, or the HTTP client went away) before it completed; nothing was cached and a partial output file was removed. In-process only: over MCP the cancelled request gets no response | Retry the call if the result is still wanted (`data.remedy: 'retry'`). |
| `ENGINE_ERROR` | Something that is not a `ZipError` escaped the engine or the runtime (`data.errorClass: 'internal'`; absolute paths are redacted from the message) | Report it with a reproduction (`draft_governance_issue`, `targetRepo: 'zipnative'` or `'zipnative-mcp'`). |
| `UNKNOWN_RESOURCE` | **Protocol error** (`-32602`): `resources/read` with an unknown or malformed `zipnative://output/` URI | List URIs with `resources/list`. |
| `[UNKNOWN_TOOL]` | **Protocol error** (`-32602`): `tools/call` with a name that does not exist | Pick a name from `tools/list` (15 tools). |

### The 39 `ZIP_*` codes, by class

The full table with cause and remedy per code is in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6 and in the machine-readable [`data/errors.json`](data/errors.json); the engine's own guide is [zipnative `docs/guides/errors.md`](https://github.com/Nizoka/zipnative/blob/main/docs/guides/errors.md).

| `data.errorClass` | Codes | What to do |
|---|---|---|
| `parse` (format) | `ZIP_EOCD_NOT_FOUND`, `ZIP_EOCD_INCONSISTENT`, `ZIP_ZIP64_LOCATOR_MISSING`, `ZIP_ZIP64_EOCD_MISPLACED`, `ZIP_CD_INCONSISTENT`, `ZIP_RECORD_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_STREAM_TRUNCATED`, `ZIP_VALUE_UNREPRESENTABLE`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DEFLATE_CORRUPT` | The bytes are not a ZIP, are truncated, or are corrupt: re-obtain the archive. `scan_zip_forward tolerateTruncation: true` salvages the inventory of a truncated one. |
| `security` | `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION` (no opt-out) · `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH` (named relaxations) | The first three are active-attack shapes: stop. The last three name the relaxation (`rejectTraversal: false` skips, `rejectSymlinks: false` writes the target text, `onDuplicate: 'first' | 'last'`). |
| `data` | `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_DECOMPRESSION_FAILED` | The content or its metadata lies: treat as corrupt or hostile. `verify_zip` reports these as rows instead of failing. |
| `limit` | `ZIP_LIMIT_EXCEEDED` (`data.limit`, `configured`, `observed`), `ZIP_INPUT_TOO_LARGE` | Raise `limits.<limit>` for trusted input only (within the ceilings). |
| `unsupported` | `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_UNSUPPORTED_ZIP64_STREAMING`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_UNSUPPORTED_CODEC_MODE` | Deliberate refusals; `data.feature` says which. No encryption in this engine (an encrypted entry cannot be merged either); no codec beyond store / deflate in this server; add `zip64: true` to a `stream: true` entry above 4 GiB; use the whole archive instead of a forward scan. |
| `not-found` / `input` / `usage` | `ZIP_ENTRY_NOT_FOUND` · `ZIP_ENTRY_EXISTS`, `ZIP_INVALID_ENTRY_NAME`, `ZIP_DUPLICATE_ENTRY_NAME` · `ZIP_INVALID_OPTION`, `ZIP_LIMIT_INVALID` | Names are case-sensitive (`list_zip_entries`); use `replace` over an existing name; relative `/`-separated names without `..`; unique names. |
| `check` / `internal` | `ZIP_STRICT_DIAGNOSTIC` · `ZIP_API_MISUSE`, `ZIP_INTERNAL` | `strict: true` escalated a diagnostic (drop `strict`, or fix the producer it names). The internal pair is a bug: draft an upstream issue with the archive. |

### When to draft an upstream issue

- **Engine root cause** (`ZIP_INTERNAL`, `ZIP_API_MISUSE`, `ENGINE_ERROR`, a wrong verdict from `verify_zip` / `inspect_zip`, a non-conformant archive from `create_zip`, a parse refusal on an archive every other tool opens): `draft_governance_issue` with `targetRepo: 'zipnative'`, the archive (or the `create_zip` arguments that produce it) as the reproduction, and the `_meta.error` block as the result. Then hand the draft to a human.
- **Wrapper root cause** (a schema mismatch, a sandbox refusal on a legitimate path, a projection that drops a field, a wrong `_meta.error.data` shape): `targetRepo: 'zipnative-mcp'`.
- **Not a bug:** a refusal whose message names a relaxation or a limit — that is the security posture working; relax it deliberately or ask the operator.

If a tool returns an archive that a downstream reader rejects, run `verify_zip` and `inspect_zip` on it first — and remember that ISO/IEC 21320-1 conformance (which every archive this server writes has, validated in CI) does not make a *hostile* archive safe: see [`guides/CONFORMANCE.md`](guides/CONFORMANCE.md).
