/**
 * veraZIP in-process gate: the conformance corpus (scripts/helpers/zip-corpus.mjs)
 * produced through `callToolDirect` from src/ and validated by the vendored
 * ISO/IEC 21320-1 core — the same entries, assertions and verdicts the CI
 * script pipeline (`npm run validate:zip`) runs against dist/, minus the
 * foreign-tool level. Every tool-produced archive must be conformant and pass
 * verify_zip; every crafted hostile shape must be refused with its ZIP_* code;
 * every crafted negative must fail with the check id it declares.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    assertRefused,
    assertVerified,
    buildCorpus,
    createContext,
    produceEntry,
    type CorpusCall,
    type CorpusContext,
    type CorpusEntry,
    type CorpusToolResult,
} from '../scripts/helpers/zip-corpus.mjs';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { validateArchive } from './_zip-assert.js';

const call: CorpusCall = async (tool, args) => (await callToolDirect(tool, args)) as CorpusToolResult;

const sandboxDir = mkdtempSync(join(tmpdir(), 'zipnative-mcp-verazip-'));
const corpus: CorpusEntry[] = buildCorpus({ call, sandboxDir }).filter((e) => !e.scriptOnly);
const ctx: CorpusContext = createContext({ call, sandboxDir });
const produced = new Map<string, Uint8Array>();
const productionErrors = new Map<string, string>();

const savedEnv = { output: process.env['ZIPNATIVE_MCP_OUTPUT_DIR'], cache: process.env['ZIPNATIVE_MCP_CACHE_DIR'] };

beforeAll(async () => {
    process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = sandboxDir;
    delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    await ensureEngineReady();
    // Sequential by design: later entries consume earlier outputs.
    for (const entry of corpus) {
        try {
            produced.set(entry.file, await produceEntry(entry, ctx));
        } catch (err) {
            productionErrors.set(entry.file, err instanceof Error ? err.message : String(err));
        }
    }
}, 120_000);

afterAll(() => {
    if (savedEnv.output === undefined) delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    else process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = savedEnv.output;
    if (savedEnv.cache !== undefined) process.env['ZIPNATIVE_MCP_CACHE_DIR'] = savedEnv.cache;
    rmSync(sandboxDir, { recursive: true, force: true });
});

function bytesOf(file: string): Uint8Array {
    const error = productionErrors.get(file);
    if (error !== undefined) throw new Error(`${file} was not produced: ${error}`);
    const bytes = produced.get(file);
    if (bytes === undefined) throw new Error(`${file} was not produced`);
    return bytes;
}

describe('veraZIP corpus (in-process, src/)', () => {
    it('covers every entry of the shared corpus definition', () => {
        expect(corpus.length).toBeGreaterThanOrEqual(38);
        expect(new Set(corpus.map((e) => e.file)).size).toBe(corpus.length);
    });

    for (const entry of corpus) {
        describe(entry.file, () => {
            it(`is produced by ${entry.tool ?? 'the raw builder'} and passes its structural assertions`, () => {
                expect(productionErrors.get(entry.file), productionErrors.get(entry.file)).toBeUndefined();
                expect(bytesOf(entry.file).length).toBeGreaterThanOrEqual(22);
            });

            if (entry.expectConformant) {
                it('is ISO/IEC 21320-1 conformant (zero findings)', () => {
                    const report = validateArchive(bytesOf(entry.file), entry.file);
                    expect(report.failures.map((f) => `${f.check}: ${f.detail}`)).toEqual([]);
                });
            } else {
                it(`is rejected with ${entry.expectedCheck}`, () => {
                    const report = validateArchive(bytesOf(entry.file), entry.file);
                    expect(report.failures.map((f) => f.check)).toContain(entry.expectedCheck);
                });
            }

            if (entry.expectConformant && entry.producedBy !== 'crafted') {
                it('passes verify_zip with ok: true', async () => {
                    await expect(assertVerified(entry, bytesOf(entry.file), ctx)).resolves.toMatchObject({ ok: true });
                });
            }

            if (entry.refusedBy !== null) {
                const { tool, code } = entry.refusedBy;
                it(`is refused by ${tool} with [${code}]`, async () => {
                    await expect(assertRefused(entry, bytesOf(entry.file), ctx)).resolves.toMatchObject({ tool, code });
                });
            }
        });
    }
});

describe('structural pairs', () => {
    it('deterministic-a / deterministic-b are byte-identical', () => {
        expect(Buffer.from(bytesOf('deterministic-b.zip')).equals(Buffer.from(bytesOf('deterministic-a.zip')))).toBe(true);
    });

    it('parallel-parallel equals parallel-sequential byte for byte', () => {
        expect(Buffer.from(bytesOf('parallel-parallel.zip')).equals(Buffer.from(bytesOf('parallel-sequential.zip')))).toBe(true);
    });

    it('append-mode modify keeps the original bytes as its prefix and the removed payload (remanence)', () => {
        const original = bytesOf('incremental-original.zip');
        const appended = bytesOf('incremental-appended.zip');
        expect(Buffer.from(appended.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true);
        expect(Buffer.from(appended).includes('REMANENT-LOG-CONTENT')).toBe(true);
    });

    it('compact-mode modify drops the removed payload', () => {
        expect(Buffer.from(bytesOf('incremental-compacted.zip')).includes('REMANENT-LOG-CONTENT')).toBe(false);
    });

    it('the SFX-prefixed sample does not start with PK but carries a local header after the stub', () => {
        const bytes = Buffer.from(bytesOf('edge-sfx-prefixed.zip'));
        expect(bytes.subarray(0, 2).toString('ascii')).not.toBe('PK');
        expect(bytes.indexOf(Buffer.from('PK\x03\x04', 'latin1'))).toBeGreaterThan(0);
    });

    it('the file-mode sample equals the base64-mode bytes of the same call', () => {
        expect(Buffer.from(bytesOf('file-mode-sandbox.zip')).equals(Buffer.from(bytesOf('basic-deflate-6.zip')))).toBe(true);
    });
});
