/**
 * The archive input every archive-consuming tool shares: `zipBase64` XOR
 * `zipPath` (a relative path inside the sandbox). The base64 form is decoded
 * with agent-facing diagnostics; the path form is stat-checked against the
 * buffered cap before it is read, and can also be opened as a bounded-memory
 * `ByteSource` for the forward scanner.
 */
import { z } from 'zod';
import type { ByteSource } from 'zipnative';

import { decodeZipBase64 } from './base64.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_PATH_INPUT_BYTES } from './caps.js';
import { ToolError } from './errors.js';
import { openInputFile, readInputFile, ZIP_CONTAINER_EXTENSIONS } from './sandbox.js';

/** JSON Schema properties for the two archive inputs (spread into each tool's `properties`). */
export const ARCHIVE_INPUT_PROPERTIES = {
    zipBase64: {
        type: 'string',
        minLength: 4,
        description: 'The archive bytes as base64 (exactly once; a data: URI prefix is tolerated). Exclusive with zipPath. Decoded size ≤ 128 MiB.',
    },
    zipPath: {
        type: 'string',
        minLength: 1,
        description: "Relative path of an archive inside the ZIPNATIVE_MCP_OUTPUT_DIR sandbox (no absolute paths, no '..'; container extensions only: .zip .jar .docx .epub …). Exclusive with zipBase64. Lets a create/modify → verify/extract chain avoid re-sending the bytes.",
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
    const entries = o['entries'] ?? o['operations'];
    if (Array.isArray(entries)) {
        return entries.some((e) => e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>)['sourcePath'] === 'string');
    }
    return false;
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
