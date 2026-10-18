/**
 * Tool: merge_zip — several archives into one WITHOUT recompressing
 * anything: zipnative 1.1.0's `ZipWriter.addFromReader()` transplants each
 * entry's compressed bytes with its method, CRC, sizes, timestamp,
 * attributes, comment and extra fields (Zip64 recomputed), in O(bytes
 * copied). Every entry is verified against its CRC and size before it is
 * copied (`verify: true`, the default), so a corrupt payload is refused with
 * its frozen code instead of being propagated; encrypted entries are refused
 * by the engine (they cannot be read raw).
 *
 * Name collisions: `onConflict: 'error'` (default) lets the engine refuse the
 * second occurrence (`ZIP_DUPLICATE_ENTRY_NAME`); `'first'` / `'last'` keep
 * the first / last occurrence across the sources in order and report what was
 * dropped. The checked transplant is the only form exposed: `addRaw()` (the
 * caller vouches for CRC and sizes) stays unexposed, an agent cannot forge an
 * inconsistent archive through this tool.
 *
 * The result is ordered like `create_zip` (`order: 'canonical'` by default —
 * deterministic given the same sources); run canonicalize_zip on it for the
 * full canonical form (one timestamp, Zip64-only extras).
 */
import { z } from 'zod';
import { createZip, openZip, type ZipEntry, type ZipReader } from 'zipnative';

import { NO_CONTEXT, throwIfCancelled, type CallContext } from '../call-context.js';
import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_MERGE_INPUT_BYTES, MAX_MERGE_SOURCES } from '../caps.js';
import { createDiagnosticSink, type DiagnosticsReport } from '../diagnostics.js';
import { ensureEngineReady } from '../engine.js';
import { compileEntryFilter, FILTER_INPUT_SCHEMA, FilterSchema } from '../filter.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { emitArchive, emitArchiveStream, OUTPUT_INPUT_PROPERTIES, OutputShape, type OutputResult } from '../output.js';
import { guard, guardAsync } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, sha256Hex, STRICT_INPUT_PROPERTY } from './_shared.js';
import { archiveOutputSchemaWith } from './create-zip.js';

export const MERGE_ZIP_NAME = 'merge_zip';

const U16 = 65_535;

export const MERGE_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['sources'],
    properties: {
        sources: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_MERGE_SOURCES,
            description: `The archives to merge, in order (1–${MAX_MERGE_SOURCES}; total ≤ ${MAX_MERGE_INPUT_BYTES} bytes, inline payloads ≤ ${MAX_BASE64_INPUT_BYTES} bytes in all). Each is zipBase64 XOR zipPath, with an optional filter selecting the entries taken from it (directories are kept unless the filter excludes them).`,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ...ARCHIVE_INPUT_PROPERTIES,
                    filter: FILTER_INPUT_SCHEMA,
                },
            },
        },
        onConflict: {
            type: 'string',
            enum: ['error', 'first', 'last'],
            default: 'error',
            description: "Two entries with the same name: 'error' (default) — the engine refuses the second with ZIP_DUPLICATE_ENTRY_NAME; 'first' / 'last' — keep the first / last occurrence across the sources in order, the others are reported in summary.dropped.",
        },
        verify: {
            type: 'boolean',
            default: true,
            description: 'Decompress each entry once to check its CRC and size before copying it (secure by default: a corrupt entry is refused with ZIP_CRC_MISMATCH / ZIP_SIZE_MISMATCH instead of being propagated). false trusts the sources — their bytes travel as they are.',
        },
        order: {
            type: 'string',
            enum: ['canonical', 'insertion'],
            default: 'canonical',
            description: "'canonical' (default): entries sorted by raw name bytes, as create_zip writes them; 'insertion': the sources' order, then each source's central-directory order.",
        },
        comment: { type: 'string', maxLength: U16, description: 'Archive comment of the result (UTF-8, ≤ 65535 bytes). Default none — the sources\' comments are not merged.' },
        includeSha256: { type: 'boolean', default: false, description: 'Add `summary.sha256` of the produced bytes.' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...OUTPUT_INPUT_PROPERTIES,
    },
} as const;

const SourceSchema = z
    .strictObject({ ...ARCHIVE_INPUT_SHAPE, filter: FilterSchema.optional() })
    .superRefine(refineArchiveInput);

const InputSchema = z.strictObject({
    sources: z.array(SourceSchema).min(1).max(MAX_MERGE_SOURCES),
    onConflict: z.enum(['error', 'first', 'last']).default('error'),
    verify: z.boolean().default(true),
    order: z.enum(['canonical', 'insertion']).default('canonical'),
    comment: z.string().max(U16).optional(),
    includeSha256: z.boolean().default(false),
    ...EngineOptionsShape,
    ...OutputShape,
});

export const MERGE_ZIP_OUTPUT_SCHEMA = archiveOutputSchemaWith(
    {
        sourceCount: { type: 'integer', minimum: 0 },
        entryCount: { type: 'integer', minimum: 0, description: 'Entries written to the result.' },
        inputBytes: { type: 'integer', minimum: 0, description: 'Total size of the sources.' },
        outputBytes: { type: 'integer', minimum: 0 },
        onConflict: { type: 'string', enum: ['error', 'first', 'last'] },
        verified: { type: 'boolean', description: 'true when every copied entry was CRC- and size-checked first.' },
        order: { type: 'string', enum: ['canonical', 'insertion'] },
        perSource: {
            type: 'array',
            description: 'One row per source, in order.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { type: 'integer', minimum: 0 },
                    label: { type: 'string', description: "The zipPath, or 'zipBase64'." },
                    entryCount: { type: 'integer', minimum: 0 },
                    taken: { type: 'integer', minimum: 0 },
                    filteredOut: { type: 'integer', minimum: 0 },
                    dropped: { type: 'integer', minimum: 0, description: 'Entries lost to the onConflict policy.' },
                },
            },
        },
        dropped: {
            type: 'array',
            description: "Name collisions resolved by 'first' / 'last' (at most 200 rows): the name and the source whose entry was not kept.",
            items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, source: { type: 'integer', minimum: 0 } } },
        },
        sha256: { type: 'string', description: 'Present with includeSha256.' },
    },
    'merge_zip summary.',
);

const MAX_DROPPED_ROWS = 200;

export interface MergeZipSummary {
    readonly sourceCount: number;
    readonly entryCount: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly onConflict: 'error' | 'first' | 'last';
    readonly verified: boolean;
    readonly order: 'canonical' | 'insertion';
    readonly perSource: ReadonlyArray<{ readonly index: number; readonly label: string; readonly entryCount: number; readonly taken: number; readonly filteredOut: number; readonly dropped: number }>;
    readonly dropped: ReadonlyArray<{ readonly name: string; readonly source: number }>;
    readonly sha256?: string;
}

export type MergeZipResult = OutputResult & DiagnosticsReport & { readonly summary: MergeZipSummary };

interface Candidate {
    readonly source: number;
    readonly reader: ZipReader;
    readonly entry: ZipEntry;
}

export async function mergeZipTool(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<MergeZipResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const sink = createDiagnosticSink(input.strict, context);
    const limits = resolveCallLimits(input.limits);

    // 1. Open every source (in memory: the transplant reads zero-copy views of each).
    let inputBytes = 0;
    let inlineBytes = 0;
    const opened: Array<{ readonly label: string; readonly reader: ZipReader; readonly entries: readonly ZipEntry[]; readonly kept: readonly ZipEntry[] }> = [];
    for (const [i, source] of input.sources.entries()) {
        throwIfCancelled(context);
        const { bytes, label, source: kind } = await loadArchive(source);
        inputBytes += bytes.byteLength;
        assertInputWithin(inputBytes, MAX_MERGE_INPUT_BYTES, 'merge sources (total)');
        if (kind === 'base64') {
            inlineBytes += bytes.byteLength;
            assertInputWithin(inlineBytes, MAX_BASE64_INPUT_BYTES, 'merge sources inline (total)');
        }
        const reader = guard(`Failed to open source ${i}`, () => openZip(bytes, { ...(limits !== undefined ? { limits } : {}), ...sink.options }), undefined, { sourceIndex: i });
        const entries = guard(`Failed to read the central directory of source ${i}`, () => [...reader.entries()], undefined, { sourceIndex: i });
        const keep = compileEntryFilter(source.filter === undefined ? { includeDirectories: true } : source.filter);
        opened.push({ label, reader, entries, kept: entries.filter((e) => keep(e.name, e.isDirectory)) });
    }

    // 2. Plan the collisions ('first' / 'last'); 'error' leaves them to the engine.
    const plan: Candidate[] = [];
    const dropped: Array<{ name: string; source: number }> = [];
    const droppedPerSource = new Array<number>(opened.length).fill(0);
    if (input.onConflict === 'error') {
        opened.forEach((o, source) => o.kept.forEach((entry) => plan.push({ source, reader: o.reader, entry })));
    } else {
        const winner = new Map<string, Candidate>();
        opened.forEach((o, source) => o.kept.forEach((entry) => {
            const previous = winner.get(entry.name);
            const candidate = { source, reader: o.reader, entry };
            if (previous === undefined) {
                winner.set(entry.name, candidate);
                return;
            }
            const loser = input.onConflict === 'first' ? candidate : previous;
            if (input.onConflict === 'last') winner.set(entry.name, candidate);
            droppedPerSource[loser.source] = (droppedPerSource[loser.source] ?? 0) + 1;
            dropped.push({ name: entry.name, source: loser.source });
        }));
        const kept = new Set(winner.values());
        opened.forEach((o, source) => o.kept.forEach((entry) => {
            const c = winner.get(entry.name);
            if (c !== undefined && kept.has(c) && c.source === source && c.entry === entry) plan.push(c);
        }));
    }

    // 3. Transplant (verified by default), then assemble.
    const writer = guard('Failed to create the writer', () => createZip({
        order: input.order,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...sink.options,
    }));
    for (const c of plan) {
        throwIfCancelled(context);
        guard(`Failed to transplant '${c.entry.name}' from source ${c.source}`, () => writer.addFromReader(c.reader, c.entry, { verify: input.verify }), c.entry.name, { sourceIndex: c.source });
    }

    const summaryBase = {
        sourceCount: opened.length,
        entryCount: plan.length,
        inputBytes,
        onConflict: input.onConflict,
        verified: input.verify,
        order: input.order,
        perSource: opened.map((o, index) => ({
            index,
            label: o.label,
            entryCount: o.entries.length,
            taken: plan.filter((c) => c.source === index).length,
            filteredOut: o.entries.length - o.kept.length,
            dropped: droppedPerSource[index] ?? 0,
        })),
        dropped: dropped.slice(0, MAX_DROPPED_ROWS),
    };

    if (input.outputMode === 'file') {
        const out = await emitArchiveStream(
            guard('Failed to assemble archive', () => writer.stream()),
            input.outputPath,
            { hash: input.includeSha256 ? 'sha256' : undefined },
        );
        return { ...out, summary: { ...summaryBase, outputBytes: out.sizeBytes, ...(out.sha256 !== undefined ? { sha256: out.sha256 } : {}) }, ...sink.report() };
    }
    const bytes = await guardAsync('Failed to assemble archive', async () => writer.toBytes());
    const out = await emitArchive(bytes, { mode: 'base64' });
    const sha256 = input.includeSha256 ? await sha256Hex(bytes) : undefined;
    return { ...out, summary: { ...summaryBase, outputBytes: bytes.byteLength, ...(sha256 !== undefined ? { sha256 } : {}) }, ...sink.report() };
}
