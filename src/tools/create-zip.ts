/**
 * Tool: create_zip — deterministic archive creation through `createZip`
 * (or the worker-pool `createParallelZip` when `parallel` is given; the two
 * are byte-identical per tier). Every option of the engine's writer is
 * reachable: canonical / insertion order, pinned or wall-clock default date,
 * archive and per-entry compression (store / deflate, level, the pure-TS
 * `deterministic` pin), archive and entry comments, external attributes or a
 * Unix mode, raw extra fields, explicit directories, and streamed sources
 * (`stream: true` on a sandbox file → `addStream`, the data-descriptor
 * layout). base64 mode assembles with `toBytes()`; file mode streams the
 * archive to disk with `stream({ chunkSize })` and bounded memory.
 */
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { activeDeflateTier, createZip, type AddEntryOptions, type CreateZipOptions } from 'zipnative';

import { assertInputWithin, getCeilings, MAX_BASE64_INPUT_BYTES, MAX_CREATE_ENTRIES, WORKERS_ENV } from '../caps.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticsReport } from '../diagnostics.js';
import { ensureEngineReady, probeRuntime } from '../engine.js';
import {
    COMPRESSION_INPUT_SCHEMA,
    CompressionSchema,
    DEFAULT_DATE_PATTERN,
    DEFAULT_DATE_SCHEMA,
    ENTRY_PAYLOAD_PROPERTIES,
    EntryPayloadShape,
    loadPayload,
    refineEntryPayload,
    toAddEntryOptions,
    toCompression,
    toDefaultDate,
    type EntryPayload,
} from '../entry-spec.js';
import { ToolError } from '../errors.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { emitArchive, emitArchiveStream, OUTPUT_INPUT_PROPERTIES, OutputShape, type OutputResult } from '../output.js';
import { resolveInputFile } from '../sandbox.js';
import { guard, guardAsync } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, sha256Hex, STRICT_INPUT_PROPERTY } from './_shared.js';

export const CREATE_ZIP_NAME = 'create_zip';

const U16 = 65_535;

export const CREATE_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['entries'],
    properties: {
        entries: {
            type: 'array',
            maxItems: MAX_CREATE_ENTRIES,
            description: `The entries to write (0–${MAX_CREATE_ENTRIES}; an empty array writes a valid empty archive). Each takes exactly one of dataBase64 / text / sourcePath, or directory: true.`,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    ...ENTRY_PAYLOAD_PROPERTIES,
                    stream: { type: 'boolean', default: false, description: 'With sourcePath: feed the file through addStream (bounded memory, data-descriptor layout; entries > 4 GiB refused). The archive is then assembled by streaming.' },
                },
            },
        },
        order: { type: 'string', enum: ['canonical', 'insertion'], default: 'canonical', description: "'canonical' (default): entries sorted by raw UTF-8 name bytes (reproducible). 'insertion': call order preserved (EPUB / JAR mimetype-first layouts)." },
        defaultDate: DEFAULT_DATE_SCHEMA,
        compression: COMPRESSION_INPUT_SCHEMA,
        comment: { type: 'string', maxLength: U16, description: 'Archive comment (UTF-8, ≤ 65535 bytes).' },
        chunkSize: { type: 'integer', minimum: 1024, maximum: 16_777_216, description: 'file mode: output chunk size for the streaming assembler (default 64 KiB). Never changes the bytes.' },
        parallel: {
            type: 'object',
            additionalProperties: false,
            description: 'Compress with the worker pool (zipnative/worker). Byte-identical to the sequential writer; only worth it for many large entries. `workers` 0 keeps everything on the calling thread.',
            properties: {
                workers: { type: 'integer', minimum: 0, maximum: 64, description: 'Worker count (default max(1, min(cores − 1, 8)); capped by ZIPNATIVE_MCP_WORKERS).' },
                minWorkerJobSize: { type: 'integer', minimum: 1, description: 'Entries below this size compress inline (default 32 KiB).' },
                jobTimeout: { type: 'integer', minimum: 1000, maximum: 600_000, description: 'Per-job cap in ms before inline fallback (default 60000).' },
            },
        },
        includeSha256: { type: 'boolean', default: false, description: 'Add `summary.sha256` of the produced bytes (determinism proofs).' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...OUTPUT_INPUT_PROPERTIES,
    },
} as const;

const EntrySchema = z
    .strictObject({ ...EntryPayloadShape, stream: z.boolean().default(false) })
    .superRefine((v, ctx) => {
        refineEntryPayload(v, ctx);
        if (v.stream && v.sourcePath === undefined) ctx.addIssue({ code: 'custom', message: 'stream: true requires sourcePath', path: ['stream'] });
    });

const InputSchema = z
    .strictObject({
        entries: z.array(EntrySchema).max(MAX_CREATE_ENTRIES),
        order: z.enum(['canonical', 'insertion']).default('canonical'),
        defaultDate: z.string().regex(new RegExp(DEFAULT_DATE_PATTERN)).optional(),
        compression: CompressionSchema.optional(),
        comment: z.string().max(U16).optional(),
        chunkSize: z.number().int().min(1024).max(16_777_216).optional(),
        parallel: z
            .strictObject({
                workers: z.number().int().min(0).max(64).optional(),
                minWorkerJobSize: z.number().int().min(1).optional(),
                jobTimeout: z.number().int().min(1000).max(600_000).optional(),
            })
            .optional(),
        includeSha256: z.boolean().default(false),
        ...EngineOptionsShape,
        ...OutputShape,
    })
    .superRefine((v, ctx) => {
        const names = new Set<string>();
        v.entries.forEach((e, i) => {
            const key = e.directory && !e.name.endsWith('/') ? `${e.name}/` : e.name;
            if (names.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate entry name '${e.name}'`, path: ['entries', i, 'name'] });
            names.add(key);
        });
    });

export interface CreateZipSummary {
    readonly entryCount: number;
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly streamedCount: number;
    readonly uncompressedBytes: number;
    readonly order: 'canonical' | 'insertion';
    readonly deterministic: boolean;
    readonly deflateTier: string;
    readonly parallel: { readonly requested: boolean; readonly workers: number };
    readonly sha256?: string;
}

export type CreateZipResult = OutputResult & DiagnosticsReport & { readonly summary: CreateZipSummary };

export const ARCHIVE_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'sizeBytes', 'summary', 'diagnostics'],
    description: 'Result of an archive-producing tool. base64 mode: the archive arrives as an embedded `resource` content block (not duplicated here); file mode: `filePath` + a resource_link.',
    properties: {
        mode: { type: 'string', enum: ['base64', 'file'] },
        sizeBytes: { type: 'integer', minimum: 0 },
        filePath: { type: 'string', description: 'Sandboxed absolute path (file mode).' },
        summary: { type: 'object', description: 'Tool-specific summary.', additionalProperties: true },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
    },
} as const;

/** The shared archive result with a typed `summary` (every key optional; the base stays the contract). */
export function archiveOutputSchemaWith(summaryProperties: Readonly<Record<string, unknown>>, description: string): Record<string, unknown> {
    return {
        ...ARCHIVE_OUTPUT_SCHEMA,
        properties: {
            ...ARCHIVE_OUTPUT_SCHEMA.properties,
            summary: { type: 'object', additionalProperties: false, description, properties: summaryProperties },
        },
    };
}

export const CREATE_ZIP_OUTPUT_SCHEMA = archiveOutputSchemaWith(
    {
        entryCount: { type: 'integer', minimum: 0 },
        fileCount: { type: 'integer', minimum: 0 },
        directoryCount: { type: 'integer', minimum: 0 },
        streamedCount: { type: 'integer', minimum: 0, description: 'Entries fed through addStream (stream:true).' },
        uncompressedBytes: { type: 'integer', minimum: 0 },
        order: { type: 'string', enum: ['canonical', 'insertion'] },
        deterministic: { type: 'boolean', description: 'true only when compression.deterministic:true pins every entry and no wall-clock date is used (cross-runtime identity).' },
        deflateTier: { type: 'string', description: "The engine deflate tier in use ('node-zlib', 'pure-pinned', 'pure', 'injected')." },
        parallel: { type: 'object', additionalProperties: false, properties: { requested: { type: 'boolean' }, workers: { type: 'integer', minimum: 0 } } },
        sha256: { type: 'string', description: 'Present with includeSha256 (base64 and file modes).' },
    },
    'create_zip summary.',
);


async function* fileChunks(absPath: string): AsyncGenerator<Uint8Array, void, undefined> {
    for await (const chunk of createReadStream(absPath, { highWaterMark: 64 * 1024 })) {
        const buf = chunk as Buffer;
        yield new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
}

export async function createZipTool(rawInput: unknown): Promise<CreateZipResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const sink = createDiagnosticSink(input.strict);
    const limits = resolveCallLimits(input.limits);
    const defaultDate = toDefaultDate(input.defaultDate);
    const compression = toCompression(input.compression);
    const options: CreateZipOptions = {
        order: input.order,
        ...(defaultDate !== undefined ? { defaultDate } : {}),
        ...(compression !== undefined ? { compression } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...sink.options,
    };

    let workers = 0;
    const parallelRequested = input.parallel !== undefined;
    if (input.parallel !== undefined) {
        const ceiling = getCeilings().maxWorkers;
        const requested = input.parallel.workers;
        if (requested !== undefined && requested > ceiling) {
            throw new ToolError('LIMIT_CEILING_EXCEEDED', `parallel.workers ${requested} exceeds the operator ceiling ${ceiling} (${WORKERS_ENV}).`, { limit: 'workers', requested, ceiling, env: WORKERS_ENV });
        }
        // The engine default is max(1, min(cores − 1, 8)); the operator ceiling bounds it.
        workers = requested ?? Math.min(ceiling, (await probeRuntime()).defaultWorkers);
    }

    // Build the writer (sequential or parallel — same add/addDirectory/addStream surface).
    let writer: { add(n: string, d: Uint8Array | string, o?: AddEntryOptions): void; addDirectory(n: string, o?: AddEntryOptions): void; addStream(n: string, s: AsyncIterable<Uint8Array>, o?: AddEntryOptions): void; setComment(c: string): void; toBytes(): Uint8Array | Promise<Uint8Array>; stream(o?: { chunkSize?: number }): AsyncGenerator<Uint8Array, void, undefined> };
    if (parallelRequested) {
        const { createParallelZip } = await import('zipnative/worker');
        writer = guard('Failed to create the parallel writer', () => createParallelZip({
            ...options,
            workers,
            ...(input.parallel?.minWorkerJobSize !== undefined ? { minWorkerJobSize: input.parallel.minWorkerJobSize } : {}),
            ...(input.parallel?.jobTimeout !== undefined ? { jobTimeout: input.parallel.jobTimeout } : {}),
        }));
    } else {
        writer = guard('Failed to create the writer', () => createZip(options));
    }

    let fileCount = 0;
    let directoryCount = 0;
    let streamedCount = 0;
    let uncompressedBytes = 0;
    let inlineBytes = 0;
    let anyNonDeterministic = compression?.deterministic !== true;

    for (let i = 0; i < input.entries.length; i++) {
        const spec = input.entries[i] as EntryPayload & { stream: boolean };
        const where = `entries[${i}]`;
        const entryOptions = toAddEntryOptions(spec, where);
        if (spec.compression?.deterministic === false || (spec.compression !== undefined && spec.compression.deterministic === undefined && compression?.deterministic !== true)) {
            anyNonDeterministic = true;
        }
        if (spec.directory) {
            directoryCount++;
            guard(`Failed to add directory '${spec.name}'`, () => writer.addDirectory(spec.name, entryOptions), spec.name, { entryIndex: i });
            continue;
        }
        fileCount++;
        if (spec.stream && spec.sourcePath !== undefined) {
            const { resolved, size } = await resolveInputFile(spec.sourcePath, null, `${where}.sourcePath`);
            streamedCount++;
            uncompressedBytes += size;
            guard(`Failed to add streamed entry '${spec.name}'`, () => writer.addStream(spec.name, fileChunks(resolved), entryOptions), spec.name, { entryIndex: i });
            continue;
        }
        const { data } = await loadPayload(spec, where);
        if (spec.sourcePath === undefined) {
            inlineBytes += data.byteLength;
            assertInputWithin(inlineBytes, MAX_BASE64_INPUT_BYTES, 'inline entry payloads (total)');
        }
        uncompressedBytes += data.byteLength;
        guard(`Failed to add entry '${spec.name}'`, () => writer.add(spec.name, data, entryOptions), spec.name, { entryIndex: i });
    }

    const deterministic = !anyNonDeterministic && defaultDate !== 'now';
    const deflateTier = activeDeflateTier(compression?.deterministic === true);
    const summaryBase = {
        entryCount: fileCount + directoryCount,
        fileCount,
        directoryCount,
        streamedCount,
        uncompressedBytes,
        order: input.order,
        deterministic,
        deflateTier,
        parallel: { requested: parallelRequested, workers },
    };

    if (input.outputMode === 'file') {
        const out = await emitArchiveStream(
            guard('Failed to assemble archive', () => writer.stream(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : undefined)),
            input.outputPath,
            { hash: input.includeSha256 ? 'sha256' : undefined },
        );
        return { ...out, summary: { ...summaryBase, ...(out.sha256 !== undefined ? { sha256: out.sha256 } : {}) }, ...sink.report() };
    }
    let bytes: Uint8Array;
    if (streamedCount > 0) {
        // addStream makes toBytes() unavailable: collect the streamed assembly.
        const parts: Uint8Array[] = [];
        await guardAsync('Failed to assemble archive', async () => {
            for await (const chunk of writer.stream(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : undefined)) parts.push(chunk);
        });
        bytes = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    } else {
        bytes = await guardAsync('Failed to assemble archive', async () => writer.toBytes());
    }
    const out = await emitArchive(bytes, { mode: 'base64' });
    const sha256 = input.includeSha256 ? await sha256Hex(bytes) : undefined;
    return { ...out, summary: { ...summaryBase, ...(sha256 !== undefined ? { sha256 } : {}) }, ...sink.report() };
}
