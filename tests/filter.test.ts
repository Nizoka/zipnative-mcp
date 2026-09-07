/**
 * Tests for `src/filter.ts` — the glob compiler and the entry filter.
 */
import { describe, it, expect } from 'vitest';

import { compileEntryFilter, compileGlob, FILTER_INPUT_SCHEMA, FilterSchema, isPassThrough } from '../src/filter.js';

function matches(pattern: string, name: string): boolean {
    return compileGlob(pattern).test(name);
}

describe('compileGlob', () => {
    it('a pattern without a slash matches at any depth', () => {
        expect(matches('*.txt', 'a.txt')).toBe(true);
        expect(matches('*.txt', 'dir/sub/a.txt')).toBe(true);
        expect(matches('*.txt', 'a.txtx')).toBe(false);
        expect(matches('*.txt', 'a.md')).toBe(false);
        expect(matches('README.md', 'docs/README.md')).toBe(true);
    });

    it('a pattern with a slash is anchored; * stays within a segment', () => {
        expect(matches('src/*.js', 'src/index.js')).toBe(true);
        expect(matches('src/*.js', 'src/sub/index.js')).toBe(false);
        expect(matches('src/*.js', 'other/src/index.js')).toBe(false);
        expect(matches('src/*', 'src/a')).toBe(true);
        expect(matches('src/*', 'src/a/b')).toBe(false);
    });

    it('** spans segments (zero or more)', () => {
        expect(matches('**/*.json', 'a.json')).toBe(true);
        expect(matches('**/*.json', 'x/y/z/a.json')).toBe(true);
        expect(matches('src/**/*.js', 'src/index.js')).toBe(true);
        expect(matches('src/**/*.js', 'src/a/b/index.js')).toBe(true);
        expect(matches('src/**/*.js', 'lib/index.js')).toBe(false);
        expect(matches('src/**', 'src/a/b/c')).toBe(true);
        expect(matches('a**b', 'axx/yyb')).toBe(true);
    });

    it('? matches exactly one non-slash character', () => {
        expect(matches('a?.txt', 'ab.txt')).toBe(true);
        expect(matches('a?.txt', 'a.txt')).toBe(false);
        expect(matches('a?.txt', 'a/.txt')).toBe(false);
        expect(matches('a??', 'abc')).toBe(true);
    });

    it('[abc] character classes pass through; an unclosed bracket is literal', () => {
        expect(matches('file[123].txt', 'file2.txt')).toBe(true);
        expect(matches('file[123].txt', 'file4.txt')).toBe(false);
        expect(matches('file[a-c].txt', 'fileb.txt')).toBe(true);
        expect(matches('file[.txt', 'file[.txt')).toBe(true);
        expect(matches('file[.txt', 'filex.txt')).toBe(false);
    });

    it("a trailing '/' matches the whole subtree (and the directory itself)", () => {
        expect(matches('docs/', 'docs/guide.md')).toBe(true);
        expect(matches('docs/', 'docs/a/b.md')).toBe(true);
        expect(matches('docs/', 'docs')).toBe(true);
        expect(matches('docs/', 'docs2/x')).toBe(false);
        expect(matches('docs/', 'x/docs/a')).toBe(false);
    });

    it("escapes regex specials, normalises backslashes and strips a leading './'", () => {
        expect(matches('a.b', 'axb')).toBe(false);
        expect(matches('a+b(c)', 'a+b(c)')).toBe(true);
        expect(matches('a$b^c|d{e}', 'a$b^c|d{e}')).toBe(true);
        expect(matches('src\\*.js', 'src/index.js')).toBe(true);
        expect(matches('./src/*.js', 'src/index.js')).toBe(true);
        expect(matches('Src/*.js', 'src/index.js')).toBe(false);
    });
});

describe('compileEntryFilter', () => {
    it('no input keeps every non-directory entry', () => {
        const keep = compileEntryFilter(undefined);
        expect(keep('a.txt', false)).toBe(true);
        expect(keep('dir/', true)).toBe(false);
        expect(isPassThrough(undefined)).toBe(true);
        expect(isPassThrough({ includeDirectories: true })).toBe(true);
        expect(isPassThrough({ prefix: 'a', includeDirectories: false })).toBe(false);
    });

    it('includeDirectories keeps directory rows', () => {
        const keep = compileEntryFilter({ includeDirectories: true });
        expect(keep('dir/', true)).toBe(true);
        const none = compileEntryFilter({ includeDirectories: false });
        expect(none('dir/', true)).toBe(false);
    });

    it('names match with and without the trailing slash', () => {
        const keep = compileEntryFilter({ names: ['a.txt', 'dir'], includeDirectories: true });
        expect(keep('a.txt', false)).toBe(true);
        expect(keep('dir/', true)).toBe(true);
        expect(keep('dir', true)).toBe(true);
        expect(keep('b.txt', false)).toBe(false);
        expect(keep('A.txt', false)).toBe(false);
        const slashName = compileEntryFilter({ names: ['dir/'], includeDirectories: true });
        expect(slashName('dir/', true)).toBe(true);
    });

    it('prefix, glob and names are ANDed; globs are ORed', () => {
        const keep = compileEntryFilter({ prefix: 'src/', glob: ['*.js', '*.ts'], includeDirectories: false });
        expect(keep('src/a.js', false)).toBe(true);
        expect(keep('src/a.ts', false)).toBe(true);
        expect(keep('src/a.md', false)).toBe(false);
        expect(keep('lib/a.js', false)).toBe(false);
        const all = compileEntryFilter({ names: ['src/a.js'], prefix: 'src/', glob: ['**/*.js'], includeDirectories: false });
        expect(all('src/a.js', false)).toBe(true);
        expect(all('src/b.js', false)).toBe(false);
    });

    it('backslash names are normalised and directory globs see the bare name', () => {
        const keep = compileEntryFilter({ glob: ['src/*.js'], includeDirectories: true });
        expect(keep('src\\a.js', false)).toBe(true);
        const dirs = compileEntryFilter({ glob: ['docs'], includeDirectories: true });
        expect(dirs('docs/', true)).toBe(true);
    });

    it('the Zod twin mirrors the JSON Schema', () => {
        expect(Object.keys(FILTER_INPUT_SCHEMA.properties)).toEqual(Object.keys(FilterSchema.shape));
        expect(FilterSchema.parse({})).toEqual({ includeDirectories: false });
        expect(FilterSchema.safeParse({ names: [''] }).success).toBe(false);
        expect(FilterSchema.safeParse({ glob: Array.from({ length: 33 }, () => '*') }).success).toBe(false);
        expect(FilterSchema.safeParse({ names: Array.from({ length: 1001 }, () => 'a') }).success).toBe(false);
        expect(FilterSchema.safeParse({ extra: 1 }).success).toBe(false);
    });
});
