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
/** JSON-shaped input bounds. */
export const MAX_CREATE_ENTRIES = 10_000;
export const MAX_MODIFY_OPERATIONS = 1000;
export const MAX_SANITIZE_NAMES = 10_000;
export const MAX_FILTER_NAMES = 1000;
export const MAX_FILTER_GLOBS = 32;
export const MAX_EXTRA_FIELDS = 16;
export const MAX_FIELDS_PATHS = 16;
export const MAX_SCAN_ENTRIES_DEFAULT = 10_000;
/** Diagnostics kept per result after de-duplication by (code, entryName). */
export const MAX_DIAGNOSTICS = 200;
/** `extract_zip` file mode: resource links attached to the result (the rest stay in `files[]`). */
export const MAX_RESOURCE_LINKS = 50;
/** `read_zip_entry` range length bound. */
export const MAX_RANGE_LENGTH = MAX_ENTRY_INLINE_BYTES;

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

/** Throw `INPUT_TOO_LARGE` when `observed` exceeds `cap`. */
export function assertInputWithin(observed: number, cap: number, what: string): void {
    if (observed > cap) {
        throw new ToolError('INPUT_TOO_LARGE', `${what} is ${observed} bytes, above the ${cap}-byte cap.`, { what, observed, cap });
    }
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
} as const;
