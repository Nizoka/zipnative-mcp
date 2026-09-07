/**
 * Documentation ↔ code consistency. The docs quote counts, names, codes and
 * environment variables that live in the source; this suite fails when they
 * drift so a doc edit (or a code edit) cannot silently desynchronise them.
 *
 * Sources of truth:
 *   toolNames() (src/server.ts)          — the 13-tool surface, in registration order
 *   __prompts (src/server.ts)            — the 7 prompts
 *   ZIP_ERROR_CODES / ZIP_DIAGNOSTIC_CODES — the 39 frozen codes + 11 diagnostics
 *   WRAPPER_CODES (below, = AGENTS.md §6) — the wrapper's own vocabulary
 *   ENV_VARS (below, = server.json)      — the 7 environment variables
 *
 * Every document is guarded with `it.skipIf(!existsSync(file))` so the suite
 * stays green while the docs are being written and activates as they land.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HTTP_TOKEN_ENV } from '../src/auth.js';
import { MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, WORKERS_ENV } from '../src/caps.js';
import { OUTPUT_DIR_ENV } from '../src/sandbox.js';
import { __prompts, __serverInstructions, toolNames } from '../src/server.js';
import { ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CODES } from '../src/zip-errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (rel: string): string => path.join(ROOT, rel);
const read = (rel: string): string => readFileSync(file(rel), 'utf8');
const has = (rel: string): boolean => existsSync(file(rel));

const TOOLS = toolNames();
const TOOL_COUNT = TOOLS.length;
const PROMPTS = __prompts.map((p) => p.name);

const ENV_VARS = [OUTPUT_DIR_ENV, 'ZIPNATIVE_MCP_CACHE_DIR', 'ZIPNATIVE_MCP_PORT', HTTP_TOKEN_ENV, MAX_UNCOMPRESSED_ENV, MAX_ENTRIES_ENV, WORKERS_ENV] as const;

const WRAPPER_CODES = [
    'VALIDATION_ERROR', 'INPUT_TOO_LARGE', 'INPUT_NOT_FOUND', 'ENTRY_TOO_LARGE', 'ENTRY_NOT_UTF8', 'OUTPUT_TOO_LARGE', 'OUTPUT_EXISTS',
    'IO_ERROR', 'SECURITY_VIOLATION', 'MISSING_OUTPUT_PATH', 'INVALID_PATH', 'INVALID_EXTENSION', 'LIMIT_CEILING_EXCEEDED', 'UNKNOWN_RESOURCE',
    'GOVERNANCE_VIOLATION', 'ENGINE_ERROR',
] as const;

const AGENTS_SECTIONS = [
    `## 1. Tool catalogue (${TOOL_COUNT} tools)`,
    '## 2. Decision tree',
    '## 3. Token-frugal responses',
    '## 4. Output modes & environment',
    '## 5. Recipes',
    '## 6. Error reference',
    '## 7. Contributing to this repo',
] as const;

/** Slice a markdown document between a heading and the next heading of the same or higher level. */
function section(text: string, heading: string): string {
    const start = text.indexOf(heading);
    expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0);
    const level = /^#+/.exec(heading)?.[0].length ?? 1;
    const rest = text.slice(start + heading.length);
    const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
    return next === null ? rest : rest.slice(0, next.index);
}

/** Data rows of the first markdown table in `text` (header + separator skipped), split into cells. */
function tableRows(text: string): string[][] {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    const rows: string[][] = [];
    let seenSeparator = false;
    for (const line of lines) {
        if (/^\|\s*:?-{2,}/.test(line)) {
            seenSeparator = true;
            continue;
        }
        if (!seenSeparator) continue;
        rows.push(line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim()));
    }
    return rows;
}

describe('the code-side sources of truth', () => {
    it('exposes 13 tools, 7 prompts, 39 ZIP_* codes, 11 diagnostics and 7 environment variables', () => {
        expect(TOOL_COUNT).toBe(13);
        expect(PROMPTS).toHaveLength(7);
        expect(ZIP_ERROR_CODES).toHaveLength(39);
        expect(ZIP_DIAGNOSTIC_CODES).toHaveLength(11);
        expect(ENV_VARS).toHaveLength(7);
        expect(new Set(ENV_VARS).size).toBe(7);
        for (const v of ENV_VARS) expect(v).toMatch(/^ZIPNATIVE_MCP_[A-Z_]+$/);
    });

    it('every tool name and every prompt name appears in SERVER_INSTRUCTIONS', () => {
        for (const t of TOOLS) expect(__serverInstructions, t).toContain(t);
        for (const p of PROMPTS) expect(__serverInstructions, p).toContain(p);
        expect(__serverInstructions).toContain(`${TOOL_COUNT} tools`);
    });
});

describe('AGENTS.md', () => {
    const present = has('AGENTS.md');

    it.skipIf(!present)('has the seven numbered sections with the tool count in the catalogue heading', () => {
        const agents = read('AGENTS.md');
        for (const h of AGENTS_SECTIONS) expect(agents, h).toContain(h);
    });

    it.skipIf(!present)('§1 lists every tool in registration order (name in backticks in column 2)', () => {
        const rows = tableRows(section(read('AGENTS.md'), AGENTS_SECTIONS[0]));
        expect(rows.length, 'catalogue table data rows').toBe(TOOL_COUNT);
        expect(rows.map((r) => r[1])).toEqual(TOOLS.map((t) => `\`${t}\``));
    });

    it.skipIf(!present)('§6 documents every wrapper code, every ZIP_* code and every diagnostic code in backticks', () => {
        const errors = section(read('AGENTS.md'), '## 6. Error reference');
        const missing = [...WRAPPER_CODES, ...ZIP_ERROR_CODES, ...ZIP_DIAGNOSTIC_CODES].filter((c) => !errors.includes(`\`${c}\``));
        expect(missing, `codes missing from AGENTS.md §6: ${missing.join(', ')}`).toEqual([]);
    });

    it.skipIf(!present)('names every environment variable and every prompt', () => {
        const agents = read('AGENTS.md');
        for (const v of ENV_VARS) expect(agents, v).toContain(v);
        for (const p of PROMPTS) expect(agents, p).toContain(p);
        for (const t of TOOLS) expect(agents, t).toContain(`\`${t}\``);
    });
});

describe('README.md', () => {
    const present = has('README.md');

    it.skipIf(!present)('has one `### `tool`` heading per tool and quotes the tool count', () => {
        const readme = read('README.md');
        for (const t of TOOLS) expect(readme, t).toContain(`### \`${t}\``);
        expect(readme).toContain(`${TOOL_COUNT} tools`);
        for (const m of readme.matchAll(/\b(\d+) tools\b/g)) expect(Number(m[1]), `README.md: "${m[0]}"`).toBe(TOOL_COUNT);
    });

    it.skipIf(!present)('names every environment variable and every prompt', () => {
        const readme = read('README.md');
        for (const v of ENV_VARS) expect(readme, v).toContain(v);
        for (const p of PROMPTS) expect(readme, p).toContain(p);
    });
});

describe('llms.txt', () => {
    it.skipIf(!has('llms.txt'))('has the "## Tools (N)" heading with the live count and names every tool', () => {
        const llms = read('llms.txt');
        expect(llms).toContain(`## Tools (${TOOL_COUNT})`);
        for (const t of TOOLS) expect(llms, t).toContain(t);
    });
});

describe('tool count in the package, registry and citation metadata', () => {
    it('package.json description quotes the tool count', () => {
        const pkg = JSON.parse(read('package.json')) as { description: string };
        expect(pkg.description).toContain(`${TOOL_COUNT} tools`);
    });

    it.skipIf(!has('server.json'))('server.json description quotes the tool count and its environment variables are exactly the seven', () => {
        const server = JSON.parse(read('server.json')) as { description: string; packages: Array<{ environmentVariables?: Array<{ name: string; isSecret?: boolean }> }> };
        expect(server.description).toContain(`${TOOL_COUNT} tools`);
        const names = (server.packages[0]?.environmentVariables ?? []).map((v) => v.name);
        expect([...names].sort()).toEqual([...ENV_VARS].sort());
        const token = server.packages[0]?.environmentVariables?.find((v) => v.name === HTTP_TOKEN_ENV);
        expect(token?.isSecret, `${HTTP_TOKEN_ENV} is a secret`).toBe(true);
    });

    it.skipIf(!has('CITATION.cff'))('CITATION.cff abstract quotes the tool count', () => {
        expect(read('CITATION.cff')).toContain(`${TOOL_COUNT} tools`);
    });

    it.skipIf(!has('CLAUDE.md'))('CLAUDE.md quotes the tool count', () => {
        expect(read('CLAUDE.md')).toContain(`${TOOL_COUNT} tools`);
    });
});

describe('every "<N> tools" figure in the counted documents equals the live count', () => {
    const COUNTED = ['README.md', 'AGENTS.md', 'llms.txt', 'CLAUDE.md', 'CITATION.cff', 'SECURITY.md', 'docs/AI_GUIDE.md', 'CHANGELOG.md'] as const;
    for (const rel of COUNTED) {
        it.skipIf(!has(rel))(`${rel}`, () => {
            const text = read(rel);
            for (const m of text.matchAll(/\b(\d+) tools\b/g)) expect(Number(m[1]), `${rel}: "${m[0]}"`).toBe(TOOL_COUNT);
            for (const m of text.matchAll(/Tools \((\d+)\)/g)) expect(Number(m[1]), `${rel}: "${m[0]}"`).toBe(TOOL_COUNT);
        });
    }
});

describe('docs/data/errors.json ↔ the frozen vocabularies', () => {
    it.skipIf(!has('docs/data/errors.json'))('carries exactly the 39 error codes and 11 diagnostics of the installed engine', () => {
        const data = JSON.parse(read('docs/data/errors.json')) as { errors: Array<{ code: string }>; diagnostics: Array<{ code: string }> };
        expect(data.errors.map((e) => e.code).sort()).toEqual([...ZIP_ERROR_CODES].sort());
        expect(data.diagnostics.map((d) => d.code).sort()).toEqual([...ZIP_DIAGNOSTIC_CODES].sort());
    });
});
