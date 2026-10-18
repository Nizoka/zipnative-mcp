/**
 * Tool: compute_crc32 — the ZIP checksum (IEEE 802.3, the engine's
 * slice-by-8 `crc32`) of inline data or a sandbox file, streamed in 1 MiB
 * chunks through the `seed` parameter so memory stays constant.
 */
import { z } from 'zod';
import { crc32 } from 'zipnative';

import { decodeBase64Field } from '../base64.js';
import { NO_CONTEXT, throwIfCancelled, type CallContext } from '../call-context.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_PATH_INPUT_BYTES } from '../caps.js';
import { openInputFile } from '../sandbox.js';
import { guard } from '../zip-errors.js';
import { parseInput } from './_shared.js';

export const COMPUTE_CRC32_NAME = 'compute_crc32';

export const COMPUTE_CRC32_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        dataBase64: { type: 'string', description: 'Bytes as base64. Exclusive with text / sourcePath.' },
        text: { type: 'string', description: 'UTF-8 text. Exclusive with dataBase64 / sourcePath.' },
        sourcePath: { type: 'string', minLength: 1, description: 'Relative path of a file inside the sandbox (streamed, ≤ 1 GiB). Exclusive with dataBase64 / text.' },
        seed: { type: 'integer', minimum: 0, maximum: 0xffff_ffff, default: 0, description: 'Running CRC to continue from (chain calls over consecutive chunks).' },
        expect: { type: 'string', pattern: '^(?:0x)?[0-9a-fA-F]{1,8}$', description: "Optional expected CRC (1–8 hex digits, optional 0x prefix, e.g. '4e08bfb4'); the result carries `matches`." },
    },
} as const;

const InputSchema = z
    .strictObject({
        dataBase64: z.string().optional(),
        text: z.string().optional(),
        sourcePath: z.string().min(1).optional(),
        seed: z.number().int().min(0).max(0xffff_ffff).default(0),
        expect: z.string().regex(/^(?:0x)?[0-9a-fA-F]{1,8}$/).optional(),
    })
    .superRefine((v, ctx) => {
        const n = (v.dataBase64 !== undefined ? 1 : 0) + (v.text !== undefined ? 1 : 0) + (v.sourcePath !== undefined ? 1 : 0);
        if (n !== 1) ctx.addIssue({ code: 'custom', message: 'pass exactly one of dataBase64 / text / sourcePath', path: ['dataBase64'] });
    });

export interface ComputeCrc32Result {
    readonly crc32: number;
    readonly hex: string;
    readonly byteLength: number;
    readonly seed: number;
    readonly matches?: boolean;
}

export const COMPUTE_CRC32_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['crc32', 'hex', 'byteLength', 'seed'],
    properties: {
        crc32: { type: 'integer', minimum: 0, description: 'Unsigned 32-bit CRC.' },
        hex: { type: 'string', description: '8 lowercase hex digits.' },
        byteLength: { type: 'integer', minimum: 0 },
        seed: { type: 'integer', minimum: 0 },
        matches: { type: 'boolean', description: 'Present when `expect` was given.' },
    },
} as const;

const CHUNK = 1024 * 1024;

export async function computeCrc32(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<ComputeCrc32Result> {
    const input = parseInput(InputSchema, rawInput);
    let value = input.seed >>> 0;
    let byteLength = 0;
    // A-003: the request's cancellation is checked between 1 MiB slices and progress reported
    // (bytesIn); a CRC chained slice by slice equals the CRC of the whole input.
    const step = (u8: Uint8Array): void => {
        throwIfCancelled(context);
        value = guard('Failed to compute CRC-32', () => crc32(u8, value)) >>> 0;
        byteLength += u8.byteLength;
        context.onProgress?.({ entriesDone: 0, entriesTotal: null, bytesIn: byteLength, bytesOut: 0 });
    };
    if (input.sourcePath !== undefined) {
        const file = await openInputFile(input.sourcePath, null, 'sourcePath');
        try {
            assertInputWithin(file.size, MAX_PATH_INPUT_BYTES, 'sourcePath');
        } catch (err) {
            await file.close();
            throw err;
        }
        for await (const u8 of file.chunks(CHUNK)) step(u8);
    } else {
        const data = input.text !== undefined
            ? new TextEncoder().encode(input.text)
            : input.dataBase64 === '' ? new Uint8Array(0) : decodeBase64Field(input.dataBase64 as string, 'dataBase64');
        assertInputWithin(data.byteLength, MAX_BASE64_INPUT_BYTES, 'data (decoded)');
        if (data.byteLength === 0) step(data);
        for (let o = 0; o < data.byteLength; o += CHUNK) step(data.subarray(o, Math.min(data.byteLength, o + CHUNK)));
    }
    const hex = value.toString(16).padStart(8, '0');
    const matches = input.expect === undefined ? undefined : parseInt(input.expect.replace(/^0x/, ''), 16) >>> 0 === value;
    return { crc32: value, hex, byteLength, seed: input.seed, ...(matches !== undefined ? { matches } : {}) };
}
