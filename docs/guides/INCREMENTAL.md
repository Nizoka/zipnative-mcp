# Incremental modification — `modify_zip`, remanence and compaction

> `modify_zip` edits an existing archive **without recompressing anything**. It has two
> save modes with very different byte-level consequences: `append` keeps every original
> byte and leaves superseded payloads inside the file (data remanence); `compact`
> rewrites the archive canonically and removes them. This guide explains both, the
> `ZIP_DEAD_BYTES_RATIO` signal, the 7-Zip stale-payload differential observed by the
> engine's conformance suite, and what rename, comment and SFX prefixes do.

The `incremental_update` MCP prompt is the short form of this page. The engine's own
statement is in [zipnative `SECURITY.md` → Known limitations](https://github.com/Nizoka/zipnative/blob/main/SECURITY.md).

---

## 1. The operations

`operations[]` (1–1000) run **in order** against the opened archive:

| `op` | Effect | Refusal |
|---|---|---|
| `add` | a new entry (`dataBase64` / `text` / `sourcePath`, or `directory: true` for an explicit directory) with optional `compression`, `date`, `comment`, `unixMode` / `externalAttributes`, `extraFields` | `ZIP_ENTRY_EXISTS` if the name is present |
| `replace` | new content for an existing entry (same options; not a directory) | `ZIP_ENTRY_NOT_FOUND` otherwise |
| `remove` | drops the entry from the central directory | `ZIP_ENTRY_NOT_FOUND` |
| `rename` | `{ from, to }` — a **raw copy** under the new name: the payload is not decompressed or recompressed, only the headers change | `ZIP_ENTRY_NOT_FOUND` (`from`), `ZIP_ENTRY_EXISTS` (`to`) — a rename never overwrites; `remove` the target first |
| `setComment` | the archive comment (≤ 65 535 bytes UTF-8) | — |

New payloads are compressed with the archive-level `compression` (`store` / `deflate`,
`level`, `deterministic`) and dated with `defaultDate` (DOS epoch by default; `'now'`
emits `ZIP_TIMESTAMP_NOT_PINNED`). Entries that are kept are copied verbatim —
timestamps, flags, attributes, extra fields and compressed bytes included.
`_meta.error.data` carries `operationIndex` and `op` so you know which step failed.

Two inputs the engine refuses up front: an archive with **duplicate entry names**
(`ZIP_DUPLICATE_ENTRY_NAME` — rebuild it with `create_zip` from the extracted content)
and an unsafe **new** name (`ZIP_INVALID_ENTRY_NAME`).

## 2. `mode: 'append'` (default) — `save()`

The engine's append-only save: the original bytes stay **verbatim** as a prefix, the
new payloads are appended after them, and a new central directory (listing the
surviving, renamed and added entries) is written at the end.

- Fast and byte-preserving: nothing you kept is re-read, decompressed or moved; the
  input is a byte-exact prefix of the output (`summary.grewByBytes` is the delta).
- No edits and an unchanged comment return **the same buffer** (`summary.noOp: true`,
  `grewByBytes: 0`).
- The previous central directory remains inside the file; a reader that honours the
  final central directory (the engine, Info-ZIP unzip, bsdtar, Python `zipfile`,
  `jar`) sees only the current entries. `inspect_zip` reports `multipleEocd: true`
  (from the `ZIP_MULTIPLE_EOCD` diagnostic) on such a file — expected, not a fault.

### Data remanence

**`remove` and `replace` in append mode do not erase content.** The superseded
payload — the secret you removed, the previous version of the file you replaced —
remains in the output, byte for byte, recoverable by anyone with a hex editor or a
lenient reader. The engine documents this loudly and so does the tool description.

The `ZIP_DEAD_BYTES_RATIO` diagnostic (info) fires when an append-only save leaves
**more than 50 % dead bytes** in the file: it is the signal that compaction is due.
`summary.outputBytes` vs the sum of live entries tells the same story.

### The 7-Zip stale-payload differential

The engine's conformance suite records a finding on append-only output: on an
archive updated with `save()` — where the superseded central directory legitimately
remains inside the file — **7-Zip (23.01 and 26.02 alike) extracts the stale replaced
payload and misses the appended entry**. It does not honour the authoritative final
central directory the way the five other integrity tools and the engine's strict
reader do. That is the multi-reader parser differential the security model warns
about, observed on a mainstream tool. Consumers of incremental output that must
interoperate with 7-Zip should ship `compact` output instead; the veraZIP gate of
this repository carries the same documented exclusion for the append-mode corpus
entry ([`CONFORMANCE.md`](CONFORMANCE.md) → level 1).

## 3. `mode: 'compact'` — `saveCompact()`

A canonical rewrite: the surviving entries are copied in canonical order into a fresh
archive — **still without recompression** (compressed bytes are copied as they are) —
followed by a new central directory.

- Removed and replaced payloads are **truly gone**; the file holds only live data.
- The layout is canonical again: data-descriptor bits on copied entries are cleared
  (sizes and CRC are written in the local headers), the entry order is the engine's
  canonical order, and `inspect_zip` reports `canonicalLayout: true`.
- An **SFX / prepended prefix is dropped** (`ZIP_PREPENDED_DATA` on the input; none
  on the output) — the output is a plain ZIP that starts with a local file header.
  If the self-extractor stub matters, keep append mode.
- The output is generally smaller (`summary.grewByBytes` may be negative) and takes
  one read pass over the surviving entries instead of none.

Use `compact` to delete secrets, to hand an archive to 7-Zip users, after a long
series of appends, or whenever `ZIP_DEAD_BYTES_RATIO` appears.

## 4. Choosing

| You want | Mode |
|---|---|
| The fastest possible update; the original bytes must stay a prefix (signatures over the prefix, resumable uploads) | `append` |
| To delete something for real | `compact` |
| Interoperability with 7-Zip on an updated archive | `compact` |
| To keep an SFX stub | `append` |
| A canonical, minimal archive after many edits | `compact` |
| Only `add` operations, no `ZIP_DEAD_BYTES_RATIO` yet | either — `append` is cheaper |

## 5. Verifying the result

- `verify_zip` on the output: `ok: true`, every kept entry `localHeaderMatch` /
  `crcMatch` / `sizeMatch` (the engine compares the copied records against their
  payloads).
- `inspect_zip`: `entryCount`, `multipleEocd` (append) vs `canonicalLayout: true`
  (compact), `prependedData` (SFX kept vs dropped), `diagnostics` for
  `ZIP_DEAD_BYTES_RATIO`.
- `includeSha256: true` on `modify_zip` for a fingerprint; `summary.entryCountBefore`
  / `entryCountAfter` for the arithmetic.
- To confirm remanence is gone after `compact`: `scan_zip_forward` on the output
  lists only the live entries (an append-mode output would still show the superseded
  local headers in stream order — the forward reader is exactly the lenient reader that
  sees dead bytes).

## 6. Chaining without re-sending bytes

Inside the sandbox every step can reference the previous one by path:

```
create_zip  { …, outputMode: 'file', outputPath: 'build/app.zip' }
modify_zip  { zipPath: 'build/app.zip', operations: […], mode: 'append', outputMode: 'file', outputPath: 'build/app-v2.zip' }
modify_zip  { zipPath: 'build/app-v2.zip', operations: [{ op: 'remove', name: '.env' }], mode: 'compact', outputMode: 'file', outputPath: 'build/app-final.zip' }
verify_zip  { zipPath: 'build/app-final.zip' }
```

The server never overwrites (`OUTPUT_EXISTS`), so every version stays on disk until
the operator removes it; path inputs are never cached.
