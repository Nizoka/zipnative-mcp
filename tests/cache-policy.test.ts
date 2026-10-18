/**
 * Server-level cache policy: what the opt-in response
 * cache may serve, how a hit is signalled, and what the key is namespaced by.
 *
 * Never cached: sandbox references (`zipPath` / `sourcePath` — a path is a
 * reference, not content), `outputMode: 'file'` (the write is the effect),
 * `defaultDate: 'now'` (wall clock), `parallel` (timing-dependent fallbacks),
 * `describe_engine` (environment) and `draft_governance_issue` (environment
 * embedded in the draft).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { getCeilings } from '../src/caps.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from '../src/version.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip } from './_zip-fixtures.js';

let cacheDir: string;

beforeAll(async () => {
    await ensureEngineReady();
});

beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'zipnative-cache-policy-'));
    process.env['ZIPNATIVE_MCP_CACHE_DIR'] = cacheDir;
});

afterEach(() => {
    delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    rmSync(cacheDir, { recursive: true, force: true });
});

const CREATE = { entries: [{ name: 'a.txt', text: 'cache' }, { name: 'dir/b.txt', text: 'me' }] };

function cachedFiles(): string[] {
    return readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
}

function cachedFlag(result: { _meta?: Record<string, unknown> }): unknown {
    return (result._meta as Record<string, unknown> | undefined)?.['cached'];
}

describe('response cache policy', () => {
    it('marks a served-from-cache create_zip result with _meta.cached=true and leaves the first (fresh) result unmarked', async () => {
        const fresh = await callToolDirect('create_zip', CREATE);
        expect(fresh.isError).not.toBe(true);
        expect(cachedFlag(fresh)).toBeUndefined();
        expect(cachedFiles()).toHaveLength(1);

        const hit = await callToolDirect('create_zip', CREATE);
        expect(cachedFlag(hit)).toBe(true);
        expect(hit.structuredContent).toEqual(fresh.structuredContent);
        // The archive bytes are replayed verbatim from the cache entry.
        const blob = (hit.content.find((c) => c.type === 'resource') as { resource: { blob: string } }).resource.blob;
        expect(blob).toBe((fresh.content.find((c) => c.type === 'resource') as { resource: { blob: string } }).resource.blob);
        assertValidZip(blob);
    });

    it('a cached inspect_zip hit carries _meta.cached and the same projected structuredContent', async () => {
        const args = { zipBase64: b64(basicZip()), verbosity: 'summary', fields: ['entryCount', 'deterministic'] };
        const fresh = await callToolDirect('inspect_zip', args);
        expect(fresh.isError).not.toBe(true);
        expect(cachedFlag(fresh)).toBeUndefined();
        const hit = await callToolDirect('inspect_zip', args);
        expect(cachedFlag(hit)).toBe(true);
        expect(hit.structuredContent).toEqual({ entryCount: 4, deterministic: true });
        expect(hit.structuredContent).toEqual(fresh.structuredContent);
    });

    it('namespaces the key by tool API version, package version and engine version (engine lock-step)', async () => {
        await callToolDirect('create_zip', CREATE);
        const [file] = cachedFiles();
        const entry = JSON.parse(readFileSync(join(cacheDir, file!), 'utf8')) as { apiVersion: string; tool: string };
        expect(entry.tool).toBe('create_zip');
        expect(entry.apiVersion).toBe(`${TOOL_API_VERSION}/${ZIPNATIVE_MCP_VERSION}/${ZIPNATIVE_VERSION}/ceilings:${[getCeilings().maxUncompressedBytes, getCeilings().maxEntries, getCeilings().maxWorkers, getCeilings().maxFileOutputBytes].join(',')}`);
    });

    it("never caches defaultDate:'now' (wall-clock timestamps)", async () => {
        const args = { ...CREATE, defaultDate: 'now' };
        const a = await callToolDirect('create_zip', args);
        expect(a.isError).not.toBe(true);
        const b = await callToolDirect('create_zip', args);
        expect(cachedFlag(b)).toBeUndefined();
        expect(cachedFiles()).toHaveLength(0);
    });

    it('never caches a parallel (worker-pool) build', async () => {
        const args = { ...CREATE, parallel: { workers: 0 } };
        const a = await callToolDirect('create_zip', args);
        expect(a.isError, JSON.stringify(a.content[0])).not.toBe(true);
        const b = await callToolDirect('create_zip', args);
        expect(cachedFlag(b)).toBeUndefined();
        expect(cachedFiles()).toHaveLength(0);
    });

    it('never caches describe_engine (environment-dependent) or draft_governance_issue (environment-embedding)', async () => {
        for (let i = 0; i < 2; i++) {
            const engine = await callToolDirect('describe_engine', {});
            expect(engine.isError).not.toBe(true);
            expect(cachedFlag(engine)).toBeUndefined();
            const draft = await callToolDirect('draft_governance_issue', {
                title: 'inspect_zip reports the wrong ratio',
                summary: 'The ratio string is inverted for stored entries in the summary projection.',
                issueType: 'bug',
                reproduction: { command: 'inspect_zip { zipBase64, verbosity: "summary" }', result: 'ratio "0.5:1"' },
                expectedBehavior: 'ratio "1.0:1"',
                duplicateSearchPerformed: true,
            });
            expect(draft.isError).not.toBe(true);
            expect(cachedFlag(draft)).toBeUndefined();
        }
        expect(cachedFiles()).toHaveLength(0);
    });

    it('never caches file-mode output (the write is the effect)', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'zipnative-cache-out-'));
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = outDir;
        try {
            const r = await callToolDirect('create_zip', { ...CREATE, outputMode: 'file', outputPath: 'a.zip' });
            expect(r.isError).not.toBe(true);
            expect(cachedFiles()).toHaveLength(0);
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    });

    it('never caches a zipPath / sourcePath reference (a path is a reference, not content)', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'zipnative-cache-path-'));
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = outDir;
        try {
            writeFileSync(join(outDir, 'in.zip'), basicZip());
            writeFileSync(join(outDir, 'payload.txt'), 'from disk');
            for (const [tool, args] of [
                ['inspect_zip', { zipPath: 'in.zip' }],
                ['verify_zip', { zipPath: 'in.zip', verbosity: 'summary' }],
                ['compute_crc32', { sourcePath: 'payload.txt' }],
                ['create_zip', { entries: [{ name: 'p.txt', sourcePath: 'payload.txt' }] }],
                ['modify_zip', { zipPath: 'in.zip', operations: [{ op: 'add', name: 'p.txt', sourcePath: 'payload.txt' }] }],
            ] as const) {
                const a = await callToolDirect(tool, args);
                expect(a.isError, `${tool}: ${JSON.stringify(a.content[0])}`).not.toBe(true);
                const b = await callToolDirect(tool, args);
                expect(cachedFlag(b), tool).toBeUndefined();
            }
            expect(cachedFiles()).toHaveLength(0);
        } finally {
            rmSync(outDir, { recursive: true, force: true });
        }
    });

    it('a cached error is never served: refusals are not persisted', async () => {
        const args = { zipBase64: 'AAAAAAAA' };
        const a = await callToolDirect('inspect_zip', args);
        expect(a.isError).toBe(true);
        expect(cachedFiles()).toHaveLength(0);
        const b = await callToolDirect('inspect_zip', args);
        expect(b.isError).toBe(true);
        expect(cachedFlag(b)).toBeUndefined();
    });
});
