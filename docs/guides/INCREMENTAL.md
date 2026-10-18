# Incremental modification — `modify_zip`, remanence and compaction

> `modify_zip` edits an existing archive **without recompressing anything**. It has two
> save modes with very different byte-level consequences: `append` keeps every original
> byte and leaves superseded payloads inside the file (data remanence); `compact`
> rewrites the archive and removes them — and, with `canonical`, brings it into the
> engine's canonical deterministic form in the same call. This guide explains both modes,
> the eager input validation, the `ZIP_DEAD_BYTES_RATIO` signal, the 7-Zip stale-payload
> differential observed by the engine's conformance suite, what rename, comment and SFX
> prefixes do, and how `merge_zip` combines archives without recompression.

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

**The input is validated eagerly** (since 1.1.0). `modify_zip` opens the archive with
`validate: 'eager'`, as `inspect_zip` does by default: the overlap table is built and
every entry's extent (its local header included) is checked before any operation runs. The append path never
re-reads the entries it keeps, so a lazily opened archive with overlapping entries —
the smuggling shape every other reader refuses — or a truncated local header would
otherwise be re-emitted unchecked into the output. Such an input is now refused with
its code (`ZIP_ENTRY_OVERLAP`, `ZIP_RECORD_TRUNCATED`, …) before anything is written. The
seeded fuzz suite found the gap; the lock test is `F-001`. The eager pass checks extents,
not contents, so in `mode: 'append'` every non-encrypted entry is also read raw before
the save (its local header and declared sizes — nothing is decompressed): a method / CRC /
size divergence between the central directory and a local header is `ZIP_CD_LFH_MISMATCH`
and a declared-size bomb `ZIP_LIMIT_EXCEEDED`, as compaction and the other writers
refuse them. Names and payloads are otherwise copied verbatim in both modes — an unsafe
name already in the archive (`../../x`) stays in the output, where `extract_zip` still
refuses it.

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

A full rewrite: the surviving entries are copied, sorted by raw name bytes, into a
fresh archive — **still without recompression** (compressed bytes are copied as they
are) — followed by a new central directory.

- Removed and replaced payloads are **truly gone**; the file holds only live data.
- The layout is canonical again: data-descriptor bits on copied entries are cleared
  (sizes and CRC are written in the local headers), the entry order is the engine's
  canonical order (an insertion-ordered layout — EPUB `mimetype` first, a JAR manifest
  first — is **not** preserved: rebuild such a container with `create_zip`
  `order: 'insertion'`), and `inspect_zip` reports `canonicalLayout: true`. The entries keep
  their own timestamps, extra fields and attributes — for the full canonical form, add
  `canonical` (below).
- An **SFX / prepended prefix is dropped** (`ZIP_PREPENDED_DATA` on the input; none
  on the output) — the output is a plain ZIP that starts with a local file header.
  If the self-extractor stub matters, keep append mode.
- The output is generally smaller (`summary.grewByBytes` may be negative) and takes
  one read pass over the surviving entries instead of none.

Use `compact` to delete secrets, to hand an archive to 7-Zip users, after a long
series of appends, or whenever `ZIP_DEAD_BYTES_RATIO` appears.

### `compact` + `canonical` — edit and canonicalise in one call

`canonical: { date?, keepComments?, keepExternalAttributes? }` (mode `compact` only;
`{}` takes the defaults) makes the rewrite `saveCompact({ canonical })`: after the
operations, every entry is normalised into the engine's canonical deterministic form —
sorted by raw name bytes, one timestamp (the DOS epoch, or `date`, read as UTC), the
UTF-8 flag on every name, no extra field but Zip64, version-made-by `0x032D`, no data
descriptor — still without recompression. Comments are dropped unless
`keepComments: true`; external attributes are kept unless
`keepExternalAttributes: false`. `summary.canonical: true` reports it. The rules are
those of `canonicalize_zip` ([`DETERMINISM.md`](DETERMINISM.md) §5); `canonical` on
`mode: 'append'` is `VALIDATION_ERROR`, since an append-mode save keeps the original
bytes verbatim.

```jsonc
// modify_zip — add a file, drop the dead bytes, canonicalise
{ "zipBase64": "<the bytes>", "operations": [{ "op": "add", "name": "CHANGES.md", "text": "# Changes\n" }],
  "mode": "compact", "canonical": {}, "includeSha256": true }
```

## 4. Choosing

| You want | Mode |
|---|---|
| The fastest possible update; the original bytes must stay a prefix (signatures over the prefix, resumable uploads) | `append` |
| To delete something for real | `compact` |
| Interoperability with 7-Zip on an updated archive | `compact` |
| To keep an SFX stub | `append` |
| A minimal archive after many edits | `compact` |
| A reproducible archive in the canonical form after the edits | `compact` + `canonical` |
| Only `add` operations, no `ZIP_DEAD_BYTES_RATIO` yet | either — `append` is cheaper |
| The entries of several existing archives in one | `merge_zip` (§6) |

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

## 6. Merging archives — `merge_zip`

`merge_zip` builds one archive from the entries of 1–32 others **without recompressing
anything**: zipnative's `ZipWriter.addFromReader()` transplants each entry's compressed
bytes with its method, CRC, sizes, timestamp, attributes, comment and extra fields
(Zip64 recomputed), in O(bytes copied).

- **Sources.** `sources[]`, each `zipBase64` XOR `zipPath` with an optional `filter`
  (names, prefix, globs; directories are kept unless the filter excludes them). The
  sources total at most 1 GiB, inline payloads at most 128 MiB in all. Each source is
  opened like every random-access reader, so a hostile source is refused with its code
  and `_meta.error.data.sourceIndex`.
- **Verified by default.** `verify: true` decompresses each entry once to check its CRC
  and size before copying it: a corrupt payload is refused (`ZIP_CRC_MISMATCH` /
  `ZIP_SIZE_MISMATCH`) instead of being propagated. `verify: false` trusts the sources
  and copies their bytes as they are. Encrypted entries cannot be transplanted
  (`ZIP_UNSUPPORTED_ENCRYPTION`) — filter them out.
- **Name collisions.** `onConflict: 'error'` (default) lets the engine refuse the
  second occurrence (`ZIP_DUPLICATE_ENTRY_NAME`); `'first'` / `'last'` keep the
  first / last occurrence across the sources in order and list the others in
  `summary.dropped[] { name, source }` (per source: `summary.perSource[]` with `taken`,
  `filteredOut`, `dropped`).
- **Order and comment.** `order: 'canonical'` (default) sorts by raw name bytes — the
  output is deterministic given the same sources; `'insertion'` keeps the sources' order
  and each source's central-directory order. The sources' comments are not merged;
  `comment` sets the result's.
- **Not the canonical form.** The transplanted entries keep their own timestamps and
  extra fields; run `canonicalize_zip` on the result when it must be canonical.
- **What is not exposed.** `addRaw()` — where the caller vouches for the CRC and the
  sizes of a pre-compressed payload — stays unexposed: an agent cannot forge an
  inconsistent archive through this server. `addFromReader` is the checked form.

```jsonc
// merge_zip — README.md exists in both: keep the second one
{ "sources": [{ "zipBase64": "<a>" }, { "zipBase64": "<b>" }], "onConflict": "last", "includeSha256": true }
```

## 7. Chaining without re-sending bytes

Inside the sandbox every step can reference the previous one by path:

```
create_zip  { …, outputMode: 'file', outputPath: 'build/app.zip' }
modify_zip  { zipPath: 'build/app.zip', operations: […], mode: 'append', outputMode: 'file', outputPath: 'build/app-v2.zip' }
modify_zip  { zipPath: 'build/app-v2.zip', operations: [{ op: 'remove', name: '.env' }], mode: 'compact', outputMode: 'file', outputPath: 'build/app-final.zip' }
verify_zip  { zipPath: 'build/app-final.zip' }
merge_zip   { sources: [{ zipPath: 'build/app-final.zip' }, { zipPath: 'build/plugins.zip' }], outputMode: 'file', outputPath: 'build/bundle.zip' }
```

The server never overwrites (`OUTPUT_EXISTS`), so every version stays on disk until
the operator removes it; path inputs are never cached.
