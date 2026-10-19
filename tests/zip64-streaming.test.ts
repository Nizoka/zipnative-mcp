/**
 * The Zip64 streaming opt-in (zipnative 1.1.0 AddEntryOptions.zip64) on
 * create_zip `stream: true` entries, and the file-output operator ceiling
 * ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES that makes an archive above 4 GiB
 * writable into the sandbox. The layout is proven on a small entry (APPNOTE
 * 4.3.9.2: Zip64 extra in the local header, 24-byte descriptor) through the
 * independent veraZIP validator; a real 4 GiB + 1 stream is written and read
 * back by byte ranges under ZIPNATIVE_MCP_SLOW_TESTS (the publish gate and
 * the weekly veraZIP run set it; see the last block).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openZip } from 'zipnative';

import { __resetCeilingsForTests, MAX_FILE_OUTPUT_ENV } from '../src/caps.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { assertIsoConformant, assertValidZip, validateArchive } from './_zip-assert.js';

const codeOf = (r: Awaited<ReturnType<typeof callToolDirect>>): string | undefined => (r._meta as { error?: { code?: string } } | undefined)?.error?.code;

let sandbox: string | null = null;

beforeAll(async () => {
    await ensureEngineReady();
});

afterEach(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    delete process.env[MAX_FILE_OUTPUT_ENV];
    __resetCeilingsForTests();
    await cleanupSandbox(sandbox);
    sandbox = null;
});

async function withSource(bytes: Uint8Array): Promise<void> {
    sandbox = await makeSandbox();
    process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = sandbox;
    await fs.writeFile(path.join(sandbox, 'src.bin'), bytes);
}

describe('create_zip stream + zip64', () => {
    it('writes the Zip64 streaming layout the independent validator accepts, and reads back byte for byte', async () => {
        const payload = patternBytes(300_000, 21);
        await withSource(payload);
        const r = await callToolDirect('create_zip', { entries: [{ name: 'big.bin', sourcePath: 'src.bin', stream: true, zip64: true }, { name: 'small.txt', text: 's' }] });
        expect(r.isError, (r.content[0] as { text: string }).text).not.toBe(true);
        const bytes = new Uint8Array(Buffer.from((r.content[1] as { resource: { blob: string } }).resource.blob, 'base64'));
        assertValidZip(bytes, 'zip64-streamed');
        const report = assertIsoConformant(bytes, 'zip64-streamed');
        expect(report.failures).toEqual([]);
        const reader = openZip(bytes, { onDiagnostic: () => undefined });
        const entry = reader.getEntry('big.bin')!;
        expect(entry.usesZip64).toBe(true);
        expect(entry.usesDataDescriptor).toBe(true);
        expect(entry.versionNeeded).toBeGreaterThanOrEqual(45);
        expect(Buffer.from(reader.readEntry(entry)).equals(Buffer.from(payload))).toBe(true);
        // Without the opt-in the same entry takes the classic 32-bit descriptor layout.
        const classic = await callToolDirect('create_zip', { entries: [{ name: 'big.bin', sourcePath: 'src.bin', stream: true }] });
        const classicBytes = new Uint8Array(Buffer.from((classic.content[1] as { resource: { blob: string } }).resource.blob, 'base64'));
        expect(openZip(classicBytes, { onDiagnostic: () => undefined }).getEntry('big.bin')!.usesZip64).toBe(false);
        expect(validateArchive(classicBytes, 'classic').failures).toEqual([]);
    });

    it('zip64 without stream is VALIDATION_ERROR (a buffered entry takes Zip64 automatically when it needs it)', async () => {
        const r = await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'a', zip64: true }] });
        expect(codeOf(r)).toBe('VALIDATION_ERROR');
        expect((r.content[0] as { text: string }).text).toContain('zip64: true applies to stream: true entries only');
    });
});

describe('ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES', () => {
    it('bounds every file output while it streams (OUTPUT_TOO_LARGE naming the variable), the partial file removed', async () => {
        await withSource(patternBytes(3 * 1024 * 1024, 4));
        process.env[MAX_FILE_OUTPUT_ENV] = String(1024 * 1024);
        __resetCeilingsForTests();
        const r = await callToolDirect('create_zip', { entries: [{ name: 'big.bin', sourcePath: 'src.bin', stream: true }], compression: { method: 'store' }, outputMode: 'file', outputPath: 'out/too-big.zip' });
        expect(codeOf(r)).toBe('OUTPUT_TOO_LARGE');
        expect((r._meta as { error: { data: Record<string, unknown> } }).error.data).toMatchObject({ cap: 1024 * 1024, env: MAX_FILE_OUTPUT_ENV });
        await expect(fs.stat(path.join(sandbox!, 'out', 'too-big.zip'))).rejects.toThrow();
        // describe_engine reports the ceiling in force.
        const d = await callToolDirect('describe_engine', { fields: ['ceilings.maxFileOutputBytes'] });
        expect(d.structuredContent).toEqual({ ceilings: { maxFileOutputBytes: 1024 * 1024 } });
    });
});

/**
 * The real thing, opt-in (ZIPNATIVE_MCP_SLOW_TESTS=1): a 4 GiB + 1 stored
 * stream through create_zip in file mode with the file-output ceiling raised,
 * then the result — above the 1 GiB in-memory cap — read by byte ranges. The
 * source is a sparse file (zeros), the output is a real 4 GiB archive on disk,
 * so the test needs about 8 GiB free and runs for minutes; it lives under
 * test-output/ (git-ignored) rather than the OS temp directory. The ISO
 * validator is not run on it (the small entry above covers the layout).
 */
describe.skipIf(!process.env['ZIPNATIVE_MCP_SLOW_TESTS'])('create_zip stream + zip64 above 4 GiB (ZIPNATIVE_MCP_SLOW_TESTS)', () => {
    const SIZE = 4 * 1024 * 1024 * 1024 + 1;
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    let slowDir: string | null = null;

    afterEach(async () => {
        if (slowDir !== null) await fs.rm(slowDir, { recursive: true, force: true });
        slowDir = null;
    });

    it('writes a 4 GiB + 1 entry in the Zip64 streaming layout and reads it back by ranges', async () => {
        await fs.mkdir(path.join(REPO_ROOT, 'test-output'), { recursive: true });
        slowDir = await fs.mkdtemp(path.join(REPO_ROOT, 'test-output', 'slow-zip64-'));
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = slowDir;
        process.env[MAX_FILE_OUTPUT_ENV] = String(5 * 1024 * 1024 * 1024);
        __resetCeilingsForTests();
        // A sparse source: the file system serves zeros without writing them.
        const source = await fs.open(path.join(slowDir, 'huge.bin'), 'w');
        try {
            await source.truncate(SIZE);
        } finally {
            await source.close();
        }

        const created = await callToolDirect('create_zip', {
            entries: [{ name: 'huge.bin', sourcePath: 'huge.bin', stream: true, zip64: true }],
            compression: { method: 'store' },
            outputMode: 'file',
            outputPath: 'out/huge.zip',
        });
        expect(created.isError, (created.content[0] as { text: string }).text).not.toBe(true);
        const written = await fs.stat(path.join(slowDir, 'out', 'huge.zip'));
        expect(written.size).toBeGreaterThan(SIZE);
        // The source is no longer needed; the archive alone is above the 1 GiB in-memory cap.
        await fs.rm(path.join(slowDir, 'huge.bin'));

        // The engine's default read bound (maxEntryUncompressedSize 1 GiB) applies in range mode too: a reader of
        // an entry this large raises it explicitly (within the operator ceiling, 8 GiB by default).
        const limits = { maxEntryUncompressedSize: SIZE, maxTotalUncompressedSize: SIZE };
        const refused = await callToolDirect('inspect_zip', { zipPath: 'out/huge.zip', verbosity: 'summary' });
        expect((refused._meta as { error?: { code?: string } }).error?.code).toBe('ZIP_LIMIT_EXCEEDED');
        const inspected = await callToolDirect('inspect_zip', { zipPath: 'out/huge.zip', verbosity: 'summary', limits });
        expect(inspected.isError, (inspected.content[0] as { text: string }).text).not.toBe(true);
        const summary = inspected.structuredContent as { access?: string; entryCount: number; isZip64: boolean; uncompressedBytes?: number };
        expect(summary.access).toBe('range');
        expect(summary.entryCount).toBe(1);
        expect(summary.isZip64).toBe(true);
        expect(summary.uncompressedBytes).toBe(SIZE);

        const listed = await callToolDirect('list_zip_entries', { zipPath: 'out/huge.zip', limits, fields: ['access', 'entries.name', 'entries.uncompressedSize', 'entries.usesZip64', 'entries.method'] });
        expect(listed.isError).not.toBe(true);
        expect(listed.structuredContent).toEqual({ access: 'range', entries: [{ name: 'huge.bin', uncompressedSize: SIZE, usesZip64: true, method: 0 }] });

        const tail = await callToolDirect('read_zip_entry', { zipPath: 'out/huge.zip', name: 'huge.bin', limits, range: { offset: SIZE - 16, length: 16 } });
        expect(tail.isError, (tail.content[0] as { text: string }).text).not.toBe(true);
        const data = tail.structuredContent as { access?: string; dataBase64?: string; range?: { offset: number; length: number } };
        expect(data.access).toBe('range');
        expect(Buffer.from(data.dataBase64 ?? '', 'base64').equals(Buffer.alloc(16))).toBe(true);
    }, 600_000);
});
