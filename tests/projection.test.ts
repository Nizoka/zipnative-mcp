import { describe, it, expect } from 'vitest';
import { parseFieldList, selectFields, readVerbosity, readFields } from '../src/projection.js';

describe('parseFieldList', () => {
    it('splits a comma-separated string into trimmed paths', () => {
        expect(parseFieldList('a, b.c ,, d')).toEqual(['a', 'b.c', 'd']);
    });

    it('accepts an array of paths and splits embedded commas', () => {
        expect(parseFieldList(['a', 'b.c,d'])).toEqual(['a', 'b.c', 'd']);
    });

    it('ignores non-string array entries and empty input', () => {
        expect(parseFieldList(['a', 42, null, ''])).toEqual(['a']);
        expect(parseFieldList(undefined)).toEqual([]);
        expect(parseFieldList(123)).toEqual([]);
    });
});

describe('selectFields', () => {
    const value = {
        a: 1,
        b: { c: 2, d: 3 },
        list: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    };

    it('projects a single top-level field', () => {
        expect(selectFields(value, ['a'])).toEqual({ a: 1 });
    });

    it('projects a nested dot-path preserving structure', () => {
        expect(selectFields(value, ['b.c'])).toEqual({ b: { c: 2 } });
    });

    it('maps an array segment over every element', () => {
        expect(selectFields(value, ['list.x'])).toEqual({ list: [{ x: 1 }, { x: 3 }] });
    });

    it('deep-merges multiple paths into one object', () => {
        expect(selectFields(value, ['a', 'b.d'])).toEqual({ a: 1, b: { d: 3 } });
    });

    it('omits unknown / non-existent paths leniently', () => {
        expect(selectFields(value, ['nope', 'b.zzz'])).toEqual({});
        expect(selectFields(value, ['a', 'nope'])).toEqual({ a: 1 });
    });

    it('returns an empty object when no paths resolve', () => {
        expect(selectFields(value, [])).toEqual({});
    });

    it('omits a path that walks into a primitive', () => {
        // `a` is the primitive 1; asking for `a.x` cannot resolve.
        expect(selectFields(value, ['a.x'])).toEqual({});
    });

    it('deep-merges two array-mapped paths element-wise', () => {
        expect(selectFields(value, ['list.x', 'list.y'])).toEqual({
            list: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
        });
    });

    it('last path wins on a scalar conflict', () => {
        expect(selectFields(value, ['a', 'a'])).toEqual({ a: 1 });
    });
});

describe('readVerbosity / readFields', () => {
    it("defaults verbosity to 'full' and reads 'summary' when requested", () => {
        expect(readVerbosity(undefined)).toBe('full');
        expect(readVerbosity({})).toBe('full');
        expect(readVerbosity({ verbosity: 'full' })).toBe('full');
        expect(readVerbosity({ verbosity: 'summary' })).toBe('summary');
        expect(readVerbosity({ verbosity: 'bogus' })).toBe('full');
    });

    it('reads the fields list defensively', () => {
        expect(readFields(undefined)).toEqual([]);
        expect(readFields({})).toEqual([]);
        expect(readFields({ fields: ['a', 'b.c'] })).toEqual(['a', 'b.c']);
        expect(readFields({ fields: 'a,b' })).toEqual(['a', 'b']);
    });
});

describe('fields projection — unmatched paths are surfaced', () => {
    it('adds _meta.unmatchedFields + availableFields when a requested path matches nothing, and nothing otherwise', async () => {
        const { callToolDirect, ensureEngineReady } = await import('../src/server.js');
        const { basicZip, b64 } = await import('./_zip-fixtures.js');
        await ensureEngineReady();
        const zipBase64 = b64(basicZip());
        const typo = await callToolDirect('inspect_zip', { zipBase64, fields: ['entrycount', 'isZip64'] });
        expect(typo.structuredContent).toEqual({ isZip64: false });
        expect(typo._meta).toEqual({ unmatchedFields: ['entrycount'], availableFields: expect.arrayContaining(['entryCount', 'isZip64']) });
        const exact = await callToolDirect('inspect_zip', { zipBase64, fields: ['entryCount'] });
        expect(exact._meta).toBeUndefined();
        const none = await callToolDirect('inspect_zip', { zipBase64 });
        expect(none._meta).toBeUndefined();
    });
});
