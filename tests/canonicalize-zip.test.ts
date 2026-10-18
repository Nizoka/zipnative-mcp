/**
 * canonicalize_zip (zipnative 1.1.0 canonicalizeZip) and modify_zip
 * `canonical` (saveCompact({ canonical })): the canonical deterministic form
 * of ANY archive, without recompression.
 */
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { analyzeDeterminism, openZip } from 'zipnative';

import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { canonicalizeZipTool } from '../src/tools/canonicalize-zip.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';
import { assertIsoConformant, assertValidZip } from './_zip-assert.js';
import { b64, basicZip, DUPLICATE_NAME, ENCRYPTED_FLAG, richZip } from './_zip-fixtures.js';

const INTEROP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'interop');
const foreign = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(INTEROP, name)));

function blobOf(r: Awaited<ReturnType<typeof callToolDirect>>): Uint8Array {
    expect(r.isError, (r.content[0] as { text?: string }).text).not.toBe(true);
    const block = r.content.find((c) => c.type === 'resource') as { resource: { blob: string } };
    return new Uint8Array(Buffer.from(block.resource.blob, 'base64'));
}

let sandbox: string | null = null;

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    await ensureEngineReady();
});

afterEach(async () => {
    await cleanupSandbox(sandbox);
    sandbox = null;
});

describe('canonicalize_zip', () => {
    it('rewrites foreign archives (bsdtar, PowerShell) into the canonical form the engine verifies, idempotently', async () => {
        for (const name of ['bsdtar-basic.zip', 'powershell-compress-archive-basic.zip']) {
            const source = foreign(name);
            expect(analyzeDeterminism(source).deterministic, name).toBe(false);
            const out = await canonicalizeZipTool({ zipBase64: b64(source), includeSha256: true });
            const bytes = new Uint8Array(Buffer.from(out.base64 as string, 'base64'));
            assertValidZip(bytes, name);
            assertIsoConformant(bytes, name);
            expect(out.summary).toMatchObject({ canonicalForm: true, alreadyCanonical: false, pinnedDate: null, keepComments: false, keepExternalAttributes: true, inputBytes: source.byteLength, outputBytes: bytes.byteLength });
            expect(out.summary.entryCount).toBe(openZip(source, { onDiagnostic: () => undefined }).entryCount);
            // Idempotent: the result is already canonical.
            const again = await canonicalizeZipTool({ zipBase64: out.base64 as string, includeSha256: true });
            expect(again.summary.alreadyCanonical).toBe(true);
            expect(again.summary.sha256).toBe(out.summary.sha256);
        }
    });

    it('no recompression: every payload keeps its compressed bytes, CRC and method', async () => {
        const source = richZip();
        const out = await canonicalizeZipTool({ zipBase64: b64(source), keepComments: true });
        const before = openZip(source, { onDiagnostic: () => undefined });
        const after = openZip(new Uint8Array(Buffer.from(out.base64 as string, 'base64')), { onDiagnostic: () => undefined });
        for (const e of before.entries()) {
            const twin = after.getEntry(e.name);
            expect(twin, e.name).not.toBeNull();
            expect([twin!.crc32, twin!.compressionMethod, twin!.compressedSize]).toEqual([e.crc32, e.compressionMethod, e.compressedSize]);
            expect(Buffer.from(after.readEntryRaw(twin!)).equals(Buffer.from(before.readEntryRaw(e)))).toBe(true);
        }
        // keepComments: true keeps the archive comment; the default drops it.
        expect(Buffer.from(after.comment).toString('utf8')).toContain('archive comment');
        const dropped = await canonicalizeZipTool({ zipBase64: b64(source) });
        expect(openZip(new Uint8Array(Buffer.from(dropped.base64 as string, 'base64')), { onDiagnostic: () => undefined }).comment.byteLength).toBe(0);
    });

    it('a pinned date is written as UTC on every entry and inspect_zip canonicalDate proves it', async () => {
        const out = await callToolDirect('canonicalize_zip', { zipBase64: b64(basicZip()), date: '2026-10-08T00:00:00Z', keepExternalAttributes: false });
        const bytes = blobOf(out);
        const summary = (out.structuredContent as { summary: { pinnedDate: string; canonicalForm: boolean } }).summary;
        expect(summary).toMatchObject({ pinnedDate: '2026-10-08T00:00:00.000Z', canonicalForm: true });
        for (const e of openZip(bytes, { onDiagnostic: () => undefined, dosTimeMode: 'utc' }).entries()) expect(e.lastModified.toISOString(), e.name).toBe('2026-10-08T00:00:00.000Z');
        const proof = await callToolDirect('inspect_zip', { zipBase64: b64(bytes), check: ['canonical-form'], canonicalDate: '2026-10-08T00:00:00Z' });
        expect((proof.structuredContent as { checksPassed: boolean }).checksPassed).toBe(true);
        const unpinned = await callToolDirect('inspect_zip', { zipBase64: b64(bytes), check: ['canonical-form'] });
        expect((unpinned.structuredContent as { checksPassed: boolean }).checksPassed).toBe(false);
    });

    it('refuses what the engine refuses: duplicate names, an out-of-range date, a malformed archive', async () => {
        const dup = await callToolDirect('canonicalize_zip', { zipBase64: b64(DUPLICATE_NAME()) });
        expect((dup._meta as { error: { code: string } }).error.code).toMatch(/^ZIP_/);
        const date = await callToolDirect('canonicalize_zip', { zipBase64: b64(basicZip()), date: '1975-07-15' });
        expect((date._meta as { error: { code: string; message: string } }).error).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect((date._meta as { error: { message: string } }).error.message).toContain('date must fall within the DOS date range');
        const bad = await callToolDirect('canonicalize_zip', { zipBase64: b64(new Uint8Array(64)) });
        expect((bad._meta as { error: { code: string } }).error.code).toMatch(/^ZIP_/);
        expect((await callToolDirect('canonicalize_zip', { zipBase64: b64(basicZip()), keepComments: 'yes' }))._meta).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    });

    it('an encrypted entry travels unchanged (nothing is decoded)', async () => {
        const out = await canonicalizeZipTool({ zipBase64: b64(ENCRYPTED_FLAG()) });
        const reader = openZip(new Uint8Array(Buffer.from(out.base64 as string, 'base64')), { onDiagnostic: () => undefined });
        expect(reader.getEntry('secret.txt')?.isEncrypted).toBe(true);
    });

    it('file mode writes into the sandbox and returns a resource link', async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'in.zip'), foreign('bsdtar-basic.zip'));
        const r = await callToolDirect('canonicalize_zip', { zipPath: 'in.zip', outputMode: 'file', outputPath: 'out/canonical.zip' });
        expect(r.isError).not.toBe(true);
        expect(r.content.some((c) => c.type === 'resource_link')).toBe(true);
        assertValidZip(new Uint8Array(await fs.readFile(path.join(sandbox, 'out', 'canonical.zip'))), 'file mode');
    });
});

describe('modify_zip canonical (saveCompact({ canonical }))', () => {
    it('applies the edits, then writes the canonical form; canonical without compact is VALIDATION_ERROR', async () => {
        const r = await callToolDirect('modify_zip', { zipBase64: b64(foreign('bsdtar-basic.zip')), operations: [{ op: 'add', name: 'added.txt', text: 'new' }], mode: 'compact', canonical: {} });
        const bytes = blobOf(r);
        expect(analyzeDeterminism(bytes).deterministic).toBe(true);
        expect((r.structuredContent as { summary: { canonical?: boolean; saveMode: string } }).summary).toMatchObject({ canonical: true, saveMode: 'compact' });
        expect(openZip(bytes, { onDiagnostic: () => undefined }).getEntry('added.txt')).not.toBeNull();
        // A plain compact keeps the order and the timestamps (and says nothing about canonical).
        const plain = await callToolDirect('modify_zip', { zipBase64: b64(foreign('bsdtar-basic.zip')), operations: [{ op: 'setComment', comment: '' }], mode: 'compact' });
        expect((plain.structuredContent as { summary: { canonical?: boolean } }).summary.canonical).toBeUndefined();
        const refused = await callToolDirect('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'x' }], canonical: {} });
        expect((refused._meta as { error: { code: string; message: string } }).error).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect((refused.content[0] as { text: string }).text).toContain("canonical applies to mode 'compact' only");
    });
});
