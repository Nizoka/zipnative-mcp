/**
 * Tool: list_zip_entries — the paged central-directory inventory. Every
 * entry (duplicates included) appears in central-directory order, projected
 * through the shared EntryView; `filter` selects by name / prefix / glob and
 * `offset` / `limit` page the result so a 100 000-entry archive stays
 * token-bounded. A `zipPath` above the 1 GiB in-memory cap (or any archive
 * with `access: 'range'`) is listed through zipnative's byte-range reader:
 * only the end record and the central directory are read.
 */
import { z } from 'zod';
import type { ZipEntry } from 'zipnative';

import { NO_CONTEXT, type CallContext } from '../call-context.js';
import { ACCESS_INPUT_PROPERTY, AccessShape, ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, openArchive, refineArchiveInput, type ArchiveHandle } from '../archive-input.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../caps.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticSink, type DiagnosticsReport } from '../diagnostics.js';
import { ENTRY_VIEW_SCHEMA, viewFromEntry, type EntryView } from '../entry.js';
import { compileEntryFilter, FILTER_INPUT_SCHEMA, FilterSchema } from '../filter.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { guard } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, ProjectionShape, STRICT_INPUT_PROPERTY } from './_shared.js';

export const LIST_ZIP_ENTRIES_NAME = 'list_zip_entries';

export const LIST_ZIP_ENTRIES_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        offset: { type: 'integer', minimum: 0, default: 0, description: 'Skip this many matching entries (paging).' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: `Return at most this many entries (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}); \`hasMore\` tells you to page.` },
        filter: FILTER_INPUT_SCHEMA,
        includeExtraData: { type: 'boolean', default: false, description: 'Include each extra field payload as base64 (forensics).' },
        includeExtendedTimestamps: { type: 'boolean', default: false, description: "Add each entry's `extendedTimestamps` (zipnative getExtendedTimestamps: UT, then NTFS, then the DOS fields; ISO-8601, UTC)." },
        includeUnixIds: { type: 'boolean', default: false, description: "Add each entry's `unixIds` (zipnative getUnixIds: the Info-ZIP ux uid / gid, or null)." },
        validate: { type: 'string', enum: ['lazy', 'eager'], default: 'lazy', description: "'lazy' (default) parses the central directory only; 'eager' also cross-checks every local header up front." },
        ...ACCESS_INPUT_PROPERTY,
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
        filter: FilterSchema.optional(),
        includeExtraData: z.boolean().default(false),
        includeExtendedTimestamps: z.boolean().default(false),
        includeUnixIds: z.boolean().default(false),
        validate: z.enum(['lazy', 'eager']).default('lazy'),
        ...AccessShape,
        ...EngineOptionsShape,
        ...ProjectionShape,
    })
    .superRefine(refineArchiveInput);

export interface ListZipEntriesResult extends DiagnosticsReport {
    readonly entryCount: number;
    readonly matchedCount: number;
    readonly offset: number;
    readonly limit: number;
    readonly returnedCount: number;
    readonly hasMore: boolean;
    readonly isZip64: boolean;
    readonly entries: readonly EntryView[];
    /** Present ('range') when the archive was read by byte ranges. */
    readonly access?: 'range';
}

export const LIST_ZIP_ENTRIES_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['entryCount', 'matchedCount', 'offset', 'limit', 'returnedCount', 'hasMore', 'entries', 'diagnostics'],
    properties: {
        entryCount: { type: 'integer', minimum: 0, description: 'Entries in the central directory (before filtering).' },
        matchedCount: { type: 'integer', minimum: 0, description: 'Entries kept by the filter (before paging).' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        returnedCount: { type: 'integer', minimum: 0 },
        hasMore: { type: 'boolean' },
        isZip64: { type: 'boolean' },
        access: { type: 'string', enum: ['range'], description: "Present when the archive was read by byte ranges (access 'range', or a zipPath above the in-memory cap)." },
        entries: { type: 'array', items: ENTRY_VIEW_SCHEMA },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
    },
} as const;

export async function listZipEntries(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<ListZipEntriesResult> {
    const input = parseInput(InputSchema, rawInput);
    const sink = createDiagnosticSink(input.strict, context);
    const limits = resolveCallLimits(input.limits);
    const reader = await openArchive(input, input.access, { validate: input.validate, ...(limits !== undefined ? { limits } : {}), ...sink.options });
    try {
        return listOpened(input, reader, sink);
    } finally {
        await reader.close();
    }
}

function listOpened(input: z.infer<typeof InputSchema>, reader: ArchiveHandle, sink: DiagnosticSink): ListZipEntriesResult {
    const all: ZipEntry[] = guard('Failed to read the central directory', () => reader.entries());
    // Directories are listed unless a filter explicitly excludes them — the
    // filter default (`includeDirectories: false`) exists for extraction.
    const keep = compileEntryFilter(input.filter === undefined ? { includeDirectories: true } : input.filter);
    const matched: Array<{ entry: ZipEntry; index: number }> = [];
    all.forEach((entry, index) => {
        if (keep(entry.name, entry.isDirectory)) matched.push({ entry, index });
    });
    const page = matched.slice(input.offset, input.offset + input.limit);
    return {
        entryCount: reader.entryCount,
        matchedCount: matched.length,
        offset: input.offset,
        limit: input.limit,
        returnedCount: page.length,
        hasMore: input.offset + page.length < matched.length,
        isZip64: reader.isZip64,
        entries: page.map(({ entry, index }) => viewFromEntry(entry, index, { includeExtraData: input.includeExtraData, includeExtendedTimestamps: input.includeExtendedTimestamps, includeUnixIds: input.includeUnixIds })),
        ...sink.report(),
        ...(reader.access === 'range' ? { access: 'range' as const } : {}),
    };
}

export function listSummary(r: ListZipEntriesResult): Record<string, unknown> {
    return {
        entryCount: r.entryCount,
        matchedCount: r.matchedCount,
        returnedCount: r.returnedCount,
        hasMore: r.hasMore,
        isZip64: r.isZip64,
        names: r.entries.map((e) => e.name),
        diagnosticCount: r.diagnostics.length,
    };
}

export const LIST_ZIP_ENTRIES_SUMMARY_PROPERTIES = {
    names: { type: 'array', items: { type: 'string' }, description: 'summary only: the names on this page.' },
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of distinct diagnostics.' },
} as const;
