/**
 * Every byte / count bound the server enforces on top of the engine's own
 * `ZipLimits`, plus the operator ceilings read once at boot.
 *
 * The engine bounds *what an archive may declare* (CWE-400/409 guards); these
 * bounds keep one JSON-RPC exchange inside a predictable memory envelope and
 * stop an agent from asking for a payload no MCP host can carry. Everything
 * here is a constant so `describe_engine` can advertise it and the docs can
 * be checked against the code.
 */
import { ToolError } from './errors.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Largest single JSON-RPC frame accepted on stdio and the HTTP body cap (256 MiB). */
export const STDIO_MAX_FRAME_BYTES = 256 * MiB;
/** Decoded `zipBase64` and the sum of inline `dataBase64` / `text` payloads per call. */
export const MAX_BASE64_INPUT_BYTES = 128 * MiB;
/** A `zipPath` / `sourcePath` read fully into memory (buffered tools). */
export const MAX_PATH_INPUT_BYTES = 1 * GiB;
/** Largest base64 payload returned inline (archives, inflated data). */
export const MAX_BASE64_OUTPUT_BYTES = 50 * MiB;
/** Largest file written in `outputMode: 'file'` (enforced while streaming). */
export const MAX_FILE_OUTPUT_BYTES = 4 * GiB;
/** Largest single entry returned inline by `read_zip_entry` / `extract_zip`. */
export const MAX_ENTRY_INLINE_BYTES = 16 * MiB;
/** Largest total returned inline by `extract_zip` in base64 mode. */
export const MAX_EXTRACT_INLINE_TOTAL_BYTES = 32 * MiB;
/** `list_zip_entries` page bounds. */
export const MAX_LIST_LIMIT = 2000;
export const DEFAULT_LIST_LIMIT = 200;
/**
 * JSON-shaped input bounds. `MAX_CREATE_ENTRIES` is aligned with the engine's
 * default `maxEntries` (100 000) so Zip64 output (> 65 535 entries) stays
 * reachable through `create_zip`; the 256 MiB frame and the operator
 * ceiling `ZIPNATIVE_MCP_MAX_ENTRIES` remain the effective bounds.
 */
export const MAX_CREATE_ENTRIES = 100_000;
export const MAX_MODIFY_OPERATIONS = 1000;
export const MAX_SANITIZE_NAMES = 10_000;
export const MAX_FILTER_NAMES = 1000;
export const MAX_FILTER_GLOBS = 32;
/**
 * Longest glob pattern accepted. Matching is linear (src/filter.ts never builds a
 * backtracking RegExp), so the bound only keeps one pattern × one name inside a
 * predictable cost: a pattern longer than any legal name (`maxNameBytes`, 4 096)
 * cannot match anyway.
 */
export const MAX_GLOB_LENGTH = 1024;
export const MAX_EXTRA_FIELDS = 16;
/**
 * Longest free-text field of a `draft_governance_issue` call (summary,
 * reproduction, behaviours). The policy checks scan the assembled draft with
 * linear-time patterns; the bound keeps a draft a reviewable size.
 */
export const MAX_ISSUE_TEXT_CHARS = 16_384;
export const MAX_FIELDS_PATHS = 16;
export const MAX_SCAN_ENTRIES_DEFAULT = 10_000;
/** Diagnostics kept per result after de-duplication by (code, entryName). */
export const MAX_DIAGNOSTICS = 200;
/** `extract_zip` file mode: resource links attached to the result (the rest stay in `entries[]`). */
export const MAX_RESOURCE_LINKS = 50;
/** `read_zip_entry` range length bound. */
export const MAX_RANGE_LENGTH = MAX_ENTRY_INLINE_BYTES;
/** `resources/list`: maximum number of sandbox files returned, and the directory-walk depth. */
export const MAX_LISTED_RESOURCES = 1000;
export const MAX_RESOURCE_WALK_DEPTH = 8;
/** `resources/read`: largest payload returned (mirrors the inline output cap). */
export const MAX_RESOURCE_READ_BYTES = MAX_BASE64_OUTPUT_BYTES;
/** Opt-in response cache (`ZIPNATIVE_MCP_CACHE_DIR`): entry TTL and total size (LRU by mtime). */
export const CACHE_TTL_SECONDS = 3600;
export const CACHE_MAX_BYTES = 256 * MiB;

/** Operator ceilings — environment variable names. */
export const MAX_UNCOMPRESSED_ENV = 'ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES';
export const MAX_ENTRIES_ENV = 'ZIPNATIVE_MCP_MAX_ENTRIES';
export const WORKERS_ENV = 'ZIPNATIVE_MCP_WORKERS';

/** Defaults equal the engine defaults, so nothing changes unless the operator says so. */
export const DEFAULT_MAX_UNCOMPRESSED_CEILING = 8 * GiB;
export const DEFAULT_MAX_ENTRIES_CEILING = 100_000;
export const DEFAULT_WORKERS_CEILING = 8;

export interface Ceilings {
    /** Upper bound for `limits.maxEntryUncompressedSize` and `limits.maxTotalUncompressedSize`. */
    readonly maxUncompressedBytes: number;
    /** Upper bound for `limits.maxEntries`. */
    readonly maxEntries: number;
    /** Upper bound for `create_zip.parallel.workers` (0 disables worker threads). */
    readonly maxWorkers: number;
}

function parseCeiling(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)}).`);
    }
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum} (got ${JSON.stringify(raw)}).`);
    }
    return value;
}

/**
 * Read the operator ceilings. Called once at boot by the CLI (an invalid value
 * refuses to start — never a silent fallback) and lazily by the tools.
 */
export function readCeilings(env: NodeJS.ProcessEnv = process.env): Ceilings {
    return {
        maxUncompressedBytes: parseCeiling(env, MAX_UNCOMPRESSED_ENV, DEFAULT_MAX_UNCOMPRESSED_CEILING, 1024),
        maxEntries: parseCeiling(env, MAX_ENTRIES_ENV, DEFAULT_MAX_ENTRIES_CEILING, 1),
        maxWorkers: parseCeiling(env, WORKERS_ENV, DEFAULT_WORKERS_CEILING, 0),
    };
}

let _ceilings: Ceilings | null = null;

/** Ceilings for the current process (memoised; `__resetCeilingsForTests` clears). */
export function getCeilings(): Ceilings {
    if (_ceilings === null) _ceilings = readCeilings();
    return _ceilings;
}

/** Test-only hook: forget the memoised ceilings so a test can change the env. */
export function __resetCeilingsForTests(): void {
    _ceilings = null;
}

/**
 * Throw `INPUT_TOO_LARGE` when `observed` exceeds `cap`. An inline (base64)
 * input names the sandbox file route as its remedy (`data.remedy: 'zipPath'`);
 * a file input already over the path cap can only be split.
 */
export function assertInputWithin(observed: number, cap: number, what: string): void {
    if (observed <= cap) return;
    const viaFile = /path/i.test(what);
    const hint = viaFile
        ? 'split the input into smaller archives'
        : `pass the bytes through a sandbox file instead (zipPath / sourcePath under ZIPNATIVE_MCP_OUTPUT_DIR, up to ${MAX_PATH_INPUT_BYTES} bytes) or send a smaller payload`;
    throw new ToolError('INPUT_TOO_LARGE', `${what} is ${observed} bytes, above the ${cap}-byte cap — ${hint}.`, { what, observed, cap, ...(viaFile ? {} : { remedy: 'zipPath' }) });
}

/** Serialisable view of every cap, for `describe_engine`. */
export const CAPS = {
    stdioMaxFrameBytes: STDIO_MAX_FRAME_BYTES,
    maxBase64InputBytes: MAX_BASE64_INPUT_BYTES,
    maxPathInputBytes: MAX_PATH_INPUT_BYTES,
    maxBase64OutputBytes: MAX_BASE64_OUTPUT_BYTES,
    maxFileOutputBytes: MAX_FILE_OUTPUT_BYTES,
    maxEntryInlineBytes: MAX_ENTRY_INLINE_BYTES,
    maxExtractInlineTotalBytes: MAX_EXTRACT_INLINE_TOTAL_BYTES,
    maxListLimit: MAX_LIST_LIMIT,
    defaultListLimit: DEFAULT_LIST_LIMIT,
    maxCreateEntries: MAX_CREATE_ENTRIES,
    maxModifyOperations: MAX_MODIFY_OPERATIONS,
    maxSanitizeNames: MAX_SANITIZE_NAMES,
    maxDiagnostics: MAX_DIAGNOSTICS,
    maxFilterNames: MAX_FILTER_NAMES,
    maxFilterGlobs: MAX_FILTER_GLOBS,
    maxGlobLength: MAX_GLOB_LENGTH,
    maxExtraFields: MAX_EXTRA_FIELDS,
    maxIssueTextChars: MAX_ISSUE_TEXT_CHARS,
    maxFieldsPaths: MAX_FIELDS_PATHS,
    defaultScanMaxEntries: MAX_SCAN_ENTRIES_DEFAULT,
    maxResourceLinks: MAX_RESOURCE_LINKS,
    maxRangeLength: MAX_RANGE_LENGTH,
    maxListedResources: MAX_LISTED_RESOURCES,
    maxResourceWalkDepth: MAX_RESOURCE_WALK_DEPTH,
    maxResourceReadBytes: MAX_RESOURCE_READ_BYTES,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    cacheMaxBytes: CACHE_MAX_BYTES,
} as const;
