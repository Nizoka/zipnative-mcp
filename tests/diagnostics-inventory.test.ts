/**
 * B-009 — the diagnostic inventory: every one of the engine's 11 diagnostic
 * codes is produced by a tool call through the wrapper, with the construction
 * that reaches it. The table is guarded against `ZIP_DIAGNOSTIC_CODES` so a
 * new engine diagnostic (or a dropped one) fails here instead of silently
 * going unproven. Each row asserts the code, its severity and — when the
 * engine scopes it — the entry name in `structuredContent.diagnostics`.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { ZIP_DIAGNOSTIC_CODES } from '../src/zip-errors.js';
import { patternBytes } from './_sandbox.js';
import { b64, basicZip, DUPLICATE_NAME, INVALID_UTF8_NAME, LFH_NAME_MISMATCH, MALFORMED_EXTRA, SFX_PREFIXED, UNICODE_PATH_CONFLICT, ZIP64_EXTRA_IGNORED } from './_zip-fixtures.js';

interface DiagnosticRow {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly entryName?: string;
}

interface Row {
    readonly code: (typeof ZIP_DIAGNOSTIC_CODES)[number];
    readonly tool: string;
    readonly args: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    readonly severity: 'info' | 'warning';
    readonly entryName?: string;
    /** Extra facts the result must carry alongside the diagnostic. */
    readonly also?: Record<string, unknown>;
}

/** One `modify_zip` append-mode output: the original EOCD stays inside the file (ZIP_MULTIPLE_EOCD on the next open). */
async function appendedArchive(): Promise<string> {
    const r = await callToolDirect('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'n.txt', text: 'n' }] });
    expect(r.isError).not.toBe(true);
    return (r.content[1] as { resource: { blob: string } }).resource.blob;
}

/** A stored 8 KiB entry next to a tiny one: removing the big one leaves > 50 % dead bytes under mode 'append'. */
async function mostlyDeadSource(): Promise<string> {
    const r = await callToolDirect('create_zip', { entries: [{ name: 'big.bin', dataBase64: Buffer.from(patternBytes(8192)).toString('base64'), compression: { method: 'store' } }, { name: 'tiny.txt', text: 't' }] });
    expect(r.isError).not.toBe(true);
    return (r.content[1] as { resource: { blob: string } }).resource.blob;
}

const ROWS: readonly Row[] = [
    { code: 'ZIP_PREPENDED_DATA', tool: 'inspect_zip', args: () => ({ zipBase64: b64(SFX_PREFIXED()) }), severity: 'info', also: { prependedData: true } },
    { code: 'ZIP_MULTIPLE_EOCD', tool: 'inspect_zip', args: async () => ({ zipBase64: await appendedArchive() }), severity: 'info', also: { multipleEocd: true, entryCount: 5 } },
    { code: 'ZIP_NAME_MISMATCH', tool: 'read_zip_entry', args: () => ({ zipBase64: b64(LFH_NAME_MISMATCH()), index: 0 }), severity: 'warning', entryName: 'central.txt' },
    { code: 'ZIP_UNICODE_PATH_CONFLICT', tool: 'inspect_zip', args: () => ({ zipBase64: b64(UNICODE_PATH_CONFLICT()) }), severity: 'warning', entryName: 'a.txt' },
    // The entry name the engine attaches is the CP437 re-decoding of the bytes (host-independent, but not a literal worth pinning).
    { code: 'ZIP_INVALID_UTF8_NAME', tool: 'inspect_zip', args: () => ({ zipBase64: b64(INVALID_UTF8_NAME()) }), severity: 'warning', entryName: '*', also: { cp437NameCount: 1 } },
    { code: 'ZIP_DUPLICATE_NAME', tool: 'read_zip_entry', args: () => ({ zipBase64: b64(DUPLICATE_NAME()), name: 'a', encoding: 'utf8' }), severity: 'warning', entryName: 'a', also: { text: 'second' } },
    { code: 'ZIP_EXTRA_FIELD_MALFORMED', tool: 'list_zip_entries', args: () => ({ zipBase64: b64(MALFORMED_EXTRA()) }), severity: 'warning', entryName: 'a.txt' },
    { code: 'ZIP_ZIP64_EXTRA_IGNORED', tool: 'inspect_zip', args: () => ({ zipBase64: b64(ZIP64_EXTRA_IGNORED()) }), severity: 'warning', entryName: 'a.txt', also: { zip64EntryCount: 0, isZip64: false } },
    { code: 'ZIP_TIMESTAMP_NOT_PINNED', tool: 'create_zip', args: () => ({ entries: [{ name: 'a.txt', text: 'a' }], defaultDate: 'now' }), severity: 'info' },
    { code: 'ZIP_NONDETERMINISTIC_CODEC', tool: 'create_zip', args: () => ({ entries: [{ name: 'a.txt', text: 'a'.repeat(100) }], defaultDate: '2024-06-01T12:34:56Z' }), severity: 'info' },
    { code: 'ZIP_DEAD_BYTES_RATIO', tool: 'modify_zip', args: async () => ({ zipBase64: await mostlyDeadSource(), operations: [{ op: 'remove', name: 'big.bin' }] }), severity: 'info' },
];

describe('B-009: every one of the 11 diagnostic codes is produced by a tool call', () => {
    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        await ensureEngineReady();
    });

    it('the table covers ZIP_DIAGNOSTIC_CODES exactly (no missing, no extra, no duplicate)', () => {
        expect(ZIP_DIAGNOSTIC_CODES).toHaveLength(11);
        expect([...ROWS.map((r) => r.code)].sort()).toEqual([...ZIP_DIAGNOSTIC_CODES].sort());
        expect(new Set(ROWS.map((r) => r.code)).size).toBe(ROWS.length);
    });

    for (const row of ROWS) {
        it(`${row.code} ← ${row.tool}`, async () => {
            const r = await callToolDirect(row.tool, await row.args());
            expect(r.isError, JSON.stringify(r.content[0])).not.toBe(true);
            const sc = r.structuredContent as Record<string, unknown> & { diagnostics: DiagnosticRow[]; diagnosticCounts: Record<string, number> };
            const hit = sc.diagnostics.find((d) => d.code === row.code);
            expect(hit, `${row.code} in ${JSON.stringify(sc.diagnostics)}`).toBeDefined();
            expect(hit?.severity).toBe(row.severity);
            expect(typeof hit?.message).toBe('string');
            expect(hit?.message.length).toBeGreaterThan(20);
            if (row.entryName === '*') expect(typeof hit?.entryName).toBe('string');
            else if (row.entryName !== undefined) expect(hit?.entryName).toBe(row.entryName);
            else expect(hit?.entryName).toBeUndefined();
            expect(sc.diagnosticCounts[row.code]).toBeGreaterThanOrEqual(1);
            if (row.also !== undefined) expect(sc).toMatchObject(row.also);
            // strict:true escalates the same construction (the tools that take `strict`).
            if (row.tool !== 'verify_zip') {
                const strict = await callToolDirect(row.tool, { ...(await row.args()), strict: true });
                expect(strict.isError, `${row.code} under strict`).toBe(true);
                expect((strict._meta as { error: { code: string; message: string } }).error.code).toBe('ZIP_STRICT_DIAGNOSTIC');
                expect((strict._meta as { error: { code: string; message: string } }).error.message).toContain(row.code);
            }
        });
    }

    it('the summary projection keeps diagnosticCount for every producing tool', async () => {
        for (const row of ROWS.filter((x) => ['inspect_zip', 'list_zip_entries', 'read_zip_entry'].includes(x.tool))) {
            const r = await callToolDirect(row.tool, { ...(await row.args()), verbosity: 'summary' });
            expect((r.structuredContent as { diagnosticCount: number }).diagnosticCount, row.code).toBeGreaterThanOrEqual(1);
        }
    });
});
