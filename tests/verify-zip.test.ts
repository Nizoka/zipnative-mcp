/**
 * Tests for `verify_zip` — the one-call deep verification that never fails
 * for a problem with the archive.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { verifyZipTool, verifySummary } from '../src/tools/verify-zip.js';
import { callToolDirect } from '../src/server.js';
import { ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { b64, basicZip, bytesOf, richZip, streamedZip, OVERLAP, CD_MISMATCH, CRC_OVERRIDE, ENCRYPTED_FLAG, LFH_NAME_MISMATCH, MULTI_DISK, SFX_PREFIXED, raw, HOSTILE_FIXTURES, UNKNOWN_METHOD, STRONG_ENCRYPTION_FLAG, truncated } from './_zip-fixtures.js';

describe('verify_zip', () => {
    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    });

    it('reports ok with one row per entry on the benign fixtures', async () => {
        for (const bytes of [basicZip(), richZip(), await streamedZip()]) {
            const out = await verifyZipTool({ zipBase64: b64(bytes) });
            expect(out.ok).toBe(true);
            expect(out.error).toBeNull();
            expect(out.entryCount).toBeGreaterThan(0);
            expect(out.entries).toHaveLength(out.entryCount);
            expect(out.verifiedCount).toBe(out.entryCount);
            expect(out.failedCount).toBe(0);
            expect(out.skippedCount).toBe(0);
            expect(out.entriesTruncated).toBeUndefined();
            expect(out.diagnostics).toEqual([]);
            for (const e of out.entries) expect(e).toMatchObject({ ok: true, crcMatch: true, sizeMatch: true, localHeaderMatch: true });
        }
    });

    it('a structural refusal lands in error, never as isError', async () => {
        const overlap = await verifyZipTool({ zipBase64: b64(OVERLAP()) });
        expect(overlap.ok).toBe(false);
        expect(overlap.error?.code).toBe('ZIP_ENTRY_OVERLAP');
        expect(overlap.error?.message).toContain('zipnative');
        expect(overlap.entryCount).toBe(0);
        expect(overlap.entries).toEqual([]);
        const cd = await verifyZipTool({ zipBase64: b64(CD_MISMATCH()) });
        expect(cd.ok).toBe(false);
        expect(cd.error?.code).toBe('ZIP_CD_INCONSISTENT');
        const md = await verifyZipTool({ zipBase64: b64(MULTI_DISK()) });
        expect(md.error?.code).toBe('ZIP_UNSUPPORTED_MULTI_DISK');
        const garbage = await verifyZipTool({ zipBase64: b64(bytesOf('definitely not an archive, twenty-two bytes+')) });
        expect(garbage.error?.code).toBe('ZIP_EOCD_NOT_FOUND');
        const r = await callToolDirect('verify_zip', { zipBase64: b64(OVERLAP()) });
        expect(r.isError).toBeUndefined();
        expect((r.content[0] as { text: string }).text).toContain('NOT OK — structural refusal [ZIP_ENTRY_OVERLAP]');
    });

    it('a CRC mismatch fails the archive with one failed row', async () => {
        const out = await verifyZipTool({ zipBase64: b64(CRC_OVERRIDE()) });
        expect(out.ok).toBe(false);
        expect(out.error).toBeNull();
        expect(out.entryCount).toBe(1);
        expect(out.failedCount).toBe(1);
        expect(out.verifiedCount).toBe(0);
        expect(out.entries[0]).toEqual({ name: 'c.txt', ok: false, crcMatch: false, sizeMatch: true, localHeaderMatch: true });
        const failed = await verifyZipTool({ zipBase64: b64(CRC_OVERRIDE()), entries: 'failed' });
        expect(failed.entries.map((e) => e.name)).toEqual(['c.txt']);
        const failedNone = await verifyZipTool({ zipBase64: b64(basicZip()), entries: 'failed' });
        expect(failedNone.entries).toEqual([]);
        expect(failedNone.ok).toBe(true);
        const r = await callToolDirect('verify_zip', { zipBase64: b64(CRC_OVERRIDE()) });
        expect((r.content[0] as { text: string }).text).toContain('NOT OK — 0 verified, 1 failed, 0 skipped of 1 entries');
    });

    it('an encrypted entry is skipped, not failed', async () => {
        const out = await verifyZipTool({ zipBase64: b64(ENCRYPTED_FLAG()) });
        expect(out.ok).toBe(true);
        expect(out.skippedCount).toBe(1);
        expect(out.verifiedCount).toBe(1);
        expect(out.failedCount).toBe(0);
        expect(out.entries.find((e) => e.name === 'secret.txt')?.skipped).toBe('encrypted');
        const skipped = await verifyZipTool({ zipBase64: b64(ENCRYPTED_FLAG()), entries: 'skipped' });
        expect(skipped.entries.map((e) => e.name)).toEqual(['secret.txt']);
        const failed = await verifyZipTool({ zipBase64: b64(ENCRYPTED_FLAG()), entries: 'failed' });
        expect(failed.entries).toEqual([]);
    });

    it("entries:'none' keeps the verdict and counts only", async () => {
        const out = await verifyZipTool({ zipBase64: b64(richZip()), entries: 'none' });
        expect(out.entries).toEqual([]);
        expect(out.entryCount).toBe(5);
        expect(out.verifiedCount).toBe(5);
        expect(out.entriesTruncated).toBeUndefined();
    });

    it('maxEntries truncates the rows and flags it', async () => {
        const out = await verifyZipTool({ zipBase64: b64(basicZip()), maxEntries: 2 });
        expect(out.entries).toHaveLength(2);
        expect(out.entriesTruncated).toBe(true);
        expect(out.verifiedCount).toBe(4);
        const exact = await verifyZipTool({ zipBase64: b64(basicZip()), maxEntries: 4 });
        expect(exact.entriesTruncated).toBeUndefined();
        await expect(verifyZipTool({ zipBase64: b64(basicZip()), maxEntries: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('collects the diagnostics the parse emits', async () => {
        const out = await verifyZipTool({ zipBase64: b64(LFH_NAME_MISMATCH()) });
        expect(out.ok).toBe(true);
        expect(out.diagnostics.map((d) => d.code)).toContain('ZIP_NAME_MISMATCH');
        expect(out.diagnostics[0]).toMatchObject({ severity: 'warning', entryName: 'central.txt' });
        const sfx = await verifyZipTool({ zipBase64: b64(SFX_PREFIXED()) });
        expect(sfx.ok).toBe(true);
        expect(sfx.diagnostics.map((d) => d.code)).toContain('ZIP_PREPENDED_DATA');
        // Duplicate names are not a verification concern: both rows are verified.
        const dup = await verifyZipTool({ zipBase64: b64(raw([{ name: 'a' }, { name: 'a' }])) });
        expect(dup.ok).toBe(true);
        expect(dup.entries.map((e) => e.name)).toEqual(['a', 'a']);
    });

    it('limits apply to the verification; the ceiling still throws', async () => {
        const limited = await verifyZipTool({ zipBase64: b64(basicZip()), limits: { maxEntries: 1 } });
        expect(limited.ok).toBe(false);
        expect(limited.error?.code).toBe('ZIP_LIMIT_EXCEEDED');
        await expect(verifyZipTool({ zipBase64: b64(basicZip()), limits: { maxEntries: 1_000_000 } })).rejects.toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED' });
        const r = await callToolDirect('verify_zip', { zipBase64: b64(basicZip()), limits: { maxEntries: 1_000_000 } });
        expect(r.isError).toBe(true);
    });

    it('caller mistakes are still isError', async () => {
        await expect(verifyZipTool({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(verifyZipTool({ zipBase64: b64(basicZip()), entries: 'some' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(verifyZipTool({ zipBase64: b64(basicZip()), strict: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('B-019: verify_zip is never isError across the whole hostile fixture set (plus a truncated archive)', async () => {
        const cases: Array<[string, Uint8Array]> = [...Object.entries(HOSTILE_FIXTURES).map(([name, make]): [string, Uint8Array] => [name, make()]), ['TRUNCATED', truncated(basicZip(), 60)]];
        expect(cases.length).toBeGreaterThanOrEqual(30);
        for (const [name, bytes] of cases) {
            const r = await callToolDirect('verify_zip', { zipBase64: b64(bytes) });
            expect(r.isError, name).not.toBe(true);
            const sc = r.structuredContent as { ok: boolean; error: { code: string } | null; entryCount: number };
            expect(typeof sc.ok, name).toBe('boolean');
            if (sc.error !== null) {
                expect(sc.ok, name).toBe(false);
                expect(ZIP_ERROR_CODES as readonly string[], `${name}: ${sc.error.code}`).toContain(sc.error.code);
                expect(sc.entryCount, name).toBe(0);
            }
        }
    });

    it('B-020: an entry whose method has no codec here is reported FAILED (ok:false, no skipped reason), never skipped', async () => {
        const out = await verifyZipTool({ zipBase64: b64(UNKNOWN_METHOD()) });
        expect(out.ok).toBe(false);
        expect(out.error).toBeNull();
        expect(out.entryCount).toBe(1);
        expect(out.failedCount).toBe(1);
        expect(out.skippedCount).toBe(0);
        expect(out.entries[0]).toMatchObject({ name: 'w.bin', ok: false });
        expect(out.entries[0]?.skipped).toBeUndefined();
        const failed = await verifyZipTool({ zipBase64: b64(UNKNOWN_METHOD()), entries: 'failed' });
        expect(failed.entries.map((e) => e.name)).toEqual(['w.bin']);
        // Encrypted entries (ZipCrypto or strong encryption) are the ones that ARE skipped.
        const strong = await verifyZipTool({ zipBase64: b64(STRONG_ENCRYPTION_FLAG()) });
        expect(strong.ok).toBe(true);
        expect(strong.entries.find((e) => e.name === 'aes.bin')?.skipped).toBe('encrypted');
    });

    it('summary projection keeps the verdict and counts', async () => {
        const full = await verifyZipTool({ zipBase64: b64(ENCRYPTED_FLAG()) });
        expect(verifySummary(full)).toEqual({ ok: true, error: null, entryCount: 2, verifiedCount: 1, failedCount: 0, skippedCount: 1, diagnosticCount: 0 });
        const r = await callToolDirect('verify_zip', { zipBase64: b64(basicZip()), verbosity: 'summary', fields: ['ok', 'error', 'failedCount'] });
        expect(r.structuredContent).toEqual({ ok: true, error: null, failedCount: 0 });
        expect((r.content[0] as { text: string }).text).toContain('verify_zip: OK — 4 verified');
    });
});
