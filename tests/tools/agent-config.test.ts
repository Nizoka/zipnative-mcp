import { describe, it, expect } from 'vitest';

import {
    CLAUDE_CONTEXT_BUDGET,
    EOL_LF_MODE,
    GUARDED_SHELL_TOOLS,
    HITL_BASH_DENY_FAMILIES,
    PR_TEMPLATE,
    bannerFor,
    checkAgentConfigParity,
    checkClaudeRulesBudget,
    checkEol,
    checkNodeVersionPin,
    checkPrTemplateParity,
    checkSkillShape,
    checkTagRuleset,
    checklistItems,
    claudeImports,
    crlfTextFiles,
    denyEntryFor,
    diffRules,
    markdownSection,
    neverReadGlobs,
    parseInstruction,
    parseLsFilesEol,
    renderRule,
    ruleHasPaths,
    ruleNameFor,
    skillFileReferences,
    type SkillInput,
} from '../../scripts/lib/agent-config.js';

/**
 * The pure functions of `scripts/lib/agent-config.ts` behind the verify-docs
 * rules `agent-config-parity`, `claude-rules-sync`, `claude-rules-budget`,
 * `pr-template-parity`, `eol-lf`, `skills-shape` and the `.node-version` /
 * `tags.json` extensions (ported from pkinative-mcp 1.0.0). Every input is
 * an inline fixture: the committed agent files are held by verify-docs
 * itself, not here.
 */

const INSTRUCTION = `---\r\ndescription: "Tool rules"\r\napplyTo: "src/tools/**,src/server.ts"\r\n---\r\n# Tools\r\n\r\n- One file per tool.\r\n`;

const SHELLS = ['Bash', 'PowerShell'] as const;
const DENY_PATTERNS: Readonly<Record<string, string>> = {
    'git push': 'git push *',
    'npm publish': 'npm publish*',
    'npm unpublish': 'npm unpublish*',
    'npm dist-tag': 'npm dist-tag*',
    'npm deprecate': 'npm deprecate*',
    'gh pr create': 'gh pr create*',
    'gh pr edit': 'gh pr edit*',
    'gh pr merge': 'gh pr merge*',
    'gh pr close': 'gh pr close*',
    'gh pr comment': 'gh pr comment*',
    'gh issue create': 'gh issue create*',
    'gh issue edit': 'gh issue edit*',
    'gh issue close': 'gh issue close*',
    'gh issue comment': 'gh issue comment*',
    'gh release': 'gh release *',
};

const SETTINGS = JSON.stringify({
    attribution: { commit: '' },
    permissions: {
        deny: [
            'Read(test-output/**)',
            'Read(coverage/**)',
            'Read(package-lock.json)',
            ...SHELLS.flatMap((shell) => Object.values(DENY_PATTERNS).map((p) => `${shell}(${p})`)),
        ],
    },
    hooks: {
        PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] },
            { matcher: 'PowerShell', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] },
        ],
    },
});

const CLAUDE_MD = `@AGENTS.md\n\n## Token discipline\n\n- Never Read \`test-output/\`, \`coverage/\`, \`package-lock.json\`.\n  The deny list in \`.claude/settings.json\` applies to Read.\n- Other bullet \`server.json\`.\n`;

const HOOK_OK = { exists: true, checkStatus: 0, checkStderr: '' };

describe('agent-config — generated Claude rules', () => {
    it('parses applyTo (comma-separated, quoted, CRLF) and strips the frontmatter from the body', () => {
        const parsed = parseInstruction(INSTRUCTION);
        expect(parsed).toMatchObject({ applyTo: ['src/tools/**', 'src/server.ts'], description: 'Tool rules' });
        if ('error' in parsed) throw new Error(parsed.error);
        expect(parsed.body.startsWith('# Tools')).toBe(true);
        expect(parsed.body).not.toContain('\r');
    });

    it('refuses a source without applyTo or without frontmatter', () => {
        expect(parseInstruction('---\ndescription: x\n---\nbody')).toHaveProperty('error', expect.stringContaining('applyTo'));
        expect(parseInstruction('# no frontmatter')).toHaveProperty('error', expect.stringContaining('frontmatter'));
    });

    it('renders a scoped rule with the banner, LF endings and one trailing newline', () => {
        const rendered = renderRule('tools.instructions.md', INSTRUCTION);
        expect(typeof rendered).toBe('string');
        expect(rendered).toBe(`---\npaths:\n  - "src/tools/**"\n  - "src/server.ts"\n---\n${bannerFor('tools.instructions.md')}\n\n# Tools\n\n- One file per tool.\n`);
        expect(ruleHasPaths(rendered as string)).toBe(true);
        expect(ruleNameFor('tools.instructions.md')).toBe('tools.md');
    });

    it('diffRules reports stale, missing, extra and invalid, and is clean on a fresh render', () => {
        const fresh = renderRule('tools.instructions.md', INSTRUCTION) as string;
        const clean = diffRules({ 'tools.instructions.md': INSTRUCTION }, { 'tools.md': fresh });
        expect(clean).toMatchObject({ stale: [], missing: [], extra: [], invalid: [] });
        // CRLF in the working copy is not drift (eol-lf owns line endings).
        expect(diffRules({ 'tools.instructions.md': INSTRUCTION }, { 'tools.md': fresh.replace(/\n/g, '\r\n') }).stale).toEqual([]);
        const drift = diffRules(
            { 'tools.instructions.md': INSTRUCTION, 'testing.instructions.md': INSTRUCTION, 'bad.instructions.md': '# nope' },
            { 'tools.md': `${fresh}\nedited by hand\n`, 'orphan.md': '---\npaths:\n  - "x"\n---\n' },
        );
        expect(drift.stale).toEqual(['tools.md']);
        expect(drift.missing).toEqual(['testing.md']);
        expect(drift.extra).toEqual(['orphan.md']);
        expect(drift.invalid).toEqual([{ source: 'bad.instructions.md', error: expect.stringContaining('frontmatter') }]);
    });

    it('ruleHasPaths is false for an unscoped rule', () => {
        expect(ruleHasPaths('---\ndescription: x\n---\nbody')).toBe(false);
        expect(ruleHasPaths('no frontmatter')).toBe(false);
    });

    it('reads a YAML-list applyTo continuation as the same key', () => {
        const parsed = parseInstruction('---\napplyTo:\n  - "src/**"\n  - "tests/**"\n---\nbody\n');
        expect(parsed).toMatchObject({ applyTo: ['src/**', 'tests/**'] });
    });
});

describe('agent-config — agent-config-parity', () => {
    it('derives the Never Read globs from the CLAUDE.md bullet and maps them to deny entries', () => {
        expect(neverReadGlobs(CLAUDE_MD)).toEqual(['test-output/', 'coverage/', 'package-lock.json']);
        expect(denyEntryFor('coverage/')).toBe('Read(coverage/**)');
        expect(denyEntryFor('tests/_fixtures/tool-shape*.json')).toBe('Read(tests/_fixtures/tool-shape*.json)');
        expect(neverReadGlobs('# nothing')).toEqual([]);
    });

    it('passes a consistent settings / CLAUDE.md / hook triple', () => {
        expect(checkAgentConfigParity({ settingsText: SETTINGS, claudeMd: CLAUDE_MD, hook: HOOK_OK })).toEqual([]);
    });

    it('fails when a Never Read glob has no deny entry', () => {
        const settings = SETTINGS.replace('"Read(coverage/**)",', '');
        const findings = checkAgentConfigParity({ settingsText: settings, claudeMd: CLAUDE_MD, hook: HOOK_OK });
        expect(findings.map((f) => f.message)).toEqual([expect.stringContaining('Read(coverage/**)')]);
    });

    it('holds every HITL family — registry, remote, tag and GitHub writes — on both shell tools', () => {
        expect(GUARDED_SHELL_TOOLS).toEqual(['Bash', 'PowerShell']);
        expect([...HITL_BASH_DENY_FAMILIES].sort()).toEqual(Object.keys(DENY_PATTERNS).sort());
        for (const shell of SHELLS) {
            for (const [family, pattern] of Object.entries(DENY_PATTERNS)) {
                const without = SETTINGS.replace(`"${shell}(${pattern})"`, `"${shell}(git fetch *)"`);
                expect(checkAgentConfigParity({ settingsText: without, claudeMd: CLAUDE_MD, hook: HOOK_OK }).map((f) => f.message), `${shell}(${family})`)
                    .toEqual([expect.stringContaining(`${shell}(${family}`)]);
            }
        }
        const bashOnly = SETTINGS.replace('"matcher":"PowerShell"', '"matcher":"Pwsh"');
        expect(checkAgentConfigParity({ settingsText: bashOnly, claudeMd: CLAUDE_MD, hook: HOOK_OK }).map((f) => f.message)).toEqual([expect.stringContaining('no PowerShell matcher')]);
    });

    it('fails on a non-empty attribution, an unwired hook, a broken hook, a missing hook and invalid JSON', () => {
        const trailer = SETTINGS.replace('"commit":""', '"commit":"Co-Authored-By: x"');
        expect(checkAgentConfigParity({ settingsText: trailer, claudeMd: CLAUDE_MD, hook: HOOK_OK }).map((f) => f.message)).toEqual([expect.stringContaining('attribution.commit')]);
        const unwired = SETTINGS.replace('guard.mjs', 'other.mjs');
        expect(checkAgentConfigParity({ settingsText: unwired, claudeMd: CLAUDE_MD, hook: HOOK_OK }).map((f) => f.message)).toEqual([expect.stringContaining('no Bash matcher')]);
        const broken = checkAgentConfigParity({ settingsText: SETTINGS, claudeMd: CLAUDE_MD, hook: { exists: true, checkStatus: 1, checkStderr: 'SyntaxError: x\n' } });
        expect(broken).toEqual([expect.objectContaining({ file: '.claude/hooks/guard.mjs', message: expect.stringContaining('SyntaxError') })]);
        expect(checkAgentConfigParity({ settingsText: SETTINGS, claudeMd: CLAUDE_MD, hook: { exists: false, checkStatus: null, checkStderr: '' } })[0]!.message).toContain('missing');
        expect(checkAgentConfigParity({ settingsText: '{', claudeMd: CLAUDE_MD, hook: HOOK_OK })[0]!.message).toContain('not valid JSON');
        expect(checkAgentConfigParity({ settingsText: null, claudeMd: CLAUDE_MD, hook: HOOK_OK })[0]!.message).toContain('missing');
    });
});

describe('agent-config — claude-rules-budget', () => {
    const scoped = '---\npaths:\n  - "src/**"\n---\nbody\n';
    it('sums CLAUDE.md, its @imports and unscoped rules against the 16 KiB budget', () => {
        expect(claudeImports(CLAUDE_MD)).toEqual(['AGENTS.md']);
        expect(checkClaudeRulesBudget({ claudeMd: CLAUDE_MD, resolveImport: () => 'x'.repeat(1000), rules: { 'a.md': scoped } })).toEqual([]);
        const over = checkClaudeRulesBudget({ claudeMd: CLAUDE_MD, resolveImport: () => 'x'.repeat(CLAUDE_CONTEXT_BUDGET), rules: {} });
        expect(over).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('always loaded') })]);
    });

    it('fails an unscoped rule and a missing import; warns on a scoped rule over 32 KiB', () => {
        const unscoped = checkClaudeRulesBudget({ claudeMd: CLAUDE_MD, resolveImport: () => '', rules: { 'free.md': '---\ndescription: x\n---\nbody' } });
        expect(unscoped).toEqual([expect.objectContaining({ file: '.claude/rules/free.md', severity: 'error', message: expect.stringContaining('paths') })]);
        expect(checkClaudeRulesBudget({ claudeMd: CLAUDE_MD, resolveImport: () => null, rules: {} })[0]!.message).toContain('@AGENTS.md');
        const big = checkClaudeRulesBudget({ claudeMd: CLAUDE_MD, resolveImport: () => '', rules: { 'big.md': `${scoped}${'y'.repeat(33 * 1024)}` } });
        expect(big).toEqual([expect.objectContaining({ severity: 'warn', file: '.claude/rules/big.md' })]);
    });
});

describe('agent-config — pr-template-parity', () => {
    const CONTRIBUTING = '# C\n\n## Pull Request Checklist\n\n- [ ] `npm run gate` passes\n- [ ] New code has tests\n\n## Commit Messages\n\n- [ ] not a checklist item of the section\n';
    it('extracts checklist items and sections', () => {
        expect(checklistItems('- [ ] a\n- [x] b\n- c\n')).toEqual(['a', 'b']);
        expect(markdownSection(CONTRIBUTING, 'Pull Request Checklist')).toContain('New code has tests');
        expect(markdownSection(CONTRIBUTING, 'Pull Request Checklist')).not.toContain('not a checklist item');
        expect(markdownSection(CONTRIBUTING, 'Nope')).toBeNull();
    });

    it('passes a template whose items are verbatim and mention the gate', () => {
        expect(checkPrTemplateParity('## Checklist\n\n- [ ] `npm run gate` passes\n- [ ] New code has tests\n', CONTRIBUTING)).toEqual([]);
    });

    it('tolerates re-pointed link targets (the template lives in .github/) but not reworded link text', () => {
        const contributing = '## Pull Request Checklist\n\n- [ ] `npm run gate` passes — see [Release](#release)\n';
        expect(checklistItems(contributing)).toEqual(['`npm run gate` passes — see [Release]']);
        expect(checkPrTemplateParity('- [ ] `npm run gate` passes — see [Release](../CONTRIBUTING.md#release)\n', contributing)).toEqual([]);
        expect(checkPrTemplateParity('- [ ] `npm run gate` passes — see [Releasing](../CONTRIBUTING.md#release)\n', contributing)).toHaveLength(1);
    });

    it('fails a reworded item, a template without the gate, a missing template and a missing section', () => {
        const reworded = checkPrTemplateParity('- [ ] `npm run gate` passes\n- [ ] New code has unit tests\n', CONTRIBUTING);
        expect(reworded).toEqual([expect.objectContaining({ line: 2, message: expect.stringContaining('New code has unit tests') })]);
        expect(checkPrTemplateParity('- [ ] New code has tests\n', CONTRIBUTING).map((f) => f.message)).toEqual([expect.stringContaining('npm run gate')]);
        expect(checkPrTemplateParity(null, CONTRIBUTING)[0]).toMatchObject({ file: PR_TEMPLATE, message: expect.stringContaining('missing') });
        expect(checkPrTemplateParity('- [ ] x', '# no section')[0]!.file).toBe('CONTRIBUTING.md');
    });

    it('drops the gate requirement when the repository names no gate command, and reports under the given file name', () => {
        expect(checkPrTemplateParity('- [ ] New code has tests\n', CONTRIBUTING, null)).toEqual([]);
        expect(checkPrTemplateParity('- [ ] New code has tests\n', CONTRIBUTING, 'npm test', '.github/pull_request_template.md')).toEqual([
            expect.objectContaining({ file: '.github/pull_request_template.md', message: expect.stringContaining('npm test') }),
        ]);
    });
});

describe('agent-config — eol-lf', () => {
    const LS = [
        'i/lf    w/lf    attr/text=auto eol=lf     \tsrc/index.ts',
        'i/crlf  w/crlf  attr/text=auto eol=lf     \tCHANGELOG.md',
        'i/mixed w/mixed attr/text=auto eol=lf     \tdocs/x.md',
        'i/crlf  w/crlf  attr/-text linguist-vendored=true\tscripts/data/Blocks.txt',
        'i/-text w/-text attr/-text -diff -merge   \ttests/fixtures/interop/bsdtar.zip',
        'i/crlf  w/crlf  attr/binary                \tweird.bin',
        'i/none  w/none  attr/text=auto eol=lf     \tempty.txt',
    ].join('\n');

    it('parses the ls-files table and keeps only CRLF/mixed text blobs', () => {
        expect(parseLsFilesEol(LS)).toHaveLength(7);
        expect(crlfTextFiles(parseLsFilesEol(LS)).map((e) => e.path)).toEqual(['CHANGELOG.md', 'docs/x.md']);
    });

    it('fails on a CRLF blob; the warn mode stays available', () => {
        expect(EOL_LF_MODE).toBe('fail');
        expect(checkEol(LS).map((f) => f.severity)).toEqual(['error', 'error']);
        expect(checkEol(LS, 'warn').map((f) => f.severity)).toEqual(['warn', 'warn']);
        expect(checkEol(LS)[0]).toMatchObject({ file: 'CHANGELOG.md', message: expect.stringContaining('CRLF') });
        expect(checkEol('')).toEqual([]);
    });
});

describe('agent-config — node-pin-parity (.node-version)', () => {
    it('passes when the pin equals the engines major and the CI floor', () => {
        expect(checkNodeVersionPin({ nodeVersion: '22\n', enginesNode: '>=22', ciMatrix: [22, 24] })).toEqual([]);
    });

    it('fails a missing file, a disagreeing major, a higher CI floor and a non-version', () => {
        expect(checkNodeVersionPin({ nodeVersion: null, enginesNode: '>=22', ciMatrix: [22] })[0]!.message).toContain('missing');
        expect(checkNodeVersionPin({ nodeVersion: '20\n', enginesNode: '>=22', ciMatrix: [22] }).map((f) => f.message)).toEqual([
            expect.stringContaining('engines.node'),
            expect.stringContaining('lowest CI matrix'),
        ]);
        expect(checkNodeVersionPin({ nodeVersion: 'lts/iron\n', enginesNode: '>=22', ciMatrix: [] })[0]!.message).toContain('not a Node version');
        expect(checkNodeVersionPin({ nodeVersion: '22', enginesNode: '>=22', ciMatrix: [] })).toEqual([expect.objectContaining({ severity: 'warn', message: expect.stringContaining('trailing newline') })]);
    });
});

describe('agent-config — ruleset-parity (tags.json)', () => {
    const TAGS = { name: 'tags', target: 'tag', conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }] };
    it('passes a tag ruleset that protects refs/tags/v* against deletion, force and update', () => {
        expect(checkTagRuleset(JSON.stringify(TAGS))).toEqual([]);
    });

    it('fails a missing file, invalid JSON, a branch target, a missing include, a missing rule and a creation rule', () => {
        expect(checkTagRuleset(null)[0]!.message).toContain('missing');
        expect(checkTagRuleset('{')[0]!.message).toContain('not valid JSON');
        expect(checkTagRuleset(JSON.stringify({ ...TAGS, target: 'branch' })).map((f) => f.message)).toEqual([expect.stringContaining('"tag"')]);
        expect(checkTagRuleset(JSON.stringify({ ...TAGS, conditions: { ref_name: { include: ['~ALL'] } } })).map((f) => f.message)).toEqual([expect.stringContaining('refs/tags/v*')]);
        expect(checkTagRuleset(JSON.stringify({ ...TAGS, rules: [{ type: 'deletion' }] })).map((f) => f.message)).toEqual([
            expect.stringContaining('non_fast_forward'),
            expect.stringContaining('"update"'),
        ]);
        expect(checkTagRuleset(JSON.stringify({ ...TAGS, rules: [...TAGS.rules, { type: 'creation' }] })).map((f) => f.message)).toEqual([expect.stringContaining('creation')]);
    });
});

describe('agent-config — skills-shape', () => {
    const SKILL = '---\nname: release-audit\ndescription: Audit a release.\ndisable-model-invocation: true\n---\n# Audit\n\nRead `ledger.md` and `docs/data/core-exports.json`; drive `tests/fixtures/interop/bsdtar.zip`; write under `.audit/<version>/`; the note is `release-notes/vX.Y.Z.md`.\n';
    const files = new Set(['ledger.md']);
    const repo = new Set(['docs/data/core-exports.json', 'tests/fixtures/interop/bsdtar.zip']);
    const input = (overrides: Partial<SkillInput> = {}): SkillInput => ({
        dir: 'release-audit',
        text: SKILL,
        existsInSkill: (n: string) => files.has(n),
        existsInRepo: (p: string) => repo.has(p),
        ...overrides,
    });

    it('collects sibling and repository references and skips placeholders', () => {
        expect(skillFileReferences(SKILL)).toEqual({ siblings: ['ledger.md'], repo: ['docs/data/core-exports.json', 'tests/fixtures/interop/bsdtar.zip'] });
    });

    it('passes a well-formed skill', () => {
        expect(checkSkillShape(input())).toEqual([]);
    });

    it('fails a name that differs from the directory, a missing description, a missing template and a missing SKILL.md', () => {
        expect(checkSkillShape(input({ dir: 'audit' })).map((f) => f.message)).toEqual([expect.stringContaining('"audit"')]);
        expect(checkSkillShape(input({ text: SKILL.replace('description: Audit a release.', 'description:') })).map((f) => f.message)).toEqual([expect.stringContaining('description')]);
        expect(checkSkillShape(input({ existsInSkill: () => false })).map((f) => f.message)).toEqual([expect.stringContaining('ledger.md')]);
        expect(checkSkillShape(input({ existsInRepo: () => false })).map((f) => f.message)).toEqual([expect.stringContaining('core-exports.json'), expect.stringContaining('bsdtar.zip')]);
        expect(checkSkillShape(input({ text: null }))[0]!.message).toContain('missing');
        expect(checkSkillShape(input({ text: '# no frontmatter' }))[0]!.message).toContain('frontmatter');
    });
});
