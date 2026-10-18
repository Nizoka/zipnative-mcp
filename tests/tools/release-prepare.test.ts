import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    isSemver,
    isIsoDate,
    todayUtc,
    stripTag,
    minorLine,
    bumpJsonVersion,
    bumpLockVersion,
    engineVersion,
    bumpVersionTs,
    bumpServerJson,
    bumpManifest,
    restampVerifiedOn,
    bumpCitation,
    bumpSecurityTable,
    bumpReadmeEngineBadge,
    bumpCurrentRelease,
    scaffoldFromTemplate,
    parseArgs,
    main,
    STAMPED_FILES,
    CURRENT_RELEASE_FILES,
} from '../../scripts/release-prepare.js';
import { STAMPED_FILES as VERIFY_DOCS_STAMPED_FILES } from '../../scripts/verify-docs.js';

// The pure half of scripts/release-prepare.ts: every edit is a targeted regex
// on the one field it owns, and these fixtures pin exactly which text each
// one may and may not touch. The last block runs main() against a sandbox
// tree under the OS temp directory (no git: --previous is passed) — never
// against the repository itself.

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('release-prepare: helpers', () => {
    it('accepts plain semver triples only', () => {
        expect(isSemver('1.0.0')).toBe(true);
        expect(isSemver('v1.0.0')).toBe(false);
        expect(isSemver('1.0')).toBe(false);
        expect(isSemver('1.0.0-rc.1')).toBe(false);
    });

    it('validates ISO dates and formats today in UTC', () => {
        expect(isIsoDate('2026-10-13')).toBe(true);
        expect(isIsoDate('13/10/2026')).toBe(false);
        expect(isIsoDate('2026-13-45')).toBe(false);
        expect(todayUtc(new Date(Date.UTC(2026, 9, 13, 23, 59)))).toBe('2026-10-13');
    });

    it('strips the tag prefix and derives the minor line', () => {
        expect(stripTag('v1.0.0')).toBe('1.0.0');
        expect(stripTag('1.0.0')).toBe('1.0.0');
        expect(minorLine('1.7.3')).toBe('1.7');
        expect(minorLine('2.0.0')).toBe('2.0');
    });
});

describe('release-prepare: package manifests', () => {
    const PKG = '{\n    "name": "zipnative-mcp",\n    "version": "1.0.0",\n    "keywords": [\n        "zipnative"\n    ],\n    "dependencies": {\n        "@modelcontextprotocol/server": "^2.3.1",\n        "zipnative": "^1.1.0",\n        "zod": "^4.6.5"\n    },\n    "devDependencies": {\n        "tsx": {\n            "version": "4.0.0"\n        }\n    }\n}\n';

    it('bumps the top-level version and nothing nested', () => {
        const r = bumpJsonVersion(PKG, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('    "version": "1.1.0",');
        expect(r.text).toContain('            "version": "4.0.0"');
        expect(r.text).not.toContain('"version": "1.0.0"');
    });

    it('reports matched=1 with unchanged text when already at the version', () => {
        const r = bumpJsonVersion(PKG.replace('"version": "1.0.0"', '"version": "1.1.0"'), '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toBe(PKG.replace('"version": "1.0.0"', '"version": "1.1.0"'));
    });

    it('reports matched=0 when there is no top-level version', () => {
        expect(bumpJsonVersion('{\n  "name": "x"\n}\n', '1.1.0').matched).toBe(0);
    });

    it('bumps the lockfile root and packages[""] but no dependency — at the four-space indent this repository uses', () => {
        const LOCK =
            '{\n    "name": "zipnative-mcp",\n    "version": "1.0.0",\n    "lockfileVersion": 3,\n    "packages": {\n        "": {\n            "name": "zipnative-mcp",\n            "version": "1.0.0",\n            "bin": {\n                "x": "y"\n            }\n        },\n        "node_modules/zipnative": {\n            "version": "1.0.0"\n        }\n    }\n}\n';
        const r = bumpLockVersion(LOCK, '1.1.0');
        expect(r.matched).toBe(2);
        expect(r.text.match(/"version": "1\.1\.0"/g)).toHaveLength(2);
        expect(r.text).toContain('"node_modules/zipnative": {\n            "version": "1.0.0"');
    });

    it('bumps a two-space lockfile the same way', () => {
        const LOCK = '{\n  "name": "zipnative-mcp",\n  "version": "1.0.0",\n  "packages": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n';
        const r = bumpLockVersion(LOCK, '1.1.0');
        expect(r.matched).toBe(2);
        expect(r.text.match(/"version": "1\.1\.0"/g)).toHaveLength(2);
    });

    it('reads the zipnative dependency floor as the engine version — never the keyword, never a devDependency', () => {
        expect(engineVersion(PKG)).toBe('1.1.0');
        expect(engineVersion(PKG.replace('^1.1.0', '~1.1.2'))).toBe('1.1.2');
        expect(engineVersion('{ "devDependencies": { "zipnative": "^1.0.0" } }')).toBeNull();
        expect(engineVersion('{ "dependencies": { "zipnative-mcp": "^1.0.0" } }')).toBeNull();
    });

    it('reads the real package.json engine floor', () => {
        expect(engineVersion(readFileSync(join(ROOT, 'package.json'), 'utf8'))).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

describe('release-prepare: the version lock-step', () => {
    it('bumps the version constant of src/version.ts and nothing else — TOOL_API_VERSION included', () => {
        const ts = "/** Kept in lock-step with package.json 1.0.0. */\nexport const ZIPNATIVE_MCP_VERSION = '1.0.0';\nexport const TOOL_API_VERSION = '1.0.0';\n";
        const r = bumpVersionTs(ts, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain("export const ZIPNATIVE_MCP_VERSION = '1.1.0';");
        expect(r.text).toContain("export const TOOL_API_VERSION = '1.0.0';");
        expect(r.text).toContain('package.json 1.0.0');
        expect(bumpVersionTs('export const OTHER = 1;', '1.1.0').matched).toBe(0);
    });

    it('matches the real src/version.ts', () => {
        expect(bumpVersionTs(readFileSync(join(ROOT, 'src', 'version.ts'), 'utf8'), '9.9.9').matched).toBe(1);
    });

    it('bumps both versions of server.json and leaves the schema date and the runtime hint alone', () => {
        const server =
            '{\n  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",\n  "name": "io.github.Nizoka/zipnative-mcp",\n  "version": "1.0.0",\n  "packages": [\n    {\n      "registryType": "npm",\n      "identifier": "zipnative-mcp",\n      "version": "1.0.0",\n      "runtimeHint": "npx"\n    }\n  ]\n}\n';
        const r = bumpServerJson(server, '1.1.0');
        expect(r.matched).toBe(2);
        expect(r.text.match(/"version": "1\.1\.0"/g)).toHaveLength(2);
        expect(r.text).toContain('schemas/2025-12-11/server.schema.json');
        expect(bumpServerJson('{ "name": "x" }', '1.1.0').matched).toBe(0);
    });

    it('finds exactly two versions in the real server.json', () => {
        expect(bumpServerJson(readFileSync(join(ROOT, 'server.json'), 'utf8'), '9.9.9').matched).toBe(2);
    });
});

describe('release-prepare: ecosystem manifest and stamps', () => {
    const MANIFEST =
        '{\n  "$comment": "x",\n  "verifiedOn": "2026-10-13",\n  "packages": {\n    "zipnative-mcp": {\n      "version": "1.0.0",\n      "pin": null\n    },\n    "zipnative": {\n      "version": "1.0.0"\n    }\n  }\n}\n';

    it('bumps only the zipnative-mcp package version and the verifiedOn date', () => {
        const r = bumpManifest(MANIFEST, '1.1.0', '2026-11-01');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('"verifiedOn": "2026-11-01"');
        expect(r.text).toContain('"zipnative-mcp": {\n      "version": "1.1.0"');
        expect(r.text).toContain('"zipnative": {\n      "version": "1.0.0"');
    });

    it('matches the real docs/assets/ecosystem.json', () => {
        expect(bumpManifest(readFileSync(join(ROOT, 'docs', 'assets', 'ecosystem.json'), 'utf8'), '9.9.9', '2099-01-01').matched).toBe(2);
    });

    it('re-stamps the prose and JSON forms of the verified-on marker', () => {
        const prose = restampVerifiedOn('_Verified on 2026-10-13 against the source tree._', '2026-11-01');
        expect(prose.matched).toBe(1);
        expect(prose.text).toBe('_Verified on 2026-11-01 against the source tree._');
        const json = restampVerifiedOn('{\n  "verifiedOn": "2026-10-13",\n  "x": 1\n}', '2026-11-01');
        expect(json.text).toContain('"verifiedOn": "2026-11-01"');
        expect(restampVerifiedOn('no stamp here', '2026-11-01').matched).toBe(0);
    });

    it('re-stamps exactly the files verify-docs holds to the manifest date', () => {
        expect([...STAMPED_FILES]).toEqual([...VERIFY_DOCS_STAMPED_FILES]);
    });
});

describe('release-prepare: CITATION.cff', () => {
    const CFF = 'cff-version: 1.2.0\ntitle: zipnative-mcp\nlicense: MIT\nversion: 1.0.0\nkeywords:\n  - zip\n';

    it('bumps version, never cff-version, and adds date-released when absent', () => {
        const r = bumpCitation(CFF, '1.1.0', '2026-11-01');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('cff-version: 1.2.0\n');
        expect(r.text).toContain('license: MIT\nversion: 1.1.0\ndate-released: 2026-11-01\nkeywords:');
    });

    it('rewrites an existing date-released in place, keeping its quoting style', () => {
        const quoted = bumpCitation(CFF.replace('version: 1.0.0\n', 'version: 1.0.0\ndate-released: "2026-09-07"\n'), '1.1.0', '2026-11-01');
        expect(quoted.matched).toBe(2);
        expect(quoted.text).toContain('version: 1.1.0\ndate-released: "2026-11-01"\n');
        expect(quoted.text.match(/date-released/g)).toHaveLength(1);
        const bare = bumpCitation(CFF.replace('version: 1.0.0\n', 'version: 1.0.0\ndate-released: 2026-09-07\n'), '1.1.0', '2026-11-01');
        expect(bare.text).toContain('date-released: 2026-11-01\n');
    });

    it('keeps CRLF line endings when it adds date-released', () => {
        const r = bumpCitation(CFF.replace(/\n/g, '\r\n'), '1.1.0', '2026-11-01');
        expect(r.text).toContain('version: 1.1.0\r\ndate-released: 2026-11-01\r\nkeywords:');
    });

    it('reports matched=0 on a file without a version key', () => {
        expect(bumpCitation('cff-version: 1.2.0\ntitle: x\n', '1.1.0', '2026-11-01').matched).toBe(0);
    });

    it('matches the real CITATION.cff (version and the quoted date-released)', () => {
        const r = bumpCitation(readFileSync(join(ROOT, 'CITATION.cff'), 'utf8'), '9.9.9', '2099-01-01');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('version: 9.9.9');
        expect(r.text).toContain('date-released: "2099-01-01"');
        expect(r.text).toContain('cff-version: 1.2.0');
    });
});

describe('release-prepare: SECURITY.md table', () => {
    const TABLE =
        '## Supported versions\n\n| Version | Supported |\n| ------- | --------- |\n| `1.0.x` | yes |\n| < 1.0 (never published to npm) | no |\n\n## Reporting a vulnerability\n';

    it('moves the supported line and the cut-off to the new minor', () => {
        const r = bumpSecurityTable(TABLE, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('| `1.1.x` | yes |\n| `< 1.1` | no |\n\n## Reporting');
        expect(r.text).not.toContain('1.0');
        expect(r.text).not.toContain('never published');
    });

    it('moves a table it already rewrote once (a second minor)', () => {
        const once = bumpSecurityTable(TABLE, '1.1.0').text;
        const twice = bumpSecurityTable(once, '2.0.0');
        expect(twice.matched).toBe(1);
        expect(twice.text).toContain('| `2.0.x` | yes |\n| `< 2.0` | no |');
    });

    it('leaves the table alone on a patch release', () => {
        const r = bumpSecurityTable(TABLE, '1.0.4');
        expect(r.matched).toBe(1);
        expect(r.text).toBe(TABLE);
    });

    it('keeps CRLF line endings', () => {
        const r = bumpSecurityTable(TABLE.replace(/\n/g, '\r\n'), '1.1.0');
        expect(r.text).toContain('| `1.1.x` | yes |\r\n| `< 1.1` | no |\r\n');
    });

    it('reports matched=0 when the table shape is unrecognised', () => {
        expect(bumpSecurityTable('| 1.0 | yes |\n', '1.1.0').matched).toBe(0);
        expect(bumpSecurityTable('| `1.0.x`  | :white_check_mark: |\n| `< 1.0`  | :x:                |\n', '1.1.0').matched).toBe(0);
    });

    it('matches the real SECURITY.md', () => {
        expect(bumpSecurityTable(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'), '9.9.0').matched).toBe(1);
    });
});

describe('release-prepare: README badge and Current-release prose', () => {
    it('moves the engine badge to the minor line of the dependency floor', () => {
        const readme = '[![zipnative](https://img.shields.io/badge/zipnative-1.0-2563EB.svg)](https://github.com/Nizoka/zipnative)\n[![MCP](https://img.shields.io/badge/MCP-2026--07--28-6f42c1.svg)](x)\n';
        const r = bumpReadmeEngineBadge(readme, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('badge/zipnative-1.1-2563EB.svg');
        expect(r.text).toContain('badge/MCP-2026--07--28-6f42c1.svg');
        expect(bumpReadmeEngineBadge('# nothing', '1.1.0').matched).toBe(0);
        // The badge is matched as a whole URL at a Markdown boundary: a look-alike under another host is left alone.
        expect(bumpReadmeEngineBadge('[![x](https://evil.example/img.shields.io/badge/zipnative-1.0-2563EB.svg)](x)\n', '1.1.0').matched).toBe(0);
        expect(bumpReadmeEngineBadge('see img.shields.io/badge/zipnative-1.0-2563EB.svg\n', '1.1.0').matched).toBe(0);
        expect(bumpReadmeEngineBadge('https://img.shields.io/badge/zipnative-1.0-2563EB.svg', '1.1.0').text).toBe('https://img.shields.io/badge/zipnative-1.1-2563EB.svg');
        // A badge for this server itself is not the engine badge.
        expect(bumpReadmeEngineBadge('https://img.shields.io/badge/zipnative--mcp-1.0-2563EB.svg', '1.1.0').matched).toBe(0);
    });

    it('matches the real README engine badge', () => {
        expect(bumpReadmeEngineBadge(readFileSync(join(ROOT, 'README.md'), 'utf8'), '9.9.0').matched).toBe(1);
    });

    it('bumps the Current release line, bold or plain, with or without the colon', () => {
        expect(bumpCurrentRelease('Current release: 1.0.0 (on zipnative 1.0.0)\n', '1.1.0').text).toBe('Current release: 1.1.0 (on zipnative 1.0.0)\n');
        expect(bumpCurrentRelease('Current release: **1.0.0** (on zipnative 1.0.0).', '1.1.0').text).toBe('Current release: **1.1.0** (on zipnative 1.0.0).');
        expect(bumpCurrentRelease('Current version: v1.0.0', '1.1.0').text).toBe('Current version: v1.1.0');
        expect(bumpCurrentRelease('the sandbox. Current release\n1.0.0. Three runtime', '1.1.0').text).toBe('the sandbox. Current release\n1.1.0. Three runtime');
        expect(bumpCurrentRelease('no line', '1.1.0').matched).toBe(0);
    });

    it('lists CLAUDE.md, whose Current release line is real', () => {
        expect(CURRENT_RELEASE_FILES).toContain('CLAUDE.md');
        expect(bumpCurrentRelease(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), '9.9.9').matched).toBe(1);
    });
});

describe('release-prepare: scaffolds', () => {
    const TEMPLATE = [
        '# Release Notes Template',
        '',
        '```markdown',
        '# zipnative-mcp vX.Y.Z',
        '',
        '_Released YYYY-MM-DD_',
        '',
        '**Built on:** zipnative vA.B.C',
        '',
        '## Install',
        '',
        '\\`\\`\\`bash',
        'npm install -g zipnative-mcp@X.Y.Z',
        '\\`\\`\\`',
        '',
        'Drop-in replacement for vX.Y.Z-1.',
        '- [Full diff](https://github.com/Nizoka/zipnative-mcp/compare/vX.Y.Z-1...vX.Y.Z)',
        '```',
        '',
        '## Conventions',
    ].join('\n');

    it('extracts the fenced block, resolves the placeholders and unescapes the fences', () => {
        const note = scaffoldFromTemplate(TEMPLATE, '1.1.0', '2026-11-01', 'v1.0.0');
        expect(note).toBe(
            [
                '# zipnative-mcp v1.1.0',
                '',
                '_Released 2026-11-01_',
                '',
                '**Built on:** zipnative vA.B.C',
                '',
                '## Install',
                '',
                '```bash',
                'npm install -g zipnative-mcp@1.1.0',
                '```',
                '',
                'Drop-in replacement for v1.0.0.',
                '- [Full diff](https://github.com/Nizoka/zipnative-mcp/compare/v1.0.0...v1.1.0)',
                '',
            ].join('\n'),
        );
    });

    it('refuses a template without a markdown block, naming it', () => {
        expect(() => scaffoldFromTemplate('# nothing here', '1.1.0', '2026-11-01', 'v1.0.0', 'release-notes/PR_TEMPLATE.md')).toThrow(/PR_TEMPLATE\.md has no/);
    });

    it('scaffolds from the real release-notes/TEMPLATE.md', () => {
        const note = scaffoldFromTemplate(readFileSync(join(ROOT, 'release-notes', 'TEMPLATE.md'), 'utf8'), '9.9.0', '2099-01-01', 'v9.8.0');
        expect(note).toMatch(/^# zipnative-mcp v9\.9\.0\n/);
        expect(note).not.toMatch(/X\.Y\.Z|YYYY-MM-DD/);
    });
});

describe('release-prepare: argument parsing', () => {
    it('requires --version and validates it', () => {
        expect(parseArgs([])).toMatch(/--version is required/);
        expect(parseArgs(['--version', '1.1'])).toMatch(/not a plain semver/);
        expect(parseArgs(['--version', 'v1.1.0'])).toMatch(/not a plain semver/);
    });

    it('defaults the date to today (UTC) and the previous tag to git', () => {
        const opts = parseArgs(['--version', '1.1.0']);
        expect(opts).toMatchObject({ version: '1.1.0', previous: null, dryRun: false });
        expect(typeof opts === 'string' ? '' : opts.date).toBe(todayUtc());
    });

    it('accepts explicit date, previous (with or without v) and --dry-run in either form', () => {
        expect(parseArgs(['--version=1.1.0', '--date=2026-11-01', '--previous=1.0.0', '--dry-run'])).toEqual({
            version: '1.1.0',
            date: '2026-11-01',
            previous: 'v1.0.0',
            dryRun: true,
        });
        expect(parseArgs(['--version', '1.1.0', '--previous', 'v1.0.0'])).toMatchObject({ previous: 'v1.0.0' });
    });

    it('rejects bad dates, bad tags, unknown flags and a flag with no value', () => {
        expect(parseArgs(['--version', '1.1.0', '--date', '01/11/2026'])).toMatch(/not an ISO date/);
        expect(parseArgs(['--version', '1.1.0', '--previous', 'latest'])).toMatch(/not a tag/);
        expect(parseArgs(['--version', '1.1.0', '--force'])).toMatch(/unknown argument "--force"/);
        expect(parseArgs(['--version'])).toMatch(/--version is required/);
    });
});

describe('release-prepare: main() over a sandbox tree', () => {
    let sandbox = '';
    let out: MockInstance<typeof process.stdout.write>;
    beforeEach(() => {
        // main() reports every edit on stdout; the assertions read the files and the captured lines.
        out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        if (sandbox) rmSync(sandbox, { recursive: true, force: true });
        sandbox = '';
    });

    const printed = (): string => out.mock.calls.map((c) => String(c[0])).join('');
    const TEMPLATE = '# T\n\n```markdown\n# zipnative-mcp vX.Y.Z\n\n_Released YYYY-MM-DD_ — after vX.Y.Z-1\n```\n';

    function seed(full: boolean): string {
        const root = mkdtempSync(join(tmpdir(), 'zipnative-mcp-release-'));
        const put = (rel: string, text: string): void => {
            mkdirSync(join(root, rel, '..'), { recursive: true });
            writeFileSync(join(root, rel), text);
        };
        put('package.json', '{\n    "name": "zipnative-mcp",\n    "version": "1.0.0",\n    "dependencies": {\n        "zipnative": "^1.1.0"\n    }\n}\n');
        put('package-lock.json', '{\n    "name": "zipnative-mcp",\n    "version": "1.0.0",\n    "packages": {\n        "": {\n            "version": "1.0.0"\n        }\n    }\n}\n');
        put('src/version.ts', "export const ZIPNATIVE_MCP_VERSION = '1.0.0';\nexport const TOOL_API_VERSION = '1.0.0';\n");
        put('server.json', '{\n  "version": "1.0.0",\n  "packages": [\n    {\n      "version": "1.0.0"\n    }\n  ]\n}\n');
        if (!full) return root;
        put('docs/assets/ecosystem.json', '{\n  "verifiedOn": "2026-10-13",\n  "packages": {\n    "zipnative-mcp": {\n      "version": "1.0.0"\n    }\n  }\n}\n');
        put('llms.txt', '# zipnative-mcp\n\nCurrent release: 1.0.0. Verified on 2026-10-13.\n');
        put('docs/KNOWLEDGE_BASE.md', '# KB\n\nVerified on 2026-10-13.\n');
        put('docs/AGENT_CONTRACT.md', '# Contract\n\nVerified on 2026-10-13.\n');
        put('CLAUDE.md', '# CLAUDE.md\n\npath exists. Current release: **1.0.0** (on zipnative 1.0.0).\n');
        put('AGENTS.md', '# Agents\n\nNo release line here.\n');
        put('.github/copilot-instructions.md', 'over the sandbox. Current release\n1.0.0. Three runtime dependencies.\n');
        put('CITATION.cff', 'cff-version: 1.2.0\nversion: 1.0.0\ndate-released: "2026-09-07"\n');
        put('SECURITY.md', '| Version | Supported |\n| ------- | --------- |\n| `1.0.x` | yes |\n| < 1.0 (never published to npm) | no |\n');
        put('README.md', '[![zipnative](https://img.shields.io/badge/zipnative-1.0-2563EB.svg)](x)\n');
        put('release-notes/TEMPLATE.md', TEMPLATE);
        put('release-notes/PR_TEMPLATE.md', TEMPLATE.replace('# zipnative-mcp vX.Y.Z', '# PR: vX.Y.Z'));
        // The governance issue template: never the PR draft's source.
        put('.github/drafts/TEMPLATE.md', '# <type>: <title>\n\n## Problem\n');
        return root;
    }

    it('applies every edit and scaffolds the note and the PR draft', () => {
        sandbox = seed(true);
        expect(main(['--version', '1.1.0', '--date', '2026-11-01', '--previous', 'v1.0.0'], sandbox)).toBe(0);
        const read = (rel: string): string => readFileSync(join(sandbox, rel), 'utf8');
        expect(read('package.json')).toContain('"version": "1.1.0"');
        expect(read('package-lock.json').match(/"version": "1\.1\.0"/g)).toHaveLength(2);
        expect(read('src/version.ts')).toContain("ZIPNATIVE_MCP_VERSION = '1.1.0'");
        expect(read('src/version.ts')).toContain("TOOL_API_VERSION = '1.0.0'");
        expect(read('server.json').match(/"version": "1\.1\.0"/g)).toHaveLength(2);
        expect(read('docs/assets/ecosystem.json')).toContain('"verifiedOn": "2026-11-01"');
        for (const file of STAMPED_FILES) expect(read(file), file).toContain('Verified on 2026-11-01');
        expect(read('llms.txt')).toContain('Current release: 1.1.0');
        expect(read('CLAUDE.md')).toContain('Current release: **1.1.0** (on zipnative 1.0.0)');
        expect(read('.github/copilot-instructions.md')).toContain('Current release\n1.1.0.');
        expect(read('AGENTS.md')).toBe('# Agents\n\nNo release line here.\n');
        expect(read('CITATION.cff')).toContain('version: 1.1.0\ndate-released: "2026-11-01"');
        expect(read('SECURITY.md')).toContain('| `1.1.x` | yes |\n| `< 1.1` | no |');
        expect(read('README.md')).toContain('badge/zipnative-1.1-');
        expect(read('release-notes/v1.1.0.md')).toBe('# zipnative-mcp v1.1.0\n\n_Released 2026-11-01_ — after v1.0.0\n');
        expect(read('.github/drafts/pr-v1.1.0.md')).toContain('# PR: v1.1.0');
        expect(printed()).toContain('AGENTS.md — no Current release 1.1.0 (skipped)');
    });

    it('skips the files that are not present yet instead of failing', () => {
        sandbox = seed(false);
        expect(main(['--version', '1.1.0', '--date', '2026-11-01', '--previous', 'v1.0.0'], sandbox)).toBe(0);
        const lines = printed();
        expect(lines).toContain('CITATION.cff — not present (skipped)');
        expect(lines).toContain('release-notes/TEMPLATE.md — not present (skipped)');
        expect(lines).toContain('release-notes/PR_TEMPLATE.md — not present (skipped)');
        expect(lines).toMatch(/\d+ files or fields not present yet/);
        expect(existsSync(join(sandbox, 'release-notes'))).toBe(false);
        expect(readFileSync(join(sandbox, 'server.json'), 'utf8').match(/"version": "1\.1\.0"/g)).toHaveLength(2);
    });

    it('writes nothing under --dry-run, and is idempotent on a second real run', () => {
        sandbox = seed(true);
        const before = readFileSync(join(sandbox, 'package.json'), 'utf8');
        expect(main(['--version', '1.1.0', '--date', '2026-11-01', '--previous', 'v1.0.0', '--dry-run'], sandbox)).toBe(0);
        expect(readFileSync(join(sandbox, 'package.json'), 'utf8')).toBe(before);
        expect(existsSync(join(sandbox, 'release-notes', 'v1.1.0.md'))).toBe(false);
        expect(main(['--version', '1.1.0', '--date', '2026-11-01', '--previous', 'v1.0.0'], sandbox)).toBe(0);
        const after = readFileSync(join(sandbox, 'server.json'), 'utf8');
        const note = readFileSync(join(sandbox, 'release-notes', 'v1.1.0.md'), 'utf8');
        writeFileSync(join(sandbox, 'release-notes', 'v1.1.0.md'), `${note}hand-written\n`);
        expect(main(['--version', '1.1.0', '--date', '2026-11-01', '--previous', 'v1.0.0'], sandbox)).toBe(0);
        expect(readFileSync(join(sandbox, 'server.json'), 'utf8')).toBe(after);
        expect(readFileSync(join(sandbox, 'release-notes', 'v1.1.0.md'), 'utf8')).toContain('hand-written');
        expect(printed()).toContain('already current');
    });

    it('returns 1 when a present file lacks its pattern or a template its markdown block, and 2 on bad usage', () => {
        sandbox = seed(true);
        writeFileSync(join(sandbox, 'CITATION.cff'), 'cff-version: 1.2.0\ntitle: x\n');
        expect(main(['--version', '1.1.0', '--previous', 'v1.0.0'], sandbox)).toBe(1);
        expect(printed()).toContain('CITATION.cff — version + date-released');

        rmSync(sandbox, { recursive: true, force: true });
        sandbox = seed(true);
        writeFileSync(join(sandbox, 'release-notes', 'PR_TEMPLATE.md'), '# no block\n');
        expect(main(['--version', '1.1.0', '--previous', 'v1.0.0'], sandbox)).toBe(1);
        expect(printed()).toMatch(/pr-v1\.1\.0\.md — release-notes\/PR_TEMPLATE\.md has no/);
        expect(existsSync(join(sandbox, '.github', 'drafts', 'pr-v1.1.0.md'))).toBe(false);

        expect(main(['--version', 'nope'], sandbox)).toBe(2);
    });
});

describe('release-prepare: wiring', () => {
    it('package.json routes release:prepare to the script', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts['release:prepare']).toBe('npx tsx scripts/release-prepare.ts');
    });
});
