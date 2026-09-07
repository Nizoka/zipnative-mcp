---
description: "Use when adding or changing a tool handler, its input/output schema, the shared entry / filter / projection / diagnostics fragments, or the engine error mapping."
applyTo: "src/tools/**,src/entry-spec.ts,src/entry.ts,src/filter.ts,src/projection.ts,src/diagnostics.ts,src/zip-errors.ts,src/limits.ts"
---
# Tool Standards

## Thin, faithful wrapper
- No ZIP logic in `src/`: every byte-level operation (EOCD, central directory, local headers, CRC, DEFLATE, path sanitisation, limits) is an engine call. A tool maps inputs to engine options, wraps the call in `guard` / `guardAsync` (`src/zip-errors.ts`), and shapes the result.
- Expose the engine's options by their engine names where the CLI does too (`zipnative-cli` field names: `usesDataDescriptor`, `methodName`, `sanitizedPath`, …) so an agent that knows one surface reads the other.
- The 39 `ZIP_*` codes pass through verbatim with the engine's message (which names the remedy) and `data` (limit / configured / observed, entryName, feature, CRCs). Wrapper codes are the ones in AGENTS.md §6 only; a new one needs a doc row and a test.
- Diagnostics ARE the signal for ZIP: every engine call takes `sink.options`; every result spreads `sink.report()` (`diagnostics`, `diagnosticCounts`, `diagnosticsTruncated`). `strict: true` escalates the first diagnostic.

## Shape of a tool module
```
export const X_NAME = 'x';
export const X_INPUT_SCHEMA = { type: 'object', additionalProperties: false, properties: {…} } as const;
const InputSchema = z.strictObject({…}).superRefine(…);      // mirrors the JSON Schema exactly
export interface XResult extends DiagnosticsReport { … }
export const X_OUTPUT_SCHEMA = { … } as const;                 // read tools: + X_SUMMARY_PROPERTIES / xSummary()
export async function xTool(rawInput: unknown): Promise<XResult> { const input = parseInput(InputSchema, rawInput); … }
```
- Register in `src/server.ts` (`TOOLS`, in catalogue order) with `kind`, `title`, `description` (what it does, when to prefer another tool, the caps, the codes it raises), annotations (`READ_ONLY` / `WRITES`), one or two `_meta.examples`; update `SERVER_INSTRUCTIONS`, AGENTS.md, README.md, llms.txt, `tests/_fixtures/tool-shape.json` and add `tests/<tool>.test.ts` + an `examples/<kebab>.json`.

## Inputs
- Archive input: `...ARCHIVE_INPUT_PROPERTIES` / `...ARCHIVE_INPUT_SHAPE` + `refineArchiveInput` (`zipBase64` XOR `zipPath`); load with `loadArchive` (buffered, capped) or `openArchiveSource` (bounded ByteSource for the forward scanner).
- Entry payloads: `ENTRY_PAYLOAD_PROPERTIES` / `EntryPayloadShape` + `refineEntryPayload` + `toAddEntryOptions` (dates in the DOS range, `unixMode` XOR `externalAttributes`, extra field id 0x0001 reserved).
- Filters: `FILTER_INPUT_SCHEMA` / `FilterSchema` + `compileEntryFilter`. Limits: `LIMITS_INPUT_SCHEMA` / `LimitsSchema` + `resolveCallLimits` (ceiling check). Projection: `PROJECTION_INPUT_PROPERTIES` / `ProjectionShape`. Output: `OUTPUT_INPUT_PROPERTIES` + `emitArchive` / `emitArchiveStream`.
- Every cap is a constant in `src/caps.ts`, quoted in the description and advertised by `describe_engine.caps` through the `CAPS` record — the byte envelope, the JSON-shape bounds (entries, operations, names, filter names / globs, extra fields, `fields` paths, the scanner's default `maxEntries`, resource links, range length), the `resources/list` bounds (entries, walk depth, read size) and the cache bounds (TTL, size). A new constant goes into `CAPS` in the same change (`tests/describe-engine.test.ts` asserts every numeric export of `src/caps.ts` appears there); the resources and cache modules import their bounds from `src/caps.ts` rather than redeclaring them.
- Determinism wording: `create_zip` is *reproducible on one runtime by default*; `summary.deterministic` is true only under `compression.deterministic: true`; `inspect_zip.determinism` is the structural verdict. Say all three where an agent reads them.
- The wrapper never reads a PK signature (CLAUDE.md convention 7): `scan_zip_forward` classifies `stoppedAt` by byte accounting over a finely sliced tail, never by scanning bytes.

## Determinism and reproducibility
- Default output must stay byte-identical across releases; `compression.deterministic: true` output changing is semver-major. `create_zip` defaults: canonical order, DOS-epoch dates, UTF-8 names, constant attributes, Zip64 only on overflow; `summary.deterministic` / `deflateTier` / `sha256` prove it.
- Every archive a tool writes must be ISO/IEC 21320-1 conformant: add a corpus entry to `scripts/helpers/zip-corpus.mjs` for any new write-side option and run `npm run validate:zip`.

## Read tools
- Read-only tools never modify their input and are `READ_ONLY`-annotated; results are projectable (`verbosity`, `fields`) and paged where unbounded (`offset` / `limit`, `hasMore`).
- `scan_zip_forward` is the only non-authoritative tool — keep the trust caveat in its description and result (`trust`).
