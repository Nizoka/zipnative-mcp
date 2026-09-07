/**
 * Tests for `src/caps.ts` — the operator ceilings and the input-size guard.
 */
import { describe, it, expect, afterEach } from 'vitest';

import * as caps from '../src/caps.js';
import {
    __resetCeilingsForTests, assertInputWithin, CAPS, DEFAULT_MAX_ENTRIES_CEILING, DEFAULT_MAX_UNCOMPRESSED_CEILING, DEFAULT_WORKERS_CEILING,
    getCeilings, MAX_BASE64_INPUT_BYTES, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, readCeilings, WORKERS_ENV,
} from '../src/caps.js';
import { ToolError } from '../src/errors.js';

const ENV = [MAX_UNCOMPRESSED_ENV, MAX_ENTRIES_ENV, WORKERS_ENV];

describe('caps', () => {
    afterEach(() => {
        for (const name of ENV) delete process.env[name];
        __resetCeilingsForTests();
    });

    it('readCeilings returns the engine defaults for an empty environment', () => {
        expect(readCeilings({})).toEqual({ maxUncompressedBytes: DEFAULT_MAX_UNCOMPRESSED_CEILING, maxEntries: DEFAULT_MAX_ENTRIES_CEILING, maxWorkers: DEFAULT_WORKERS_CEILING });
        expect(readCeilings({ [MAX_ENTRIES_ENV]: '' })).toEqual(readCeilings({}));
        expect(DEFAULT_MAX_UNCOMPRESSED_CEILING).toBe(8 * 1024 * 1024 * 1024);
        expect(DEFAULT_MAX_ENTRIES_CEILING).toBe(100_000);
        expect(DEFAULT_WORKERS_CEILING).toBe(8);
    });

    it('readCeilings parses valid values (whitespace tolerated)', () => {
        expect(readCeilings({ [MAX_UNCOMPRESSED_ENV]: '1024', [MAX_ENTRIES_ENV]: ' 1 ', [WORKERS_ENV]: '0' })).toEqual({ maxUncompressedBytes: 1024, maxEntries: 1, maxWorkers: 0 });
        expect(readCeilings({ [WORKERS_ENV]: '64' }).maxWorkers).toBe(64);
    });

    it('readCeilings refuses invalid and below-minimum values by name', () => {
        expect(() => readCeilings({ [MAX_ENTRIES_ENV]: 'ten' })).toThrow(new RegExp(`${MAX_ENTRIES_ENV} must be a non-negative integer`));
        expect(() => readCeilings({ [MAX_ENTRIES_ENV]: '-1' })).toThrow(/non-negative integer/);
        expect(() => readCeilings({ [MAX_ENTRIES_ENV]: '1.5' })).toThrow(/non-negative integer/);
        expect(() => readCeilings({ [MAX_ENTRIES_ENV]: '0' })).toThrow(new RegExp(`${MAX_ENTRIES_ENV} must be an integer >= 1`));
        expect(() => readCeilings({ [MAX_UNCOMPRESSED_ENV]: '1023' })).toThrow(/>= 1024/);
        expect(() => readCeilings({ [MAX_UNCOMPRESSED_ENV]: '99999999999999999999' })).toThrow(/integer >= 1024/);
        expect(() => readCeilings({ [WORKERS_ENV]: '0' })).not.toThrow();
    });

    it('getCeilings memoises until reset', () => {
        process.env[MAX_ENTRIES_ENV] = '42';
        __resetCeilingsForTests();
        expect(getCeilings().maxEntries).toBe(42);
        process.env[MAX_ENTRIES_ENV] = '43';
        expect(getCeilings().maxEntries).toBe(42);
        __resetCeilingsForTests();
        expect(getCeilings().maxEntries).toBe(43);
        expect(getCeilings()).toBe(getCeilings());
    });

    it('assertInputWithin throws INPUT_TOO_LARGE with the observed / cap detail', () => {
        expect(() => assertInputWithin(10, 10, 'x')).not.toThrow();
        expect(() => assertInputWithin(0, 0, 'x')).not.toThrow();
        try {
            assertInputWithin(11, 10, 'zipBase64 (decoded)');
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(ToolError);
            expect((e as ToolError).code).toBe('INPUT_TOO_LARGE');
            expect((e as ToolError).message).toBe('zipBase64 (decoded) is 11 bytes, above the 10-byte cap.');
            expect((e as ToolError).data).toEqual({ what: 'zipBase64 (decoded)', observed: 11, cap: 10 });
        }
    });

    it('the serialisable CAPS view mirrors the constants', () => {
        expect(CAPS.maxBase64InputBytes).toBe(MAX_BASE64_INPUT_BYTES);
        // The headline values are pinned (they are quoted in the docs) …
        expect(CAPS).toMatchObject({
            stdioMaxFrameBytes: 256 * 1024 * 1024,
            maxBase64InputBytes: 128 * 1024 * 1024,
            maxPathInputBytes: 1024 * 1024 * 1024,
            maxBase64OutputBytes: 50 * 1024 * 1024,
            maxFileOutputBytes: 4 * 1024 * 1024 * 1024,
            maxEntryInlineBytes: 16 * 1024 * 1024,
            maxExtractInlineTotalBytes: 32 * 1024 * 1024,
            maxListLimit: 2000,
            defaultListLimit: 200,
            maxCreateEntries: 100_000,
            maxModifyOperations: 1000,
            maxSanitizeNames: 10_000,
            maxDiagnostics: 200,
            defaultScanMaxEntries: 10_000,
            maxListedResources: 1000,
            maxResourceWalkDepth: 8,
            maxResourceReadBytes: 50 * 1024 * 1024,
            cacheTtlSeconds: 3600,
            cacheMaxBytes: 256 * 1024 * 1024,
        });
        expect(Object.values(CAPS).every((v) => Number.isInteger(v) && v > 0)).toBe(true);
    });

    it('A-008: every numeric constant exported by src/caps.ts (except the ceiling defaults) is advertised in CAPS', () => {
        // Ceiling defaults are reported by describe_engine under `ceilings`, not `caps`.
        const ceilingNames = new Set(['DEFAULT_MAX_UNCOMPRESSED_CEILING', 'DEFAULT_MAX_ENTRIES_CEILING', 'DEFAULT_WORKERS_CEILING']);
        expect(DEFAULT_MAX_UNCOMPRESSED_CEILING + DEFAULT_MAX_ENTRIES_CEILING + DEFAULT_WORKERS_CEILING).toBeGreaterThan(0);
        const advertised = new Set(Object.values(CAPS));
        const numericExports = Object.entries(caps).filter(([name, value]) => typeof value === 'number' && !ceilingNames.has(name));
        expect(numericExports.length).toBe(Object.keys(CAPS).length);
        const missing = numericExports.filter(([, value]) => !advertised.has(value as number)).map(([name]) => name);
        expect(missing, `caps.ts constants missing from CAPS: ${missing.join(', ')}`).toEqual([]);
        // Every CAPS key maps back to a constant with the same value.
        for (const [key, value] of Object.entries(CAPS)) {
            expect(numericExports.some(([, v]) => v === value), `CAPS.${key} = ${value} has no source constant`).toBe(true);
        }
    });
});
