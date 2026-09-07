/**
 * Tests for `src/engine.ts` — engine initialisation and the runtime probe.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { activeDeflateTier } from 'zipnative';

import { ensureEngineReady, probeRuntime } from '../src/engine.js';

describe('engine', () => {
    it('ensureEngineReady is memoised and resolves', async () => {
        const first = ensureEngineReady();
        const second = ensureEngineReady();
        expect(first).toBe(second);
        expect(first).toBeInstanceOf(Promise);
        await expect(first).resolves.toBeUndefined();
        expect(ensureEngineReady()).toBe(first);
        // The Node tier is wired for the deterministic pin regardless; the default tier is node-zlib once ready.
        expect(activeDeflateTier(true)).toBe('pure-pinned');
        expect(['node-zlib', 'pure']).toContain(activeDeflateTier(false));
    });

    it('probeRuntime reports the capabilities of this Node runtime', async () => {
        const caps = await probeRuntime();
        const cpuCount = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
        expect(caps).toEqual({
            nodeZlib: true,
            compressionStream: typeof globalThis.CompressionStream === 'function',
            decompressionStream: typeof globalThis.DecompressionStream === 'function',
            workerThreads: true,
            cpuCount,
            defaultWorkers: Math.max(1, Math.min(cpuCount - 1, 8)),
        });
        expect(caps.compressionStream).toBe(true);
        expect(caps.decompressionStream).toBe(true);
        expect(caps.defaultWorkers).toBeGreaterThanOrEqual(1);
        expect(caps.defaultWorkers).toBeLessThanOrEqual(8);
        expect(await probeRuntime()).toEqual(caps);
    });
});
