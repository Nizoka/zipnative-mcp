# Security model — zipnative-mcp

> zipnative-mcp treats every archive as untrusted input and the LLM driving it as an
> untrusted caller. The engine's default code path is the safe one; the server adds a
> single filesystem boundary, byte caps on every exchange, and operator ceilings that
> no tool argument can exceed. Refusals carry a frozen code and name the remedy.

This guide is the threat-and-defence view. The reporting policy, supported versions
and release-integrity statement are in [`SECURITY.md`](../../SECURITY.md) at the
repository root; the engine's own model is
[zipnative `docs/guides/security.md`](https://github.com/Nizoka/zipnative/blob/main/docs/guides/security.md).

---

## 1. Why ZIP needs this

ZIP is an attacker-friendly format: parsed from the end, tolerant of leading and
trailing garbage, metadata duplicated between the central directory and local
headers, 16/32/64-bit size fields mixed freely, and entry names that are arbitrary
bytes. Most historical archive CVEs are parser differentials, path traversal or
resource exhaustion — all three are addressed structurally by the engine, and the
server never re-implements a byte of ZIP parsing that could reintroduce them.

## 2. Trust boundaries

| Party | Trust | Consequence |
|---|---|---|
| The **host process** (Claude Desktop, Cursor, an HTTP client on loopback) | trusted | It spawned the server, chose the environment, and owns the pipe. |
| The **operator** who sets the environment variables | trusted | The sandbox directory, the ceilings and the HTTP token are their decisions. |
| The **LLM** controlling the host | **untrusted** | Every tool argument may be malicious: names, paths, limits, base64. |
| **Archive inputs** | **untrusted** | Every header, name, size, flag and payload may lie. |
| The **filesystem outside `ZIPNATIVE_MCP_OUTPUT_DIR`** | must remain inaccessible | The server neither reads nor writes anywhere else. |
| The **network** | does not exist | There is no network code path. |

## 3. Threats and defences (engine guards, on by default)

| Threat | Defence | CWE | Where an agent sees it |
|---|---|---|---|
| Zip-slip path traversal (`../`, absolute paths, drive letters, backslashes, UNC, NUL, NTFS alternate data streams) and Windows reserved device names (`CON`, `NUL`, `COM1`…) | `rejectTraversal: true` by default in `extract_zip`; the engine's `sanitizeEntryPath()` is the only path ever joined onto `outputDir`, and is exported as `sanitize_entry_paths` for external sinks | CWE-22 / CWE-67 | `ZIP_PATH_TRAVERSAL`; `rejectTraversal: false` **skips** such entries (listed in `skipped`), never emits them; `sanitizedPath` on every entry row |
| Decompression bombs (high ratio, nesting, entry floods) | per-entry and total output caps, compression-ratio bound, entry-count cap, name / extra / comment / central-directory byte bounds — the eight `ZipLimits`, enforced **during** inflation, not after | CWE-400 / CWE-409 | `ZIP_LIMIT_EXCEEDED` with `data.limit` / `configured` / `observed`; raised per call through `limits`, bounded by the operator ceilings |
| Symlink entries redirecting extraction | `rejectSymlinks: true` by default; a symlink accepted through `rejectSymlinks: false` is written as a **regular file holding the target text**, never materialised as a link | CWE-59 | `ZIP_SYMLINK_REJECTED`; `isSymlink` on entry rows; `inspect_zip check: 'no-symlinks'` |
| Overlapping entries (one payload claimed by many entries, smuggling), entries reaching into the central directory or past EOF | always-on region-boundary checks over central-directory ranges — up front under `validate: 'eager'` (`inspect_zip` by default, the `extract_zip` pre-flight in both modes, `verify_zip`), at first read otherwise; **no opt-out** | CWE-405 | `ZIP_ENTRY_OVERLAP`, `ZIP_RECORD_TRUNCATED` |
| Parser-differential smuggling (central directory disagreeing with local headers) | the central directory is authoritative; method / size / CRC divergence is fatal **when the entry is read** (the eager extent pass does not compare them), name divergence is diagnosed | CWE-436 | `ZIP_CD_LFH_MISMATCH`, `ZIP_SIZE_MISMATCH` on `read_zip_entry` / `extract_zip`; `ZIP_NAME_MISMATCH` diagnostic; `verify_zip` `localHeaderMatch` is the one-call gate |
| Ambiguous EOCD (trailing garbage, several candidate records) | only a self-consistent EOCD closest to EOF is accepted; ambiguity is refused, never guessed | — | `ZIP_EOCD_NOT_FOUND`, `ZIP_EOCD_INCONSISTENT`; `ZIP_MULTIPLE_EOCD` / `ZIP_PREPENDED_DATA` diagnostics |
| Zip64 field spoofing (sentinel values masking lying 64-bit fields) | Zip64 records cross-checked against every non-sentinel classic field; divergence is fatal | CWE-1288 | `ZIP_ZIP64_CONTRADICTION`; `ZIP_ZIP64_EXTRA_IGNORED` diagnostic |
| Duplicate entry names shadowing each other during extraction | `onDuplicate: 'error'` by default | CWE-694 | `ZIP_EXTRACT_DUPLICATE_PATH`; `'first'` / `'last'` resolve deliberately; `inspect_zip check: 'no-duplicates'` |
| Integer overflow (> 2^53 sizes / offsets) | 64-bit fields read via BigInt and rejected above `Number.MAX_SAFE_INTEGER` | CWE-190 | `ZIP_VALUE_UNREPRESENTABLE` |
| Corrupt payloads masquerading as content | CRC-32 verified on every read by default (`verifyCrc`), declared vs measured sizes compared | — | `ZIP_CRC_MISMATCH` with `expectedCrc` / `actualCrc`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DECOMPRESSION_FAILED` |
| Encrypted entries creating false confidence | no decryption in 1.x by policy (ZipCrypto is broken); encrypted entries are **detected**, never decrypted | — | `ZIP_UNSUPPORTED_ENCRYPTION`; `isEncrypted` on rows; `verify_zip` skips them; `inspect_zip check: 'no-encryption'` |

Every relaxation is an explicit, named input (`rejectTraversal`, `rejectSymlinks`,
`onDuplicate`, `limits`) — never a silent default — and every refusal carries the
frozen `ZIP_*` code in `_meta.error.code` with the engine message that names the
remedy. The machine-readable registry is [`../data/errors.json`](../data/errors.json).

## 4. What the server adds on top

| Threat | Defence | CWE |
|---|---|---|
| The LLM naming a file outside the sandbox (`zipPath`, `sourcePath`, `outputPath`, `outputDir`) | `src/sandbox.ts` is the single boundary: relative paths only; NUL, absolute, Windows-absolute and UNC rejected (also on POSIX); `path.relative` containment; container-extension allow-list on archive paths; `INPUT_NOT_FOUND` messages carry the relative path only | CWE-22 / CWE-73 |
| A symlink or junction pre-planted inside the sandbox redirecting a write **or a read** outside it | writes: after every `mkdir -p`, the **real** path of the parent must still lie inside the real sandbox; reads (`zipPath`, `sourcePath`, `resources/read`): the **real** path of the file itself must lie inside it — the check is on the file, not only its parent, so a file symlink cannot slip past (`assertRealpathInside`) — `SECURITY_VIOLATION` otherwise, `INPUT_NOT_FOUND` for a dangling link, and no absolute path ever leaves in the message | CWE-59 |
| Arbitrary file overwrite | every write opens with `wx` (`OUTPUT_EXISTS` when the target exists); a partial file is removed on failure; the input archive is never touched | CWE-73 |
| Resource exhaustion through the JSON-RPC exchange | the `src/caps.ts` envelope: 256 MiB stdio frame / HTTP body (413), 128 MiB decoded base64 input per call, 1 GiB buffered path input, 16 MiB per inline entry, 32 MiB per inline extraction, 50 MiB per inline output, 4 GiB streamed file output (enforced while writing), bounded JSON shapes (entries, operations, names, globs, extra fields, `fields` paths), 200 diagnostics per result; `inflate_raw` requires `maxOutput` | CWE-400 |
| The LLM raising engine limits to disable the bomb guards | per-call `limits` are capped by the **operator ceilings** `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS` (`LIMIT_CEILING_EXCEEDED` names the variable); a ceiling below an engine default tightens it silently; an invalid ceiling refuses to start | CWE-400 / CWE-409 |
| Prototype pollution / unexpected keys | `additionalProperties: false` on every JSON Schema object; Zod `.strictObject` at every nesting level (unknown keys → `VALIDATION_ERROR`, never stripped) | CWE-1321 |
| Malformed base64 reaching the parser | `src/base64.ts` diagnoses `data:` URIs, PEM text, nested URIs, double encoding and empty payloads before the engine sees a byte | — |
| Code injection through the engine's extension points | `registerCodec`, `setInflateImpl`, `setDeflateImpl` and `ParallelZipOptions.workerUrl` are **unexposed** — no tool argument can name a module or a worker script | CWE-94 |
| DNS rebinding against the HTTP transport | bound to `127.0.0.1`; foreign `Host` / `Origin` answered 403; the `Origin` port must equal the server port (the SDK's check is port-agnostic); `GET` / `DELETE` 405 | CWE-350 |
| Unauthenticated local access to the HTTP transport | *only when the operator opts in:* `ZIPNATIVE_MCP_HTTP_TOKEN` (≥ 16 chars, no whitespace; a weaker value aborts startup) makes every `/mcp` request require `Authorization: Bearer <token>`, else 401 + `WWW-Authenticate` (RFC 6750 §3.1); constant-time comparison; never logged | CWE-306 |
| Listener exhaustion on keep-alive HTTP connections | disconnect detection is attached per response, not per socket | CWE-400 |
| Diagnostics corrupting the stdio wire | the engine's `console.warn` fallback is never reached: a diagnostic sink is installed on every engine call and the rows travel in the result | — |
| Information leakage in errors | absolute sandbox paths, the HTTP token and errno details beyond the code never appear in `_meta.error`; the engine holds no key material | CWE-209 |

## 5. Limits and ceilings — the fragment every engine tool accepts

```jsonc
"limits": {
  "maxEntries": 100000,                   // ≤ ZIPNATIVE_MCP_MAX_ENTRIES
  "maxEntryUncompressedSize": 1073741824, // ≤ ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES
  "maxTotalUncompressedSize": 8589934592, // ≤ ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES
  "maxCompressionRatio": 1024,            // entries ≥ 1 KiB compressed
  "maxNameBytes": 4096,
  "maxExtraFieldBytes": 65535,
  "maxCommentBytes": 65535,
  "maxCentralDirectoryBytes": 268435456
}
```

The values above are the engine defaults (`DEFAULT_ZIP_LIMITS`, reported by
`describe_engine.defaultLimits`). Absent keys keep them; `Infinity` is not JSON, so
"disable" is spelled as the ceiling. Raising a bound is always an explicit decision
for **trusted input only**; the operator decides how far an agent may go by setting
the ceilings in the server environment. `scan_zip_forward.maxEntries` (work bound on
an unbounded stream) and `create_zip.parallel.workers` are ceiling-bound the same way.

## 6. The sandbox — reads and writes

`ZIPNATIVE_MCP_OUTPUT_DIR` is the **only** directory the server touches, for reading
(`zipPath`, `sourcePath`, `resources/read`) as much as for writing (`outputMode: 'file'`,
`outputDir`, governance drafts). Unset, the server performs no file I/O except the
opt-in response cache under `ZIPNATIVE_MCP_CACHE_DIR` and works on base64 only — the
recommended posture when the host does not need files.

When set: give it a directory the host owns, keep it empty or trusted (a
pre-existing symlink or junction inside it is detected by the realpath check on reads
and writes alike, but "use an empty destination" is the documented posture), and remember that everything
in it is enumerable through `resources/list` and readable through `resources/read`
(≤ 50 MiB per read) by the same host. Extracted files are written with the
sanitized `/`-relative path only; `unixMode` bits are never applied to the
filesystem; no timestamps are restored.

## 7. Symlink handling, in one place

- Reading: a symlink **entry** inside an archive is reported (`isSymlink: true`,
  `inspect_zip.symlinkCount`) and refused by `extract_zip` (`ZIP_SYMLINK_REJECTED`)
  unless `rejectSymlinks: false`, in which case its target text becomes an ordinary
  file — the server never creates a link.
- Writing: a symlink **on disk** inside the sandbox is followed by `realpath` before
  any write, and a parent whose real location leaves the sandbox is refused
  (`SECURITY_VIOLATION`).
- Reading: `zipPath` / `sourcePath` / `resources/read` go through the same resolver
  **and** the same realpath check, applied to the file itself: a file or directory
  link whose real location leaves the sandbox is refused (`SECURITY_VIOLATION`), a
  dangling link is `INPUT_NOT_FOUND`, and a regular file still reads.
- The forward scanner (`scan_zip_forward`) cannot see symlink attributes (they live
  only in the central directory): `isSymlink` is `null` there.

## 8. The forward reader's trust caveat

`scan_zip_forward` reads local headers **alone** — there is no central directory to
cross-check names, sizes or methods, so a hostile archive can present different
content there than `inspect_zip` / `list_zip_entries` authoritatively report (the
upload-scanner differential, CWE-436 adjacent). The stream must start at a local
header: an SFX / prepended prefix is refused (`ZIP_SIGNATURE_MISMATCH`) — route it to
`inspect_zip`, which reports `prependedData`. All size limits are enforced by
output counting and CRCs are verified when a payload is read, but treat forward-read
metadata as unverified: use it only for streams you cannot seek, compare with the
authoritative readers whenever the whole archive is available, and never feed its
names to a filesystem without `sanitize_entry_paths`.

## 9. Conformant does not mean safe

Every archive the server writes conforms to ISO/IEC 21320-1:2015, validated in CI by
an engine-independent validator ([`CONFORMANCE.md`](CONFORMANCE.md)). Three of the
hostile refusal fixtures — zip-slip, a Windows device name, duplicate paths — are
**perfectly conformant**: the standard constrains the container's structure, not the
meaning of entry names. That is precisely why the extraction guards above exist on
top of conformance, and why the conformance gate records those archives as
"conformant but refused" instead of pretending the profile catches what it does not.

## 10. What the server never does

No network egress of any kind (no telemetry, no GitHub, no URL from any source), no
`eval`, no dynamic import of caller-named modules, no filesystem access outside the
sandbox, no decryption, no overwrite, no silent fallback on a bad configuration (a
weak token or an invalid ceiling exits 1 with one `fatal:` line). The supply chain is
three runtime dependencies; CI runs CodeQL, OpenSSF Scorecard, `npm audit`, the
conformance gate on Linux and Windows, and the package is published with provenance
and an SBOM ([`SECURITY.md`](../../SECURITY.md) → *Release integrity*).

## 11. Reporting

Privately, via GitHub Security Advisories — see [`SECURITY.md`](../../SECURITY.md).
Engine-level findings (parser, writer, guards) belong to
[Nizoka/zipnative](https://github.com/Nizoka/zipnative/security/advisories/new);
report to both when unsure.
