/**
 * Diagnostic collection. zipnative reports non-fatal conformance concerns
 * (prepended SFX data, duplicate names, CD/LFH name mismatch, unpinned
 * timestamps, dead bytes after an incremental save, …) through an
 * `onDiagnostic` callback; when no callback is installed it falls back to a
 * de-duplicated `console.warn`, which a stdio MCP server must never emit on
 * stdout. Every engine call therefore goes through a sink from this module,
 * and every tool result carries `diagnostics[]` — for ZIP they ARE the signal.
 *
 * The sink's `options` are also where the server pins the DOS wall-clock
 * (1.1.0): every engine call receives `dosTimeMode: 'utc'`, so an explicit
 * date is written as the same DOS fields on every host and a `lastModified`
 * is read back as the same instant — up to 1.0.0 the engine used the host's
 * time zone, so a pinned `create_zip` call produced different bytes in Paris
 * and on a UTC runner while the response cache treated them as one.
 */
import type { ZipCommonOptions, ZipDiagnostic } from 'zipnative';

import { NO_CONTEXT, type CallContext } from './call-context.js';
import { MAX_DIAGNOSTICS } from './caps.js';

/** Wire shape of one diagnostic (identical to the engine's, minus nothing). */
export interface DiagnosticRow {
    readonly code: string;
    readonly severity: 'warning' | 'info';
    readonly message: string;
    readonly entryName?: string;
}

export interface DiagnosticSink {
    /** Pass to the engine: `onDiagnostic`, `strict`, the pinned `dosTimeMode: 'utc'` and the call's `signal` / `onProgress`. */
    readonly options: Pick<ZipCommonOptions, 'onDiagnostic' | 'strict' | 'dosTimeMode' | 'signal' | 'onProgress'>;
    /** De-duplicated rows (by code + entryName), capped at {@link MAX_DIAGNOSTICS}. */
    readonly diagnostics: DiagnosticRow[];
    /** Count per code over EVERY diagnostic received (not capped). */
    readonly counts: Record<string, number>;
    /** True when rows were dropped by the cap. */
    readonly truncated: boolean;
    /** True when a diagnostic with `code` was received. */
    has(code: string): boolean;
    /** The serialisable summary attached to tool results. */
    report(): DiagnosticsReport;
}

export interface DiagnosticsReport {
    readonly diagnostics: readonly DiagnosticRow[];
    readonly diagnosticCounts: Readonly<Record<string, number>>;
    readonly diagnosticsTruncated?: true;
}

/**
 * Create a sink. `strict: true` asks the engine to escalate the first diagnostic (`ZIP_STRICT_DIAGNOSTIC`);
 * the call context's cancellation signal and progress sink ride along to every engine call (src/call-context.ts).
 */
export function createDiagnosticSink(strict = false, context: CallContext = NO_CONTEXT): DiagnosticSink {
    const diagnostics: DiagnosticRow[] = [];
    const counts: Record<string, number> = {};
    const seen = new Set<string>();
    let truncated = false;
    const onDiagnostic = (d: ZipDiagnostic): void => {
        counts[d.code] = (counts[d.code] ?? 0) + 1;
        const key = `${d.code}\0${d.entryName ?? ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (diagnostics.length >= MAX_DIAGNOSTICS) {
            truncated = true;
            return;
        }
        diagnostics.push({
            code: d.code,
            severity: d.severity,
            message: d.message,
            ...(d.entryName !== undefined ? { entryName: d.entryName } : {}),
        });
    };
    return {
        options: {
            onDiagnostic,
            dosTimeMode: 'utc',
            ...(strict ? { strict: true } : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
            ...(context.onProgress !== undefined ? { onProgress: context.onProgress } : {}),
        },
        diagnostics,
        counts,
        get truncated() {
            return truncated;
        },
        has: (code) => counts[code] !== undefined,
        report: () => ({
            diagnostics: [...diagnostics],
            diagnosticCounts: { ...counts },
            ...(truncated ? { diagnosticsTruncated: true as const } : {}),
        }),
    };
}

/** JSON Schema of the `diagnostics` output block shared by every tool. */
export const DIAGNOSTICS_OUTPUT_PROPERTIES = {
    diagnostics: {
        type: 'array',
        description:
            'Non-fatal conformance concerns the engine raised while parsing or writing (de-duplicated by code + entry, at most 200). Empty for a clean archive. Codes: ZIP_PREPENDED_DATA, ZIP_MULTIPLE_EOCD, ZIP_NAME_MISMATCH, ZIP_UNICODE_PATH_CONFLICT, ZIP_INVALID_UTF8_NAME, ZIP_DUPLICATE_NAME, ZIP_EXTRA_FIELD_MALFORMED, ZIP_ZIP64_EXTRA_IGNORED, ZIP_TIMESTAMP_NOT_PINNED, ZIP_NONDETERMINISTIC_CODEC, ZIP_DEAD_BYTES_RATIO, ZIP_TIMESTAMP_CLAMPED.',
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'severity', 'message'],
            properties: {
                code: { type: 'string' },
                severity: { type: 'string', enum: ['warning', 'info'] },
                message: { type: 'string' },
                entryName: { type: 'string' },
            },
        },
    },
    diagnosticCounts: {
        type: 'object',
        description: 'Number of diagnostics received per code (counts every occurrence, including de-duplicated ones).',
        additionalProperties: { type: 'integer', minimum: 0 },
    },
    diagnosticsTruncated: { type: 'boolean', description: 'Present (true) when more than 200 distinct diagnostics were dropped from `diagnostics`.' },
} as const;
