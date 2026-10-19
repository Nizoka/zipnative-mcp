/**
 * Tool: inflate_raw — decompress a raw DEFLATE (RFC 1951) stream with a
 * MANDATORY output bound, through zipnative's resumable `createInflator`
 * fed chunk by chunk: constant memory, exact `bytesConsumed`, and the
 * trailing bytes after the stream reported as `leftover` (a warning unless
 * `allowTrailing`). `method: 'store'` is a bounded pass-through; a numeric
 * method id selects a registered codec's synchronous decompressor (none are
 * registered by this server, so only 0 and 8 succeed). Mirrors
 * `zipnative inflate`.
 */
import { z } from 'zod';
import { createInflator, getCodec, METHOD_DEFLATE, METHOD_STORE } from 'zipnative';

import { decodeBase64Field } from '../base64.js';
import { NO_CONTEXT, throwIfCancelled, type CallContext } from '../call-context.js';
import { assertInputWithin, getCeilings, MAX_BASE64_INPUT_BYTES, MAX_BASE64_OUTPUT_BYTES, MAX_FILE_OUTPUT_BYTES, MAX_PATH_INPUT_BYTES } from '../caps.js';
import { ensureEngineReady } from '../engine.js';
import { ToolError } from '../errors.js';
import { emitArchive, OUTPUT_INPUT_PROPERTIES, OutputShape, type OutputResult } from '../output.js';
import { openInputFile } from '../sandbox.js';
import { guard } from '../zip-errors.js';
import { parseInput } from './_shared.js';
import { archiveOutputSchemaWith } from './create-zip.js';

export const INFLATE_RAW_NAME = 'inflate_raw';

export const INFLATE_RAW_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['maxOutput'],
    properties: {
        dataBase64: { type: 'string', description: 'The compressed stream as base64 (e.g. the payload from read_zip_entry mode:"raw"). Exclusive with sourcePath.' },
        sourcePath: { type: 'string', minLength: 1, description: 'Relative path of a file inside the sandbox holding the compressed stream (streamed). Exclusive with dataBase64.' },
        maxOutput: { type: 'integer', minimum: 1, description: `Mandatory output bound in bytes: decompression stops with ZIP_INFLATE_OUTPUT_OVERFLOW beyond it (zip-bomb guard). Inline results are further capped at ${MAX_BASE64_OUTPUT_BYTES} bytes, file results at the file cap (ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES, default ${MAX_FILE_OUTPUT_BYTES}).` },
        method: { type: 'string', pattern: '^(?:deflate|store|[0-9]+)$', default: 'deflate', description: "'deflate' (default, method 8), 'store' (method 0, bounded pass-through) or a numeric method id for a registered codec." },
        allowTrailing: { type: 'boolean', default: false, description: 'Accept bytes after the end of the deflate stream silently (they are always reported as `leftover`).' },
        ...OUTPUT_INPUT_PROPERTIES,
        outputPath: {
            ...OUTPUT_INPUT_PROPERTIES.outputPath,
            description: "Relative path inside the sandbox (only when outputMode='file'); the inflated bytes are raw data, so it must end in .bin, .dat, .raw, .txt, .json, .xml, .md, .csv, .html, .tar or .zip.",
        },
    },
} as const;

const InputSchema = z
    .strictObject({
        dataBase64: z.string().optional(),
        sourcePath: z.string().min(1).optional(),
        maxOutput: z.number().int().min(1),
        method: z.string().regex(/^(?:deflate|store|[0-9]+)$/).default('deflate'),
        allowTrailing: z.boolean().default(false),
        ...OutputShape,
    })
    .superRefine((v, ctx) => {
        const n = (v.dataBase64 !== undefined ? 1 : 0) + (v.sourcePath !== undefined ? 1 : 0);
        if (n !== 1) ctx.addIssue({ code: 'custom', message: 'pass exactly one of dataBase64 / sourcePath', path: ['dataBase64'] });
    });

export const INFLATE_RAW_OUTPUT_SCHEMA = archiveOutputSchemaWith(
    {
        method: { type: 'integer', minimum: 0 },
        methodName: { type: 'string' },
        bytesIn: { type: 'integer', minimum: 0 },
        bytesOut: { type: 'integer', minimum: 0 },
        bytesConsumed: { type: 'integer', minimum: 0, description: 'Compressed bytes the deflate stream consumed (excludes leftover).' },
        leftover: { type: 'integer', minimum: 0, description: 'Trailing bytes after the end of the stream.' },
        finished: { type: 'boolean' },
        maxOutput: { type: 'integer', minimum: 1, description: 'The effective output bound (maxOutput capped by the inline / file cap).' },
        trailingWarning: { type: 'string' },
    },
    'inflate_raw summary (the produced bytes are application/octet-stream, not an archive).',
);

export interface InflateRawSummary {
    readonly method: number;
    readonly methodName: string;
    readonly bytesIn: number;
    readonly bytesOut: number;
    readonly bytesConsumed: number;
    readonly leftover: number;
    readonly finished: boolean;
    readonly maxOutput: number;
    readonly trailingWarning?: string;
}

export type InflateRawResult = OutputResult & { readonly summary: InflateRawSummary; readonly diagnostics: readonly never[] };

async function* inputChunks(input: z.infer<typeof InputSchema>): AsyncGenerator<Uint8Array, void, undefined> {
    if (input.dataBase64 !== undefined) {
        const bytes = input.dataBase64 === '' ? new Uint8Array(0) : decodeBase64Field(input.dataBase64, 'dataBase64');
        assertInputWithin(bytes.byteLength, MAX_BASE64_INPUT_BYTES, 'dataBase64 (decoded)');
        for (let o = 0; o < bytes.byteLength; o += 65_536) yield bytes.subarray(o, Math.min(bytes.byteLength, o + 65_536));
        return;
    }
    const file = await openInputFile(input.sourcePath, null, 'sourcePath');
    try {
        assertInputWithin(file.size, MAX_PATH_INPUT_BYTES, 'sourcePath');
    } catch (err) {
        await file.close();
        throw err;
    }
    yield* file.chunks(65_536);
}

export async function inflateRaw(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<InflateRawResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const method = input.method === 'deflate' ? METHOD_DEFLATE : input.method === 'store' ? METHOD_STORE : Number(input.method);
    const cap = input.outputMode === 'file' ? getCeilings().maxFileOutputBytes : MAX_BASE64_OUTPUT_BYTES;
    const bound = Math.min(input.maxOutput, cap);

    let bytesIn = 0;
    let bytesOut = 0;
    let leftover = 0;
    let bytesConsumed = 0;
    let finished = false;
    const parts: Uint8Array[] = [];
    // A-003: cancellation between 64 KiB input chunks, progress as bytes in / out.
    const tick = (): void => {
        throwIfCancelled(context);
        context.onProgress?.({ entriesDone: 0, entriesTotal: null, bytesIn, bytesOut });
    };

    if (method === METHOD_DEFLATE) {
        const inflator = guard('Failed to create the inflater', () => createInflator(bound));
        for await (const chunk of inputChunks(input)) {
            tick();
            bytesIn += chunk.byteLength;
            if (inflator.finished) {
                leftover += chunk.byteLength;
                continue;
            }
            const pieces = guard('Failed to inflate', () => inflator.push(chunk));
            for (const piece of pieces) {
                bytesOut += piece.byteLength;
                parts.push(piece);
            }
            if (inflator.finished) leftover += inflator.leftover.length;
        }
        guard('Failed to inflate', () => inflator.end());
        bytesConsumed = inflator.bytesConsumed;
        finished = inflator.finished;
    } else {
        const collected: Uint8Array[] = [];
        for await (const chunk of inputChunks(input)) {
            tick();
            bytesIn += chunk.byteLength;
            collected.push(chunk);
        }
        const buffer = Buffer.concat(collected.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
        const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        if (method === METHOD_STORE) {
            if (data.byteLength > bound) {
                throw new ToolError('ZIP_INFLATE_OUTPUT_OVERFLOW', `Input (${data.byteLength} bytes) exceeds maxOutput (${bound}).`, { errorClass: 'data', observed: data.byteLength, configured: bound });
            }
            parts.push(data);
            bytesOut = data.byteLength;
        } else {
            const codec = getCodec(method);
            if (codec === null) {
                throw new ToolError('ZIP_UNSUPPORTED_METHOD', `No codec is registered for method ${method} (this server registers none beyond store and deflate).`, { errorClass: 'unsupported', feature: `method:${method}` });
            }
            if (codec.decompressSync === undefined) {
                throw new ToolError('ZIP_UNSUPPORTED_CODEC_MODE', `Codec '${codec.name}' (method ${method}) has no synchronous decompressor.`, { errorClass: 'unsupported', feature: `method:${method}` });
            }
            const decompressSync = codec.decompressSync;
            const out = guard(`Failed to decompress with method ${method}`, () => decompressSync(data, bound));
            parts.push(out);
            bytesOut = out.byteLength;
        }
        bytesConsumed = bytesIn;
        finished = true;
    }

    tick();
    const output = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    const result = await emitArchive(new Uint8Array(output.buffer, output.byteOffset, output.byteLength), {
        mode: input.outputMode,
        outputPath: input.outputPath,
        extensions: ['.bin', '.dat', '.txt', '.json', '.xml', '.md', '.csv', '.html', '.zip', '.tar', '.raw'],
        mimeType: 'application/octet-stream',
    });
    const trailingWarning = leftover > 0 && !input.allowTrailing ? `${leftover} trailing byte(s) after the end of the deflate stream (pass allowTrailing:true to accept silently).` : undefined;
    return {
        ...result,
        summary: {
            method,
            methodName: method === METHOD_DEFLATE ? 'deflate' : method === METHOD_STORE ? 'store' : `method-${method}`,
            bytesIn,
            bytesOut,
            bytesConsumed,
            leftover,
            finished,
            maxOutput: bound,
            ...(trailingWarning !== undefined ? { trailingWarning } : {}),
        },
        diagnostics: [],
    };
}
