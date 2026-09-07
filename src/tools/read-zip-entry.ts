/**
 * Tool: read_zip_entry — random access to ONE entry without extracting the
 * archive: its decompressed content (`mode: 'data'`, base64 or UTF-8 text,
 * optionally a byte `range` read through the chunked stream API), its
 * compressed payload verbatim (`mode: 'raw'`), or a non-throwing integrity
 * check (`mode: 'verify'`). CRC-verified by default.
 */
import { z } from 'zod';
import { openZip, type ZipEntry } from 'zipnative';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { encodeBase64 } from '../base64.js';
import { MAX_ENTRY_INLINE_BYTES, MAX_RANGE_LENGTH } from '../caps.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticsReport } from '../diagnostics.js';
import { ENTRY_VIEW_SCHEMA, viewFromEntry, type EntryView } from '../entry.js';
import { ToolError } from '../errors.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { guard, guardAsync } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, ProjectionShape, STRICT_INPUT_PROPERTY } from './_shared.js';

export const READ_ZIP_ENTRY_NAME = 'read_zip_entry';

export const READ_ZIP_ENTRY_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        name: { type: 'string', minLength: 1, description: 'Entry name (exact, case-sensitive; the LAST duplicate wins). Exclusive with index.' },
        index: { type: 'integer', minimum: 0, description: 'Central-directory position (from list_zip_entries) — disambiguates duplicate names. Exclusive with name.' },
        mode: {
            type: 'string',
            enum: ['data', 'raw', 'verify'],
            default: 'data',
            description: "'data' (default): decompressed content; 'raw': the compressed payload bytes verbatim (zero-copy, no decompression); 'verify': CRC / size / local-header check only, no payload.",
        },
        encoding: { type: 'string', enum: ['base64', 'utf8'], default: 'base64', description: "Content encoding for mode 'data': base64 (default) or UTF-8 text (invalid UTF-8 → ENTRY_NOT_UTF8)." },
        verifyCrc: { type: 'boolean', default: true, description: 'Verify the decompressed CRC-32 against the central directory (mode data, no range).' },
        range: {
            type: 'object',
            additionalProperties: false,
            required: ['offset', 'length'],
            description: `Read only a byte window of the decompressed content through the chunked stream (bounded memory; CRC is not verified for a window). length ≤ ${MAX_RANGE_LENGTH}.`,
            properties: {
                offset: { type: 'integer', minimum: 0, description: 'First byte of the window (0-based, in the decompressed content).' },
                length: { type: 'integer', minimum: 1, maximum: MAX_RANGE_LENGTH, description: 'Window length in bytes; fewer are returned at the end of the entry (`range.returned`).' },
            },
        },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        name: z.string().min(1).optional(),
        index: z.number().int().min(0).optional(),
        mode: z.enum(['data', 'raw', 'verify']).default('data'),
        encoding: z.enum(['base64', 'utf8']).default('base64'),
        verifyCrc: z.boolean().default(true),
        range: z.strictObject({ offset: z.number().int().min(0), length: z.number().int().min(1).max(MAX_RANGE_LENGTH) }).optional(),
        ...EngineOptionsShape,
        ...ProjectionShape,
    })
    .superRefine((value, ctx) => {
        refineArchiveInput(value, ctx);
        const has = (value.name !== undefined ? 1 : 0) + (value.index !== undefined ? 1 : 0);
        if (has !== 1) ctx.addIssue({ code: 'custom', message: 'pass exactly one of name / index', path: ['name'] });
        if (value.range !== undefined && value.mode !== 'data') ctx.addIssue({ code: 'custom', message: "range applies to mode 'data' only", path: ['range'] });
        if (value.encoding === 'utf8' && value.mode === 'raw') ctx.addIssue({ code: 'custom', message: "encoding 'utf8' does not apply to mode 'raw' (compressed bytes)", path: ['encoding'] });
    });

export interface ReadZipEntryResult extends DiagnosticsReport {
    readonly entry: EntryView;
    readonly mode: 'data' | 'raw' | 'verify';
    readonly sizeBytes: number;
    readonly crcVerified: boolean;
    readonly encoding?: 'base64' | 'utf8';
    readonly dataBase64?: string;
    readonly text?: string;
    readonly textLength?: number;
    readonly range?: { readonly offset: number; readonly length: number; readonly returned: number };
    readonly verification?: { readonly ok: boolean; readonly crcMatch: boolean; readonly sizeMatch: boolean; readonly localHeaderMatch: boolean };
}

export const READ_ZIP_ENTRY_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['entry', 'mode', 'sizeBytes', 'crcVerified', 'diagnostics'],
    properties: {
        entry: ENTRY_VIEW_SCHEMA,
        mode: { type: 'string', enum: ['data', 'raw', 'verify'] },
        sizeBytes: { type: 'integer', minimum: 0, description: 'Bytes returned (data / raw) or the declared uncompressed size (verify).' },
        crcVerified: { type: 'boolean' },
        encoding: { type: 'string', enum: ['base64', 'utf8'] },
        dataBase64: { type: 'string' },
        text: { type: 'string' },
        textLength: { type: 'integer', minimum: 0 },
        range: {
            type: 'object',
            additionalProperties: false,
            properties: { offset: { type: 'integer' }, length: { type: 'integer' }, returned: { type: 'integer' } },
        },
        verification: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, crcMatch: { type: 'boolean' }, sizeMatch: { type: 'boolean' }, localHeaderMatch: { type: 'boolean' } },
        },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
    },
} as const;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function locate(entries: readonly ZipEntry[], reader: { getEntry(name: string): ZipEntry | null }, input: { name?: string | undefined; index?: number | undefined }): { entry: ZipEntry; index: number } {
    if (input.index !== undefined) {
        const entry = entries[input.index];
        if (entry === undefined) {
            throw new ToolError('ZIP_ENTRY_NOT_FOUND', `Entry index ${input.index} is out of range (the archive holds ${entries.length} entries, indices 0–${Math.max(0, entries.length - 1)}) — take the index from list_zip_entries.`, { errorClass: 'not-found', index: input.index, entryCount: entries.length, remedy: 'list_zip_entries' });
        }
        return { entry, index: input.index };
    }
    const name = input.name as string;
    const entry = guard('Failed to look up entry', () => reader.getEntry(name), name);
    if (entry === null) {
        throw new ToolError('ZIP_ENTRY_NOT_FOUND', `Entry not found: ${name} (names are case-sensitive — call list_zip_entries for the exact names).`, { errorClass: 'not-found', entryName: name });
    }
    return { entry, index: entries.lastIndexOf(entry) };
}

export async function readZipEntry(rawInput: unknown): Promise<ReadZipEntryResult> {
    const input = parseInput(InputSchema, rawInput);
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict);
    const limits = resolveCallLimits(input.limits);
    const reader = guard('Failed to open archive', () => openZip(bytes, { ...(limits !== undefined ? { limits } : {}), ...sink.options }));
    const entries: ZipEntry[] = guard('Failed to read the central directory', () => [...reader.entries()]);
    const { entry, index } = locate(entries, reader, input);
    const view = viewFromEntry(entry, index);
    const label = entry.name;

    if (input.mode === 'verify') {
        const verification = guard(`Failed to verify entry "${label}"`, () => reader.verifyEntry(entry), label);
        return { entry: view, mode: 'verify', sizeBytes: entry.uncompressedSize, crcVerified: verification.crcMatch, verification, ...sink.report() };
    }

    if (input.mode === 'raw') {
        if (entry.compressedSize > MAX_ENTRY_INLINE_BYTES) {
            throw new ToolError('ENTRY_TOO_LARGE', `Entry "${label}" compressed payload is ${entry.compressedSize} bytes, above the ${MAX_ENTRY_INLINE_BYTES}-byte inline cap — raw payloads above the cap are not retrievable inline; for the DECOMPRESSED content use mode:'data' with a range, or extract_zip with outputMode:'file'.`, { entryName: label, sizeBytes: entry.compressedSize, cap: MAX_ENTRY_INLINE_BYTES, remedy: 'range' });
        }
        const raw = guard(`Failed to read raw entry "${label}"`, () => reader.readEntryRaw(entry), label);
        return { entry: view, mode: 'raw', sizeBytes: raw.byteLength, crcVerified: false, encoding: 'base64', dataBase64: encodeBase64(raw), ...sink.report() };
    }

    let data: Uint8Array;
    let crcVerified: boolean;
    let range: ReadZipEntryResult['range'];
    if (input.range !== undefined) {
        // Chunked read through the stream API: bounded memory, no CRC for a window.
        const { offset, length } = input.range;
        const parts: Uint8Array[] = [];
        let seen = 0;
        let collected = 0;
        await guardAsync(`Failed to stream entry "${label}"`, async () => {
            const gen = reader.readEntryStream(entry, { verifyCrc: false });
            try {
                for await (const chunk of gen) {
                    const start = seen;
                    const end = seen + chunk.byteLength;
                    seen = end;
                    if (end <= offset) continue;
                    const from = Math.max(0, offset - start);
                    const to = Math.min(chunk.byteLength, offset + length - start);
                    if (to > from) {
                        parts.push(chunk.subarray(from, to));
                        collected += to - from;
                    }
                    if (collected >= length) break;
                }
            } finally {
                await gen.return();
            }
        }, label);
        data = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
        crcVerified = false;
        range = { offset, length, returned: data.byteLength };
    } else {
        if (entry.uncompressedSize > MAX_ENTRY_INLINE_BYTES) {
            throw new ToolError('ENTRY_TOO_LARGE', `Entry "${label}" is ${entry.uncompressedSize} bytes, above the ${MAX_ENTRY_INLINE_BYTES}-byte inline cap — pass a range, or use extract_zip with outputMode:'file'.`, { entryName: label, sizeBytes: entry.uncompressedSize, cap: MAX_ENTRY_INLINE_BYTES, remedy: 'range' });
        }
        data = guard(`Failed to read entry "${label}"`, () => reader.readEntry(entry, { verifyCrc: input.verifyCrc }), label);
        crcVerified = input.verifyCrc;
    }

    const base = { entry: view, mode: 'data' as const, sizeBytes: data.byteLength, crcVerified, ...(range !== undefined ? { range } : {}), ...sink.report() };
    if (input.encoding === 'utf8') {
        let text: string;
        try {
            text = utf8Strict.decode(data);
        } catch {
            throw new ToolError('ENTRY_NOT_UTF8', `Entry "${label}" is not valid UTF-8 — read it with encoding:'base64'.`, { entryName: label, remedy: "encoding:'base64'" });
        }
        return { ...base, encoding: 'utf8', text, textLength: text.length };
    }
    return { ...base, encoding: 'base64', dataBase64: encodeBase64(data) };
}

export function readEntrySummary(r: ReadZipEntryResult): Record<string, unknown> {
    return {
        name: r.entry.name,
        index: r.entry.index,
        mode: r.mode,
        sizeBytes: r.sizeBytes,
        crcVerified: r.crcVerified,
        ...(r.textLength !== undefined ? { textLength: r.textLength } : {}),
        ...(r.range !== undefined ? { range: r.range } : {}),
        ...(r.verification !== undefined ? { verification: r.verification } : {}),
        diagnosticCount: r.diagnostics.length,
    };
}

export const READ_ZIP_ENTRY_SUMMARY_PROPERTIES = {
    name: { type: 'string', description: 'summary only: the entry name.' },
    index: { type: 'integer', minimum: 0, description: 'summary only: the entry index.' },
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of distinct diagnostics.' },
} as const;
