/**
 * Tests for `src/entry.ts` — the shared EntryView and its helpers.
 */
import { describe, it, expect } from 'vitest';
import { iterateZipEntries, openZip, type StreamedZipHeader } from 'zipnative';

import { bytesToHex, crcHex, decodeComment, decodeFlags, ENTRY_VIEW_SCHEMA, formatRatio, methodName, sanitizedPathOf, viewFromEntry, viewFromHeader } from '../src/entry.js';
import { chunked } from '../src/archive-input.js';
import { basicZip, bytesOf, raw, richZip, SYMLINK, ZIP_SLIP, INVALID_UTF8_NAME } from './_zip-fixtures.js';

describe('entry helpers', () => {
    it('decodeFlags reads the four documented bits', () => {
        expect(decodeFlags(0)).toEqual({ raw: 0, encrypted: false, dataDescriptor: false, strongEncryption: false, utf8: false });
        expect(decodeFlags(0x0001 | 0x0008 | 0x0040 | 0x0800)).toEqual({ raw: 0x0849, encrypted: true, dataDescriptor: true, strongEncryption: true, utf8: true });
        expect(decodeFlags(0x0800).utf8).toBe(true);
        expect(decodeFlags(0x0008).dataDescriptor).toBe(true);
    });

    it('methodName knows store / deflate and names unregistered methods', () => {
        expect(methodName(0)).toBe('store');
        expect(methodName(8)).toBe('deflate');
        expect(methodName(93)).toBe('method-93');
        expect(methodName(12)).toBe('method-12');
    });

    it('crcHex and bytesToHex format lowercase hex', () => {
        expect(crcHex(0)).toBe('00000000');
        expect(crcHex(0xdeadbeef)).toBe('deadbeef');
        expect(crcHex(-1)).toBe('ffffffff');
        expect(crcHex(0x0d4a1185)).toBe('0d4a1185');
        expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
        const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
        expect(bytesToHex(view)).toBe('0203');
    });

    it('formatRatio is the percentage saved, never negative', () => {
        expect(formatRatio(0, 0)).toBe('0%');
        expect(formatRatio(50, 100)).toBe('50%');
        expect(formatRatio(37, 1000)).toBe('96%');
        expect(formatRatio(120, 100)).toBe('0%');
        expect(formatRatio(100, 100)).toBe('0%');
    });

    it('decodeComment is lossy UTF-8 with an empty fast path', () => {
        expect(decodeComment(new Uint8Array(0))).toBe('');
        expect(decodeComment(bytesOf('ünï'))).toBe('ünï');
        expect(decodeComment(new Uint8Array([0xff, 0x41]))).toBe('�A');
    });

    it('sanitizedPathOf strips the directory slash before the gate', () => {
        expect(sanitizedPathOf('dir/', true)).toBe('dir');
        expect(sanitizedPathOf('dir/', false)).toBe('dir');
        expect(sanitizedPathOf('a/b.txt', false)).toBe('a/b.txt');
        expect(sanitizedPathOf('../x', false)).toBeNull();
        expect(sanitizedPathOf('../', true)).toBeNull();
    });
});

describe('viewFromEntry', () => {
    it('projects every central-directory field of a rich entry', () => {
        const reader = openZip(richZip(), { onDiagnostic: () => undefined });
        const entries = [...reader.entries()];
        const readme = entries.find((e) => e.name === 'README.md');
        const view = viewFromEntry(readme as NonNullable<typeof readme>, 0);
        expect(view).toMatchObject({
            index: 0,
            name: 'README.md',
            nameEncoding: 'utf-8',
            isDirectory: false,
            isSymlink: false,
            method: 0,
            methodName: 'store',
            compressedSize: 8,
            uncompressedSize: 8,
            ratio: '0%',
            lastModified: '2024-06-01T12:34:56.000Z',
            isEncrypted: false,
            usesZip64: false,
            usesDataDescriptor: false,
            unixMode: '0644',
            sanitizedPath: 'README.md',
            comment: 'entry comment',
            commentHex: Buffer.from('entry comment').toString('hex'),
            hostSystem: 'unix',
            rawNameHex: Buffer.from('README.md').toString('hex'),
            extraFields: expect.any(Array),
        });
        expect(view.crc32).toMatch(/^[0-9a-f]{8}$/);
        expect(view.flags.utf8).toBe(true);
        expect(typeof view.versionMadeBy).toBe('number');
        expect(typeof view.versionNeeded).toBe('number');
        expect(typeof view.localHeaderOffset).toBe('number');
        expect(typeof view.externalAttributes).toBe('number');
        expect(typeof view.internalAttributes).toBe('number');
        expect(typeof view.dosDate).toBe('number');
        expect(typeof view.dosTime).toBe('number');
        const cafe = entries.find((e) => e.name === 'café/résumé.txt') as NonNullable<typeof readme>;
        expect(viewFromEntry(cafe, 3).extraFields).toEqual([{ id: 0x6a6a, idHex: '0x6a6a', name: null, length: 3 }]);
        expect(viewFromEntry(cafe, 3, { includeExtraData: true }).extraFields[0]?.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        const dir = entries.find((e) => e.name === 'assets/') as NonNullable<typeof readme>;
        const dirView = viewFromEntry(dir, 1);
        expect(dirView.isDirectory).toBe(true);
        expect(dirView.sanitizedPath).toBe('assets');
        expect(dirView.comment).toBeUndefined();
        expect(dirView.commentHex).toBeUndefined();
    });

    it('names known extra fields and unknown host systems', () => {
        const extra = new Uint8Array([0x55, 0x54, 0x01, 0x00, 0x03]); // UT, length 1
        const reader = openZip(raw([{ name: 'a', extraCentral: extra, versionMadeBy: 0x6314 }]), { onDiagnostic: () => undefined });
        const view = viewFromEntry([...reader.entries()][0] as NonNullable<ReturnType<typeof reader.getEntry>>, 0);
        expect(view.extraFields).toEqual([{ id: 0x5455, idHex: '0x5455', name: 'Extended timestamp (UT)', length: 1 }]);
        expect(view.hostSystem).toBe('host-99');
        expect(view.unixMode).toBeNull();
    });

    it('flags symlinks and unsafe names', () => {
        const link = openZip(SYMLINK(), { onDiagnostic: () => undefined });
        const linkView = viewFromEntry(link.getEntry('link') as NonNullable<ReturnType<typeof link.getEntry>>, 0);
        expect(linkView.isSymlink).toBe(true);
        expect(linkView.unixMode).toBe('0777');
        const slip = openZip(ZIP_SLIP(), { onDiagnostic: () => undefined });
        const slipView = viewFromEntry([...slip.entries()][0] as NonNullable<ReturnType<typeof slip.getEntry>>, 0);
        expect(slipView.sanitizedPath).toBeNull();
        expect(slipView.nameEncoding).toBe('cp437');
        const bad = openZip(INVALID_UTF8_NAME(), { onDiagnostic: () => undefined });
        const badView = viewFromEntry([...bad.entries()][0] as NonNullable<ReturnType<typeof bad.getEntry>>, 0);
        expect(badView.rawNameHex).toBe('fffe2e747874');
        expect(badView.nameEncoding).toBe('cp437');
    });

    it('every emitted key is declared in ENTRY_VIEW_SCHEMA (no required list)', () => {
        const reader = openZip(richZip(), { onDiagnostic: () => undefined });
        const declared = Object.keys(ENTRY_VIEW_SCHEMA.properties);
        [...reader.entries()].forEach((e, i) => {
            for (const key of Object.keys(viewFromEntry(e, i, { includeExtraData: true }))) expect(declared).toContain(key);
        });
        expect('required' in ENTRY_VIEW_SCHEMA).toBe(false);
        expect(ENTRY_VIEW_SCHEMA.additionalProperties).toBe(false);
    });
});

describe('viewFromHeader', () => {
    async function headers(bytes: Uint8Array): Promise<StreamedZipHeader[]> {
        const out: StreamedZipHeader[] = [];
        for await (const item of iterateZipEntries(chunked(bytes), { onDiagnostic: () => undefined })) {
            out.push(item.header);
            await item.skip();
        }
        return out;
    }

    it('projects a local header with the central-directory-only fields nulled or absent', async () => {
        const [readme, assets, guide] = await headers(basicZip());
        const view = viewFromHeader(readme as StreamedZipHeader, 0);
        expect(view).toMatchObject({ index: 0, name: 'README.md', nameEncoding: 'utf-8', isDirectory: false, isSymlink: null, method: 0, methodName: 'store', usesZip64: null, usesDataDescriptor: false, unixMode: null, sanitizedPath: 'README.md', extraFields: [] });
        expect(view.versionMadeBy).toBeUndefined();
        expect(view.hostSystem).toBeUndefined();
        expect(view.localHeaderOffset).toBeUndefined();
        expect(view.externalAttributes).toBeUndefined();
        expect(view.comment).toBeUndefined();
        expect(view.rawNameHex).toBe(Buffer.from('README.md').toString('hex'));
        expect(typeof view.lastModified).toBe('string');
        expect(view.flags.utf8).toBe(true);
        expect(viewFromHeader(assets as StreamedZipHeader, 1).isDirectory).toBe(true);
        expect(viewFromHeader(assets as StreamedZipHeader, 1).sanitizedPath).toBe('assets');
        expect(viewFromHeader(guide as StreamedZipHeader, 2).methodName).toBe('deflate');
        expect(viewFromHeader(guide as StreamedZipHeader, 2).ratio).toMatch(/^\d+%$/);
    });

    it('decodes the data-descriptor flag from a streamed local header', async () => {
        const [h] = await headers(raw([{ name: 'dd.txt', data: bytesOf('x'.repeat(100)), method: 8, dataDescriptor: 'signed' }]));
        const view = viewFromHeader(h as StreamedZipHeader, 0);
        expect(view.usesDataDescriptor).toBe(true);
        expect(view.flags.dataDescriptor).toBe(true);
        expect(view.compressedSize).toBe(0);
    });
});
