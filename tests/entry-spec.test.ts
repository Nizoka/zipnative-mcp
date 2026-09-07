/**
 * Tests for `src/entry-spec.ts` — the create / modify entry payload mapping.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
    COMPRESSION_INPUT_SCHEMA, CompressionSchema, ENTRY_PAYLOAD_PROPERTIES, EntryPayloadShape, externalAttributesFor, loadPayload, parseEntryDate, parseUnixMode,
    refineEntryPayload, toAddEntryOptions, toCompression, toDefaultDate, toExtraFields,
} from '../src/entry-spec.js';
import { ToolError } from '../src/errors.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';

const PayloadSchema = z.strictObject(EntryPayloadShape).superRefine((v, ctx) => refineEntryPayload(v, ctx));
const LenientSchema = z.strictObject(EntryPayloadShape).superRefine((v, ctx) => refineEntryPayload(v, ctx, true));

describe('entry-spec', () => {
    let sandbox: string | null = null;

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    describe('compression', () => {
        it('maps only the given keys', () => {
            expect(toCompression(undefined)).toBeUndefined();
            expect(toCompression({})).toEqual({});
            expect(toCompression({ method: 'store' })).toEqual({ method: 'store' });
            expect(toCompression({ method: 'deflate', level: 9, deterministic: true })).toEqual({ method: 'deflate', level: 9, deterministic: true });
            expect(Object.keys(COMPRESSION_INPUT_SCHEMA.properties)).toEqual(Object.keys(CompressionSchema.shape));
            expect(CompressionSchema.safeParse({ level: 10 }).success).toBe(false);
            expect(CompressionSchema.safeParse({ method: 'lzma' }).success).toBe(false);
        });
    });

    describe('dates', () => {
        it('parseEntryDate accepts ISO instants within the DOS range', () => {
            expect(parseEntryDate('1980-01-01T00:00:00Z', 'x').getTime()).toBe(Date.UTC(1980, 0, 1));
            expect(parseEntryDate('2107-12-31T23:59:58Z', 'x').getTime()).toBe(Date.UTC(2107, 11, 31, 23, 59, 58));
            expect(parseEntryDate('2024-06-01', 'x').getTime()).toBe(Date.UTC(2024, 5, 1));
            expect(parseEntryDate('2024-06-01T12:34:56.789+02:00', 'x').toISOString()).toBe('2024-06-01T10:34:56.789Z');
        });

        it('parseEntryDate refuses out-of-range and malformed dates with the field name', () => {
            for (const bad of ['1979-12-31T23:59:59Z', '2107-12-31T23:59:59Z', '2200-01-01T00:00:00Z']) {
                expect(() => parseEntryDate(bad, 'entries[2].date')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[2].date must fall within the DOS date range') }));
            }
            for (const bad of ['now', 'June 1 2024', '', '12345', 'Sat, 01 Jun 2024 00:00:00 GMT']) {
                expect(() => parseEntryDate(bad, 'defaultDate')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringContaining('defaultDate must be an ISO-8601') }));
            }
        });

        it("toDefaultDate passes 'now' through and parses the rest", () => {
            expect(toDefaultDate(undefined)).toBeUndefined();
            expect(toDefaultDate('now')).toBe('now');
            expect((toDefaultDate('2024-06-01T00:00:00Z') as Date).getTime()).toBe(Date.UTC(2024, 5, 1));
            expect(() => toDefaultDate('1970-01-01')).toThrow(ToolError);
        });
    });

    describe('attributes', () => {
        it('parseUnixMode accepts 3–4 octal digits with optional 0o', () => {
            expect(parseUnixMode('0644', 'x')).toBe(0o644);
            expect(parseUnixMode('755', 'x')).toBe(0o755);
            expect(parseUnixMode('0o750', 'x')).toBe(0o750);
            expect(parseUnixMode('4755', 'x')).toBe(0o4755);
            // A-005: no trimming — the runtime parser accepts exactly what the advertised `pattern` accepts.
            for (const bad of ['8', '64', '12345', '0x1ff', 'rwx', '', ' 4755 ', '0755\n']) {
                expect(() => parseUnixMode(bad, 'entries[0].unixMode')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[0].unixMode must be 3–4 octal digits') }));
            }
        });

        it('externalAttributesFor sets the Unix type bits and the DOS directory bit', () => {
            expect(externalAttributesFor(0o644, false)).toBe((0o100644 << 16) >>> 0);
            expect(externalAttributesFor(0o755, true)).toBe(((0o40755 << 16) >>> 0) | 0x10);
            expect(externalAttributesFor(0o7777, false)).toBe((0o107777 << 16) >>> 0);
            expect(externalAttributesFor(0o644, false) >>> 0).toBe(externalAttributesFor(0o644, false));
        });
    });

    describe('extra fields', () => {
        it('decodes payloads and refuses the Zip64 id', () => {
            expect(toExtraFields(undefined, 'x')).toBeUndefined();
            expect(toExtraFields([], 'x')).toEqual([]);
            const fields = toExtraFields([{ id: 0x6a6a, dataBase64: Buffer.from([1, 2]).toString('base64') }, { id: 0xffff, dataBase64: '' }], 'x');
            expect(fields).toEqual([{ id: 0x6a6a, data: new Uint8Array([1, 2]) }, { id: 0xffff, data: new Uint8Array(0) }]);
            expect(() => toExtraFields([{ id: 0x0001, dataBase64: 'AA==' }], 'entries[3]')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[3].extraFields[0].id 0x0001') }));
            expect(() => toExtraFields([{ id: 2, dataBase64: '###' }], 'entries[3]')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[3].extraFields[0].dataBase64') }));
        });
    });

    describe('refineEntryPayload', () => {
        it('requires exactly one payload source unless directory', () => {
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x' }).success).toBe(true);
            expect(PayloadSchema.safeParse({ name: 'a', dataBase64: 'eA==' }).success).toBe(true);
            expect(PayloadSchema.safeParse({ name: 'a', sourcePath: 'f' }).success).toBe(true);
            expect(PayloadSchema.safeParse({ name: 'd', directory: true }).success).toBe(true);
            expect(PayloadSchema.safeParse({ name: 'a' }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', dataBase64: 'eA==' }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', sourcePath: 'f' }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'd', directory: true, text: 'x' }).success).toBe(false);
            expect(LenientSchema.safeParse({ name: 'a' }).success).toBe(true);
            expect(LenientSchema.safeParse({ name: 'a', text: 'x', dataBase64: 'eA==' }).success).toBe(false);
        });

        it('externalAttributes and unixMode are exclusive; the shapes mirror the JSON Schema', () => {
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', unixMode: '0644', externalAttributes: 0 }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', unixMode: '0644' }).success).toBe(true);
            expect(PayloadSchema.safeParse({ name: '', text: 'x' }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'a'.repeat(4097), text: 'x' }).success).toBe(false);
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', extraFields: Array.from({ length: 17 }, () => ({ id: 2, dataBase64: '' })) }).success).toBe(false);
            expect(Object.keys(ENTRY_PAYLOAD_PROPERTIES)).toEqual(Object.keys(EntryPayloadShape));
        });
    });

    describe('toAddEntryOptions', () => {
        it('returns undefined when nothing is set and maps each option otherwise', () => {
            expect(toAddEntryOptions(PayloadSchema.parse({ name: 'a', text: 'x' }), 'e')).toBeUndefined();
            const full = toAddEntryOptions(PayloadSchema.parse({
                name: 'a', text: 'x', compression: { method: 'store' }, date: '2024-06-01T00:00:00Z', comment: 'c', unixMode: '0755', extraFields: [{ id: 0x6a6a, dataBase64: '' }],
            }), 'e');
            expect(full).toEqual({ compression: { method: 'store' }, date: new Date(Date.UTC(2024, 5, 1)), comment: 'c', externalAttributes: (0o100755 << 16) >>> 0, extraFields: [{ id: 0x6a6a, data: new Uint8Array(0) }] });
            const dir = toAddEntryOptions(PayloadSchema.parse({ name: 'd', directory: true, unixMode: '0750' }), 'e');
            expect(dir).toEqual({ externalAttributes: ((0o40750 << 16) >>> 0) | 0x10 });
            const rawAttrs = toAddEntryOptions(PayloadSchema.parse({ name: 'a', text: 'x', externalAttributes: 7 }), 'e');
            expect(rawAttrs).toEqual({ externalAttributes: 7 });
            // A malformed date is refused by the schema pattern; a well-formed date outside the DOS range by the runtime parser (naming the field).
            expect(PayloadSchema.safeParse({ name: 'a', text: 'x', date: 'bad' }).success).toBe(false);
            expect(() => toAddEntryOptions(PayloadSchema.parse({ name: 'a', text: 'x', date: '1979-12-31T00:00:00Z' }), 'entries[0]')).toThrow(expect.objectContaining({ message: expect.stringContaining('entries[0].date') }));
            expect(() => toAddEntryOptions(PayloadSchema.parse({ name: 'a', text: 'x', date: '2024-99-99' }), 'entries[0]')).toThrow(expect.objectContaining({ message: expect.stringContaining('entries[0].date') }));
        });
    });

    describe('loadPayload', () => {
        it('loads base64, empty base64, text, and nothing', async () => {
            expect((await loadPayload(PayloadSchema.parse({ name: 'a', dataBase64: Buffer.from([1, 2]).toString('base64') }), 'e')).data).toEqual(new Uint8Array([1, 2]));
            expect((await loadPayload(PayloadSchema.parse({ name: 'a', dataBase64: '' }), 'e')).data).toEqual(new Uint8Array(0));
            expect((await loadPayload(PayloadSchema.parse({ name: 'a', text: 'hé' }), 'e')).data).toEqual(new TextEncoder().encode('hé'));
            expect((await loadPayload(LenientSchema.parse({ name: 'a' }), 'e')).data).toEqual(new Uint8Array(0));
            await expect(loadPayload(PayloadSchema.parse({ name: 'a', dataBase64: '!!' }), 'entries[1]')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[1].dataBase64') });
        });

        it('loads a sandbox file and reports its absolute path', async () => {
            await expect(loadPayload(PayloadSchema.parse({ name: 'a', sourcePath: 'f.bin' }), 'e')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'f.bin'), Buffer.from([7, 8, 9]));
            const loaded = await loadPayload(PayloadSchema.parse({ name: 'a', sourcePath: 'f.bin' }), 'e');
            expect(loaded.data).toEqual(new Uint8Array([7, 8, 9]));
            expect(loaded.sourceAbs).toBe(path.join(sandbox, 'f.bin'));
            await expect(loadPayload(PayloadSchema.parse({ name: 'a', sourcePath: 'missing.bin' }), 'entries[0]')).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND', message: expect.stringContaining('entries[0].sourcePath') });
            await expect(loadPayload(PayloadSchema.parse({ name: 'a', sourcePath: '../f.bin' }), 'e')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        });
    });
});
