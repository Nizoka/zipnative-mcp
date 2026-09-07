/**
 * Tests for `inspect_zip` — facts, determinism verdict, checks / assertions,
 * diagnostics, hostile refusals and the wire-level projection.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectZip, inspectSummary, INSPECT_CHECKS } from '../src/tools/inspect-zip.js';
import { callToolDirect } from '../src/server.js';
import { ToolError } from '../src/errors.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';
import {
    b64, basicZip, bytesOf, richZip, streamedZip, OVERLAP, SFX_PREFIXED, TRAILING_GARBAGE, INVALID_UTF8_NAME, CP437_NAME,
    CD_MISMATCH, MULTI_DISK, ZIP64_DROPPED, ZIP64_FORCED, ZIP_SLIP, SYMLINK, ENCRYPTED_FLAG, raw,
} from './_zip-fixtures.js';

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'OK';
    } catch (e) {
        return e instanceof ToolError ? e.code : `THROW:${String(e)}`;
    }
}

describe('inspect_zip', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
    });

    describe('facts', () => {
        it('reports counts, methods, sizes and a deterministic verdict for basicZip', async () => {
            const bytes = basicZip();
            const out = await inspectZip({ zipBase64: b64(bytes) });
            expect(out.archiveBytes).toBe(bytes.byteLength);
            expect(out.entryCount).toBe(4);
            expect(out.fileCount).toBe(3);
            expect(out.directoryCount).toBe(1);
            expect(out.isZip64).toBe(false);
            expect(out.comment).toBe('');
            expect(out.commentBytes).toBe(0);
            expect(out.commentHex).toBeUndefined();
            expect(out.prependedData).toBe(false);
            expect(out.multipleEocd).toBe(false);
            expect(out.methods).toEqual([{ id: 0, name: 'store', count: 3 }, { id: 8, name: 'deflate', count: 1 }]);
            expect(out.uncompressedBytes).toBeGreaterThan(out.compressedBytes);
            expect(out.ratio).toMatch(/^\d+%$/);
            expect(out.encryptedCount).toBe(0);
            expect(out.symlinkCount).toBe(0);
            expect(out.dataDescriptorCount).toBe(0);
            expect(out.zip64EntryCount).toBe(0);
            expect(out.utf8NameCount).toBe(4);
            expect(out.cp437NameCount).toBe(0);
            expect(out.duplicateNameCount).toBe(0);
            expect(out.unsafeNameCount).toBe(0);
            expect(out.earliestDate).toBe(out.latestDate);
            expect(out.determinism).toEqual({ epochTimestamps: true, canonicalOrder: true, utf8Flags: true, noDataDescriptors: true, canonicalLayout: true, deterministic: true });
            expect(out.diagnostics).toEqual([]);
            expect(out.diagnosticCounts).toEqual({});
            expect(out.checks).toBeUndefined();
            expect(out.checksPassed).toBeUndefined();
        });

        it('reports the comment (text + hex) and the date range of richZip', async () => {
            const out = await inspectZip({ zipBase64: b64(richZip()) });
            expect(out.entryCount).toBe(5);
            expect(out.fileCount).toBe(4);
            expect(out.directoryCount).toBe(1);
            expect(out.comment).toBe('archive comment — ünïcödé');
            expect(out.commentBytes).toBe(Buffer.byteLength('archive comment — ünïcödé', 'utf8'));
            expect(out.commentHex).toBe(Buffer.from('archive comment — ünïcödé', 'utf8').toString('hex'));
            expect(out.latestDate).toBe('2024-06-01T12:34:56.000Z');
            expect(out.earliestDate).not.toBe(out.latestDate);
            expect(out.methods).toEqual([{ id: 0, name: 'store', count: 5 }]);
            // One entry carries a non-epoch date: reproducible order and flags, but not deterministic.
            expect(out.determinism.epochTimestamps).toBe(false);
            expect(out.determinism.canonicalOrder).toBe(true);
            expect(out.determinism.utf8Flags).toBe(true);
            expect(out.determinism.deterministic).toBe(false);
        });

        it("a 'now'-dated archive is not deterministic", async () => {
            const out = await inspectZip({ zipBase64: b64(basicZip({ defaultDate: 'now' })) });
            expect(out.determinism.epochTimestamps).toBe(false);
            expect(out.determinism.deterministic).toBe(false);
            expect(out.determinism.canonicalLayout).toBe(true);
        });

        it('a streamed archive is deterministic but not canonical layout', async () => {
            const out = await inspectZip({ zipBase64: b64(await streamedZip()) });
            expect(out.dataDescriptorCount).toBe(1);
            expect(out.determinism.noDataDescriptors).toBe(false);
            expect(out.determinism.canonicalLayout).toBe(false);
            expect(out.determinism.deterministic).toBe(true);
        });

        it('counts symlinks, encrypted entries, unsafe names, duplicates and cp437 names', async () => {
            expect((await inspectZip({ zipBase64: b64(SYMLINK()), validate: 'lazy' })).symlinkCount).toBe(1);
            expect((await inspectZip({ zipBase64: b64(ENCRYPTED_FLAG()), validate: 'lazy' })).encryptedCount).toBe(1);
            expect((await inspectZip({ zipBase64: b64(ZIP_SLIP()), validate: 'lazy' })).unsafeNameCount).toBe(1);
            const dup = await inspectZip({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }])) });
            expect(dup.duplicateNameCount).toBe(1);
            expect(dup.cp437NameCount).toBe(2);
            expect(dup.utf8NameCount).toBe(0);
            const z64 = await inspectZip({ zipBase64: b64(ZIP64_FORCED()) });
            expect(z64.isZip64).toBe(true);
        });

        it('an empty archive has null dates and no methods', async () => {
            const out = await inspectZip({ zipBase64: b64(raw([])) });
            expect(out.entryCount).toBe(0);
            expect(out.earliestDate).toBeNull();
            expect(out.latestDate).toBeNull();
            expect(out.methods).toEqual([]);
            expect(out.ratio).toBe('0%');
        });
    });

    describe('checks', () => {
        it('evaluates every simple check on basicZip', async () => {
            const out = await inspectZip({ zipBase64: b64(basicZip()), check: [...INSPECT_CHECKS] });
            expect(INSPECT_CHECKS).toHaveLength(15);
            expect(out.checks).toHaveLength(15);
            const byName = Object.fromEntries((out.checks ?? []).map((c) => [c.check, c.ok]));
            expect(byName).toEqual({
                'deterministic': true,
                'epoch-timestamps': true,
                'canonical-order': true,
                'utf8-names': true,
                'no-data-descriptor': true,
                'canonical-layout': true,
                'no-zip64': true,
                'zip64': false,
                'no-encryption': true,
                'no-symlinks': true,
                'safe-names': true,
                'no-duplicates': true,
                'no-diagnostics': true,
                'store-only': false,
                'deflate-only': false,
            });
            expect(out.checksPassed).toBe(false);
            for (const c of out.checks ?? []) expect(typeof c.detail).toBe('string');
        });

        it('store-only / zip64 / no-diagnostics hold on the right archives', async () => {
            const store = await inspectZip({ zipBase64: b64(richZip()), check: ['store-only', 'deflate-only'] });
            expect(store.checks?.map((c) => c.ok)).toEqual([true, false]);
            const z64 = await inspectZip({ zipBase64: b64(ZIP64_FORCED()), check: ['zip64', 'no-zip64'] });
            expect(z64.checks?.map((c) => c.ok)).toEqual([true, false]);
            const sfx = await inspectZip({ zipBase64: b64(SFX_PREFIXED()), check: ['no-diagnostics'] });
            expect(sfx.checks?.[0]?.ok).toBe(false);
            expect(sfx.checksPassed).toBe(false);
        });

        it('fails the security checks on hostile-but-parseable archives', async () => {
            const slip = await inspectZip({ zipBase64: b64(ZIP_SLIP()), check: ['safe-names'] });
            expect(slip.checks?.[0]).toMatchObject({ check: 'safe-names', ok: false });
            const link = await inspectZip({ zipBase64: b64(SYMLINK()), check: ['no-symlinks'] });
            expect(link.checks?.[0]?.ok).toBe(false);
            const enc = await inspectZip({ zipBase64: b64(ENCRYPTED_FLAG()), check: ['no-encryption'] });
            expect(enc.checks?.[0]?.ok).toBe(false);
            const dup = await inspectZip({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }])), check: ['no-duplicates', 'utf8-names'] });
            expect(dup.checks?.map((c) => c.ok)).toEqual([false, true]);
            const cp = await inspectZip({ zipBase64: b64(CP437_NAME()), check: ['utf8-names', 'deterministic'] });
            expect(cp.checks?.map((c) => c.ok)).toEqual([false, false]);
            const streamed = await inspectZip({ zipBase64: b64(await streamedZip()), check: ['canonical-layout', 'no-data-descriptor', 'deterministic'] });
            expect(streamed.checks?.map((c) => c.ok)).toEqual([false, false, true]);
            const now = await inspectZip({ zipBase64: b64(basicZip({ defaultDate: 'now' })), check: ['epoch-timestamps'] });
            expect(now.checks?.[0]?.ok).toBe(false);
        });

        it('canonical-order fails on an insertion-ordered archive', async () => {
            const out = await inspectZip({ zipBase64: b64(raw([{ name: 'b.txt' }, { name: 'a.txt' }])), check: ['canonical-order'] });
            expect(out.checks?.[0]?.ok).toBe(false);
            expect(out.determinism.canonicalOrder).toBe(false);
        });

        it('evaluates every assert key, passing and failing', async () => {
            const pass = await inspectZip({
                zipBase64: b64(basicZip()),
                assert: { maxEntries: 4, minEntries: 4, maxUncompressedBytes: 10_000, maxRatio: 100, has: ['README.md', 'src/index.js'], method: 'store' },
            });
            const passMap = Object.fromEntries((pass.checks ?? []).map((c) => [c.check, c.ok]));
            expect(passMap).toEqual({
                'max-entries=4': true,
                'min-entries=4': true,
                'max-uncompressed=10000': true,
                'max-ratio=100': true,
                'has=README.md': true,
                'has=src/index.js': true,
                'method=store': false,
            });
            expect(pass.checksPassed).toBe(false);

            const fail = await inspectZip({
                zipBase64: b64(basicZip()),
                assert: { maxEntries: 1, minEntries: 10, maxUncompressedBytes: 1, maxRatio: 1, has: ['missing.txt'], method: 'deflate' },
            });
            expect(fail.checks?.every((c) => !c.ok)).toBe(true);
            expect(fail.checksPassed).toBe(false);
            expect(fail.checks?.find((c) => c.check === 'has=missing.txt')?.detail).toContain('missing');

            const ok = await inspectZip({ zipBase64: b64(richZip()), assert: { method: 'store', minEntries: 1 }, check: ['no-encryption'] });
            expect(ok.checksPassed).toBe(true);
            expect(ok.checks).toHaveLength(3);
        });

        it('rejects an unknown check and a bad assert', async () => {
            await expect(inspectZip({ zipBase64: b64(basicZip()), check: ['nope'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(inspectZip({ zipBase64: b64(basicZip()), assert: { maxRatio: 0.5 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(inspectZip({ zipBase64: b64(basicZip()), assert: { unknown: 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('validation modes and diagnostics', () => {
        it("eager (default) refuses an overlapping archive with ZIP_ENTRY_OVERLAP, lazy opens it", async () => {
            await expect(inspectZip({ zipBase64: b64(OVERLAP()) })).rejects.toMatchObject({
                code: 'ZIP_ENTRY_OVERLAP',
                data: { errorClass: 'security', engineError: 'ZipSecurityError' },
            });
            const lazy = await inspectZip({ zipBase64: b64(OVERLAP()), validate: 'lazy' });
            expect(lazy.entryCount).toBe(2);
        });

        it('reports prepended (SFX) data as a diagnostic', async () => {
            const out = await inspectZip({ zipBase64: b64(SFX_PREFIXED()) });
            expect(out.prependedData).toBe(true);
            expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_PREPENDED_DATA');
            expect(out.diagnosticCounts['ZIP_PREPENDED_DATA']).toBe(1);
            expect(out.entryCount).toBe(1);
        });

        it('refuses trailing garbage after the archive (no self-consistent EOCD)', async () => {
            await expect(inspectZip({ zipBase64: b64(TRAILING_GARBAGE()) })).rejects.toMatchObject({ code: 'ZIP_EOCD_NOT_FOUND' });
            const small = raw([{ name: 'a.txt', data: bytesOf('a') }], { append: new Uint8Array(100) });
            await expect(inspectZip({ zipBase64: b64(small) })).rejects.toMatchObject({ code: 'ZIP_EOCD_NOT_FOUND', data: { errorClass: 'parse' } });
        });

        it('reports an invalid UTF-8 name (flag set, bytes not UTF-8) as a diagnostic', async () => {
            const out = await inspectZip({ zipBase64: b64(INVALID_UTF8_NAME()) });
            const d = out.diagnostics.find((x) => x.code === 'ZIP_INVALID_UTF8_NAME');
            expect(d).toBeDefined();
            expect(d?.severity).toBe('warning');
            expect(typeof d?.entryName).toBe('string');
            expect(out.cp437NameCount).toBe(1);
        });

        it('a cp437 name with a non-ASCII byte and no UTF-8 flag breaks the utf8Flags verdict without a diagnostic', async () => {
            const out = await inspectZip({ zipBase64: b64(CP437_NAME()) });
            expect(out.diagnostics).toEqual([]);
            expect(out.cp437NameCount).toBe(1);
            expect(out.determinism.utf8Flags).toBe(false);
            expect(out.determinism.deterministic).toBe(false);
        });

        it('strict:true escalates the first diagnostic to ZIP_STRICT_DIAGNOSTIC', async () => {
            await expect(inspectZip({ zipBase64: b64(SFX_PREFIXED()), strict: true })).rejects.toMatchObject({
                code: 'ZIP_STRICT_DIAGNOSTIC',
                data: { errorClass: 'check' },
            });
            const clean = await inspectZip({ zipBase64: b64(basicZip()), strict: true });
            expect(clean.entryCount).toBe(4);
        });
    });

    describe('hostile refusals', () => {
        it('maps every structural refusal to its frozen ZIP_* code', async () => {
            expect(await codeOf(inspectZip({ zipBase64: b64(CD_MISMATCH()) }))).toBe('ZIP_CD_INCONSISTENT');
            expect(await codeOf(inspectZip({ zipBase64: b64(MULTI_DISK()) }))).toBe('ZIP_UNSUPPORTED_MULTI_DISK');
            expect(await codeOf(inspectZip({ zipBase64: b64(ZIP64_DROPPED()) }))).toMatch(/^ZIP_ZIP64_/);
            expect(await codeOf(inspectZip({ zipBase64: b64(bytesOf('this is not a zip archive at all, sorry')) }))).toBe('ZIP_EOCD_NOT_FOUND');
        });

        it('carries the unsupported feature in data', async () => {
            await expect(inspectZip({ zipBase64: b64(MULTI_DISK()) })).rejects.toMatchObject({
                data: { errorClass: 'unsupported', feature: 'multi-disk', engineError: 'ZipUnsupportedError' },
            });
        });

        it('rejects base64 that is not an archive at the boundary', async () => {
            await expect(inspectZip({ zipBase64: '!!!!' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(inspectZip({ zipBase64: b64(bytesOf(b64(basicZip()))) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });
    });

    describe('inputs', () => {
        it('enforces the zipBase64 XOR zipPath rule', async () => {
            await expect(inspectZip({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(inspectZip({ zipBase64: b64(basicZip()), zipPath: 'a.zip' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            await expect(inspectZip({ zipBase64: b64(basicZip()), extra: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        });

        it('reads an archive through zipPath inside the sandbox', async () => {
            sandbox = await makeSandbox();
            await fs.writeFile(path.join(sandbox, 'in.zip'), basicZip());
            const out = await inspectZip({ zipPath: 'in.zip' });
            expect(out.entryCount).toBe(4);
            await expect(inspectZip({ zipPath: 'missing.zip' })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
            await expect(inspectZip({ zipPath: '../in.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            await expect(inspectZip({ zipPath: 'in.txt' })).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
        });

        it('zipPath without a sandbox is a SECURITY_VIOLATION', async () => {
            await expect(inspectZip({ zipPath: 'in.zip' })).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        });

        it('applies per-call limits and refuses values above the operator ceiling', async () => {
            await expect(inspectZip({ zipBase64: b64(basicZip()), limits: { maxEntries: 1 } })).rejects.toMatchObject({
                code: 'ZIP_LIMIT_EXCEEDED',
                data: { errorClass: 'limit', limit: 'maxEntries', configured: 1, observed: 4 },
            });
            await expect(inspectZip({ zipBase64: b64(basicZip()), limits: { maxEntries: 200_000 } })).rejects.toMatchObject({
                code: 'LIMIT_CEILING_EXCEEDED',
                data: { limit: 'maxEntries', requested: 200_000, ceiling: 100_000, env: 'ZIPNATIVE_MCP_MAX_ENTRIES' },
            });
            const ok = await inspectZip({ zipBase64: b64(basicZip()), limits: { maxEntries: 4, maxCompressionRatio: 2000 } });
            expect(ok.entryCount).toBe(4);
        });
    });

    describe('wire level (callToolDirect)', () => {
        it('returns the full report as structuredContent with a text line', async () => {
            const r = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()) });
            expect(r.isError).toBeUndefined();
            expect(r.content[0]).toMatchObject({ type: 'text' });
            expect((r.content[0] as { text: string }).text).toContain('4 entries');
            const sc = r.structuredContent as Record<string, unknown>;
            expect(sc['entryCount']).toBe(4);
            expect(sc['determinism']).toBeDefined();
        });

        it("verbosity:'summary' collapses to the scalar verdict", async () => {
            const r = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), verbosity: 'summary', check: ['deterministic'] });
            const sc = r.structuredContent as Record<string, unknown>;
            expect(Object.keys(sc).sort()).toEqual(['archiveBytes', 'canonicalLayout', 'checksPassed', 'compressedBytes', 'deterministic', 'diagnosticCount', 'duplicateNameCount', 'encryptedCount', 'entryCount', 'isZip64', 'uncompressedBytes', 'unsafeNameCount'].sort());
            expect(sc['deterministic']).toBe(true);
            expect(sc['checksPassed']).toBe(true);
            const full = await inspectZip({ zipBase64: b64(basicZip()) });
            expect(inspectSummary(full)).not.toHaveProperty('checksPassed');
        });

        it('fields projects dot-paths and reports unmatched ones in _meta', async () => {
            const r = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), fields: ['entryCount', 'determinism.deterministic', 'nope'] });
            expect(r.structuredContent).toEqual({ entryCount: 4, determinism: { deterministic: true } });
            expect(r._meta).toMatchObject({ unmatchedFields: ['nope'] });
            expect((r._meta as { availableFields: string[] }).availableFields).toContain('entryCount');
            const clean = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), fields: ['entryCount'] });
            expect(clean._meta).toBeUndefined();
        });

        it('shapes an engine refusal as isError with _meta.error.data', async () => {
            const r = await callToolDirect('inspect_zip', { zipBase64: b64(OVERLAP()) });
            expect(r.isError).toBe(true);
            expect((r.content[0] as { text: string }).text).toMatch(/^inspect_zip failed \[ZIP_ENTRY_OVERLAP\]: /);
            const meta = r._meta as { error: { code: string; message: string; data: Record<string, unknown> } };
            expect(meta.error.code).toBe('ZIP_ENTRY_OVERLAP');
            expect(meta.error.data['errorClass']).toBe('security');
            expect(meta.error.data['engineError']).toBe('ZipSecurityError');
        });

        it('carries the entry name in _meta.error.data for entry-scoped errors', async () => {
            const r = await callToolDirect('read_zip_entry', { zipBase64: b64(ENCRYPTED_FLAG()), name: 'secret.txt' });
            expect(r.isError).toBe(true);
            const meta = r._meta as { error: { code: string; data: Record<string, unknown> } };
            expect(meta.error.code).toBe('ZIP_UNSUPPORTED_ENCRYPTION');
            expect(meta.error.data).toMatchObject({ errorClass: 'unsupported', entryName: 'secret.txt', feature: 'zipcrypto' });
        });

        it('a validation failure is isError with VALIDATION_ERROR', async () => {
            const r = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), validate: 'sometimes' });
            expect(r.isError).toBe(true);
            expect((r._meta as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
        });
    });
});
