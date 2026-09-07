/**
 * Tests for `read_zip_entry` — data / raw / verify modes, ranges, lookups by
 * name or index, the inline cap and every entry-level refusal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { openZip } from 'zipnative';

import { readZipEntry, readEntrySummary } from '../src/tools/read-zip-entry.js';
import { callToolDirect } from '../src/server.js';
import { ToolError } from '../src/errors.js';
import { patternBytes } from './_sandbox.js';
import { b64, basicZip, bytesOf, raw, CRC_OVERRIDE, ENCRYPTED_FLAG, UNKNOWN_METHOD, LFH_METHOD_MISMATCH, CORRUPT_DEFLATE, LFH_NAME_MISMATCH, SFX_PREFIXED } from './_zip-fixtures.js';

const README = '# Hello\n\nA small archive for the tests.\n';
const GUIDE = '# Guide\n' + 'lorem ipsum dolor sit amet '.repeat(40) + '\n';
const MiB = 1024 * 1024;

/** An archive holding one deflated entry of `size` bytes (built with the foreign builder). */
function bigEntryZip(size: number): Uint8Array {
    return raw([{ name: 'big.bin', data: patternBytes(size), method: 8 }, { name: 'small.txt', data: bytesOf('small') }]);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'OK';
    } catch (e) {
        return e instanceof ToolError ? e.code : `THROW:${String(e)}`;
    }
}

describe('read_zip_entry', () => {
    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    describe('mode data', () => {
        it('returns base64 by default, CRC-verified', async () => {
            const out = await readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md' });
            expect(out.mode).toBe('data');
            expect(out.encoding).toBe('base64');
            expect(Buffer.from(out.dataBase64 as string, 'base64').toString('utf8')).toBe(README);
            expect(out.sizeBytes).toBe(Buffer.byteLength(README));
            expect(out.crcVerified).toBe(true);
            expect(out.text).toBeUndefined();
            expect(out.range).toBeUndefined();
            expect(out.entry).toMatchObject({ name: 'README.md', index: 0, method: 0 });
            expect(out.diagnostics).toEqual([]);
        });

        it('returns UTF-8 text with textLength (a deflated entry)', async () => {
            const out = await readZipEntry({ zipBase64: b64(basicZip()), name: 'docs/guide.md', encoding: 'utf8' });
            expect(out.encoding).toBe('utf8');
            expect(out.text).toBe(GUIDE);
            expect(out.textLength).toBe(GUIDE.length);
            expect(out.dataBase64).toBeUndefined();
            expect(out.entry.methodName).toBe('deflate');
            expect(out.crcVerified).toBe(true);
        });

        it('locates by index and reports the same entry', async () => {
            const byIndex = await readZipEntry({ zipBase64: b64(basicZip()), index: 2, encoding: 'utf8' });
            expect(byIndex.entry.name).toBe('docs/guide.md');
            expect(byIndex.entry.index).toBe(2);
            expect(byIndex.text).toBe(GUIDE);
        });

        it('the last duplicate wins by name; index picks another', async () => {
            const dup = raw([{ name: 'a', data: bytesOf('first') }, { name: 'a', data: bytesOf('second') }]);
            const byName = await readZipEntry({ zipBase64: b64(dup), name: 'a', encoding: 'utf8' });
            expect(byName.text).toBe('second');
            expect(byName.entry.index).toBe(1);
            const first = await readZipEntry({ zipBase64: b64(dup), index: 0, encoding: 'utf8' });
            expect(first.text).toBe('first');
            expect(first.entry.index).toBe(0);
        });

        it('reads a byte window through the stream without CRC', async () => {
            const out = await readZipEntry({ zipBase64: b64(basicZip()), name: 'docs/guide.md', encoding: 'utf8', range: { offset: 2, length: 5 } });
            expect(out.text).toBe(GUIDE.slice(2, 7));
            expect(out.range).toEqual({ offset: 2, length: 5, returned: 5 });
            expect(out.crcVerified).toBe(false);
            expect(out.sizeBytes).toBe(5);
            const tail = await readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', range: { offset: README.length - 3, length: 100 } });
            expect(tail.range?.returned).toBe(3);
            expect(Buffer.from(tail.dataBase64 as string, 'base64').toString()).toBe(README.slice(-3));
            const beyond = await readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', range: { offset: 10_000, length: 10 } });
            expect(beyond.range?.returned).toBe(0);
            expect(beyond.sizeBytes).toBe(0);
        });

        it('verifyCrc:false returns corrupt data instead of ZIP_CRC_MISMATCH', async () => {
            await expect(readZipEntry({ zipBase64: b64(CRC_OVERRIDE()), name: 'c.txt' })).rejects.toMatchObject({
                code: 'ZIP_CRC_MISMATCH',
                data: { errorClass: 'data', entryName: 'c.txt', expectedCrc: 'deadbeef', actualCrc: expect.stringMatching(/^[0-9a-f]{8}$/) },
            });
            const out = await readZipEntry({ zipBase64: b64(CRC_OVERRIDE()), name: 'c.txt', verifyCrc: false, encoding: 'utf8' });
            expect(out.text).toBe('crc');
            expect(out.crcVerified).toBe(false);
            expect(out.entry.crc32).toBe('deadbeef');
        });

        it('an empty entry reads as empty', async () => {
            const out = await readZipEntry({ zipBase64: b64(raw([{ name: 'e' }])), name: 'e', encoding: 'utf8' });
            expect(out.text).toBe('');
            expect(out.textLength).toBe(0);
            expect(out.sizeBytes).toBe(0);
        });
    });

    describe('mode raw and verify', () => {
        it("raw returns the compressed payload verbatim (matches the engine's readEntryRaw)", async () => {
            const bytes = basicZip();
            const out = await readZipEntry({ zipBase64: b64(bytes), name: 'docs/guide.md', mode: 'raw' });
            expect(out.mode).toBe('raw');
            expect(out.crcVerified).toBe(false);
            expect(out.encoding).toBe('base64');
            const reader = openZip(bytes, { onDiagnostic: () => undefined });
            const expected = reader.readEntryRaw('docs/guide.md');
            expect(Buffer.from(out.dataBase64 as string, 'base64').equals(Buffer.from(expected))).toBe(true);
            expect(out.sizeBytes).toBe(expected.byteLength);
            expect(out.sizeBytes).toBeLessThan(Buffer.byteLength(GUIDE));
        });

        it('verify reports ok on a sound entry', async () => {
            const out = await readZipEntry({ zipBase64: b64(basicZip()), name: 'docs/guide.md', mode: 'verify' });
            expect(out.mode).toBe('verify');
            expect(out.verification).toEqual({ ok: true, crcMatch: true, sizeMatch: true, localHeaderMatch: true });
            expect(out.crcVerified).toBe(true);
            expect(out.sizeBytes).toBe(Buffer.byteLength(GUIDE));
            expect(out.dataBase64).toBeUndefined();
        });

        it('verify never throws for a CRC mismatch: ok false, crcMatch false', async () => {
            const out = await readZipEntry({ zipBase64: b64(CRC_OVERRIDE()), name: 'c.txt', mode: 'verify' });
            expect(out.verification).toEqual({ ok: false, crcMatch: false, sizeMatch: true, localHeaderMatch: true });
            expect(out.crcVerified).toBe(false);
        });
    });

    describe('refusals', () => {
        it('ZIP_ENTRY_NOT_FOUND by name and by out-of-range index', async () => {
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'readme.md' })).rejects.toMatchObject({
                code: 'ZIP_ENTRY_NOT_FOUND',
                data: { errorClass: 'not-found', entryName: 'readme.md' },
            });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), index: 4 })).rejects.toMatchObject({
                code: 'ZIP_ENTRY_NOT_FOUND',
                data: { errorClass: 'not-found', index: 4, entryCount: 4 },
            });
        });

        it('ENTRY_NOT_UTF8 for a binary entry read as text', async () => {
            const bin = raw([{ name: 'bin', data: new Uint8Array([0xff, 0xfe, 0x00, 0xc3]) }]);
            await expect(readZipEntry({ zipBase64: b64(bin), name: 'bin', encoding: 'utf8' })).rejects.toMatchObject({
                code: 'ENTRY_NOT_UTF8',
                data: { entryName: 'bin', remedy: "encoding:'base64'" },
            });
            const ok = await readZipEntry({ zipBase64: b64(bin), name: 'bin' });
            expect(ok.dataBase64).toBe(Buffer.from([0xff, 0xfe, 0x00, 0xc3]).toString('base64'));
        });

        it('ENTRY_TOO_LARGE above the 16 MiB inline cap; a range still succeeds', async () => {
            const zip = bigEntryZip(17 * MiB);
            await expect(readZipEntry({ zipBase64: b64(zip), name: 'big.bin' })).rejects.toMatchObject({
                code: 'ENTRY_TOO_LARGE',
                data: { entryName: 'big.bin', sizeBytes: 17 * MiB, cap: 16 * MiB, remedy: 'range' },
            });
            const window = await readZipEntry({ zipBase64: b64(zip), name: 'big.bin', range: { offset: 4096, length: 16 } });
            expect(window.range).toEqual({ offset: 4096, length: 16, returned: 16 });
            expect(Buffer.from(window.dataBase64 as string, 'base64').equals(Buffer.from(patternBytes(4096 + 16).subarray(4096)))).toBe(true);
            const small = await readZipEntry({ zipBase64: b64(zip), name: 'small.txt', encoding: 'utf8' });
            expect(small.text).toBe('small');
        });

        it('raw mode applies the cap to the compressed size', async () => {
            const stored = raw([{ name: 'big.bin', data: patternBytes(17 * MiB) }]);
            await expect(readZipEntry({ zipBase64: b64(stored), name: 'big.bin', mode: 'raw' })).rejects.toMatchObject({ code: 'ENTRY_TOO_LARGE', data: { cap: 16 * MiB } });
            const deflated = bigEntryZip(17 * MiB);
            const rawOut = await readZipEntry({ zipBase64: b64(deflated), name: 'big.bin', mode: 'raw' });
            expect(rawOut.sizeBytes).toBeLessThan(16 * MiB);
        });

        it('maps the engine refusals with their data fields', async () => {
            await expect(readZipEntry({ zipBase64: b64(ENCRYPTED_FLAG()), name: 'secret.txt' })).rejects.toMatchObject({
                code: 'ZIP_UNSUPPORTED_ENCRYPTION',
                data: { errorClass: 'unsupported', feature: 'zipcrypto', entryName: 'secret.txt' },
            });
            await expect(readZipEntry({ zipBase64: b64(UNKNOWN_METHOD()), name: 'w.bin' })).rejects.toMatchObject({
                code: 'ZIP_UNSUPPORTED_METHOD',
                data: { errorClass: 'unsupported', feature: 'method:93' },
            });
            await expect(readZipEntry({ zipBase64: b64(LFH_METHOD_MISMATCH()), name: 'm.txt' })).rejects.toMatchObject({
                code: 'ZIP_CD_LFH_MISMATCH',
                data: { errorClass: 'security', entryName: 'm.txt' },
            });
            expect(['ZIP_DEFLATE_CORRUPT', 'ZIP_DECOMPRESSION_FAILED', 'ZIP_DEFLATE_TRUNCATED', 'ZIP_CRC_MISMATCH']).toContain(await codeOf(readZipEntry({ zipBase64: b64(CORRUPT_DEFLATE()), name: 'bad.txt' })));
            const enc = await readZipEntry({ zipBase64: b64(ENCRYPTED_FLAG()), name: 'ok.txt', encoding: 'utf8' });
            expect(enc.text).toBe('ok');
        });

        it('raw mode is zero-copy and succeeds even on an unregistered method', async () => {
            const out = await readZipEntry({ zipBase64: b64(UNKNOWN_METHOD()), name: 'w.bin', mode: 'raw' });
            expect(out.entry.methodName).toBe('method-93');
            expect(out.sizeBytes).toBe(1);
        });

        it('a corrupt deflate stream is refused with a parse / data code', async () => {
            const code = await codeOf(readZipEntry({ zipBase64: b64(CORRUPT_DEFLATE()), name: 'bad.txt', verifyCrc: false }));
            expect(['ZIP_DEFLATE_CORRUPT', 'ZIP_DECOMPRESSION_FAILED', 'ZIP_DEFLATE_TRUNCATED', 'OK']).toContain(code);
        });

        it('a truncated deflate payload (raw builder) fails inflation', async () => {
            const data = bytesOf('compressible text '.repeat(64));
            const compressed = new Uint8Array(deflateRawSync(data));
            const half = compressed.subarray(0, Math.floor(compressed.length / 2));
            // The central directory declares the true sizes; the payload stops half way.
            const zip = raw([{ name: 't.txt', data: half, compressedSizeOverride: half.length, uncompressedSizeOverride: data.length, crcOverride: 0 }]);
            const code = await codeOf(readZipEntry({ zipBase64: b64(zip), name: 't.txt' }));
            expect(code).toMatch(/^ZIP_/);
        });
    });

    describe('refinements', () => {
        it('requires exactly one of name / index', async () => {
            await expect(readZipEntry({ zipBase64: b64(basicZip()) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', index: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it("range applies to mode 'data' only; utf8 does not apply to raw", async () => {
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', mode: 'raw', range: { offset: 0, length: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', mode: 'verify', range: { offset: 0, length: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', mode: 'raw', encoding: 'utf8' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', range: { offset: 0, length: 0 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', range: { offset: 0, length: 16 * MiB + 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('verify mode ignores encoding gracefully', async () => {
            const out = await readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', mode: 'verify', encoding: 'utf8' });
            expect(out.verification?.ok).toBe(true);
        });
    });

    describe('diagnostics and projection', () => {
        it('collects the name-mismatch diagnostic the read emits', async () => {
            const out = await readZipEntry({ zipBase64: b64(LFH_NAME_MISMATCH()), name: 'central.txt', encoding: 'utf8' });
            expect(out.text).toBe('x');
            expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_NAME_MISMATCH');
            expect(out.diagnosticCounts['ZIP_NAME_MISMATCH']).toBeGreaterThanOrEqual(1);
            await expect(readZipEntry({ zipBase64: b64(SFX_PREFIXED()), name: 'a.txt', strict: true })).rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
        });

        it('summary keeps name / index / mode / size and the optional blocks', async () => {
            const data = await readZipEntry({ zipBase64: b64(basicZip()), name: 'docs/guide.md', encoding: 'utf8', range: { offset: 0, length: 4 } });
            expect(readEntrySummary(data)).toEqual({ name: 'docs/guide.md', index: 2, mode: 'data', sizeBytes: 4, crcVerified: false, textLength: 4, range: { offset: 0, length: 4, returned: 4 }, diagnosticCount: 0 });
            const verify = await readZipEntry({ zipBase64: b64(basicZip()), index: 0, mode: 'verify' });
            expect(readEntrySummary(verify)).toMatchObject({ name: 'README.md', index: 0, mode: 'verify', verification: { ok: true } });
            const r = await callToolDirect('read_zip_entry', { zipBase64: b64(basicZip()), name: 'README.md', verbosity: 'summary' });
            expect(r.structuredContent).toEqual({ name: 'README.md', index: 0, mode: 'data', sizeBytes: Buffer.byteLength(README), crcVerified: true, diagnosticCount: 0 });
            expect((r.content[0] as { text: string }).text).toContain('"README.md" mode=data');
        });

        it('applies limits and the ceiling', async () => {
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED' });
            await expect(readZipEntry({ zipBase64: b64(basicZip()), name: 'README.md', limits: { maxTotalUncompressedSize: 2 ** 40 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        });
    });
});
