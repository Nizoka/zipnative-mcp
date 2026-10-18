/**
 * Tool: verify_zip — one-call deep verification, the engine's `verifyZip`
 * report verbatim: eager structural validation, per-entry CRC-32 / size /
 * local-header checks, every diagnostic collected. The contract that makes it
 * agent-grade: the tool NEVER fails for a problem with the archive — a
 * structural refusal lands in `error` (with the frozen ZIP_* code), an
 * unverifiable entry carries `skipped` with its reason (zipnative 1.1.0:
 * 'encrypted', 'stream-only-codec', 'unsupported-method'). Only caller
 * mistakes (bad limits, bad input) are `isError`.
 *
 * The counts follow the engine's archive rule: an entry passes when it is ok,
 * or when it is a design-time skip (encrypted, stream-only codec) whose local
 * header agrees with the central directory. `skippedCount` counts those;
 * every other entry that is not ok is FAILED — an unknown method (skipped:
 * 'unsupported-method', as in 1.0.0 failed) and, since 1.1.0, an encrypted
 * entry whose local header contradicts the central directory (1.0.0 trusted a
 * fabricated localHeaderMatch).
 */
import { z } from 'zod';
import { verifyZip, type VerifiedEntry } from 'zipnative';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticRow } from '../diagnostics.js';
import { LIMITS_INPUT_SCHEMA, LimitsSchema, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { guard } from '../zip-errors.js';
import { parseInput, ProjectionShape } from './_shared.js';

export const VERIFY_ZIP_NAME = 'verify_zip';

export const VERIFY_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        entries: {
            type: 'string',
            enum: ['all', 'failed', 'skipped', 'none'],
            default: 'all',
            description: "Which per-entry rows to return: 'all' (default), only 'failed' (ok:false, not skipped), only 'skipped', or 'none' (verdict + counts only).",
        },
        maxEntries: { type: 'integer', minimum: 1, maximum: 100_000, default: 1000, description: 'Cap on returned rows (the counts always cover every entry); `entriesTruncated` flags a cut.' },
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        entries: z.enum(['all', 'failed', 'skipped', 'none']).default('all'),
        maxEntries: z.number().int().min(1).max(100_000).default(1000),
        limits: LimitsSchema.optional(),
        ...ProjectionShape,
    })
    .superRefine(refineArchiveInput);

export interface VerifyZipResult {
    readonly ok: boolean;
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly entryCount: number;
    readonly verifiedCount: number;
    readonly failedCount: number;
    readonly skippedCount: number;
    readonly entries: readonly VerifiedEntry[];
    readonly entriesTruncated?: true;
    readonly diagnostics: readonly DiagnosticRow[];
}

export const VERIFY_ZIP_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'error', 'entryCount', 'verifiedCount', 'failedCount', 'skippedCount', 'entries', 'diagnostics'],
    description: "zipnative's verifyZip report: structure valid AND every verifiable entry passed ⇒ ok. Never an isError for an archive problem.",
    properties: {
        ok: { type: 'boolean' },
        error: {
            type: ['object', 'null'],
            additionalProperties: false,
            description: 'The structural refusal when the archive could not even be opened (frozen ZIP_* code + engine message), else null.',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
        },
        entryCount: { type: 'integer', minimum: 0 },
        verifiedCount: { type: 'integer', minimum: 0, description: 'Entries that passed every check.' },
        failedCount: { type: 'integer', minimum: 0, description: 'Entries that fail the archive: a CRC / size / local-header mismatch, an unknown compression method, or a design-time skip whose local header contradicts the central directory.' },
        skippedCount: { type: 'integer', minimum: 0, description: 'Entries that could not be verified by design (encrypted, stream-only codec) and whose local header agrees with the central directory.' },
        entries: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    name: { type: 'string' },
                    ok: { type: 'boolean' },
                    crcMatch: { type: 'boolean' },
                    sizeMatch: { type: 'boolean' },
                    localHeaderMatch: { type: 'boolean' },
                    skipped: { type: 'string', enum: ['encrypted', 'stream-only-codec', 'unsupported-method'], description: 'Why the payload was not verified (zipnative 1.1.0 adds unsupported-method, which still fails the archive).' },
                },
            },
        },
        entriesTruncated: { type: 'boolean' },
        diagnostics: DIAGNOSTICS_OUTPUT_PROPERTIES.diagnostics,
    },
} as const;

/** The engine's archive rule for a non-ok entry: a design-time skip passes when its local header agrees. */
function passesAsSkipped(e: VerifiedEntry): boolean {
    return (e.skipped === 'encrypted' || e.skipped === 'stream-only-codec') && e.localHeaderMatch;
}

export async function verifyZipTool(rawInput: unknown): Promise<VerifyZipResult> {
    const input = parseInput(InputSchema, rawInput);
    const { bytes } = await loadArchive(input);
    const limits = resolveCallLimits(input.limits);
    // Only caller mistakes throw here (invalid limits) — mapped like every other engine error.
    const report = guard('Failed to verify archive', () => verifyZip(bytes, limits !== undefined ? { limits } : undefined));
    let verifiedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    for (const e of report.entries) {
        if (e.ok) verifiedCount++;
        else if (passesAsSkipped(e)) skippedCount++;
        else failedCount++;
    }
    const selected = input.entries === 'none'
        ? []
        : input.entries === 'failed'
            ? report.entries.filter((e) => !e.ok && !passesAsSkipped(e))
            : input.entries === 'skipped'
                ? report.entries.filter((e) => !e.ok && passesAsSkipped(e))
                : report.entries;
    const truncated = selected.length > input.maxEntries;
    return {
        ok: report.ok,
        error: report.error,
        entryCount: report.entryCount,
        verifiedCount,
        failedCount,
        skippedCount,
        entries: truncated ? selected.slice(0, input.maxEntries) : [...selected],
        ...(truncated ? { entriesTruncated: true as const } : {}),
        diagnostics: report.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, ...(d.entryName !== undefined ? { entryName: d.entryName } : {}) })),
    };
}

export function verifySummary(r: VerifyZipResult): Record<string, unknown> {
    return {
        ok: r.ok,
        error: r.error,
        entryCount: r.entryCount,
        verifiedCount: r.verifiedCount,
        failedCount: r.failedCount,
        skippedCount: r.skippedCount,
        diagnosticCount: r.diagnostics.length,
    };
}

export const VERIFY_ZIP_SUMMARY_PROPERTIES = {
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of diagnostics.' },
} as const;
