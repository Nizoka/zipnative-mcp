/**
 * zipnative error → ToolError mapping — the ONLY place that reads `err.code`.
 *
 * Vendored from zipnative-cli `src/utils/ziperr.ts` (1.0.0) and reshaped for
 * MCP: the tool error code IS the engine's frozen `ZIP_*` code, verbatim
 * (39 codes), the message keeps the engine text (which names the remedy),
 * and `data` carries the machine-readable detail the engine attaches
 * (`limit` / `configured` / `observed`, `entryName`, `feature`,
 * `expectedCrc` / `actualCrc`) plus the error class name. Nothing here can
 * leak a secret: the engine holds none.
 *
 * The table is typed `satisfies Record<ZipErrorCode, …>`: a core minor bump
 * that adds a code fails `tsc` here instead of leaking as `ENGINE_ERROR`.
 */
import {
    ZipDataError,
    ZipError,
    ZipLimitError,
    ZipSecurityError,
    ZipUnsupportedError,
    type ZipDiagnosticCode,
    type ZipErrorCode,
} from 'zipnative';

import { redactAbsolutePaths, ToolError } from './errors.js';

/** Coarse class of each frozen code — surfaced as `data.errorClass` and in AGENTS.md §6. */
export const ZIP_ERROR_CLASS = {
    // ── base (7)
    ZIP_INVALID_OPTION: 'usage',
    ZIP_INPUT_TOO_LARGE: 'limit',
    ZIP_ENTRY_NOT_FOUND: 'not-found',
    ZIP_ENTRY_EXISTS: 'input',
    ZIP_API_MISUSE: 'internal',
    ZIP_STRICT_DIAGNOSTIC: 'check',
    ZIP_INTERNAL: 'internal',
    // ── format (13)
    ZIP_EOCD_NOT_FOUND: 'parse',
    ZIP_EOCD_INCONSISTENT: 'parse',
    ZIP_ZIP64_LOCATOR_MISSING: 'parse',
    ZIP_ZIP64_EOCD_MISPLACED: 'parse',
    ZIP_CD_INCONSISTENT: 'parse',
    ZIP_RECORD_TRUNCATED: 'parse',
    ZIP_SIGNATURE_MISMATCH: 'parse',
    ZIP_STREAM_TRUNCATED: 'parse',
    ZIP_VALUE_UNREPRESENTABLE: 'parse',
    ZIP_INVALID_ENTRY_NAME: 'input',
    ZIP_DUPLICATE_ENTRY_NAME: 'input',
    ZIP_DEFLATE_TRUNCATED: 'parse',
    ZIP_DEFLATE_CORRUPT: 'parse',
    // ── security (6)
    ZIP_ENTRY_OVERLAP: 'security',
    ZIP_CD_LFH_MISMATCH: 'security',
    ZIP_ZIP64_CONTRADICTION: 'security',
    ZIP_PATH_TRAVERSAL: 'security',
    ZIP_SYMLINK_REJECTED: 'security',
    ZIP_EXTRACT_DUPLICATE_PATH: 'security',
    // ── data (5)
    ZIP_CRC_MISMATCH: 'data',
    ZIP_SIZE_MISMATCH: 'data',
    ZIP_INFLATE_OUTPUT_OVERFLOW: 'data',
    ZIP_DESCRIPTOR_MISMATCH: 'data',
    ZIP_DECOMPRESSION_FAILED: 'data',
    // ── limits (2)
    ZIP_LIMIT_EXCEEDED: 'limit',
    ZIP_LIMIT_INVALID: 'usage',
    // ── unsupported (6)
    ZIP_UNSUPPORTED_ENCRYPTION: 'unsupported',
    ZIP_UNSUPPORTED_METHOD: 'unsupported',
    ZIP_UNSUPPORTED_MULTI_DISK: 'unsupported',
    ZIP_UNSUPPORTED_ZIP64_STREAMING: 'unsupported',
    ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR: 'unsupported',
    ZIP_UNSUPPORTED_CODEC_MODE: 'unsupported',
} as const satisfies Record<ZipErrorCode, string>;

/** Every frozen `ZIP_*` code (39), in table order. */
export const ZIP_ERROR_CODES: readonly ZipErrorCode[] = Object.keys(ZIP_ERROR_CLASS) as ZipErrorCode[];

/** Every core diagnostic code (12) — informational, never thrown unless `strict`. */
export const ZIP_DIAGNOSTIC_CODES = [
    'ZIP_PREPENDED_DATA',
    'ZIP_MULTIPLE_EOCD',
    'ZIP_NAME_MISMATCH',
    'ZIP_UNICODE_PATH_CONFLICT',
    'ZIP_INVALID_UTF8_NAME',
    'ZIP_DUPLICATE_NAME',
    'ZIP_EXTRA_FIELD_MALFORMED',
    'ZIP_ZIP64_EXTRA_IGNORED',
    'ZIP_TIMESTAMP_NOT_PINNED',
    'ZIP_NONDETERMINISTIC_CODEC',
    'ZIP_DEAD_BYTES_RATIO',
    // zipnative 1.1.0: a date outside the DOS range clamped to 1980-01-01 / 2107-12-31 23:59:58.
    'ZIP_TIMESTAMP_CLAMPED',
] as const satisfies readonly ZipDiagnosticCode[];

/** Compile-time exhaustiveness: a diagnostic a NEWER engine adds and this list lacks fails `tsc` here. */
type MissingDiagnostic = Exclude<ZipDiagnosticCode, (typeof ZIP_DIAGNOSTIC_CODES)[number]>;
const DIAGNOSTICS_EXHAUSTIVE: MissingDiagnostic extends never ? true : MissingDiagnostic = true;
void DIAGNOSTICS_EXHAUSTIVE;

const crcHex = (crc: number): string => (crc >>> 0).toString(16).padStart(8, '0');

function detailOf(err: ZipError): Record<string, unknown> {
    if (err instanceof ZipLimitError) {
        return {
            limit: String(err.limit),
            configured: Number.isFinite(err.configured) ? err.configured : String(err.configured),
            observed: Number.isFinite(err.observed) ? err.observed : String(err.observed),
        };
    }
    if (err instanceof ZipUnsupportedError) return { feature: err.feature };
    if (err instanceof ZipDataError && (err.expectedCrc !== undefined || err.actualCrc !== undefined)) {
        return {
            expectedCrc: err.expectedCrc === undefined ? null : crcHex(err.expectedCrc),
            actualCrc: err.actualCrc === undefined ? null : crcHex(err.actualCrc),
        };
    }
    return {};
}

function entryNameOf(err: ZipError): string | undefined {
    if (err instanceof ZipSecurityError || err instanceof ZipDataError) return err.entryName;
    return undefined;
}

/**
 * Convert any thrown value into a `ToolError`. `ToolError`s pass through.
 *
 * @param err        the caught value
 * @param context    short human prefix, e.g. `'Failed to open archive'`
 * @param entryName  the entry the operation was about (used when the engine
 *                   error carries none)
 * @param extra      additional `data` fields (e.g. `operationIndex`)
 */
export function mapZipError(err: unknown, context: string, entryName?: string, extra?: Readonly<Record<string, unknown>>): ToolError {
    if (err instanceof ToolError) return err;
    if (err instanceof ZipError) {
        // `satisfies Record<ZipErrorCode, …>` makes the fallback unreachable for a
        // 1.0.0 engine; it stays for a code a NEWER engine may add at runtime.
        const errorClass: string = ZIP_ERROR_CLASS[err.code] ?? 'internal';
        const name = entryNameOf(err) ?? entryName;
        return new ToolError(err.code, `${context}: ${err.message}`, {
            errorClass,
            engineError: err.name,
            ...(name !== undefined ? { entryName: name } : {}),
            ...detailOf(err),
            ...(extra ?? {}),
        });
    }
    // zipnative 1.1.0 normalises a corrupt deflate stream to ZIP_DEFLATE_CORRUPT / _TRUNCATED on every
    // inflate tier (node:zlib, DecompressionStream, pure TS): the zlib table 1.0.0 kept here is gone.
    const message = redactAbsolutePaths(err instanceof Error ? err.message : String(err));
    return new ToolError('ENGINE_ERROR', `${context}: ${message}`, { errorClass: 'internal', ...(extra ?? {}) });
}

/** Run `fn` and translate any failure through {@link mapZipError}. */
export function guard<T>(context: string, fn: () => T, entryName?: string, extra?: Readonly<Record<string, unknown>>): T {
    try {
        return fn();
    } catch (e) {
        throw mapZipError(e, context, entryName, extra);
    }
}

/** Async variant of {@link guard}. */
export async function guardAsync<T>(context: string, fn: () => Promise<T>, entryName?: string, extra?: Readonly<Record<string, unknown>>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        throw mapZipError(e, context, entryName, extra);
    }
}
