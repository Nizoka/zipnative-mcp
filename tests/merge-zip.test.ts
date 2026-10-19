/**
 * merge_zip (zipnative 1.1.0 ZipWriter.addFromReader): several archives into
 * one without recompression, every entry verified before it is copied.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createZip, openZip } from 'zipnative';

import { MAX_MERGE_SOURCES } from '../src/caps.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { mergeZipTool } from '../src/tools/merge-zip.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';
import { assertIsoConformant, assertValidZip } from './_zip-assert.js';
import { b64, basicZip, CRC_OVERRIDE, ENCRYPTED_FLAG, richZip } from './_zip-fixtures.js';

function zipOf(files: Record<string, string>): Uint8Array {
    const w = createZip({ onDiagnostic: () => undefined });
    for (const [name, text] of Object.entries(files)) w.add(name, text);
    return w.toBytes();
}

const decode = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));
const codeOf = (r: Awaited<ReturnType<typeof callToolDirect>>): string | undefined => (r._meta as { error?: { code?: string } } | undefined)?.error?.code;

let sandbox: string | null = null;

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    await ensureEngineReady();
});

afterEach(async () => {
    await cleanupSandbox(sandbox);
    sandbox = null;
});

describe('merge_zip', () => {
    it('merges without recompression: payloads, CRCs and methods travel unchanged; the result is ISO-conformant', async () => {
        const a = basicZip();
        const b = zipOf({ 'other/x.txt': 'x', 'other/y.txt': 'y' });
        const out = await mergeZipTool({ sources: [{ zipBase64: b64(a) }, { zipBase64: b64(b) }], includeSha256: true });
        const merged = decode(out.base64 as string);
        assertValidZip(merged, 'merged');
        assertIsoConformant(merged, 'merged');
        const reader = openZip(merged, { onDiagnostic: () => undefined });
        for (const source of [a, b]) {
            const r = openZip(source, { onDiagnostic: () => undefined });
            for (const e of r.entries()) {
                const twin = reader.getEntry(e.name);
                expect(twin, e.name).not.toBeNull();
                expect([twin!.crc32, twin!.compressionMethod, twin!.compressedSize]).toEqual([e.crc32, e.compressionMethod, e.compressedSize]);
                expect(Buffer.from(reader.readEntryRaw(twin!)).equals(Buffer.from(r.readEntryRaw(e)))).toBe(true);
            }
        }
        expect(out.summary).toMatchObject({ sourceCount: 2, entryCount: 6, onConflict: 'error', verified: true, order: 'canonical', dropped: [] });
        expect(out.summary.perSource.map((s) => [s.label, s.entryCount, s.taken, s.filteredOut, s.dropped])).toEqual([['zipBase64', 4, 4, 0, 0], ['zipBase64', 2, 2, 0, 0]]);
        // Canonical order: sorted by raw name bytes, like create_zip.
        const names = [...reader.entries()].map((e) => e.name);
        expect(names).toEqual([...names].sort());
        // Deterministic given the same sources.
        expect((await mergeZipTool({ sources: [{ zipBase64: b64(a) }, { zipBase64: b64(b) }], includeSha256: true })).summary.sha256).toBe(out.summary.sha256);
    });

    it("onConflict: 'error' (default) is the engine's ZIP_DUPLICATE_ENTRY_NAME; 'first' / 'last' keep one and report the other", async () => {
        const one = zipOf({ 'a.txt': 'one', 'b.txt': 'b' });
        const two = zipOf({ 'a.txt': 'two', 'c.txt': 'c' });
        const refused = await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(one) }, { zipBase64: b64(two) }] });
        expect(codeOf(refused)).toBe('ZIP_DUPLICATE_ENTRY_NAME');
        expect((refused._meta as { error: { data: { sourceIndex?: number } } }).error.data.sourceIndex).toBe(1);
        for (const [policy, kept, loser] of [['first', 'one', 1], ['last', 'two', 0]] as const) {
            const out = await mergeZipTool({ sources: [{ zipBase64: b64(one) }, { zipBase64: b64(two) }], onConflict: policy });
            const reader = openZip(decode(out.base64 as string), { onDiagnostic: () => undefined });
            expect(Buffer.from(reader.readEntry('a.txt')).toString('utf8'), policy).toBe(kept);
            expect(out.summary.entryCount).toBe(3);
            expect(out.summary.dropped).toEqual([{ name: 'a.txt', source: loser }]);
            expect(out.summary.perSource[loser]!.dropped).toBe(1);
        }
    });

    it('per-source filters select entries; directories are kept unless the filter excludes them; insertion order is kept on request', async () => {
        const out = await mergeZipTool({ sources: [{ zipBase64: b64(basicZip()), filter: { prefix: 'docs/' } }, { zipBase64: b64(richZip()), filter: { glob: ['*.sh'] } }], order: 'insertion' });
        const names = [...openZip(decode(out.base64 as string), { onDiagnostic: () => undefined }).entries()].map((e) => e.name);
        expect(names).toEqual(['docs/guide.md', 'bin/run.sh']);
        expect(out.summary.perSource[0]!.filteredOut).toBe(3);
        const withDirs = await mergeZipTool({ sources: [{ zipBase64: b64(basicZip()) }] });
        expect([...openZip(decode(withDirs.base64 as string), { onDiagnostic: () => undefined }).entries()].some((e) => e.isDirectory)).toBe(true);
    });

    it('verify (default): a corrupt payload is refused with its code, never propagated; verify: false trusts the source', async () => {
        const refused = await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(CRC_OVERRIDE()) }] });
        expect(codeOf(refused)).toBe('ZIP_CRC_MISMATCH');
        const trusted = await mergeZipTool({ sources: [{ zipBase64: b64(CRC_OVERRIDE()) }], verify: false });
        expect(trusted.summary.verified).toBe(false);
        expect(trusted.summary.entryCount).toBe(1);
    });

    it('an encrypted entry is refused (it cannot be read raw); filtering it out lets the rest through', async () => {
        expect(codeOf(await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(ENCRYPTED_FLAG()) }] }))).toBe('ZIP_UNSUPPORTED_ENCRYPTION');
        const out = await mergeZipTool({ sources: [{ zipBase64: b64(ENCRYPTED_FLAG()), filter: { names: ['ok.txt'] } }] });
        expect(out.summary.entryCount).toBe(1);
    });

    it('validation: 1–32 sources, exactly one input form each, strict objects', async () => {
        expect(codeOf(await callToolDirect('merge_zip', { sources: [] }))).toBe('VALIDATION_ERROR');
        expect(codeOf(await callToolDirect('merge_zip', { sources: Array.from({ length: MAX_MERGE_SOURCES + 1 }, () => ({ zipBase64: b64(basicZip()) })) }))).toBe('VALIDATION_ERROR');
        expect(codeOf(await callToolDirect('merge_zip', { sources: [{}] }))).toBe('VALIDATION_ERROR');
        expect(codeOf(await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(basicZip()), extra: 1 }] }))).toBe('VALIDATION_ERROR');
        expect(codeOf(await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(basicZip()) }], onConflict: 'merge' }))).toBe('VALIDATION_ERROR');
    });

    it('sandbox sources and a streamed file output; a path input is never cached', async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'a.zip'), basicZip());
        await fs.writeFile(path.join(sandbox, 'b.zip'), zipOf({ 'z.txt': 'z' }));
        const r = await callToolDirect('merge_zip', { sources: [{ zipPath: 'a.zip' }, { zipPath: 'b.zip' }], outputMode: 'file', outputPath: 'merged/all.zip', includeSha256: true });
        expect(r.isError, (r.content[0] as { text: string }).text).not.toBe(true);
        const written = new Uint8Array(await fs.readFile(path.join(sandbox, 'merged', 'all.zip')));
        assertValidZip(written, 'merged file');
        const summary = (r.structuredContent as { summary: { entryCount: number; outputBytes: number; perSource: Array<{ label: string }> } }).summary;
        expect(summary.entryCount).toBe(5);
        expect(summary.outputBytes).toBe(written.byteLength);
        expect(summary.perSource.map((s) => s.label)).toEqual(['a.zip', 'b.zip']);
        expect(r._meta?.['cached']).toBeUndefined();
    });
});
