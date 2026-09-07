/**
 * Output emission for the archive-producing tools (`create_zip`, `modify_zip`,
 * `inflate_raw`): base64 inline (bounded) or an exclusive file write inside
 * the sandbox (streamed, bounded), plus the text writer the governance draft
 * uses. Mirrors pdfnative-mcp `src/output.ts`.
 */
import path from 'node:path';
import { z } from 'zod';

import { encodeBase64 } from './base64.js';
import { MAX_BASE64_OUTPUT_BYTES, MAX_FILE_OUTPUT_BYTES } from './caps.js';
import { ToolError } from './errors.js';
import {
    discardPartial,
    openExclusiveWriteStream,
    relativeLabel,
    resolveOutputFile,
    writeExclusive,
    ZIP_CONTAINER_EXTENSIONS,
} from './sandbox.js';

/** Output mode: either return the bytes as base64 in the response, or write to a sandboxed file. */
export type OutputMode = 'base64' | 'file';

export interface OutputResult {
    /** The output mode that was used. */
    mode: OutputMode;
    /** Number of bytes produced. */
    sizeBytes: number;
    /** Absolute file path (when `mode === 'file'`). */
    filePath?: string;
    /** Base64 bytes (when `mode === 'base64'`). */
    base64?: string;
    /** Tool-specific summary echoed into `structuredContent.summary`. */
    summary?: Readonly<Record<string, unknown>>;
    /** MIME type of the produced bytes (`application/zip` by default). */
    mimeType?: string;
}

/** JSON Schema properties for the two output inputs. */
export const OUTPUT_INPUT_PROPERTIES = {
    outputMode: {
        type: 'string',
        enum: ['base64', 'file'],
        default: 'base64',
        description: "'base64' (default) returns the bytes inline as an embedded resource (≤ 50 MiB). 'file' writes them inside ZIPNATIVE_MCP_OUTPUT_DIR (never overwrites; ≤ 4 GiB, streamed) and returns a resource_link.",
    },
    outputPath: {
        type: 'string',
        description: "Relative path inside the sandbox (only when outputMode='file'); must end in a container extension (.zip recommended).",
    },
} as const;

/** Produce the final tool output for in-memory bytes. */
export async function emitArchive(
    bytes: Uint8Array,
    options: { mode: OutputMode; outputPath?: string | undefined; extensions?: readonly string[]; mimeType?: string },
): Promise<OutputResult> {
    const mimeType = options.mimeType ?? 'application/zip';
    if (options.mode === 'file') {
        if (options.outputPath === undefined) {
            throw new ToolError('MISSING_OUTPUT_PATH', "outputPath is required when outputMode='file'.");
        }
        if (bytes.byteLength > MAX_FILE_OUTPUT_BYTES) {
            throw new ToolError('OUTPUT_TOO_LARGE', `Output (${bytes.byteLength} bytes) exceeds the ${MAX_FILE_OUTPUT_BYTES}-byte file cap.`);
        }
        const resolved = resolveOutputFile(options.outputPath, options.extensions ?? ZIP_CONTAINER_EXTENSIONS);
        await writeExclusive(resolved, bytes, relativeLabel(resolved));
        return { mode: 'file', sizeBytes: bytes.byteLength, filePath: resolved, mimeType };
    }
    if (bytes.byteLength > MAX_BASE64_OUTPUT_BYTES) {
        throw new ToolError(
            'OUTPUT_TOO_LARGE',
            `Output (${bytes.byteLength} bytes) exceeds the ${MAX_BASE64_OUTPUT_BYTES}-byte inline cap — use outputMode:'file' with ZIPNATIVE_MCP_OUTPUT_DIR set.`,
            { sizeBytes: bytes.byteLength, cap: MAX_BASE64_OUTPUT_BYTES, remedy: "outputMode:'file'" },
        );
    }
    return { mode: 'base64', sizeBytes: bytes.byteLength, base64: encodeBase64(bytes), mimeType };
}

/**
 * Stream chunks to an exclusive sandbox file with bounded memory, enforcing
 * the file cap while writing; a failure removes the partial file.
 */
export async function emitArchiveStream(
    chunks: AsyncIterable<Uint8Array>,
    outputPath: string | undefined,
    options: { extensions?: readonly string[]; mimeType?: string; hash?: 'sha256' | undefined } = {},
): Promise<OutputResult & { sha256?: string }> {
    if (outputPath === undefined) {
        throw new ToolError('MISSING_OUTPUT_PATH', "outputPath is required when outputMode='file'.");
    }
    const resolved = resolveOutputFile(outputPath, options.extensions ?? ZIP_CONTAINER_EXTENSIONS);
    const label = relativeLabel(resolved);
    const stream = await openExclusiveWriteStream(resolved, label);
    // Hash while streaming so `includeSha256` costs no second pass and no buffering.
    const hasher = options.hash === 'sha256' ? (await import('node:crypto')).createHash('sha256') : null;
    let total = 0;
    try {
        for await (const chunk of chunks) {
            total += chunk.byteLength;
            hasher?.update(chunk);
            if (total > MAX_FILE_OUTPUT_BYTES) {
                throw new ToolError('OUTPUT_TOO_LARGE', `Output exceeds the ${MAX_FILE_OUTPUT_BYTES}-byte file cap.`);
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
        await discardPartial(resolved);
        throw err;
    }
    return {
        mode: 'file',
        sizeBytes: total,
        filePath: resolved,
        mimeType: options.mimeType ?? 'application/zip',
        ...(hasher !== null ? { sha256: hasher.digest('hex') } : {}),
    };
}

/** Zod twin of {@link OUTPUT_INPUT_PROPERTIES} (spread into the archive-producing tools). */
export const OutputShape = {
    outputMode: z.enum(['base64', 'file']).default('base64'),
    outputPath: z.string().optional(),
};

/**
 * Writes a UTF-8 text artifact (a Markdown governance draft) to a sandboxed
 * path with the same guards as archive output; `wx` never clobbers.
 */
export async function writeSandboxedText(text: string, outputPath: string, extension = '.md'): Promise<{ filePath: string; sizeBytes: number }> {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > MAX_BASE64_OUTPUT_BYTES) {
        throw new ToolError('OUTPUT_TOO_LARGE', `The text artifact (${bytes.byteLength} bytes) exceeds the maximum allowed size (${MAX_BASE64_OUTPUT_BYTES} bytes).`);
    }
    const resolved = resolveOutputFile(outputPath, [extension]);
    await writeExclusive(resolved, bytes, relativeLabel(resolved));
    return { filePath: resolved, sizeBytes: bytes.byteLength };
}

/** Basename helper for messages. */
export function displayName(filePath: string): string {
    return path.basename(filePath);
}
