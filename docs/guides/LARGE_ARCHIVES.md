# Large archives — byte-range reads, Zip64 streaming, cancellation

> Most archives an agent meets fit in memory, and the tools treat them that way. This
> guide is for the others: a multi-gigabyte archive the operator dropped into the
> sandbox, an entry too large to return inline, an archive that must exceed 4 GiB, and a
> call long enough that the client may want to stop it or watch it progress. Everything
> here stays inside the sandbox and the process — there is no remote source and no
> network path.

The caps and ceilings quoted below live in [`src/caps.ts`](../../src/caps.ts) and are
reported at runtime by `describe_engine` (`caps`, `ceilings`, `defaultLimits`). The
engine's own guides are
[zipnative `docs/guides/`](https://github.com/Nizoka/zipnative/tree/main/docs/guides).

---

## 1. How each tool reaches the bytes

| Tool | `zipBase64` (≤ 128 MiB decoded) | `zipPath` ≤ 1 GiB | `zipPath` above 1 GiB |
|---|---|---|---|
| `inspect_zip`, `list_zip_entries`, `read_zip_entry` | in memory (or byte ranges with `access: 'range'`) | in memory (`access: 'auto'`, the default) | **byte ranges** (`'auto'` switches by itself; `'memory'` refuses with `INPUT_TOO_LARGE`) |
| `scan_zip_forward` | chunked from memory | streamed through one handle | streamed — no size cap |
| `verify_zip`, `extract_zip`, `modify_zip`, `canonicalize_zip` | in memory | in memory | `INPUT_TOO_LARGE` (split the archive) |
| `merge_zip` | in memory, 128 MiB of inline sources in all | in memory, 1 GiB of sources in all | `INPUT_TOO_LARGE` |

The in-memory cap for a sandbox file is `MAX_PATH_INPUT_BYTES` (1 GiB). An inline
payload above 128 MiB is refused with `data.remedy: 'zipPath'`: put the bytes in the
sandbox and pass the relative path instead.

## 2. Byte-range reads — `access`

`inspect_zip`, `list_zip_entries` and `read_zip_entry` take
`access: 'auto' | 'memory' | 'range'`:

- **`'auto'`** (default) — a `zipPath` up to 1 GiB is read into memory, a larger one is
  opened by byte ranges instead of being refused. Inline bytes are read in memory.
- **`'range'`** — always by byte ranges: zipnative's `openZipRange()` over the sandbox
  file's own handle (never a URL). Over inline bytes the same reader runs on the bytes
  already in memory (`rangeSourceFromBytes`); the result equals the in-memory one.
- **`'memory'`** — always buffered; a `zipPath` above 1 GiB is `INPUT_TOO_LARGE`.

**What a range read touches.** The end-of-central-directory record (and the Zip64
records), the central directory, then only the entries the call reads — nothing else.
Memory stays at the size of the central directory (itself bounded by
`limits.maxCentralDirectoryBytes`) plus the entry being read. Every limit and
cross-check of `openZip` applies (`validate`, `limits`, `strict`, the overlap and
Zip64 checks), and a source that delivers fewer bytes than asked is
`ZIP_RECORD_TRUNCATED`. The file is opened once, its real path proven inside the
sandbox and bound to the handle; the handle is closed when the call ends.

**`limits.maxEntryCompressedSize`.** The byte-range reader fetches one entry's
compressed payload into memory before decoding it, so the ninth `ZipLimits` key bounds
that payload (default 1 GiB + 1 MiB; ceiling `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`;
`ZIP_LIMIT_EXCEEDED` above it). The in-memory reader never consults it.

```jsonc
// read_zip_entry — one entry of a large sandbox archive, no compressed payload above 64 MiB fetched
{ "zipPath": "big.zip", "name": "data/part-0001.bin", "access": "range", "limits": { "maxEntryCompressedSize": 67108864 } }
// → ZIP_LIMIT_EXCEEDED naming maxEntryCompressedSize when that entry's compressed size is larger
```

**Results say how they were read.** Every result produced over byte ranges carries
`access: 'range'`; in memory the field is absent (the 1.0.0 shape).

**What `inspect_zip` cannot do over ranges.** The determinism analysis
(`analyzeDeterminism()`) takes the whole archive in memory, so over byte ranges
`inspect_zip` omits `determinism`, the determinism checks (`deterministic`,
`epoch-timestamps`, `canonical-order`, `utf8-names`, `canonical-form`,
`canonical-extras`, `canonical-version-made-by`) fail closed with a detail saying why,
and `determinismReport` / `canonicalDate` are `VALIDATION_ERROR`
(`data.remedy: "access:'memory'"`, archives up to 1 GiB). Every other count, flag and
check is computed from the central directory as usual.

From [`examples/read-entry-byte-ranges.json`](../../examples/read-entry-byte-ranges.json)
(needs `ZIPNATIVE_MCP_OUTPUT_DIR`):

```json
{
  "tool": "read_zip_entry",
  "arguments": {
    "zipPath": "incoming/report.zip",
    "access": "range",
    "name": "docs/guide.md",
    "encoding": "utf8"
  }
}
```

A typical walk over a large sandbox archive:

```
inspect_zip       { zipPath: 'incoming/huge.zip', verbosity: 'summary' }                  → access: 'range'
list_zip_entries  { zipPath: 'incoming/huge.zip', filter: { glob: ['**/*.json'] }, limit: 200 }
read_zip_entry    { zipPath: 'incoming/huge.zip', name: 'config/app.json', encoding: 'utf8' }
read_zip_entry    { zipPath: 'incoming/huge.zip', name: 'logs/big.log', range: { offset: 0, length: 65536 } }
```

## 3. Large entries

An entry is returned inline up to 16 MiB (`MAX_ENTRY_INLINE_BYTES`; `ENTRY_TOO_LARGE`
with `data.remedy` above it). Beyond that:

- **A window** — `read_zip_entry` with `range: { offset, length ≤ 16 MiB }` reads
  through the engine's chunked stream with bounded memory (`crcVerified: false`: a
  window cannot verify the whole entry's CRC). Works in memory and over byte ranges.
- **The whole entry on disk** — `extract_zip` with `outputMode: 'file'` and a `filter`
  streams each entry into the sandbox (the archive itself is buffered, so ≤ 1 GiB).
- **Verify without returning** — `read_zip_entry mode: 'verify'` or `verify_zip`
  decompress to check CRC and size and return no payload.
- **Forward, any size** — `scan_zip_forward` with `data: 'verify'` streams a `zipPath`
  of any size and checks every CRC; it trusts local headers only
  ([`SECURITY.md`](SECURITY.md) §8).

A raw payload (`mode: 'raw'`) above 16 MiB is not retrievable inline at all; the window
and file mode give the decompressed content instead.

## 4. Writing large archives — streamed entries and Zip64

`create_zip` takes a sandbox file as an entry source (`sourcePath`, up to 1 GiB when
buffered). With `stream: true` the file is fed through the engine's `addStream` in
64 KiB chunks and never buffered: no size cap on the source, the **data-descriptor
layout** (flag bit 3; CRC and sizes after the payload), and the archive is assembled by
streaming. In file mode the archive streams to disk with bounded memory.

**Above 4 GiB: `zip64: true`.** A streamed entry does not know its size up front. By
default the engine writes the classic streaming layout and refuses an entry that
crosses 4 GiB (`ZIP_UNSUPPORTED_ZIP64_STREAMING`). `zip64: true` on a `stream: true`
entry (zipnative 1.1.0 `AddEntryOptions.zip64`) writes the **Zip64 streaming layout**
of APPNOTE 4.3.9.2 instead: version needed 45, a Zip64 extra in the local header, a
24-byte data descriptor with 8-byte sizes. Every random-access extractor reads it, and
the vendored validator checks the descriptor width against the local header
(`WF/DESCRIPTOR-WIDTH`, [`CONFORMANCE.md`](CONFORMANCE.md)). Two caveats:

- An opted-in entry below 4 GiB still carries the Zip64 records, which some streaming
  readers (Java's `ZipInputStream`) cannot read — opt in only for entries that may
  cross 4 GiB.
- `zip64` without `stream` is `VALIDATION_ERROR`: a buffered entry takes Zip64
  automatically when a field overflows, as does an archive past 65 535 entries.
  `compression.deterministic: true` caps a streamed entry at 2 GiB.

**The file-output ceiling.** A file a tool writes is bounded by
`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` (default 4 GiB — the 1.0.0 cap, so nothing moves
unless the operator raises it), enforced while streaming: above it the call is
`OUTPUT_TOO_LARGE` naming the variable, and the partial file is removed. An archive
above 4 GiB in the sandbox therefore needs both the opt-in and the operator's raised
ceiling. The same ceiling bounds `extract_zip` file mode (on the running total) and
`inflate_raw` file mode.

From [`examples/create-zip64-stream.json`](../../examples/create-zip64-stream.json)
(needs `ZIPNATIVE_MCP_OUTPUT_DIR`):

```json
{
  "tool": "create_zip",
  "arguments": {
    "entries": [
      { "name": "data/dump.bin", "sourcePath": "incoming/dump.bin", "stream": true, "zip64": true }
    ],
    "outputMode": "file",
    "outputPath": "builds/dump64.zip",
    "includeSha256": true
  }
}
```

## 5. Caps and ceilings in play

**Caps** (constants; `describe_engine.caps`):

| Cap | Value | Applies to |
|---|---|---|
| `stdioMaxFrameBytes` | 256 MiB | one stdio frame / HTTP body (413) |
| `maxBase64InputBytes` | 128 MiB | decoded `zipBase64`, and the sum of inline payloads per call |
| `maxPathInputBytes` | 1 GiB | a buffered `zipPath` / `sourcePath`; above it the three random-access read tools use byte ranges |
| `maxMergeInputBytes` | 1 GiB | the `merge_zip` sources in all |
| `maxEntryInlineBytes` | 16 MiB | one entry returned inline; `range.length` |
| `maxExtractInlineTotalBytes` | 32 MiB | one inline extraction |
| `maxBase64OutputBytes` | 50 MiB | one inline archive / inflate output; one `resources/read` |
| `maxFileOutputBytes` | 4 GiB | the default of the file-output ceiling |

**Operator ceilings** (environment, read once at boot — an invalid value refuses to
start; `describe_engine.ceilings`; the response-cache key includes all four):

| Variable | Default | Bounds |
|---|---|---|
| `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` | 8 GiB | `limits.maxEntryUncompressedSize`, `limits.maxEntryCompressedSize`, `limits.maxTotalUncompressedSize` |
| `ZIPNATIVE_MCP_MAX_ENTRIES` | 100 000 | `limits.maxEntries`, `scan_zip_forward.maxEntries` |
| `ZIPNATIVE_MCP_WORKERS` | 8 | `create_zip.parallel.workers` |
| `ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES` | 4 GiB | every file a tool writes |

A per-call `limits` value above its ceiling is `LIMIT_CEILING_EXCEEDED`
(`data.env` names the variable); a ceiling below an engine default tightens the default
silently. An agent cannot raise a ceiling — the operator can, for trusted input only.

## 6. Cancellation and progress

Long calls — a large extraction, a streamed `create_zip`, a `merge_zip` over many
sources, a forward scan of a big file — honour the MCP utilities for cancellation and
progress. Every `tools/call` carries the request's cancellation signal, and, when the
request asks for it, a progress sink; both ride the diagnostic sink into every engine
call that takes them (zipnative 1.1.0 takes `signal` and `onProgress` on its common
options), and `compute_crc32` / `inflate_raw` check the signal and report progress between
their own chunks. `verify_zip` is the exception: zipnative's `verifyZip` is synchronous and
takes neither, so the tool checks the signal once before the verification starts and the
verification then runs to completion (an engine limitation).

**Cancellation.** A client that sends `notifications/cancelled` for the request (or an
HTTP client that goes away) aborts the signal:

```json
{ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7, "reason": "user aborted" } }
```

The engine stops between chunks and releases what it held (stream locks, worker pools);
a partial output file is removed; nothing is cached. The call ends as the wrapper code `CANCELLED`
(`data.remedy: 'retry'`) — over MCP the SDK sends no response for a cancelled request,
so a client sees the code only through the in-process `callToolDirect`. Cancellation is
best-effort: work that completed before the abort reached the engine is returned as a
result, but never cached. The tools that stop on the signal are `inspect_zip`,
`list_zip_entries`, `read_zip_entry`, `extract_zip`, `scan_zip_forward`, `create_zip`,
`modify_zip`, `canonicalize_zip`, `merge_zip`, `compute_crc32` and `inflate_raw`;
`sanitize_entry_paths`, `describe_engine` and `draft_governance_issue` do no work worth
cancelling.

**Progress.** Send a `progressToken` in the request's `_meta` to receive
`notifications/progress`:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": { "name": "extract_zip", "arguments": { "zipPath": "incoming/rich.zip", "outputMode": "file", "outputDir": "unpacked" },
              "_meta": { "progressToken": "extract-1" } } }
```

```json
{ "jsonrpc": "2.0", "method": "notifications/progress",
  "params": { "progressToken": "extract-1", "progress": 18430, "message": "3 entries, 9216 bytes in, 9211 bytes out" } }
```

`progress` is built from the engine's monotonic snapshots (bytes in + bytes out +
entries done) and is strictly increasing across the whole call — a tool that runs
several engine operations, such as `merge_zip` reading several sources, carries the
finished operation's counter forward and never goes backwards. Notifications are
throttled to one per 200 ms, plus the one that completes a known entry count. No
`total` is sent (the byte total is not known in advance). Without a `progressToken`
no notification is sent; the result is the same either way.

## 7. What is deliberately not offered

- **No remote source.** `openZipRange` could read an archive served by HTTP ranges; this
  server feeds it only the sandbox file's handle or inline bytes. No tool argument names
  a URL, ever (`describe_engine.unexposed` lists it).
- **No external stream input.** JSON-RPC has no stream channel; a `ByteSource` is built
  internally from a sandbox file.
- **No byte-range writes or in-place edits.** `modify_zip`, `canonicalize_zip` and
  `merge_zip` read their inputs in memory (1 GiB) and write a new file; the input is
  never modified.
