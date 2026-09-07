/**
 * Tests for `scan_zip_forward` — the local-headers-only forward reader:
 * complete archives, truncated streams, payload verification, the refusals
 * and the differential against the central directory.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scanZipForward, scanSummary } from '../src/tools/scan-zip-forward.js';
import { listZipEntries } from '../src/tools/list-zip-entries.js';
import { callToolDirect } from '../src/server.js';
import { __resetCeilingsForTests, MAX_ENTRIES_ENV } from '../src/caps.js';
import { ToolError } from '../src/errors.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';
import { b64, basicZip, bytesOf, centralDirectoryOffset, streamedZip, truncated, DEFLATE_DESCRIPTOR, STORE_DESCRIPTOR, ENCRYPTED_FLAG, LFH_NAME_MISMATCH, SFX_PREFIXED, raw } from './_zip-fixtures.js';

const README = '# Hello\n\nA small archive for the tests.\n';

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'OK';
    } catch (e) {
        return e instanceof ToolError ? e.code : `THROW:${String(e)}`;
    }
}

describe('scan_zip_forward', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    it('walks a complete archive to its central directory', async () => {
        const bytes = basicZip();
        const out = await scanZipForward({ zipBase64: b64(bytes) });
        expect(out.trust).toBe('local-headers-only');
        expect(out.stoppedAt).toBe('central-directory');
        expect(out.truncated).toBe(false);
        expect(out.entryCount).toBe(4);
        expect(out.keptCount).toBe(4);
        expect(out.entries).toHaveLength(4);
        expect(out.entries.map((e) => e.name)).toEqual(['README.md', 'assets/', 'docs/guide.md', 'src/index.js']);
        expect(out.entries.every((e) => e.kept)).toBe(true);
        expect(out.entries.every((e) => e.data === undefined)).toBe(true);
        expect(out.inputBytes).toBe(bytes.byteLength);
        // A-001: the engine leaves the central directory unconsumed, so fewer bytes than the input were delivered.
        expect(out.bytesDelivered).toBeLessThan(bytes.byteLength);
        expect(out.bytesDelivered).toBeGreaterThan(0);
        expect(out.maxEntries).toBe(10_000);
        expect(out.error).toBeUndefined();
        expect(out.diagnostics).toEqual([]);
        // Forward rows carry no central-directory-only fields.
        expect(out.entries[0]).toMatchObject({ index: 0, isSymlink: null, usesZip64: null, unixMode: null, methodName: 'store' });
        expect(out.entries[0]?.versionMadeBy).toBeUndefined();
        expect(out.entries[0]?.localHeaderOffset).toBeUndefined();
        expect(out.entries[2]?.methodName).toBe('deflate');
    });

    it('a truncated stream fails with a ZIP_* code unless tolerateTruncation', async () => {
        const cut = truncated(basicZip(), 60);
        const code = await codeOf(scanZipForward({ zipBase64: b64(cut) }));
        expect(['ZIP_STREAM_TRUNCATED', 'ZIP_RECORD_TRUNCATED', 'ZIP_SIGNATURE_MISMATCH']).toContain(code);
        const out = await scanZipForward({ zipBase64: b64(cut), tolerateTruncation: true });
        expect(out.stoppedAt).toBe('error');
        expect(out.truncated).toBe(true);
        expect(out.error?.code).toBe(code);
        expect(out.error?.message).toContain('README.md');
        expect(out.entries.map((e) => e.name)).toEqual(['README.md']);
        expect(out.entryCount).toBe(1);
        expect(out.inputBytes).toBe(60);
        expect(out.bytesDelivered).toBe(60);
        const r = await callToolDirect('scan_zip_forward', { zipBase64: b64(cut), tolerateTruncation: true, verbosity: 'summary' });
        expect(r.isError).toBeUndefined();
        expect(r.structuredContent).toMatchObject({ stoppedAt: 'error', truncated: true, names: ['README.md'], error: { code } });
        expect((r.content[0] as { text: string }).text).toContain('TRUNCATED');
    });

    it("data:'verify' decompresses kept entries, data:'include' returns them", async () => {
        const verify = await scanZipForward({ zipBase64: b64(basicZip()), data: 'verify' });
        const readme = verify.entries.find((e) => e.name === 'README.md');
        expect(readme?.data).toEqual({ verified: true, bytesProduced: Buffer.byteLength(README) });
        expect(verify.entries.find((e) => e.name === 'assets/')?.data).toBeUndefined();
        const include = await scanZipForward({ zipBase64: b64(basicZip()), data: 'include' });
        const row = include.entries.find((e) => e.name === 'README.md');
        expect(row?.data?.verified).toBe(true);
        expect(Buffer.from(row?.data?.dataBase64 ?? '', 'base64').toString('utf8')).toBe(README);
        const guide = include.entries.find((e) => e.name === 'docs/guide.md');
        expect(guide?.data?.bytesProduced).toBe(guide?.uncompressedSize);
    });

    it('reads a deflate + data-descriptor entry with verification', async () => {
        const out = await scanZipForward({ zipBase64: b64(DEFLATE_DESCRIPTOR()), data: 'verify' });
        expect(out.stoppedAt).toBe('central-directory');
        expect(out.entries[0]?.usesDataDescriptor).toBe(true);
        expect(out.entries[0]?.flags.dataDescriptor).toBe(true);
        expect(out.entries[0]?.data).toEqual({ verified: true, bytesProduced: 'deflated with descriptor '.length * 20 });
        const streamed = await scanZipForward({ zipBase64: b64(await streamedZip()), data: 'verify' });
        expect(streamed.stoppedAt).toBe('central-directory');
        expect(streamed.entries.every((e) => e.data?.verified === true)).toBe(true);
    });

    it('a stored entry with a data descriptor is refused (ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR)', async () => {
        const none = await codeOf(scanZipForward({ zipBase64: b64(STORE_DESCRIPTOR()) }));
        const verify = await codeOf(scanZipForward({ zipBase64: b64(STORE_DESCRIPTOR()), data: 'verify' }));
        expect([none, verify]).toContain('ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR');
        const tolerated = await scanZipForward({ zipBase64: b64(STORE_DESCRIPTOR()), data: 'verify', tolerateTruncation: true });
        expect(tolerated.stoppedAt).toBe('error');
        expect(tolerated.error?.code).toBe('ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR');
    });

    it('an encrypted entry is refused when its payload is read, listed when skipped', async () => {
        await expect(scanZipForward({ zipBase64: b64(ENCRYPTED_FLAG()), data: 'verify' })).rejects.toMatchObject({
            code: 'ZIP_UNSUPPORTED_ENCRYPTION',
            data: { feature: 'zipcrypto', entryName: 'secret.txt' },
        });
        const listed = await scanZipForward({ zipBase64: b64(ENCRYPTED_FLAG()) });
        expect(listed.entries.map((e) => [e.name, e.isEncrypted])).toEqual([['secret.txt', true], ['ok.txt', false]]);
        const tolerated = await scanZipForward({ zipBase64: b64(ENCRYPTED_FLAG()), data: 'verify', tolerateTruncation: true });
        expect(tolerated.stoppedAt).toBe('error');
        expect(tolerated.entries[0]?.data).toEqual({ verified: false, bytesProduced: 0 });
        expect(tolerated.error?.code).toBe('ZIP_UNSUPPORTED_ENCRYPTION');
    });

    it('maxEntries stops the walk; a value above the ceiling is refused', async () => {
        const out = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 2 });
        expect(out.stoppedAt).toBe('max-entries');
        expect(out.truncated).toBe(false);
        expect(out.entryCount).toBe(2);
        expect(out.entries.map((e) => e.name)).toEqual(['README.md', 'assets/']);
        await expect(scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 200_000 })).rejects.toMatchObject({
            code: 'LIMIT_CEILING_EXCEEDED',
            data: { limit: 'maxEntries', requested: 200_000, ceiling: 100_000, env: 'ZIPNATIVE_MCP_MAX_ENTRIES' },
        });
    });

    it('the filter marks rows kept / not kept and skips payloads of dropped rows', async () => {
        const out = await scanZipForward({ zipBase64: b64(basicZip()), filter: { glob: ['*.md'] }, data: 'verify' });
        expect(out.entryCount).toBe(4);
        expect(out.keptCount).toBe(2);
        expect(out.entries.map((e) => [e.name, e.kept])).toEqual([['README.md', true], ['assets/', false], ['docs/guide.md', true], ['src/index.js', false]]);
        expect(out.entries.filter((e) => !e.kept).every((e) => e.data === undefined)).toBe(true);
        expect(out.entries.filter((e) => e.kept).every((e) => e.data?.verified === true)).toBe(true);
        expect(scanSummary(out).names).toEqual(['README.md', 'docs/guide.md']);
    });

    it('reports the LOCAL name where list_zip_entries reports the central one (the differential)', async () => {
        const scan = await scanZipForward({ zipBase64: b64(LFH_NAME_MISMATCH()) });
        const list = await listZipEntries({ zipBase64: b64(LFH_NAME_MISMATCH()) });
        expect(scan.entries.map((e) => e.name)).toEqual(['locallll.txt']);
        expect(list.entries.map((e) => e.name)).toEqual(['central.txt']);
        expect(scan.entries[0]?.rawNameHex).toBe(Buffer.from('locallll.txt').toString('hex'));
    });

    it('sanitizedPath shows what the extraction gate would use; names are not sanitized', async () => {
        const out = await scanZipForward({ zipBase64: b64(raw([{ name: '../evil.txt', data: bytesOf('x') }, { name: './ok.txt', data: bytesOf('y') }])) });
        expect(out.entries.map((e) => [e.name, e.sanitizedPath])).toEqual([['../evil.txt', null], ['./ok.txt', 'ok.txt']]);
    });

    it('streams a zipPath from the sandbox', async () => {
        sandbox = await makeSandbox();
        const bytes = basicZip();
        await fs.writeFile(path.join(sandbox, 'in.zip'), bytes);
        const out = await scanZipForward({ zipPath: 'in.zip', data: 'verify' });
        expect(out.stoppedAt).toBe('central-directory');
        expect(out.inputBytes).toBe(bytes.byteLength);
        expect(out.bytesDelivered).toBeLessThan(bytes.byteLength);
        expect(out.entryCount).toBe(4);
        await expect(scanZipForward({ zipPath: 'nope.zip' })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
    });

    it('bytes that are not a ZIP stream fail with ZIP_SIGNATURE_MISMATCH', async () => {
        await expect(scanZipForward({ zipBase64: b64(bytesOf('this is not a zip archive at all, sorry')) })).rejects.toMatchObject({
            code: 'ZIP_SIGNATURE_MISMATCH',
            data: { errorClass: 'parse' },
        });
        // An SFX prefix cannot be seeked past by a forward reader either.
        expect(await codeOf(scanZipForward({ zipBase64: b64(SFX_PREFIXED()) }))).toBe('ZIP_SIGNATURE_MISMATCH');
        const tolerated = await scanZipForward({ zipBase64: b64(bytesOf('this is not a zip archive at all, sorry')), tolerateTruncation: true });
        expect(tolerated.stoppedAt).toBe('error');
        expect(tolerated.entryCount).toBe(0);
    });

    it("an empty archive stops at its central directory; a bare stream ends at 'eof'", async () => {
        const empty = await scanZipForward({ zipBase64: b64(raw([])) });
        expect(empty.stoppedAt).toBe('central-directory');
        expect(empty.entryCount).toBe(0);
        // Only local headers, no central directory at all: the reader reaches EOF cleanly.
        const full = basicZip();
        const cdStart = Buffer.from(full).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        const headersOnly = full.subarray(0, cdStart);
        const out = await scanZipForward({ zipBase64: b64(headersOnly), data: 'verify' });
        expect(out.entryCount).toBe(4);
        expect(['eof', 'central-directory']).toContain(out.stoppedAt);
        expect(out.bytesDelivered).toBe(headersOnly.byteLength);
    });

    it('validates its inputs and honours strict', async () => {
        await expect(scanZipForward({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(scanZipForward({ zipBase64: b64(basicZip()), data: 'all' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(scanZipForward({ zipBase64: b64(basicZip()), limits: { maxEntries: 1_000_000 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        const clean = await scanZipForward({ zipBase64: b64(basicZip()), strict: true });
        expect(clean.entryCount).toBe(4);
    });

    describe('A-001: stoppedAt is derived from byte accounting, never from a PK signature the wrapper parses', () => {
        /** Both input forms: base64 in memory and a zipPath streamed from the sandbox. */
        async function both(bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<Array<Awaited<ReturnType<typeof scanZipForward>>>> {
            const inline = await scanZipForward({ zipBase64: b64(bytes), ...extra });
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'in.zip'), bytes);
            const streamed = await scanZipForward({ zipPath: 'in.zip', ...extra });
            await cleanupSandbox(sandbox);
            sandbox = null;
            return [inline, streamed];
        }

        it('src/tools/scan-zip-forward.ts contains no PK signature literal (CLAUDE.md convention 7)', () => {
            const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools', 'scan-zip-forward.ts'), 'utf8');
            expect(source).not.toMatch(/0x50\s*,\s*0x4b/i);
            expect(source).not.toMatch(/0x0?4034b50|0x0?2014b50|0x0?6054b50|0x0?6064b50/i);
            expect(source).not.toMatch(/containsSignature|SIG_CFH|SIG_EOCD/);
        });

        it('a complete archive stops at the central directory with bytes left undelivered', async () => {
            const bytes = basicZip();
            for (const out of await both(bytes)) {
                expect(out).toMatchObject({ stoppedAt: 'central-directory', truncated: false, entryCount: 4, inputBytes: bytes.byteLength });
                expect(out.bytesDelivered).toBeLessThan(bytes.byteLength);
                expect(out.bytesDelivered).toBeGreaterThanOrEqual(centralDirectoryOffset(bytes));
            }
        });

        it("a stream cut inside an entry ends in 'error' with every byte delivered (tolerateTruncation)", async () => {
            const cut = truncated(basicZip(), 60);
            for (const out of await both(cut, { tolerateTruncation: true })) {
                expect(out).toMatchObject({ stoppedAt: 'error', truncated: true, bytesDelivered: 60, inputBytes: 60 });
                expect(out.error?.code).toBe('ZIP_STREAM_TRUNCATED');
            }
        });

        it("a CD-less stream whose LAST entry is a stored nested zip ends at 'eof' / truncated — the nested central directory is payload, not a stop", async () => {
            const nested = raw([{ name: 'outer.txt', data: bytesOf('outer') }, { name: 'inner.zip', data: basicZip() }]);
            const headersOnly = nested.subarray(0, centralDirectoryOffset(nested));
            for (const out of await both(headersOnly, { data: 'verify' })) {
                expect(out).toMatchObject({ stoppedAt: 'eof', truncated: true, entryCount: 2, inputBytes: headersOnly.byteLength, bytesDelivered: headersOnly.byteLength });
                expect(out.entries.map((e) => e.name)).toEqual(['outer.txt', 'inner.zip']);
                expect(out.entries[1]?.data?.verified).toBe(true);
                expect(out.error).toBeUndefined();
            }
        });

        it("a stream cut INSIDE the central directory still classifies as 'central-directory' (the reader reached it)", async () => {
            const full = basicZip();
            const cut = full.subarray(0, centralDirectoryOffset(full) + 20);
            for (const out of await both(cut, { tolerateTruncation: true })) {
                expect(out).toMatchObject({ stoppedAt: 'central-directory', truncated: false, entryCount: 4 });
                expect(out.bytesDelivered).toBeLessThan(cut.byteLength);
            }
        });

        it("more than 64 KiB of trailing bytes after a complete archive is still 'central-directory'", async () => {
            const bytes = raw([{ name: 'a.txt', data: bytesOf('a') }], { append: new Uint8Array(70_000) });
            for (const out of await both(bytes)) {
                expect(out).toMatchObject({ stoppedAt: 'central-directory', truncated: false, entryCount: 1, inputBytes: bytes.byteLength });
                expect(out.bytesDelivered).toBeLessThan(bytes.byteLength);
            }
        });

        it('an SFX / prepended prefix is refused with ZIP_SIGNATURE_MISMATCH on both input forms', async () => {
            await expect(scanZipForward({ zipBase64: b64(SFX_PREFIXED()) })).rejects.toMatchObject({ code: 'ZIP_SIGNATURE_MISMATCH', data: { errorClass: 'parse' } });
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'sfx.zip'), SFX_PREFIXED());
            await expect(scanZipForward({ zipPath: 'sfx.zip' })).rejects.toMatchObject({ code: 'ZIP_SIGNATURE_MISMATCH' });
            const tolerated = await scanZipForward({ zipPath: 'sfx.zip', tolerateTruncation: true });
            expect(tolerated.stoppedAt).toBe('error');
            expect(tolerated.error?.code).toBe('ZIP_SIGNATURE_MISMATCH');
        });
    });

    describe('A-003: the maxEntries default is clamped to the operator ceiling; only an explicit value above it is refused', () => {
        afterEach(() => {
            delete process.env[MAX_ENTRIES_ENV];
            __resetCeilingsForTests();
        });

        it('with ZIPNATIVE_MCP_MAX_ENTRIES=5000: no maxEntries → 5000; 5000 ok; 5001 → LIMIT_CEILING_EXCEEDED with data.env', async () => {
            process.env[MAX_ENTRIES_ENV] = '5000';
            __resetCeilingsForTests();
            const implicit = await scanZipForward({ zipBase64: b64(basicZip()) });
            expect(implicit.maxEntries).toBe(5000);
            expect(implicit.stoppedAt).toBe('central-directory');
            const explicit = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 5000 });
            expect(explicit.maxEntries).toBe(5000);
            await expect(scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 5001 })).rejects.toMatchObject({
                code: 'LIMIT_CEILING_EXCEEDED',
                data: { limit: 'maxEntries', requested: 5001, ceiling: 5000, env: 'ZIPNATIVE_MCP_MAX_ENTRIES' },
            });
            const r = await callToolDirect('scan_zip_forward', { zipBase64: b64(basicZip()), maxEntries: 5001 });
            expect(r.isError).toBe(true);
            expect((r._meta as { error: { data: { env: string; remedy: string } } }).error.data.env).toBe('ZIPNATIVE_MCP_MAX_ENTRIES');
            expect((r._meta as { error: { data: { remedy: string } } }).error.data.remedy).toContain('5000');
        });

        it('the default (10 000) applies untouched under the default ceiling and is reported in the result', async () => {
            const out = await scanZipForward({ zipBase64: b64(basicZip()) });
            expect(out.maxEntries).toBe(10_000);
        });
    });

    describe('B-007: the budget boundary looks one header ahead', () => {
        it("maxEntries equal to the entry count ends at 'central-directory'; one fewer ends at 'max-entries'", async () => {
            const exact = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 4 });
            expect(exact).toMatchObject({ stoppedAt: 'central-directory', entryCount: 4, maxEntries: 4, truncated: false });
            const short = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 3 });
            expect(short).toMatchObject({ stoppedAt: 'max-entries', entryCount: 3, maxEntries: 3, truncated: false });
            expect(short.entries.map((e) => e.name)).toEqual(['README.md', 'assets/', 'docs/guide.md']);
        });

        it("maxEntries equal to limits.maxEntries ends at 'max-entries' without ZIP_LIMIT_EXCEEDED (no look-ahead past the engine bound)", async () => {
            const out = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 4, limits: { maxEntries: 4 } });
            expect(out).toMatchObject({ stoppedAt: 'max-entries', entryCount: 4, truncated: false });
            expect(out.error).toBeUndefined();
            const three = await scanZipForward({ zipBase64: b64(basicZip()), maxEntries: 3, limits: { maxEntries: 3 } });
            expect(three).toMatchObject({ stoppedAt: 'max-entries', entryCount: 3 });
            expect(three.error).toBeUndefined();
        });
    });

    it('summary projection keeps the verdict and kept names', async () => {
        const full = await scanZipForward({ zipBase64: b64(basicZip()) });
        expect(scanSummary(full)).toEqual({ trust: 'local-headers-only', entryCount: 4, keptCount: 4, stoppedAt: 'central-directory', truncated: false, names: ['README.md', 'assets/', 'docs/guide.md', 'src/index.js'], diagnosticCount: 0 });
        const r = await callToolDirect('scan_zip_forward', { zipBase64: b64(basicZip()), fields: ['entries.name', 'trust'] });
        expect(r.structuredContent).toEqual({ trust: 'local-headers-only', entries: [{ name: 'README.md' }, { name: 'assets/' }, { name: 'docs/guide.md' }, { name: 'src/index.js' }] });
        expect((r.content[0] as { text: string }).text).toContain('trust=local-headers-only');
    });
});
