/**
 * The archive input every archive-consuming tool shares: `zipBase64` XOR
 * `zipPath` (a relative path inside the sandbox). The base64 form is decoded
 * with agent-facing diagnostics; the path form is stat-checked against the
 * buffered cap before it is read, and can also be opened as a bounded-memory
 * `ByteSource` for the forward scanner.
 */
import { z } from 'zod';
import {
    openZip,
    openZipRange,
    rangeSourceFromBytes,
    type ByteRangeSource,
    type ByteSource,
    type EntryVerification,
    type OpenZipOptions,
    type ReadEntryOptions,
    type ZipEntry,
    type ZipRangeReader,
    type ZipReader,
} from 'zipnative';

import { decodeZipBase64 } from './base64.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_PATH_INPUT_BYTES } from './caps.js';
import { ToolError } from './errors.js';
import { openInputFile, readInputFile, ZIP_CONTAINER_EXTENSIONS } from './sandbox.js';
import { guard, guardAsync } from './zip-errors.js';

/** JSON Schema properties for the two archive inputs (spread into each tool's `properties`). */
export const ARCHIVE_INPUT_PROPERTIES = {
    zipBase64: {
        type: 'string',
        minLength: 4,
        description: 'Archive bytes, base64 (≤ 128 MiB decoded). Exclusive with zipPath.',
    },
    zipPath: {
        type: 'string',
        minLength: 1,
        description: "Archive path relative to the ZIPNATIVE_MCP_OUTPUT_DIR sandbox (container extensions: .zip .jar .docx .epub …). Exclusive with zipBase64; saves re-sending bytes between calls.",
    },
} as const;

/** Zod shape for the two inputs (compose with `.strictObject({...ARCHIVE_INPUT_SHAPE, ...})` and call {@link refineArchiveInput}). */
export const ARCHIVE_INPUT_SHAPE = {
    zipBase64: z.string().min(4).optional(),
    zipPath: z.string().min(1).optional(),
};

export interface ArchiveInputFields {
    readonly zipBase64?: string | undefined;
    readonly zipPath?: string | undefined;
}

/** Enforce the XOR at the Zod boundary. Use inside `.superRefine`. */
export function refineArchiveInput(value: ArchiveInputFields, ctx: z.RefinementCtx): void {
    const has = (value.zipBase64 !== undefined ? 1 : 0) + (value.zipPath !== undefined ? 1 : 0);
    if (has !== 1) {
        ctx.addIssue({ code: 'custom', message: 'pass exactly one of zipBase64 / zipPath', path: ['zipBase64'] });
    }
}

export interface LoadedArchive {
    readonly bytes: Uint8Array;
    readonly source: 'base64' | 'path';
    /** The relative path (path input) — never absolute, safe to echo. */
    readonly label: string;
}

/** True when the call references sandbox files (never cached: a path is a reference, not content). */
export function isPathInput(input: unknown): boolean {
    if (input === null || typeof input !== 'object') return false;
    const o = input as Record<string, unknown>;
    if (typeof o['zipPath'] === 'string' || typeof o['sourcePath'] === 'string') return true;
    // create_zip entries / modify_zip operations name sourcePath; merge_zip sources name zipPath.
    const nested = [o['entries'], o['operations'], o['sources']].filter(Array.isArray) as unknown[][];
    return nested.some((list) => list.some((e) => e !== null && typeof e === 'object' && (typeof (e as Record<string, unknown>)['sourcePath'] === 'string' || typeof (e as Record<string, unknown>)['zipPath'] === 'string')));
}

/** Load the whole archive into memory (buffered tools). */
export async function loadArchive(input: ArchiveInputFields): Promise<LoadedArchive> {
    if (input.zipBase64 !== undefined) {
        const bytes = decodeZipBase64(input.zipBase64);
        assertInputWithin(bytes.byteLength, MAX_BASE64_INPUT_BYTES, 'zipBase64 (decoded)');
        return { bytes, source: 'base64', label: 'zipBase64' };
    }
    if (input.zipPath === undefined) {
        throw new ToolError('VALIDATION_ERROR', 'pass exactly one of zipBase64 / zipPath');
    }
    const zipPath = input.zipPath;
    const { bytes } = await readInputFile(zipPath, ZIP_CONTAINER_EXTENSIONS, 'zipPath', (size) => assertInputWithin(size, MAX_PATH_INPUT_BYTES, `zipPath '${zipPath}'`));
    return { bytes, source: 'path', label: zipPath };
}

/** Chunk an in-memory buffer as an async iterable (what a pipe would deliver). */
export async function* chunked(bytes: Uint8Array, chunkSize = 64 * 1024): AsyncGenerator<Uint8Array, void, undefined> {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    }
}

/**
 * Open the archive as a `ByteSource` for the forward scanner: base64 input is
 * chunked from memory; a path is streamed from disk with no size cap (the
 * scanner never buffers the file).
 */
export async function openArchiveSource(input: ArchiveInputFields): Promise<{ source: ByteSource; label: string; sizeBytes: number | null }> {
    if (input.zipBase64 !== undefined) {
        const bytes = decodeZipBase64(input.zipBase64);
        assertInputWithin(bytes.byteLength, MAX_BASE64_INPUT_BYTES, 'zipBase64 (decoded)');
        return { source: chunked(bytes), label: 'zipBase64', sizeBytes: bytes.byteLength };
    }
    if (input.zipPath === undefined) {
        throw new ToolError('VALIDATION_ERROR', 'pass exactly one of zipBase64 / zipPath');
    }
    // One handle from the open to the last byte; the stream closes it when it ends or is abandoned.
    const file = await openInputFile(input.zipPath, ZIP_CONTAINER_EXTENSIONS, 'zipPath');
    return { source: file.chunks(64 * 1024), label: input.zipPath, sizeBytes: file.size };
}

// ── Random access: in memory, or by byte ranges (zipnative 1.1.0) ────────

/** How the random-access read tools reach the archive. */
export type ArchiveAccess = 'auto' | 'memory' | 'range';

/** JSON Schema of the `access` input shared by inspect_zip, list_zip_entries and read_zip_entry. */
export const ACCESS_INPUT_PROPERTY = {
    access: {
        type: 'string',
        enum: ['auto', 'memory', 'range'],
        default: 'auto',
        description: `'auto' (default): in memory, and a zipPath above ${MAX_PATH_INPUT_BYTES} bytes by byte ranges. 'range': always by byte ranges over the sandbox file (never a URL; memory ≈ the central directory). 'memory': always buffered (INPUT_TOO_LARGE above the cap).`,
    },
} as const;

/** Zod twin of {@link ACCESS_INPUT_PROPERTY}. */
export const AccessShape = { access: z.enum(['auto', 'memory', 'range']).default('auto') };

/**
 * One opened archive, whichever way it was reached: the `ZipReader` surface
 * the read tools need, asynchronous so the in-memory reader and the
 * byte-range reader answer the same calls. `bytes` is present in memory mode
 * only (the operations that need the whole archive — analyzeDeterminism,
 * verifyZip, extraction — stay in memory).
 */
export interface ArchiveHandle {
    readonly access: 'memory' | 'range';
    readonly size: number;
    readonly bytes: Uint8Array | null;
    readonly entryCount: number;
    readonly comment: Uint8Array;
    readonly isZip64: boolean;
    entries(): ZipEntry[];
    getEntry(name: string): ZipEntry | null;
    readEntry(entry: ZipEntry, options?: ReadEntryOptions): Promise<Uint8Array>;
    readEntryRaw(entry: ZipEntry): Promise<Uint8Array>;
    readEntryStream(entry: ZipEntry, options?: ReadEntryOptions): AsyncGenerator<Uint8Array, void, undefined>;
    verifyEntry(entry: ZipEntry): Promise<EntryVerification>;
    close(): Promise<void>;
}

function memoryHandle(bytes: Uint8Array, reader: ZipReader): ArchiveHandle {
    return {
        access: 'memory',
        size: bytes.byteLength,
        bytes,
        entryCount: reader.entryCount,
        comment: reader.comment,
        isZip64: reader.isZip64,
        entries: () => [...reader.entries()],
        getEntry: (name) => reader.getEntry(name),
        readEntry: async (entry, options) => reader.readEntry(entry, options),
        readEntryRaw: async (entry) => reader.readEntryRaw(entry),
        readEntryStream: (entry, options) => reader.readEntryStream(entry, options),
        verifyEntry: async (entry) => reader.verifyEntry(entry),
        close: async () => undefined,
    };
}

function rangeHandle(reader: ZipRangeReader, close: () => Promise<void>): ArchiveHandle {
    return {
        access: 'range',
        size: reader.size,
        bytes: null,
        entryCount: reader.entryCount,
        comment: reader.comment,
        isZip64: reader.isZip64,
        entries: () => [...reader.entries()],
        getEntry: (name) => reader.getEntry(name),
        readEntry: (entry, options) => reader.readEntry(entry, options),
        readEntryRaw: (entry) => reader.readEntryRaw(entry),
        readEntryStream: (entry, options) => reader.readEntryStream(entry, options),
        verifyEntry: (entry) => reader.verifyEntry(entry),
        close,
    };
}

/**
 * Open an archive for random access. Inline bytes are opened in memory (or,
 * with `access: 'range'`, through `rangeSourceFromBytes` — the same reader a
 * huge file gets, on bytes already here). A `zipPath` is read into memory up
 * to the 1 GiB cap; above it (`'auto'`) or always (`'range'`) the sandbox
 * file's single handle becomes the engine's `ByteRangeSource`: every limit
 * and cross-check of `openZip` applies, a source that delivers fewer bytes
 * than asked is `ZIP_RECORD_TRUNCATED`. There is no URL form and no network:
 * the source is a local file the operator placed in the sandbox. The caller
 * closes the handle.
 */
export async function openArchive(input: ArchiveInputFields, access: ArchiveAccess, options: OpenZipOptions): Promise<ArchiveHandle> {
    if (input.zipBase64 !== undefined) {
        const bytes = decodeZipBase64(input.zipBase64);
        assertInputWithin(bytes.byteLength, MAX_BASE64_INPUT_BYTES, 'zipBase64 (decoded)');
        if (access === 'range') {
            const reader = await guardAsync('Failed to open archive', () => openZipRange(rangeSourceFromBytes(bytes), options));
            return rangeHandle(reader, async () => undefined);
        }
        return memoryHandle(bytes, guard('Failed to open archive', () => openZip(bytes, options)));
    }
    if (input.zipPath === undefined) {
        throw new ToolError('VALIDATION_ERROR', 'pass exactly one of zipBase64 / zipPath');
    }
    const zipPath = input.zipPath;
    const file = await openInputFile(zipPath, ZIP_CONTAINER_EXTENSIONS, 'zipPath');
    const byRange = access === 'range' || (access === 'auto' && file.size > MAX_PATH_INPUT_BYTES);
    if (!byRange) {
        try {
            assertInputWithin(file.size, MAX_PATH_INPUT_BYTES, `zipPath '${zipPath}'`);
            const bytes = await file.read(0, file.size + 1);
            if (bytes.byteLength !== file.size) {
                throw new ToolError('IO_ERROR', `zipPath '${zipPath}' changed while it was being read (${bytes.byteLength > file.size ? 'grew' : 'shrank'}) — retry once the file is complete.`, { remedy: 'retry' });
            }
            return memoryHandle(bytes, guard('Failed to open archive', () => openZip(bytes, options)));
        } finally {
            await file.close();
        }
    }
    const source: ByteRangeSource = { size: file.size, read: (offset, length) => file.read(offset, length) };
    try {
        const reader = await guardAsync('Failed to open archive', () => openZipRange(source, options));
        return rangeHandle(reader, () => file.close());
    } catch (err) {
        await file.close();
        throw err;
    }
}
