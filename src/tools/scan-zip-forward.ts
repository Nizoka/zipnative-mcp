/**
 * Tool: scan_zip_forward — the engine's forward, central-directory-less
 * reader (`iterateZipEntries`) over the archive bytes: local headers walked
 * in stream order with bounded memory. The one tool that works on a
 * truncated archive, a stream that was cut, or a stream you cannot seek —
 * and the one whose result is NOT authoritative.
 *
 * TRUST CAVEAT (from the engine): forward iteration trusts local headers
 * ALONE. There is no central directory to cross-check names, sizes or
 * methods, so a hostile archive can present different content here than
 * `inspect_zip` / `list_zip_entries` report — the classic upload-scanner
 * differential. Prefer those tools whenever the whole archive is available.
 */
import { z } from 'zod';
import { iterateZipEntries } from 'zipnative';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, openArchiveSource, refineArchiveInput } from '../archive-input.js';
import { encodeBase64 } from '../base64.js';
import { getCeilings, MAX_ENTRIES_ENV, MAX_ENTRY_INLINE_BYTES, MAX_EXTRACT_INLINE_TOTAL_BYTES, MAX_SCAN_ENTRIES_DEFAULT } from '../caps.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticsReport } from '../diagnostics.js';
import { ENTRY_VIEW_SCHEMA, viewFromHeader, type EntryView } from '../entry.js';
import { ToolError } from '../errors.js';
import { compileEntryFilter, FILTER_INPUT_SCHEMA, FilterSchema } from '../filter.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { mapZipError } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, ProjectionShape, STRICT_INPUT_PROPERTY } from './_shared.js';

export const SCAN_ZIP_FORWARD_NAME = 'scan_zip_forward';

export const SCAN_ZIP_FORWARD_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        data: {
            type: 'string',
            enum: ['none', 'verify', 'include'],
            default: 'none',
            description: "'none' (default): skip payloads (a data-descriptor entry still costs a full decompress-and-discard); 'verify': decompress every kept entry so CRC and sizes are checked; 'include': also return the content as base64 (inline caps apply).",
        },
        filter: FILTER_INPUT_SCHEMA,
        maxEntries: { type: 'integer', minimum: 1, default: MAX_SCAN_ENTRIES_DEFAULT, description: 'Stop after this many local headers (bounded work on an unbounded stream).' },
        tolerateTruncation: { type: 'boolean', default: false, description: 'true: a truncated / corrupt stream ends the scan with `stoppedAt:"error"` and the partial inventory (forensics) instead of failing the call.' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        data: z.enum(['none', 'verify', 'include']).default('none'),
        filter: FilterSchema.optional(),
        maxEntries: z.number().int().min(1).default(MAX_SCAN_ENTRIES_DEFAULT),
        tolerateTruncation: z.boolean().default(false),
        ...EngineOptionsShape,
        ...ProjectionShape,
    })
    .superRefine(refineArchiveInput);

export interface ScannedEntry extends EntryView {
    readonly kept: boolean;
    readonly data?: { readonly verified: boolean; readonly bytesProduced: number; readonly dataBase64?: string };
}

export interface ScanZipForwardResult extends DiagnosticsReport {
    readonly trust: 'local-headers-only';
    readonly entryCount: number;
    readonly keptCount: number;
    readonly entries: readonly ScannedEntry[];
    readonly stoppedAt: 'central-directory' | 'eof' | 'max-entries' | 'error';
    readonly truncated: boolean;
    readonly inputBytes: number | null;
    readonly bytesDelivered: number;
    readonly error?: { readonly code: string; readonly message: string };
}

export const SCAN_ZIP_FORWARD_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['trust', 'entryCount', 'keptCount', 'entries', 'stoppedAt', 'truncated', 'diagnostics'],
    properties: {
        trust: { type: 'string', enum: ['local-headers-only'], description: 'Constant reminder: nothing here was cross-checked against a central directory.' },
        entryCount: { type: 'integer', minimum: 0, description: 'Local headers seen (before the filter).' },
        keptCount: { type: 'integer', minimum: 0 },
        entries: {
            type: 'array',
            items: {
                ...ENTRY_VIEW_SCHEMA,
                properties: {
                    ...ENTRY_VIEW_SCHEMA.properties,
                    kept: { type: 'boolean', description: 'false when the filter dropped it (row kept for the inventory, payload skipped).' },
                    data: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { verified: { type: 'boolean' }, bytesProduced: { type: 'integer', minimum: 0 }, dataBase64: { type: 'string' } },
                    },
                },
            },
        },
        stoppedAt: { type: 'string', enum: ['central-directory', 'eof', 'max-entries', 'error'], description: "'central-directory' is the normal end of a complete archive; 'eof' means the stream ended before any central directory (truncated or CD-less)." },
        truncated: { type: 'boolean', description: 'true when the stream ended without reaching a central directory.' },
        inputBytes: { type: ['integer', 'null'] },
        bytesDelivered: { type: 'integer', minimum: 0, description: 'Bytes handed to the forward reader.' },
        error: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, message: { type: 'string' } } },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
    },
} as const;

const SIG_CFH = [0x50, 0x4b, 0x01, 0x02];
const SIG_EOCD = [0x50, 0x4b, 0x05, 0x06];
const SIG_Z64_EOCD = [0x50, 0x4b, 0x06, 0x06];

function containsSignature(chunk: Uint8Array): boolean {
    for (let i = 0; i + 4 <= chunk.length; i++) {
        if (chunk[i] !== 0x50 || chunk[i + 1] !== 0x4b) continue;
        for (const sig of [SIG_CFH, SIG_EOCD, SIG_Z64_EOCD]) {
            if (chunk[i + 2] === sig[2] && chunk[i + 3] === sig[3]) return true;
        }
    }
    return false;
}

export async function scanZipForward(rawInput: unknown): Promise<ScanZipForwardResult> {
    const input = parseInput(InputSchema, rawInput);
    const ceilings = getCeilings();
    if (input.maxEntries > ceilings.maxEntries) {
        throw new ToolError('LIMIT_CEILING_EXCEEDED', `maxEntries ${input.maxEntries} exceeds the operator ceiling ${ceilings.maxEntries} (${MAX_ENTRIES_ENV}).`, { limit: 'maxEntries', requested: input.maxEntries, ceiling: ceilings.maxEntries, env: MAX_ENTRIES_ENV });
    }
    const { source, sizeBytes } = await openArchiveSource(input);
    const sink = createDiagnosticSink(input.strict);
    const limits = resolveCallLimits(input.limits);
    const keep = compileEntryFilter(input.filter === undefined ? { includeDirectories: true } : input.filter);

    // Count what the reader consumed so a clean stop can be classified: the engine
    // returns cleanly both at a central-directory signature and at EOF.
    const counter: { delivered: number; tail: Uint8Array } = { delivered: 0, tail: new Uint8Array(0) };
    async function* counting(): AsyncGenerator<Uint8Array, void, undefined> {
        for await (const chunk of source) {
            counter.delivered += chunk.byteLength;
            counter.tail = chunk;
            yield chunk;
        }
    }

    const entries: ScannedEntry[] = [];
    let entryCount = 0;
    let keptCount = 0;
    let inlineTotal = 0;
    const state: { stoppedAt: ScanZipForwardResult['stoppedAt']; error?: { code: string; message: string } } = { stoppedAt: 'eof' };

    const fail = (err: unknown, context: string, name?: string): void => {
        if (err instanceof ToolError) throw err;
        const mapped = mapZipError(err, context, name);
        if (!input.tolerateTruncation) throw mapped;
        state.error = { code: mapped.code, message: mapped.message };
        state.stoppedAt = 'error';
    };

    const gen = iterateZipEntries(counting(), { ...(limits !== undefined ? { limits } : {}), ...sink.options });
    try {
        for (;;) {
            if (entryCount >= input.maxEntries) {
                state.stoppedAt = 'max-entries';
                break;
            }
            let next;
            try {
                next = await gen.next();
            } catch (err) {
                fail(err, 'Forward scan failed');
                break;
            }
            if (next.done) {
                const consumedEverything = sizeBytes !== null && counter.delivered >= sizeBytes;
                state.stoppedAt = !consumedEverything || containsSignature(counter.tail) ? 'central-directory' : 'eof';
                break;
            }
            const item = next.value;
            const index = entryCount++;
            const kept = keep(item.header.name, item.header.isDirectory);
            const view = viewFromHeader(item.header, index);
            if (!kept || input.data === 'none' || item.header.isDirectory) {
                try {
                    await item.skip();
                } catch (err) {
                    entries.push({ ...view, kept });
                    if (kept) keptCount++;
                    fail(err, `Forward scan failed at entry "${item.header.name}"`, item.header.name);
                    break;
                }
                entries.push({ ...view, kept });
                if (kept) keptCount++;
                continue;
            }
            const parts: Uint8Array[] = [];
            let produced = 0;
            try {
                for await (const chunk of item.data()) {
                    produced += chunk.byteLength;
                    if (input.data === 'include') {
                        if (produced > MAX_ENTRY_INLINE_BYTES) {
                            throw new ToolError('ENTRY_TOO_LARGE', `Entry "${item.header.name}" exceeds the ${MAX_ENTRY_INLINE_BYTES}-byte inline cap — use data:'verify' or a filter.`, { entryName: item.header.name, cap: MAX_ENTRY_INLINE_BYTES });
                        }
                        parts.push(chunk);
                    }
                }
            } catch (err) {
                entries.push({ ...view, kept, data: { verified: false, bytesProduced: produced } });
                keptCount++;
                fail(err, `Forward scan failed at entry "${item.header.name}"`, item.header.name);
                break;
            }
            keptCount++;
            if (input.data === 'include') {
                inlineTotal += produced;
                if (inlineTotal > MAX_EXTRACT_INLINE_TOTAL_BYTES) {
                    throw new ToolError('OUTPUT_TOO_LARGE', `Inline payloads exceed the ${MAX_EXTRACT_INLINE_TOTAL_BYTES}-byte cap — use data:'verify' or a filter.`, { cap: MAX_EXTRACT_INLINE_TOTAL_BYTES });
                }
                const data = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
                entries.push({ ...view, kept, data: { verified: true, bytesProduced: produced, dataBase64: encodeBase64(data) } });
            } else {
                entries.push({ ...view, kept, data: { verified: true, bytesProduced: produced } });
            }
        }
    } finally {
        await gen.return();
    }

    const truncated = state.stoppedAt === 'eof' || state.stoppedAt === 'error';
    return {
        trust: 'local-headers-only',
        entryCount,
        keptCount,
        entries,
        stoppedAt: state.stoppedAt,
        truncated,
        inputBytes: sizeBytes,
        bytesDelivered: counter.delivered,
        ...(state.error !== undefined ? { error: state.error } : {}),
        ...sink.report(),
    };
}

export function scanSummary(r: ScanZipForwardResult): Record<string, unknown> {
    return {
        trust: r.trust,
        entryCount: r.entryCount,
        keptCount: r.keptCount,
        stoppedAt: r.stoppedAt,
        truncated: r.truncated,
        names: r.entries.filter((e) => e.kept).map((e) => e.name),
        ...(r.error !== undefined ? { error: r.error } : {}),
        diagnosticCount: r.diagnostics.length,
    };
}

export const SCAN_ZIP_FORWARD_SUMMARY_PROPERTIES = {
    names: { type: 'array', items: { type: 'string' }, description: 'summary only: the kept entry names.' },
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of distinct diagnostics.' },
} as const;
