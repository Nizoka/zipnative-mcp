/**
 * Tests for `list_zip_entries` — paging, filters, the EntryView row and the
 * summary projection.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { listZipEntries, listSummary } from '../src/tools/list-zip-entries.js';
import { callToolDirect } from '../src/server.js';
import { b64, basicZip, bytesOf, richZip, raw, ZIP_SLIP, SYMLINK, ENCRYPTED_FLAG, OVERLAP, SFX_PREFIXED } from './_zip-fixtures.js';

describe('list_zip_entries', () => {
    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    describe('paging', () => {
        it('lists every entry (directories included) in central-directory order', async () => {
            const out = await listZipEntries({ zipBase64: b64(basicZip()) });
            expect(out.entryCount).toBe(4);
            expect(out.matchedCount).toBe(4);
            expect(out.offset).toBe(0);
            expect(out.limit).toBe(200);
            expect(out.returnedCount).toBe(4);
            expect(out.hasMore).toBe(false);
            expect(out.isZip64).toBe(false);
            expect(out.entries.map((e) => e.name)).toEqual(['README.md', 'assets/', 'docs/guide.md', 'src/index.js']);
            expect(out.entries.map((e) => e.index)).toEqual([0, 1, 2, 3]);
            expect(out.diagnostics).toEqual([]);
        });

        it('pages with offset / limit and reports hasMore', async () => {
            const p1 = await listZipEntries({ zipBase64: b64(basicZip()), limit: 2 });
            expect(p1.returnedCount).toBe(2);
            expect(p1.hasMore).toBe(true);
            expect(p1.entries.map((e) => e.name)).toEqual(['README.md', 'assets/']);
            const p2 = await listZipEntries({ zipBase64: b64(basicZip()), limit: 2, offset: 2 });
            expect(p2.returnedCount).toBe(2);
            expect(p2.hasMore).toBe(false);
            expect(p2.entries.map((e) => e.index)).toEqual([2, 3]);
            const beyond = await listZipEntries({ zipBase64: b64(basicZip()), offset: 10 });
            expect(beyond.returnedCount).toBe(0);
            expect(beyond.hasMore).toBe(false);
            expect(beyond.matchedCount).toBe(4);
        });

        it('rejects a limit above the cap and a negative offset', async () => {
            await expect(listZipEntries({ zipBase64: b64(basicZip()), limit: 2001 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(listZipEntries({ zipBase64: b64(basicZip()), limit: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(listZipEntries({ zipBase64: b64(basicZip()), offset: -1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('filter', () => {
        it('filters by prefix (files only unless includeDirectories)', async () => {
            const out = await listZipEntries({ zipBase64: b64(basicZip()), filter: { prefix: 'src/' } });
            expect(out.matchedCount).toBe(1);
            expect(out.entries[0]?.name).toBe('src/index.js');
            expect(out.entryCount).toBe(4);
        });

        it('a filter without includeDirectories drops directory entries', async () => {
            const out = await listZipEntries({ zipBase64: b64(basicZip()), filter: {} });
            expect(out.entries.map((e) => e.name)).toEqual(['README.md', 'docs/guide.md', 'src/index.js']);
            const withDirs = await listZipEntries({ zipBase64: b64(basicZip()), filter: { includeDirectories: true } });
            expect(withDirs.matchedCount).toBe(4);
        });

        it('filters by exact names and by glob', async () => {
            const names = await listZipEntries({ zipBase64: b64(basicZip()), filter: { names: ['README.md', 'assets', 'missing'], includeDirectories: true } });
            expect(names.entries.map((e) => e.name)).toEqual(['README.md', 'assets/']);
            const glob = await listZipEntries({ zipBase64: b64(basicZip()), filter: { glob: ['*.md'] } });
            expect(glob.entries.map((e) => e.name)).toEqual(['README.md', 'docs/guide.md']);
            const subtree = await listZipEntries({ zipBase64: b64(basicZip()), filter: { glob: ['docs/'] } });
            expect(subtree.entries.map((e) => e.name)).toEqual(['docs/guide.md']);
            const both = await listZipEntries({ zipBase64: b64(basicZip()), filter: { prefix: 'docs/', glob: ['**/*.js'] } });
            expect(both.matchedCount).toBe(0);
        });

        it('keeps every duplicate of a name', async () => {
            const out = await listZipEntries({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }, { name: 'b' }])), filter: { names: ['a'] } });
            expect(out.matchedCount).toBe(2);
            expect(out.entries.map((e) => e.index)).toEqual([0, 1]);
        });
    });

    describe('rows', () => {
        it('duplicates are visible in the inventory', async () => {
            const out = await listZipEntries({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }])) });
            expect(out.entryCount).toBe(2);
            expect(out.entries.map((e) => e.name)).toEqual(['a', 'a']);
        });

        it('exposes unix mode, host system, comments, extra fields and hex forms on richZip', async () => {
            const out = await listZipEntries({ zipBase64: b64(richZip()), includeExtraData: true });
            const byName = new Map(out.entries.map((e) => [e.name, e]));
            const run = byName.get('bin/run.sh');
            expect(run?.unixMode).toBe('0755');
            expect(run?.hostSystem).toBe('unix');
            expect(run?.isSymlink).toBe(false);
            expect(run?.versionMadeBy).toBeDefined();
            expect(run?.externalAttributes).toBe((0o100755 << 16) >>> 0);
            const readme = byName.get('README.md');
            expect(readme?.comment).toBe('entry comment');
            expect(readme?.commentHex).toBe(Buffer.from('entry comment').toString('hex'));
            expect(readme?.lastModified).toBe('2024-06-01T12:34:56.000Z');
            expect(readme?.unixMode).toBe('0644');
            const cafe = byName.get('café/résumé.txt');
            expect(cafe?.nameEncoding).toBe('utf-8');
            expect(cafe?.flags.utf8).toBe(true);
            expect(cafe?.rawNameHex).toBe(Buffer.from('café/résumé.txt', 'utf8').toString('hex'));
            expect(cafe?.extraFields).toEqual([{ id: 0x6a6a, idHex: '0x6a6a', name: null, length: 3, dataBase64: Buffer.from([1, 2, 3]).toString('base64') }]);
            const assets = byName.get('assets/');
            expect(assets?.isDirectory).toBe(true);
            expect(assets?.unixMode).toBe('0755');
            expect(assets?.sanitizedPath).toBe('assets');
            const empty = byName.get('empty.txt');
            expect(empty?.uncompressedSize).toBe(0);
            expect(empty?.ratio).toBe('0%');
            expect(empty?.crc32).toBe('00000000');
        });

        it('omits extra-field payloads unless includeExtraData', async () => {
            const out = await listZipEntries({ zipBase64: b64(richZip()) });
            const cafe = out.entries.find((e) => e.name === 'café/résumé.txt');
            expect(cafe?.extraFields).toEqual([{ id: 0x6a6a, idHex: '0x6a6a', name: null, length: 3 }]);
        });

        it('decodes the row for a deflated entry: method, sizes, ratio, crc hex, flags', async () => {
            const out = await listZipEntries({ zipBase64: b64(basicZip()) });
            const guide = out.entries.find((e) => e.name === 'docs/guide.md');
            expect(guide).toMatchObject({ method: 8, methodName: 'deflate', isEncrypted: false, usesZip64: false, usesDataDescriptor: false, isDirectory: false, nameEncoding: 'utf-8' });
            expect(guide?.compressedSize).toBeLessThan(guide?.uncompressedSize ?? 0);
            expect(guide?.ratio).toMatch(/^\d+%$/);
            expect(guide?.crc32).toMatch(/^[0-9a-f]{8}$/);
            expect(guide?.flags).toEqual({ raw: 0x0800, encrypted: false, dataDescriptor: false, strongEncryption: false, utf8: true });
            expect(guide?.localHeaderOffset).toBeGreaterThan(0);
            expect(guide?.dosDate).toBe(0x0021);
            expect(guide?.dosTime).toBe(0);
            expect(guide?.sanitizedPath).toBe('docs/guide.md');
            expect(typeof guide?.versionNeeded).toBe('number');
            expect(typeof guide?.internalAttributes).toBe('number');
        });

        it('reports a null sanitizedPath for a zip-slip name and cp437 for unflagged names', async () => {
            const out = await listZipEntries({ zipBase64: b64(ZIP_SLIP()) });
            expect(out.entries[0]?.name).toBe('../../evil.txt');
            expect(out.entries[0]?.sanitizedPath).toBeNull();
            expect(out.entries[0]?.nameEncoding).toBe('cp437');
            expect(out.entries[0]?.flags.utf8).toBe(false);
        });

        it('flags symlinks and encrypted entries', async () => {
            const link = await listZipEntries({ zipBase64: b64(SYMLINK()) });
            expect(link.entries.map((e) => [e.name, e.isSymlink, e.unixMode])).toEqual([['link', true, '0777'], ['ok.txt', false, '0000']]);
            const enc = await listZipEntries({ zipBase64: b64(ENCRYPTED_FLAG()) });
            expect(enc.entries[0]).toMatchObject({ name: 'secret.txt', isEncrypted: true });
            expect(enc.entries[0]?.flags.encrypted).toBe(true);
        });

        it('a DOS-authored entry has no unix mode', async () => {
            const out = await listZipEntries({ zipBase64: b64(raw([{ name: 'dos.txt', data: bytesOf('x'), versionMadeBy: 0x0014 }])) });
            expect(out.entries[0]?.unixMode).toBeNull();
            expect(out.entries[0]?.hostSystem).toBe('ms-dos');
        });
    });

    describe('validation and diagnostics', () => {
        it('is lazy by default (overlap not refused) and eager on request', async () => {
            const lazy = await listZipEntries({ zipBase64: b64(OVERLAP()) });
            expect(lazy.entryCount).toBe(2);
            await expect(listZipEntries({ zipBase64: b64(OVERLAP()), validate: 'eager' })).rejects.toMatchObject({ code: 'ZIP_ENTRY_OVERLAP' });
        });

        it('carries diagnostics and honours strict', async () => {
            const out = await listZipEntries({ zipBase64: b64(SFX_PREFIXED()) });
            expect(out.diagnostics.map((d) => d.code)).toEqual(['ZIP_PREPENDED_DATA']);
            await expect(listZipEntries({ zipBase64: b64(SFX_PREFIXED()), strict: true })).rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
        });

        it('applies limits and the ceiling', async () => {
            await expect(listZipEntries({ zipBase64: b64(basicZip()), limits: { maxEntries: 2 } })).rejects.toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED' });
            await expect(listZipEntries({ zipBase64: b64(basicZip()), limits: { maxEntryUncompressedSize: 2 ** 40 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        });

        it('enforces the input XOR', async () => {
            await expect(listZipEntries({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('summary', () => {
        it('summary keeps counts and the page names', async () => {
            const full = await listZipEntries({ zipBase64: b64(basicZip()), limit: 2 });
            expect(listSummary(full)).toEqual({ entryCount: 4, matchedCount: 4, returnedCount: 2, hasMore: true, isZip64: false, names: ['README.md', 'assets/'], diagnosticCount: 0 });
            const r = await callToolDirect('list_zip_entries', { zipBase64: b64(basicZip()), verbosity: 'summary', fields: ['names'] });
            expect(r.structuredContent).toEqual({ names: ['README.md', 'assets/', 'docs/guide.md', 'src/index.js'] });
            const rows = await callToolDirect('list_zip_entries', { zipBase64: b64(basicZip()), fields: ['entries.name', 'hasMore'] });
            expect(rows.structuredContent).toEqual({ entries: [{ name: 'README.md' }, { name: 'assets/' }, { name: 'docs/guide.md' }, { name: 'src/index.js' }], hasMore: false });
            expect((r.content[0] as { text: string }).text).toContain('4 of 4 matching entries');
        });
    });
});
