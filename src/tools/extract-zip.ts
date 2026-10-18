/**
 * Tool: extract_zip — secure-by-default extraction. Every engine guard stays
 * on unless the caller names the relaxation: `rejectTraversal` (zip-slip,
 * device names — CWE-22 / CWE-67), `rejectSymlinks` (CWE-59), `onDuplicate`
 * (CWE-694), the `limits` bounds (CWE-400 / CWE-409), and overlap /
 * central-vs-local divergence detection that has no opt-out at all.
 *
 * base64 mode returns the files inline (bounded; `includeData: false` is a
 * dry run listing the plan). file mode streams every file under a relative
 * `outputDir` inside the sandbox: the engine's sanitized path is the only
 * thing ever joined, the parent's real path is checked, files are written
 * with `wx`, and a symlink accepted through `rejectSymlinks: false` is written
 * as a regular file holding the link target — never materialised as a link.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { extractZip, extractZipStream, openZip, sanitizeEntryPath, type ExtractOptions, type ZipEntry } from 'zipnative';

import { NO_CONTEXT, type CallContext } from '../call-context.js';
import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { encodeBase64 } from '../base64.js';
import { getCeilings, MAX_ENTRY_INLINE_BYTES, MAX_EXTRACT_INLINE_TOTAL_BYTES, MAX_FILE_OUTPUT_ENV } from '../caps.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticsReport } from '../diagnostics.js';
import { crcHex, methodName } from '../entry.js';
import { ToolError } from '../errors.js';
import { compileEntryFilter, FILTER_INPUT_SCHEMA, FilterSchema } from '../filter.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { assertAncestorInside, assertRealpathInside, discardPartial, mapWriteError, openExclusiveWriteStream, relativeLabel, resolveOutputDir } from '../sandbox.js';
import { guard, mapZipError } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, ProjectionShape, STRICT_INPUT_PROPERTY } from './_shared.js';

export const EXTRACT_ZIP_NAME = 'extract_zip';

export const EXTRACT_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        outputMode: {
            type: 'string',
            enum: ['base64', 'file'],
            default: 'base64',
            description: `'base64' (default): files inline (≤ ${MAX_ENTRY_INLINE_BYTES} bytes each, ≤ ${MAX_EXTRACT_INLINE_TOTAL_BYTES} bytes total). 'file': stream every file under outputDir inside ZIPNATIVE_MCP_OUTPUT_DIR (never overwrites) and return resource links.`,
        },
        outputDir: { type: 'string', minLength: 1, description: "Relative directory inside the sandbox to extract into (file mode; created if absent; no absolute paths, no '..')." },
        includeData: { type: 'boolean', default: true, description: 'base64 mode: false = dry run — list what WOULD be extracted (paths, sizes) without decompressing or returning bytes.' },
        filter: FILTER_INPUT_SCHEMA,
        rejectTraversal: { type: 'boolean', default: true, description: 'true (default): an entry whose name escapes the root (zip-slip, absolute, drive/UNC, NUL, ADS, Windows device name) fails the call with ZIP_PATH_TRAVERSAL. false: such entries are SKIPPED and listed in `skipped` — an unsafe path is never emitted either way.' },
        rejectSymlinks: { type: 'boolean', default: true, description: 'true (default): a symlink entry fails the call with ZIP_SYMLINK_REJECTED. false: its target text is extracted as ordinary data (never materialised as a link).' },
        onDuplicate: { type: 'string', enum: ['error', 'first', 'last'], default: 'error', description: "Two entries mapping to the same sanitized path: 'error' (default, ZIP_EXTRACT_DUPLICATE_PATH), keep the 'first', or keep the 'last'." },
        emptyDirectories: { type: 'boolean', default: false, description: 'file mode: also create explicit directory entries (with a safe name) that hold no file.' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        outputMode: z.enum(['base64', 'file']).default('base64'),
        outputDir: z.string().min(1).optional(),
        includeData: z.boolean().default(true),
        filter: FilterSchema.optional(),
        rejectTraversal: z.boolean().default(true),
        rejectSymlinks: z.boolean().default(true),
        onDuplicate: z.enum(['error', 'first', 'last']).default('error'),
        emptyDirectories: z.boolean().default(false),
        ...EngineOptionsShape,
        ...ProjectionShape,
    })
    .superRefine(refineArchiveInput);

export interface ExtractedRow {
    readonly path: string;
    readonly entryName: string;
    readonly index: number;
    readonly sizeBytes: number;
    readonly crc32: string;
    readonly method: string;
    readonly dataBase64?: string;
    /** Absolute sandbox path (file mode). */
    readonly filePath?: string;
}

export interface SkippedRow {
    readonly entryName: string;
    readonly reason: 'unsafe-path';
}

export interface ExtractZipResult extends DiagnosticsReport {
    readonly mode: 'base64' | 'file';
    readonly dryRun: boolean;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly entries: readonly ExtractedRow[];
    readonly skipped: readonly SkippedRow[];
    readonly outputDir?: string;
    readonly directoriesCreated?: number;
}

export const EXTRACT_ZIP_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'dryRun', 'fileCount', 'totalBytes', 'entries', 'skipped', 'diagnostics'],
    properties: {
        mode: { type: 'string', enum: ['base64', 'file'] },
        dryRun: { type: 'boolean', description: 'true when includeData was false: nothing was decompressed.' },
        fileCount: { type: 'integer', minimum: 0 },
        totalBytes: { type: 'integer', minimum: 0, description: 'Sum of the extracted (or planned) uncompressed sizes.' },
        entries: {
            type: 'array',
            description: 'One row per extracted file, in central-directory order. base64 mode carries dataBase64 (unless dryRun); file mode carries filePath.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', description: "Sanitized '/'-relative path." },
                    entryName: { type: 'string' },
                    index: { type: 'integer', minimum: 0 },
                    sizeBytes: { type: 'integer', minimum: 0 },
                    crc32: { type: 'string' },
                    method: { type: 'string' },
                    dataBase64: { type: 'string' },
                    filePath: { type: 'string' },
                },
            },
        },
        skipped: {
            type: 'array',
            description: 'Entries skipped because their name is unsafe (only with rejectTraversal:false).',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: { entryName: { type: 'string' }, reason: { type: 'string', enum: ['unsafe-path'] } },
            },
        },
        outputDir: { type: 'string', description: 'Absolute sandbox directory (file mode).' },
        directoriesCreated: { type: 'integer', minimum: 0 },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
    },
} as const;

type Input = z.infer<typeof InputSchema>;

function engineOptions(input: Input, sink: ReturnType<typeof createDiagnosticSink>, keep: (name: string, isDirectory: boolean) => boolean): ExtractOptions {
    const limits = resolveCallLimits(input.limits);
    return {
        rejectTraversal: input.rejectTraversal,
        rejectSymlinks: input.rejectSymlinks,
        onDuplicate: input.onDuplicate,
        filter: (entry: ZipEntry) => keep(entry.name, entry.isDirectory),
        ...(limits !== undefined ? { limits } : {}),
        ...sink.options,
    };
}

/** Entries the engine would skip silently under rejectTraversal:false — surfaced so the agent sees them. */
function collectSkipped(entries: readonly ZipEntry[], input: Input, keep: (name: string, isDirectory: boolean) => boolean): SkippedRow[] {
    if (input.rejectTraversal) return [];
    return entries
        .filter((e) => !e.isDirectory && keep(e.name, e.isDirectory) && sanitizeEntryPath(e.name) === null)
        .map((e) => ({ entryName: e.name, reason: 'unsafe-path' as const }));
}

export async function extractZipTool(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<ExtractZipResult> {
    const input = parseInput(InputSchema, rawInput);
    if (input.outputMode === 'file' && input.outputDir === undefined) {
        throw new ToolError('MISSING_OUTPUT_PATH', "outputDir is required when outputMode='file'.");
    }
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict, context);
    const keep = compileEntryFilter(input.filter);
    const options = engineOptions(input, sink, keep);

    // Index lookup + pre-flight over the plan. EAGER: every entry's real extent
    // (overlap, reach into the central directory, Zip64 spoofing) is refused
    // here, so the dry run is a genuine hostile-shape pre-check and never
    // returns a clean plan for an archive the extraction would refuse.
    const reader = guard('Failed to open archive', () => openZip(bytes, { validate: 'eager', ...(options.limits !== undefined ? { limits: options.limits } : {}), ...sink.options }));
    const all: ZipEntry[] = guard('Failed to read the central directory', () => [...reader.entries()]);
    // The engine's extractors open their own reader, so its ZipEntry objects are
    // not ours: key the central-directory position on (offset, name) instead.
    const indexKey = (e: ZipEntry): string => `${e.localHeaderOffset}\0${e.name}`;
    const indexOf = new Map<string, number>(all.map((e, i) => [indexKey(e), i]));
    const skipped = collectSkipped(all, input, keep);

    if (input.outputMode === 'base64') {
        // The plan (filter, sanitize, symlink policy, duplicates, budgets) runs on the
        // generator's first step; the entries are yielded without touching any payload.
        const planned: Array<{ path: string; entry: ZipEntry }> = [];
        const planGen = extractZipStream(bytes, { ...options, onDiagnostic: () => undefined });
        try {
            for (;;) {
                let step;
                try {
                    step = await planGen.next();
                } catch (err) {
                    throw mapZipError(err, 'Failed to plan extraction');
                }
                if (step.done) break;
                planned.push({ path: step.value.path, entry: step.value.entry });
            }
        } finally {
            await planGen.return();
        }
        let totalBytes = 0;
        for (const p of planned) {
            if (input.includeData && p.entry.uncompressedSize > MAX_ENTRY_INLINE_BYTES) {
                throw new ToolError('ENTRY_TOO_LARGE', `Entry "${p.entry.name}" is ${p.entry.uncompressedSize} bytes, above the ${MAX_ENTRY_INLINE_BYTES}-byte inline cap — use outputMode:'file', a filter, or read_zip_entry with a range.`, { entryName: p.entry.name, sizeBytes: p.entry.uncompressedSize, cap: MAX_ENTRY_INLINE_BYTES, remedy: "outputMode:'file'" });
            }
            totalBytes += p.entry.uncompressedSize;
        }
        if (input.includeData && totalBytes > MAX_EXTRACT_INLINE_TOTAL_BYTES) {
            throw new ToolError('OUTPUT_TOO_LARGE', `The selected entries total ${totalBytes} bytes, above the ${MAX_EXTRACT_INLINE_TOTAL_BYTES}-byte inline cap — use outputMode:'file' or a filter.`, { totalBytes, cap: MAX_EXTRACT_INLINE_TOTAL_BYTES, remedy: "outputMode:'file'" });
        }
        if (!input.includeData) {
            return {
                mode: 'base64',
                dryRun: true,
                fileCount: planned.length,
                totalBytes,
                entries: planned.map((p) => ({ path: p.path, entryName: p.entry.name, index: indexOf.get(indexKey(p.entry)) ?? -1, sizeBytes: p.entry.uncompressedSize, crc32: crcHex(p.entry.crc32), method: methodName(p.entry.compressionMethod) })),
                skipped,
                ...sink.report(),
            };
        }
        const extracted = guard('Failed to extract archive', () => extractZip(bytes, options));
        let actual = 0;
        const rows: ExtractedRow[] = extracted.map((x) => {
            actual += x.data.byteLength;
            return { path: x.path, entryName: x.entry.name, index: indexOf.get(indexKey(x.entry)) ?? -1, sizeBytes: x.data.byteLength, crc32: crcHex(x.entry.crc32), method: methodName(x.entry.compressionMethod), dataBase64: encodeBase64(x.data) };
        });
        return { mode: 'base64', dryRun: false, fileCount: rows.length, totalBytes: actual, entries: rows, skipped, ...sink.report() };
    }

    // ── file mode: streamed, exclusive, bounded ───────────────────────
    const outputDir = resolveOutputDir(input.outputDir, 'outputDir');
    await assertAncestorInside(outputDir, 'outputDir');
    await fs.mkdir(outputDir, { recursive: true });
    await assertRealpathInside(outputDir, 'outputDir');
    const rows: ExtractedRow[] = [];
    let totalBytes = 0;
    let written = 0;
    let directoriesCreated = 0;

    if (input.emptyDirectories) {
        for (const e of all) {
            if (!e.isDirectory) continue;
            const safe = sanitizeEntryPath(e.name.endsWith('/') ? e.name.slice(0, -1) : e.name);
            if (safe === null) continue;
            const dir = path.join(outputDir, ...safe.split('/'));
            await assertAncestorInside(dir, 'outputDir');
            await fs.mkdir(dir, { recursive: true });
            await assertRealpathInside(dir, 'outputDir');
            directoriesCreated++;
        }
    }

    const gen = extractZipStream(bytes, options);
    try {
        for (;;) {
            let next;
            try {
                next = await gen.next();
            } catch (err) {
                throw mapZipError(err, 'Failed to extract archive', undefined, { writtenCount: written });
            }
            if (next.done) break;
            const item = next.value;
            const target = path.join(outputDir, ...item.path.split('/'));
            const label = relativeLabel(target);
            await assertAncestorInside(path.dirname(target), 'outputDir');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await assertRealpathInside(path.dirname(target), 'outputDir');
            const stream = await openExclusiveWriteStream(target, label);
            let size = 0;
            try {
                for await (const chunk of item.stream()) {
                    size += chunk.byteLength;
                    totalBytes += chunk.byteLength;
                    if (totalBytes > getCeilings().maxFileOutputBytes) {
                        throw new ToolError('OUTPUT_TOO_LARGE', `Extraction exceeds the ${getCeilings().maxFileOutputBytes}-byte file-output cap (${MAX_FILE_OUTPUT_ENV}).`, { entryName: item.entry.name, writtenCount: written, env: MAX_FILE_OUTPUT_ENV });
                    }
                    if (!stream.write(chunk)) {
                        // Detach whichever listener did not fire: one pair per drain, never accumulated.
                        await new Promise<void>((resolveDrain, reject) => {
                            const onError = (err: Error): void => { stream.off('drain', onDrain); reject(err); };
                            const onDrain = (): void => { stream.off('error', onError); resolveDrain(); };
                            stream.once('drain', onDrain);
                            stream.once('error', onError);
                        });
                    }
                }
                await new Promise<void>((resolveEnd, reject) => {
                    stream.once('error', reject);
                    stream.end(() => resolveEnd());
                });
            } catch (err) {
                stream.destroy();
                await discardPartial(target);
                if (err instanceof ToolError) throw err;
                if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string' && !/^ZIP_/.test(String((err as NodeJS.ErrnoException).code))) {
                    throw mapWriteError(err, label);
                }
                throw mapZipError(err, `Failed to extract entry "${item.entry.name}"`, item.entry.name, { writtenCount: written });
            }
            written++;
            rows.push({ path: item.path, entryName: item.entry.name, index: indexOf.get(indexKey(item.entry)) ?? -1, sizeBytes: size, crc32: crcHex(item.entry.crc32), method: methodName(item.entry.compressionMethod), filePath: target });
        }
    } finally {
        await gen.return();
    }
    return {
        mode: 'file',
        dryRun: false,
        fileCount: rows.length,
        totalBytes,
        entries: rows,
        skipped,
        outputDir,
        directoriesCreated,
        ...sink.report(),
    };
}

export function extractSummary(r: ExtractZipResult): Record<string, unknown> {
    return {
        mode: r.mode,
        dryRun: r.dryRun,
        fileCount: r.fileCount,
        totalBytes: r.totalBytes,
        skippedCount: r.skipped.length,
        paths: r.entries.map((e) => e.path),
        ...(r.outputDir !== undefined ? { outputDir: r.outputDir } : {}),
        diagnosticCount: r.diagnostics.length,
    };
}

export const EXTRACT_ZIP_SUMMARY_PROPERTIES = {
    skippedCount: { type: 'integer', minimum: 0, description: 'summary only: number of skipped (unsafe-path) entries.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'summary only: the extracted paths.' },
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of distinct diagnostics.' },
} as const;
