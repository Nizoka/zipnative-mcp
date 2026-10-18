/**
 * Tests for `src/filter.ts` — the glob compiler and the entry filter.
 */
import { describe, it, expect } from 'vitest';

import { MAX_GLOB_LENGTH } from '../src/caps.js';
import { compileEntryFilter, compileGlob, FILTER_INPUT_SCHEMA, FilterSchema, globError, GlobSyntaxError, isPassThrough } from '../src/filter.js';

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

/**
 * The 1.0.0 translation to a backtracking RegExp, kept here as the reference
 * semantics: the linear matcher must agree with it on every input where the
 * RegExp is well-defined.
 */
function referenceRegex(pattern: string): RegExp {
    let p = pattern.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    let source = '';
    let anyDepth = !p.includes('/');
    if (p.endsWith('/')) {
        p = p.slice(0, -1);
        source = '(?:/.*)?';
        anyDepth = false;
    }
    let body = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i] as string;
        if (c === '*') {
            if (p[i + 1] === '*') {
                i++;
                if (p[i + 1] === '/') {
                    i++;
                    body += '(?:.*/)?';
                } else {
                    body += '.*';
                }
            } else {
                body += '[^/]*';
            }
        } else if (c === '?') {
            body += '[^/]';
        } else if (c === '[') {
            const end = p.indexOf(']', i + 1);
            if (end === -1) {
                body += '\\[';
            } else {
                body += p.slice(i, end + 1);
                i = end;
            }
        } else {
            body += c.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${body}${source}$`);
}

describe('compileGlob — linear matcher (1.1.0)', () => {
    it('agrees with the 1.0.0 RegExp translation on 20 000 seeded pattern / name pairs', () => {
        let seed = 0x5eed;
        const rand = (n: number): number => {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return (seed >>> 8) % n;
        };
        const PATTERN_PARTS = ['a', 'b', '.', '/', '*', '**', '**/', '?', '[ab]', '[^a]', '[a-c]', 'x', '['];
        const NAME_CHARS = ['a', 'b', 'c', '.', '/', 'x', '['];
        for (let n = 0; n < 20_000; n++) {
            let pattern = '';
            const parts = 1 + rand(5);
            for (let i = 0; i < parts; i++) pattern += PATTERN_PARTS[rand(PATTERN_PARTS.length)];
            if (rand(6) === 0) pattern += '/';
            let name = '';
            const len = rand(9);
            for (let i = 0; i < len; i++) name += NAME_CHARS[rand(NAME_CHARS.length)];
            expect(compileGlob(pattern).test(name), `${pattern} vs ${name}`).toBe(referenceRegex(pattern).test(name));
        }
    });

    it('CWE-1333: a pathological pattern over a long name finishes in linear time', () => {
        const name = 'a'.repeat(4096);
        for (const pattern of ['*a*a*a*a*a*a*a*b', '**a**a**a**a**b', '?*?*?*?*?*?*b']) {
            const started = performance.now();
            expect(compileGlob(pattern).test(name)).toBe(false);
            expect(performance.now() - started, pattern).toBeLessThan(500);
        }
    });

    it('classes: ranges, negation (including /), empty and match-all classes', () => {
        expect(compileGlob('[^a]').test('/')).toBe(true);
        expect(compileGlob('x[^a]y').test('x/y')).toBe(true);
        expect(compileGlob('x[]y').test('xy')).toBe(false);
        expect(compileGlob('x[^]y').test('x-y')).toBe(true);
        expect(compileGlob('[a-]').test('-')).toBe(true);
        expect(compileGlob('[-a]').test('-')).toBe(true);
    });

    it('an inverted class range is a GlobSyntaxError and a validation issue, never an uncaught SyntaxError', () => {
        expect(() => compileGlob('file[z-a].txt')).toThrow(GlobSyntaxError);
        expect(globError('file[z-a].txt')).toMatch(/invalid character class range 'z-a'/);
        expect(globError('*.txt')).toBeNull();
        const parsed = FilterSchema.safeParse({ glob: ['[z-a]'] });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toMatch(/^invalid glob: /);
    });

    it('a pattern longer than MAX_GLOB_LENGTH is refused at the boundary', () => {
        expect(FilterSchema.safeParse({ glob: ['a'.repeat(MAX_GLOB_LENGTH)] }).success).toBe(true);
        expect(FilterSchema.safeParse({ glob: ['a'.repeat(MAX_GLOB_LENGTH + 1)] }).success).toBe(false);
        expect(FILTER_INPUT_SCHEMA.properties.glob.items.maxLength).toBe(MAX_GLOB_LENGTH);
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
