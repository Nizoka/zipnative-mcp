/**
 * Tests for `inflate_raw` — bounded raw-DEFLATE inflation through the
 * resumable inflater, the store pass-through, unregistered methods, file
 * output and the round-trip from `read_zip_entry` mode 'raw'.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { registerCodec, ZipDataError } from 'zipnative';

import { inflateRaw } from '../src/tools/inflate-raw.js';
import { readZipEntry } from '../src/tools/read-zip-entry.js';
import { callToolDirect } from '../src/server.js';
import { ToolError } from '../src/errors.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { b64, basicZip } from './_zip-fixtures.js';

const TEXT = 'hello hello hello hello — a known text, repeated: ' + 'lorem ipsum '.repeat(30);
const COMPRESSED = new Uint8Array(deflateRawSync(Buffer.from(TEXT, 'utf8')));
const GUIDE = '# Guide\n' + 'lorem ipsum dolor sit amet '.repeat(40) + '\n';

function decoded(r: { base64?: string }): string {
    return Buffer.from(r.base64 ?? '', 'base64').toString('utf8');
}

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'OK';
    } catch (e) {
        return e instanceof ToolError ? e.code : `THROW:${String(e)}`;
    }
}

describe('inflate_raw', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    it('inflates a raw deflate stream exactly', async () => {
        const out = await inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1_000_000 });
        expect(out.mode).toBe('base64');
        expect(out.mimeType).toBe('application/octet-stream');
        expect(decoded(out)).toBe(TEXT);
        expect(out.sizeBytes).toBe(Buffer.byteLength(TEXT));
        expect(out.summary).toEqual({ method: 8, methodName: 'deflate', bytesIn: COMPRESSED.byteLength, bytesOut: Buffer.byteLength(TEXT), bytesConsumed: COMPRESSED.byteLength, leftover: 0, finished: true, maxOutput: 1_000_000 });
        expect(out.diagnostics).toEqual([]);
        const exact = await inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: Buffer.byteLength(TEXT) });
        expect(exact.summary.finished).toBe(true);
    });

    it('inflates a stream larger than one input chunk', async () => {
        const data = patternBytes(300_000);
        const compressed = deflateRawSync(data);
        const out = await inflateRaw({ dataBase64: compressed.toString('base64'), maxOutput: 400_000 });
        expect(Buffer.from(out.base64 as string, 'base64').equals(Buffer.from(data))).toBe(true);
        expect(out.summary.bytesConsumed).toBe(compressed.byteLength);
    });

    it('reports trailing bytes as leftover with a warning unless allowTrailing', async () => {
        const withTail = Buffer.concat([Buffer.from(COMPRESSED), Buffer.from('tail!')]);
        const out = await inflateRaw({ dataBase64: withTail.toString('base64'), maxOutput: 1_000_000 });
        expect(decoded(out)).toBe(TEXT);
        expect(out.summary.leftover).toBe(5);
        expect(out.summary.bytesIn).toBe(withTail.byteLength);
        expect(out.summary.bytesConsumed).toBe(COMPRESSED.byteLength);
        expect(out.summary.trailingWarning).toContain('5 trailing byte(s)');
        const silent = await inflateRaw({ dataBase64: withTail.toString('base64'), maxOutput: 1_000_000, allowTrailing: true });
        expect(silent.summary.leftover).toBe(5);
        expect(silent.summary.trailingWarning).toBeUndefined();
        // Trailing bytes spanning a later chunk are counted too.
        const longTail = Buffer.concat([Buffer.from(COMPRESSED), Buffer.alloc(70_000, 0x41)]);
        const spanned = await inflateRaw({ dataBase64: longTail.toString('base64'), maxOutput: 1_000_000, allowTrailing: true });
        expect(spanned.summary.leftover).toBe(70_000);
        expect(decoded(spanned)).toBe(TEXT);
    });

    it('a maxOutput below the real size is ZIP_INFLATE_OUTPUT_OVERFLOW', async () => {
        await expect(inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 16 })).rejects.toMatchObject({
            code: 'ZIP_INFLATE_OUTPUT_OVERFLOW',
            data: { errorClass: 'data' },
        });
    });

    it('a truncated stream is ZIP_DEFLATE_TRUNCATED (or corrupt); garbage is ZIP_DEFLATE_CORRUPT', async () => {
        const half = COMPRESSED.subarray(0, Math.floor(COMPRESSED.length / 2));
        expect(['ZIP_DEFLATE_TRUNCATED', 'ZIP_DEFLATE_CORRUPT']).toContain(await codeOf(inflateRaw({ dataBase64: Buffer.from(half).toString('base64'), maxOutput: 1_000_000 })));
        await expect(inflateRaw({ dataBase64: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).toString('base64'), maxOutput: 1024 })).rejects.toMatchObject({
            code: 'ZIP_DEFLATE_CORRUPT',
            data: { errorClass: 'parse' },
        });
        const empty = await codeOf(inflateRaw({ dataBase64: '', maxOutput: 1024 }));
        expect(['ZIP_DEFLATE_TRUNCATED', 'ZIP_DEFLATE_CORRUPT']).toContain(empty);
    });

    it("method 'store' is a bounded pass-through", async () => {
        const out = await inflateRaw({ dataBase64: Buffer.from('stored bytes').toString('base64'), maxOutput: 100, method: 'store' });
        expect(decoded(out)).toBe('stored bytes');
        expect(out.summary).toEqual({ method: 0, methodName: 'store', bytesIn: 12, bytesOut: 12, bytesConsumed: 12, leftover: 0, finished: true, maxOutput: 100 });
        await expect(inflateRaw({ dataBase64: Buffer.from('stored bytes').toString('base64'), maxOutput: 5, method: 'store' })).rejects.toMatchObject({
            code: 'ZIP_INFLATE_OUTPUT_OVERFLOW',
            data: { errorClass: 'data', observed: 12, configured: 5 },
        });
        const numeric = await inflateRaw({ dataBase64: Buffer.from('x').toString('base64'), maxOutput: 5, method: '0' });
        expect(numeric.summary.methodName).toBe('store');
        const eight = await inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1_000_000, method: '8' });
        expect(decoded(eight)).toBe(TEXT);
    });

    it('a registered codec is used through its synchronous decompressor (test-local registration)', async () => {
        // The server registers no codec; a test may, to exercise the dispatch. Module state is per test file.
        registerCodec({ method: 97, name: 'reverse', decompressSync: (data: Uint8Array, maxOutput: number) => { if (data.length > maxOutput) throw new ZipDataError('ZIP_INFLATE_OUTPUT_OVERFLOW', 'zipnative: over'); return Uint8Array.from(data).reverse(); } });
        registerCodec({ method: 98, name: 'stream-only', decompressStream: async function* (data: Uint8Array) { yield data; } });
        const out = await inflateRaw({ dataBase64: Buffer.from('abc').toString('base64'), maxOutput: 10, method: '97' });
        expect(decoded(out)).toBe('cba');
        expect(out.summary).toMatchObject({ method: 97, methodName: 'method-97', bytesIn: 3, bytesOut: 3, bytesConsumed: 3, finished: true });
        await expect(inflateRaw({ dataBase64: Buffer.from('abc').toString('base64'), maxOutput: 2, method: '97' })).rejects.toMatchObject({ code: 'ZIP_INFLATE_OUTPUT_OVERFLOW' });
        await expect(inflateRaw({ dataBase64: Buffer.from('abc').toString('base64'), maxOutput: 10, method: '98' })).rejects.toMatchObject({
            code: 'ZIP_UNSUPPORTED_CODEC_MODE',
            data: { errorClass: 'unsupported', feature: 'method:98' },
        });
    });

    it('an unregistered numeric method is ZIP_UNSUPPORTED_METHOD', async () => {
        await expect(inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024, method: '93' })).rejects.toMatchObject({
            code: 'ZIP_UNSUPPORTED_METHOD',
            data: { errorClass: 'unsupported', feature: 'method:93' },
        });
        await expect(inflateRaw({ dataBase64: 'AA==', maxOutput: 1024, method: 'lzma' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('reads the compressed stream from a sandbox file', async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'payload.deflate'), COMPRESSED);
        const out = await inflateRaw({ sourcePath: 'payload.deflate', maxOutput: 1_000_000 });
        expect(decoded(out)).toBe(TEXT);
        expect(out.summary.bytesIn).toBe(COMPRESSED.byteLength);
        await expect(inflateRaw({ sourcePath: 'missing.deflate', maxOutput: 10 })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
    });

    it('writes the output as a sandbox file with an allow-listed extension', async () => {
        sandbox = await makeSandbox();
        const out = await inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1_000_000, outputMode: 'file', outputPath: 'out/inflated.bin' });
        expect(out.mode).toBe('file');
        expect(out.filePath).toBe(path.join(sandbox, 'out', 'inflated.bin'));
        expect(await fs.readFile(out.filePath as string, 'utf8')).toBe(TEXT);
        expect(out.summary.maxOutput).toBe(1_000_000);
        await expect(inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024 * 1024, outputMode: 'file', outputPath: 'out/inflated.exe' })).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
        await expect(inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024 * 1024, outputMode: 'file', outputPath: 'out/inflated.bin' })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
        await expect(inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024 * 1024, outputMode: 'file' })).rejects.toMatchObject({ code: 'MISSING_OUTPUT_PATH' });
        const txt = await inflateRaw({ dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024 * 1024, outputMode: 'file', outputPath: 'out/inflated.txt' });
        expect(txt.filePath?.endsWith('inflated.txt')).toBe(true);
        const r = await callToolDirect('inflate_raw', { dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1024 * 1024, outputMode: 'file', outputPath: 'out/wire.json' });
        expect(r.content[1]).toMatchObject({ type: 'resource_link', uri: 'zipnative://output/out/wire.json', mimeType: 'application/json' });
    });

    it("round-trips the payload of read_zip_entry mode 'raw' on a deflated entry", async () => {
        const zipBase64 = b64(basicZip());
        const rawEntry = await readZipEntry({ zipBase64, name: 'docs/guide.md', mode: 'raw' });
        expect(rawEntry.entry.method).toBe(8);
        const out = await inflateRaw({ dataBase64: rawEntry.dataBase64 as string, maxOutput: rawEntry.entry.uncompressedSize });
        expect(decoded(out)).toBe(GUIDE);
        expect(out.summary.bytesConsumed).toBe(rawEntry.entry.compressedSize);
        expect(out.summary.leftover).toBe(0);
        const stored = await readZipEntry({ zipBase64, name: 'README.md', mode: 'raw' });
        expect(stored.entry.method).toBe(0);
        const passthrough = await inflateRaw({ dataBase64: stored.dataBase64 as string, maxOutput: stored.entry.uncompressedSize, method: 'store' });
        expect(decoded(passthrough)).toBe('# Hello\n\nA small archive for the tests.\n');
    });

    it('validates its inputs', async () => {
        await expect(inflateRaw({ dataBase64: 'AA==' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(inflateRaw({ maxOutput: 10 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(inflateRaw({ dataBase64: 'AA==', sourcePath: 'x', maxOutput: 10 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(inflateRaw({ dataBase64: 'AA==', maxOutput: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(inflateRaw({ dataBase64: '!!!', maxOutput: 10 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(inflateRaw({ dataBase64: 'AA==', maxOutput: 10, method: '8x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('wire level: embedded resource with the octet-stream MIME type', async () => {
        const r = await callToolDirect('inflate_raw', { dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1_000_000 });
        expect(r.isError).toBeUndefined();
        const resource = r.content[1] as { type: string; resource: { mimeType: string; blob: string } };
        expect(resource.resource.mimeType).toBe('application/octet-stream');
        expect(Buffer.from(resource.resource.blob, 'base64').toString('utf8')).toBe(TEXT);
        expect(r.structuredContent).toMatchObject({ mode: 'base64', summary: { finished: true, leftover: 0 }, diagnostics: [] });
        const err = await callToolDirect('inflate_raw', { dataBase64: Buffer.from(COMPRESSED).toString('base64'), maxOutput: 1 });
        expect(err.isError).toBe(true);
        expect((err._meta as { error: { code: string } }).error.code).toBe('ZIP_INFLATE_OUTPUT_OVERFLOW');
    });
});
