/**
 * B-010 — Zip64 through the tools: `create_zip` auto-promotes to Zip64 exactly
 * when the entry count overflows a 16-bit field (65 536 entries), the result
 * passes the ISO/IEC 21320-1 gate, and the read tools handle a 70 000-entry
 * engine-built archive (`zip64ManyEntries`). The big fixture is built once per
 * file (it is the slow part).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { createZipTool } from '../src/tools/create-zip.js';
import { inspectZip } from '../src/tools/inspect-zip.js';
import { listZipEntries } from '../src/tools/list-zip-entries.js';
import { scanZipForward } from '../src/tools/scan-zip-forward.js';
import { verifyZipTool } from '../src/tools/verify-zip.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, zip64ManyEntries } from './_zip-fixtures.js';

const MANY = 70_000;

describe('B-010: Zip64 is reachable and readable through the tools', () => {
    let manyBase64: string;

    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        await ensureEngineReady();
        manyBase64 = b64(zip64ManyEntries(MANY));
    }, 60_000);

    it('create_zip with 65 536 one-byte entries auto-promotes to Zip64 and passes veraZIP; 65 534 stays classic (65 535 is the sentinel itself)', async () => {
        const entries = (n: number): Array<{ name: string; text: string }> => Array.from({ length: n }, (_, i) => ({ name: `e/${i.toString(36)}`, text: 'A' }));
        const promoted = await createZipTool({ entries: entries(65_536), compression: { method: 'store' } });
        expect(promoted.summary.entryCount).toBe(65_536);
        assertValidZip(promoted.base64 as string, 'zip64-65536');
        const inspected = await inspectZip({ zipBase64: promoted.base64 as string, check: ['zip64', 'no-zip64'] });
        expect(inspected.isZip64).toBe(true);
        expect(inspected.entryCount).toBe(65_536);
        expect(inspected.checks?.map((c) => c.ok)).toEqual([true, false]);
        const classic = await createZipTool({ entries: entries(65_534), compression: { method: 'store' } });
        expect((await inspectZip({ zipBase64: classic.base64 as string })).isZip64).toBe(false);
        assertValidZip(classic.base64 as string, 'classic-65534');
        // 0xFFFF is the Zip64 sentinel, so a count of exactly 65 535 is already Zip64.
        const sentinel = await createZipTool({ entries: entries(65_535), compression: { method: 'store' } });
        expect((await inspectZip({ zipBase64: sentinel.base64 as string })).isZip64).toBe(true);
    }, 120_000);

    it('inspect_zip reports isZip64 / entryCount and the zip64 check on the 70 000-entry archive', async () => {
        const out = await inspectZip({ zipBase64: manyBase64, check: ['zip64'], verbosity: 'summary' });
        expect(out.isZip64).toBe(true);
        expect(out.entryCount).toBe(MANY);
        expect(out.checks?.[0]).toMatchObject({ check: 'zip64', ok: true });
        expect(out.determinism.deterministic).toBe(true);
    }, 60_000);

    it('list_zip_entries pages to the end: offset 69 990 returns the last 10 rows with hasMore false', async () => {
        const tail = await listZipEntries({ zipBase64: manyBase64, offset: MANY - 10 });
        expect(tail.entryCount).toBe(MANY);
        expect(tail.isZip64).toBe(true);
        expect(tail.returnedCount).toBe(10);
        expect(tail.hasMore).toBe(false);
        expect(tail.entries[9]?.index).toBe(MANY - 1);
        expect(tail.entries.every((e) => e.usesZip64 === false)).toBe(true);
        const page = await listZipEntries({ zipBase64: manyBase64, limit: 2000 });
        expect(page.hasMore).toBe(true);
        expect(page.returnedCount).toBe(2000);
    }, 60_000);

    it("verify_zip entries:'none' verifies every entry without returning rows", async () => {
        const out = await verifyZipTool({ zipBase64: manyBase64, entries: 'none' });
        expect(out.ok).toBe(true);
        expect(out.entryCount).toBe(MANY);
        expect(out.verifiedCount).toBe(MANY);
        expect(out.entries).toEqual([]);
        const capped = await callToolDirect('verify_zip', { zipBase64: manyBase64, maxEntries: 5, verbosity: 'summary' });
        expect(capped.structuredContent).toMatchObject({ ok: true, verifiedCount: MANY });
    }, 60_000);

    it("scan_zip_forward maxEntries:100 stops at 'max-entries' with the budget reported", async () => {
        const out = await scanZipForward({ zipBase64: manyBase64, maxEntries: 100 });
        expect(out.stoppedAt).toBe('max-entries');
        expect(out.entryCount).toBe(100);
        expect(out.maxEntries).toBe(100);
        expect(out.truncated).toBe(false);
        expect(out.entries[0]?.name).toBe('e/0');
    }, 60_000);
});
