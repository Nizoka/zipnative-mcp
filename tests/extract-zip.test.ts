/**
 * Tests for `extract_zip` — inline and file-mode extraction with every guard
 * on by default, the named relaxations, the inline caps and the sandbox.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { extractZipTool, extractSummary } from '../src/tools/extract-zip.js';
import { callToolDirect } from '../src/server.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { b64, basicZip, bytesOf, raw, richZip, ZIP_SLIP, DEVICE_NAME, SYMLINK, DUPLICATE_PATHS, ENCRYPTED_FLAG, SFX_PREFIXED, OVERLAP, CRC_OVERRIDE } from './_zip-fixtures.js';

const README = '# Hello\n\nA small archive for the tests.\n';
const INDEX = 'export const answer = 42;\n';
const GUIDE = '# Guide\n' + 'lorem ipsum dolor sit amet '.repeat(40) + '\n';
const MiB = 1024 * 1024;

function decode(base64: string | undefined): string {
    return Buffer.from(base64 ?? '', 'base64').toString('utf8');
}

describe('extract_zip', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    describe('inline (base64) mode', () => {
        it('round-trips every file of basicZip with its central-directory index', async () => {
            const out = await extractZipTool({ zipBase64: b64(basicZip()) });
            expect(out.mode).toBe('base64');
            expect(out.dryRun).toBe(false);
            expect(out.fileCount).toBe(3);
            expect(out.skipped).toEqual([]);
            expect(out.entries.map((e) => e.path)).toEqual(['README.md', 'docs/guide.md', 'src/index.js']);
            expect(out.entries.map((e) => e.index)).toEqual([0, 2, 3]);
            expect(out.entries.map((e) => e.entryName)).toEqual(['README.md', 'docs/guide.md', 'src/index.js']);
            expect(decode(out.entries[0]?.dataBase64)).toBe(README);
            expect(decode(out.entries[1]?.dataBase64)).toBe(GUIDE);
            expect(decode(out.entries[2]?.dataBase64)).toBe(INDEX);
            expect(out.totalBytes).toBe(Buffer.byteLength(README) + Buffer.byteLength(GUIDE) + Buffer.byteLength(INDEX));
            expect(out.entries[1]).toMatchObject({ method: 'deflate', sizeBytes: Buffer.byteLength(GUIDE) });
            expect(out.entries[1]?.crc32).toMatch(/^[0-9a-f]{8}$/);
            expect(out.entries[0]?.filePath).toBeUndefined();
            expect(out.outputDir).toBeUndefined();
            expect(out.diagnostics).toEqual([]);
        });

        it('includeData:false is a dry run: the plan without bytes', async () => {
            const out = await extractZipTool({ zipBase64: b64(basicZip()), includeData: false });
            expect(out.dryRun).toBe(true);
            expect(out.fileCount).toBe(3);
            expect(out.totalBytes).toBe(Buffer.byteLength(README) + Buffer.byteLength(GUIDE) + Buffer.byteLength(INDEX));
            expect(out.entries.every((e) => e.dataBase64 === undefined)).toBe(true);
            expect(out.entries.map((e) => [e.path, e.index, e.sizeBytes, e.method])).toEqual([
                ['README.md', 0, Buffer.byteLength(README), 'store'],
                ['docs/guide.md', 2, Buffer.byteLength(GUIDE), 'deflate'],
                ['src/index.js', 3, Buffer.byteLength(INDEX), 'store'],
            ]);
        });

        it('filter keeps a subset', async () => {
            const out = await extractZipTool({ zipBase64: b64(basicZip()), filter: { glob: ['*.js'] } });
            expect(out.entries.map((e) => e.path)).toEqual(['src/index.js']);
            const prefix = await extractZipTool({ zipBase64: b64(basicZip()), filter: { prefix: 'docs/' }, includeData: false });
            expect(prefix.entries.map((e) => e.path)).toEqual(['docs/guide.md']);
            const none = await extractZipTool({ zipBase64: b64(basicZip()), filter: { names: ['nope'] } });
            expect(none.fileCount).toBe(0);
            expect(none.totalBytes).toBe(0);
        });

        it('unicode names and empty files extract as-is', async () => {
            const out = await extractZipTool({ zipBase64: b64(richZip()) });
            const paths = out.entries.map((e) => e.path);
            expect(paths).toContain('café/résumé.txt');
            expect(paths).toContain('empty.txt');
            expect(out.entries.find((e) => e.path === 'empty.txt')?.sizeBytes).toBe(0);
        });
    });

    describe('guards', () => {
        it('zip-slip is refused with ZIP_PATH_TRAVERSAL', async () => {
            await expect(extractZipTool({ zipBase64: b64(ZIP_SLIP()) })).rejects.toMatchObject({
                code: 'ZIP_PATH_TRAVERSAL',
                data: { errorClass: 'security', entryName: '../../evil.txt' },
            });
            await expect(extractZipTool({ zipBase64: b64(ZIP_SLIP()), includeData: false })).rejects.toMatchObject({ code: 'ZIP_PATH_TRAVERSAL' });
        });

        it('a Windows device name is refused with ZIP_PATH_TRAVERSAL naming the device', async () => {
            await expect(extractZipTool({ zipBase64: b64(DEVICE_NAME()) })).rejects.toMatchObject({
                code: 'ZIP_PATH_TRAVERSAL',
                message: expect.stringMatching(/device/i),
                data: { entryName: 'aux.txt' },
            });
        });

        it('rejectTraversal:false skips unsafe names and lists them', async () => {
            const out = await extractZipTool({ zipBase64: b64(DEVICE_NAME()), rejectTraversal: false });
            expect(out.skipped).toEqual([{ entryName: 'aux.txt', reason: 'unsafe-path' }]);
            expect(out.entries.map((e) => e.path)).toEqual(['ok.txt']);
            expect(out.entries[0]?.index).toBe(1);
            expect(decode(out.entries[0]?.dataBase64)).toBe('ok');
            const slip = await extractZipTool({ zipBase64: b64(ZIP_SLIP()), rejectTraversal: false, includeData: false });
            expect(slip.skipped).toEqual([{ entryName: '../../evil.txt', reason: 'unsafe-path' }]);
            expect(slip.fileCount).toBe(0);
            const filtered = await extractZipTool({ zipBase64: b64(DEVICE_NAME()), rejectTraversal: false, filter: { names: ['ok.txt'] } });
            expect(filtered.skipped).toEqual([]);
        });

        it('symlinks are refused unless rejectSymlinks:false, then the target text is data', async () => {
            await expect(extractZipTool({ zipBase64: b64(SYMLINK()) })).rejects.toMatchObject({
                code: 'ZIP_SYMLINK_REJECTED',
                data: { errorClass: 'security', entryName: 'link' },
            });
            const out = await extractZipTool({ zipBase64: b64(SYMLINK()), rejectSymlinks: false });
            expect(out.entries.map((e) => e.path)).toEqual(['link', 'ok.txt']);
            expect(decode(out.entries[0]?.dataBase64)).toBe('/etc/passwd');
        });

        it('duplicate sanitized paths are refused unless onDuplicate picks one', async () => {
            await expect(extractZipTool({ zipBase64: b64(DUPLICATE_PATHS()) })).rejects.toMatchObject({
                code: 'ZIP_EXTRACT_DUPLICATE_PATH',
                data: { errorClass: 'security' },
            });
            const first = await extractZipTool({ zipBase64: b64(DUPLICATE_PATHS()), onDuplicate: 'first' });
            expect(first.entries).toHaveLength(1);
            expect(first.entries[0]?.path).toBe('dup.txt');
            expect(decode(first.entries[0]?.dataBase64)).toBe('first');
            expect(first.entries[0]?.index).toBe(0);
            const last = await extractZipTool({ zipBase64: b64(DUPLICATE_PATHS()), onDuplicate: 'last' });
            expect(decode(last.entries[0]?.dataBase64)).toBe('second');
            expect(last.entries[0]?.entryName).toBe('./dup.txt');
            expect(last.entries[0]?.index).toBe(1);
        });

        it('limits are enforced on the declared plan with the limit in data', async () => {
            await expect(extractZipTool({ zipBase64: b64(basicZip()), limits: { maxTotalUncompressedSize: 10 } })).rejects.toMatchObject({
                code: 'ZIP_LIMIT_EXCEEDED',
                data: { errorClass: 'limit', limit: 'maxTotalUncompressedSize', configured: 10 },
            });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), limits: { maxEntryUncompressedSize: 100 } })).rejects.toMatchObject({
                code: 'ZIP_LIMIT_EXCEEDED',
                data: { limit: 'maxEntryUncompressedSize' },
            });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), limits: { maxEntries: 200_000 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        });

        it('encrypted entries are refused; overlap is always refused', async () => {
            await expect(extractZipTool({ zipBase64: b64(ENCRYPTED_FLAG()) })).rejects.toMatchObject({ code: 'ZIP_UNSUPPORTED_ENCRYPTION', data: { feature: 'zipcrypto' } });
            const around = await extractZipTool({ zipBase64: b64(ENCRYPTED_FLAG()), filter: { names: ['ok.txt'] } });
            expect(around.entries.map((e) => e.path)).toEqual(['ok.txt']);
            await expect(extractZipTool({ zipBase64: b64(OVERLAP()) })).rejects.toMatchObject({ code: 'ZIP_ENTRY_OVERLAP' });
        });

        it('strict escalates a diagnostic; otherwise it is reported', async () => {
            const out = await extractZipTool({ zipBase64: b64(SFX_PREFIXED()) });
            expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_PREPENDED_DATA');
            expect(decode(out.entries[0]?.dataBase64)).toBe('sfx');
            await expect(extractZipTool({ zipBase64: b64(SFX_PREFIXED()), strict: true })).rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
        });
    });

    describe('inline caps', () => {
        it('ENTRY_TOO_LARGE above 16 MiB; the dry run still lists it', async () => {
            const zip = raw([{ name: 'big.bin', data: patternBytes(17 * MiB), method: 8 }]);
            await expect(extractZipTool({ zipBase64: b64(zip) })).rejects.toMatchObject({
                code: 'ENTRY_TOO_LARGE',
                data: { entryName: 'big.bin', sizeBytes: 17 * MiB, cap: 16 * MiB },
            });
            const dry = await extractZipTool({ zipBase64: b64(zip), includeData: false });
            expect(dry.entries[0]?.sizeBytes).toBe(17 * MiB);
        });

        it('OUTPUT_TOO_LARGE when the selected entries exceed 32 MiB; the dry run does not fail', async () => {
            const block = patternBytes(12 * MiB);
            const zip = raw([
                { name: 'a.bin', data: block, method: 8 },
                { name: 'b.bin', data: block, method: 8 },
                { name: 'c.bin', data: block, method: 8 },
            ]);
            await expect(extractZipTool({ zipBase64: b64(zip) })).rejects.toMatchObject({
                code: 'OUTPUT_TOO_LARGE',
                data: { totalBytes: 36 * MiB, cap: 32 * MiB, remedy: "outputMode:'file'" },
            });
            const dry = await extractZipTool({ zipBase64: b64(zip), includeData: false });
            expect(dry.fileCount).toBe(3);
            expect(dry.totalBytes).toBe(36 * MiB);
            const subset = await extractZipTool({ zipBase64: b64(zip), filter: { names: ['a.bin', 'b.bin'] }, includeData: false });
            expect(subset.totalBytes).toBe(24 * MiB);
        });
    });

    describe('file mode', () => {
        it('writes every file under outputDir (nested directories created) and returns resource links', async () => {
            sandbox = await makeSandbox();
            const out = await extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'unpacked/report' });
            expect(out.mode).toBe('file');
            expect(out.dryRun).toBe(false);
            expect(out.fileCount).toBe(3);
            expect(out.outputDir).toBe(path.join(sandbox, 'unpacked', 'report'));
            expect(out.directoriesCreated).toBe(0);
            expect(out.entries.map((e) => e.index)).toEqual([0, 2, 3]);
            for (const row of out.entries) {
                expect(row.dataBase64).toBeUndefined();
                expect(row.filePath).toBe(path.join(out.outputDir as string, ...row.path.split('/')));
                expect((await fs.stat(row.filePath as string)).size).toBe(row.sizeBytes);
            }
            expect(await fs.readFile(path.join(sandbox, 'unpacked', 'report', 'docs', 'guide.md'), 'utf8')).toBe(GUIDE);
            expect(await fs.readFile(path.join(sandbox, 'unpacked', 'report', 'src', 'index.js'), 'utf8')).toBe(INDEX);
            await expect(fs.stat(path.join(sandbox, 'unpacked', 'report', 'assets'))).rejects.toBeDefined();

            const r = await callToolDirect('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'second' });
            expect(r.isError).toBeUndefined();
            const links = r.content.filter((c) => c.type === 'resource_link') as Array<{ uri: string; name: string; mimeType: string }>;
            expect(links).toHaveLength(3);
            expect(links.map((l) => l.uri)).toEqual(['zipnative://output/second/README.md', 'zipnative://output/second/docs/guide.md', 'zipnative://output/second/src/index.js']);
            expect(links[0]?.mimeType).toBe('text/markdown');
            expect((r.content[0] as { text: string }).text).toContain('wrote 3 file(s)');
        });

        it('emptyDirectories creates explicit directory entries', async () => {
            sandbox = await makeSandbox();
            const out = await extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'out', emptyDirectories: true });
            expect(out.directoriesCreated).toBe(1);
            expect((await fs.stat(path.join(sandbox, 'out', 'assets'))).isDirectory()).toBe(true);
        });

        it('never overwrites: a second run into the same outputDir is OUTPUT_EXISTS', async () => {
            sandbox = await makeSandbox();
            await extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'out' });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'out' })).rejects.toMatchObject({
                code: 'OUTPUT_EXISTS',
                data: { path: 'out/README.md' },
            });
        });

        it('rejects a missing outputDir, a traversal outputDir and an absent sandbox', async () => {
            sandbox = await makeSandbox();
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file' })).rejects.toMatchObject({ code: 'MISSING_OUTPUT_PATH' });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: '../escape' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: path.join(sandbox, 'abs') })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            await cleanupSandbox(sandbox);
            sandbox = null;
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'out' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        });

        it('skipped names and relaxations apply in file mode too', async () => {
            sandbox = await makeSandbox();
            const out = await extractZipTool({ zipBase64: b64(DEVICE_NAME()), outputMode: 'file', outputDir: 'dev', rejectTraversal: false });
            expect(out.skipped).toEqual([{ entryName: 'aux.txt', reason: 'unsafe-path' }]);
            expect(await fs.readFile(path.join(sandbox, 'dev', 'ok.txt'), 'utf8')).toBe('ok');
            await expect(fs.stat(path.join(sandbox, 'dev', 'aux.txt'))).rejects.toBeDefined();
            const link = await extractZipTool({ zipBase64: b64(SYMLINK()), outputMode: 'file', outputDir: 'ln', rejectSymlinks: false });
            expect(link.fileCount).toBe(2);
            const st = await fs.lstat(path.join(sandbox, 'ln', 'link'));
            expect(st.isSymbolicLink()).toBe(false);
            expect(st.isFile()).toBe(true);
            expect(await fs.readFile(path.join(sandbox, 'ln', 'link'), 'utf8')).toBe('/etc/passwd');
        });

        it('a structural refusal in file mode carries writtenCount', async () => {
            sandbox = await makeSandbox();
            await expect(extractZipTool({ zipBase64: b64(ENCRYPTED_FLAG()), outputMode: 'file', outputDir: 'enc' })).rejects.toMatchObject({
                code: 'ZIP_UNSUPPORTED_ENCRYPTION',
                data: { writtenCount: 0 },
            });
        });

        it('a CRC mismatch mid-stream discards the partial file and names the entry', async () => {
            sandbox = await makeSandbox();
            await expect(extractZipTool({ zipBase64: b64(CRC_OVERRIDE()), outputMode: 'file', outputDir: 'crc' })).rejects.toMatchObject({
                code: 'ZIP_CRC_MISMATCH',
                data: { entryName: 'c.txt', writtenCount: 0 },
            });
            await expect(fs.stat(path.join(sandbox, 'crc', 'c.txt'))).rejects.toBeDefined();
        });

        it('streams a large entry to disk with bounded memory (no inline cap in file mode)', async () => {
            sandbox = await makeSandbox();
            const data = patternBytes(17 * MiB);
            const zip = raw([{ name: 'big.bin', data, method: 8 }]);
            const out = await extractZipTool({ zipBase64: b64(zip), outputMode: 'file', outputDir: 'big' });
            expect(out.fileCount).toBe(1);
            expect(out.totalBytes).toBe(17 * MiB);
            expect(out.entries[0]?.sizeBytes).toBe(17 * MiB);
            const written = await fs.readFile(path.join(sandbox, 'big', 'big.bin'));
            expect(written.byteLength).toBe(17 * MiB);
            expect(written.subarray(0, 4096).equals(Buffer.from(data.subarray(0, 4096)))).toBe(true);
            expect(written.subarray(written.byteLength - 4096).equals(Buffer.from(data.subarray(data.byteLength - 4096)))).toBe(true);
        });

        it.skipIf(process.platform !== 'win32')('a name the host filesystem refuses is an IO_ERROR (win32)', async () => {
            sandbox = await makeSandbox();
            const bad = raw([{ name: 'q?.txt', data: bytesOf('q') }, { name: 'ok.txt', data: bytesOf('ok') }]);
            await expect(extractZipTool({ zipBase64: b64(bad), outputMode: 'file', outputDir: 'bad' })).rejects.toMatchObject({
                code: 'IO_ERROR',
                data: { path: 'bad/q?.txt' },
            });
        });
    });

    describe('projection', () => {
        it('summary keeps counts and paths', async () => {
            const full = await extractZipTool({ zipBase64: b64(DEVICE_NAME()), rejectTraversal: false });
            expect(extractSummary(full)).toEqual({ mode: 'base64', dryRun: false, fileCount: 1, totalBytes: 2, skippedCount: 1, paths: ['ok.txt'], diagnosticCount: 0 });
            const r = await callToolDirect('extract_zip', { zipBase64: b64(basicZip()), verbosity: 'summary', includeData: false });
            expect(r.structuredContent).toEqual({ mode: 'base64', dryRun: true, fileCount: 3, totalBytes: expect.any(Number), skippedCount: 0, paths: ['README.md', 'docs/guide.md', 'src/index.js'], diagnosticCount: 0 });
            expect((r.content[0] as { text: string }).text).toContain('dry run — 3 file(s)');
            const fields = await callToolDirect('extract_zip', { zipBase64: b64(basicZip()), fields: ['entries.path', 'fileCount'] });
            expect(fields.structuredContent).toEqual({ entries: [{ path: 'README.md' }, { path: 'docs/guide.md' }, { path: 'src/index.js' }], fileCount: 3 });
        });

        it('validates its inputs', async () => {
            await expect(extractZipTool({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), onDuplicate: 'merge' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(extractZipTool({ zipBase64: b64(basicZip()), outputMode: 'disk' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });
});
