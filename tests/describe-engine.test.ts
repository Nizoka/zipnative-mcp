/**
 * Tests for `describe_engine` — the offline capability manifest.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { DEFAULT_ZIP_LIMITS, VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { describeEngine, describeSummary, UNEXPOSED_EXPORTS } from '../src/tools/describe-engine.js';
import { callToolDirect, toolNames } from '../src/server.js';
import { CAPS, __resetCeilingsForTests } from '../src/caps.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from '../src/version.js';
import { ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { cleanupSandbox, makeSandbox } from './_sandbox.js';

const ENV = ['ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES', 'ZIPNATIVE_MCP_MAX_ENTRIES', 'ZIPNATIVE_MCP_WORKERS', 'ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES'] as const;

describe('describe_engine', () => {
    let sandbox: string | null = null;

    beforeAll(() => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        for (const name of ENV) delete process.env[name];
        __resetCeilingsForTests();
    });

    afterEach(async () => {
        await cleanupSandbox(sandbox);
        sandbox = null;
        delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
        for (const name of ENV) delete process.env[name];
        __resetCeilingsForTests();
    });

    it('reports the server, engine and runtime shape', async () => {
        const out = await describeEngine({});
        expect(out.server).toEqual({ name: 'zipnative-mcp', version: ZIPNATIVE_MCP_VERSION, toolApiVersion: TOOL_API_VERSION, protocol: expect.stringContaining('MCP'), toolCount: 15 });
        expect(out.server.toolCount).toBe(toolNames().length);
        expect(out.engine.name).toBe('zipnative');
        expect(out.engine.version).toBe(ZIPNATIVE_VERSION);
        expect(['node-zlib', 'pure', 'injected']).toContain(out.engine.deflateTier.default);
        expect(out.engine.deflateTier.deterministic).toBe('pure-pinned');
        expect(out.capabilities.nodeZlib).toBe(true);
        expect(typeof out.capabilities.compressionStream).toBe('boolean');
        expect(typeof out.capabilities.decompressionStream).toBe('boolean');
        expect(out.capabilities.workerThreads).toBe(true);
        expect(out.capabilities.cpuCount).toBeGreaterThanOrEqual(1);
        expect(out.capabilities.defaultWorkers).toBeGreaterThanOrEqual(1);
        expect(out.capabilities.defaultWorkers).toBeLessThanOrEqual(8);
        expect(out.codecs).toEqual([{ id: 0, name: 'store', sync: true, stream: expect.any(Boolean), incremental: true }, { id: 8, name: 'deflate', sync: true, stream: expect.any(Boolean), incremental: true }]);
        expect(out.defaultLimits).toEqual({ ...DEFAULT_ZIP_LIMITS });
        expect(out.caps).toEqual(CAPS);
        expect(out.network).toBe('none');
    });

    it('lists the frozen vocabularies and the unexposed exports', async () => {
        const out = await describeEngine({});
        expect(out.errorCodes).toHaveLength(39);
        expect(out.errorCodes).toEqual([...ZIP_ERROR_CODES]);
        expect(new Set(out.errorCodes).size).toBe(39);
        expect(out.errorCodes.every((c) => c.startsWith('ZIP_'))).toBe(true);
        expect(out.diagnosticCodes).toHaveLength(12);
        expect(out.diagnosticCodes).toEqual([...ZIP_DIAGNOSTIC_CODES]);
        expect(out.unexposed.length).toBeGreaterThan(0);
        expect(out.unexposed).toBe(UNEXPOSED_EXPORTS);
        for (const u of out.unexposed) {
            expect(u.export.length).toBeGreaterThan(0);
            expect(u.rationale.length).toBeGreaterThan(0);
        }
    });

    it('sandbox and cache flags react to the environment', async () => {
        const off = await describeEngine({});
        expect(off.sandbox).toEqual({ enabled: false, cacheEnabled: false });
        sandbox = await makeSandbox();
        process.env['ZIPNATIVE_MCP_CACHE_DIR'] = sandbox;
        const on = await describeEngine({});
        expect(on.sandbox).toEqual({ enabled: true, cacheEnabled: true });
    });

    it('ceilings reflect the operator environment', async () => {
        const defaults = await describeEngine({});
        expect(defaults.ceilings).toEqual({ maxUncompressedBytes: 8 * 1024 * 1024 * 1024, maxEntries: 100_000, maxWorkers: 8, maxFileOutputBytes: 4 * 1024 * 1024 * 1024, env: [...ENV] });
        process.env['ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES'] = '1048576';
        process.env['ZIPNATIVE_MCP_MAX_ENTRIES'] = '500';
        process.env['ZIPNATIVE_MCP_WORKERS'] = '2';
        __resetCeilingsForTests();
        const custom = await describeEngine({});
        expect(custom.ceilings).toMatchObject({ maxUncompressedBytes: 1_048_576, maxEntries: 500, maxWorkers: 2 });
    });

    it('rejects unknown arguments', async () => {
        await expect(describeEngine({ verbose: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        const ok = await describeEngine(undefined);
        expect(ok.network).toBe('none');
    });

    it('summary / fields projection through the wire', async () => {
        const full = await describeEngine({});
        expect(Object.keys(describeSummary(full))).toEqual(['server', 'engine', 'capabilities', 'sandbox', 'network']);
        const r = await callToolDirect('describe_engine', { verbosity: 'summary' });
        expect(r.isError).toBeUndefined();
        expect(Object.keys(r.structuredContent as object)).toEqual(['server', 'engine', 'capabilities', 'sandbox', 'network']);
        expect((r.content[0] as { text: string }).text).toContain('zipnative-mcp');
        expect((r.content[0] as { text: string }).text).toContain('network=none');
        const fields = await callToolDirect('describe_engine', { fields: ['defaultLimits', 'ceilings.maxEntries', 'sandbox.enabled', 'nope'] });
        expect(fields.structuredContent).toEqual({ defaultLimits: { ...DEFAULT_ZIP_LIMITS }, ceilings: { maxEntries: 100_000 }, sandbox: { enabled: false } });
        expect(fields._meta).toMatchObject({ unmatchedFields: ['nope'] });
        // Never cached: no _meta.cached even when the cache is on.
        sandbox = await makeSandbox();
        process.env['ZIPNATIVE_MCP_CACHE_DIR'] = sandbox;
        await callToolDirect('describe_engine', {});
        const again = await callToolDirect('describe_engine', {});
        expect((again._meta as { cached?: boolean } | undefined)?.cached).toBeUndefined();
    });
});
