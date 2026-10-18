/**
 * Tests for `src/limits.ts` — merging caller limits over the engine defaults
 * under the operator ceilings.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { DEFAULT_ZIP_LIMITS } from 'zipnative';

import { __resetCeilingsForTests, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, type Ceilings } from '../src/caps.js';
import { effectiveLimits, LIMIT_KEYS, LIMITS_INPUT_SCHEMA, LimitsSchema, resolveCallLimits } from '../src/limits.js';
import { ToolError } from '../src/errors.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { buildExtraField } from './_fixtures/raw-zip-builder.js';
import { b64, basicZip, bytesOf, highRatioZip, raw } from './_zip-fixtures.js';

const DEFAULT_CEILINGS: Ceilings = { maxUncompressedBytes: 8 * 1024 * 1024 * 1024, maxEntries: 100_000, maxWorkers: 8 };

describe('limits', () => {
    afterEach(() => {
        delete process.env[MAX_ENTRIES_ENV];
        delete process.env[MAX_UNCOMPRESSED_ENV];
        __resetCeilingsForTests();
    });

    it('the schema fragments cover the nine engine keys (maxEntryCompressedSize since zipnative 1.1.0)', () => {
        expect(LIMIT_KEYS).toHaveLength(9);
        expect(LIMIT_KEYS[2]).toBe('maxEntryCompressedSize');
        expect(Object.keys(LIMITS_INPUT_SCHEMA.properties)).toEqual([...LIMIT_KEYS]);
        expect(Object.keys(LimitsSchema.shape)).toEqual([...LIMIT_KEYS]);
        expect(Object.keys(DEFAULT_ZIP_LIMITS).sort()).toEqual([...LIMIT_KEYS].sort());
        expect(LimitsSchema.safeParse({ maxEntries: 0 }).success).toBe(false);
        expect(LimitsSchema.safeParse({ maxNameBytes: 65_536 }).success).toBe(false);
        expect(LimitsSchema.safeParse({ maxCompressionRatio: 1.5 }).success).toBe(true);
        expect(LimitsSchema.safeParse({ other: 1 }).success).toBe(false);
    });

    it('returns undefined when nothing is requested and no ceiling tightens a default', () => {
        expect(resolveCallLimits(undefined, DEFAULT_CEILINGS)).toBeUndefined();
        expect(resolveCallLimits({}, DEFAULT_CEILINGS)).toBeUndefined();
        expect(resolveCallLimits(undefined)).toBeUndefined();
    });

    it('merges the requested keys only', () => {
        expect(resolveCallLimits({ maxEntries: 10, maxNameBytes: 100 }, DEFAULT_CEILINGS)).toEqual({ maxEntries: 10, maxNameBytes: 100 });
        expect(effectiveLimits({ maxEntries: 10 }, DEFAULT_CEILINGS)).toEqual({ ...DEFAULT_ZIP_LIMITS, maxEntries: 10 });
        expect(effectiveLimits(undefined, DEFAULT_CEILINGS)).toEqual(DEFAULT_ZIP_LIMITS);
    });

    it('a ceiling below the engine default tightens the default silently', () => {
        const tight: Ceilings = { maxUncompressedBytes: 1024 * 1024, maxEntries: 50, maxWorkers: 8 };
        expect(resolveCallLimits(undefined, tight)).toEqual({ maxEntries: 50, maxEntryUncompressedSize: 1024 * 1024, maxEntryCompressedSize: 1024 * 1024, maxTotalUncompressedSize: 1024 * 1024 });
        expect(resolveCallLimits({ maxEntries: 20 }, tight)).toEqual({ maxEntries: 20, maxEntryUncompressedSize: 1024 * 1024, maxEntryCompressedSize: 1024 * 1024, maxTotalUncompressedSize: 1024 * 1024 });
        process.env[MAX_ENTRIES_ENV] = '7';
        __resetCeilingsForTests();
        expect(resolveCallLimits(undefined)).toEqual({ maxEntries: 7 });
    });

    it('a value above the ceiling is LIMIT_CEILING_EXCEEDED naming the variable', () => {
        for (const [key, ceiling, env] of [
            ['maxEntries', 100_000, MAX_ENTRIES_ENV],
            ['maxEntryUncompressedSize', DEFAULT_CEILINGS.maxUncompressedBytes, MAX_UNCOMPRESSED_ENV],
            ['maxEntryCompressedSize', DEFAULT_CEILINGS.maxUncompressedBytes, MAX_UNCOMPRESSED_ENV],
            ['maxTotalUncompressedSize', DEFAULT_CEILINGS.maxUncompressedBytes, MAX_UNCOMPRESSED_ENV],
        ] as const) {
            try {
                resolveCallLimits({ [key]: ceiling + 1 }, DEFAULT_CEILINGS);
                expect.unreachable();
            } catch (e) {
                expect(e).toBeInstanceOf(ToolError);
                expect((e as ToolError).code).toBe('LIMIT_CEILING_EXCEEDED');
                expect((e as ToolError).data).toEqual({ limit: key, requested: ceiling + 1, ceiling, env });
                expect((e as ToolError).message).toContain(env);
                expect((e as ToolError).message).toContain(`limits.${key} = ${ceiling + 1}`);
            }
        }
        expect(resolveCallLimits({ maxEntries: 100_000 }, DEFAULT_CEILINGS)).toEqual({ maxEntries: 100_000 });
    });

    it('keys without a ceiling are never refused', () => {
        expect(resolveCallLimits({ maxCentralDirectoryBytes: 2 ** 40, maxCompressionRatio: 1e9 }, DEFAULT_CEILINGS)).toEqual({ maxCentralDirectoryBytes: 2 ** 40, maxCompressionRatio: 1e9 });
    });
});

describe('B-018: every ZipLimits key produces ZIP_LIMIT_EXCEEDED naming itself when set below the archive value', () => {
    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        await ensureEngineReady();
    });

    async function refusal(tool: string, args: Record<string, unknown>): Promise<{ code: string; data: Record<string, unknown> }> {
        const r = await callToolDirect(tool, args);
        expect(r.isError, `${tool} ${JSON.stringify(args['limits'])}: ${String(JSON.stringify(r.structuredContent)).slice(0, 200)}`).toBe(true);
        const err = (r._meta as { error: { code: string; data: Record<string, unknown> } }).error;
        return { code: err.code, data: err.data };
    }

    const extra = buildExtraField([{ id: 0x6a6a, data: new Uint8Array(40) }]);
    const longName = (): Uint8Array => raw([{ name: 'x'.repeat(50), data: bytesOf('a') }]);
    const extraZip = (): Uint8Array => raw([{ name: 'a.txt', data: bytesOf('a'), extraCentral: extra, extraLocal: extra }]);
    const commentZip = (): Uint8Array => raw([{ name: 'a.txt', data: bytesOf('a') }], { comment: bytesOf('c'.repeat(40)) });

    /** [key, limits, archive, observed, tools that refuse it at open] */
    const ROWS: Array<[string, Record<string, number>, () => Uint8Array, number, string[]]> = [
        ['maxEntries', { maxEntries: 1 }, basicZip, 4, ['inspect_zip', 'list_zip_entries', 'read_zip_entry', 'extract_zip', 'modify_zip']],
        ['maxEntryUncompressedSize', { maxEntryUncompressedSize: 100 }, basicZip, 0, ['extract_zip', 'read_zip_entry']],
        ['maxTotalUncompressedSize', { maxTotalUncompressedSize: 10 }, basicZip, 0, ['extract_zip']],
        ['maxCompressionRatio', { maxCompressionRatio: 2 }, highRatioZip, 0, ['extract_zip']],
        ['maxNameBytes', { maxNameBytes: 10 }, longName, 50, ['inspect_zip', 'list_zip_entries', 'scan_zip_forward']],
        ['maxExtraFieldBytes', { maxExtraFieldBytes: 10 }, extraZip, 44, ['inspect_zip', 'list_zip_entries', 'scan_zip_forward']],
        ['maxCommentBytes', { maxCommentBytes: 10 }, commentZip, 40, ['inspect_zip', 'list_zip_entries']],
        ['maxCentralDirectoryBytes', { maxCentralDirectoryBytes: 50 }, basicZip, 225, ['inspect_zip', 'list_zip_entries', 'modify_zip']],
    ];

    it('the table covers the in-memory keys exactly once (maxEntryCompressedSize is the byte-range reader, see tests/range-access.test.ts)', () => {
        expect(ROWS.map((r) => r[0]).sort()).toEqual(LIMIT_KEYS.filter((k) => k !== 'maxEntryCompressedSize').sort());
    });

    for (const [key, limits, make, observed, tools] of ROWS) {
        it(`${key}: read tools refuse with data.limit = '${key}'; verify_zip lands the code in error.code`, async () => {
            const zipBase64 = b64(make());
            for (const tool of tools) {
                const args: Record<string, unknown> = { zipBase64, limits };
                if (tool === 'read_zip_entry') args['index'] = 2; // docs/guide.md — the entry above 100 bytes
                if (tool === 'modify_zip') args['operations'] = [{ op: 'setComment', comment: 'c' }];
                const err = await refusal(tool, args);
                expect(err.code, tool).toBe('ZIP_LIMIT_EXCEEDED');
                expect(err.data, tool).toMatchObject({ errorClass: 'limit', limit: key, configured: limits[key] });
                if (observed > 0) expect(err.data['observed'], tool).toBe(observed);
            }
            const verified = await callToolDirect('verify_zip', { zipBase64, limits });
            expect(verified.isError).not.toBe(true);
            const sc = verified.structuredContent as { ok: boolean; error: { code: string; message: string } | null; entries: unknown[] };
            if (key === 'maxEntryUncompressedSize' || key === 'maxTotalUncompressedSize' || key === 'maxCompressionRatio') {
                // Extraction-time bounds: the structural open succeeds and verification reads no plan, so nothing fires here.
                expect(sc.error).toBeNull();
                expect(typeof sc.ok).toBe('boolean');
            } else {
                expect(sc.ok).toBe(false);
                expect(sc.error?.code).toBe('ZIP_LIMIT_EXCEEDED');
                expect(sc.error?.message).toContain(`limits.${key}`);
                expect(sc.entries).toEqual([]);
            }
        });
    }

    it('the writer side enforces maxNameBytes / maxCommentBytes / maxExtraFieldBytes on create_zip and maxCentralDirectoryBytes on modify_zip', async () => {
        expect(await refusal('create_zip', { entries: [{ name: 'x'.repeat(50), text: 'a' }], limits: { maxNameBytes: 10 } })).toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxNameBytes', configured: 10, observed: 50 } });
        expect(await refusal('create_zip', { entries: [{ name: 'a', text: 'a' }], comment: 'c'.repeat(50), limits: { maxCommentBytes: 10 } })).toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxCommentBytes', configured: 10, observed: 50 } });
        expect(await refusal('create_zip', { entries: [{ name: 'a', text: 'a', extraFields: [{ id: 0x6a6a, dataBase64: Buffer.alloc(40).toString('base64') }] }], limits: { maxExtraFieldBytes: 10 } })).toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxExtraFieldBytes', configured: 10, observed: 44 } });
        expect(await refusal('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'x', text: 'a' }], limits: { maxCentralDirectoryBytes: 200 } })).toMatchObject({ code: 'ZIP_LIMIT_EXCEEDED', data: { limit: 'maxCentralDirectoryBytes', configured: 200 } });
    });

    it('scan_zip_forward can only enforce the local-header bounds (name, extra field): comment and central-directory bounds have nothing to bite on', async () => {
        const scan = await callToolDirect('scan_zip_forward', { zipBase64: b64(commentZip()), limits: { maxCommentBytes: 10, maxCentralDirectoryBytes: 50 } });
        expect(scan.isError).not.toBe(true);
        expect((scan.structuredContent as { stoppedAt: string }).stoppedAt).toBe('central-directory');
    });
});
