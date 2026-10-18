// scripts/helpers/hermetic.ts is imported first by every generator and by
// the gate: it pins TZ=UTC and removes every operator knob inherited from the
// developer's shell, so a local ZIPNATIVE_MCP_OUTPUT_DIR, _CACHE_DIR or a
// widened ceiling can neither change the bytes a script produces nor open a
// cache. These tests hold that promise, and hold it to the variables
// server.json actually declares.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { OPERATOR_PREFIX, isOperatorKnob, scrubEnv } from '../../scripts/helpers/hermetic.js';
import { ENV_PREFIX, serverJsonEnvVars } from '../../scripts/lib/mcp-surface.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('hermetic environment', () => {
    it('pins the process time zone to UTC on import', () => {
        expect(process.env['TZ']).toBe('UTC');
        expect(new Date(Date.UTC(2027, 0, 1)).getTimezoneOffset()).toBe(0);
    });

    it('scrubs the same prefix the docs tooling reads as the operator namespace', () => {
        expect(OPERATOR_PREFIX).toBe(ENV_PREFIX);
    });

    it('recognises every variable server.json declares as an operator knob', () => {
        const declared = serverJsonEnvVars(readFileSync(resolve(ROOT, 'server.json'), 'utf8'));
        expect(declared.length).toBeGreaterThanOrEqual(7);
        for (const name of declared) expect(isOperatorKnob(name), name).toBe(true);
    });

    it('recognises the prefix and nothing unrelated', () => {
        expect(isOperatorKnob('ZIPNATIVE_MCP_WORKERS')).toBe(true);
        expect(isOperatorKnob('ZIPNATIVE_MCP_OUTPUT_DIR')).toBe(true);
        for (const name of ['PATH', 'TZ', 'NODE_OPTIONS', 'GATE', 'GATE_REQUIRE_ARTIFACTS', 'ZIPNATIVE', 'XZIPNATIVE_MCP_X', 'PKINATIVE_MCP_OUTPUT_DIR', 'PDFNATIVE_MCP_OUTPUT_DIR']) {
            expect(isOperatorKnob(name), name).toBe(false);
        }
    });

    it('scrubs the knobs in place, reports them, and leaves the rest of the environment alone', () => {
        const env: NodeJS.ProcessEnv = {
            PATH: '/usr/bin',
            TZ: 'UTC',
            ZIPNATIVE_MCP_HTTP_TOKEN: 'a-token-of-sixteen-chars',
            ZIPNATIVE_MCP_CACHE_DIR: '/tmp/cache',
            ZIPNATIVE_MCP_OUTPUT_DIR: '/tmp/out',
            GATE: '1',
        };
        const removed = scrubEnv(env).sort();
        expect(removed).toEqual(['ZIPNATIVE_MCP_CACHE_DIR', 'ZIPNATIVE_MCP_HTTP_TOKEN', 'ZIPNATIVE_MCP_OUTPUT_DIR']);
        expect(env).toEqual({ PATH: '/usr/bin', TZ: 'UTC', GATE: '1' });
        expect(scrubEnv(env)).toEqual([]);
    });

    it('left no operator knob in this process after the import', () => {
        expect(Object.keys(process.env).filter(isOperatorKnob)).toEqual([]);
    });
});
