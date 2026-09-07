/**
 * Tests for `src/limits.ts` — merging caller limits over the engine defaults
 * under the operator ceilings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_ZIP_LIMITS } from 'zipnative';

import { __resetCeilingsForTests, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, type Ceilings } from '../src/caps.js';
import { effectiveLimits, LIMIT_KEYS, LIMITS_INPUT_SCHEMA, LimitsSchema, resolveCallLimits } from '../src/limits.js';
import { ToolError } from '../src/errors.js';

const DEFAULT_CEILINGS: Ceilings = { maxUncompressedBytes: 8 * 1024 * 1024 * 1024, maxEntries: 100_000, maxWorkers: 8 };

describe('limits', () => {
    afterEach(() => {
        delete process.env[MAX_ENTRIES_ENV];
        delete process.env[MAX_UNCOMPRESSED_ENV];
        __resetCeilingsForTests();
    });

    it('the schema fragments cover the eight engine keys', () => {
        expect(LIMIT_KEYS).toHaveLength(8);
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
        expect(resolveCallLimits(undefined, tight)).toEqual({ maxEntries: 50, maxEntryUncompressedSize: 1024 * 1024, maxTotalUncompressedSize: 1024 * 1024 });
        expect(resolveCallLimits({ maxEntries: 20 }, tight)).toEqual({ maxEntries: 20, maxEntryUncompressedSize: 1024 * 1024, maxTotalUncompressedSize: 1024 * 1024 });
        process.env[MAX_ENTRIES_ENV] = '7';
        __resetCeilingsForTests();
        expect(resolveCallLimits(undefined)).toEqual({ maxEntries: 7 });
    });

    it('a value above the ceiling is LIMIT_CEILING_EXCEEDED naming the variable', () => {
        for (const [key, ceiling, env] of [
            ['maxEntries', 100_000, MAX_ENTRIES_ENV],
            ['maxEntryUncompressedSize', DEFAULT_CEILINGS.maxUncompressedBytes, MAX_UNCOMPRESSED_ENV],
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
