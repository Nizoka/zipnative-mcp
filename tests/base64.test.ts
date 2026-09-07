/**
 * Boundary diagnostics for base64 inputs:
 * the classic agent mistakes — `data:` URI, PEM where raw bytes are expected,
 * double-encoded base64 — must fail with a coded error and a remedy,
 * never with an opaque engine exception.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { decodeBase64Field, decodeZipBase64, encodeBase64 } from '../src/base64.js';
import { ToolError } from '../src/errors.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { b64, basicZip } from './_zip-fixtures.js';

beforeAll(async () => {
    await ensureEngineReady();
});

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

function codeOf(fn: () => unknown): ToolError {
    try {
        fn();
    } catch (err) {
        if (err instanceof ToolError) return err;
        throw err;
    }
    throw new Error('expected the call to throw');
}

describe('decodeBase64Field / decodeZipBase64', () => {
    it('tolerates whitespace and a data: URI prefix', () => {
        const zip = b64(basicZip());
        const viaDataUri = decodeZipBase64(`data:application/zip;base64,${zip.slice(0, 40)}\n${zip.slice(40)}`);
        expect(Buffer.from(viaDataUri).toString('base64')).toBe(zip);
        expect(decodeZipBase64(zip)).toEqual(basicZip());
    });

    it('rejects non-base64 characters and empty payloads with VALIDATION_ERROR', () => {
        expect(codeOf(() => decodeBase64Field('not base64!', 'zipBase64')).code).toBe('VALIDATION_ERROR');
        expect(codeOf(() => decodeBase64Field('', 'dataBase64')).message).toContain('dataBase64');
        expect(codeOf(() => decodeZipBase64('====')).code).toBe('VALIDATION_ERROR');
        // Valid base64 that decodes to nothing is still an empty archive input.
        const empty = codeOf(() => decodeZipBase64('data:application/zip;base64,'));
        expect(empty.code).toBe('VALIDATION_ERROR');
    });

    it('reports an empty decoded buffer as VALIDATION_ERROR naming the field', () => {
        const err = codeOf(() => decodeZipBase64('    ', 'archive'));
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.message).toContain('archive');
    });

    it('names the mistake for PEM text, nested data: URIs and double-encoded base64 (VALIDATION_ERROR)', () => {
        const cases: Array<[string, RegExp]> = [
            [Buffer.from(PEM).toString('base64'), /PEM text/],
            [Buffer.from('data:application/zip;base64,UEsDBBQ=').toString('base64'), /nested data: URI/],
            [Buffer.from(b64(basicZip())).toString('base64'), /encoded twice/],
            [Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').toString('base64'), /encoded twice/],
        ];
        for (const [input, re] of cases) {
            const err = codeOf(() => decodeZipBase64(input));
            expect(err.code).toBe('VALIDATION_ERROR');
            expect(err.message).toMatch(re);
            expect(err.message).toContain('exactly once');
        }
    });

    it('hands arbitrary bytes to the engine (no PK sniffing beyond the obvious mistakes)', () => {
        expect(() => decodeZipBase64(Buffer.from('this is not a zip').toString('base64'))).not.toThrow();
    });

    it('encodeBase64 round-trips a subarray view without copying the whole backing buffer', () => {
        const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
        const view = backing.subarray(2, 6);
        expect(encodeBase64(view)).toBe(Buffer.from([2, 3, 4, 5]).toString('base64'));
        expect(decodeBase64Field(encodeBase64(view), 'x')).toEqual(new Uint8Array([2, 3, 4, 5]));
    });
});

describe('tools surface base64 mistakes with a remedy', () => {
    it('inspect_zip: double-encoded input → isError VALIDATION_ERROR (not an engine ZIP_* code)', async () => {
        const r = await callToolDirect('inspect_zip', { zipBase64: Buffer.from(b64(basicZip())).toString('base64') });
        expect(r.isError).toBe(true);
        expect((r.content[0] as { text: string }).text).toContain('VALIDATION_ERROR');
        expect((r.content[0] as { text: string }).text).toContain('encoded twice');
        expect((r._meta as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('inspect_zip: a data: URI is accepted (the prefix is stripped once)', async () => {
        const r = await callToolDirect('inspect_zip', { zipBase64: `data:application/zip;base64,${b64(basicZip())}`, verbosity: 'summary' });
        expect(r.isError).not.toBe(true);
        expect((r.structuredContent as { entryCount: number }).entryCount).toBe(4);
    });

    it('compute_crc32 / inflate_raw: garbage dataBase64 → VALIDATION_ERROR naming the field', async () => {
        for (const [tool, args] of [
            ['compute_crc32', { dataBase64: '!!!' }],
            ['inflate_raw', { dataBase64: '!!!', maxOutput: 16 }],
        ] as const) {
            const r = await callToolDirect(tool, args);
            expect(r.isError, tool).toBe(true);
            expect((r.content[0] as { text: string }).text).toContain('VALIDATION_ERROR');
            expect((r.content[0] as { text: string }).text).toContain('dataBase64');
        }
    });
});
