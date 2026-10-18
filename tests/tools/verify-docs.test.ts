import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
    ALL_RULES,
    COUNT_GROUP,
    EXPECTED_DOCUMENTS,
    KNOWN_NON_TOOLS,
    MANIFEST_REL,
    OFFLINE_RULES,
    RULES,
    TOOL_VERBS,
    compilePattern,
    formatRules,
    isExpectedDocument,
    isSuppressed,
    lineOf,
    parseCount,
    semverLess,
    verifyDocs,
    workflowJobs,
    type Problem,
    type VerifyResult,
} from '../../scripts/verify-docs.js';
import { renderRule } from '../../scripts/lib/agent-config.js';
import { corpusFigures, type CorpusFigures } from '../../scripts/lib/mcp-surface.js';
import { buildSecretNeedles, findSecretMaterial, isPlaceholderSecret, PRIVATE_KEY_BLOCK, tokenLiterals } from '../../scripts/lib/secret-needles.js';

// The documentation verifier, ported from pkinative-mcp 1.0.0. The helpers
// are unit-tested; the rule engine runs against a SYNTHETIC tree written to a
// temporary directory — a two-tool server with its manifest, contract and
// agent files — never against the live documents (those are held by
// `npx tsx scripts/verify-docs.ts` itself). The clean tree must pass every
// rule with zero errors (no false positive); a corrupted copy must make each
// rule fire (no false negative).

const ROOT = resolve(import.meta.dirname, '..', '..');
const VERSION = '1.2.3';
const STAMP = '2026-10-18';
const TOKEN = 'correct-horse-battery-staple-42';
const SHELLS = ['Bash', 'PowerShell'] as const;
const DENY = ['git push *', 'npm publish*', 'npm unpublish*', 'npm dist-tag*', 'npm deprecate*', 'gh pr create*', 'gh pr edit*', 'gh pr merge*', 'gh pr close*', 'gh pr comment*', 'gh issue create*', 'gh issue edit*', 'gh issue close*', 'gh issue comment*', 'gh release *'];
const INSTRUCTION = '---\ndescription: "Testing rules"\napplyTo: "tests/**"\n---\n# Testing\n\n- One test file per module.\n';

type Files = Record<string, string>;

function cleanTree(corpus: CorpusFigures): Files {
    const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
    const manifest = {
        verifiedOn: STAMP,
        packages: {
            'zipnative-mcp': { version: VERSION, pinField: null, pin: null, registryName: 'io.github.Nizoka/zipnative-mcp' },
            zipnative: { version: '1.1.0', pinField: 'dependencies', pin: '^1.1.0' },
        },
        declared: {
            tests: 5, engineExports: 2, dependencies: 3, nodeMajor: 22, toolApiVersion: '1.1.0',
            coverageStatements: 94, coverageBranches: 90, coverageFunctions: 95, coverageLines: 94,
            coverageMeasured: 98.12, coverageMeasuredBranches: 94.8, coverageMeasuredFunctions: 98.71, coverageMeasuredLines: 98.72,
            sdk: { name: '@modelcontextprotocol/server', pin: '^2.3.1', installed: '2.3.1' }, zod: { pin: '^4.6.5' },
        },
        derived: {
            tools: 2, toolGroups: { Read: ['inspect_zip'], Write: ['create_zip'] }, prompts: 1, errorCodes: 2, wrapperCodes: 2,
            zipErrorCodes: 2, zipDiagnosticCodes: 1, limits: 2, envVars: 2, examples: 0, testFiles: 1, samples: 0,
            corpusEntries: corpus.corpusEntries, corpusConformant: corpus.corpusConformant, corpusNonConformant: corpus.corpusNonConformant,
            corpusHostileConformant: corpus.corpusHostileConformant, checkIds: corpus.checkIds,
        },
        assertions: [
            { id: 'tool-count', canonical: '{derived.tools} tools', match: '(?<![#.\\d-])(?<!\\()\\b(\\d+)\\s+tools\\b', expectFrom: 'derived.tools', requireIn: ['README.md', 'docs/AGENT_CONTRACT.md'] },
            { id: 'prompt-count', canonical: '{derived.prompts} prompt', match: '(?<![#.\\d-])\\b{count}\\s+(?:MCP\\s+)?prompts?\\b', expectFrom: 'derived.prompts', requireIn: [] },
            { id: 'limit-count', canonical: '{derived.limits} `ZipLimits` keys', match: '(?<![#.\\d-])\\b{count}\\s+(?:named\\s+)?`?ZipLimits`?(?:\\s+(?:keys|bounds))?\\b', expectFrom: 'derived.limits', requireIn: [] },
        ],
    };
    const settings = {
        attribution: { commit: '' },
        permissions: { deny: ['Read(test-output/**)', 'Read(coverage/**)', ...SHELLS.flatMap((s) => DENY.map((d) => `${s}(${d})`))] },
        hooks: { PreToolUse: SHELLS.map((s) => ({ matcher: s, hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs', timeout: 5 }] })) },
    };
    const contract = [
        '# Agent contract', '', `Verified on ${STAMP}. 2 tools; set ZIPNATIVE_MCP_OUTPUT_DIR, or ZIPNATIVE_MCP_PORT for HTTP.`, '',
        '## 1. Tool catalogue (2 tools)', '', '| # | Tool | Use |', '|---|---|---|', '| 1 | `inspect_zip` | facts |', '| 2 | `create_zip` | write |', '',
        '## 6. Error reference', '', '| Code | Meaning |', '|---|---|',
        '| `VALIDATION_ERROR` | bad input |', '| `SECURITY_VIOLATION` | sandbox |', '| `ZIP_CRC_MISMATCH` | data |', '| `ZIP_PATH_TRAVERSAL` | refused |', '| `ZIP_PREPENDED_DATA` | diagnostic |', '',
    ].join('\n');
    return {
        [MANIFEST_REL]: json(manifest),
        'package.json': json({
            name: 'zipnative-mcp', version: VERSION, mcpName: 'io.github.Nizoka/zipnative-mcp',
            dependencies: { '@modelcontextprotocol/server': '^2.3.1', zipnative: '^1.1.0', zod: '^4.6.5' },
            engines: { node: '>=22' }, packageManager: 'npm@10.9.8', scripts: { gate: 'npx tsx scripts/gate.ts' },
        }),
        'node_modules/zipnative/package.json': json({ name: 'zipnative', version: '1.1.0' }),
        'node_modules/@modelcontextprotocol/server/package.json': json({ version: '2.3.1' }),
        'server.json': json({ version: VERSION, packages: [{ version: VERSION, environmentVariables: [{ name: 'ZIPNATIVE_MCP_OUTPUT_DIR' }, { name: 'ZIPNATIVE_MCP_PORT' }] }] }),
        'CITATION.cff': `cff-version: 1.2.0\ntitle: zipnative-mcp\nversion: ${VERSION}\n`,
        'src/version.ts': `export const ZIPNATIVE_MCP_VERSION = '${VERSION}';\nexport const TOOL_API_VERSION = '1.1.0';\n`,
        'src/sandbox.ts': "export const OUTPUT_DIR_ENV = 'ZIPNATIVE_MCP_OUTPUT_DIR';\n",
        'src/cli.ts': "export const port = process.env['ZIPNATIVE_MCP_PORT'];\n",
        'src/errors.ts': "export class ToolError extends Error {}\nexport class SecurityError extends ToolError { constructor(m: string) { super('SECURITY_VIOLATION', m); } }\n",
        'src/wrapper-codes.ts': "export const WRAPPER_CODES = [\n    { code: 'VALIDATION_ERROR', meaning: 'x', remedy: 'y' },\n    { code: 'SECURITY_VIOLATION', meaning: 'x', remedy: 'y' },\n];\n",
        'src/zip-errors.ts': "export const ZIP_ERROR_CLASS = {\n    ZIP_CRC_MISMATCH: 'data',\n    ZIP_PATH_TRAVERSAL: 'security',\n} as const;\nexport const ZIP_DIAGNOSTIC_CODES = [\n    'ZIP_PREPENDED_DATA',\n] as const;\n",
        'src/limits.ts': "export const LIMITS_INPUT_SCHEMA = {\n    properties: {\n        maxEntries: { type: 'integer' },\n        maxNameBytes: { type: 'integer' },\n    },\n};\n",
        'src/tools/inspect-zip.ts': "export const INSPECT_ZIP_NAME = 'inspect_zip';\n",
        'src/tools/create-zip.ts': "export const CREATE_ZIP_NAME = 'create_zip';\nthrow new ToolError('VALIDATION_ERROR', 'x');\n",
        'src/server.ts': [
            'const TOOLS: readonly ToolDefinition[] = [', '    {', '        name: INSPECT_ZIP_NAME,', "        examples: [{ input: { name: 'a.txt' } }],", '    },',
            '    {', '        name: CREATE_ZIP_NAME,', '    },', '];',
            'const PROMPTS: readonly PromptDefinition[] = [', '    {', "        name: 'secure_extraction',", '    },', '];', '',
        ].join('\n'),
        'tests/auth.test.ts': `const TOKEN = '${TOKEN}';\n`,
        '.nvmrc': '22\n',
        '.node-version': '22\n',
        'README.md': `# zipnative-mcp\n\nzipnative-mcp ${VERSION} serves 2 tools — \`inspect_zip\` and \`create_zip\` — and 1 prompt, with 2 \`ZipLimits\` keys. ${5} tests pass; ${corpus.corpusEntries} archives in the veraZIP corpus.\n\nSet ZIPNATIVE_MCP_OUTPUT_DIR (or ZIPNATIVE_MCP_PORT); see [the catalogue](docs/AGENT_CONTRACT.md#1-tool-catalogue-2-tools) and [usage](#usage).\n\n## Usage\n\nRun npx zipnative-mcp, then send Authorization: Bearer <token>.\n`,
        'AGENTS.md': '# AGENTS.md\n\nTwo tools, 5 tests. Read [the contract](docs/AGENT_CONTRACT.md).\n',
        'CLAUDE.md': '@AGENTS.md\n\n## Token discipline\n\n- Never Read `test-output/` or `coverage/`.\n',
        'CONTRIBUTING.md': '# Contributing\n\n## Pull Request Checklist\n\n- [ ] `npm run gate` passes\n- [ ] New code has tests\n',
        'CHANGELOG.md': `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - ${STAMP}\n\n[Unreleased]: https://github.com/Nizoka/zipnative-mcp/compare/v${VERSION}...HEAD\n[${VERSION}]: https://github.com/Nizoka/zipnative-mcp/releases/tag/v${VERSION}\n`,
        [`release-notes/v${VERSION}.md`]: `# v${VERSION}\n\nThe first release.\n`,
        'llms.txt': `# zipnative-mcp\n\nVerified on ${STAMP}. 2 tools: inspect_zip, create_zip.\n`,
        'docs/AGENT_CONTRACT.md': contract,
        'docs/KNOWLEDGE_BASE.md': `# Knowledge base\n\nVerified on ${STAMP}.\n`,
        'docs/AI_GUIDE.md': '# AI guide\n\nStart with `inspect_zip`, write with `create_zip`.\n',
        'docs/API_STABILITY.md': '# API stability\n\n`inspect_zip` and `create_zip` are frozen.\n',
        'docs/guides/CONFORMANCE.md': `# Conformance\n\nThe corpus holds ${corpus.corpusConformant + corpus.corpusNonConformant} archives: ${corpus.corpusConformant} conformant and ${corpus.corpusNonConformant} crafted negatives, ${corpus.corpusHostileConformant} hostile-but-conformant, against ISO/IEC 21320-1:2015 conformant readers.\n`,
        'docs/data/errors.json': json({ zipnativeVersion: '1.1.0', errors: [{ code: 'ZIP_CRC_MISMATCH' }, { code: 'ZIP_PATH_TRAVERSAL' }], diagnostics: [{ code: 'ZIP_PREPENDED_DATA' }] }),
        'docs/data/core-exports.json': json({ zipnativeVersion: '1.1.0', exportCount: 2, exports: [{ name: 'a' }, { name: 'b' }] }),
        'docs/data/verazip.json': json({
            declared: { conformant: corpus.corpusConformant, nonConformant: corpus.corpusNonConformant, hostileConformant: corpus.corpusHostileConformant },
            checkIds: corpus.checkIds, requiredNegativeChecks: corpus.requiredNegativeChecks,
        }),
        '.github/ai-governance.json': json({ capability_manifest: { sources: ['AGENTS.md'] }, references: { errors: 'docs/AGENT_CONTRACT.md#6-error-reference' } }),
        '.github/copilot-instructions.md': '# Copilot instructions\n\nRead AGENTS.md.\n',
        '.github/pull_request_template.md': '## Checklist\n\n- [ ] `npm run gate` passes\n- [ ] New code has tests\n',
        '.github/instructions/testing.instructions.md': INSTRUCTION,
        '.claude/rules/testing.md': renderRule('testing.instructions.md', INSTRUCTION) as string,
        '.claude/settings.json': json(settings),
        '.claude/hooks/guard.mjs': 'export {};\n',
    };
}

function writeTree(root: string, files: Files): void {
    for (const [rel, text] of Object.entries(files)) {
        const path = join(root, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    }
    // The corpus definition and the validator vocabulary (no imports beyond the raw builder).
    for (const rel of ['scripts/helpers/zip-corpus.mjs', 'scripts/helpers/raw-zip-builder.mjs', 'scripts/verazip-core.mjs']) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        copyFileSync(join(ROOT, rel), join(root, rel));
    }
}

const errorsOf = (result: VerifyResult, rule?: string): string[] =>
    result.problems.filter((p) => p.severity === 'error' && (rule === undefined || p.rule === rule)).map((p) => `${p.file}:${p.line} [${p.rule}] ${p.message}`);

describe('verify-docs — helpers', () => {
    it('computes 1-based line numbers from offsets', () => {
        expect(lineOf('a\nb\nc', 0)).toBe(1);
        expect(lineOf('a\nb\nc', 2)).toBe(2);
        expect(lineOf('a\nb\nc', 4)).toBe(3);
    });

    it('honours an allow marker on the line or the line above, for that rule only', () => {
        const lines = ['<!-- verify-docs:allow stale-token -->', '11 tools', 'x', 'y <!-- verify-docs:allow count-tokens -->'];
        expect(isSuppressed(lines, 2, 'stale-token')).toBe(true);
        expect(isSuppressed(lines, 2, 'count-tokens')).toBe(false);
        expect(isSuppressed(lines, 4, 'count-tokens')).toBe(true);
        expect(isSuppressed(lines, 3, 'stale-token')).toBe(false);
    });

    it('orders plain semver triples', () => {
        expect(semverLess('1.0.0', '1.0.1')).toBe(true);
        expect(semverLess('1.1.0', '1.0.9')).toBe(false);
        expect(semverLess('1.0.0', '1.0.0')).toBe(false);
        expect(semverLess('1.10.0', '1.9.0')).toBe(false);
    });

    it('parses digits, thousands separators and number words; {count} expands to the same vocabulary', () => {
        expect(parseCount('1,119')).toBe(1119);
        expect(parseCount('42')).toBe(42);
        expect(parseCount('Seven')).toBe(7);
        expect(parseCount('twelve')).toBe(12);
        expect(Number.isNaN(parseCount('many'))).toBe(true);
        const re = compilePattern('\\b{count}\\s+prompts\\b');
        expect(re.flags).toContain('g');
        expect([...'Seven prompts, 7 prompts and eight prompts'.matchAll(re)].map((m) => parseCount(m[1]!))).toEqual([7, 7, 8]);
        expect(COUNT_GROUP.startsWith('(')).toBe(true);
    });

    it('reads job ids, display names and matrix values from workflows', () => {
        const ci = 'name: CI\non: push\njobs:\n  ci:\n    name: ci\n    strategy:\n      matrix:\n        node-version: [22, 24]\n    steps: []\n  windows:\n    runs-on: windows-latest\n';
        const { jobs, matrixValues } = workflowJobs([ci, 'jobs:\n  sample-regression:\n    steps: []\n']);
        expect([...jobs].sort()).toEqual(['ci', 'sample-regression', 'windows']);
        expect([...matrixValues.get('ci')!]).toEqual(['22', '24']);
    });

    it('knows the documents the release is written against, and the names that are not tools', () => {
        expect(isExpectedDocument('docs/AGENT_CONTRACT.md')).toBe(true);
        expect(isExpectedDocument('docs\\guides\\CONFORMANCE.md')).toBe(true);
        expect(isExpectedDocument('docs/NOT_THERE.md')).toBe(false);
        expect(EXPECTED_DOCUMENTS).toContain('CHANGELOG.md');
        expect(KNOWN_NON_TOOLS).toContain('encrypt_zip');
        expect(TOOL_VERBS.test('merge_zip')).toBe(true);
        expect(TOOL_VERBS.test('secure_extraction')).toBe(false);
    });

    it('declares every rule once, with a description; npm-drift is the one online rule', () => {
        expect(new Set(ALL_RULES).size).toBe(ALL_RULES.length);
        for (const r of RULES) expect(r.description.length, r.id).toBeGreaterThan(20);
        expect(ALL_RULES.filter((r) => !OFFLINE_RULES.includes(r))).toEqual(['npm-drift']);
        for (const rule of ['tool-parity', 'error-parity', 'env-var-parity', 'changelog-ladder', 'agent-config-parity', 'prose-language', 'no-secret-material', 'engine-data-parity', 'verazip-counts', 'ruleset-parity', 'claude-rules-sync']) {
            expect(OFFLINE_RULES).toContain(rule);
        }
        expect(OFFLINE_RULES).not.toContain('interop-counts');
        expect(formatRules().split('\n')).toHaveLength(RULES.length);
        expect(MANIFEST_REL).toBe('docs/assets/ecosystem.json');
    });
});

describe('verify-docs — secret material', () => {
    it('collects the token literals of the test sources as needles, never a placeholder', () => {
        expect(tokenLiterals(`const TOKEN = '${TOKEN}';\nconst OTHER_TOKEN = 'change-me-please-1234';\nconst SHORT_TOKEN = 'abc';`)).toEqual([TOKEN]);
        const needles = buildSecretNeedles(ROOT);
        expect(needles).toContain(TOKEN);
        expect(buildSecretNeedles(join(ROOT, 'no-such-dir'))).toEqual([]);
    });

    it('tells a placeholder from a credential', () => {
        for (const p of ['<token>', '$TOKEN', 'change-me-to-a-real-secret', 'your-token-here', 'xxxxxxxxxxxxxxxx', '…']) expect(isPlaceholderSecret(p), p).toBe(true);
        expect(isPlaceholderSecret('q7Rk2vLm9PzX4tWa')).toBe(false);
    });

    it('finds a test token, a concrete bearer token, a credential, a PRIVATE KEY body and a development-host path', () => {
        const reasons = (text: string): string[] => findSecretMaterial(text, [TOKEN]).map((f) => f.reason);
        expect(reasons(`curl -H "Authorization: Bearer ${TOKEN}"`)).toEqual([expect.stringContaining('token literal of the test suite')]);
        expect(reasons('ZIPNATIVE_MCP_HTTP_TOKEN=q7Rk2vLm9PzX4tWa8nYc npx zipnative-mcp')).toEqual([expect.stringContaining('concrete bearer token')]);
        expect(reasons('Authorization: Bearer q7Rk2vLm9PzX4tWa8nYc')).toEqual([expect.stringContaining('concrete bearer token')]);
        expect(reasons('ZIPNATIVE_MCP_HTTP_TOKEN=change-me-to-a-real-secret and Authorization: Bearer <token>')).toEqual([]);
        expect(reasons(`npm config set //registry.npmjs.org/:_authToken=npm_${'a1B2'.repeat(9)}`)).toEqual([expect.stringContaining('npm access token')]);
        expect(reasons(`ghp_${'Z9y8'.repeat(9)}`)).toEqual([expect.stringContaining('GitHub token')]);
        expect(reasons('-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----')).toEqual([expect.stringContaining('PRIVATE KEY PEM block')]);
        expect(reasons('-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----')).toEqual([]);
        expect(reasons('set ZIPNATIVE_MCP_OUTPUT_DIR to D:\\Github\\sandbox')).toEqual([expect.stringContaining('development-host absolute path')]);
        expect(reasons('"C:\\\\path\\\\to\\\\sandbox" is fine as an illustration')).toEqual([]);
        PRIVATE_KEY_BLOCK.lastIndex = 0;
    });
});

describe('verify-docs — a clean synthetic tree', () => {
    let root = '';
    let corpus: CorpusFigures;
    let result: VerifyResult;

    beforeAll(async () => {
        corpus = (await corpusFigures(ROOT))!;
        root = mkdtempSync(join(tmpdir(), 'zipnative-mcp-verify-docs-clean-'));
        writeTree(root, cleanTree(corpus));
        result = await verifyDocs(root);
    }, 60_000);

    afterAll(() => {
        if (root) rmSync(root, { recursive: true, force: true });
    });

    it('passes every offline rule with zero errors and zero warnings', () => {
        expect(result.problems.map((p) => `${p.file}:${p.line} [${p.rule}] ${p.message}`)).toEqual([]);
        expect(result.rules).toEqual(OFFLINE_RULES);
        expect(result.verifiedOn).toBe(STAMP);
        expect(result.files).toBeGreaterThan(5);
    });

    it('reports what it could not check as a skip with a reason, never as an error', () => {
        const skipped = new Set(result.skips.map((s) => s.rule));
        // No ruleset, no skill, not a git checkout, offline; the absent expected documents are not referenced by any rule.
        for (const rule of ['ruleset-parity', 'skills-shape', 'eol-lf', 'npm-drift']) expect(skipped.has(rule), rule).toBe(true);
        for (const s of result.skips) expect(s.message.length, s.rule).toBeGreaterThan(10);
    });

    it('--require-all turns every skip but npm-drift into an error', async () => {
        const strict = await verifyDocs(root, { requireAll: true });
        expect(strict.skips.map((s) => s.rule)).toEqual(['npm-drift']);
        expect(errorsOf(strict)).toHaveLength(result.skips.filter((s) => s.rule !== 'npm-drift').length);
    }, 60_000);

    it('--only narrows the report to one rule', async () => {
        const only = await verifyDocs(root, { only: 'tool-parity' });
        expect(only.rules).toEqual(['tool-parity']);
        expect(only.skips.every((s) => s.rule === 'tool-parity')).toBe(true);
    }, 60_000);

    it('skips the corpus rules on a tree without the corpus definition', async () => {
        const bare = mkdtempSync(join(tmpdir(), 'zipnative-mcp-verify-docs-bare-'));
        try {
            const files = cleanTree(corpus);
            for (const [rel, text] of Object.entries(files)) {
                mkdirSync(dirname(join(bare, rel)), { recursive: true });
                writeFileSync(join(bare, rel), text);
            }
            const r = await verifyDocs(bare);
            expect(r.skips.filter((s) => s.rule === 'verazip-counts' || s.rule === 'derived-counts').map((s) => s.file)).toEqual(['scripts/helpers/zip-corpus.mjs', 'scripts/helpers/zip-corpus.mjs']);
            expect(errorsOf(r)).toEqual([]);
        } finally {
            rmSync(bare, { recursive: true, force: true });
        }
    }, 60_000);
});

describe('verify-docs — a corrupted synthetic tree', () => {
    let root = '';
    let problems: Problem[] = [];

    beforeAll(async () => {
        const corpus = (await corpusFigures(ROOT))!;
        const files = cleanTree(corpus);
        const edit = (rel: string, fn: (text: string) => string): void => {
            files[rel] = fn(files[rel] ?? '');
        };
        edit(MANIFEST_REL, (text) => {
            const m = JSON.parse(text) as { derived: Record<string, unknown>; declared: Record<string, unknown>; packages: Record<string, { version: string }> };
            m.derived['prompts'] = 99;
            m.derived['typoKey'] = 1;
            m.derived['limits'] = 3;
            m.declared['engineExports'] = 5;
            (m.derived['toolGroups'] as Record<string, string[]>)['Read']!.push('render_zip');
            return JSON.stringify(m, null, 2);
        });
        edit('README.md', (text) => `${text}\nStale: zipnative v0.0.1 has 11 tools and Seven prompts; call \`convert_zip\` and set ZIPNATIVE_MCP_NOPE. 4 corpus entries, 23 tests.\n\nBroken anchors: [same](#no-such-heading), [cross](docs/AGENT_CONTRACT.md#nope-either).\n\n[allowed](#also-missing) <!-- verify-docs:allow anchor-parity -->\n\nPlanned: \`generate_zip\` <!-- verify-docs:allow tool-parity -->\n\nNot a tool, by design: \`encrypt_zip\`.\n\n[gone](docs/NOT_THERE.md)\n\nLeak: Authorization: Bearer ${TOKEN} and the sandbox at D:\\Github\\sandbox.\n`);
        edit('docs/AGENT_CONTRACT.md', (text) => text.replace(/^\| `SECURITY_VIOLATION` \|.*\n/m, '').replace(/^(\| `VALIDATION_ERROR` \|.*\n)/m, '$1| `INVENTED_CODE` | never |\n| `OLD_CODE` | Legacy — removed in 1.0.0 |\n'));
        // demo-language: fr (the prose-language rule must fire on this line of the corrupted tree)
        edit('docs/AI_GUIDE.md', (text) => `${text}\nla ponctuation qui borde une ligne\n`);
        edit('docs/KNOWLEDGE_BASE.md', (text) => text.replace(STAMP, '2026-01-01'));
        edit('docs/guides/CONFORMANCE.md', (text) => `${text}\nThe old gate validated 38 archives with 5 negatives.\n`);
        edit('docs/data/errors.json', (text) => text.replace('"zipnativeVersion": "1.1.0"', '"zipnativeVersion": "1.0.0"').replace('"ZIP_PREPENDED_DATA"', '"ZIP_FAKE_DIAGNOSTIC"'));
        edit('docs/data/verazip.json', (text) => text.replace(/"conformant": \d+/, '"conformant": 1'));
        edit('CHANGELOG.md', (text) => text.replace(new RegExp(`^\\[${VERSION.replace(/\./g, '\\.')}\\]:.*\\n`, 'm'), ''));
        edit('src/version.ts', (text) => `${text}export const KNOB = process.env['ZIPNATIVE_MCP_UNDECLARED'];\n`);
        edit('package.json', (text) => text.replace('"zod":', '"left-pad": "^1.3.0",\n    "zod":'));
        edit('.github/ai-governance.json', (text) => text.replace('"AGENTS.md"', '"AGENTS.md", ".github/AGENT_RULES_GONE.md"'));
        edit('.claude/settings.json', (text) => text.replace('"matcher": "PowerShell"', '"matcher": "Pwsh"').replace('"Bash(npm deprecate*)",', ''));
        edit('.claude/rules/testing.md', (text) => `${text}\n- Edited by hand.\n`);
        edit('.github/pull_request_template.md', (text) => text.replace('New code has tests', 'New code has unit tests'));
        edit('.node-version', () => '20\n');
        edit('CLAUDE.md', (text) => `# CLAUDE.md\n\n${text}`);
        files['.github/rulesets/main.json'] = JSON.stringify({ rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ghost-job' }] } }] });
        files['.claude/skills/demo/SKILL.md'] = '---\nname: other\ndescription: A demo.\n---\nRead `missing.md`.\n';
        root = mkdtempSync(join(tmpdir(), 'zipnative-mcp-verify-docs-bad-'));
        writeTree(root, files);
        problems = (await verifyDocs(root)).problems;
    }, 60_000);

    afterAll(() => {
        if (root) rmSync(root, { recursive: true, force: true });
    });

    const messages = (rule: string): string[] => problems.filter((p) => p.rule === rule && p.severity === 'error').map((p) => `${p.file}:${p.line} ${p.message}`);

    it('fails derived-counts and manifest-shape on the corrupted manifest and the fourth dependency', () => {
        expect(messages('derived-counts')).toEqual(expect.arrayContaining([
            expect.stringContaining('derived.prompts says 99 but the tree has 1'),
            expect.stringContaining('derived.limits says 3 but the tree has 2'),
            expect.stringContaining('declared.engineExports says 5 but docs/data/core-exports.json exportCount has 2'),
        ]));
        expect(messages('manifest-shape')).toEqual(expect.arrayContaining([
            expect.stringContaining('derived.typoKey'),
            expect.stringContaining('left-pad'),
        ]));
    });

    it('fails stale-token (number words included), version-token and count-tokens on the appended README line', () => {
        expect(messages('stale-token')).toEqual(expect.arrayContaining([
            expect.stringMatching(/README\.md:\d+ "11 tools" — the manifest says 2/),
            expect.stringMatching(/README\.md:\d+ "Seven prompts" — the manifest says 99/),
        ]));
        expect(messages('version-token')).toEqual([expect.stringContaining('"zipnative v0.0.1" — the manifest says zipnative is 1.1.0')]);
        expect(messages('count-tokens')).toEqual(expect.arrayContaining([
            expect.stringContaining('"4 corpus entries"'),
            expect.stringContaining('"23 tests" — the manifest says 5'),
        ]));
    });

    it('fails tool-parity on an invented tool in the docs and in the manifest groups, and honours the allow marker and the known non-tools', () => {
        const found = messages('tool-parity');
        expect(found).toEqual(expect.arrayContaining([
            expect.stringMatching(/README\.md:\d+ `convert_zip` reads like a tool name/),
            expect.stringContaining('derived.toolGroups differs from the TOOLS registry — unknown: render_zip'),
        ]));
        expect(found.some((m) => m.includes('generate_zip'))).toBe(false);
        expect(found.some((m) => m.includes('encrypt_zip'))).toBe(false);
    });

    it('fails error-parity in both directions, and honours a Legacy row', () => {
        expect(messages('error-parity')).toEqual([
            expect.stringContaining('§6 has no row for the wrapper code SECURITY_VIOLATION'),
            expect.stringMatching(/AGENT_CONTRACT\.md:\d+ §6 documents `INVENTED_CODE`/),
        ]);
    });

    it('fails env-var-parity on an undeclared variable in the docs and in the source', () => {
        expect(messages('env-var-parity')).toEqual(expect.arrayContaining([
            expect.stringMatching(/README\.md:\d+ ZIPNATIVE_MCP_NOPE is not an operator variable/),
            expect.stringMatching(/src\/version\.ts:\d+ ZIPNATIVE_MCP_UNDECLARED is read by the source but server\.json does not declare it/),
            expect.stringContaining('README.md:1 does not name ZIPNATIVE_MCP_UNDECLARED'),
        ]));
    });

    it('fails changelog-ladder on the missing rung', () => {
        expect(messages('changelog-ladder')).toEqual([expect.stringContaining(`heading [${VERSION}] has no link definition`)]);
    });

    it('fails internal-links and anchor-parity, and honours the allow marker', () => {
        expect(messages('internal-links')).toEqual([expect.stringMatching(/README\.md:\d+ "docs\/NOT_THERE\.md" does not resolve/)]);
        const found = messages('anchor-parity');
        expect(found).toEqual([
            expect.stringMatching(/README\.md:\d+ "#no-such-heading" is not a heading anchor of README\.md/),
            expect.stringMatching(/README\.md:\d+ "#nope-either" is not a heading anchor of docs\/AGENT_CONTRACT\.md/),
        ]);
    });

    it('fails the agent layer: governance-sources, agent-config-parity, claude-rules-sync, claude-md-budget, pr-template-parity, skills-shape', () => {
        expect(messages('governance-sources')).toEqual([expect.stringContaining('".github/AGENT_RULES_GONE.md", which does not exist')]);
        expect(messages('agent-config-parity')).toEqual(expect.arrayContaining([
            expect.stringContaining('no Bash(npm deprecate…) entry'),
            expect.stringContaining('no PowerShell matcher'),
        ]));
        expect(messages('claude-rules-sync')).toEqual([expect.stringMatching(/\.claude\/rules\/testing\.md:1 differs from its instruction file/)]);
        expect(messages('claude-md-budget')).toEqual([expect.stringContaining('it must be "@AGENTS.md"')]);
        expect(messages('pr-template-parity')).toEqual([expect.stringContaining('New code has unit tests')]);
        expect(messages('skills-shape')).toEqual(expect.arrayContaining([
            expect.stringContaining('frontmatter name "other" must equal the directory name "demo"'),
            expect.stringContaining('`missing.md`'),
        ]));
    });

    it('fails node-pin-parity and ruleset-parity on the repository plumbing', () => {
        expect(messages('node-pin-parity')).toEqual([expect.stringContaining('.node-version:1 pins 20 but package.json engines.node')]);
        expect(messages('ruleset-parity')).toEqual(expect.arrayContaining([
            expect.stringContaining('required status check "ghost-job" names no job'),
            expect.stringContaining('no required status check "sample-regression"'),
            expect.stringContaining('no required status check "verazip"'),
            expect.stringContaining('.github/rulesets/tags.json:1 missing'),
        ]));
    });

    it('fails verified-on-parity, prose-language and no-secret-material', () => {
        expect(messages('verified-on-parity')).toEqual([expect.stringContaining('docs/KNOWLEDGE_BASE.md:3 stamped 2026-01-01')]);
        // demo-language: fr (the reason the detector reports)
        expect(messages('prose-language')).toEqual([expect.stringMatching(/docs\/AI_GUIDE\.md:\d+ French word "ponctuation"/)]);
        expect(messages('no-secret-material')).toEqual([
            expect.stringMatching(/README\.md:\d+ carries a token literal of the test suite/),
            expect.stringMatching(/README\.md:\d+ carries a development-host absolute path/),
        ]);
    });

    it('fails engine-data-parity on a stale pin and a drifted vocabulary, and verazip-counts on a wrong declaration and a stale quote', () => {
        expect(messages('engine-data-parity')).toEqual([
            expect.stringContaining('docs/data/errors.json:2 pins zipnativeVersion 1.0.0 but node_modules/zipnative (1.1.0) is the engine'),
            expect.stringContaining('diagnostics[] differs from ZIP_DIAGNOSTIC_CODES'),
        ]);
        expect(messages('verazip-counts')).toEqual(expect.arrayContaining([
            expect.stringMatching(/docs\/data\/verazip\.json:\d+ declared\.conformant is 1 but scripts\/helpers\/zip-corpus\.mjs defines \d+/),
            expect.stringContaining('"38 archives"'),
            expect.stringContaining('"5 negatives"'),
        ]));
    });

    it('never runs eol-lf outside a git checkout', () => {
        expect(problems.filter((p) => p.rule === 'eol-lf')).toEqual([]);
    });
});

describe('verify-docs — the CLI', () => {
    it('lists the rules, refuses an unknown flag and an unknown --only rule with exit 2', async () => {
        const { spawnSync } = await import('node:child_process');
        const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
            const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'verify-docs.ts'), ...args], { encoding: 'utf8', windowsHide: true, cwd: ROOT });
            return { status: r.status, stdout: r.stdout, stderr: r.stderr };
        };
        const rules = run('--rules');
        expect(rules.status, rules.stderr).toBe(0);
        expect(rules.stdout.trim().split('\n').map((l) => l.split(/\s+/)[0])).toEqual([...ALL_RULES]);
        expect(run('--bogus').status).toBe(2);
        expect(run('--only', 'no-such-rule').status).toBe(2);
        expect(readFileSync(join(ROOT, 'scripts', 'verify-docs.ts'), 'utf8')).toContain("findNonEnglishProse(text, file, { suppress: 'verify-docs:allow prose-language' })");
    }, 60_000);
});
