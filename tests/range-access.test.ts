/**
 * Byte-range access (zipnative 1.1.0 openZipRange) for inspect_zip,
 * list_zip_entries and read_zip_entry: `access: 'range'` (or a zipPath above
 * the 1 GiB in-memory cap under 'auto') reads the end record, the central
 * directory and only the entries touched — through the sandbox file's own
 * handle, never a URL. Also the opt-in extendedTimestamps / unixIds rows.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { buildExtraField } from './_fixtures/raw-zip-builder.js';
import { b64, basicZip, bytesOf, raw, richZip, UT_TIMESTAMP, UT_TIMESTAMP_MTIME } from './_zip-fixtures.js';

type Result = Awaited<ReturnType<typeof callToolDirect>>;
const sc = (r: Result): Record<string, unknown> => {
    expect(r.isError, (r.content[0] as { text?: string }).text).not.toBe(true);
    return r.structuredContent as Record<string, unknown>;
};
const codeOf = (r: Result): string | undefined => (r._meta as { error?: { code?: string } } | undefined)?.error?.code;
const withoutAccess = (o: Record<string, unknown>): Record<string, unknown> => {
    const { access: _access, ...rest } = o;
    void _access;
    return rest;
};

/** An archive with a stored and a deflated entry big enough to span several ranged reads. */
function sizable(): Uint8Array {
    return raw([
        { name: 'a/stored.bin', data: patternBytes(300_000, 3) },
        { name: 'b/text.txt', data: bytesOf('lorem ipsum dolor sit amet '.repeat(4000)) },
    ]);
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

describe("access: 'range' over inline bytes (rangeSourceFromBytes) answers what memory answers", () => {
    it('list_zip_entries: the same rows, plus access: range', async () => {
        for (const bytes of [basicZip(), richZip()]) {
            const memory = sc(await callToolDirect('list_zip_entries', { zipBase64: b64(bytes) }));
            const ranged = sc(await callToolDirect('list_zip_entries', { zipBase64: b64(bytes), access: 'range' }));
            expect(ranged['access']).toBe('range');
            expect(memory['access']).toBeUndefined();
            expect(withoutAccess(ranged)).toEqual(memory);
        }
    });

    it('read_zip_entry: data, a range window, raw and verify are identical', async () => {
        const zipBase64 = b64(basicZip());
        for (const args of [{ name: 'docs/guide.md' }, { name: 'docs/guide.md', encoding: 'utf8' }, { index: 2, range: { offset: 10, length: 50 } }, { name: 'docs/guide.md', mode: 'raw' }, { name: 'README.md', mode: 'verify' }]) {
            const memory = sc(await callToolDirect('read_zip_entry', { zipBase64, ...args }));
            const ranged = sc(await callToolDirect('read_zip_entry', { zipBase64, ...args, access: 'range' }));
            expect(ranged['access'], JSON.stringify(args)).toBe('range');
            expect(withoutAccess(ranged), JSON.stringify(args)).toEqual(memory);
        }
    });

    it('inspect_zip: the facts match; determinism is absent and its checks fail closed; determinismReport is refused', async () => {
        const zipBase64 = b64(basicZip());
        const memory = sc(await callToolDirect('inspect_zip', { zipBase64 }));
        const ranged = sc(await callToolDirect('inspect_zip', { zipBase64, access: 'range', check: ['deterministic', 'canonical-form', 'no-encryption'] }));
        expect(ranged['access']).toBe('range');
        expect(ranged['determinism']).toBeUndefined();
        for (const key of ['archiveBytes', 'entryCount', 'fileCount', 'directoryCount', 'isZip64', 'compressedBytes', 'uncompressedBytes', 'methods', 'unsafeNameCount', 'earliestDate', 'latestDate']) {
            expect(ranged[key], key).toEqual(memory[key]);
        }
        const checks = ranged['checks'] as Array<{ check: string; ok: boolean; detail: string }>;
        expect(checks.map((c) => [c.check, c.ok])).toEqual([['deterministic', false], ['canonical-form', false], ['no-encryption', true]]);
        expect(checks[0]!.detail).toContain("access 'memory'");
        expect(ranged['checksPassed']).toBe(false);
        const summary = sc(await callToolDirect('inspect_zip', { zipBase64, access: 'range', verbosity: 'summary' }));
        expect(summary['access']).toBe('range');
        expect(summary['deterministic']).toBeUndefined();
        const refused = await callToolDirect('inspect_zip', { zipBase64, access: 'range', determinismReport: true });
        expect(codeOf(refused)).toBe('VALIDATION_ERROR');
        expect((refused.content[0] as { text: string }).text).toContain("access:'memory'");
    });
});

describe('access over a sandbox zipPath (one file handle as the ByteRangeSource)', () => {
    it("'range' reads entries of a multi-hundred-KiB archive and equals 'memory'", async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'big.zip'), sizable());
        for (const args of [{ name: 'a/stored.bin', range: { offset: 123_456, length: 4096 } }, { name: 'b/text.txt', encoding: 'utf8' }, { name: 'a/stored.bin', mode: 'verify' }]) {
            const memory = sc(await callToolDirect('read_zip_entry', { zipPath: 'big.zip', access: 'memory', ...args }));
            const ranged = sc(await callToolDirect('read_zip_entry', { zipPath: 'big.zip', access: 'range', ...args }));
            expect(withoutAccess(ranged), JSON.stringify(args)).toEqual(memory);
        }
        // 'auto' keeps a file under the cap in memory (no access field: the 1.0.0 response).
        expect(sc(await callToolDirect('list_zip_entries', { zipPath: 'big.zip' }))['access']).toBeUndefined();
        expect(sc(await callToolDirect('list_zip_entries', { zipPath: 'big.zip', access: 'range' }))['access']).toBe('range');
    });

    it('limits.maxEntryCompressedSize bounds a fetched payload over ranges (and is never consulted in memory)', async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'big.zip'), sizable());
        const refused = await callToolDirect('read_zip_entry', { zipPath: 'big.zip', access: 'range', name: 'a/stored.bin', mode: 'raw', limits: { maxEntryCompressedSize: 1024 } });
        expect(codeOf(refused)).toBe('ZIP_LIMIT_EXCEEDED');
        expect((refused._meta as { error: { data: Record<string, unknown> } }).error.data).toMatchObject({ limit: 'maxEntryCompressedSize', configured: 1024 });
        const inMemory = await callToolDirect('read_zip_entry', { zipPath: 'big.zip', access: 'memory', name: 'b/text.txt', mode: 'raw', limits: { maxEntryCompressedSize: 1024 } });
        expect(inMemory.isError).not.toBe(true);
        // The ceiling applies: the uncompressed-bytes operator ceiling bounds this limit too.
        const above = await callToolDirect('read_zip_entry', { zipPath: 'big.zip', name: 'b/text.txt', limits: { maxEntryCompressedSize: 64 * 1024 * 1024 * 1024 } });
        expect(codeOf(above)).toBe('LIMIT_CEILING_EXCEEDED');
    });

    it('a range-read archive keeps every refusal: a missing path, a non-archive, a sandbox escape', async () => {
        sandbox = await makeSandbox();
        await fs.writeFile(path.join(sandbox, 'junk.zip'), Buffer.alloc(4096, 7));
        expect(codeOf(await callToolDirect('inspect_zip', { zipPath: 'nope.zip', access: 'range' }))).toBe('INPUT_NOT_FOUND');
        expect(codeOf(await callToolDirect('inspect_zip', { zipPath: 'junk.zip', access: 'range' }))).toMatch(/^ZIP_/);
        expect(codeOf(await callToolDirect('list_zip_entries', { zipPath: '../x.zip', access: 'range' }))).toBe('SECURITY_VIOLATION');
        expect(codeOf(await callToolDirect('list_zip_entries', { zipBase64: b64(basicZip()), access: 'stream' }))).toBe('VALIDATION_ERROR');
    });
});

describe('opt-in extendedTimestamps and unixIds (zipnative 1.1.0 getExtendedTimestamps / getUnixIds)', () => {
    /** An entry with the Info-ZIP ux extra (0x7875): version 1, uid 1000, gid 100 (4-byte ids). */
    function unixIdsZip(): Uint8Array {
        const ux = new Uint8Array([1, 4, 0xe8, 0x03, 0, 0, 4, 100, 0, 0, 0]);
        return raw([{ name: 'owned.txt', data: bytesOf('o'), extraCentral: buildExtraField([{ id: 0x7875, data: ux }]), extraLocal: buildExtraField([{ id: 0x7875, data: ux }]) }]);
    }

    it('absent by default (the 1.0.0 row), present on request, on list and read alike', async () => {
        const plain = sc(await callToolDirect('list_zip_entries', { zipBase64: b64(UT_TIMESTAMP()) }));
        const row = (plain['entries'] as Array<Record<string, unknown>>)[0]!;
        expect(row['extendedTimestamps']).toBeUndefined();
        expect(row['unixIds']).toBeUndefined();
        const listed = sc(await callToolDirect('list_zip_entries', { zipBase64: b64(UT_TIMESTAMP()), includeExtendedTimestamps: true, includeUnixIds: true }));
        const ext = (listed['entries'] as Array<Record<string, unknown>>)[0]!;
        expect(ext['extendedTimestamps']).toEqual({ mtime: new Date(UT_TIMESTAMP_MTIME * 1000).toISOString(), atime: null, ctime: null, source: 'ut' });
        expect(ext['unixIds']).toBeNull();
        const read = sc(await callToolDirect('read_zip_entry', { zipBase64: b64(unixIdsZip()), name: 'owned.txt', includeUnixIds: true, includeExtendedTimestamps: true }));
        const entry = read['entry'] as Record<string, unknown>;
        expect(entry['unixIds']).toEqual({ uid: 1000, gid: 100 });
        expect((entry['extendedTimestamps'] as { source: string }).source).toBe('dos');
    });
});
