/**
 * Tests for `src/archive-input.ts` — zipBase64 XOR zipPath, buffered and
 * streamed loading, and the path-input detector.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, chunked, isPathInput, loadArchive, openArchiveSource, refineArchiveInput } from '../src/archive-input.js';
import { openInputFile } from '../src/sandbox.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';
import { b64, basicZip } from './_zip-fixtures.js';

const Schema = z.strictObject(ARCHIVE_INPUT_SHAPE).superRefine(refineArchiveInput);

async function collect(source: AsyncIterable<Uint8Array>): Promise<{ chunks: number; bytes: Buffer }> {
    const parts: Buffer[] = [];
    for await (const chunk of source) parts.push(Buffer.from(chunk));
    return { chunks: parts.length, bytes: Buffer.concat(parts) };
}

describe('archive-input', () => {
    let sandbox: string | null = null;

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    it('the Zod shape mirrors the JSON Schema and enforces the XOR', () => {
        expect(Object.keys(ARCHIVE_INPUT_PROPERTIES)).toEqual(Object.keys(ARCHIVE_INPUT_SHAPE));
        expect(Schema.safeParse({ zipBase64: 'UEsF' }).success).toBe(true);
        expect(Schema.safeParse({ zipPath: 'a.zip' }).success).toBe(true);
        expect(Schema.safeParse({}).success).toBe(false);
        expect(Schema.safeParse({ zipBase64: 'UEsF', zipPath: 'a.zip' }).success).toBe(false);
        expect(Schema.safeParse({ zipBase64: 'UEs' }).success).toBe(false);
        expect(Schema.safeParse({ zipPath: '' }).success).toBe(false);
        const issue = Schema.safeParse({});
        expect(issue.success ? '' : issue.error.issues[0]?.message).toBe('pass exactly one of zipBase64 / zipPath');
    });

    it('loadArchive decodes base64 (data: URI tolerated) and rejects agent mistakes', async () => {
        const bytes = basicZip();
        const loaded = await loadArchive({ zipBase64: b64(bytes) });
        expect(loaded.source).toBe('base64');
        expect(loaded.label).toBe('zipBase64');
        expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
        const uri = await loadArchive({ zipBase64: `data:application/zip;base64,${b64(bytes)}` });
        expect(uri.bytes.byteLength).toBe(bytes.byteLength);
        await expect(loadArchive({ zipBase64: '****' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(loadArchive({ zipBase64: Buffer.from(b64(bytes)).toString('base64') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('base64 encoded twice') });
        await expect(loadArchive({ zipBase64: Buffer.from('-----BEGIN CERT').toString('base64') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('PEM') });
        await expect(loadArchive({ zipBase64: Buffer.from('data:application/zip;base64,UEsF').toString('base64') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('nested data: URI') });
        await expect(loadArchive({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('loadArchive reads a sandbox path with the container extension allow-list', async () => {
        await expect(loadArchive({ zipPath: 'a.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        sandbox = await makeSandbox();
        const bytes = basicZip();
        await fs.writeFile(path.join(sandbox, 'in.docx'), bytes);
        const loaded = await loadArchive({ zipPath: 'in.docx' });
        expect(loaded.source).toBe('path');
        expect(loaded.label).toBe('in.docx');
        expect(Buffer.from(loaded.bytes).equals(Buffer.from(bytes))).toBe(true);
        await fs.writeFile(path.join(sandbox, 'in.bin'), bytes);
        await expect(loadArchive({ zipPath: 'in.bin' })).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
        await expect(loadArchive({ zipPath: 'missing.zip' })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND', data: { path: 'missing.zip' } });
        await expect(loadArchive({ zipPath: path.join(sandbox, 'in.docx') })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        await expect(loadArchive({ zipPath: 'a\0b.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('openInputFile refuses a directory as INPUT_NOT_FOUND', async () => {
        sandbox = await makeSandbox();
        await fs.mkdir(path.join(sandbox, 'dir.zip'));
        await expect(openInputFile('dir.zip', null, 'zipPath')).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND', message: expect.stringContaining('not a regular file') });
        await fs.writeFile(path.join(sandbox, 'f.zip'), basicZip());
        const ok = await openInputFile('f.zip', ['.zip']);
        expect({ resolved: ok.resolved, size: ok.size }).toEqual({ resolved: path.join(sandbox, 'f.zip'), size: basicZip().byteLength });
        await ok.close();
        await ok.close();
        await expect(openInputFile('', null, 'zipPath')).rejects.toMatchObject({ code: 'INVALID_PATH' });
        await expect(openInputFile(42, null, 'zipPath')).rejects.toMatchObject({ code: 'INVALID_PATH' });
        await expect(openInputFile('C:\\x.zip', null, 'zipPath')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        await expect(openInputFile('\\\\srv\\share\\x.zip', null, 'zipPath')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('chunked splits a buffer into bounded pieces', async () => {
        const data = new Uint8Array(150_000).map((_, i) => i & 0xff);
        const out = await collect(chunked(data));
        expect(out.chunks).toBe(3);
        expect(out.bytes.equals(Buffer.from(data))).toBe(true);
        expect((await collect(chunked(data, 100_000))).chunks).toBe(2);
        expect((await collect(chunked(new Uint8Array(0)))).chunks).toBe(0);
    });

    it('openArchiveSource streams base64 from memory and a path from disk', async () => {
        const bytes = basicZip();
        const fromB64 = await openArchiveSource({ zipBase64: b64(bytes) });
        expect(fromB64.label).toBe('zipBase64');
        expect(fromB64.sizeBytes).toBe(bytes.byteLength);
        expect((await collect(fromB64.source as AsyncIterable<Uint8Array>)).bytes.equals(Buffer.from(bytes))).toBe(true);
        await expect(openArchiveSource({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'in.zip'), bytes);
        const fromPath = await openArchiveSource({ zipPath: 'in.zip' });
        expect(fromPath.label).toBe('in.zip');
        expect(fromPath.sizeBytes).toBe(bytes.byteLength);
        expect((await collect(fromPath.source as AsyncIterable<Uint8Array>)).bytes.equals(Buffer.from(bytes))).toBe(true);
        await expect(openArchiveSource({ zipPath: 'missing.zip' })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
    });

    it('isPathInput detects sandbox references anywhere they can appear', () => {
        expect(isPathInput(null)).toBe(false);
        expect(isPathInput('x')).toBe(false);
        expect(isPathInput({})).toBe(false);
        expect(isPathInput({ zipBase64: 'UEsF' })).toBe(false);
        expect(isPathInput({ zipPath: 'a.zip' })).toBe(true);
        expect(isPathInput({ sourcePath: 'a.bin' })).toBe(true);
        expect(isPathInput({ entries: [{ name: 'a', text: 'x' }] })).toBe(false);
        expect(isPathInput({ entries: [{ name: 'a', text: 'x' }, { name: 'b', sourcePath: 'b.bin' }] })).toBe(true);
        expect(isPathInput({ zipBase64: 'UEsF', operations: [{ op: 'add', name: 'a', sourcePath: 'p' }] })).toBe(true);
        expect(isPathInput({ entries: 'nope' })).toBe(false);
        expect(isPathInput({ entries: [null, 1] })).toBe(false);
    });
});
