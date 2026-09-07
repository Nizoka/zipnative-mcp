/**
 * Tests for `create_zip` — deterministic creation, every writer option,
 * streamed sources, the worker pool, file mode and the caps. Every archive
 * produced here passes `assertValidZip` (ISO/IEC 21320-1 included).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createZipTool } from '../src/tools/create-zip.js';
import { inspectZip } from '../src/tools/inspect-zip.js';
import { listZipEntries } from '../src/tools/list-zip-entries.js';
import { modifyZipTool } from '../src/tools/modify-zip.js';
import { readZipEntry } from '../src/tools/read-zip-entry.js';
import { ensureEngineReady, probeRuntime } from '../src/engine.js';
import { b64, basicZip } from './_zip-fixtures.js';
import { __resetCeilingsForTests, assertInputWithin, MAX_BASE64_INPUT_BYTES } from '../src/caps.js';
import { callToolDirect } from '../src/server.js';
import { assertValidZip } from './_zip-assert.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';

const MiB = 1024 * 1024;

function bytesOfResult(r: { base64?: string }): Uint8Array {
    return new Uint8Array(Buffer.from(r.base64 ?? '', 'base64'));
}

async function textOf(zipBase64: string, name: string): Promise<string> {
    return (await readZipEntry({ zipBase64, name, encoding: 'utf8' })).text as string;
}

describe('create_zip', () => {
    let sandbox: string | null = null;

    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        delete process.env['ZIPNATIVE_MCP_WORKERS'];
        __resetCeilingsForTests();
        // Before any engine deflate runs, so the node:zlib tier is the one reported.
        await ensureEngineReady();
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
        delete process.env['ZIPNATIVE_MCP_WORKERS'];
        __resetCeilingsForTests();
    });

    describe('entries', () => {
        it('writes text, base64, sandbox-file and directory entries', async () => {
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'src.bin'), Buffer.from([0, 1, 2, 3, 255]));
            const out = await createZipTool({
                entries: [
                    { name: 'hello.txt', text: 'hello\n' },
                    { name: 'bin/data.bin', dataBase64: Buffer.from([9, 8, 7]).toString('base64') },
                    { name: 'from-disk.bin', sourcePath: 'src.bin' },
                    { name: 'empty', directory: true },
                    { name: 'explicit/', directory: true },
                ],
            });
            expect(out.mode).toBe('base64');
            expect(out.sizeBytes).toBeGreaterThan(22);
            expect(out.summary).toMatchObject({ entryCount: 5, fileCount: 3, directoryCount: 2, streamedCount: 0, uncompressedBytes: 6 + 3 + 5, order: 'canonical', parallel: { requested: false, workers: 0 } });
            expect(out.summary.sha256).toBeUndefined();
            expect(out.diagnostics).toEqual([]);
            assertValidZip(out.base64 as string, 'create-basic');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            expect(list.entries.map((e) => [e.name, e.isDirectory])).toEqual([['bin/data.bin', false], ['empty/', true], ['explicit/', true], ['from-disk.bin', false], ['hello.txt', false]]);
            expect(await textOf(out.base64 as string, 'hello.txt')).toBe('hello\n');
            const disk = await readZipEntry({ zipBase64: out.base64 as string, name: 'from-disk.bin' });
            expect(disk.dataBase64).toBe(Buffer.from([0, 1, 2, 3, 255]).toString('base64'));
            expect((await readZipEntry({ zipBase64: out.base64 as string, name: 'bin/data.bin' })).dataBase64).toBe(Buffer.from([9, 8, 7]).toString('base64'));
        });

        it('canonical order sorts by raw name bytes; insertion keeps call order', async () => {
            const entries = [{ name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } }, { name: 'META-INF/container.xml', text: '<container/>' }, { name: 'a.txt', text: 'a' }];
            const canonical = await createZipTool({ entries });
            const insertion = await createZipTool({ entries, order: 'insertion' });
            assertValidZip(canonical.base64 as string, 'canonical');
            assertValidZip(insertion.base64 as string, 'insertion');
            expect((await listZipEntries({ zipBase64: canonical.base64 as string })).entries.map((e) => e.name)).toEqual(['META-INF/container.xml', 'a.txt', 'mimetype']);
            expect((await listZipEntries({ zipBase64: insertion.base64 as string })).entries.map((e) => e.name)).toEqual(['mimetype', 'META-INF/container.xml', 'a.txt']);
            expect(insertion.summary.order).toBe('insertion');
            const inspected = await inspectZip({ zipBase64: insertion.base64 as string, check: ['canonical-order', 'epoch-timestamps'] });
            expect(inspected.checks?.map((c) => c.ok)).toEqual([false, true]);
            expect((await listZipEntries({ zipBase64: insertion.base64 as string })).entries[0]?.method).toBe(0);
        });

        it('an empty entries array writes a valid 22-byte archive', async () => {
            const out = await createZipTool({ entries: [] });
            expect(out.sizeBytes).toBe(22);
            assertValidZip(out.base64 as string, 'empty');
            expect(out.summary.entryCount).toBe(0);
            expect((await inspectZip({ zipBase64: out.base64 as string })).entryCount).toBe(0);
        });

        it('refuses duplicate names at the boundary (directory forms included)', async () => {
            await expect(createZipTool({ entries: [{ name: 'a', text: '1' }, { name: 'a', text: '2' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'd', directory: true }, { name: 'd/', directory: true }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('the engine refuses traversal, absolute, backslash and NUL names with ZIP_INVALID_ENTRY_NAME', async () => {
            for (const [i, name] of ['../x', '/abs', 'a\\b', 'a\0b'].entries()) {
                await expect(createZipTool({ entries: [{ name: 'ok.txt', text: 'ok' }, { name, text: 'x' }] }), name).rejects.toMatchObject({
                    code: 'ZIP_INVALID_ENTRY_NAME',
                    data: { errorClass: 'input', entryName: name, entryIndex: 1 },
                });
                void i;
            }
        });

        it('validates payload exclusivity and shapes', async () => {
            await expect(createZipTool({ entries: [{ name: 'a', text: 'x', dataBase64: 'eA==' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'd', directory: true, text: 'x' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a', dataBase64: '!!!' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'x' }], order: 'random' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'x', stream: true }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a', sourcePath: 'x.bin' }] })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            sandbox = await makeSandbox();
            await expect(createZipTool({ entries: [{ name: 'a', sourcePath: 'missing.bin' }] })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
        });
    });

    describe('dates', () => {
        it('omitted defaultDate → DOS epoch, deterministic by the inspect verdict', async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }] });
            const inspected = await inspectZip({ zipBase64: out.base64 as string });
            expect(inspected.determinism.deterministic).toBe(true);
            expect(inspected.determinism.epochTimestamps).toBe(true);
            expect(out.diagnostics).toEqual([]);
        });

        it("'now' emits ZIP_TIMESTAMP_NOT_PINNED and is not deterministic", async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], defaultDate: 'now', compression: { deterministic: true } });
            expect(out.diagnostics.map((d) => d.code)).toEqual(['ZIP_TIMESTAMP_NOT_PINNED']);
            expect(out.diagnosticCounts['ZIP_TIMESTAMP_NOT_PINNED']).toBe(1);
            expect(out.summary.deterministic).toBe(false);
            assertValidZip(out.base64 as string, 'now');
            expect((await inspectZip({ zipBase64: out.base64 as string })).determinism.epochTimestamps).toBe(false);
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], defaultDate: 'now', strict: true })).rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
        });

        it('an ISO defaultDate and a per-entry date round-trip at 2-second granularity', async () => {
            const out = await createZipTool({
                entries: [{ name: 'a.txt', text: 'a' }, { name: 'b.txt', text: 'b', date: '2031-02-03T04:05:07.900Z' }],
                defaultDate: '2024-06-01T12:34:56Z',
            });
            assertValidZip(out.base64 as string, 'dated');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            const a = Date.parse(list.entries[0]?.lastModified ?? '');
            const b = Date.parse(list.entries[1]?.lastModified ?? '');
            expect(Math.abs(a - Date.UTC(2024, 5, 1, 12, 34, 56))).toBeLessThanOrEqual(2000);
            expect(Math.abs(b - Date.UTC(2031, 1, 3, 4, 5, 7, 900))).toBeLessThanOrEqual(2000);
            expect(out.summary.deterministic).toBe(false);
            const inspected = await inspectZip({ zipBase64: out.base64 as string });
            expect(inspected.determinism.epochTimestamps).toBe(false);
            expect(inspected.diagnostics).toEqual([]);
        });

        it('rejects dates outside the DOS range and malformed dates', async () => {
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], defaultDate: '1979-12-31T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('defaultDate') });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', date: '2108-01-01T00:00:00Z' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('entries[0].date') });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], defaultDate: 'yesterday' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('compression', () => {
        it('store / deflate / level at archive and entry level', async () => {
            const text = 'compressible text '.repeat(200);
            const stored = await createZipTool({ entries: [{ name: 'a.txt', text }], compression: { method: 'store' } });
            const deflated = await createZipTool({ entries: [{ name: 'a.txt', text }] });
            const level0 = await createZipTool({ entries: [{ name: 'a.txt', text }], compression: { level: 0 } });
            const level9 = await createZipTool({ entries: [{ name: 'a.txt', text }], compression: { level: 9 } });
            for (const [label, r] of [['stored', stored], ['deflated', deflated], ['level0', level0], ['level9', level9]] as const) assertValidZip(r.base64 as string, label);
            expect((await listZipEntries({ zipBase64: stored.base64 as string })).entries[0]?.method).toBe(0);
            expect((await listZipEntries({ zipBase64: deflated.base64 as string })).entries[0]?.method).toBe(8);
            expect(deflated.sizeBytes).toBeLessThan(stored.sizeBytes);
            expect(level9.sizeBytes).toBeLessThanOrEqual(level0.sizeBytes);
            const mixed = await createZipTool({ entries: [{ name: 'a.txt', text, compression: { method: 'store' } }, { name: 'b.txt', text }], compression: { level: 6 } });
            assertValidZip(mixed.base64 as string, 'mixed');
            expect((await listZipEntries({ zipBase64: mixed.base64 as string })).entries.map((e) => e.method)).toEqual([0, 8]);
            expect(await textOf(mixed.base64 as string, 'b.txt')).toBe(text);
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], compression: { level: 10 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], compression: { method: 'bzip2' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('deterministic:true pins the pure encoder and gives identical sha256 across calls', async () => {
            const entries = [{ name: 'a.txt', text: 'deterministic '.repeat(500) }, { name: 'b.bin', dataBase64: Buffer.from(patternBytes(20_000)).toString('base64') }];
            const one = await createZipTool({ entries, compression: { deterministic: true }, includeSha256: true });
            const two = await createZipTool({ entries, compression: { deterministic: true }, includeSha256: true });
            expect(one.summary.deflateTier).toBe('pure-pinned');
            expect(one.summary.deterministic).toBe(true);
            expect(one.summary.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(one.summary.sha256).toBe(two.summary.sha256);
            expect(one.base64).toBe(two.base64);
            expect(one.summary.sha256).toBe(createHash('sha256').update(bytesOfResult(one)).digest('hex'));
            assertValidZip(one.base64 as string, 'deterministic');
            const plain = await createZipTool({ entries, includeSha256: true });
            expect(plain.summary.deterministic).toBe(false);
            expect(['node-zlib', 'pure']).toContain(plain.summary.deflateTier);
            expect(plain.summary.deflateTier).toBe('node-zlib');
            const perEntry = await createZipTool({ entries: [{ name: 'a.txt', text: 'x', compression: { deterministic: true } }], compression: { deterministic: true } });
            expect(perEntry.summary.deterministic).toBe(true);
            const entryOptOut = await createZipTool({ entries: [{ name: 'a.txt', text: 'x', compression: { deterministic: false } }], compression: { deterministic: true } });
            expect(entryOptOut.summary.deterministic).toBe(false);
            const entryUnpinned = await createZipTool({ entries: [{ name: 'a.txt', text: 'x', compression: { level: 1 } }] });
            expect(entryUnpinned.summary.deterministic).toBe(false);
        });
    });

    describe('metadata', () => {
        it('archive and entry comments round-trip', async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a', comment: 'entry note' }], comment: 'archive note — ünï' });
            assertValidZip(out.base64 as string, 'comments');
            const inspected = await inspectZip({ zipBase64: out.base64 as string });
            expect(inspected.comment).toBe('archive note — ünï');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            expect(list.entries[0]?.comment).toBe('entry note');
            await expect(createZipTool({ entries: [], comment: 'x'.repeat(65_536) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('unixMode maps to external attributes; externalAttributes is raw; the two are exclusive', async () => {
            const out = await createZipTool({
                entries: [
                    { name: 'run.sh', text: '#!/bin/sh\n', unixMode: '0755' },
                    { name: 'plain.txt', text: 'p', unixMode: '644' },
                    { name: 'bin', directory: true, unixMode: '0o750' },
                    { name: 'raw.txt', text: 'r', externalAttributes: (0o100600 << 16) >>> 0 },
                ],
            });
            assertValidZip(out.base64 as string, 'modes');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            const modes = Object.fromEntries(list.entries.map((e) => [e.name, e.unixMode]));
            expect(modes).toEqual({ 'run.sh': '0755', 'plain.txt': '0644', 'bin/': '0750', 'raw.txt': '0600' });
            expect(list.entries.find((e) => e.name === 'bin/')?.isDirectory).toBe(true);
            expect(list.entries.find((e) => e.name === 'bin/')?.externalAttributes).toBe(((0o40750 << 16) >>> 0) | 0x10);
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', unixMode: '0755', externalAttributes: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            // The schema `pattern` (lock-step with the Zod regex) refuses a malformed mode at the boundary, naming the path.
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', unixMode: '9' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('unixMode') });
            // A-005: surrounding whitespace is no longer trimmed — the advertised pattern is the contract.
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', unixMode: ' 0755 ' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('unixMode') });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', externalAttributes: -1 }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('extra fields are embedded verbatim; id 0x0001 is refused', async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a', extraFields: [{ id: 0x6a6a, dataBase64: Buffer.from([1, 2, 3]).toString('base64') }, { id: 0x7070, dataBase64: '' }] }] });
            assertValidZip(out.base64 as string, 'extra');
            const list = await listZipEntries({ zipBase64: out.base64 as string, includeExtraData: true });
            expect(list.entries[0]?.extraFields).toEqual([
                { id: 0x6a6a, idHex: '0x6a6a', name: null, length: 3, dataBase64: Buffer.from([1, 2, 3]).toString('base64') },
                { id: 0x7070, idHex: '0x7070', name: null, length: 0, dataBase64: '' },
            ]);
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', extraFields: [{ id: 1, dataBase64: 'AAAA' }] }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('0x0001') });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a', extraFields: [{ id: 2, dataBase64: '!!' }] }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('streaming and parallel', () => {
        it('stream:true feeds a sandbox file through addStream (data-descriptor layout)', async () => {
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'big.bin'), patternBytes(MiB + 7));
            const out = await createZipTool({ entries: [{ name: 'big.bin', sourcePath: 'big.bin', stream: true }, { name: 'small.txt', text: 's' }], chunkSize: 4096 });
            expect(out.summary.streamedCount).toBe(1);
            expect(out.summary.fileCount).toBe(2);
            expect(out.summary.uncompressedBytes).toBe(MiB + 7 + 1);
            assertValidZip(out.base64 as string, 'streamed');
            const inspected = await inspectZip({ zipBase64: out.base64 as string });
            expect(inspected.dataDescriptorCount).toBe(1);
            expect(inspected.determinism.canonicalLayout).toBe(false);
            expect(inspected.determinism.deterministic).toBe(true);
            const back = await readZipEntry({ zipBase64: out.base64 as string, name: 'big.bin', range: { offset: MiB, length: 7 } });
            expect(Buffer.from(back.dataBase64 as string, 'base64').equals(Buffer.from(patternBytes(MiB + 7).subarray(MiB)))).toBe(true);
        });

        it('parallel compression is byte-identical to the sequential writer under the deterministic pin', async () => {
            const entries = [
                { name: 'a.bin', dataBase64: Buffer.from(patternBytes(200_000, 1)).toString('base64') },
                { name: 'b.bin', dataBase64: Buffer.from(patternBytes(150_000, 2)).toString('base64') },
                { name: 'c.txt', text: 'text '.repeat(10_000) },
            ];
            const sequential = await createZipTool({ entries, compression: { deterministic: true }, includeSha256: true });
            const parallel = await createZipTool({ entries, compression: { deterministic: true }, includeSha256: true, parallel: { workers: 2, minWorkerJobSize: 1 } });
            expect(parallel.summary.parallel).toEqual({ requested: true, workers: 2 });
            expect(parallel.summary.sha256).toBe(sequential.summary.sha256);
            expect(parallel.base64).toBe(sequential.base64);
            assertValidZip(parallel.base64 as string, 'parallel');
            const defaults = await createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: {} });
            expect(defaults.summary.parallel.requested).toBe(true);
            expect(defaults.summary.parallel.workers).toBeGreaterThanOrEqual(1);
            expect(defaults.summary.parallel.workers).toBeLessThanOrEqual(8);
        });

        it('A-004: parallel:{} uses the engine default worker count bounded by ZIPNATIVE_MCP_WORKERS; bytes identical to the sequential writer', async () => {
            const entries = [{ name: 'a.bin', dataBase64: Buffer.from(patternBytes(120_000, 3)).toString('base64') }, { name: 'b.txt', text: 'text '.repeat(4000) }];
            const engineDefault = (await probeRuntime()).defaultWorkers;
            expect(engineDefault).toBe(Math.max(1, Math.min((await probeRuntime()).cpuCount - 1, 8)));
            const defaults = await createZipTool({ entries, parallel: {}, compression: { deterministic: true }, includeSha256: true });
            expect(defaults.summary.parallel).toEqual({ requested: true, workers: Math.min(8, engineDefault) });
            const sequential = await createZipTool({ entries, compression: { deterministic: true }, includeSha256: true });
            expect(defaults.summary.sha256).toBe(sequential.summary.sha256);
            expect(defaults.base64).toBe(sequential.base64);
            assertValidZip(defaults.base64 as string, 'parallel-default');
            // A lower ceiling bounds the default; 0 disables the pool entirely.
            process.env['ZIPNATIVE_MCP_WORKERS'] = '1';
            __resetCeilingsForTests();
            expect((await createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: {} })).summary.parallel).toEqual({ requested: true, workers: 1 });
            process.env['ZIPNATIVE_MCP_WORKERS'] = '0';
            __resetCeilingsForTests();
            expect((await createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: {} })).summary.parallel).toEqual({ requested: true, workers: 0 });
        });

        it('workers above the operator ceiling are refused; ZIPNATIVE_MCP_WORKERS=0 keeps everything inline', async () => {
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: { workers: 9 } })).rejects.toMatchObject({
                code: 'LIMIT_CEILING_EXCEEDED',
                data: { limit: 'workers', requested: 9, ceiling: 8, env: 'ZIPNATIVE_MCP_WORKERS' },
            });
            process.env['ZIPNATIVE_MCP_WORKERS'] = '0';
            __resetCeilingsForTests();
            const out = await createZipTool({ entries: [{ name: 'a', text: 'a'.repeat(1000) }], parallel: {} });
            expect(out.summary.parallel).toEqual({ requested: true, workers: 0 });
            assertValidZip(out.base64 as string, 'workers-0');
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: { workers: 1 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED', data: { ceiling: 0 } });
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }], parallel: { workers: 65 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('output', () => {
        it('file mode writes the archive exclusively inside the sandbox and returns a resource_link', async () => {
            sandbox = await makeSandbox();
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'nested/out.zip', chunkSize: 1024 });
            expect(out.mode).toBe('file');
            expect(out.base64).toBeUndefined();
            expect(out.filePath).toBe(path.join(sandbox, 'nested', 'out.zip'));
            const bytes = new Uint8Array(await fs.readFile(out.filePath as string));
            expect(bytes.byteLength).toBe(out.sizeBytes);
            assertValidZip(bytes, 'file-mode');
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'nested/out.zip' })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS', data: { path: 'nested/out.zip' } });
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'out.txt' })).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file' })).rejects.toMatchObject({ code: 'MISSING_OUTPUT_PATH' });
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: '../x.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            const r = await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'wire.jar' });
            expect(r.isError).toBeUndefined();
            expect(r.content[1]).toMatchObject({ type: 'resource_link', uri: 'zipnative://output/wire.jar', name: 'wire.jar', mimeType: 'application/java-archive' });
            expect(r.structuredContent).toMatchObject({ mode: 'file', filePath: path.join(sandbox, 'wire.jar'), summary: { entryCount: 1 } });
            expect((r.content[0] as { text: string }).text).toContain('wrote');
        });

        it('file mode without a sandbox is a SECURITY_VIOLATION', async () => {
            await expect(createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'out.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        });

        it('streamed entries in file mode', async () => {
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'src.bin'), patternBytes(70_000));
            const out = await createZipTool({ entries: [{ name: 'src.bin', sourcePath: 'src.bin', stream: true }], outputMode: 'file', outputPath: 'streamed.zip' });
            expect(out.summary.streamedCount).toBe(1);
            const bytes = new Uint8Array(await fs.readFile(out.filePath as string));
            assertValidZip(bytes, 'streamed-file');
            expect((await inspectZip({ zipPath: 'streamed.zip' })).dataDescriptorCount).toBe(1);
        });

        it('base64 mode returns the archive as an embedded resource on the wire', async () => {
            const r = await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'a' }], includeSha256: true });
            expect(r.isError).toBeUndefined();
            const resource = r.content[1] as { type: string; resource: { uri: string; mimeType: string; blob: string } };
            expect(resource.type).toBe('resource');
            expect(resource.resource.mimeType).toBe('application/zip');
            expect(resource.resource.uri.startsWith('data:application/zip;base64,')).toBe(true);
            assertValidZip(resource.resource.blob, 'wire');
            const sc = r.structuredContent as Record<string, unknown>;
            expect(sc['mode']).toBe('base64');
            expect(sc).not.toHaveProperty('base64');
            expect((sc['summary'] as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(sc['diagnostics']).toEqual([]);
        });
    });

    describe('caps and limits', () => {
        it('the inline payload cap is enforced through assertInputWithin', () => {
            expect(() => assertInputWithin(MAX_BASE64_INPUT_BYTES, MAX_BASE64_INPUT_BYTES, 'inline entry payloads (total)')).not.toThrow();
            expect(() => assertInputWithin(MAX_BASE64_INPUT_BYTES + 1, MAX_BASE64_INPUT_BYTES, 'inline entry payloads (total)')).toThrow(expect.objectContaining({
                code: 'INPUT_TOO_LARGE',
                data: { what: 'inline entry payloads (total)', observed: MAX_BASE64_INPUT_BYTES + 1, cap: MAX_BASE64_INPUT_BYTES, remedy: 'zipPath' },
            }));
        });

        it('limits.maxEntries is enforced by the engine; the ceiling by the wrapper', async () => {
            await expect(createZipTool({ entries: [{ name: 'a', text: 'a' }, { name: 'b', text: 'b' }], limits: { maxEntries: 1 } })).rejects.toMatchObject({
                code: 'ZIP_LIMIT_EXCEEDED',
                data: { limit: 'maxEntries', configured: 1, observed: 2 },
            });
            await expect(createZipTool({ entries: [], limits: { maxEntries: 200_000 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
            // B-010: the schema cap is 100 000 (aligned with the engine default), so a per-call
            // limit and the operator ceiling are the bounds that fire on a large entry list.
            const many = Array.from({ length: 12 }, (_, i) => ({ name: `e${i}`, text: 'x' }));
            await expect(createZipTool({ entries: many, limits: { maxEntries: 11 } })).rejects.toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxEntries', configured: 11, observed: 12 } });
            process.env['ZIPNATIVE_MCP_MAX_ENTRIES'] = '11';
            __resetCeilingsForTests();
            try {
                await expect(createZipTool({ entries: many })).rejects.toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxEntries', configured: 11, observed: 12 } });
                await expect(createZipTool({ entries: many, limits: { maxEntries: 12 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED', data: { env: 'ZIPNATIVE_MCP_MAX_ENTRIES', ceiling: 11 } });
            } finally {
                delete process.env['ZIPNATIVE_MCP_MAX_ENTRIES'];
                __resetCeilingsForTests();
            }
            await expect(createZipTool({ entries: Array.from({ length: 100_001 }, (_, i) => ({ name: `e${i}`, text: 'x' })) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('includeSha256 reports the hash of the produced bytes', async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], includeSha256: true });
            expect(out.summary.sha256).toBe(createHash('sha256').update(bytesOfResult(out)).digest('hex'));
        });

        it('B-006: includeSha256 in file mode reports the sha256 of the written file, equal to the base64-mode digest', async () => {
            sandbox = await makeSandbox();
            const entries = [{ name: 'a.txt', text: 'a'.repeat(3000) }, { name: 'b.bin', dataBase64: Buffer.from(patternBytes(50_000)).toString('base64') }];
            const file = await createZipTool({ entries, includeSha256: true, outputMode: 'file', outputPath: 'hashed.zip', chunkSize: 4096 });
            expect(file.mode).toBe('file');
            const written = await fs.readFile(file.filePath as string);
            expect(file.summary.sha256).toBe(createHash('sha256').update(written).digest('hex'));
            const inline = await createZipTool({ entries, includeSha256: true });
            expect(file.summary.sha256).toBe(inline.summary.sha256);
            expect(bytesOfResult(inline).byteLength).toBe(written.byteLength);
            // Without the flag the file-mode summary carries no digest (byte-identical default response).
            const plain = await createZipTool({ entries, outputMode: 'file', outputPath: 'plain.zip' });
            expect(plain.summary.sha256).toBeUndefined();
            // Streamed sources are hashed while streaming too.
            const streamed = await createZipTool({ entries: [{ name: 'src.zip', sourcePath: 'hashed.zip', stream: true }], includeSha256: true, outputMode: 'file', outputPath: 'streamed.zip' });
            expect(streamed.summary.sha256).toBe(createHash('sha256').update(await fs.readFile(streamed.filePath as string)).digest('hex'));
        });
    });

    describe('B-011: a "/"-terminated name with a payload is refused like modify_zip', () => {
        it("create_zip: 'dir/' with text → VALIDATION_ERROR; 'dir/' with directory:true and no payload → ok", async () => {
            for (const payload of [{ text: 'x' }, { dataBase64: 'eA==' }, { sourcePath: 'p.bin' }] as const) {
                await expect(createZipTool({ entries: [{ name: 'dir/', ...payload }] }), JSON.stringify(payload)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining("ending in '/'") });
            }
            // An EMPTY payload on a '/' name is what the engine itself accepts (a directory entry of length 0).
            const out = await createZipTool({ entries: [{ name: 'dir/', directory: true }, { name: 'a.txt', text: 'a' }] });
            assertValidZip(out.base64 as string, 'dir-ok');
            expect(out.summary.directoryCount).toBe(1);
            expect((await listZipEntries({ zipBase64: out.base64 as string })).entries.find((e) => e.name === 'dir/')?.isDirectory).toBe(true);
        });

        it("modify_zip add: 'dir/' with text → VALIDATION_ERROR; 'dir/' with directory:true → ok", async () => {
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'dir/', text: 'x' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining("ending in '/'") });
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'replace', name: 'README.md', text: 'x' }, { op: 'add', name: 'dir/', dataBase64: 'AA==' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            const out = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'dir/', directory: true }] });
            assertValidZip(out.base64 as string, 'modify-dir-ok');
            expect(out.summary.entryCountAfter).toBe(5);
        });
    });

    describe('B-015: the determinism verdicts', () => {
        it("a default call is reproducible on this runtime but reports summary.deterministic false with deflateTier 'node-zlib'", async () => {
            const entries = [{ name: 'a.txt', text: 'deterministic '.repeat(200) }];
            const one = await createZipTool({ entries, includeSha256: true });
            const two = await createZipTool({ entries, includeSha256: true });
            expect(one.summary.deterministic).toBe(false);
            expect(one.summary.deflateTier).toBe('node-zlib');
            expect(one.summary.sha256).toBe(two.summary.sha256);
            // The structural verdict of inspect_zip is a different question (canonical defaults) and says true.
            expect((await inspectZip({ zipBase64: one.base64 as string })).determinism.deterministic).toBe(true);
        });

        it("compression.deterministic:true → summary.deterministic true with deflateTier 'pure-pinned'", async () => {
            const out = await createZipTool({ entries: [{ name: 'a.txt', text: 'deterministic '.repeat(200) }], compression: { deterministic: true } });
            expect(out.summary.deterministic).toBe(true);
            expect(out.summary.deflateTier).toBe('pure-pinned');
            // A stored-only archive needs no codec: the pin still decides the verdict.
            const stored = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], compression: { method: 'store' } });
            expect(stored.summary.deterministic).toBe(false);
        });
    });
});
