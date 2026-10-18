/**
 * The Zip64 streaming opt-in (zipnative 1.1.0 AddEntryOptions.zip64) on
 * create_zip `stream: true` entries, and the file-output operator ceiling
 * ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES that makes an archive above 4 GiB
 * writable into the sandbox. A real 4 GiB + 1 stream is exercised by the
 * engine's own conformance workflow; here the layout is proven on a small
 * entry (APPNOTE 4.3.9.2: Zip64 extra in the local header, 24-byte
 * descriptor) through the independent veraZIP validator.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
