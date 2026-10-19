// scripts/lib/mcp-surface.ts reads the server surface from text: scripts
// never import src/, and verify-docs runs before any build. Each parser is
// exercised with inline fixtures in both directions, then the real source
// tree is compared with the live registry: a parser that silently stops
// matching (a reformatted TOOLS array, a renamed PROMPTS table, a new code
// table shape) must fail here, not pass with a zero. Ported from
// pkinative-mcp 1.0.0 (tests/tools/mcp-surface.test.ts); the zip server keeps
// one flat TOOLS array in src/server.ts instead of group files.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ENV_PREFIX,
    NON_OPERATOR_ENV_TOKENS,
    changelogCompareLinks,
    changelogHeadings,
    checkChangelogLadder,
    computeDerived,
    contractCatalogueTools,
    contractErrorRows,
    corpusFigures,
    declaredTools,
    envVarTokens,
    errorCodes,
    limitKeys,
    promptNames,
    registryToolRefs,
    serverJsonEnvVars,
    snakeTokens,
    sourceEnvVars,
    subclassErrorCodes,
    toolErrorCodes,
    toolNameConstant,
    toolNames,
    wrapperCodes,
    zipDiagnosticCodes,
    zipErrorCodes,
} from '../../scripts/lib/mcp-surface.js';
import { buildCorpus, corpusCounts } from '../../scripts/helpers/zip-corpus.mjs';
import { CHECK_IDS, REQUIRED_NEGATIVE_CHECKS } from '../../scripts/verazip-core.mjs';
import { HTTP_TOKEN_ENV } from '../../src/auth.js';
import { MAX_ENTRIES_ENV, MAX_FILE_OUTPUT_ENV, MAX_UNCOMPRESSED_ENV, WORKERS_ENV } from '../../src/caps.js';
import { LimitsSchema } from '../../src/limits.js';
import { OUTPUT_DIR_ENV } from '../../src/sandbox.js';
import { __prompts, listToolsPayload } from '../../src/server.js';
import { WRAPPER_CODES } from '../../src/wrapper-codes.js';
import { ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CODES } from '../../src/zip-errors.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(resolve(ROOT, ...parts), 'utf8');

describe('mcp-surface: pure parsers', () => {
    it('reads the <NAME>_NAME constant of a tool module', () => {
        expect(toolNameConstant("import x from 'y';\nexport const CREATE_ZIP_NAME = 'create_zip';\n")).toEqual(['CREATE_ZIP_NAME', 'create_zip']);
        expect(toolNameConstant("const CREATE_ZIP_NAME = 'create_zip';")).toBeNull();
        expect(toolNameConstant("export const SCHEMA_NAME = 'Not A Tool';")).toBeNull();
    });

    it('reads the name rows of the TOOLS registry in order, constants and literals, never a nested name', () => {
        const server = [
            "const READ_ONLY = { readOnlyHint: true } as const;",
            'const TOOLS: readonly ToolDefinition[] = [',
            '    {',
            '        name: INSPECT_ZIP_NAME,',
            "        examples: [{ title: 'x', input: { zipBase64: '<zip>', name: 'META-INF/MANIFEST.MF' } }],",
            '    },',
            '    {',
            "        name: 'legacy_tool',",
            '        input: {',
            "            name: 'nested_not_a_tool',",
            '        },',
            '    },',
            '    {',
            '        name: CREATE_ZIP_NAME,',
            '    },',
            '];',
            'const OTHER = [',
            '    {',
            '        name: AFTER_NAME,',
            '    },',
            '];',
        ].join('\n');
        expect(registryToolRefs(server)).toEqual(['INSPECT_ZIP_NAME', 'legacy_tool', 'CREATE_ZIP_NAME']);
        expect(registryToolRefs('const NOT_TOOLS = [];')).toEqual([]);
    });

    it('reads the prompt names up to the end of the PROMPTS table', () => {
        const server = "const PROMPTS: readonly PromptDefinition[] = [\n    {\n        name: 'governance_contract',\n    },\n    {\n        name: 'secure_extraction',\n    },\n];\nconst AFTER = [\n    {\n        name: 'not_a_prompt',\n    },\n];";
        expect(promptNames(server)).toEqual(['governance_contract', 'secure_extraction']);
        expect(promptNames('nothing')).toEqual([]);
    });

    it('collects ToolError codes across a line break, the fixed codes of the subclasses, and the wrapper-code table', () => {
        expect(toolErrorCodes("throw new ToolError('VALIDATION_ERROR', m);\nthrow new ToolError(\n    'INPUT_TOO_LARGE',\n    m);")).toEqual(['VALIDATION_ERROR', 'INPUT_TOO_LARGE']);
        expect(toolErrorCodes('new ToolError(err.code, m)')).toEqual([]);
        expect(subclassErrorCodes("class SecurityError extends ToolError { constructor(m) { super('SECURITY_VIOLATION', m); } }")).toEqual(['SECURITY_VIOLATION']);
        expect(wrapperCodes("{ code: 'VALIDATION_ERROR', meaning: 'x' },\n{ code: 'INPUT_TOO_LARGE' },\n{ code: 'VALIDATION_ERROR' }")).toEqual(['VALIDATION_ERROR', 'INPUT_TOO_LARGE']);
    });

    it('reads the ZIP_ERROR_CLASS keys and the ZIP_DIAGNOSTIC_CODES entries, comments skipped', () => {
        const text = [
            'export const ZIP_ERROR_CLASS = {',
            '    // ── base (2)',
            "    ZIP_INVALID_OPTION: 'usage',",
            "    ZIP_CRC_MISMATCH: 'data',",
            '} as const satisfies Record<ZipErrorCode, string>;',
            "const OTHER = { ZIP_NOT_A_CODE: 'x' };",
            'export const ZIP_DIAGNOSTIC_CODES = [',
            "    'ZIP_PREPENDED_DATA',",
            "    // zipnative 1.1.0: 'ZIP_IN_A_COMMENT' is not an entry.",
            "    'ZIP_TIMESTAMP_CLAMPED',",
            '] as const satisfies readonly ZipDiagnosticCode[];',
        ].join('\n');
        expect(zipErrorCodes(text)).toEqual(['ZIP_INVALID_OPTION', 'ZIP_CRC_MISMATCH']);
        expect(zipDiagnosticCodes(text)).toEqual(['ZIP_PREPENDED_DATA', 'ZIP_TIMESTAMP_CLAMPED']);
        expect(zipErrorCodes('nothing')).toEqual([]);
        expect(zipDiagnosticCodes('nothing')).toEqual([]);
    });

    it('reads the ZipLimits keys of the JSON-Schema rows, not the Zod rows', () => {
        const text = "    properties: {\n        maxEntries: { type: 'integer', minimum: 1 },\n        maxNameBytes: { type: 'integer' },\n    },\n};\nconst Z = z.strictObject({\n    maxEntries: z.number().int().optional(),\n});";
        expect(limitKeys(text)).toEqual(['maxEntries', 'maxNameBytes']);
    });

    it('reads the first column of the §6 tables only, several codes per cell included', () => {
        const contract = '## 5. Recipes\n\n`NOT_A_ROW`\n\n## 6. Error reference\n\n### 6.1 Wrapper codes\n\n| Code | When | Do |\n|---|---|---|\n| `VALIDATION_ERROR` | bad `INPUT_THING` | fix |\n| `ENTRY_TOO_LARGE` / `OUTPUT_TOO_LARGE` | x | y |\n\n### 6.2 Engine codes\n\n| `ZIP_CRC_MISMATCH` | data | retry |\n\n## 7. Next\n\n| `LATER` | x | y |\n';
        expect(contractErrorRows(contract)).toEqual(['VALIDATION_ERROR', 'ENTRY_TOO_LARGE', 'OUTPUT_TOO_LARGE', 'ZIP_CRC_MISMATCH']);
        expect(contractErrorRows('# no table')).toEqual([]);
    });

    it('reads the numbered rows of the §1 catalogue', () => {
        const contract = '## 1. Tool catalogue (2 tools)\n\n| # | Tool | Use |\n|---|---|---|\n| 1 | `inspect_zip` | x `verify_zip` |\n| 2 | `verify_zip` | y |\n\n## 2. Decision tree\n\n| 3 | `not_in_catalogue` | z |\n';
        expect(contractCatalogueTools(contract)).toEqual(['inspect_zip', 'verify_zip']);
        expect(contractCatalogueTools('# none')).toEqual([]);
    });

    it('tokenises tool-shaped names and operator variables', () => {
        expect(snakeTokens('Call `create_zip`, then `verify_zip` — not `outputMode`, `zip64` or extract_zip.')).toEqual(['create_zip', 'verify_zip']);
        expect(envVarTokens('Set ZIPNATIVE_MCP_OUTPUT_DIR (and the old ZIPNATIVE_MPC_OUTPUT_DIR); `ZIPNATIVE_MCP_*` is the prefix. ZIPNATIVE_MCP_OUTPUT_DIR again.')).toEqual(['ZIPNATIVE_MCP_OUTPUT_DIR']);
        expect(ENV_PREFIX).toBe('ZIPNATIVE_MCP_');
        expect(NON_OPERATOR_ENV_TOKENS).toContain('ZIPNATIVE_MCP_VERSION');
    });

    it('lists the operator variables of server.json once each', () => {
        const text = JSON.stringify({ packages: [{ environmentVariables: [{ name: 'A' }, { name: 'B' }, { name: 'A' }, { description: 'nameless' }] }] });
        expect(serverJsonEnvVars(text)).toEqual(['A', 'B']);
        expect(serverJsonEnvVars('{}')).toEqual([]);
    });
});

describe('mcp-surface: changelog ladder', () => {
    const GOOD = [
        '# Changelog', '', '## [Unreleased]', '', '## [1.1.0] - 2026-10-18', '', '## [1.0.0] - 2026-09-07', '',
        '[Unreleased]: https://github.com/Nizoka/zipnative-mcp/compare/v1.1.0...HEAD',
        '[1.1.0]: https://github.com/Nizoka/zipnative-mcp/compare/v1.0.0...v1.1.0',
        '[1.0.0]: https://github.com/Nizoka/zipnative-mcp/releases/tag/v1.0.0',
    ].join('\n');

    it('parses headings, compare links and the tag link of the first release', () => {
        expect(changelogHeadings(GOOD).map((h) => h.label)).toEqual(['Unreleased', '1.1.0', '1.0.0']);
        const links = changelogCompareLinks(GOOD);
        expect(links.map((l) => l.label)).toEqual(['Unreleased', '1.1.0', '1.0.0']);
        expect(links[0]).toMatchObject({ from: 'v1.1.0', to: 'HEAD' });
        expect(links[2]).toMatchObject({ from: null, to: 'v1.0.0' });
    });

    it('passes a complete ladder', () => {
        expect(checkChangelogLadder(GOOD)).toEqual([]);
    });

    it('fails on a missing rung, a rung comparing the wrong tags, a stale Unreleased and an orphan link', () => {
        expect(checkChangelogLadder(GOOD.replace(/^\[1\.0\.0\]:.*\n?/m, '')).map((f) => f.message)).toEqual([expect.stringMatching(/\[1\.0\.0\] has no link definition/)]);
        expect(checkChangelogLadder(GOOD.replace('compare/v1.0.0...v1.1.0', 'compare/v0.9.0...v1.1.0')).map((f) => f.message)).toEqual([expect.stringMatching(/must compare v1\.0\.0\.\.\.v1\.1\.0/)]);
        expect(checkChangelogLadder(GOOD.replace('compare/v1.1.0...HEAD', 'compare/v1.0.0...HEAD')).map((f) => f.message)).toEqual([expect.stringMatching(/\[Unreleased\] must compare v1\.1\.0\.\.\.HEAD/)]);
        expect(checkChangelogLadder(`${GOOD}\n[0.9.0]: https://github.com/Nizoka/zipnative-mcp/releases/tag/v0.9.0`).map((f) => f.message)).toEqual([expect.stringMatching(/\[0\.9\.0\] has no heading/)]);
    });
});

describe('mcp-surface: the source tree agrees with the live server', () => {
    it('resolves the same tools, in the same order, as tools/list — every registry row through a src/tools/ constant', () => {
        const live = listToolsPayload().tools.map((t) => t.name);
        expect(toolNames(ROOT)).toEqual(live);
        const declared = declaredTools(ROOT);
        expect(new Set(declared.values())).toEqual(new Set(live));
        const refs = registryToolRefs(read('src', 'server.ts'));
        expect(refs).toHaveLength(live.length);
        for (const ref of refs) expect(declared.has(ref), ref).toBe(true);
    });

    it('resolves the same prompts as the PROMPTS table', () => {
        expect(promptNames(read('src', 'server.ts'))).toEqual(__prompts.map((p) => p.name));
    });

    it('reads the wrapper table, the frozen ZIP_* codes and the diagnostics the source exports', () => {
        expect(wrapperCodes(read('src', 'wrapper-codes.ts'))).toEqual(WRAPPER_CODES.map((w) => w.code));
        const zipErrors = read('src', 'zip-errors.ts');
        expect(zipErrorCodes(zipErrors)).toEqual([...ZIP_ERROR_CODES]);
        expect(zipDiagnosticCodes(zipErrors)).toEqual([...ZIP_DIAGNOSTIC_CODES]);
        // Every literal ToolError code is a wrapper code or a frozen engine code.
        const known = new Set<string>([...WRAPPER_CODES.map((w) => w.code), ...ZIP_ERROR_CODES]);
        expect(errorCodes(ROOT).filter((c) => !known.has(c))).toEqual([]);
        expect(errorCodes(ROOT)).toEqual(expect.arrayContaining(['VALIDATION_ERROR', 'SECURITY_VIOLATION', 'GOVERNANCE_VIOLATION']));
    });

    it('reads the ZipLimits keys of src/limits.ts — the keys the Zod schema accepts', () => {
        expect(limitKeys(read('src', 'limits.ts')).sort()).toEqual(Object.keys(LimitsSchema.shape).sort());
    });

    it('finds every operator variable the source exports as a constant, prefixed, and nothing that is not one', () => {
        const vars = sourceEnvVars(ROOT);
        for (const v of [OUTPUT_DIR_ENV, HTTP_TOKEN_ENV, MAX_UNCOMPRESSED_ENV, MAX_ENTRIES_ENV, WORKERS_ENV, MAX_FILE_OUTPUT_ENV, 'ZIPNATIVE_MCP_CACHE_DIR', 'ZIPNATIVE_MCP_PORT']) {
            expect(vars, v).toContain(v);
        }
        for (const v of vars) expect(v.startsWith(ENV_PREFIX), v).toBe(true);
        for (const t of NON_OPERATOR_ENV_TOKENS) expect(vars).not.toContain(t);
    });

    it('derives every figure non-zero, and the corpus figures from the corpus definition itself', async () => {
        const derived = computeDerived(ROOT);
        for (const [key, value] of Object.entries(derived)) expect(value, key).toBeGreaterThan(0);
        expect(derived.tools).toBe(listToolsPayload().tools.length);
        expect(derived.prompts).toBe(__prompts.length);
        expect(derived.wrapperCodes).toBe(WRAPPER_CODES.length);
        expect(derived.zipErrorCodes).toBe(ZIP_ERROR_CODES.length);
        expect(derived.zipDiagnosticCodes).toBe(ZIP_DIAGNOSTIC_CODES.length);
        const corpus = await corpusFigures(ROOT);
        expect(corpus).not.toBeNull();
        const entries = buildCorpus({ call: () => Promise.reject(new Error('unused')), sandboxDir: null });
        const counts = corpusCounts(entries);
        expect(corpus).toEqual({
            corpusEntries: entries.length,
            corpusConformant: counts.conformant,
            corpusNonConformant: counts.nonConformant,
            corpusHostileConformant: counts.hostileConformant,
            checkIds: CHECK_IDS.length,
            requiredNegativeChecks: [...REQUIRED_NEGATIVE_CHECKS],
        });
        expect(corpus!.corpusConformant + corpus!.corpusNonConformant).toBe(corpus!.corpusEntries);
        expect(await corpusFigures(resolve(ROOT, 'no-such-root'))).toBeNull();
    });
});
