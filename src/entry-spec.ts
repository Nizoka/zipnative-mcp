/**
 * The per-entry payload shared by `create_zip` and `modify_zip`
 * (`add` / `replace` operations): one of `dataBase64` / `text` / `sourcePath`,
 * optional compression, date, comment, attributes and raw extra fields —
 * mapped onto zipnative's `AddEntryOptions`.
 */
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { AddEntryOptions, ZipCompressionOptions, ZipExtraField } from 'zipnative';

import { decodeBase64Field } from './base64.js';
import { assertInputWithin, MAX_EXTRA_FIELDS, MAX_PATH_INPUT_BYTES } from './caps.js';
import { ToolError } from './errors.js';
import { resolveInputFile } from './sandbox.js';

const U16 = 65_535;
const U32 = 0xffff_ffff;

// ── Compression ──────────────────────────────────────────────────────
export const COMPRESSION_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    description: "Compression settings. `method` 'deflate' (default) or 'store'; `level` 0–9 (default 6); `deterministic: true` pins the pure-TS encoder so the bytes are identical on every runtime (slower).",
    properties: {
        method: { type: 'string', enum: ['store', 'deflate'] },
        level: { type: 'integer', minimum: 0, maximum: 9 },
        deterministic: { type: 'boolean' },
    },
} as const;

export const CompressionSchema = z.strictObject({
    method: z.enum(['store', 'deflate']).optional(),
    level: z.number().int().min(0).max(9).optional(),
    deterministic: z.boolean().optional(),
});

export function toCompression(input: z.infer<typeof CompressionSchema> | undefined): ZipCompressionOptions | undefined {
    if (input === undefined) return undefined;
    return {
        ...(input.method !== undefined ? { method: input.method } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.deterministic !== undefined ? { deterministic: input.deterministic } : {}),
    };
}

// ── Dates ────────────────────────────────────────────────────────────
const DOS_MIN = Date.UTC(1980, 0, 1);
const DOS_MAX = Date.UTC(2107, 11, 31, 23, 59, 58);

/** Parse an ISO-8601 instant within the DOS date range (1980-01-01 … 2107-12-31). */
export function parseEntryDate(raw: string, where: string): Date {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        throw new ToolError('VALIDATION_ERROR', `${where} must be an ISO-8601 date/time (got ${JSON.stringify(raw)}).`);
    }
    if (ms < DOS_MIN || ms > DOS_MAX) {
        throw new ToolError('VALIDATION_ERROR', `${where} must fall within the DOS date range 1980-01-01 … 2107-12-31 (got ${raw}).`);
    }
    return new Date(ms);
}

export const DEFAULT_DATE_SCHEMA = {
    type: 'string',
    description: "Timestamp for entries that set no `date`: an ISO-8601 instant (1980-01-01 … 2107-12-31, 2-second DOS granularity) or 'now' (wall clock — emits the ZIP_TIMESTAMP_NOT_PINNED diagnostic and makes the bytes non-reproducible). Omitted: the DOS epoch 1980-01-01T00:00:00 (reproducible).",
} as const;

export function toDefaultDate(raw: string | undefined): Date | 'now' | undefined {
    if (raw === undefined) return undefined;
    if (raw === 'now') return 'now';
    return parseEntryDate(raw, 'defaultDate');
}

// ── Attributes ───────────────────────────────────────────────────────
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Parse a unixMode string ('0644', '755', '0o755') into permission bits. */
export function parseUnixMode(raw: string, where: string): number {
    const m = /^(?:0o)?([0-7]{3,4})$/.exec(raw.trim());
    if (m === null) {
        throw new ToolError('VALIDATION_ERROR', `${where} must be 3–4 octal digits such as '0644' or '755' (got ${JSON.stringify(raw)}).`);
    }
    return parseInt(m[1] as string, 8) & 0o7777;
}

/** External attributes for a Unix mode: (S_IFREG|mode) << 16, plus the DOS directory bit for directories. */
export function externalAttributesFor(mode: number, isDirectory: boolean): number {
    const type = isDirectory ? S_IFDIR : S_IFREG;
    return (((type | mode) << 16) | (isDirectory ? 0x10 : 0)) >>> 0;
}

// ── Extra fields ─────────────────────────────────────────────────────
export const EXTRA_FIELD_INPUT_SCHEMA = {
    type: 'array',
    maxItems: MAX_EXTRA_FIELDS,
    description: 'Extra fields to embed verbatim (id 0–65535 except 0x0001, the Zip64 record the engine owns). The caller owns their determinism.',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'dataBase64'],
        properties: {
            id: { type: 'integer', minimum: 0, maximum: U16 },
            dataBase64: { type: 'string', description: 'Payload bytes as base64 (may be empty).' },
        },
    },
} as const;

export const ExtraFieldSchema = z.strictObject({
    id: z.number().int().min(0).max(U16),
    dataBase64: z.string(),
});

export function toExtraFields(input: readonly z.infer<typeof ExtraFieldSchema>[] | undefined, where: string): ZipExtraField[] | undefined {
    if (input === undefined) return undefined;
    return input.map((f, i) => {
        if (f.id === 0x0001) {
            throw new ToolError('VALIDATION_ERROR', `${where}.extraFields[${i}].id 0x0001 is the Zip64 record — the engine emits it itself.`);
        }
        const data = f.dataBase64.length === 0 ? new Uint8Array(0) : decodeBase64Field(f.dataBase64, `${where}.extraFields[${i}].dataBase64`);
        return { id: f.id, data };
    });
}

// ── Payload ──────────────────────────────────────────────────────────
/** JSON Schema properties shared by a create entry and an add/replace operation. */
export const ENTRY_PAYLOAD_PROPERTIES = {
    name: { type: 'string', minLength: 1, maxLength: 4096, description: "Entry name, '/'-separated. Directories end in '/' (or set `directory: true`)." },
    directory: { type: 'boolean', default: false, description: 'Explicit directory entry (no payload).' },
    dataBase64: { type: 'string', description: 'File content as base64. Exclusive with text / sourcePath.' },
    text: { type: 'string', description: 'File content as UTF-8 text. Exclusive with dataBase64 / sourcePath.' },
    sourcePath: { type: 'string', minLength: 1, description: 'Relative path of a file inside the ZIPNATIVE_MCP_OUTPUT_DIR sandbox to read the content from (any extension). Exclusive with dataBase64 / text.' },
    compression: COMPRESSION_INPUT_SCHEMA,
    date: { type: 'string', description: 'ISO-8601 last-modified instant for this entry (overrides defaultDate).' },
    comment: { type: 'string', maxLength: U16, description: 'Entry comment (UTF-8, ≤ 65535 bytes).' },
    externalAttributes: { type: 'integer', minimum: 0, maximum: U32, description: 'Raw external attributes (uint32). Exclusive with unixMode.' },
    unixMode: { type: 'string', description: "Unix permission bits as octal ('0644', '0755'); mapped to external attributes. Exclusive with externalAttributes." },
    extraFields: EXTRA_FIELD_INPUT_SCHEMA,
} as const;

export const EntryPayloadShape = {
    name: z.string().min(1).max(4096),
    directory: z.boolean().default(false),
    dataBase64: z.string().optional(),
    text: z.string().optional(),
    sourcePath: z.string().min(1).optional(),
    compression: CompressionSchema.optional(),
    date: z.string().optional(),
    comment: z.string().max(U16).optional(),
    externalAttributes: z.number().int().min(0).max(U32).optional(),
    unixMode: z.string().optional(),
    extraFields: z.array(ExtraFieldSchema).max(MAX_EXTRA_FIELDS).optional(),
};

export type EntryPayload = z.infer<z.ZodObject<typeof EntryPayloadShape>>;

/** Zod refinement: exactly one payload source unless `directory`, attribute exclusivity. */
export function refineEntryPayload(value: EntryPayload, ctx: z.RefinementCtx, allowNoPayload = false): void {
    const sources = (value.dataBase64 !== undefined ? 1 : 0) + (value.text !== undefined ? 1 : 0) + (value.sourcePath !== undefined ? 1 : 0);
    if (value.directory) {
        if (sources !== 0) ctx.addIssue({ code: 'custom', message: 'a directory entry takes no dataBase64 / text / sourcePath', path: ['directory'] });
    } else if (sources !== 1 && !(allowNoPayload && sources === 0)) {
        ctx.addIssue({ code: 'custom', message: 'pass exactly one of dataBase64 / text / sourcePath (or directory: true)', path: ['name'] });
    }
    if (value.externalAttributes !== undefined && value.unixMode !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'externalAttributes and unixMode are exclusive', path: ['unixMode'] });
    }
}

/** Map the option-bearing fields to `AddEntryOptions` (validating dates, modes, extra fields). */
export function toAddEntryOptions(value: EntryPayload, where: string): AddEntryOptions | undefined {
    const compression = toCompression(value.compression);
    const date = value.date !== undefined ? parseEntryDate(value.date, `${where}.date`) : undefined;
    const externalAttributes = value.unixMode !== undefined
        ? externalAttributesFor(parseUnixMode(value.unixMode, `${where}.unixMode`), value.directory)
        : value.externalAttributes;
    const extraFields = toExtraFields(value.extraFields, where);
    const out: AddEntryOptions = {
        ...(compression !== undefined ? { compression } : {}),
        ...(date !== undefined ? { date } : {}),
        ...(value.comment !== undefined ? { comment: value.comment } : {}),
        ...(externalAttributes !== undefined ? { externalAttributes } : {}),
        ...(extraFields !== undefined ? { extraFields } : {}),
    };
    return Object.keys(out).length === 0 ? undefined : out;
}

export interface LoadedPayload {
    readonly data: Uint8Array;
    /** Absolute sandbox path when the payload came from `sourcePath` (for streaming). */
    readonly sourceAbs?: string;
}

/** Load the entry content (base64, text or a sandbox file) as bytes. */
export async function loadPayload(value: EntryPayload, where: string): Promise<LoadedPayload> {
    if (value.dataBase64 !== undefined) {
        return { data: value.dataBase64.length === 0 ? new Uint8Array(0) : decodeBase64Field(value.dataBase64, `${where}.dataBase64`) };
    }
    if (value.text !== undefined) return { data: new TextEncoder().encode(value.text) };
    if (value.sourcePath !== undefined) {
        const { resolved, size } = await resolveInputFile(value.sourcePath, null, `${where}.sourcePath`);
        assertInputWithin(size, MAX_PATH_INPUT_BYTES, `${where}.sourcePath`);
        const buf = await fs.readFile(resolved);
        return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), sourceAbs: resolved };
    }
    return { data: new Uint8Array(0) };
}
