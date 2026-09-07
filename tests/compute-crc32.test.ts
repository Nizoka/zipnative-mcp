/**
 * Tests for `compute_crc32` — known vectors, seed chaining, streamed sandbox
 * files and the `expect` comparison.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';

import { computeCrc32 } from '../src/tools/compute-crc32.js';
import { callToolDirect } from '../src/server.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';

describe('compute_crc32', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    it("matches the known vector for 'hello world'", async () => {
        const out = await computeCrc32({ text: 'hello world' });
        expect(out).toEqual({ crc32: 0x0d4a1185, hex: '0d4a1185', byteLength: 11, seed: 0 });
        const b64 = await computeCrc32({ dataBase64: Buffer.from('hello world').toString('base64') });
        expect(b64.hex).toBe('0d4a1185');
    });

    it('agrees with node:zlib on binary data', async () => {
        const data = patternBytes(70_000);
        const out = await computeCrc32({ dataBase64: Buffer.from(data).toString('base64') });
        expect(out.crc32).toBe(zlibCrc32(data) >>> 0);
        expect(out.hex).toBe((zlibCrc32(data) >>> 0).toString(16).padStart(8, '0'));
        expect(out.byteLength).toBe(70_000);
    });

    it('seed chaining over consecutive chunks equals the CRC of the whole', async () => {
        const whole = await computeCrc32({ text: 'hello world' });
        const first = await computeCrc32({ text: 'hello ' });
        const second = await computeCrc32({ text: 'world', seed: first.crc32 });
        expect(second.seed).toBe(first.crc32);
        expect(second.crc32).toBe(whole.crc32);
        expect(second.byteLength).toBe(5);
    });

    it('empty data yields 0 (and a seed passes through)', async () => {
        expect(await computeCrc32({ text: '' })).toEqual({ crc32: 0, hex: '00000000', byteLength: 0, seed: 0 });
        expect(await computeCrc32({ dataBase64: '' })).toEqual({ crc32: 0, hex: '00000000', byteLength: 0, seed: 0 });
        const seeded = await computeCrc32({ dataBase64: '', seed: 0xdeadbeef });
        expect(seeded.crc32).toBe(0xdeadbeef);
        expect(seeded.hex).toBe('deadbeef');
    });

    it('streams a sandbox file larger than one chunk', async () => {
        sandbox = await makeSandbox();
        const data = patternBytes(1024 * 1024 + 4097, 3);
        await fs.writeFile(path.join(sandbox, 'big.bin'), data);
        const out = await computeCrc32({ sourcePath: 'big.bin' });
        expect(out.crc32).toBe(zlibCrc32(data) >>> 0);
        expect(out.byteLength).toBe(data.byteLength);
        const chained = await computeCrc32({ sourcePath: 'big.bin', seed: 7 });
        expect(chained.crc32).toBe(zlibCrc32(data, 7) >>> 0);
        await expect(computeCrc32({ sourcePath: 'missing.bin' })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
        await expect(computeCrc32({ sourcePath: '../big.bin' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('sourcePath without a sandbox is a SECURITY_VIOLATION', async () => {
        await expect(computeCrc32({ sourcePath: 'big.bin' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it("compares against `expect` (hex, 0x prefix, short forms)", async () => {
        expect((await computeCrc32({ text: 'hello world', expect: '0d4a1185' })).matches).toBe(true);
        expect((await computeCrc32({ text: 'hello world', expect: '0x0D4A1185' })).matches).toBe(true);
        expect((await computeCrc32({ text: 'hello world', expect: 'd4a1185' })).matches).toBe(true);
        expect((await computeCrc32({ text: 'hello world', expect: '00000000' })).matches).toBe(false);
        expect((await computeCrc32({ text: 'hello world' })).matches).toBeUndefined();
        await expect(computeCrc32({ text: 'x', expect: 'nothex' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'x', expect: '123456789' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('requires exactly one source and validates the rest', async () => {
        await expect(computeCrc32({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'a', dataBase64: 'YQ==' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'a', sourcePath: 'a.bin' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'a', seed: -1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'a', seed: 2 ** 32 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ dataBase64: '!!!' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(computeCrc32({ text: 'a', extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('wire level: text line and structuredContent', async () => {
        const r = await callToolDirect('compute_crc32', { text: 'hello world', expect: '0d4a1185' });
        expect(r.isError).toBeUndefined();
        expect((r.content[0] as { text: string }).text).toBe('compute_crc32: crc32=0d4a1185 over 11 byte(s), matches=true.');
        expect(r.structuredContent).toEqual({ crc32: 0x0d4a1185, hex: '0d4a1185', byteLength: 11, seed: 0, matches: true });
    });
});
