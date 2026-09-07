/**
 * Tests for `sanitize_entry_paths` — the engine's traversal gate over a list
 * of names, with the explanatory reason for every rejection.
 */
import { describe, it, expect } from 'vitest';

import { sanitizeEntryPaths, sanitizeReason, sanitizeSummary, SANITIZE_REASONS } from '../src/tools/sanitize-entry-paths.js';
import { callToolDirect } from '../src/server.js';

describe('sanitize_entry_paths', () => {
    it('maps safe names to their relative form', async () => {
        const out = await sanitizeEntryPaths({ names: ['docs/readme.md', 'a.txt', 'deep/er/file.bin'] });
        expect(out.count).toBe(3);
        expect(out.rejectedCount).toBe(0);
        expect(out.results).toEqual([
            { name: 'docs/readme.md', sanitized: 'docs/readme.md', rejected: false },
            { name: 'a.txt', sanitized: 'a.txt', rejected: false },
            { name: 'deep/er/file.bin', sanitized: 'deep/er/file.bin', rejected: false },
        ]);
    });

    it("collapses './' and '//' segments and normalises backslashes", async () => {
        const out = await sanitizeEntryPaths({ names: ['a/./b//c.txt', './x.txt', 'dir\\sub\\f.txt', 'dir/'] });
        expect(out.results.map((r) => r.sanitized)).toEqual(['a/b/c.txt', 'x.txt', 'dir/sub/f.txt', 'dir']);
        expect(out.rejectedCount).toBe(0);
    });

    it('rejects each hostile shape with its reason', async () => {
        const cases: Array<[string, string]> = [
            ['', 'empty'],
            ['a\0b.txt', 'nul'],
            ['/etc/passwd', 'absolute'],
            ['C:\\Windows\\win.ini', 'drive'],
            ['c:/x', 'drive'],
            ['\\\\server\\share\\f', 'unc'],
            ['//server/share', 'unc'],
            ['../../evil.txt', 'traversal'],
            ['a/../b', 'traversal'],
            ['dir/file.txt:stream', 'ads'],
            ['aux.txt', 'device-name'],
            ['dir/COM1', 'device-name'],
            ['nul', 'device-name'],
            ['.', 'no-segments'],
            ['./', 'no-segments'],
        ];
        const out = await sanitizeEntryPaths({ names: cases.map(([n]) => n) });
        expect(out.count).toBe(cases.length);
        expect(out.rejectedCount).toBe(cases.length);
        out.results.forEach((r, i) => {
            expect(r.sanitized, r.name).toBeNull();
            expect(r.rejected).toBe(true);
            expect(r.reason, r.name).toBe(cases[i]?.[1]);
            expect(SANITIZE_REASONS).toContain(r.reason);
        });
        expect(SANITIZE_REASONS).toHaveLength(9);
        expect(new Set(out.results.map((r) => r.reason)).size).toBe(9);
    });

    it('keeps the input order and mixes accepted and rejected rows', async () => {
        const out = await sanitizeEntryPaths({ names: ['ok.txt', '../no', 'also/ok', 'CON'] });
        expect(out.results.map((r) => r.rejected)).toEqual([false, true, false, true]);
        expect(out.count).toBe(4);
        expect(out.rejectedCount).toBe(2);
        expect(sanitizeSummary(out)).toEqual({ count: 4, rejectedCount: 2, rejectedNames: ['../no', 'CON'] });
    });

    it('sanitizeReason re-derives the engine order of checks', () => {
        expect(sanitizeReason('')).toBe('empty');
        expect(sanitizeReason('\0')).toBe('nul');
        expect(sanitizeReason('//x')).toBe('unc');
        expect(sanitizeReason('/x')).toBe('absolute');
        expect(sanitizeReason('D:x')).toBe('drive');
        expect(sanitizeReason('a/..')).toBe('traversal');
        expect(sanitizeReason('a/b:c')).toBe('ads');
        expect(sanitizeReason('lpt9.log')).toBe('device-name');
        expect(sanitizeReason('safe/name')).toBe('no-segments');
    });

    it('validates the input list', async () => {
        await expect(sanitizeEntryPaths({ names: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(sanitizeEntryPaths({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(sanitizeEntryPaths({ names: ['a'.repeat(4097)] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(sanitizeEntryPaths({ names: [1] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(sanitizeEntryPaths({ names: Array.from({ length: 10_001 }, () => 'a') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('wire level: text line, summary and fields', async () => {
        const r = await callToolDirect('sanitize_entry_paths', { names: ['a', '../b'], verbosity: 'summary' });
        expect(r.isError).toBeUndefined();
        expect((r.content[0] as { text: string }).text).toBe('sanitize_entry_paths: 1 of 2 name(s) rejected.');
        expect(r.structuredContent).toEqual({ count: 2, rejectedCount: 1, rejectedNames: ['../b'] });
        const fields = await callToolDirect('sanitize_entry_paths', { names: ['a', '../b'], fields: ['results.sanitized'] });
        expect(fields.structuredContent).toEqual({ results: [{ sanitized: 'a' }, { sanitized: null }] });
    });
});
