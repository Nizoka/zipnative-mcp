/**
 * Tests for `modify_zip` — incremental edits in append and compact mode,
 * data remanence, the engine's entry-level refusals and the file-mode chain.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { modifyZipTool } from '../src/tools/modify-zip.js';
import { createZipTool } from '../src/tools/create-zip.js';
import { inspectZip } from '../src/tools/inspect-zip.js';
import { listZipEntries } from '../src/tools/list-zip-entries.js';
import { readZipEntry } from '../src/tools/read-zip-entry.js';
import { verifyZipTool } from '../src/tools/verify-zip.js';
import { callToolDirect } from '../src/server.js';
import { assertValidZip } from './_zip-assert.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { b64, basicZip, richZip, raw, SFX_PREFIXED } from './_zip-fixtures.js';

const README = '# Hello\n\nA small archive for the tests.\n';
const RICH_COMMENT = 'archive comment — ünïcödé';

function bytesOf(base64: string | undefined): Buffer {
    return Buffer.from(base64 ?? '', 'base64');
}

async function names(zipBase64: string): Promise<string[]> {
    return (await listZipEntries({ zipBase64 })).entries.map((e) => e.name);
}

async function textOf(zipBase64: string, name: string): Promise<string> {
    return (await readZipEntry({ zipBase64, name, encoding: 'utf8' })).text as string;
}

describe('modify_zip', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    const OPERATIONS = [
        { op: 'add', name: 'new.txt', text: 'added' },
        { op: 'replace', name: 'README.md', text: '# Replaced\n' },
        { op: 'remove', name: 'docs/guide.md' },
        { op: 'rename', from: 'src/index.js', to: 'lib/index.js' },
        { op: 'setComment', comment: 'edited' },
    ];

    it.each(['append', 'compact'] as const)('applies add / replace / remove / rename / setComment (%s)', async (mode) => {
        const out = await modifyZipTool({ zipBase64: b64(basicZip()), operations: OPERATIONS, mode, includeSha256: true });
        expect(out.mode).toBe('base64');
        expect(out.summary).toMatchObject({ saveMode: mode, operationsApplied: 5, entryCountBefore: 4, entryCountAfter: 4, inputBytes: basicZip().byteLength, outputBytes: out.sizeBytes, noOp: false });
        expect(out.summary.grewByBytes).toBe(out.sizeBytes - basicZip().byteLength);
        expect(out.summary.sha256).toBe(createHash('sha256').update(bytesOf(out.base64)).digest('hex'));
        assertValidZip(out.base64 as string, `modify-${mode}`);
        expect((await names(out.base64 as string)).sort()).toEqual(['README.md', 'assets/', 'lib/index.js', 'new.txt']);
        expect(await textOf(out.base64 as string, 'README.md')).toBe('# Replaced\n');
        expect(await textOf(out.base64 as string, 'new.txt')).toBe('added');
        expect(await textOf(out.base64 as string, 'lib/index.js')).toBe('export const answer = 42;\n');
        expect((await inspectZip({ zipBase64: out.base64 as string })).comment).toBe('edited');
        const verified = await verifyZipTool({ zipBase64: out.base64 as string });
        expect(verified.ok).toBe(true);
    });

    describe('data remanence', () => {
        it('append mode keeps the original bytes as a prefix, superseded payloads included', async () => {
            const original = basicZip();
            const out = await modifyZipTool({ zipBase64: b64(original), operations: [{ op: 'replace', name: 'README.md', text: '# Replaced\n' }] });
            const bytes = bytesOf(out.base64);
            expect(bytes.subarray(0, original.byteLength).equals(Buffer.from(original))).toBe(true);
            expect(bytes.includes(Buffer.from(README))).toBe(true);
            expect(await textOf(out.base64 as string, 'README.md')).toBe('# Replaced\n');
            expect(out.summary.grewByBytes).toBeGreaterThan(0);
            assertValidZip(out.base64 as string, 'remanence-append');
        });

        it('compact mode drops removed content', async () => {
            const out = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'README.md' }], mode: 'compact' });
            const bytes = bytesOf(out.base64);
            expect(bytes.includes(Buffer.from(README))).toBe(false);
            expect(bytes.includes(Buffer.from('README.md'))).toBe(false);
            expect(out.summary.entryCountAfter).toBe(3);
            expect(out.summary.grewByBytes).toBeLessThan(0);
            assertValidZip(out.base64 as string, 'remanence-compact');
            const appended = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'README.md' }] });
            expect(bytesOf(appended.base64).includes(Buffer.from(README))).toBe(true);
            expect(await names(appended.base64 as string)).not.toContain('README.md');
        });

        it('ZIP_DEAD_BYTES_RATIO fires when most of an append-mode output is dead', async () => {
            const source = await createZipTool({ entries: [{ name: 'big.bin', dataBase64: Buffer.from(patternBytes(8192)).toString('base64'), compression: { method: 'store' } }, { name: 'tiny.txt', text: 't' }] });
            const out = await modifyZipTool({ zipBase64: source.base64 as string, operations: [{ op: 'remove', name: 'big.bin' }] });
            expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_DEAD_BYTES_RATIO');
            expect(out.diagnosticCounts['ZIP_DEAD_BYTES_RATIO']).toBe(1);
            expect(out.summary.entryCountAfter).toBe(1);
            assertValidZip(out.base64 as string, 'dead-bytes');
            const compact = await modifyZipTool({ zipBase64: source.base64 as string, operations: [{ op: 'remove', name: 'big.bin' }], mode: 'compact' });
            expect(compact.diagnostics).toEqual([]);
            expect(compact.sizeBytes).toBeLessThan(out.sizeBytes);
            await expect(modifyZipTool({ zipBase64: source.base64 as string, operations: [{ op: 'remove', name: 'big.bin' }], strict: true })).rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
        });

        it('an unchanged comment and no edits is a no-op returning the same bytes', async () => {
            const out = await modifyZipTool({ zipBase64: b64(richZip()), operations: [{ op: 'setComment', comment: RICH_COMMENT }] });
            expect(out.summary.noOp).toBe(true);
            expect(out.summary.grewByBytes).toBe(0);
            expect(bytesOf(out.base64).equals(Buffer.from(richZip()))).toBe(true);
            const changed = await modifyZipTool({ zipBase64: b64(richZip()), operations: [{ op: 'setComment', comment: 'other' }] });
            expect(changed.summary.noOp).toBe(false);
            expect((await inspectZip({ zipBase64: changed.base64 as string })).comment).toBe('other');
            assertValidZip(changed.base64 as string, 'comment');
        });
    });

    describe('entry-level refusals', () => {
        it('add on an existing name is ZIP_ENTRY_EXISTS with the operation index', async () => {
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'docs/guide.md' }, { op: 'add', name: 'README.md', text: 'x' }] })).rejects.toMatchObject({
                code: 'ZIP_ENTRY_EXISTS',
                data: { errorClass: 'input', entryName: 'README.md', operationIndex: 1, op: 'add' },
            });
        });

        it('replace / remove / rename of a missing entry is ZIP_ENTRY_NOT_FOUND', async () => {
            for (const [i, op] of [{ op: 'replace', name: 'nope', text: 'x' }, { op: 'remove', name: 'nope' }, { op: 'rename', from: 'nope', to: 'other' }].entries()) {
                await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'c' }, op] }), op.op).rejects.toMatchObject({
                    code: 'ZIP_ENTRY_NOT_FOUND',
                    data: { errorClass: 'not-found', entryName: 'nope', operationIndex: 1, op: op.op },
                });
                void i;
            }
        });

        it('rename never overwrites', async () => {
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'rename', from: 'README.md', to: 'src/index.js' }] })).rejects.toMatchObject({
                code: expect.stringMatching(/^ZIP_/),
                data: { operationIndex: 0, op: 'rename' },
            });
            const ok = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'src/index.js' }, { op: 'rename', from: 'README.md', to: 'src/index.js' }] });
            expect(await textOf(ok.base64 as string, 'src/index.js')).toBe(README);
            assertValidZip(ok.base64 as string, 'rename-over');
        });

        it('an archive with duplicate names is refused', async () => {
            await expect(modifyZipTool({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }])), operations: [{ op: 'remove', name: 'a' }] })).rejects.toMatchObject({
                code: 'ZIP_DUPLICATE_ENTRY_NAME',
                data: { errorClass: 'input' },
            });
        });

        it('the engine refuses invalid new names', async () => {
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: '../x', text: 'x' }] })).rejects.toMatchObject({ code: 'ZIP_INVALID_ENTRY_NAME', data: { operationIndex: 0 } });
        });

        it('wire level: the operation index reaches _meta.error.data', async () => {
            const r = await callToolDirect('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'nope' }] });
            expect(r.isError).toBe(true);
            expect((r._meta as { error: { code: string; data: Record<string, unknown> } }).error).toMatchObject({ code: 'ZIP_ENTRY_NOT_FOUND', data: { operationIndex: 0, op: 'remove' } });
        });
    });

    describe('payloads and options', () => {
        it('adds a directory entry and a sandbox-file payload', async () => {
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'payload.bin'), Buffer.from([1, 2, 3, 4]));
            const out = await modifyZipTool({
                zipBase64: b64(basicZip()),
                operations: [
                    { op: 'add', name: 'newdir', directory: true },
                    { op: 'add', name: 'from-disk.bin', sourcePath: 'payload.bin', compression: { method: 'store' }, unixMode: '0600', comment: 'note' },
                    { op: 'add', name: 'b64.bin', dataBase64: Buffer.from([9]).toString('base64') },
                ],
                mode: 'compact',
            });
            assertValidZip(out.base64 as string, 'payloads');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            const byName = new Map(list.entries.map((e) => [e.name, e]));
            expect(byName.get('newdir/')?.isDirectory).toBe(true);
            expect(byName.get('from-disk.bin')).toMatchObject({ method: 0, uncompressedSize: 4, unixMode: '0600', comment: 'note' });
            expect((await readZipEntry({ zipBase64: out.base64 as string, name: 'from-disk.bin' })).dataBase64).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
            expect(byName.get('b64.bin')?.uncompressedSize).toBe(1);
            expect(out.summary.entryCountAfter).toBe(7);
        });

        it("defaultDate 'now' and compression settings apply to written entries", async () => {
            const out = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'n.txt', text: 'n'.repeat(500) }], defaultDate: 'now', compression: { method: 'store' } });
            expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_TIMESTAMP_NOT_PINNED');
            const list = await listZipEntries({ zipBase64: out.base64 as string });
            expect(list.entries.find((e) => e.name === 'n.txt')?.method).toBe(0);
            assertValidZip(out.base64 as string, 'now');
            const dated = await modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'n.txt', text: 'n', date: '2030-01-01T00:00:00Z' }], defaultDate: '2025-01-01T00:00:00Z' });
            expect(dated.diagnostics).toEqual([]);
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'n.txt', text: 'n' }], defaultDate: '1970-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('validates the operations list', async () => {
            const zipBase64 = b64(basicZip());
            await expect(modifyZipTool({ zipBase64, operations: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64, operations: [{ op: 'delete', name: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64, operations: [{ op: 'replace', name: 'assets', directory: true }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64, operations: [{ op: 'add', name: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64, operations: [{ op: 'rename', from: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ zipBase64, operations: Array.from({ length: 1001 }, () => ({ op: 'setComment', comment: 'c' })) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(modifyZipTool({ operations: [{ op: 'setComment', comment: 'c' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('limits apply when opening the source; the ceiling is enforced', async () => {
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'c' }], limits: { maxEntries: 1 } })).rejects.toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED' });
            await expect(modifyZipTool({ zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'c' }], limits: { maxEntries: 200_000 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        });
    });

    describe('SFX prefix', () => {
        it('append keeps the prefix; compact drops it', async () => {
            const appended = await modifyZipTool({ zipBase64: b64(SFX_PREFIXED()), operations: [{ op: 'add', name: 'n.txt', text: 'n' }] });
            expect(bytesOf(appended.base64).subarray(0, 8).toString()).toBe('MZ-STUB-');
            const inspectedA = await inspectZip({ zipBase64: appended.base64 as string });
            expect(inspectedA.prependedData).toBe(true);
            expect(inspectedA.entryCount).toBe(2);
            expect(appended.diagnostics.map((d) => d.code)).toContain('ZIP_PREPENDED_DATA');
            const compacted = await modifyZipTool({ zipBase64: b64(SFX_PREFIXED()), operations: [{ op: 'add', name: 'n.txt', text: 'n' }], mode: 'compact' });
            expect(bytesOf(compacted.base64).subarray(0, 2).toString('latin1')).toBe('PK');
            const inspectedC = await inspectZip({ zipBase64: compacted.base64 as string });
            expect(inspectedC.prependedData).toBe(false);
            expect(inspectedC.entryCount).toBe(2);
            assertValidZip(compacted.base64 as string, 'sfx-compact');
            expect(await textOf(compacted.base64 as string, 'a.txt')).toBe('sfx');
        });
    });

    describe('file mode and zipPath chaining', () => {
        it('create (file) → modify via zipPath (file) → verify via zipPath', async () => {
            sandbox = await makeSandbox();
            const created = await createZipTool({ entries: [{ name: 'a.txt', text: 'a' }], outputMode: 'file', outputPath: 'chain/v1.zip' });
            expect(created.mode).toBe('file');
            const modified = await modifyZipTool({ zipPath: 'chain/v1.zip', operations: [{ op: 'add', name: 'b.txt', text: 'b' }], outputMode: 'file', outputPath: 'chain/v2.zip', includeSha256: true });
            expect(modified.mode).toBe('file');
            expect(modified.filePath).toBe(path.join(sandbox, 'chain', 'v2.zip'));
            expect(modified.base64).toBeUndefined();
            expect(modified.summary).toMatchObject({ entryCountBefore: 1, entryCountAfter: 2, noOp: false });
            const bytes = new Uint8Array(await fs.readFile(modified.filePath as string));
            expect(modified.summary.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
            assertValidZip(bytes, 'chain-v2');
            const verified = await verifyZipTool({ zipPath: 'chain/v2.zip' });
            expect(verified.ok).toBe(true);
            expect(verified.entryCount).toBe(2);
            await expect(modifyZipTool({ zipPath: 'chain/v1.zip', operations: [{ op: 'setComment', comment: 'c' }], outputMode: 'file', outputPath: 'chain/v2.zip' })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
            await expect(modifyZipTool({ zipPath: 'chain/v1.zip', operations: [{ op: 'setComment', comment: 'c' }], outputMode: 'file' })).rejects.toMatchObject({ code: 'MISSING_OUTPUT_PATH' });
            await expect(modifyZipTool({ zipPath: 'chain/v1.zip', operations: [{ op: 'setComment', comment: 'c' }], outputMode: 'file', outputPath: 'chain/v3.exe' })).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
            const r = await callToolDirect('modify_zip', { zipPath: 'chain/v1.zip', operations: [{ op: 'setComment', comment: 'wire' }], outputMode: 'file', outputPath: 'chain/v4.zip' });
            expect(r.content[1]).toMatchObject({ type: 'resource_link', uri: 'zipnative://output/chain/v4.zip' });
        });

        it('base64 output arrives as an embedded resource on the wire', async () => {
            const r = await callToolDirect('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'wire' }] });
            expect(r.isError).toBeUndefined();
            const resource = r.content[1] as { type: string; resource: { blob: string; mimeType: string } };
            expect(resource.type).toBe('resource');
            assertValidZip(resource.resource.blob, 'wire');
            expect(r.structuredContent).toMatchObject({ mode: 'base64', summary: { saveMode: 'append', operationsApplied: 1 } });
        });
    });
});
