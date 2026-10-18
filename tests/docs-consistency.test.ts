/**
 * Documentation ↔ code consistency. The docs quote counts, names, codes and
 * environment variables that live in the source; this suite fails when they
 * drift so a doc edit (or a code edit) cannot silently desynchronise them.
 *
 * Sources of truth:
 *   toolNames() (src/server.ts)          — the 13-tool surface, in registration order
 *   __prompts (src/server.ts)            — the 7 prompts
 *   ZIP_ERROR_CODES / ZIP_DIAGNOSTIC_CODES — the 39 frozen codes + 12 diagnostics
 *   WRAPPER_CODES (below, = AGENTS.md §6) — the wrapper's own vocabulary
 *   ENV_VARS (below, = server.json)      — the 7 environment variables
 *
 * Every document is guarded with `it.skipIf(!existsSync(file))` so the suite
 * stays green while the docs are being written and activates as they land.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { HTTP_TOKEN_ENV } from '../src/auth.js';
import { MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, WORKERS_ENV } from '../src/caps.js';
import { GOVERNANCE_CONTRACT_SUMMARY } from '../src/governance.js';
import { OUTPUT_DIR_ENV } from '../src/sandbox.js';
import { __prompts, __serverInstructions, listToolsPayload, toolNames } from '../src/server.js';
import { UNEXPOSED_EXPORTS } from '../src/tools/describe-engine.js';
import { ZIPNATIVE_MCP_VERSION } from '../src/version.js';
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
    it('exposes 13 tools, 7 prompts, 39 ZIP_* codes, 12 diagnostics and 7 environment variables', () => {
        expect(TOOL_COUNT).toBe(13);
        expect(PROMPTS).toHaveLength(7);
        expect(ZIP_ERROR_CODES).toHaveLength(39);
        expect(ZIP_DIAGNOSTIC_CODES).toHaveLength(12);
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

describe('B-014: the 77-export ledger (api.json ≡ core-exports.json ≡ KB §8) and the zipnativeVersion pins', () => {
    interface ExportRow { name: string; subpath: string }
    const CORE = 'docs/data/core-exports.json';
    const KB = 'docs/KNOWLEDGE_BASE.md';
    const KB_SECTION = '## 8. The 77-export coverage ledger';
    /** The engine's own api.json: a sibling checkout first, the installed package second, otherwise skipped with a note. */
    const API_JSON_CANDIDATES = [path.resolve(ROOT, '..', 'zipnative', 'docs', 'assets', 'api.json'), path.join(ROOT, 'node_modules', 'zipnative', 'docs', 'assets', 'api.json')];
    const apiJson = API_JSON_CANDIDATES.find((p) => existsSync(p));
    if (apiJson === undefined) console.warn('[docs-consistency] no zipnative api.json found (sibling checkout or node_modules) — the api.json ≡ core-exports.json check is skipped');

    const pairs = (rows: ExportRow[]): string[] => rows.map((r) => `${r.subpath} ${r.name}`).sort();

    it.skipIf(!has(CORE) || apiJson === undefined)('core-exports.json name + subpath pairs equal the engine api.json exactly', () => {
        const core = JSON.parse(read(CORE)) as { exportCount: number; exports: ExportRow[] };
        const api = JSON.parse(readFileSync(apiJson!, 'utf8')) as { exportCount: number; exports: ExportRow[] };
        expect(pairs(core.exports)).toEqual(pairs(api.exports));
        expect(core.exportCount).toBe(api.exportCount);
        expect(core.exports).toHaveLength(core.exportCount);
    });

    it.skipIf(!has(CORE) || !has(KB))('every export name of core-exports.json appears in KNOWLEDGE_BASE.md §8, and the 72 + 5 split holds', () => {
        const core = JSON.parse(read(CORE)) as { exportCount: number; exports: ExportRow[] };
        const ledger = section(read(KB), KB_SECTION);
        const missing = core.exports.filter((e) => !ledger.includes(`\`${e.name}\``)).map((e) => `${e.subpath}:${e.name}`);
        expect(missing, `exports missing from KB §8: ${missing.join(', ')}`).toEqual([]);
        expect(core.exportCount).toBe(77);
        expect(core.exports.filter((e) => e.subpath === '.')).toHaveLength(72);
        expect(core.exports.filter((e) => e.subpath === './worker')).toHaveLength(5);
        expect(read(KB)).toContain(`${core.exportCount}-export`);
    });

    it.skipIf(!has(KB))('every UNEXPOSED_EXPORTS entry of describe_engine is named in KB §8', () => {
        const ledger = section(read(KB), KB_SECTION);
        for (const u of UNEXPOSED_EXPORTS) {
            for (const name of u.export.replace(/\s*\([^)]*\)/g, '').split(' / ')) expect(ledger, name).toContain(`\`${name.trim()}\``);
        }
        expect(read(KB)).toContain('UNEXPOSED_EXPORTS');
    });

    it('docs/data/*.json pin zipnativeVersion to the installed engine VERSION', () => {
        const dir = path.join(ROOT, 'docs', 'data');
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
        expect(files.length).toBeGreaterThan(0);
        let pinned = 0;
        for (const f of files) {
            const data = JSON.parse(read(`docs/data/${f}`)) as { zipnativeVersion?: string };
            if (data.zipnativeVersion !== undefined) {
                pinned++;
                expect(data.zipnativeVersion, f).toBe(ZIPNATIVE_VERSION);
            }
        }
        expect(pinned).toBeGreaterThanOrEqual(2);
    });
});

describe('A-006: no document routes an SFX / self-extracting prefix to scan_zip_forward', () => {
    const DOCS = ['README.md', 'AGENTS.md', 'llms.txt', 'docs/AI_GUIDE.md', 'CLAUDE.md'] as const;
    const mentionsScan = (line: string): boolean => line.includes('scan_zip_forward');
    const mentionsSfx = (line: string): boolean => /\bSFX\b|self-extract/i.test(line);
    const saysRefused = (line: string): boolean => /refus|cannot|not (?:skip|handle|seek)|ZIP_SIGNATURE_MISMATCH/i.test(line);

    for (const rel of DOCS) {
        it.skipIf(!has(rel))(`${rel}: a line naming scan_zip_forward next to SFX says it is refused`, () => {
            const offenders = read(rel).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => mentionsScan(l) && mentionsSfx(l) && !saysRefused(l));
            expect(offenders.map(([n, l]) => `${rel}:${n}: ${l.slice(0, 120)}`)).toEqual([]);
        });
    }

    it('SERVER_INSTRUCTIONS and the scan_zip_forward description route the SFX case to inspect_zip', () => {
        const offenders = __serverInstructions.split('\n').filter((l) => mentionsScan(l) && mentionsSfx(l) && !saysRefused(l));
        expect(offenders).toEqual([]);
        expect(__serverInstructions).toMatch(/prepended prefix\s*→\s*inspect_zip/);
        expect(__serverInstructions).toContain('ZIP_SIGNATURE_MISMATCH');
        const scan = listToolsPayload().tools.find((t) => t.name === 'scan_zip_forward');
        expect(scan?.description).toMatch(/SFX/);
        expect(scan?.description).toMatch(/must start at a local header|refus|cannot/i);
    });
});

describe('A-015: version strings outside the lock-step files quote the package version', () => {
    it('GOVERNANCE_CONTRACT_SUMMARY carries (v<ZIPNATIVE_MCP_VERSION>)', () => {
        expect(GOVERNANCE_CONTRACT_SUMMARY).toContain(`(v${ZIPNATIVE_MCP_VERSION})`);
        expect(ZIPNATIVE_MCP_VERSION).toBe((JSON.parse(read('package.json')) as { version: string }).version);
    });

    it.skipIf(!has('llms.txt'))('llms.txt quotes (v<package version>)', () => {
        const pkg = JSON.parse(read('package.json')) as { version: string };
        expect(read('llms.txt')).toContain(`(v${pkg.version})`);
        for (const m of read('llms.txt').matchAll(/\(v(\d+\.\d+\.\d+)\)/g)) expect(m[1]).toBe(pkg.version);
    });
});

describe('A-019: release notes and CHANGELOG name the same tools under Added', () => {
    const NOTES = `release-notes/v${ZIPNATIVE_MCP_VERSION}.md`;
    const featTools = (text: string): string[] => [...new Set([...text.matchAll(/feat\(tool\):\s*`?([a-z0-9_]+)`?/g)].map((m) => m[1]!))].sort();

    it.skipIf(!has(NOTES) || !has('CHANGELOG.md'))('every feat(tool) bullet of the release notes appears in CHANGELOG [version] Added, and vice versa', () => {
        const notes = featTools(section(read(NOTES), '## Added'));
        const changelog = featTools(section(read('CHANGELOG.md'), `## [${ZIPNATIVE_MCP_VERSION}]`));
        expect(notes).toEqual(changelog);
        expect(notes).toEqual([...TOOLS].sort());
    });
});

describe('every ZIPNATIVE_MCP_* token in the documents is one of the seven environment variables', () => {
    // Code identifiers and the test-only switch are the only other tokens allowed to carry the prefix.
    const ALLOWED = new Set<string>([...ENV_VARS, 'ZIPNATIVE_MCP_VERSION', 'ZIPNATIVE_MCP_SLOW_TESTS']);
    const DOCS = ['README.md', 'AGENTS.md', 'llms.txt', 'CLAUDE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'SUPPORT.md', 'CHANGELOG.md', 'server.json', 'package.json', '.github/AGENT_RULES.md', '.github/copilot-instructions.md', '.github/ai-governance.json'] as const;
    const walkMd = (dir: string, out: string[] = []): string[] => {
        if (!existsSync(dir)) return out;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkMd(full, out);
            else if (/\.(?:md|json|txt|yml)$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
        return out;
    };
    const files = [...DOCS.filter((f) => has(f)), ...walkMd(path.join(ROOT, 'docs')), ...walkMd(path.join(ROOT, 'release-notes')), ...walkMd(path.join(ROOT, '.github', 'workflows')), ...walkMd(path.join(ROOT, 'examples'))];

    it('names exactly the seven variables (plus code identifiers) across the documents', () => {
        const unknown = new Set<string>();
        for (const rel of files) {
            for (const m of read(rel).matchAll(/ZIPNATIVE_MCP_[A-Z0-9_]+/g)) if (!ALLOWED.has(m[0])) unknown.add(`${rel}: ${m[0]}`);
        }
        expect([...unknown]).toEqual([]);
        expect(files.length).toBeGreaterThan(5);
    });

    it('the seven variables all appear in the README and in server.json (documented and registered)', () => {
        for (const v of ENV_VARS) {
            expect(read('README.md'), v).toContain(v);
            if (has('server.json')) expect(read('server.json'), v).toContain(v);
        }
    });
});

describe('docs/data/errors.json ↔ the frozen vocabularies', () => {
    it.skipIf(!has('docs/data/errors.json'))('carries exactly the 39 error codes and 12 diagnostics of the installed engine', () => {
        const data = JSON.parse(read('docs/data/errors.json')) as { errors: Array<{ code: string }>; diagnostics: Array<{ code: string }> };
        expect(data.errors.map((e) => e.code).sort()).toEqual([...ZIP_ERROR_CODES].sort());
        expect(data.diagnostics.map((d) => d.code).sort()).toEqual([...ZIP_DIAGNOSTIC_CODES].sort());
    });
});

describe('AUDIT-D: the claims the documents make about themselves hold', () => {
    const readOnly = new Map(listToolsPayload().tools.map((t) => [t.name, (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true]));
    const walk = (dir: string, accept: RegExp, out: string[] = []): string[] => {
        if (!existsSync(dir)) return out;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, accept, out);
            else if (accept.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
        return out;
    };
    const lines = (rel: string): Array<[number, string]> => read(rel).split('\n').map((l, i) => [i + 1, l]);
    const NOTES = `release-notes/v${ZIPNATIVE_MCP_VERSION}.md`;

    it.skipIf(!has('README.md'))('D-004/D-018: the README project-structure tree names every docs, workflow, src and scripts file', () => {
        const block = section(read('README.md'), '## 📚 Project structure');
        const fence = /```\n([\s\S]*?)```/.exec(block)?.[1] ?? '';
        expect(fence.length).toBeGreaterThan(100);
        const files = [
            ...walk(path.join(ROOT, 'docs'), /\.(?:md|json)$/),
            ...walk(path.join(ROOT, '.github', 'workflows'), /\.yml$/),
            ...walk(path.join(ROOT, 'src'), /\.ts$/),
            ...walk(path.join(ROOT, 'scripts'), /\.(?:mjs|mts)$/),
        ];
        const missing = files.filter((rel) => !fence.includes(path.basename(rel)));
        expect(missing, `files absent from the README tree: ${missing.join(', ')}`).toEqual([]);
    });

    it('D-004/D-013: every "no I/O outside the sandbox" statement names the opt-in cache', () => {
        for (const rel of ['README.md', 'SECURITY.md', 'docs/guides/SECURITY.md'].filter(has)) {
            for (const [n, l] of lines(rel)) {
                if (/no (?:file )?I\/O outside|neither reads nor writes anywhere else|no filesystem access outside/i.test(l)) {
                    expect(l, `${rel}:${n}`).toMatch(/ZIPNATIVE_MCP_CACHE_DIR|cache/i);
                }
            }
        }
    });

    it.skipIf(!has('docs/data/verazip.json'))('D-002/D-004: every corpus figure quoted in the documents equals docs/data/verazip.json', () => {
        const { declared } = JSON.parse(read('docs/data/verazip.json')) as { declared: { conformant: number; nonConformant: number; hostileConformant: number } };
        const total = declared.conformant + declared.nonConformant;
        const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
        const num = (s: string): number => words[s.toLowerCase()] ?? Number(s);
        const DOCS = ['README.md', 'CONTRIBUTING.md', 'llms.txt', 'docs/KNOWLEDGE_BASE.md', 'docs/guides/CONFORMANCE.md', 'docs/guides/LOCAL_TESTING.md', 'docs/guides/SECURITY.md', NOTES, 'CHANGELOG.md', '.github/workflows/verazip.yml', '.github/drafts/pr-v1.0.0.md'];
        let seen = 0;
        for (const rel of DOCS.filter(has)) {
            for (const [n, l] of lines(rel)) {
                const where = `${rel}:${n}: ${l.slice(0, 100)}`;
                for (const m of l.matchAll(/\b(\d+|three|four|five) hostile-but-conformant/gi)) { seen++; expect(num(m[1]!), where).toBe(declared.hostileConformant); }
                for (const m of l.matchAll(/(?<![-\d.:])\b(\d+) (?:archives|conformant)\b/g)) { seen++; expect([total, declared.conformant], where).toContain(Number(m[1])); }
                for (const m of l.matchAll(/\bof (\d+)\b(?! bytes)/g)) if (/PASS|XFAIL|corpus|archives/.test(l)) { seen++; expect(Number(m[1]), where).toBe(total); }
                for (const m of l.matchAll(/\b(\d+|four) (?:raw-crafted |crafted )?(?:negative canaries|negatives|non-conformant)/gi)) { seen++; expect(num(m[1]!), where).toBe(declared.nonConformant); }
                for (const m of l.matchAll(/\b(\d+) (PASS|XFAIL)\b/g)) { seen++; expect(Number(m[1]), where).toBe(m[2] === 'PASS' ? declared.conformant : declared.nonConformant); }
                if (/\b(?:three|trio)\b[^\n]{0,90}\bhostile|\bhostile[^\n]{0,90}\b(?:three|trio)\b/i.test(l)) expect(declared.hostileConformant, where).toBe(3);
            }
        }
        expect(seen).toBeGreaterThan(10);
    });

    it.skipIf(!has('docs/data/core-exports.json') || !has('docs/KNOWLEDGE_BASE.md'))('D-004: the reach counts are 62 / 9 / 6 and every UNEXPOSED_EXPORTS entry is graded unexposed in the ledger', () => {
        const core = JSON.parse(read('docs/data/core-exports.json')) as { exports: Array<{ name: string; reach: string }> };
        const count = (reach: string): number => core.exports.filter((e) => e.reach === reach).length;
        expect([count('capability'), count('type'), count('unexposed')]).toEqual([62, 9, 6]);
        expect(count('capability') + count('type') + count('unexposed')).toBe(core.exports.length);
        const ledger = section(read('docs/KNOWLEDGE_BASE.md'), '## 8. The 77-export coverage ledger');
        const unexposedNames = new Set(core.exports.filter((e) => e.reach === 'unexposed').map((e) => e.name));
        const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const u of UNEXPOSED_EXPORTS) {
            for (const raw of u.export.replace(/\s*\([^)]*\)/g, '').split(' / ')) {
                const name = raw.trim();
                const bare = name.split('.').pop()!;
                // A whole export is an `unexposed` row; a field / member of an exposed export is called unexposed on the row of its owner.
                const rowIsUnexposed = unexposedNames.has(bare);
                const named = new RegExp(`\`[^\`\\n]*\\b${escape(bare)}\\b[^\`\\n]*\``);
                const ledgerSaysUnexposed = ledger.split('\n').some((row) => row.includes('unexposed') && named.test(row));
                expect(rowIsUnexposed || ledgerSaysUnexposed, `${name} is not graded unexposed in KB §8`).toBe(true);
            }
        }
    });

    it.skipIf(!has('docs/KNOWLEDGE_BASE.md'))('D-001: the knowledge base annotation sentence lists each tool under the hint it really carries', () => {
        const line = read('docs/KNOWLEDGE_BASE.md').split('\n').find((l) => l.includes('`READ_ONLY` ='));
        expect(line).toBeDefined();
        const [readOnlyPart, writesPart] = line!.split('`WRITES`');
        expect(writesPart).toBeDefined();
        for (const [tool, ro] of readOnly) {
            if (ro) expect(writesPart!, `${tool} must not be listed under WRITES`).not.toContain(`\`${tool}\``);
            else {
                expect(readOnlyPart!, `${tool} must not be listed under READ_ONLY`).not.toContain(`\`${tool}\``);
                expect(writesPart!, `${tool} must be listed under WRITES`).toContain(`\`${tool}\``);
            }
        }
    });

    it.skipIf(!has('docs/API_STABILITY.md'))('D-001: API_STABILITY says "read-only" exactly for the tools whose readOnlyHint is true', () => {
        const text = read('docs/API_STABILITY.md');
        for (const [tool, ro] of readOnly) {
            const sec = section(text, `### \`${tool}\``);
            const ann = sec.split('\n').find((l) => l.trim().startsWith('- **Annotations:**'));
            expect(ann, `${tool}: annotations line`).toBeDefined();
            expect(/(?<!not )\bread-only\b/.test(ann!), `${tool}: "${ann}"`).toBe(ro);
        }
    });

    it.skipIf(!has('README.md') || !has('AGENTS.md'))('D-016: the README and AGENTS read-only columns carry a tick exactly for the readOnlyHint tools', () => {
        const readme = read('README.md');
        const readmeRows = tableRows(readme.slice(readme.indexOf('| Tool | What it does | Read-only |')));
        const agentsRows = tableRows(section(read('AGENTS.md'), AGENTS_SECTIONS[0]));
        for (const [tool, ro] of readOnly) {
            const r = readmeRows.find((row) => row[0] === `\`${tool}\``);
            const a = agentsRows.find((row) => row[1] === `\`${tool}\``);
            expect(r, `README row for ${tool}`).toBeDefined();
            expect(a, `AGENTS row for ${tool}`).toBeDefined();
            expect((r![2] ?? '').startsWith('✓'), `README read-only tick for ${tool}`).toBe(ro);
            expect((a![3] ?? '').startsWith('✓'), `AGENTS read-only tick for ${tool}`).toBe(ro);
        }
    });

    it.skipIf(!has('docs/KNOWLEDGE_BASE.md'))('D-006: every SERVER_INSTRUCTIONS byte figure in the knowledge base is the measured one', () => {
        const measured = Buffer.byteLength(__serverInstructions);
        let seen = 0;
        for (const [n, l] of lines('docs/KNOWLEDGE_BASE.md')) {
            for (const m of l.matchAll(/SERVER_INSTRUCTIONS`?[^\n]{0,60}?≈?\s*([\d,]+)\s*bytes/g)) {
                seen++;
                expect(Number(m[1]!.replace(/,/g, '')), `docs/KNOWLEDGE_BASE.md:${n}`).toBe(measured);
            }
        }
        expect(seen).toBeGreaterThan(0);
    });

    it('D-009: no document credits draft_governance_issue with a resource_link', () => {
        for (const rel of [NOTES, 'README.md', 'AGENTS.md', 'docs/API_STABILITY.md', 'CHANGELOG.md'].filter(has)) {
            for (const [n, l] of lines(rel)) {
                if (l.includes('resource_link') && l.includes('draft_governance_issue')) expect(l, `${rel}:${n}`).toMatch(/no resource_link|not .*resource_link|two text|text blocks|resources\/list/i);
            }
        }
    });

    it('D-010: a cross-runtime SHA-256 promise always carries the deterministic pin qualifier', () => {
        for (const rel of ['README.md', 'AGENTS.md', 'llms.txt', 'docs/AI_GUIDE.md', 'docs/guides/DETERMINISM.md'].filter(has)) {
            for (const [n, l] of lines(rel)) {
                if (/same SHA-256 on every runtime|identical bytes on every runtime|identical SHA-256 on every runtime/i.test(l)) expect(l, `${rel}:${n}`).toMatch(/deterministic:\s*true|deterministic: true|pin/i);
            }
        }
    });

    it('D-011: includeDirectories is never described as defaulting to true without the "no filter" condition', () => {
        for (const rel of ['docs/KNOWLEDGE_BASE.md', 'docs/AI_GUIDE.md', 'README.md', 'AGENTS.md'].filter(has)) {
            for (const [n, l] of lines(rel)) {
                if (/includeDirectories[^\n]{0,60}\btrue\b/.test(l)) expect(l, `${rel}:${n}`).toMatch(/no filter|without a filter|filter is given|filter object/i);
            }
        }
    });

    it.skipIf(!has('.github/instructions/release.instructions.md'))('D-014: a named workflow step exists in .github/workflows when the release instructions cite one', () => {
        const text = read('.github/instructions/release.instructions.md');
        if (text.includes('`mcp-publish`')) {
            const workflows = readdirSync(path.join(ROOT, '.github', 'workflows')).map((f) => read(`.github/workflows/${f}`));
            expect(workflows.some((w) => w.includes('mcp-publish'))).toBe(true);
        }
    });

    it.skipIf(!has('.github/copilot-instructions.md'))('D-015: the tools said to share src/filter.ts all carry a filter input', () => {
        const withFilter = new Set(listToolsPayload().tools.filter((t) => 'filter' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).map((t) => t.name.split('_')[0]!));
        const line = read('.github/copilot-instructions.md').split('\n').find((l) => l.includes('src/filter.ts'));
        expect(line).toBeDefined();
        const listed = line!.split('shared by ')[1];
        expect(listed, 'the copilot line names the sharing tools').toBeDefined();
        for (const w of listed!.replace(/\.$/, '').split(' / ')) expect(withFilter.has(w.trim()), w).toBe(true);
    });

    it('D-017: the instructions are documented as a top-level field of the opening exchange, never serverInfo.instructions', () => {
        for (const rel of ['AGENTS.md', 'docs/AI_GUIDE.md', 'docs/KNOWLEDGE_BASE.md', 'README.md', 'llms.txt'].filter(has)) expect(read(rel), rel).not.toContain('serverInfo.instructions');
    });
});
