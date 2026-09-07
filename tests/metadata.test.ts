import { describe, it, expect } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { __serverMetadata } from '../src/server.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from '../src/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_MCP_NAME = 'io.github.Nizoka/zipnative-mcp';
const EXPECTED_NPM_NAME = 'zipnative-mcp';

const SERVER_JSON = path.join(ROOT, 'server.json');
const CITATION = path.join(ROOT, 'CITATION.cff');

async function readJson(rel: string): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(ROOT, rel), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

/** Does the installed version satisfy a simple caret range (`^X.Y.Z`)? */
function satisfiesCaret(range: string, installed: string): boolean {
    const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
    if (m === null) return false;
    const [min, have] = [[Number(m[1]), Number(m[2]), Number(m[3])], installed.split('.').map(Number)] as const;
    if (have[0] !== min[0]) return false;
    if (have[1] !== min[1]) return (have[1] as number) > min[1];
    return (have[2] as number) >= min[2];
}

describe('registry metadata parity', () => {
    it('mcpName uses the canonical GitHub login casing (Nizoka)', async () => {
        const pkg = await readJson('package.json');
        // npm requires a lowercase package name…
        expect(pkg['name']).toBe(EXPECTED_NPM_NAME);
        // …but the MCP registry compares mcpName to the GitHub namespace with
        // case-sensitive equality, so the login must be spelled "Nizoka".
        expect(pkg['mcpName']).toBe(EXPECTED_MCP_NAME);
    });

    it.skipIf(!existsSync(SERVER_JSON))('server.json name matches package.json mcpName exactly (case-sensitive)', async () => {
        const pkg = await readJson('package.json');
        const server = await readJson('server.json');
        expect(server['name']).toBe(EXPECTED_MCP_NAME);
        expect(server['name']).toBe(pkg['mcpName']);
    });

    it.skipIf(!existsSync(SERVER_JSON))('advertises the same websiteUrl in serverInfo (Implementation) as server.json and package.json homepage', async () => {
        const pkg = await readJson('package.json');
        const server = await readJson('server.json');
        expect(__serverMetadata.websiteUrl).toBe(server['websiteUrl']);
        expect(__serverMetadata.websiteUrl).toBe(pkg['homepage']);
    });

    it('keeps version in lock-step across package.json, src/version.ts and the server runtime', async () => {
        const pkg = await readJson('package.json');
        expect(pkg['version']).toBe(__serverMetadata.version);
        expect(ZIPNATIVE_MCP_VERSION).toBe(__serverMetadata.version);
        expect(ZIPNATIVE_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(TOOL_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it.skipIf(!existsSync(SERVER_JSON))('server.json carries the package version (top-level and packages[0])', async () => {
        const pkg = await readJson('package.json');
        const server = await readJson('server.json');
        const version = pkg['version'];
        expect(server['version']).toBe(version);
        const packages = server['packages'] as Array<Record<string, unknown>>;
        expect(packages[0]?.['identifier']).toBe(EXPECTED_NPM_NAME);
        expect(packages[0]?.['version']).toBe(version);
    });

    it.skipIf(!existsSync(CITATION))('CITATION.cff version equals package.json version', async () => {
        const pkg = await readJson('package.json');
        const cff = await fs.readFile(CITATION, 'utf8');
        const m = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(cff);
        expect(m, 'CITATION.cff has a version: line').not.toBeNull();
        expect(m![1]).toBe(pkg['version']);
    });

    it('reports the installed zipnative engine version and the dependency range accepts it', async () => {
        const pkg = await readJson('package.json');
        expect(__serverMetadata.engineVersion).toBe(ZIPNATIVE_VERSION);
        expect(ZIPNATIVE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        const range = (pkg['dependencies'] as Record<string, string>)['zipnative'];
        expect(range).toBeDefined();
        expect(satisfiesCaret(range!, ZIPNATIVE_VERSION), `dependencies.zipnative ${range} does not accept the installed ${ZIPNATIVE_VERSION}`).toBe(true);
        const installed = JSON.parse(await fs.readFile(path.join(ROOT, 'node_modules', 'zipnative', 'package.json'), 'utf8')) as { version: string };
        expect(installed.version).toBe(ZIPNATIVE_VERSION);
    });

    it('serverInfo title and description are non-empty and the description mirrors the registry pitch', () => {
        expect(__serverMetadata.name).toBe(EXPECTED_NPM_NAME);
        expect(__serverMetadata.title.length).toBeGreaterThan(0);
        expect(__serverMetadata.description).toMatch(/MCP server/i);
        expect(__serverMetadata.description).toContain('no network ever');
    });
});
