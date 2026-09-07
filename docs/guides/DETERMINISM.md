# Determinism — reproducible archives through zipnative-mcp

> Reproducible output is a product feature with a written contract, inherited from the
> engine: what is guaranteed always, what is guaranteed per environment, and what
> `compression: { deterministic: true }` pins bit-for-bit on every runtime. This guide
> maps the engine's three levels onto the `create_zip` / `modify_zip` inputs and the
> `inspect_zip` verdict, and shows how to prove reproducibility from a tool result.

The engine's contract (with the frozen encoder constants and the golden tests) is
[zipnative `docs/guides/determinism.md`](https://github.com/Nizoka/zipnative/blob/main/docs/guides/determinism.md).
The `reproducible_archive` MCP prompt is the short form of this page.

---

## 1. The three levels of guarantee

| Level | Guarantee | How you get it | What the server reports |
|---|---|---|---|
| **1 — structurally deterministic, always** | Entry order, header layout, flags, attributes, timestamps and Zip64 decisions never depend on the clock, randomness, locale or environment. Two `create_zip` calls with identical inputs produce structurally identical archives everywhere. | The defaults. Do not pass `defaultDate: 'now'` or a wall-clock per-entry `date`. | `inspect_zip.determinism.deterministic: true` (epoch timestamps + canonical order + UTF-8 flags) on the result |
| **2 — bitwise deterministic per environment, the default** | Deflate compresses through the best available tier (`node:zlib` in this server), so the bytes are stable for a given Node + zlib build, but may differ across environments. | The defaults again. | `create_zip.summary.deflateTier: 'node-zlib'`, `summary.deterministic: false`; the `ZIP_NONDETERMINISTIC_CODEC` diagnostic when an explicit date is pinned but the codec is not |
| **3 — bitwise deterministic everywhere** | The pure-TS encoder is pinned: `SHA256(A) === SHA256(B)` for identical inputs on every runtime (Node versions, Bun, Deno, browsers). The mode for content addressing, reproducible builds, caching and signatures. Changing these bytes is semver-major, upstream and here. | `compression: { deterministic: true }` at archive level (or on every entry). Slower than zlib. | `summary.deflateTier: 'pure-pinned'`, `summary.deterministic: true` (only when every entry is pinned and no wall-clock date is used), `summary.sha256` with `includeSha256: true` |

`summary.deterministic` therefore answers "are these bytes reproducible *across
runtimes*?" — the strict question. `inspect_zip.determinism.deterministic` answers the
structural question (level 1) for any archive, whoever wrote it.

## 2. Canonical layout (level 1 rules, always)

| Aspect | Rule |
|---|---|
| Entry order | sorted by raw UTF-8 name bytes, unsigned bytewise (`order: 'canonical'`, the default). `order: 'insertion'` preserves the call order — still deterministic given identical calls (EPUB / JAR need `mimetype` first, stored) |
| Timestamps | DOS epoch `1980-01-01 00:00:00` unless a `date` / `defaultDate` is given; an ISO instant is stored at 2-second DOS resolution (range 1980–2107); `'now'` emits `ZIP_TIMESTAMP_NOT_PINNED` |
| Name encoding | always UTF-8 with flag bit 11, including pure-ASCII names (`utf8Flags`) |
| version-made-by | constant `0x032D` (Unix, spec 4.5) |
| versions-needed | 20, or 45 exactly when the entry uses Zip64 |
| External attributes | files `0o100644 << 16`, directories `(0o40755 << 16) | 0x10`; `unixMode` / `externalAttributes` override per entry deterministically |
| Internal attributes | 0 |
| Extra fields | none, except Zip64 (`0x0001`) exactly when a field overflows; caller-supplied `extraFields` are embedded verbatim (their determinism is yours; id `0x0001` is refused) |
| Method selection | empty content is stored; deflate falls back to store when it does not shrink the payload (a pure function of the content); `compression.method: 'store'` forces store |
| Zip64 records | emitted exactly when a classic field overflows; classic EOCD sentinels only for the overflowed fields |
| Data descriptors | never on buffered entries; always on `stream: true` entries |

`inspect_zip` reports each aspect: `determinism.epochTimestamps`, `canonicalOrder`,
`utf8Flags`, `noDataDescriptors` (= `canonicalLayout`), and the `check` values
`epoch-timestamps`, `canonical-order`, `utf8-names`, `canonical-layout` /
`no-data-descriptor`, `deterministic`, `no-zip64` / `zip64`.

## 3. Pinned dates

- Omit `defaultDate` and every per-entry `date`: the DOS epoch, reproducible.
- Pass one fixed ISO instant (`"2026-09-07T00:00:00Z"`) to `defaultDate` (and, if you
  need per-entry values, fixed instants to `date`): the bytes are stable run-to-run.
  Note that the `inspect_zip` verdict *requires* epoch timestamps
  (`deterministic = epochTimestamps && canonicalOrder && utf8Flags`), so such an
  archive reports `determinism.epochTimestamps: false` and therefore
  `determinism.deterministic: false` although it is reproducible. Use
  `includeSha256` (or `check: ['canonical-order', 'utf8-names']`) as the proof in that
  case.
- `defaultDate: 'now'` makes the bytes vary per run: `ZIP_TIMESTAMP_NOT_PINNED`
  (info) is emitted, `summary.deterministic` is `false`, and the response is never
  cached.
- `modify_zip` applies the same rules to the payloads it **adds** (`defaultDate`,
  per-operation `date`); the entries it keeps are copied verbatim, timestamps included.

## 4. The deterministic pin (level 3)

`compression: { deterministic: true }` selects the engine's frozen pure-TS DEFLATE
encoder. Every constant in that encoder is frozen public API upstream (hash
function, level table, lazy matching, block sizes, Huffman construction, block choice
at exact bit cost); the golden SHA-256 tables in the engine's test suite are the
tripwire, and a byte change is semver-major there and here
([`API_STABILITY.md`](../API_STABILITY.md) §3).

- Set it at archive level to pin every entry; a per-entry `compression.deterministic`
  may override in either direction, and `summary.deterministic` is `true` only when
  no entry is left unpinned.
- `level` still applies (0–9, default 6) — it is part of the input, not of the
  environment.
- `summary.deflateTier` reports `pure-pinned`; `describe_engine.engine.deflateTier`
  shows `{ default: 'node-zlib', deterministic: 'pure-pinned' }` for this server
  (the `injected` tier never occurs — `setDeflateImpl` is unexposed).
- The pinned encoder is whole-buffer and slower than zlib; for many large entries
  combine it with `parallel` (still byte-identical, see below).

## 5. Parallel byte-identity

`create_zip.parallel` compresses through the engine's worker pool
(`zipnative/worker`). The output is **byte-identical** to the sequential writer for
the same tier: the pool only moves the `compressSync` calls to worker threads and the
segment generator that lays out the archive is the same. `summary.parallel` reports
`{ requested, workers }`; `summary.deflateTier` is `node-zlib` or `pure-pinned`, never
`injected`. The engine falls back to inline compression on a worker timeout
(`jobTimeout`) or for small entries (`minWorkerJobSize`) without changing a byte.
Because the fallbacks are timing-dependent the *response* is never cached, but the
bytes are the same. `ZIPNATIVE_MCP_WORKERS=0` keeps everything on the calling thread —
same bytes again.

## 6. Streamed layout: reproducible, not canonical

`stream: true` on a `sourcePath` entry feeds the file through `addStream` and the
archive is assembled by streaming: every such entry uses the **data-descriptor
layout** (flag bit 3; sizes and CRC written after the payload). The content is the
same as the buffered layout; the bytes are not (an engine contract — Info-ZIP and
bsdtar do the same to a pipe). A streamed archive is reproducible run-to-run, and
`inspect_zip` separates the two questions: `determinism.deterministic: true`,
`determinism.canonicalLayout: false`. When bytes must match a buffered build, do not
stream. `modify_zip mode: 'compact'` re-canonicalises (descriptor bits are cleared on
the entries it copies); `mode: 'append'` preserves the original bytes as a prefix
and therefore whatever layout they had.

## 7. Documented determinism losses

| Situation | Effect | Signal |
|---|---|---|
| Default codec tier (no `deterministic: true`) | bytes vary across zlib builds | `ZIP_NONDETERMINISTIC_CODEC` (info; emitted when an explicit date is pinned but the codec is not); `summary.deflateTier: 'node-zlib'` |
| `defaultDate: 'now'` or a wall-clock `date` | bytes vary per run | `ZIP_TIMESTAMP_NOT_PINNED` (info); `summary.deterministic: false`; never cached |
| `stream: true` vs an inline / buffered entry with identical content | different layout (data descriptor) | `inspect_zip.determinism.canonicalLayout: false` |
| `modify_zip mode: 'append'` | the output embeds the input verbatim plus dead bytes | `ZIP_DEAD_BYTES_RATIO` past 50 % dead bytes; `summary.grewByBytes` |
| Caller-supplied `extraFields` | embedded verbatim | none — their determinism is yours |

## 8. Proving it from a tool result

**Same inputs, twice:**

```jsonc
// call 1 and call 2 — identical arguments
{ "entries": [{ "name": "data.json", "text": "{\"a\":1}\n" }],
  "compression": { "deterministic": true }, "includeSha256": true }
// → summary.sha256 equal in both results; summary.deterministic true; summary.deflateTier "pure-pinned"
```

With `ZIPNATIVE_MCP_CACHE_DIR` set the second call may be a cache hit
(`_meta.cached: true`) — run it on another machine, or vary something irrelevant
such as `chunkSize`, to make the comparison meaningful.

**Any archive, whoever wrote it:**

```jsonc
{ "zipBase64": "<the bytes>", "check": ["deterministic", "canonical-layout", "utf8-names", "no-zip64"],
  "verbosity": "summary", "fields": ["checksPassed", "checks", "deterministic", "canonicalLayout"] }
// inspect_zip → checksPassed; each check row carries a detail string
```

**Cross-tool identity:** `create_zip` with and without `parallel`, same
`compression`, `includeSha256: true` on both → equal `summary.sha256`. `create_zip`
followed by `modify_zip` with an empty-effect operation set is refused by the schema
(at least one operation), but `modify_zip` with `setComment` to the *same* comment
returns `summary.noOp: true` and the identical bytes.

**In CI:** `inspect_zip` with `strict: true` and `check: ['deterministic']` fails
the call on the first determinism diagnostic (`ZIP_STRICT_DIAGNOSTIC`) and on a
`false` verdict (`checksPassed: false`).
