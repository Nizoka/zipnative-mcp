/**
 * MCP server wiring: registers the zipnative tools on a low-level `Server`
 * instance and exposes a `createServer()` factory so the runtime (CLI,
 * tests, embedded host) can choose how to connect a transport.
 */
// MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, spec 2026-07-28 with a
// legacy 2025-xx fallback). We deliberately stay on the low-level `Server` +
// method-string `setRequestHandler` surface: `McpServer.registerTool` requires
// Standard-Schema inputs and validates `structuredContent` against the advertised
// `outputSchema`, which would break the hand-written JSON Schemas, the
// `verbosity`/`fields` projections and the `isError` contract this server promises.
import {
    Server,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    type CacheHint,
    type CallToolResult,
    type GetPromptResult,
    type ListToolsResult,
    type ServerOptions,
    type Tool,
} from '@modelcontextprotocol/server';
import { VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { isPathInput } from './archive-input.js';
import { getCached, setCached } from './cache.js';
import { ensureEngineReady } from './engine.js';
import { ToolError } from './errors.js';
import { DRAFT_ISSUE_WORKFLOW, GOVERNANCE_CONTRACT_SUMMARY } from './governance.js';
import { type OutputResult } from './output.js';
import { readFields, readVerbosity, selectFields } from './projection.js';
import { listResources, listResourceTemplates, readResource, resourceLinkForPath } from './resources.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from './version.js';
import { COMPUTE_CRC32_INPUT_SCHEMA, COMPUTE_CRC32_NAME, COMPUTE_CRC32_OUTPUT_SCHEMA, computeCrc32, type ComputeCrc32Result } from './tools/compute-crc32.js';
import { CREATE_ZIP_INPUT_SCHEMA, CREATE_ZIP_NAME, CREATE_ZIP_OUTPUT_SCHEMA, createZipTool, type CreateZipResult } from './tools/create-zip.js';
import { __setToolCount, DESCRIBE_ENGINE_INPUT_SCHEMA, DESCRIBE_ENGINE_NAME, DESCRIBE_ENGINE_OUTPUT_SCHEMA, describeEngine, describeSummary, type DescribeEngineResult } from './tools/describe-engine.js';
import { DRAFT_GOVERNANCE_ISSUE_INPUT_SCHEMA, DRAFT_GOVERNANCE_ISSUE_NAME, DRAFT_GOVERNANCE_ISSUE_OUTPUT_SCHEMA, draftGovernanceIssue, type DraftGovernanceIssueResult } from './tools/draft-governance-issue.js';
import { EXTRACT_ZIP_INPUT_SCHEMA, EXTRACT_ZIP_NAME, EXTRACT_ZIP_OUTPUT_SCHEMA, EXTRACT_ZIP_SUMMARY_PROPERTIES, extractSummary, extractZipTool, type ExtractZipResult } from './tools/extract-zip.js';
import { INFLATE_RAW_INPUT_SCHEMA, INFLATE_RAW_NAME, INFLATE_RAW_OUTPUT_SCHEMA, inflateRaw, type InflateRawResult } from './tools/inflate-raw.js';
import { INSPECT_ZIP_INPUT_SCHEMA, INSPECT_ZIP_NAME, INSPECT_ZIP_OUTPUT_SCHEMA, INSPECT_ZIP_SUMMARY_PROPERTIES, inspectSummary, inspectZip, type InspectZipResult } from './tools/inspect-zip.js';
import { LIST_ZIP_ENTRIES_INPUT_SCHEMA, LIST_ZIP_ENTRIES_NAME, LIST_ZIP_ENTRIES_OUTPUT_SCHEMA, LIST_ZIP_ENTRIES_SUMMARY_PROPERTIES, listSummary, listZipEntries, type ListZipEntriesResult } from './tools/list-zip-entries.js';
import { MODIFY_ZIP_INPUT_SCHEMA, MODIFY_ZIP_NAME, MODIFY_ZIP_OUTPUT_SCHEMA, modifyZipTool, type ModifyZipResult } from './tools/modify-zip.js';
import { READ_ZIP_ENTRY_INPUT_SCHEMA, READ_ZIP_ENTRY_NAME, READ_ZIP_ENTRY_OUTPUT_SCHEMA, READ_ZIP_ENTRY_SUMMARY_PROPERTIES, readEntrySummary, readZipEntry, type ReadZipEntryResult } from './tools/read-zip-entry.js';
import { SANITIZE_ENTRY_PATHS_INPUT_SCHEMA, SANITIZE_ENTRY_PATHS_NAME, SANITIZE_ENTRY_PATHS_OUTPUT_SCHEMA, SANITIZE_ENTRY_PATHS_SUMMARY_PROPERTIES, sanitizeEntryPaths, sanitizeSummary, type SanitizeEntryPathsResult } from './tools/sanitize-entry-paths.js';
import { SCAN_ZIP_FORWARD_INPUT_SCHEMA, SCAN_ZIP_FORWARD_NAME, SCAN_ZIP_FORWARD_OUTPUT_SCHEMA, SCAN_ZIP_FORWARD_SUMMARY_PROPERTIES, scanSummary, scanZipForward, type ScanZipForwardResult } from './tools/scan-zip-forward.js';
import { VERIFY_ZIP_INPUT_SCHEMA, VERIFY_ZIP_NAME, VERIFY_ZIP_OUTPUT_SCHEMA, VERIFY_ZIP_SUMMARY_PROPERTIES, verifySummary, verifyZipTool, type VerifyZipResult } from './tools/verify-zip.js';

const SERVER_VERSION = ZIPNATIVE_MCP_VERSION;
const SERVER_NAME = 'zipnative-mcp';

/**
 * Human-readable server identity surfaced in `serverInfo` (MCP `Implementation`).
 * `title` is a display name; `description` mirrors `server.json` so hosts and the
 * MCP registry present consistent metadata during initialization.
 */
const SERVER_TITLE = 'zipnative MCP — ZIP creation, inspection, secure extraction & verification';
/** Mirrors server.json `websiteUrl` (asserted by tests/metadata.test.ts). */
export const SERVER_WEBSITE_URL = 'https://github.com/Nizoka/zipnative-mcp#readme';
const SERVER_DESCRIPTION =
    'Production-grade MCP server for ZIP archives on the zero-dependency zipnative engine: deterministic, reproducible creation ' +
    '(store / deflate, worker-parallel, streamed sources), listing and inspection without extracting, random-access entry reads, ' +
    'secure-by-default extraction (zip-slip, zip-bomb, symlink, duplicate-path and device-name refusals), one-call deep verification, ' +
    'forward scanning of truncated or unseekable streams, incremental modification without recompression, CRC-32, bounded raw-DEFLATE ' +
    'inflation, ISO/IEC 21320-1 conformance validated in CI, MCP resources for sandbox files, and human-in-the-loop AI-governance ' +
    'issue drafting. 13 tools, no network ever, three runtime dependencies (zipnative, the MCP SDK, zod).';

/**
 * MCP 2026-07-28 cache hints (`ttlMs` / `cacheScope`) emitted on the cacheable
 * results. The catalogue (tools, prompts, discovery) is static for a given
 * package version; the sandbox resource listing and produced archives are live,
 * per-host user data and must never be cached by shared intermediaries.
 * 2025-era clients never see these fields.
 */
export const SERVER_CACHE_HINTS = {
    'tools/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'prompts/list': { ttlMs: 86_400_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 0, cacheScope: 'private' },
    'resources/templates/list': { ttlMs: 0, cacheScope: 'private' },
    'resources/read': { ttlMs: 0, cacheScope: 'private' },
} as const satisfies Record<string, CacheHint>;

/**
 * Tools whose output must never be persisted to the opt-in response cache
 * (`ZIPNATIVE_MCP_CACHE_DIR`, plaintext at rest): environment-dependent
 * (`describe_engine`), environment-embedding (`draft_governance_issue`).
 */
const NON_CACHEABLE_TOOLS: ReadonlySet<string> = new Set([DESCRIBE_ENGINE_NAME, DRAFT_GOVERNANCE_ISSUE_NAME]);

/**
 * Cache key namespace: the tool API version, the package version and the
 * engine version, so an engine upgrade can never serve bytes written by the
 * previous engine.
 */
const CACHE_API_VERSION = `${TOOL_API_VERSION}/${ZIPNATIVE_MCP_VERSION}/${ZIPNATIVE_VERSION}`;

/** True when the call's input requests a file-mode output (filesystem side-effect). */
function isFileOutput(input: unknown): boolean {
    if (input === null || typeof input !== 'object') return false;
    const mode = (input as { outputMode?: unknown }).outputMode;
    return mode === 'file';
}

/**
 * True when this call's output may be served from the response cache: never
 * for sandbox references (a path is a reference, not content), file output,
 * wall-clock dates (`defaultDate: 'now'`), the worker pool (timing-dependent
 * fallbacks) or the non-cacheable tools.
 */
function isCacheable(name: string, input: unknown): boolean {
    if (NON_CACHEABLE_TOOLS.has(name) || isFileOutput(input) || isPathInput(input)) return false;
    if (input !== null && typeof input === 'object') {
        const o = input as Record<string, unknown>;
        if (o['defaultDate'] === 'now' || o['parallel'] !== undefined) return false;
    }
    return true;
}

type ToolKind = 'archive-output' | 'extract' | 'inspect' | 'list' | 'read-entry' | 'verify' | 'scan' | 'sanitize' | 'crc32' | 'inflate' | 'engine' | 'governance';

type ToolOutput =
    | CreateZipResult
    | ModifyZipResult
    | InflateRawResult
    | ExtractZipResult
    | InspectZipResult
    | ListZipEntriesResult
    | ReadZipEntryResult
    | VerifyZipResult
    | ScanZipForwardResult
    | SanitizeEntryPathsResult
    | ComputeCrc32Result
    | DescribeEngineResult
    | DraftGovernanceIssueResult;

interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    kind: ToolKind;
    inputSchema: unknown;
    outputSchema?: unknown;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
    /** Minimal MCP `_meta.examples` payload — each entry is a self-contained input. */
    examples?: ReadonlyArray<{ readonly title: string; readonly input: Record<string, unknown> }>;
    handler: (args: unknown) => Promise<ToolOutput>;
}

/**
 * Apply the opt-in token-frugal projection to a read tool's `structuredContent`.
 * `verbosity: 'summary'` swaps the full result for a canonical scalar-only subset;
 * `fields: [...]` then projects to named dot-paths. Defaults return the full result.
 */
function projectStructured(full: Record<string, unknown>, summary: Record<string, unknown>, input: unknown): Record<string, unknown> {
    const base = readVerbosity(input) === 'summary' ? summary : full;
    const fields = readFields(input);
    if (fields.length === 0) return base;
    return selectFields(base, fields) as Record<string, unknown>;
}

/**
 * Surface `fields` paths that matched nothing (a typo, or a field that is only
 * present with another option). Additive: `_meta.unmatchedFields` appears only
 * in that case, so a structured consumer is never left with an empty object
 * and no explanation.
 */
function projectionMeta(full: Record<string, unknown>, summary: Record<string, unknown>, input: unknown): { _meta?: { unmatchedFields: string[]; availableFields: string[] } } {
    const fields = readFields(input);
    if (fields.length === 0) return {};
    const base = readVerbosity(input) === 'summary' ? summary : full;
    const unmatched = fields.filter((f) => {
        const head = f.split('.')[0]?.trim() ?? '';
        return head.length > 0 && !(head in base);
    });
    return unmatched.length === 0 ? {} : { _meta: { unmatchedFields: unmatched, availableFields: Object.keys(base) } };
}

/**
 * MCP 2026-07-28 (server/tools, Output Schema): "Servers MUST provide
 * structured results that conform to [the output] schema". The read tools can
 * project their result (`verbosity: 'summary'` collapses to scalars, `fields`
 * keeps a dot-path subset), so their advertised schema describes the *full*
 * shape with every property optional at every level — `additionalProperties:
 * false` stays, `required` is removed recursively — and declares the
 * summary-only scalars. A validating host then accepts the full result, the
 * summary and any projection alike.
 */
function projectableOutputSchema(schema: Readonly<Record<string, unknown>>, summaryProperties: Readonly<Record<string, unknown>>, description: string): Record<string, unknown> {
    const strip = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(strip);
        if (node === null || typeof node !== 'object') return node;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            // The schema keyword is an array; a *property* named "required" is an object.
            if (k === 'required' && Array.isArray(v)) continue;
            out[k] = strip(v);
        }
        return out;
    };
    const stripped = strip(schema) as Record<string, unknown>;
    return {
        ...stripped,
        description,
        properties: { ...(stripped['properties'] as Record<string, unknown>), ...summaryProperties },
    };
}

const PROJECTION_NOTE =
    " Every property is optional because the result can be projected: verbosity:'summary' returns only the scalar summary fields, fields:[...] keeps a dot-path subset. Defaults return the full shape.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SAMPLE_ZIP_PLACEHOLDER = '<zip-base64>';

const TOOLS: readonly ToolDefinition[] = [
    {
        name: INSPECT_ZIP_NAME,
        title: 'Inspect archive (facts, determinism verdict, CI checks)',
        kind: 'inspect',
        description:
            "Read-only archive report in ONE call: size, entry / file / directory counts, Zip64, comment, compressed vs uncompressed totals, per-method counts, encrypted / symlink / data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date range, a `determinism` verdict (epoch timestamps + canonical order + UTF-8 flags ⇒ reproducible; `canonicalLayout` = no data descriptors) and every engine diagnostic (prepended SFX data, name mismatches, …). Opens EAGERLY by default: every entry's real extent is checked up front — overlapping entries, entries reaching into the central directory or past EOF, and Zip64 spoofing — and refused with their ZIP_* code rather than summarised (a method / CRC / size divergence between central and local headers is caught by verify_zip and on read, not here). `check:[…]` / `assert:{…}` turn it into a CI gate → `checks[]` + `checksPassed`. Token-frugal: verbosity:'summary', fields:[…]. Input: zipBase64 or zipPath (sandbox).",
        inputSchema: INSPECT_ZIP_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(INSPECT_ZIP_OUTPUT_SCHEMA, INSPECT_ZIP_SUMMARY_PROPERTIES, `Structured archive report (the zipnative inspect --json shape).${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'CI gate: reproducible, no encryption, safe names', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, check: ['deterministic', 'no-encryption', 'safe-names'] } },
            { title: 'Token-frugal verdict', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, verbosity: 'summary', fields: ['entryCount', 'deterministic'] } },
        ],
        handler: inspectZip,
    },
    {
        name: LIST_ZIP_ENTRIES_NAME,
        title: 'List entries (paged inventory)',
        kind: 'list',
        description:
            "Read-only central-directory inventory without decompressing anything: every entry (duplicates included) in directory order as a full row — name + encoding, sizes, ratio, CRC-32, method, timestamp, decoded flags, Unix mode, symlink, Zip64, data descriptor, host system, offsets, named extra fields, the sanitized path an extraction would use (null = unsafe name), comment. `filter` selects by exact names / prefix / globs; `offset` + `limit` page (default 200, max 2000, `hasMore`). Prefer inspect_zip for a one-shot summary and read_zip_entry / extract_zip for content. Token-frugal: verbosity:'summary' → names only; fields:[…].",
        inputSchema: LIST_ZIP_ENTRIES_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(LIST_ZIP_ENTRIES_OUTPUT_SCHEMA, LIST_ZIP_ENTRIES_SUMMARY_PROPERTIES, `Paged entry listing.${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'First page of a manifest', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, limit: 50 } },
            { title: 'Only JSON files under src/', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, filter: { prefix: 'src/', glob: ['**/*.json'] }, fields: ['entries.name', 'entries.uncompressedSize', 'hasMore'] } },
        ],
        handler: listZipEntries,
    },
    {
        name: READ_ZIP_ENTRY_NAME,
        title: 'Read one entry (random access)',
        kind: 'read-entry',
        description:
            "Read ONE entry without extracting the archive, by `name` (exact; the last duplicate wins) or `index` (central-directory position — disambiguates duplicates). mode 'data' (default): decompressed content as base64 or UTF-8 `text` (encoding:'utf8'; ENTRY_NOT_UTF8 otherwise), CRC-verified; a `range` {offset,length} reads a byte window through the chunked stream (bounded memory, no CRC). mode 'raw': the compressed payload verbatim (feed it to inflate_raw). mode 'verify': CRC / size / local-header agreement only. Inline cap 16 MiB per entry (ENTRY_TOO_LARGE → use a range or extract_zip file mode). Encrypted entries → ZIP_UNSUPPORTED_ENCRYPTION (no decryption in this engine).",
        inputSchema: READ_ZIP_ENTRY_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(READ_ZIP_ENTRY_OUTPUT_SCHEMA, READ_ZIP_ENTRY_SUMMARY_PROPERTIES, `One entry's content or verification.${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'Read a manifest as text', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, name: 'META-INF/MANIFEST.MF', encoding: 'utf8' } },
            { title: 'Peek at the first 4 KiB of a large log', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, name: 'logs/app.log', encoding: 'utf8', range: { offset: 0, length: 4096 } } },
        ],
        handler: readZipEntry,
    },
    {
        name: VERIFY_ZIP_NAME,
        title: 'Verify archive integrity (one call, never throws for archive problems)',
        kind: 'verify',
        description:
            "Deep verification in one call — zipnative's verifyZip report verbatim: eager structural validation, then every entry's CRC-32 / size / local-header agreement. `ok` is true when the structure is valid AND every verifiable entry passed. This tool NEVER fails for a problem with the archive: a structural refusal lands in `error` {code: ZIP_*, message}; an unverifiable entry is `skipped` ('encrypted' | 'stream-only-codec') and does not fail the archive, while an entry whose method has no codec here (anything but 0 store / 8 deflate) is reported FAILED, not skipped — the engine's verdict verbatim. Only caller mistakes (bad limits, bad input) are isError. `entries:'failed'` keeps the rows you act on; `verbosity:'summary'` keeps the verdict + counts. Verify before you trust: run it on any archive from an untrusted source before extract_zip.",
        inputSchema: VERIFY_ZIP_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(VERIFY_ZIP_OUTPUT_SCHEMA, VERIFY_ZIP_SUMMARY_PROPERTIES, `Deep verification report.${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'Is this archive intact?', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, verbosity: 'summary' } },
            { title: 'Which entries failed?', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, entries: 'failed' } },
        ],
        handler: verifyZipTool,
    },
    {
        name: EXTRACT_ZIP_NAME,
        title: 'Extract (secure by default)',
        kind: 'extract',
        description:
            "Extract with every engine guard ON unless you name the relaxation: zip-slip / absolute / drive / UNC / NUL / ADS / Windows-device names → ZIP_PATH_TRAVERSAL (rejectTraversal:false SKIPS them, listed in `skipped`; an unsafe path is never emitted); symlinks → ZIP_SYMLINK_REJECTED (rejectSymlinks:false extracts the target text as data, never a link); duplicate sanitized paths → ZIP_EXTRACT_DUPLICATE_PATH (onDuplicate 'first' | 'last'); declared sizes / ratios beyond `limits` → ZIP_LIMIT_EXCEEDED; overlapping entries and central/local divergence are always refused. `filter` keeps a subset. outputMode 'base64' (default) returns files inline (≤ 16 MiB each, ≤ 32 MiB total; includeData:false = dry run of the plan); 'file' streams into a relative `outputDir` inside ZIPNATIVE_MCP_OUTPUT_DIR (never overwrites) and returns resource links. Directories are implied by paths (emptyDirectories:true creates the explicit ones). The dry run opens eagerly: an overlapping, offset-into-CD or Zip64-spoofed archive is refused before any plan is returned. Prefer read_zip_entry for a single file.",
        inputSchema: EXTRACT_ZIP_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(EXTRACT_ZIP_OUTPUT_SCHEMA, EXTRACT_ZIP_SUMMARY_PROPERTIES, `Extraction result (inline files, a dry-run plan, or written files).${PROJECTION_NOTE}`),
        annotations: WRITES,
        examples: [
            { title: 'Dry run: what would be extracted?', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, includeData: false } },
            { title: 'Extract into the sandbox', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, outputMode: 'file', outputDir: 'unpacked/report' } },
        ],
        handler: extractZipTool,
    },
    {
        name: SCAN_ZIP_FORWARD_NAME,
        title: 'Scan forward (truncated / unseekable streams — NOT authoritative)',
        kind: 'scan',
        description:
            "Walk LOCAL headers in stream order with bounded memory (zipnative's central-directory-less reader). The only tool that works on a truncated archive or a stream cut mid-way (it cannot skip an SFX prefix: the stream must start at a local header) — and the only one whose result is NOT authoritative: forward iteration trusts local headers ALONE, so a hostile archive can present different content here than inspect_zip / list_zip_entries report (the upload-scanner differential). Prefer those tools whenever the whole archive is available; use this one for forensics (`tolerateTruncation:true` returns the partial inventory + `error`). data 'none' skips payloads, 'verify' decompresses to check CRCs, 'include' returns them (inline caps). `stoppedAt` tells you whether a central directory was reached. Names are NOT sanitized — `sanitizedPath` shows what the extraction gate would use.",
        inputSchema: SCAN_ZIP_FORWARD_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(SCAN_ZIP_FORWARD_OUTPUT_SCHEMA, SCAN_ZIP_FORWARD_SUMMARY_PROPERTIES, `Forward-scan inventory (local headers only).${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'Inventory of a truncated download', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, tolerateTruncation: true, verbosity: 'summary' } },
            { title: 'Verify payloads of a streamed archive', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, data: 'verify' } },
        ],
        handler: scanZipForward,
    },
    {
        name: SANITIZE_ENTRY_PATHS_NAME,
        title: 'Sanitize entry paths (the traversal gate)',
        kind: 'sanitize',
        description:
            "Apply zipnative's single traversal gate `sanitizeEntryPath()` to a list of names: the safe '/'-separated relative form each maps to (join it under your extraction root — never the raw name), or null with the rule that fired (empty, NUL byte, absolute, drive letter, UNC, '..' traversal, NTFS alternate data stream ':', Windows reserved device name CON/NUL/COM1…). Use it when you extract with another tool or plan an external filesystem sink. No archive needed.",
        inputSchema: SANITIZE_ENTRY_PATHS_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(SANITIZE_ENTRY_PATHS_OUTPUT_SCHEMA, SANITIZE_ENTRY_PATHS_SUMMARY_PROPERTIES, `Sanitized paths and rejections.${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'Which of these names are hostile?', input: { names: ['docs/readme.md', '../../etc/passwd', 'C:\\Windows\\win.ini', 'aux.txt', 'a/./b//c.txt'] } },
        ],
        handler: sanitizeEntryPaths,
    },
    {
        name: CREATE_ZIP_NAME,
        title: 'Create archive (reproducible; deterministic:true for cross-runtime identical bytes)',
        kind: 'archive-output',
        description:
            "Write a ZIP from inline entries (`dataBase64` | `text` | `sourcePath` in the sandbox, or `directory:true`). Reproducible by default: canonical order (raw UTF-8 name bytes), DOS-epoch timestamps, UTF-8 names, constant attributes — `defaultDate:'now'` or per-entry `date` opts out (ZIP_TIMESTAMP_NOT_PINNED diagnostic). `compression` {method store|deflate, level 0–9, deterministic:true = pinned pure-TS encoder ⇒ identical bytes on every runtime} at archive or entry level; `order:'insertion'` for EPUB / JAR (mimetype first, stored); `comment`, per-entry comment / unixMode / externalAttributes / raw extraFields. `stream:true` on a sourcePath feeds the file through addStream (data-descriptor layout, bounded memory). `parallel` compresses with the worker pool — byte-identical output. Zip64 is emitted exactly when a field overflows. Output base64 (≤ 50 MiB) or a sandbox file (streamed, never overwritten); `summary.deterministic` is true ONLY with compression.deterministic:true (cross-runtime identity); a default call is reproducible on the same runtime (`deflateTier` 'node-zlib') and reports false; `sha256` (includeSha256, base64 and file modes) is the proof. Every archive it writes is ISO/IEC 21320-1 conformant (CI-validated).",
        inputSchema: CREATE_ZIP_INPUT_SCHEMA,
        outputSchema: CREATE_ZIP_OUTPUT_SCHEMA,
        annotations: WRITES,
        examples: [
            { title: 'Two text files, reproducible', input: { entries: [{ name: 'README.md', text: '# Hello\n' }, { name: 'src/index.js', text: 'export {};\n' }], compression: { deterministic: true }, includeSha256: true } },
            { title: 'EPUB-style layout (mimetype first, stored)', input: { entries: [{ name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } }, { name: 'META-INF/container.xml', text: '<container/>' }], order: 'insertion' } },
        ],
        handler: createZipTool,
    },
    {
        name: MODIFY_ZIP_NAME,
        title: 'Modify archive (incremental, no recompression)',
        kind: 'archive-output',
        description:
            "Edit an existing archive without recompressing anything: operations add / replace / remove / rename / setComment applied in order. mode 'append' (default) = save(): the original bytes stay verbatim and edits are appended — fast and byte-preserving, BUT removed or replaced payloads REMAIN in the file (data remanence: recoverable by anyone; a ZIP_DEAD_BYTES_RATIO diagnostic fires past 50 % dead bytes, and 7-Zip is known to read the stale payload). mode 'compact' = saveCompact(): canonical rewrite, still no recompression, removed data truly gone, SFX prefix dropped. No edits and an unchanged comment return the same bytes (`summary.noOp`). Archives with duplicate entry names are refused — prefer create_zip for a full rebuild or when the source has duplicate names. Output base64 or a sandbox file.",
        inputSchema: MODIFY_ZIP_INPUT_SCHEMA,
        outputSchema: MODIFY_ZIP_OUTPUT_SCHEMA,
        annotations: WRITES,
        examples: [
            { title: 'Replace one file, keep everything else byte-identical', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, operations: [{ op: 'replace', name: 'config.json', text: '{"debug":false}' }] } },
            { title: 'Remove a secret for real (compact)', input: { zipBase64: SAMPLE_ZIP_PLACEHOLDER, operations: [{ op: 'remove', name: '.env' }], mode: 'compact' } },
        ],
        handler: modifyZipTool,
    },
    {
        name: COMPUTE_CRC32_NAME,
        title: 'Compute CRC-32',
        kind: 'crc32',
        description:
            "The ZIP checksum (IEEE 802.3 CRC-32, the engine's slice-by-8 implementation) of inline bytes / text or a sandbox file (streamed in 1 MiB chunks). `seed` continues a running CRC across consecutive chunks; `expect` compares against a known value (`matches`). Use it to cross-check an entry's crc32 from list_zip_entries against a file on disk.",
        inputSchema: COMPUTE_CRC32_INPUT_SCHEMA,
        outputSchema: COMPUTE_CRC32_OUTPUT_SCHEMA,
        annotations: READ_ONLY,
        examples: [
            { title: 'CRC-32 of a string', input: { text: 'hello world', expect: '0d4a1185' } },
        ],
        handler: computeCrc32,
    },
    {
        name: INFLATE_RAW_NAME,
        title: 'Inflate raw DEFLATE (bounded)',
        kind: 'inflate',
        description:
            "Decompress a raw DEFLATE (RFC 1951) stream — e.g. the payload from read_zip_entry mode:'raw' — with a MANDATORY `maxOutput` bound through zipnative's resumable inflater (constant memory, exact `bytesConsumed`, trailing bytes reported as `leftover`; ZIP_INFLATE_OUTPUT_OVERFLOW past the bound). method 'store' is a bounded pass-through; a numeric method id selects a registered codec (none beyond 0 / 8 in this server → ZIP_UNSUPPORTED_METHOD). Output base64 (≤ 50 MiB) or a sandbox file. Use it only for a raw payload or a bare deflate stream; to read an entry's content prefer read_zip_entry mode:'data'.",
        inputSchema: INFLATE_RAW_INPUT_SCHEMA,
        outputSchema: INFLATE_RAW_OUTPUT_SCHEMA,
        annotations: WRITES,
        examples: [
            { title: 'Inflate a small raw-deflate stream', input: { dataBase64: 'y0jNyckHAA==', maxOutput: 1024 } },
        ],
        handler: inflateRaw,
    },
    {
        name: DESCRIBE_ENGINE_NAME,
        title: 'Describe engine & server capabilities',
        kind: 'engine',
        description:
            "Offline preflight (no archive needed): server / engine / tool-API versions, the deflate tier in use and the pinned deterministic tier, runtime codecs (node:zlib, CompressionStream, DecompressionStream) and worker threads, the codec registry, the engine's default `limits`, the operator ceilings (ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES, ZIPNATIVE_MCP_MAX_ENTRIES, ZIPNATIVE_MCP_WORKERS), every server cap, whether the sandbox and the cache are enabled, the 39 frozen ZIP_* error codes and 11 diagnostic codes, and the engine exports this server deliberately does not expose (with why). `network` is always 'none'. Call it first in a session, or whenever a cap / ceiling refusal needs interpreting.",
        inputSchema: DESCRIBE_ENGINE_INPUT_SCHEMA,
        outputSchema: projectableOutputSchema(DESCRIBE_ENGINE_OUTPUT_SCHEMA, {}, `Capability manifest.${PROJECTION_NOTE}`),
        annotations: READ_ONLY,
        examples: [
            { title: 'Which limits apply here?', input: { fields: ['defaultLimits', 'ceilings', 'sandbox'] } },
        ],
        handler: describeEngine,
    },
    {
        name: DRAFT_GOVERNANCE_ISSUE_NAME,
        title: 'Draft a governance-compliant GitHub issue (HITL)',
        kind: 'governance',
        description:
            "Produce a LOCAL GitHub issue draft + compliance report for zipnative / zipnative-mcp and NEVER submit it — the agent drafts, a human reviews and files it under their own identity (Human-In-The-Loop contract, .github/AGENT_RULES.md). No GitHub write path and no network path exist in this server. The draft is checked against the zero-dependency + reproduction policy; a violation (new runtime dependency, missing reproduction, duplicateSearchPerformed:false) throws GOVERNANCE_VIOLATION. targetRepo 'zipnative' for engine behaviour (parsing, writing, limits, codecs), 'zipnative-mcp' for wrapper behaviour (schemas, sandbox, transport). Returns markdown inline (outputMode:'file' also writes a .md inside the sandbox). Use it only after reproducing a defect — for questions read describe_engine / AGENTS.md instead. Present the draft AND the report to the user, then STOP.",
        inputSchema: DRAFT_GOVERNANCE_ISSUE_INPUT_SCHEMA,
        outputSchema: DRAFT_GOVERNANCE_ISSUE_OUTPUT_SCHEMA,
        // Not readOnlyHint: outputMode='file' writes a .md into the sandbox. The default inline mode is side-effect-free.
        annotations: WRITES,
        examples: [
            { title: 'Draft an engine bug report (never submitted)', input: { title: 'iterateZipEntries mis-detects the descriptor of a stored entry', summary: 'A stored entry followed by a signed data descriptor is reported as truncated by the forward reader.', issueType: 'bug', targetRepo: 'zipnative', reproduction: { command: "scan_zip_forward on an archive written with compression.method:'store' and stream:true", result: 'ZIP_STREAM_TRUNCATED' }, expectedBehavior: 'The entry is read and its CRC verified.', affectedPackages: ['zipnative', 'zipnative-mcp'], duplicateSearchPerformed: true } },
        ],
        handler: draftGovernanceIssue,
    },
];

const TOOL_INDEX: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.name, t]));
__setToolCount(TOOLS.length);

const SERVER_INSTRUCTIONS = `zipnative-mcp: 13 tools over the zipnative v${ZIPNATIVE_VERSION} ZIP engine (zero dependencies, pure TypeScript). Tool API ${TOOL_API_VERSION}. MCP 2026-07-28 (stateless) with automatic fallback to the 2025-era handshake. Every tool has typed input/output schemas and executable _meta.examples; read-only tools never modify input; archive-producing tools are byte-reproducible on one runtime by default (compression.deterministic:true for cross-runtime identity) and every option is opt-in.

DECISION TREE:
  • What is in this archive? → inspect_zip (facts + determinism verdict + diagnostics; check:[…] for CI) then list_zip_entries (paged rows, filter by prefix/glob)
  • Is it intact / safe to trust? → verify_zip (never throws for archive problems: ok / error{code} / skipped) → inspect_zip check:['safe-names','no-encryption','no-symlinks'] → extract_zip includeData:false (dry run)
  • Read one file without extracting → read_zip_entry (name or index; encoding:'utf8' for text; range for a window; mode:'raw' for the compressed bytes; mode:'verify' for a single-entry check)
  • Get files out → extract_zip (guards ON by default; outputMode:'file' + outputDir for the sandbox; filter for a subset)
  • Build an archive → create_zip (reproducible by default; compression.deterministic:true for cross-runtime identical bytes; order:'insertion' for EPUB/JAR; parallel for many large entries)
  • Change an existing archive → modify_zip (add/replace/remove/rename/setComment; mode:'compact' to truly delete — 'append' keeps old bytes)
  • Truncated download, cut or unseekable stream, forensics → scan_zip_forward (local headers only — NOT authoritative; tolerateTruncation:true; the stream must start at a local header)
  • Self-extractor / prepended prefix → inspect_zip (reports prependedData; the engine shifts offsets) — scan_zip_forward refuses it (ZIP_SIGNATURE_MISMATCH); modify_zip mode:'compact' drops the prefix
  • Planning your own extraction sink → sanitize_entry_paths
  • Checksum / raw deflate payload → compute_crc32 / inflate_raw (mandatory maxOutput)
  • What can this server do here? → describe_engine (limits, ceilings, caps, sandbox, deflate tier, error codes)
  • Propose an upstream change → draft_governance_issue (local draft, never submitted)

SECURITY POSTURE:
  • Secure by default: zip-slip / absolute / drive / UNC / NUL / ADS / device names, symlinks, duplicate paths, declared-size and ratio bombs, overlapping entries and central/local divergence are refused with a frozen ZIP_* code and the remedy in the message. Relaxations are explicit, named inputs (rejectTraversal, rejectSymlinks, onDuplicate, limits) — never silent defaults.
  • No network, ever: no telemetry, no GitHub, no URL from any argument. The only filesystem boundary is ZIPNATIVE_MCP_OUTPUT_DIR (zipPath / sourcePath reads, outputMode:'file' / outputDir writes; never overwrites).
  • No encryption in this engine: encrypted entries are detected (isEncrypted, ZIP_UNSUPPORTED_ENCRYPTION), never decrypted. verify_zip skips them; extract_zip refuses them.

COMMON PITFALLS:
  • Pass exactly one of zipBase64 / zipPath; zipBase64 is the raw archive as base64 exactly once (no data: URI, not base64 twice). Inline results are capped (16 MiB per entry, 32 MiB per extraction, 50 MiB per archive) — switch to file mode for more.
  • verify_zip returns ok:false in structuredContent (not isError) for a broken archive; branch on ok and error.code.
  • modify_zip mode:'append' does NOT erase removed/replaced content (data remanence); use mode:'compact' for deletion. Rename never overwrites — remove the target first.
  • create_zip is reproducible only while dates stay pinned (omit defaultDate, or pass a fixed ISO instant); compression.deterministic:true pins the pure-TS encoder for identical bytes across runtimes (slower). summary.deterministic and sha256 tell you what you got.
  • scan_zip_forward trusts local headers alone — a hostile archive can lie to it; a data-descriptor (streamed) entry costs a full decompress even when skipped.
  • Entry names are '/'-separated and case-sensitive; read_zip_entry by name returns the LAST duplicate — use index from list_zip_entries to pick another.
  • limits.* raise engine bounds for trusted input only and can never exceed the operator ceilings (LIMIT_CEILING_EXCEEDED names the environment variable).
  • verbosity:'summary' keeps the scalar verdict; fields:[…] projects dot-paths — unmatched paths are reported in _meta.unmatchedFields.

TOKEN-FRUGAL READS & RESOURCES: read tools accept verbosity:'summary' and fields:[…]. Produced archives arrive as an embedded resource block (not duplicated in structuredContent); in file mode the result carries a resource_link and the file is listed under resources/list as zipnative://output/<path>. Prompts: secure_extraction, reproducible_archive, incremental_update, forensic_scan, verify_before_trust, governance_contract, draft_issue_workflow. Docs: docs/AI_GUIDE.md, docs/guides/*.md.`;

function buildDraftGovernanceIssueResult(output: DraftGovernanceIssueResult, toolName: string): CallToolResult {
    const where = output.outputMode === 'file' ? ` and written to ${output.filePath}` : '';
    return {
        content: [
            {
                type: 'text',
                text:
                    `${toolName}: DRAFT ONLY — not submitted${where}. ` +
                    `${output.compliance.humanGate} Present the draft and compliance report below to the user; ` +
                    `they must review and submit it themselves under their own GitHub identity.`,
            },
            { type: 'text', text: output.draftMarkdown },
        ],
        structuredContent: {
            title: output.title,
            issueType: output.issueType,
            targetRepo: output.targetRepo,
            outputMode: output.outputMode,
            ...(output.filePath !== undefined ? { filePath: output.filePath } : {}),
            sizeBytes: output.sizeBytes,
            draftMarkdown: output.draftMarkdown,
            warnings: output.warnings,
            compliance: output.compliance,
        },
    };
}

function projected(text: string, full: Record<string, unknown>, summary: Record<string, unknown>, input: unknown): CallToolResult {
    return {
        content: [{ type: 'text', text }],
        structuredContent: projectStructured(full, summary, input),
        ...projectionMeta(full, summary, input),
    };
}

function buildArchiveResult(output: OutputResult & { summary?: Readonly<Record<string, unknown>>; diagnostics?: unknown; diagnosticCounts?: unknown; diagnosticsTruncated?: unknown }, toolName: string): CallToolResult {
    const mimeType = output.mimeType ?? 'application/zip';
    const structured = {
        mode: output.mode,
        sizeBytes: output.sizeBytes,
        ...(output.filePath !== undefined ? { filePath: output.filePath } : {}),
        ...(output.summary !== undefined ? { summary: output.summary } : {}),
        diagnostics: output.diagnostics ?? [],
        ...(output.diagnosticCounts !== undefined ? { diagnosticCounts: output.diagnosticCounts } : {}),
        ...(output.diagnosticsTruncated !== undefined ? { diagnosticsTruncated: output.diagnosticsTruncated } : {}),
    };
    if (output.mode === 'file') {
        const link = output.filePath !== undefined ? resourceLinkForPath(output.filePath) : null;
        return {
            content: [
                { type: 'text', text: `${toolName}: wrote ${output.sizeBytes} bytes to ${output.filePath}` },
                ...(link !== null ? [{ type: 'resource_link' as const, ...link }] : []),
            ],
            structuredContent: structured,
        };
    }
    return {
        content: [
            { type: 'text', text: `${toolName}: produced ${output.sizeBytes} bytes (base64 delivered as the embedded resource below).` },
            {
                type: 'resource',
                resource: {
                    uri: `data:${mimeType};base64,${/* v8 ignore next */ output.base64 ?? ''}`,
                    mimeType,
                    blob: /* v8 ignore next */ output.base64 ?? '',
                },
            },
        ],
        structuredContent: structured,
    };
}

function buildExtractResult(output: ExtractZipResult, toolName: string, input: unknown): CallToolResult {
    const full = output as unknown as Record<string, unknown>;
    const summary = extractSummary(output);
    const text = output.mode === 'file'
        ? `${toolName}: wrote ${output.fileCount} file(s), ${output.totalBytes} bytes, under ${output.outputDir}${output.skipped.length > 0 ? ` (${output.skipped.length} unsafe name(s) skipped)` : ''}.`
        : output.dryRun
            ? `${toolName}: dry run — ${output.fileCount} file(s), ${output.totalBytes} bytes would be extracted${output.skipped.length > 0 ? ` (${output.skipped.length} unsafe name(s) skipped)` : ''}.`
            : `${toolName}: extracted ${output.fileCount} file(s), ${output.totalBytes} bytes (inline)${output.skipped.length > 0 ? ` (${output.skipped.length} unsafe name(s) skipped)` : ''}.`;
    const base = projected(text, full, summary, input);
    if (output.mode !== 'file') return base;
    const links = output.entries
        .slice(0, 50)
        .map((e) => (e.filePath !== undefined ? resourceLinkForPath(e.filePath) : null))
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .map((l) => ({ type: 'resource_link' as const, ...l }));
    return { ...base, content: [...base.content, ...links] };
}

function dispatchOutput(output: ToolOutput, tool: ToolDefinition, input: unknown): CallToolResult {
    const name = tool.name;
    switch (tool.kind) {
        case 'archive-output':
        case 'inflate':
            return buildArchiveResult(output as CreateZipResult | ModifyZipResult | InflateRawResult, name);
        case 'extract':
            return buildExtractResult(output as ExtractZipResult, name, input);
        case 'inspect': {
            const r = output as InspectZipResult;
            return projected(
                `${name}: ${r.entryCount} entries (${r.fileCount} files, ${r.directoryCount} dirs), ${r.archiveBytes} bytes, zip64=${r.isZip64}, deterministic=${r.determinism.deterministic}, diagnostics=${r.diagnostics.length}${r.checksPassed !== undefined ? `, checksPassed=${r.checksPassed}` : ''}.`,
                r as unknown as Record<string, unknown>,
                inspectSummary(r),
                input,
            );
        }
        case 'list': {
            const r = output as ListZipEntriesResult;
            return projected(`${name}: ${r.returnedCount} of ${r.matchedCount} matching entries (${r.entryCount} total)${r.hasMore ? ', more available' : ''}.`, r as unknown as Record<string, unknown>, listSummary(r), input);
        }
        case 'read-entry': {
            const r = output as ReadZipEntryResult;
            return projected(`${name}: "${r.entry.name}" mode=${r.mode}, ${r.sizeBytes} bytes, crcVerified=${r.crcVerified}${r.verification !== undefined ? `, ok=${r.verification.ok}` : ''}.`, r as unknown as Record<string, unknown>, readEntrySummary(r), input);
        }
        case 'verify': {
            const r = output as VerifyZipResult;
            const text = r.error !== null
                ? `${name}: NOT OK — structural refusal [${r.error.code}]: ${r.error.message}`
                : `${name}: ${r.ok ? 'OK' : 'NOT OK'} — ${r.verifiedCount} verified, ${r.failedCount} failed, ${r.skippedCount} skipped of ${r.entryCount} entries; ${r.diagnostics.length} diagnostic(s).`;
            return projected(text, r as unknown as Record<string, unknown>, verifySummary(r), input);
        }
        case 'scan': {
            const r = output as ScanZipForwardResult;
            return projected(`${name}: ${r.entryCount} local header(s) (${r.keptCount} kept), stopped at ${r.stoppedAt}${r.truncated ? ' — TRUNCATED' : ''}; trust=${r.trust}.`, r as unknown as Record<string, unknown>, scanSummary(r), input);
        }
        case 'sanitize': {
            const r = output as SanitizeEntryPathsResult;
            return projected(`${name}: ${r.rejectedCount} of ${r.count} name(s) rejected.`, r as unknown as Record<string, unknown>, sanitizeSummary(r), input);
        }
        case 'crc32': {
            const r = output as ComputeCrc32Result;
            return { content: [{ type: 'text', text: `${name}: crc32=${r.hex} over ${r.byteLength} byte(s)${r.matches !== undefined ? `, matches=${r.matches}` : ''}.` }], structuredContent: { ...r } };
        }
        case 'engine': {
            const r = output as DescribeEngineResult;
            return projected(`${name}: ${r.server.name} ${r.server.version} on zipnative ${r.engine.version}, deflate tier ${r.engine.deflateTier.default}, sandbox=${r.sandbox.enabled}, network=none.`, r as unknown as Record<string, unknown>, describeSummary(r), input);
        }
        case 'governance':
            return buildDraftGovernanceIssueResult(output as DraftGovernanceIssueResult, name);
    }
}

function buildErrorResult(err: unknown, toolName: string): CallToolResult {
    if (err instanceof ToolError) {
        return {
            content: [{ type: 'text', text: `${toolName} failed [${err.code}]: ${err.message}` }],
            isError: true,
            _meta: { error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } },
        };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: 'text', text: `${toolName} failed: ${message}` }],
        isError: true,
    };
}

interface PromptDefinition {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly text: string;
}

const SECURE_EXTRACTION_RECIPE = `Untrusted-archive intake with zipnative-mcp (every guard stays ON):
1. verify_zip { zipBase64 | zipPath, verbosity:'summary' } → branch on ok and error.code (ZIP_ENTRY_OVERLAP, ZIP_CD_LFH_MISMATCH, ZIP_ZIP64_CONTRADICTION are active-attack shapes: stop here).
2. inspect_zip { check:['safe-names','no-encryption','no-symlinks','no-duplicates'], assert:{ maxUncompressedBytes: 268435456, maxRatio: 100 } } → checksPassed.
3. extract_zip { includeData:false } → the dry-run plan: paths (already sanitized), sizes; nothing decompressed.
4. extract_zip { outputMode:'file', outputDir:'intake/<id>' } (or inline with a filter). Keep rejectTraversal / rejectSymlinks / onDuplicate at their defaults; relax ONLY when you have read the entry list and accept the consequence — rejectTraversal:false skips unsafe names (never emits them), rejectSymlinks:false writes the link TARGET TEXT as a file.
5. limits.* widen the engine bounds for trusted input only (LIMIT_CEILING_EXCEEDED names the operator variable); the engine enforces declared sizes and ratios while inflating, not after.
Remember: ISO/IEC 21320-1 conformance is not safety — zip-slip, device names and duplicate paths are spec-valid archives; the guards exist on top of conformance.`;

const REPRODUCIBLE_ARCHIVE_RECIPE = `Byte-identical archives with create_zip:
• Defaults already give reproducibility on ONE runtime: canonical order (raw UTF-8 name bytes), DOS-epoch timestamps (1980-01-01), UTF-8 names with the EFS flag, constant version-made-by and attributes, Zip64 only when a field overflows.
• Cross-runtime identity (Node versions, Bun, browsers): compression:{ deterministic:true } pins the pure-TS deflate encoder (slower); summary.deflateTier reports 'pure-pinned'. Without it the bytes are stable per environment only (summary.deflateTier 'node-zlib').
• Keep dates pinned: omit defaultDate (epoch) or pass one fixed ISO instant; never 'now' (ZIP_TIMESTAMP_NOT_PINNED, summary.deterministic:false). Per-entry date overrides must be fixed too.
• order:'insertion' is still deterministic given the same call order (EPUB / JAR need mimetype first, stored).
• Extra fields you pass are embedded verbatim — their determinism is yours.
• parallel:{…} is byte-identical to the sequential writer (per tier); stream:true entries use the data-descriptor layout: reproducible, but inspect_zip reports canonicalLayout:false.
• Proof: includeSha256:true twice → equal summary.sha256; or inspect_zip check:['deterministic','canonical-layout'] on the result. modify_zip mode:'append' preserves the original bytes as a prefix; mode:'compact' re-canonicalises.`;

const INCREMENTAL_UPDATE_RECIPE = `Editing an archive with modify_zip (no recompression, ever):
• operations run in order: add (ZIP_ENTRY_EXISTS if present), replace (ZIP_ENTRY_NOT_FOUND otherwise), remove, rename (never overwrites — remove the target first), setComment.
• mode:'append' (default) = save(): original bytes verbatim + appended entries + new central directory. Fast, byte-preserving — and the superseded payloads REMAIN inside the file (data remanence). Anyone can carve them out, and 7-Zip is known to read the STALE payload of a replaced entry instead of the new one. ZIP_DEAD_BYTES_RATIO fires past 50 % dead bytes.
• mode:'compact' = saveCompact(): canonical rewrite (still no recompression), removed data truly gone, an SFX prefix is dropped. Use it to delete secrets, to interoperate with 7-Zip, or when dead bytes pile up.
• No edits + unchanged comment ⇒ the same bytes back (summary.noOp:true). Archives with duplicate names are refused (ZIP_DUPLICATE_ENTRY_NAME): rebuild with create_zip.
• Chain without re-sending bytes: create_zip outputMode:'file' → modify_zip { zipPath } outputMode:'file' → verify_zip { zipPath } (all inside ZIPNATIVE_MCP_OUTPUT_DIR; a path is never cached).`;

const FORENSIC_SCAN_RECIPE = `Forensics on a damaged or streamed archive with scan_zip_forward:
• It walks LOCAL headers in stream order and works when inspect_zip fails with ZIP_EOCD_NOT_FOUND / ZIP_RECORD_TRUNCATED (truncated download, cut stream, no central directory yet).
• It is NOT authoritative: local headers alone can lie (sizes, methods, names) — the upload-scanner differential. Compare with list_zip_entries whenever the whole archive is readable; treat disagreements as hostile.
• tolerateTruncation:true returns the partial inventory plus error{code} and stoppedAt:'error' instead of failing; stoppedAt:'eof' means the stream ended with no central directory; 'central-directory' is the normal end.
• data:'none' (default) skips payloads — a data-descriptor (bit 3) entry still costs a full decompress-and-discard, and store + bit 3, encrypted + bit 3 are refused (ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR). data:'verify' checks CRCs; data:'include' returns content (inline caps).
• Names are not sanitized here: use sanitizedPath (or sanitize_entry_paths) before touching a filesystem. maxEntries bounds the work on an unbounded stream.`;

const VERIFY_BEFORE_TRUST_RECIPE = `Verify before you trust — the minimal safe sequence for any archive from an untrusted source:
1. verify_zip { …, verbosity:'summary', fields:['ok','error','failedCount','skippedCount'] } — the smallest probe. ok:false with error:null means content mismatches (CRC / size); error:{code} means the structure itself was refused.
2. inspect_zip { …, check:['safe-names','no-encryption','no-symlinks','no-duplicates','no-zip64'] , verbosity:'summary', fields:['checksPassed','checks'] }.
3. list_zip_entries { …, verbosity:'summary' } to eyeball the names (a spec-valid archive can still carry '../' names — the extraction gate refuses them, but you want to know).
4. extract_zip { …, includeData:false } for the plan, then the real extraction with the defaults.
Every step is read-only until step 4; nothing leaves the process; every refusal carries a frozen ZIP_* code and the remedy in its message.`;

/**
 * MCP prompts: the AI-governance / Human-In-The-Loop contract plus five
 * ready-made recipes. Read-only text; no arguments, no side effects.
 */
const PROMPTS: readonly PromptDefinition[] = [
    {
        name: 'governance_contract',
        title: 'AI-governance & HITL contract',
        description: 'The non-negotiable AI-governance / Human-In-The-Loop contract for zipnative-mcp: the agent is a draftsman, the human is the only gate, zero runtime dependencies, no autonomous GitHub writes, no network.',
        text: GOVERNANCE_CONTRACT_SUMMARY,
    },
    {
        name: 'draft_issue_workflow',
        title: 'Human-in-the-loop issue workflow',
        description: 'Step-by-step workflow for drafting a GitHub issue with the draft_governance_issue tool and handing it to a human for review and submission.',
        text: DRAFT_ISSUE_WORKFLOW,
    },
    {
        name: 'secure_extraction',
        title: 'Untrusted-archive intake (secure extraction)',
        description: 'Recipe for taking in an archive from an untrusted source: verify, inspect with CI checks, dry-run the plan, extract with every guard on, and when (not) to relax a guard.',
        text: SECURE_EXTRACTION_RECIPE,
    },
    {
        name: 'reproducible_archive',
        title: 'Byte-identical, reproducible archives',
        description: 'How to obtain the same bytes from repeated create_zip calls and across runtimes: pinned dates, canonical order, the deterministic encoder pin, and how to prove it.',
        text: REPRODUCIBLE_ARCHIVE_RECIPE,
    },
    {
        name: 'incremental_update',
        title: 'Incremental modification and data remanence',
        description: 'How modify_zip edits without recompression, what append mode leaves behind (remanence, the 7-Zip stale-payload differential), and when to compact.',
        text: INCREMENTAL_UPDATE_RECIPE,
    },
    {
        name: 'forensic_scan',
        title: 'Forensics on truncated or streamed archives',
        description: 'When and how to use scan_zip_forward, what its local-headers-only result can and cannot tell you, and how to reconcile it with the authoritative readers.',
        text: FORENSIC_SCAN_RECIPE,
    },
    {
        name: 'verify_before_trust',
        title: 'Verify before you trust',
        description: 'The minimal read-only sequence (verify_zip → inspect_zip checks → list → dry run) to run on any archive before extracting it.',
        text: VERIFY_BEFORE_TRUST_RECIPE,
    },
];

const PROMPT_INDEX: ReadonlyMap<string, PromptDefinition> = new Map(PROMPTS.map((p) => [p.name, p]));

/** Wire-level `tools/list` payload (deterministic order = registration order, per MCP 2026-07-28 guidance). */
export function listToolsPayload(): ListToolsResult {
    return { tools: TOOLS.map(describeTool) };
}

function describeTool(t: ToolDefinition): Tool {
    return {
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema as Tool['inputSchema'],
        ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema as Tool['outputSchema'] } : {}),
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
        _meta: {
            apiVersion: TOOL_API_VERSION,
            ...(t.examples !== undefined ? { examples: t.examples } : {}),
        },
    };
}

/** Registered tool names, in registration order (docs-consistency canary). */
export function toolNames(): string[] {
    return TOOLS.map((t) => t.name);
}

/**
 * Execute one tool call exactly as the `tools/call` handler does (cache lookup,
 * handler, result shaping, error → `isError`). Transport-agnostic so tests and
 * the corpus tooling can exercise the contract without a connection.
 */
export async function callToolDirect(name: string, args: unknown): Promise<CallToolResult> {
    const tool = TOOL_INDEX.get(name);
    if (tool === undefined) {
        return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }
    try {
        const input = args ?? {};
        const cacheable = isCacheable(name, input);
        const cacheKey = cacheable ? { tool: name, apiVersion: CACHE_API_VERSION } : null;
        if (cacheKey !== null) {
            const hit = getCached<ToolOutput>(cacheKey.tool, cacheKey.apiVersion, input);
            if (hit !== null) {
                const result = dispatchOutput(hit, tool, input);
                return { ...result, _meta: { ...(result._meta ?? {}), cached: true } };
            }
        }
        const output = await tool.handler(input);
        if (cacheKey !== null) {
            setCached(cacheKey.tool, cacheKey.apiVersion, input, output);
        }
        return dispatchOutput(output, tool, input);
    } catch (err) {
        return buildErrorResult(err, name);
    }
}

/**
 * Build a fresh, connection-less `Server`. Cheap and side-effect free, so the
 * HTTP entry point can call it once per request (MCP 2026-07-28 is stateless)
 * while stdio pins a single instance per process. Handlers await
 * `ensureEngineReady()` themselves where the engine's Node codecs matter.
 */
export function createServer(): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE, description: SERVER_DESCRIPTION, websiteUrl: SERVER_WEBSITE_URL },
        {
            capabilities: { tools: {}, prompts: {}, resources: {} },
            instructions: SERVER_INSTRUCTIONS,
            cacheHints: SERVER_CACHE_HINTS,
        } satisfies ServerOptions,
    );

    // Native MCP resources: expose sandbox files as re-referenceable
    // zipnative://output/… URIs (empty when the sandbox is disabled).
    server.setRequestHandler('resources/list', async () => ({
        resources: (await listResources()).map((r) => ({
            uri: r.uri,
            name: r.name,
            title: r.title,
            description: r.description,
            mimeType: r.mimeType,
            size: r.size,
        })),
    }));

    server.setRequestHandler('resources/templates/list', async () => ({
        resourceTemplates: listResourceTemplates(),
    }));

    server.setRequestHandler('resources/read', async (request) => {
        const uri = request.params.uri;
        try {
            return { contents: [await readResource(uri)] };
        } catch (err) {
            // Spec 2026-07-28: resource-not-found is -32602 (Invalid params) on every revision.
            if (err instanceof ToolError) {
                if (err.code === 'UNKNOWN_RESOURCE') throw new ResourceNotFoundError(uri, err.message);
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `[${err.code}] ${err.message}`);
            }
            throw err;
        }
    });

    server.setRequestHandler('prompts/list', async () => ({
        prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description })),
    }));

    server.setRequestHandler('prompts/get', async (request): Promise<GetPromptResult> => {
        const prompt = PROMPT_INDEX.get(request.params.name);
        if (prompt === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `[UNKNOWN_PROMPT] Unknown prompt: ${request.params.name}`);
        }
        return {
            description: prompt.description,
            messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }],
        };
    });

    server.setRequestHandler('tools/list', async () => listToolsPayload());

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params;
        const tool = TOOL_INDEX.get(name);
        if (tool === undefined) {
            // MCP 2026-07-28 server/tools §Error Handling: "Unknown tool" is a protocol
            // error (-32602), not an `isError` execution result.
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `[UNKNOWN_TOOL] Unknown tool: ${name}`);
        }
        const result = await callToolDirect(name, args);
        // Identity for object-shaped structuredContent; keeps the wire projection the
        // SDK expects for the negotiated protocol revision.
        return server.projectCallToolResult(result, tool.outputSchema as Record<string, unknown> | undefined);
    });

    return server;
}

export { ensureEngineReady };

export const __serverMetadata = { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE, description: SERVER_DESCRIPTION, websiteUrl: SERVER_WEBSITE_URL, engineVersion: ZIPNATIVE_VERSION } as const;
export const __serverInstructions = SERVER_INSTRUCTIONS;
export const __prompts = PROMPTS;
