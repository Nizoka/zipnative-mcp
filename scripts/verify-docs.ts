#!/usr/bin/env tsx
/**
 * zipnative-mcp — documentation consistency verifier (ported from pkinative-mcp 1.0.0 / pdfnative-mcp 1.7.0)
 * ======================================================================================================
 * Every version string, tool count, error-code list and operator variable
 * quoted in the docs is hand-copied across a dozen files — README, the
 * agent contract, the knowledge base, llms.txt, AGENTS.md, the Copilot
 * instructions, SECURITY.md — and nothing checks them unless a script does.
 *
 * This script makes `docs/assets/ecosystem.json` the single source of truth
 * for every count and version, derives the counts it CAN derive from the
 * files the server is built from (`scripts/lib/mcp-surface.ts`), and fails
 * the build when any documentation file disagrees. Three rules are specific
 * to a ZIP server: `engine-data-parity` (the docs/data/ registries pin the
 * installed zipnative and carry its vocabulary), `verazip-counts` (the
 * conformance declaration equals the corpus definition, and every corpus
 * figure the documents quote equals it) and `no-secret-material` (no
 * document carries a test token, a concrete bearer token, a credential or a
 * development-host path).
 *
 * Usage:
 *   npx tsx scripts/verify-docs.ts                  # offline, hermetic — safe in CI
 *   npx tsx scripts/verify-docs.ts --rules          # list the rules, one line each
 *   npx tsx scripts/verify-docs.ts --only tool-parity   # one rule's findings
 *   npx tsx scripts/verify-docs.ts --json           # machine-readable, for CI annotations
 *   npx tsx scripts/verify-docs.ts --verbose        # the grouped table even when not a TTY
 *   npx tsx scripts/verify-docs.ts --online         # also compare against the npm registry (npm-drift)
 *   npx tsx scripts/verify-docs.ts --strict         # (--online) docs behind npm is an error
 *   npx tsx scripts/verify-docs.ts --require-all    # a document not present yet is an error, not a skip
 *
 * (PowerShell swallows a bare `--` after `npm run`, so call the script
 * directly when passing flags.)
 *
 * Exit codes:
 *   0 — every rule passes (a document not present yet is reported as a skip, with its reason).
 *   1 — at least one rule failed; each problem is printed as `path:line [rule] message`.
 *   2 — usage: an unknown flag, or `--only` naming no rule.
 *
 * The script never writes. It is safe to run against a dirty tree. A line
 * that legitimately quotes a superseded figure (historical prose) opts out
 * with `verify-docs:allow <rule>` on itself or on the line above.
 *
 * `verifyDocs(root)` is exported and covered by tests/tools/verify-docs.test.ts;
 * only `main()` prints and exits.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findNonEnglishProse } from './lib/prose-language.js';
import {
    INSTRUCTIONS_DIR,
    PR_TEMPLATE,
    RULES_DIR,
    checkAgentConfigParity,
    checkClaudeRulesBudget,
    checkEol,
    checkNodeVersionPin,
    checkPrTemplateParity,
    checkSkillShape,
    checkTagRuleset,
    type Finding,
} from './lib/agent-config.js';
import { diffClaudeRules, readRuleFiles } from './build-claude-rules.js';
import {
    NON_OPERATOR_ENV_TOKENS,
    checkChangelogLadder,
    computeDerived,
    contractCatalogueTools,
    contractErrorRows,
    corpusFigures,
    envVarTokens,
    errorCodes,
    promptNames,
    serverJsonEnvVars,
    snakeTokens,
    sourceEnvVars,
    toolNameConstant,
    toolNames,
    wrapperCodes,
    zipDiagnosticCodes,
    zipErrorCodes,
} from './lib/mcp-surface.js';
import { markdownAnchors, fragmentLinks } from './lib/markdown-anchors.js';
import { buildSecretNeedles, findSecretMaterial } from './lib/secret-needles.js';

// ── Types ───────────────────────────────────────────────────────────

export interface Problem {
    readonly file: string;
    readonly line: number;
    readonly rule: string;
    readonly message: string;
    readonly severity: 'error' | 'warn';
}

/** A check that could not run because its input is not present yet (never an error unless --require-all). */
export interface Skip {
    readonly file: string;
    readonly rule: string;
    readonly message: string;
}

export interface VerifyOptions {
    /** Also compare the manifest with the npm registry (network). */
    readonly online?: boolean;
    /** Under --online, docs behind npm is an error rather than a warning. */
    readonly strict?: boolean;
    /** A document not present yet is an error rather than a skip (the release condition). */
    readonly requireAll?: boolean;
    /** Report one rule's findings only. */
    readonly only?: string;
}

export interface VerifyResult {
    readonly problems: Problem[];
    readonly skips: Skip[];
    readonly rules: readonly string[];
    /** Documentation files scanned. */
    readonly files: number;
    readonly verifiedOn: string | null;
}

interface PackageEntry {
    version: string;
    pinField: 'dependencies' | 'peerDependencies' | null;
    pin: string | null;
}

interface Assertion {
    id: string;
    canonical: string;
    match?: string;
    /** RegExp flags of `match` / `forbid` (default `g`; `g` is always added). */
    flags?: string;
    expect?: number;
    expectFrom?: string;
    forbid?: string;
    requireIn: string[];
}

interface Manifest {
    verifiedOn: string;
    packages: Record<string, PackageEntry>;
    declared: Record<string, unknown>;
    derived: Record<string, unknown>;
    assertions: Assertion[];
}

export const MANIFEST_REL = 'docs/assets/ecosystem.json';
export const SELF_PACKAGE = 'zipnative-mcp';
export const ENGINE_PACKAGE = 'zipnative';

/** The agent contract: §1 is the tool catalogue, §6 the error reference. */
export const CONTRACT_DOC = 'docs/AGENT_CONTRACT.md';

/** Files whose `Verified on YYYY-MM-DD` stamp must equal the manifest's `verifiedOn`. */
export const STAMPED_FILES: readonly string[] = ['llms.txt', 'docs/KNOWLEDGE_BASE.md', CONTRACT_DOC];

/** Every registered tool must be named, in backticks, in each of these (llms.txt: bare). */
export const TOOL_DOCS: readonly string[] = ['README.md', 'llms.txt', CONTRACT_DOC, 'docs/AI_GUIDE.md', 'docs/API_STABILITY.md'];

/** Every operator variable must be named in each of these. */
export const ENV_VAR_DOCS: readonly string[] = ['README.md', CONTRACT_DOC];

/** Tokens shaped like an operator variable that are not one (src/version.ts, the test-only switch). */
export const UNDECLARED_ENV_VARS: readonly string[] = NON_OPERATOR_ENV_TOKENS;

/**
 * Backticked verb_noun tokens the documents quote on purpose although no
 * such tool exists: names an agent might guess and the docs refute, and the
 * zipnative-cli commands the knowledge base cross-references.
 */
export const KNOWN_NON_TOOLS: readonly string[] = ['encrypt_zip', 'decrypt_zip', 'repair_zip', 'create_tar', 'extract_tar', 'fetch_zip', 'open_zip'];

/** The verbs of a tool name: a backticked `<verb>_<noun>` token is held to the registry. */
export const TOOL_VERBS = /^(?:inspect|list|read|verify|extract|scan|sanitize|create|modify|canonicalize|merge|compute|inflate|deflate|describe|draft|explain|write|open|update|append|remove|rename|check|validate|build|convert|encode|decode|fetch|parse|generate|export|import|encrypt|decrypt|repair|zip|unzip)_[a-z0-9_]+$/;

/**
 * The documents the release is written against. One that is not present yet
 * is a skip wherever a rule needs it (the gate stays green while they are
 * being written); a present one is held to every figure. `--require-all`
 * turns the skips into errors — the release condition.
 */
export const EXPECTED_DOCUMENTS: readonly string[] = [
    'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md', 'ROADMAP.md',
    'THIRD-PARTY-NOTICES.md', 'CITATION.cff', 'llms.txt', 'CHANGELOG.md', 'LICENSE',
    CONTRACT_DOC, 'docs/AI_GUIDE.md', 'docs/API_STABILITY.md', 'docs/KNOWLEDGE_BASE.md',
    'docs/guides/AI_GOVERNANCE.md', 'docs/guides/CONFORMANCE.md', 'docs/guides/DETERMINISM.md', 'docs/guides/INCREMENTAL.md',
    'docs/guides/LOCAL_TESTING.md', 'docs/guides/SECURITY.md',
    'release-notes/TEMPLATE.md', 'release-notes/PR_TEMPLATE.md',
    '.claude/settings.json', '.claude/hooks/guard.mjs',
];

/** The docs/data/ registries that carry a `zipnativeVersion` pin (verazip.json is the server's own declaration). */
export const ENGINE_DATA_FILES: readonly string[] = ['errors.json', 'core-exports.json'];

/** The documents whose corpus figures `verazip-counts` holds to docs/data/verazip.json. */
export const VERAZIP_DOCS: readonly string[] = [
    'README.md', 'CONTRIBUTING.md', 'docs/guides/CONFORMANCE.md', 'llms.txt', 'docs/KNOWLEDGE_BASE.md',
    'docs/guides/LOCAL_TESTING.md', 'docs/guides/SECURITY.md',
];

/** Status checks .github/rulesets/main.json must require (a job id, alone or with its matrix values). */
export const REQUIRED_CHECK_PREFIXES: ReadonlyArray<readonly [string, string]> = [
    ['sample-regression', 'the sample baseline must block merges'],
    ['verazip', 'the ISO/IEC 21320-1 conformance gate must block merges'],
];

export interface RuleInfo {
    readonly id: string;
    readonly description: string;
    /** Runs only under --online. */
    readonly online?: true;
}

/** Every rule, in the order the verifier runs them; `--rules` prints this table. */
export const RULES: readonly RuleInfo[] = [
    { id: 'manifest-shape', description: 'ecosystem.json is well-formed; versions agree with package.json, src/version.ts, server.json, CITATION.cff and the installed engine; exactly three runtime dependencies' },
    { id: 'derived-counts', description: 'derived.* equals the source tree (tools, prompts, wrapper / ZIP_* / diagnostic codes, limits, env vars, examples, tests, samples, corpus); declared.* equals core-exports, coverage floors, .nvmrc, the last gate run' },
    { id: 'stale-token', description: "every assertion's counted noun in the docs (\"N tools\", \"N prompts\", \"N frozen ZIP_* codes\", …) equals the manifest" },
    { id: 'canonical-present', description: "every assertion's canonical sentence appears verbatim where requireIn says" },
    { id: 'version-token', description: '"<package> vX.Y.Z" in prose equals the manifest version of that package' },
    { id: 'count-tokens', description: 'tests / test files / examples / samples / corpus entries / check ids / dependencies / coverage / "Current release" tokens equal the manifest' },
    { id: 'tool-parity', description: 'src/tools/ == the TOOLS registry == the contract §1 catalogue == manifest toolGroups; every tool named in the consumer docs; no invented tool' },
    { id: 'error-parity', description: 'the contract §6 has a row for every wrapper code, every ToolError literal, every ZIP_* code and every diagnostic; no row the source does not know' },
    { id: 'env-var-parity', description: 'the ZIPNATIVE_MCP_* variables the source reads == server.json; each documented in README and the contract; no unknown token in the docs' },
    { id: 'changelog-ladder', description: 'every CHANGELOG heading has its compare link in sequence; the current version has an entry and a release note' },
    { id: 'claude-md-budget', description: 'CLAUDE.md starts with @AGENTS.md; CLAUDE.md and AGENTS.md <= 120 lines; Copilot file <= 16 KiB; no line > 240 chars' },
    { id: 'governance-sources', description: '.github/ai-governance.json parses; capability_manifest sources / on_demand exist; always-loaded sources < 16 KiB' },
    { id: 'node-pin-parity', description: '.nvmrc, .node-version, engines.node, the CI matrix floor and every setup-node step agree; packageManager is npm@' },
    { id: 'ruleset-parity', description: '.github/rulesets/main.json required checks name real workflow jobs; tags.json protects refs/tags/v* (skipped until .github/rulesets/ exists)' },
    { id: 'agent-config-parity', description: '.claude/settings.json: HITL denies on Bash and PowerShell, every CLAUDE.md "Never Read" glob denied, guard hook wired and parsing, no commit attribution' },
    { id: 'claude-rules-sync', description: '.claude/rules/ equals a fresh render of .github/instructions/ (skipped until .claude/rules/ exists)' },
    { id: 'claude-rules-budget', description: 'CLAUDE.md + its @imports + unscoped rules <= 16 KiB; a scoped rule > 32 KiB warns' },
    { id: 'pr-template-parity', description: 'every PR-template checklist item is verbatim in CONTRIBUTING.md "## Pull Request Checklist"; the template names the gate command' },
    { id: 'eol-lf', description: '(git checkouts only) every tracked text blob is LF' },
    { id: 'skills-shape', description: 'every .claude/skills/*/SKILL.md names its directory, has a description, and its referenced files exist (skipped until .claude/skills/ exists)' },
    { id: 'internal-links', description: 'every relative Markdown link resolves on disk' },
    { id: 'anchor-parity', description: 'every #fragment a Markdown link (or a governance reference) targets is a heading anchor of its target' },
    { id: 'verified-on-parity', description: 'every "Verified on" stamp equals manifest.verifiedOn' },
    { id: 'prose-language', description: 'docs, examples README and release notes are English unless marked demo-language' },
    { id: 'no-secret-material', description: 'no document carries a test token, a concrete bearer token, a registry / forge credential, a PRIVATE KEY body or a development-host path' },
    { id: 'engine-data-parity', description: 'docs/data/{errors,core-exports}.json pin zipnativeVersion == the installed engine; errors.json carries exactly the ZIP_* codes and diagnostics of src/zip-errors.ts' },
    { id: 'verazip-counts', description: 'docs/data/verazip.json == scripts/helpers/zip-corpus.mjs + scripts/verazip-core.mjs; every corpus figure README / CONTRIBUTING / CONFORMANCE quote equals it' },
    { id: 'npm-drift', description: '(--online only) the manifest versions and engine pin equal the npm registry', online: true },
];

export const OFFLINE_RULES: readonly string[] = RULES.filter((r) => r.online !== true).map((r) => r.id);
export const ALL_RULES: readonly string[] = RULES.map((r) => r.id);

// ── Helpers ─────────────────────────────────────────────────────────

/** `s` as a literal inside a RegExp source: every metacharacter, the backslash included, escaped. */
export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Line number (1-based) of a character offset. */
export function lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) line++;
    }
    return line;
}

/**
 * Historical prose legitimately quotes superseded numbers. Rewriting those
 * would falsify the roadmap, so a line may opt out with
 * `verify-docs:allow <rule>` on itself or on the line immediately above — a
 * visible, greppable marker rather than a silent exclusion list.
 */
export function isSuppressed(lines: readonly string[], lineNo: number, rule: string): boolean {
    const marker = `verify-docs:allow ${rule}`;
    return (lines[lineNo - 1]?.includes(marker) ?? false) || (lines[lineNo - 2]?.includes(marker) ?? false);
}

/** True when semver a is strictly lower than b (plain x.y.z triples only). */
export function semverLess(a: string, b: string): boolean {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
    }
    return false;
}

const NUMBER_WORDS: readonly string[] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/**
 * The capturing group a manifest `match` writes as `{count}`: digits (with
 * thousands separators) or an English number word up to twenty, either case
 * of the first letter ("Seven prompts").
 */
export const COUNT_GROUP = `(\\d{1,3}(?:[,\\u202f\\u00a0]\\d{3})+|\\d+|${NUMBER_WORDS.slice(1).map((w) => `[${w[0]}${(w[0] as string).toUpperCase()}]${w.slice(1)}`).join('|')})`;

/** A quoted count as a number: "1,119" → 1119, "seven" → 7; NaN for anything else. */
export function parseCount(s: string): number {
    const word = NUMBER_WORDS.indexOf(s.toLowerCase());
    if (word !== -1) return word;
    const digits = s.replace(/[\s  ,]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

/** A manifest pattern compiled: `{count}` expanded, `g` always set. */
export function compilePattern(source: string, flags = 'g'): RegExp {
    const f = flags.includes('g') ? flags : `${flags}g`;
    return new RegExp(source.replace(/\{count\}/g, COUNT_GROUP), f);
}

/**
 * Job ids, display names and matrix values of every workflow under
 * `.github/workflows/`, for matching a ruleset's required status checks.
 */
export function workflowJobs(workflowTexts: readonly string[]): { jobs: Set<string>; matrixValues: Map<string, Set<string>> } {
    const jobs = new Set<string>();
    const matrixValues = new Map<string, Set<string>>();
    for (const text of workflowTexts) {
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        let inJobs = false;
        let current: string | null = null;
        for (const line of lines) {
            if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
            if (!inJobs) continue;
            if (/^\S/.test(line)) { inJobs = false; continue; }
            const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
            if (id) {
                current = id[1] as string;
                jobs.add(current);
                matrixValues.set(current, new Set());
                continue;
            }
            if (!current) continue;
            const jobName = /^ {4}name:\s*(.+?)\s*$/.exec(line);
            if (jobName) jobs.add((jobName[1] as string).replace(/^["']|["']$/g, ''));
            const list = /^ {8}[A-Za-z0-9_-]+:\s*\[([^\]]*)\]\s*$/.exec(line);
            if (list) {
                for (const v of (list[1] as string).split(',')) matrixValues.get(current)!.add(v.trim().replace(/['"]/g, ''));
            }
        }
    }
    return { jobs, matrixValues };
}

/** True when a relative path names one of the documents the release is written against. */
export function isExpectedDocument(relPath: string): boolean {
    return EXPECTED_DOCUMENTS.includes(relPath.replace(/\\/g, '/'));
}

function walk(dir: string, filter: (p: string) => boolean, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir).sort()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, filter, out);
        else if (filter(full)) out.push(full);
    }
    return out;
}

// ── The verifier ────────────────────────────────────────────────────

export async function verifyDocs(root: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    const result = await runRules(root, options);
    if (options.only === undefined) return result;
    return {
        ...result,
        problems: result.problems.filter((p) => p.rule === options.only),
        skips: result.skips.filter((s) => s.rule === options.only),
        rules: [options.only],
    };
}

async function runRules(root: string, options: VerifyOptions): Promise<VerifyResult> {
    const problems: Problem[] = [];
    const skips: Skip[] = [];
    const rulesRun = options.online ? ALL_RULES : OFFLINE_RULES;
    const fail = (file: string, line: number, rule: string, message: string): void => {
        problems.push({ file, line, rule, message, severity: 'error' });
    };
    const warn = (file: string, line: number, rule: string, message: string): void => {
        problems.push({ file, line, rule, message, severity: 'warn' });
    };
    /** An input not present yet: a skip, or an error under --require-all. */
    const skip = (file: string, rule: string, message: string): void => {
        if (options.requireAll) fail(file, 1, rule, `${message} (required by --require-all)`);
        else skips.push({ file, rule, message });
    };
    const rel = (p: string): string => relative(root, p).replace(/\\/g, '/');
    const read = (p: string): string => readFileSync(p, 'utf8');
    const readOr = (p: string): string | null => (existsSync(join(root, p)) ? read(join(root, p)) : null);
    /** Read a document, or record a skip (expected document) / an error (anything else) and return null. */
    const readDoc = (p: string, rule: string, why: string): string | null => {
        const text = readOr(p);
        if (text !== null) return text;
        if (isExpectedDocument(p)) skip(p, rule, `not present yet — ${why}`);
        else fail(p, 1, rule, `missing — ${why}`);
        return null;
    };
    const report = (findings: readonly Finding[], rule: string): void => {
        for (const f of findings) (f.severity === 'error' ? fail : warn)(f.file, f.line, rule, f.message);
    };
    const parseJson = <T>(text: string | null): T | null => {
        if (text === null) return null;
        try {
            return JSON.parse(text) as T;
        } catch {
            return null;
        }
    };

    // ── Manifest ──────────────────────────────────────────────────
    const manifestPath = join(root, MANIFEST_REL);
    if (!existsSync(manifestPath)) {
        fail(MANIFEST_REL, 1, 'manifest-shape', 'missing — it is the single source of every count and version the docs quote');
        return { problems, skips, rules: rulesRun, files: 0, verifiedOn: null };
    }
    let manifest: Manifest;
    try {
        manifest = JSON.parse(read(manifestPath)) as Manifest;
    } catch (err) {
        fail(MANIFEST_REL, 1, 'manifest-shape', `not valid JSON — ${(err as Error).message}`);
        return { problems, skips, rules: rulesRun, files: 0, verifiedOn: null };
    }
    manifest.declared ??= {};
    manifest.derived ??= {};
    manifest.assertions ??= [];
    manifest.packages ??= {};

    const selfVersion = manifest.packages[SELF_PACKAGE]?.version ?? '';
    const coreVersion = manifest.packages[ENGINE_PACKAGE]?.version ?? '';

    // ── The documentation corpus ──────────────────────────────────
    const DOC_FILES: string[] = [
        ...['README.md', 'ROADMAP.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md',
            'THIRD-PARTY-NOTICES.md', 'CITATION.cff', 'llms.txt',
            '.github/copilot-instructions.md', '.github/AGENT_RULES.md', 'examples/README.md', 'scripts/README.md', 'tests/fixtures/PROVENANCE.md',
            `release-notes/v${selfVersion}.md`]
            .map((f) => join(root, f))
            .filter((f) => existsSync(f)),
        ...walk(join(root, 'docs'), (p) => p.endsWith('.md')),
        ...walk(join(root, '.github', 'instructions'), (p) => p.endsWith('.md')),
        ...walk(join(root, '.github', 'prompts'), (p) => p.endsWith('.md')),
    ];
    const texts = new Map(DOC_FILES.map((f) => [f, read(f)] as const));

    // ── Rule: manifest-shape ──────────────────────────────────────
    const SEMVER = /^\d+\.\d+\.\d+$/;
    for (const [name, pkg] of Object.entries(manifest.packages)) {
        if (!SEMVER.test(pkg.version ?? '')) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `${name}.version "${pkg.version}" is not a plain semver triple`);
        }
        if (pkg.pinField !== null && pkg.pinField !== 'dependencies' && pkg.pinField !== 'peerDependencies') {
            fail(MANIFEST_REL, 1, 'manifest-shape', `${name}.pinField must be "dependencies", "peerDependencies" or null`);
        }
        if (pkg.pinField !== null && !pkg.pin) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `${name} declares pinField "${pkg.pinField}" but no pin`);
        }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.verifiedOn ?? '')) {
        fail(MANIFEST_REL, 1, 'manifest-shape', `verifiedOn "${String(manifest.verifiedOn)}" is not a YYYY-MM-DD date`);
    }
    const pkgJsonText = readOr('package.json');
    const pkgJson = parseJson<{ version?: string; dependencies?: Record<string, string>; mcpName?: string; scripts?: Record<string, string>; engines?: { node?: string }; packageManager?: string }>(pkgJsonText);
    /** The installed version of a package, when node_modules is present (CI installs before verifying). */
    const installed = (name: string): string | null => parseJson<{ version?: string }>(readOr(`node_modules/${name}/package.json`))?.version ?? null;
    const engineInstalled = installed(ENGINE_PACKAGE);
    if (pkgJson !== null) {
        if (pkgJson.version !== selfVersion) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `packages.${SELF_PACKAGE}.version is ${selfVersion} but package.json says ${pkgJson.version} — the version moves in lock-step`);
        }
        const pin = pkgJson.dependencies?.[ENGINE_PACKAGE];
        const declaredPin = manifest.packages[ENGINE_PACKAGE]?.pin;
        if (pin !== undefined && declaredPin !== pin) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `packages.${ENGINE_PACKAGE}.pin is ${JSON.stringify(declaredPin ?? null)} but package.json pins ${ENGINE_PACKAGE} ${pin}`);
        }
        const pinFloor = /(\d+\.\d+\.\d+)/.exec(pin ?? '')?.[1];
        if (pinFloor !== undefined && pinFloor !== coreVersion) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `packages.${ENGINE_PACKAGE}.version is ${coreVersion} but the dependency floor is ${pinFloor} — the manifest names the engine the server is built on`);
        }
        // Exactly three runtime dependencies: the governance invariant (CLAUDE.md convention 1).
        const deps = Object.keys(pkgJson.dependencies ?? {}).sort();
        const allowed = ['@modelcontextprotocol/server', ENGINE_PACKAGE, 'zod'];
        if (deps.length !== allowed.length || deps.some((d, i) => d !== allowed[i])) {
            fail('package.json', 1, 'manifest-shape', `dependencies are [${deps.join(', ')}] — the runtime set is exactly [${allowed.join(', ')}]`);
        }
        const sdk = manifest.declared['sdk'] as { pin?: unknown; installed?: unknown } | undefined;
        const sdkPin = pkgJson.dependencies?.['@modelcontextprotocol/server'];
        if (sdk !== undefined && sdkPin !== undefined && sdk.pin !== sdkPin) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `declared.sdk.pin is ${JSON.stringify(sdk.pin ?? null)} but package.json pins @modelcontextprotocol/server ${sdkPin}`);
        }
        const zod = manifest.declared['zod'] as { pin?: unknown } | undefined;
        const zodPin = pkgJson.dependencies?.['zod'];
        if (zod !== undefined && zodPin !== undefined && zod.pin !== zodPin) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `declared.zod.pin is ${JSON.stringify(zod.pin ?? null)} but package.json pins zod ${zodPin}`);
        }
        const registryName = (manifest.packages[SELF_PACKAGE] as { registryName?: unknown } | undefined)?.registryName;
        if (registryName !== undefined && pkgJson.mcpName !== undefined && registryName !== pkgJson.mcpName) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `packages.${SELF_PACKAGE}.registryName is ${JSON.stringify(registryName)} but package.json mcpName is ${pkgJson.mcpName}`);
        }
        if (engineInstalled !== null && engineInstalled !== coreVersion) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `packages.${ENGINE_PACKAGE}.version is ${coreVersion} but node_modules holds ${engineInstalled} — the manifest names the engine the server is built on`);
        }
        const sdkInstalled = installed('@modelcontextprotocol/server');
        if (sdk !== undefined && typeof sdk.installed === 'string' && sdkInstalled !== null && sdkInstalled !== sdk.installed) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `declared.sdk.installed is ${sdk.installed} but node_modules holds @modelcontextprotocol/server ${sdkInstalled}`);
        }
    } else if (pkgJsonText !== null) {
        fail('package.json', 1, 'manifest-shape', 'not valid JSON');
    }
    {
        // The version lock-step (CLAUDE.md convention 8): src/version.ts, server.json (twice) and CITATION.cff carry the same triple.
        const versionTs = readOr('src/version.ts');
        const inSource = versionTs === null ? null : /ZIPNATIVE_MCP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/.exec(versionTs)?.[1] ?? null;
        if (inSource !== null && inSource !== selfVersion) {
            fail('src/version.ts', 1, 'manifest-shape', `says ${inSource} but the manifest says ${selfVersion} — the version moves in lock-step`);
        }
        const toolApi = versionTs === null ? null : /TOOL_API_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/.exec(versionTs)?.[1] ?? null;
        const declaredToolApi = manifest.declared['toolApiVersion'];
        if (toolApi !== null && declaredToolApi !== undefined && declaredToolApi !== toolApi) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `declared.toolApiVersion is ${String(declaredToolApi)} but src/version.ts says TOOL_API_VERSION = ${toolApi}`);
        }
        const serverJson = readOr('server.json');
        if (serverJson !== null) {
            try {
                const parsed = JSON.parse(serverJson) as { version?: string; packages?: Array<{ version?: string }> };
                for (const v of [parsed.version, ...(parsed.packages ?? []).map((p) => p.version)]) {
                    if (v !== selfVersion) fail('server.json', 1, 'manifest-shape', `carries version ${JSON.stringify(v ?? null)} but the manifest says ${selfVersion}`);
                }
            } catch (err) {
                fail('server.json', 1, 'manifest-shape', `not valid JSON — ${(err as Error).message}`);
            }
        }
        const citation = readOr('CITATION.cff');
        const cited = citation === null ? null : /^version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m.exec(citation);
        if (cited && cited[1] !== selfVersion) {
            fail('CITATION.cff', lineOf(citation ?? '', cited.index), 'manifest-shape', `says version ${cited[1]} but the manifest says ${selfVersion} — the version moves in lock-step`);
        }
    }

    const manifestRef = (ref: string): number | undefined => {
        const m = /^(declared|derived)\.([A-Za-z_]\w*)$/.exec(ref);
        if (!m) return undefined;
        const value = (m[1] === 'declared' ? manifest.declared : manifest.derived)[m[2] as string];
        return typeof value === 'number' ? value : undefined;
    };
    const resolveCanonical = (canonical: string): string =>
        canonical.replace(/\{((?:declared|derived)\.\w+)\}/g, (whole, ref: string) => {
            const value = manifestRef(ref);
            return value === undefined ? whole : String(value);
        });

    for (const assertion of manifest.assertions) {
        for (const pattern of [assertion.match, assertion.forbid]) {
            if (pattern === undefined) continue;
            try {
                compilePattern(pattern, assertion.flags);
            } catch (err) {
                fail(MANIFEST_REL, 1, 'manifest-shape', `assertion "${assertion.id}" has an invalid pattern — ${(err as Error).message}`);
            }
        }
        if (assertion.expectFrom === undefined) continue;
        const resolved = manifestRef(assertion.expectFrom);
        if (resolved === undefined) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `assertion "${assertion.id}" has expectFrom "${assertion.expectFrom}", which is not a numeric declared.* or derived.* field`);
            continue;
        }
        if (assertion.expect !== undefined && assertion.expect !== resolved) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `assertion "${assertion.id}" says expect ${assertion.expect} but ${assertion.expectFrom} is ${resolved} — drop the literal, expectFrom is the source`);
        }
        const canonical = resolveCanonical(assertion.canonical);
        const lead = /^(\d[\d ,]*)/.exec(canonical);
        if (lead && !assertion.canonical.startsWith('{') && Number((lead[1] as string).replace(/[\s,]/g, '')) !== resolved) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `assertion "${assertion.id}" canonical "${assertion.canonical}" contradicts ${assertion.expectFrom} = ${resolved} — use a {${assertion.expectFrom}} placeholder`);
        }
        for (const placeholder of canonical.matchAll(/\{((?:declared|derived)\.\w+)\}/g)) {
            fail(MANIFEST_REL, 1, 'manifest-shape', `assertion "${assertion.id}" canonical references {${placeholder[1]}}, which is not a numeric manifest field`);
        }
    }

    // ── Rule: derived-counts ──────────────────────────────────────
    const corpus = await corpusFigures(root);
    {
        const actual: Record<string, number> = { ...computeDerived(root) };
        if (corpus !== null) {
            actual['corpusEntries'] = corpus.corpusEntries;
            actual['corpusConformant'] = corpus.corpusConformant;
            actual['corpusNonConformant'] = corpus.corpusNonConformant;
            actual['corpusHostileConformant'] = corpus.corpusHostileConformant;
            actual['checkIds'] = corpus.checkIds;
        } else {
            skip('scripts/helpers/zip-corpus.mjs', 'derived-counts', 'not present — the corpus counts (corpusEntries, corpusConformant, corpusNonConformant, corpusHostileConformant, checkIds) cannot be derived');
        }
        const CORPUS_KEYS = ['corpusEntries', 'corpusConformant', 'corpusNonConformant', 'corpusHostileConformant', 'checkIds'];
        const KNOWN_DERIVED = new Set([...Object.keys(actual), ...CORPUS_KEYS, 'toolGroups', '$comment']);
        for (const key of Object.keys(manifest.derived)) {
            if (!KNOWN_DERIVED.has(key)) {
                fail(MANIFEST_REL, 1, 'manifest-shape', `derived.${key} is not computed by any rule — typo, or add it to scripts/lib/mcp-surface.ts computeDerived()`);
            }
        }
        for (const [key, value] of Object.entries(actual)) {
            const stated = manifest.derived[key];
            if (stated === undefined) {
                fail(MANIFEST_REL, 1, 'derived-counts', `derived.${key} is missing — the tree has ${value}`);
                continue;
            }
            if (stated !== value) {
                fail(MANIFEST_REL, 1, 'derived-counts', `derived.${key} says ${String(stated)} but the tree has ${value} — update the manifest, not the docs`);
            }
        }
    }
    {
        // Declared figures the tree can still check: the engine export ledger, the dependencies, the Node pin.
        const expectDeclared = (key: string, value: number, source: string): void => {
            const stated = manifest.declared[key];
            if (stated === undefined) fail(MANIFEST_REL, 1, 'derived-counts', `declared.${key} is missing — ${source} has ${value}`);
            else if (stated !== value) fail(MANIFEST_REL, 1, 'derived-counts', `declared.${key} says ${String(stated)} but ${source} has ${value} — update whichever is stale`);
        };
        const core = parseJson<{ exportCount?: unknown; exports?: unknown[] }>(readOr('docs/data/core-exports.json'));
        if (core !== null && typeof core.exportCount === 'number') expectDeclared('engineExports', core.exportCount, 'docs/data/core-exports.json exportCount');
        // The engine's own export surface, when reachable: a sibling checkout first, the installed package second.
        for (const candidate of [join(root, '..', ENGINE_PACKAGE, 'docs', 'assets', 'api.json'), join(root, 'node_modules', ENGINE_PACKAGE, 'docs', 'assets', 'api.json')]) {
            if (!existsSync(candidate)) continue;
            const api = parseJson<{ exportCount?: unknown }>(read(candidate));
            const siblingVersion = parseJson<{ version?: string }>(existsSync(join(dirname(dirname(dirname(candidate))), 'package.json')) ? read(join(dirname(dirname(dirname(candidate))), 'package.json')) : null)?.version;
            if (typeof api?.exportCount === 'number' && (siblingVersion === undefined || siblingVersion === coreVersion)) {
                expectDeclared('engineExports', api.exportCount, `the ${ENGINE_PACKAGE} ${siblingVersion ?? ''} api.json`.replace('  ', ' '));
            }
            break;
        }
        if (pkgJson !== null) expectDeclared('dependencies', Object.keys(pkgJson.dependencies ?? {}).length, 'package.json dependencies');
        const nvmrc = readOr('.nvmrc');
        const nvmMajor = nvmrc === null ? null : /^v?(\d+)/.exec(nvmrc.trim())?.[1];
        if (nvmMajor !== undefined && nvmMajor !== null) expectDeclared('nodeMajor', Number(nvmMajor), '.nvmrc');
    }
    {
        // The test count is whatever the last gate run recorded — only a
        // report newer than every test file is evidence.
        const vitestJson = join(root, 'test-output', '.gate', 'vitest.json');
        const newestTest = walk(join(root, 'tests'), (p) => p.endsWith('.test.ts')).reduce((max, p) => Math.max(max, statSync(p).mtimeMs), 0);
        if (existsSync(vitestJson) && statSync(vitestJson).mtimeMs >= newestTest) {
            const r = parseJson<{ numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; numPendingTests?: number; numTodoTests?: number }>(read(vitestJson));
            const total = r === null
                ? undefined
                : typeof r.numTotalTests === 'number'
                    ? r.numTotalTests
                    : typeof r.numPassedTests === 'number'
                        ? r.numPassedTests + (r.numFailedTests ?? 0) + (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0)
                        : undefined;
            if (typeof total === 'number' && total > 0 && manifest.declared['tests'] !== total) {
                fail(MANIFEST_REL, 1, 'derived-counts', `declared.tests says ${String(manifest.declared['tests'])} but the last gate run counted ${total} tests — update the manifest (and every doc quoting it)`);
            }
        }
    }
    {
        // The coverage floors the docs quote are the ones vitest enforces.
        const vitestConfig = readOr('vitest.config.ts');
        if (vitestConfig !== null) {
            for (const [key, field] of [['coverageStatements', 'statements'], ['coverageBranches', 'branches'], ['coverageFunctions', 'functions'], ['coverageLines', 'lines']] as const) {
                const floor = new RegExp(`\\b${field}:\\s*(\\d+(?:\\.\\d+)?)`).exec(vitestConfig)?.[1];
                if (floor !== undefined && manifest.declared[key] !== Number(floor)) {
                    fail(MANIFEST_REL, 1, 'derived-counts', `declared.${key} says ${String(manifest.declared[key])} but vitest.config.ts enforces ${floor}`);
                }
            }
        }
    }

    // ── Rule: stale-token / canonical-present ─────────────────────
    for (const assertion of manifest.assertions) {
        const pattern = assertion.match ?? assertion.forbid;
        const expect = assertion.expectFrom !== undefined ? manifestRef(assertion.expectFrom) : assertion.expect;
        const canonical = resolveCanonical(assertion.canonical);
        if (pattern) {
            let re: RegExp;
            try {
                re = compilePattern(pattern, assertion.flags);
            } catch {
                continue; // manifest-shape reports it
            }
            const isEquality = assertion.match !== undefined && expect !== undefined;
            for (const file of DOC_FILES) {
                const text = texts.get(file)!;
                const lines = text.split(/\r?\n/);
                re.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = re.exec(text)) !== null) {
                    if (m[0] === '') { re.lastIndex++; continue; }
                    const line = lineOf(text, m.index);
                    if (isSuppressed(lines, line, 'stale-token')) continue;
                    if (isEquality) {
                        const found = parseCount(m[1] ?? '');
                        if (!Number.isFinite(found) || found === expect) continue;
                        fail(rel(file), line, 'stale-token', `"${m[0].trim().replace(/\s+/g, ' ')}" — the manifest says ${expect} (${assertion.id})`);
                    } else {
                        fail(rel(file), line, 'stale-token', `"${m[0].trim()}" contradicts the manifest — canonical value is "${canonical}"`);
                    }
                }
            }
        }
        for (const required of assertion.requireIn) {
            const text = readDoc(required, 'canonical-present', `it must state the canonical value "${canonical}" (assertion "${assertion.id}")`);
            if (text === null) continue;
            if (!text.includes(canonical)) {
                fail(required, 1, 'canonical-present', `must state the canonical value "${canonical}" (assertion "${assertion.id}")`);
            }
        }
    }

    // ── Rule: version-token ───────────────────────────────────────
    for (const [name, pkg] of Object.entries(manifest.packages)) {
        const escaped = escapeRegExp(name);
        const re = new RegExp(
            `\\b${escaped}(?![\\w-])[^\\n'"\`/().]{0,60}?(?<![\\^~\\d.§])(?<![<>≥≤=]\\s{0,3})\\bv?(\\d+\\.\\d+\\.\\d+)\\b`,
            'g',
        );
        const structural = [
            new RegExp(`\\[\`${escaped}\`\\]\\([^)]*\\)\\s*\\|\\s*\\*{0,2}v?(\\d+\\.\\d+\\.\\d+)\\*{0,2}`, 'g'),
        ];
        for (const file of DOC_FILES) {
            const text = texts.get(file)!;
            const lines = text.split(/\r?\n/);
            for (const pattern of [re, ...structural]) {
                pattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = pattern.exec(text)) !== null) {
                    if (m[1] === pkg.version) continue;
                    const line = lineOf(text, m.index);
                    if (isSuppressed(lines, line, 'version-token') || isSuppressed(lines, line, 'stale-token')) continue;
                    fail(rel(file), line, 'version-token', `"${m[0].trim()}" — the manifest says ${name} is ${pkg.version}`);
                }
            }
        }
    }

    // ── Rule: count-tokens ────────────────────────────────────────
    {
        interface CountToken {
            readonly pattern: RegExp;
            readonly source: string;
            readonly mode: 'equal' | 'floor';
            readonly requireIn?: readonly string[];
            /** Measured figure a decimal quote must equal (declared.<key>). */
            readonly measured?: string;
        }
        // `(?<![#.\d-])` keeps "v1.1 tests", "level-1 tools" and "#12 tests" out of the count.
        const COUNT_TOKENS: readonly CountToken[] = [
            { pattern: /(?<![#.\d-])\b(\d{1,3}(?:[,  ]\d{3})+|\d+)\+?\s+tests\b/g, source: 'declared.tests', mode: 'equal', requireIn: ['README.md', 'AGENTS.md'] },
            { pattern: /\bacross\s+(\d+)\+?\s+(?:test\s+)?files\b/g, source: 'derived.testFiles', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)\+?\s+test files\b/g, source: 'derived.testFiles', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)\s+(?:executable\s+|worked\s+|runnable\s+)?examples\b/g, source: 'derived.examples', mode: 'equal' },
            // "10 samples byte for byte": the baseline's modes, not its size.
            { pattern: /(?<![#.\d-])\b(\d+)\s+samples\b(?!\s+(?:byte|semantic|compared))/g, source: 'derived.samples', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)-sample (?:byte\/semantic )?baseline\b/g, source: 'derived.samples', mode: 'equal' },
            { pattern: /(?<![#.\d-])(?<![+\-–]\s{0,2})\b(\d+)\s+corpus entries\b/g, source: 'derived.corpusEntries', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)-entry (?:conformance |veraZIP )?corpus\b/g, source: 'derived.corpusEntries', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)\s+(?:frozen\s+)?check ids\b/gi, source: 'derived.checkIds', mode: 'equal' },
            { pattern: /(?<![#.\d-])\b(\d+)\s+runtime dependencies\b/g, source: 'declared.dependencies', mode: 'equal' },
            { pattern: /(\d+(?:\.\d+)?)\s?%\+?\s+statement coverage\b/g, source: 'declared.coverageStatements', mode: 'floor', measured: 'coverageMeasured' },
            { pattern: /(\d+(?:\.\d+)?)\s?%\+?\s+statements\b/g, source: 'declared.coverageStatements', mode: 'floor', measured: 'coverageMeasured' },
            { pattern: /(\d+(?:\.\d+)?)\s?%\+?\s+branch(?:es| coverage)\b/g, source: 'declared.coverageBranches', mode: 'floor', measured: 'coverageMeasuredBranches' },
            { pattern: /(\d+(?:\.\d+)?)\s?%\+?\s+functions\b/g, source: 'declared.coverageFunctions', mode: 'floor', measured: 'coverageMeasuredFunctions' },
            { pattern: /(\d+(?:\.\d+)?)\s?%\+?\s+lines\b/g, source: 'declared.coverageLines', mode: 'floor', measured: 'coverageMeasuredLines' },
        ];
        for (const token of COUNT_TOKENS) {
            const expected = manifestRef(token.source);
            if (expected === undefined) {
                fail(MANIFEST_REL, 1, 'manifest-shape', `${token.source} is missing — count-tokens needs it to police "${token.pattern.source}"`);
                continue;
            }
            const seenIn = new Set<string>();
            for (const file of DOC_FILES) {
                const text = texts.get(file)!;
                const lines = text.split(/\r?\n/);
                token.pattern.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = token.pattern.exec(text)) !== null) {
                    seenIn.add(rel(file));
                    const found = parseCount(m[1] as string);
                    const raw = m[1] as string;
                    const asNumber = token.mode === 'floor' ? Number(raw) : found;
                    if (!Number.isFinite(asNumber)) continue;
                    const line = lineOf(text, m.index);
                    const suppressed = (): boolean => isSuppressed(lines, line, 'count-tokens') || isSuppressed(lines, line, 'stale-token');
                    const measured = token.measured === undefined ? undefined : manifest.declared[token.measured];
                    if (token.mode === 'floor' && raw.includes('.') && typeof measured === 'number') {
                        if (Math.abs(asNumber - measured) > 0.001 && !suppressed()) {
                            fail(rel(file), line, 'count-tokens', `"${m[0].trim()}" — the manifest says the measured figure is ${measured} % (declared.${token.measured})`);
                        }
                        continue;
                    }
                    const ok = token.mode === 'equal' ? asNumber === expected : Math.floor(asNumber) <= expected;
                    if (ok || suppressed()) continue;
                    const verdict = token.mode === 'equal'
                        ? `the manifest says ${expected} (${token.source})`
                        : `the manifest floor is ${expected} % (${token.source}) — a doc may not claim more coverage than is enforced`;
                    fail(rel(file), line, 'count-tokens', `"${m[0].trim()}" — ${verdict}`);
                }
            }
            for (const required of token.requireIn ?? []) {
                if (!existsSync(join(root, required))) {
                    if (isExpectedDocument(required)) skip(required, 'count-tokens', `not present yet — it must state the ${token.source} count`);
                    else fail(required, 1, 'count-tokens', `missing — it must state the ${token.source} count`);
                } else if (!seenIn.has(required)) {
                    fail(required, 1, 'count-tokens', `never states the ${token.source} count ("${expected} tests") — it is the figure agents quote`);
                }
            }
        }
        // "Current release: X.Y.Z" / "Current version: X.Y.Z" — prose that names
        // the server version without the package name beside it.
        const CURRENT_VERSION = /Current (?:release|version):\s*\**v?(\d+\.\d+\.\d+)/g;
        for (const file of DOC_FILES) {
            const text = texts.get(file)!;
            const lines = text.split(/\r?\n/);
            CURRENT_VERSION.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = CURRENT_VERSION.exec(text)) !== null) {
                if (m[1] === selfVersion) continue;
                const line = lineOf(text, m.index);
                if (isSuppressed(lines, line, 'count-tokens') || isSuppressed(lines, line, 'version-token')) continue;
                fail(rel(file), line, 'count-tokens', `"${m[0].trim()}" — the manifest says ${SELF_PACKAGE} is ${selfVersion}`);
            }
        }
    }

    // ── Rule: tool-parity ─────────────────────────────────────────
    const tools = toolNames(root);
    const serverText = readOr('src/server.ts') ?? '';
    {
        const toolSet = new Set(tools);
        const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
        if (tools.length === 0) {
            fail('src/server.ts', 1, 'tool-parity', 'the TOOLS registry resolves to no tool — scripts/lib/mcp-surface.ts can no longer read it');
        }
        // Every tool module is registered, and the registry names only tool modules.
        const toolsDir = join(root, 'src', 'tools');
        if (existsSync(toolsDir)) {
            const declared = new Set<string>();
            for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).sort()) {
                const pair = toolNameConstant(read(join(toolsDir, file)));
                if (!pair) continue;
                const name = pair[1];
                declared.add(name);
                if (!toolSet.has(name)) fail(`src/tools/${file}`, 1, 'tool-parity', `declares "${name}", which the TOOLS registry of src/server.ts does not list`);
                const expectedFile = `${name.replace(/_/g, '-')}.ts`;
                if (file !== expectedFile) fail(`src/tools/${file}`, 1, 'tool-parity', `declares "${name}" — one file per tool, named after it (${expectedFile})`);
            }
            for (const t of tools) if (!declared.has(t)) fail('src/server.ts', 1, 'tool-parity', `registers "${t}", which no module under src/tools/ declares`);
        }
        const contract = readDoc(CONTRACT_DOC, 'tool-parity', 'its §1 catalogue lists every tool');
        if (contract !== null) {
            const catalogue = contractCatalogueTools(contract);
            if (catalogue.length === 0) fail(CONTRACT_DOC, 1, 'tool-parity', 'has no "## 1. Tool catalogue" table with numbered rows and a backticked tool name in the second column');
            for (const t of tools) if (!catalogue.includes(t)) fail(CONTRACT_DOC, 1, 'tool-parity', `the §1 catalogue has no row for \`${t}\``);
            for (const t of catalogue) if (!toolSet.has(t)) fail(CONTRACT_DOC, 1, 'tool-parity', `the §1 catalogue lists \`${t}\`, which is not a tool`);
            if (new Set(catalogue).size !== catalogue.length) fail(CONTRACT_DOC, 1, 'tool-parity', 'the §1 catalogue lists a tool twice');
            if (catalogue.length === tools.length && catalogue.some((t, i) => t !== tools[i])) {
                fail(CONTRACT_DOC, 1, 'tool-parity', 'the §1 catalogue is not in registration order (tools/list order) — reorder the rows');
            }
        }
        for (const doc of TOOL_DOCS) {
            const text = readDoc(doc, 'tool-parity', 'it must name every tool');
            if (text === null) continue;
            // Markdown names a tool in backticks; llms.txt is plain text and names it bare.
            const names = doc.endsWith('.md') ? (t: string): boolean => text.includes(`\`${t}\``) : (t: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`).test(text);
            const absent = tools.filter((t) => !names(t));
            if (absent.length > 0) fail(doc, 1, 'tool-parity', `does not name ${absent.map((t) => `\`${t}\``).join(', ')} — every tool is part of the contract`);
        }
        const groups = manifest.derived['toolGroups'];
        if (groups && typeof groups === 'object') {
            const grouped = Object.values(groups as Record<string, string[]>).flat();
            if (!same(grouped, tools)) {
                const unknown = grouped.filter((t) => !toolSet.has(t));
                const missing = tools.filter((t) => !grouped.includes(t));
                fail(MANIFEST_REL, 1, 'tool-parity', `derived.toolGroups differs from the TOOLS registry${unknown.length ? ` — unknown: ${unknown.join(', ')}` : ''}${missing.length ? ` — not grouped: ${missing.join(', ')}` : ''}`);
            } else if (grouped.some((t, i) => t !== tools[i])) {
                fail(MANIFEST_REL, 1, 'tool-parity', 'derived.toolGroups is not in registration order — the groups, read in order, must spell tools/list');
            }
        } else {
            fail(MANIFEST_REL, 1, 'tool-parity', 'derived.toolGroups is missing — the README and llms.txt group the tools by it');
        }
        // A backticked verb_noun token that looks like a tool but is not one: a renamed or invented tool.
        // Prompt names share the shape (`secure_extraction`) and are a surface of their own.
        const prompts = new Set(promptNames(serverText));
        const knownNonTools = new Set(KNOWN_NON_TOOLS);
        for (const file of DOC_FILES) {
            const text = texts.get(file)!;
            const lines = text.split(/\r?\n/);
            for (const token of snakeTokens(text)) {
                if (!TOOL_VERBS.test(token) || toolSet.has(token) || prompts.has(token) || knownNonTools.has(token)) continue;
                const line = lineOf(text, text.indexOf(`\`${token}\``));
                if (isSuppressed(lines, line, 'tool-parity')) continue;
                fail(rel(file), line, 'tool-parity', `\`${token}\` reads like a tool name but the registry has none — a planned tool is marked \`verify-docs:allow tool-parity\``);
            }
        }
    }

    // ── Rule: error-parity ────────────────────────────────────────
    {
        const zipErrorsText = readOr('src/zip-errors.ts') ?? '';
        const wrapper = wrapperCodes(readOr('src/wrapper-codes.ts') ?? '');
        const raised = errorCodes(root);
        const zipCodes = zipErrorCodes(zipErrorsText);
        const diagnostics = zipDiagnosticCodes(zipErrorsText);
        // Every literal ToolError code is a wrapper code or a frozen ZIP_* code (tests/error-codes.test.ts holds the same).
        for (const c of raised) {
            if (!wrapper.includes(c) && !zipCodes.includes(c)) fail('src/wrapper-codes.ts', 1, 'error-parity', `\`${c}\` is raised under src/ but WRAPPER_CODES has no row for it`);
        }
        const contract = readDoc(CONTRACT_DOC, 'error-parity', 'its §6 documents every wrapper code, ZIP_* code and diagnostic');
        if (contract !== null) {
            const rows = contractErrorRows(contract);
            if (rows.length === 0) fail(CONTRACT_DOC, 1, 'error-parity', 'has no "## 6." error reference table');
            const contractLines = contract.split(/\r?\n/);
            for (const [what, list] of [['wrapper code', [...new Set([...wrapper, ...raised.filter((c) => !c.startsWith('ZIP_'))])]], ['ZIP_* code', zipCodes], ['diagnostic', diagnostics]] as const) {
                const absent = list.filter((c) => !rows.includes(c));
                if (absent.length > 0) fail(CONTRACT_DOC, 1, 'error-parity', `§6 has no row for the ${what}${absent.length === 1 ? '' : 's'} ${absent.join(', ')} — every code an agent can receive is part of the contract`);
            }
            const known = new Set([...wrapper, ...raised, ...zipCodes, ...diagnostics, 'UNKNOWN_TOOL']);
            for (const row of rows) {
                if (known.has(row)) continue;
                const at = contractLines.findIndex((l) => l.startsWith('|') && l.includes(`\`${row}\``));
                if (at !== -1 && /\bLegacy\b/.test(contractLines[at] as string)) continue;
                fail(CONTRACT_DOC, at === -1 ? 1 : at + 1, 'error-parity', `§6 documents \`${row}\`, which neither src/wrapper-codes.ts nor src/zip-errors.ts knows — remove the row or mark it "Legacy"`);
            }
        }
    }

    // ── Rule: env-var-parity ──────────────────────────────────────
    {
        const serverJson = readOr('server.json');
        let declaredVars: string[] = [];
        if (serverJson === null) {
            fail('server.json', 1, 'env-var-parity', 'missing — it declares every operator variable');
        } else {
            try {
                declaredVars = serverJsonEnvVars(serverJson);
            } catch {
                declaredVars = []; // manifest-shape reports invalid JSON
            }
        }
        const sourceVars = sourceEnvVars(root);
        const operatorVars = [...new Set([...sourceVars, ...declaredVars])];
        const known = new Set([...operatorVars, ...UNDECLARED_ENV_VARS]);
        for (const v of declaredVars) {
            if (!sourceVars.includes(v) && serverJson !== null) {
                fail('server.json', lineOf(serverJson, serverJson.indexOf(`"${v}"`)), 'env-var-parity', `declares ${v}, which no file under src/ reads — remove it or wire it`);
            }
        }
        for (const doc of ENV_VAR_DOCS) {
            const text = readDoc(doc, 'env-var-parity', 'every operator variable is documented there');
            if (text === null) continue;
            const absent = operatorVars.filter((v) => !text.includes(v));
            if (absent.length > 0) fail(doc, 1, 'env-var-parity', `does not name ${absent.join(', ')} — every operator variable the server reads is documented`);
        }
        for (const file of DOC_FILES) {
            const text = texts.get(file)!;
            const lines = text.split(/\r?\n/);
            for (const token of envVarTokens(text)) {
                if (known.has(token)) continue;
                const line = lineOf(text, text.indexOf(token));
                if (isSuppressed(lines, line, 'env-var-parity')) continue;
                fail(rel(file), line, 'env-var-parity', `${token} is not an operator variable the server reads — a planned variable is marked \`verify-docs:allow env-var-parity\``);
            }
        }
        // The source reads no operator variable that server.json hides.
        if (serverJson !== null) {
            for (const file of walk(join(root, 'src'), (p) => p.endsWith('.ts'))) {
                const text = read(file);
                for (const token of envVarTokens(text)) {
                    if (!declaredVars.includes(token) && !UNDECLARED_ENV_VARS.includes(token)) {
                        fail(rel(file), lineOf(text, text.indexOf(token)), 'env-var-parity', `${token} is read by the source but server.json does not declare it`);
                    }
                }
            }
        }
    }

    // ── Rule: changelog-ladder ────────────────────────────────────
    {
        const changelog = readDoc('CHANGELOG.md', 'changelog-ladder', 'every release has its entry and compare link');
        if (changelog !== null) {
            for (const f of checkChangelogLadder(changelog)) fail('CHANGELOG.md', f.line, 'changelog-ladder', f.message);
            if (selfVersion !== '' && !new RegExp(`^## \\[${escapeRegExp(selfVersion)}\\]`, 'm').test(changelog)) {
                fail('CHANGELOG.md', 1, 'changelog-ladder', `has no "## [${selfVersion}]" entry — release-notes/v${selfVersion}.md is mirrored into it`);
            }
        }
        if (selfVersion !== '' && !existsSync(join(root, 'release-notes', `v${selfVersion}.md`))) {
            fail(`release-notes/v${selfVersion}.md`, 1, 'changelog-ladder', 'missing — a release note is mandatory for every version');
        }
    }

    // ── Rule: claude-md-budget ────────────────────────────────────
    {
        const MAX_LINE = 240;
        const budgets: Array<{ file: string; maxLines?: number; maxBytes?: number; firstLine?: string }> = [
            { file: 'CLAUDE.md', maxLines: 120, firstLine: '@AGENTS.md' },
            { file: 'AGENTS.md', maxLines: 120 },
            { file: '.github/copilot-instructions.md', maxBytes: 16384 },
        ];
        for (const budget of budgets) {
            const text = readDoc(budget.file, 'claude-md-budget', 'every agent entry file must exist');
            if (text === null) continue;
            const lines = text.replace(/\r\n/g, '\n').split('\n');
            const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
            if (budget.maxLines !== undefined && lineCount > budget.maxLines) {
                fail(budget.file, 1, 'claude-md-budget', `${lineCount} lines — the budget is ${budget.maxLines}; move detail to .github/instructions/ or docs/`);
            }
            const bytes = Buffer.byteLength(text, 'utf8');
            if (budget.maxBytes !== undefined && bytes > budget.maxBytes) {
                fail(budget.file, 1, 'claude-md-budget', `${bytes} bytes — the budget is ${budget.maxBytes}; move detail to .github/instructions/`);
            }
            lines.forEach((line, i) => {
                if (line.length > MAX_LINE) fail(budget.file, i + 1, 'claude-md-budget', `line is ${line.length} characters — the limit is ${MAX_LINE}`);
            });
            if (budget.firstLine !== undefined) {
                const first = lines.find((l) => l.trim() !== '')?.trim();
                if (first !== budget.firstLine) {
                    fail(budget.file, 1, 'claude-md-budget', `first non-empty line is "${first ?? ''}" — it must be "${budget.firstLine}" so Claude Code loads AGENTS.md instead of a fork of it`);
                }
            }
        }
    }

    // ── Rule: governance-sources ──────────────────────────────────
    {
        const text = readOr('.github/ai-governance.json');
        const MAX_SOURCES_BYTES = 16 * 1024;
        if (text === null) {
            fail('.github/ai-governance.json', 1, 'governance-sources', 'missing — agents read it as the machine-readable policy');
        } else {
            let policy: { capability_manifest?: { sources?: unknown; on_demand?: unknown } } = {};
            try {
                policy = JSON.parse(text) as typeof policy;
            } catch (err) {
                fail('.github/ai-governance.json', 1, 'governance-sources', `not valid JSON — ${(err as Error).message}`);
            }
            const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
            let total = 0;
            for (const [list, entries] of [['sources', asPaths(policy.capability_manifest?.sources)], ['on_demand', asPaths(policy.capability_manifest?.on_demand)]] as const) {
                for (const p of entries) {
                    const full = join(root, p);
                    if (!existsSync(full)) {
                        if (isExpectedDocument(p)) skip(p, 'governance-sources', `not present yet — .github/ai-governance.json capability_manifest.${list} names it`);
                        else fail('.github/ai-governance.json', lineOf(text, Math.max(0, text.indexOf(`"${p}"`))), 'governance-sources', `capability_manifest.${list} names "${p}", which does not exist`);
                    } else if (list === 'sources' && statSync(full).isFile()) {
                        total += statSync(full).size;
                    }
                }
            }
            if (total >= MAX_SOURCES_BYTES) {
                fail('.github/ai-governance.json', 1, 'governance-sources', `capability_manifest.sources total ${total} bytes — the always-loaded set must stay under ${MAX_SOURCES_BYTES}; move a file to on_demand`);
            }
        }
    }

    // ── Rule: node-pin-parity ─────────────────────────────────────
    {
        const nvmrc = readOr('.nvmrc');
        let pinnedMajor: number | null = null;
        if (nvmrc === null) {
            fail('.nvmrc', 1, 'node-pin-parity', 'missing — every workflow reads its Node version from it');
        } else {
            const m = /^v?(\d+)/.exec(nvmrc.trim());
            if (!m) fail('.nvmrc', 1, 'node-pin-parity', `"${nvmrc.trim()}" is not a Node version`);
            else pinnedMajor = Number(m[1]);
        }
        if (pkgJson !== null) {
            const enginesMajor = /(\d+)/.exec(pkgJson.engines?.node ?? '')?.[1];
            if (enginesMajor === undefined) {
                fail('package.json', 1, 'node-pin-parity', 'engines.node is missing or names no major version');
            } else if (pinnedMajor !== null && Number(enginesMajor) !== pinnedMajor) {
                fail('package.json', 1, 'node-pin-parity', `engines.node "${pkgJson.engines?.node}" but .nvmrc pins ${pinnedMajor} — the two majors must agree`);
            }
            if (typeof pkgJson.packageManager !== 'string' || !pkgJson.packageManager.startsWith('npm@')) {
                fail('package.json', 1, 'node-pin-parity', `packageManager must be present and start with "npm@" (found ${JSON.stringify(pkgJson.packageManager ?? null)})`);
            }
        }
        const WORKFLOWS = join(root, '.github', 'workflows');
        if (existsSync(WORKFLOWS)) {
            for (const name of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
                const relPath = `.github/workflows/${name}`;
                const text = read(join(WORKFLOWS, name));
                const uses = [...text.matchAll(/uses:\s*actions\/setup-node@/g)];
                if (uses.length === 0) continue;
                const withFile = [...text.matchAll(/node-version-file:\s*\.nvmrc\b/g)].length;
                if (withFile >= uses.length) continue;
                const matrix = /node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/.test(text) && /node-version:\s*\[([^\]]*)\]/.exec(text);
                if (matrix) {
                    const majors = (matrix[1] as string).split(',').map((s) => Number(s.trim().replace(/['"]/g, '')));
                    if (name === 'ci.yml' && pinnedMajor !== null && !majors.includes(pinnedMajor)) {
                        fail(relPath, lineOf(text, matrix.index), 'node-pin-parity', `matrix [${(matrix[1] as string).trim()}] does not include the .nvmrc major ${pinnedMajor}`);
                    }
                    // A matrix job may name versions; every other setup-node step of the file still reads the pin.
                    const literals = [...text.matchAll(/^\s*node-version:\s*['"]?([^'"\s$[][^'"\n]*)['"]?\s*$/gm)];
                    for (const lit of literals) {
                        const major = /^(\d+)\s*$/.exec(lit[1] as string)?.[1];
                        if (major !== undefined && pinnedMajor !== null && Number(major) > pinnedMajor) continue;
                        fail(relPath, lineOf(text, lit.index ?? 0), 'node-pin-parity', `node-version: ${(lit[1] as string).trim()} — a non-matrix setup-node step must read \`node-version-file: .nvmrc\``);
                    }
                    continue;
                }
                // A forward probe names a major ABOVE the pin on purpose: the pin is the floor CI proves, a newer line is a canary.
                const literal = /node-version:\s*['"]?(\d+)['"]?\s*$/m.exec(text);
                if (literal && pinnedMajor !== null && Number(literal[1]) > pinnedMajor) continue;
                fail(relPath, lineOf(text, (uses[0] as RegExpMatchArray).index ?? 0), 'node-pin-parity', 'actions/setup-node must read `node-version-file: .nvmrc` (only a matrix job, or a probe of a major above the pin, may name versions)');
            }
        }
        const ciMatrix = /node-version:\s*\[([^\]]*)\]/.exec(readOr('.github/workflows/ci.yml') ?? '')?.[1]
            ?.split(',').map((s) => Number(s.trim().replace(/['"]/g, ''))).filter((n) => Number.isFinite(n)) ?? [];
        report(checkNodeVersionPin({ nodeVersion: readOr('.node-version'), enginesNode: pkgJson?.engines?.node ?? null, ciMatrix }), 'node-pin-parity');
    }

    // ── Rule: ruleset-parity ──────────────────────────────────────
    if (!existsSync(join(root, '.github', 'rulesets'))) {
        skip('.github/rulesets', 'ruleset-parity', 'not present yet — .github/rulesets/main.json (required status checks) and tags.json (tag protection) are the committed copies of the GitHub rulesets');
    } else {
        const text = readOr('.github/rulesets/main.json');
        if (text === null) {
            fail('.github/rulesets/main.json', 1, 'ruleset-parity', 'missing — the committed copy of the main-branch ruleset (required status checks)');
        } else {
            let ruleset: { rules?: Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }> } = {};
            let parsed = true;
            try {
                ruleset = JSON.parse(text) as typeof ruleset;
            } catch (err) {
                parsed = false;
                fail('.github/rulesets/main.json', 1, 'ruleset-parity', `not valid JSON — ${(err as Error).message}`);
            }
            if (parsed) {
                const WORKFLOWS = join(root, '.github', 'workflows');
                const workflowTexts = existsSync(WORKFLOWS) ? readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => read(join(WORKFLOWS, f))) : [];
                const { jobs, matrixValues } = workflowJobs(workflowTexts);
                const contexts: string[] = [];
                for (const rule of ruleset.rules ?? []) {
                    if (rule.type !== 'required_status_checks') continue;
                    for (const check of rule.parameters?.required_status_checks ?? []) {
                        if (typeof check.context === 'string') contexts.push(check.context);
                    }
                }
                if (contexts.length === 0) fail('.github/rulesets/main.json', 1, 'ruleset-parity', 'declares no required status check — a PR to main could merge red');
                for (const context of contexts) {
                    if (jobs.has(context)) continue;
                    const m = /^(.+?)\s*\((.+)\)$/.exec(context);
                    if (m && jobs.has(m[1] as string) && (m[2] as string).split(',').every((v) => matrixValues.get(m[1] as string)?.has(v.trim()))) continue;
                    fail('.github/rulesets/main.json', lineOf(text, Math.max(0, text.indexOf(`"${context}"`))), 'ruleset-parity', `required status check "${context}" names no job in .github/workflows/ — every PR to main would block on it`);
                }
                // The two regression gates of what the server writes must block merges.
                for (const [prefix, why] of REQUIRED_CHECK_PREFIXES) {
                    if (!contexts.some((c) => c === prefix || c.startsWith(`${prefix} (`))) {
                        fail('.github/rulesets/main.json', 1, 'ruleset-parity', `no required status check "${prefix}" — ${why}`);
                    }
                }
            }
        }
        report(checkTagRuleset(readOr('.github/rulesets/tags.json')), 'ruleset-parity');
    }

    // ── Rules: agent-config-parity, claude-rules-sync, claude-rules-budget,
    //           pr-template-parity, eol-lf, skills-shape ──────────────
    {
        const claudeMd = readOr('CLAUDE.md') ?? '';
        const settingsText = readOr('.claude/settings.json');
        if (settingsText === null) {
            skip('.claude/settings.json', 'agent-config-parity', 'not present yet — the shared Claude Code settings carry the HITL deny list and the guard hook');
        } else {
            const hookPath = join(root, '.claude', 'hooks', 'guard.mjs');
            const hookExists = existsSync(hookPath);
            const hookCheck = hookExists ? spawnSync(process.execPath, ['--check', hookPath], { encoding: 'utf8', windowsHide: true }) : null;
            const findings = checkAgentConfigParity({
                settingsText,
                claudeMd,
                hook: { exists: hookExists, checkStatus: hookCheck?.status ?? null, checkStderr: hookCheck?.stderr ?? '' },
            });
            for (const f of findings) {
                if (f.file === '.claude/hooks/guard.mjs' && !hookExists) skip(f.file, 'agent-config-parity', 'not present yet — settings.json wires it as the PreToolUse hook on Bash and PowerShell');
                else report([f], 'agent-config-parity');
            }
        }

        if (!existsSync(join(root, RULES_DIR))) {
            skip(RULES_DIR, 'claude-rules-sync', `not present yet — the generated projection of ${INSTRUCTIONS_DIR}/ (one scoped rule per instruction file)`);
        } else {
            const diff = diffClaudeRules(root);
            for (const bad of diff.invalid) fail(`${INSTRUCTIONS_DIR}/${bad.source}`, 1, 'claude-rules-sync', `${bad.error} — the generator refuses it`);
            for (const f of diff.missing) fail(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'missing — run `npm run agents:rules`');
            for (const f of diff.stale) fail(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'differs from its instruction file — edit the .github/instructions/ source, then run `npm run agents:rules`');
            for (const f of diff.extra) fail(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'has no instruction source — delete it, or add the .github/instructions/<area>.instructions.md it should come from');
        }

        if (readOr('CLAUDE.md') !== null) {
            report(checkClaudeRulesBudget({ claudeMd, resolveImport: (name) => readOr(name), rules: readRuleFiles(root) }), 'claude-rules-budget');
        } else {
            skip('CLAUDE.md', 'claude-rules-budget', 'not present yet — the always-loaded context is CLAUDE.md, its @imports and the unscoped rules');
        }

        const contributing = readDoc('CONTRIBUTING.md', 'pr-template-parity', 'the PR template mirrors its "## Pull Request Checklist"');
        if (contributing !== null) {
            const gate = pkgJson?.scripts?.['gate'] !== undefined ? 'npm run gate' : null;
            report(checkPrTemplateParity(readOr(PR_TEMPLATE), contributing, gate), 'pr-template-parity');
        }

        // eol-lf — git checkouts only (the test sandbox is a plain directory).
        const gitOut = (...args: string[]): string | null => {
            const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
            return r.status === 0 ? r.stdout : null;
        };
        const top = gitOut('rev-parse', '--show-toplevel')?.trim().replace(/\\/g, '/');
        if (top !== undefined && top.toLowerCase() === resolve(root).replace(/\\/g, '/').toLowerCase()) {
            report(checkEol(gitOut('ls-files', '--eol') ?? ''), 'eol-lf');
        } else {
            skip('.git', 'eol-lf', 'not a git checkout root — the index line endings cannot be read');
        }

        const skillsDir = join(root, '.claude', 'skills');
        if (!existsSync(skillsDir)) {
            skip('.claude/skills', 'skills-shape', 'not present yet — no project skill to check');
        } else {
            for (const dir of readdirSync(skillsDir).sort()) {
                if (!statSync(join(skillsDir, dir)).isDirectory()) continue;
                // A skill that references a document not present yet is a skip, like every other reference to it.
                const findings = checkSkillShape({
                    dir,
                    text: readOr(`.claude/skills/${dir}/SKILL.md`),
                    existsInSkill: (name) => existsSync(join(skillsDir, dir, name)),
                    existsInRepo: (p) => existsSync(join(root, p)),
                });
                for (const f of findings) {
                    const expected = /references `([^`]+)`, which does not exist/.exec(f.message)?.[1];
                    if (expected !== undefined && isExpectedDocument(expected)) skip(expected, 'skills-shape', `not present yet — .claude/skills/${dir}/SKILL.md references it`);
                    else report([f], 'skills-shape');
                }
            }
        }
    }

    // ── The live release documents (the current note, the PR draft, the templates) ──
    const releaseDocs = ['CHANGELOG.md', PR_TEMPLATE, 'release-notes/TEMPLATE.md', 'release-notes/PR_TEMPLATE.md',
        '.github/drafts/TEMPLATE.md', '.github/drafts/README.md', `.github/drafts/pr-v${selfVersion}.md`]
        .map((p) => join(root, p)).filter((p) => existsSync(p));

    // ── Rule: internal-links ──────────────────────────────────────
    {
        const MD_LINK = /\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g;
        const linked = [...new Set([...DOC_FILES.filter((f) => f.endsWith('.md')), ...releaseDocs])];
        for (const file of linked) {
            const text = texts.get(file) ?? read(file);
            const lines = text.split(/\r?\n/);
            MD_LINK.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = MD_LINK.exec(text)) !== null) {
                const href = m[1] as string;
                if (/^(https?:|mailto:|data:|\/\/)/.test(href) || href.includes('${') || href.includes('<')) continue;
                const target = resolve(dirname(file), decodeURI(href));
                if (existsSync(target)) continue;
                const line = lineOf(text, m.index);
                if (isSuppressed(lines, line, 'internal-links')) continue;
                if (isExpectedDocument(rel(target))) skip(rel(target), 'internal-links', `not present yet — linked from ${rel(file)}:${line}`);
                else fail(rel(file), line, 'internal-links', `"${href}" does not resolve on disk`);
            }
        }
    }

    // ── Rule: anchor-parity ───────────────────────────────────────
    // Shipped release notes (release-notes/v*.md below the current version)
    // and shipped PR drafts are frozen history: their links were right
    // against the tree of their day and are never rewritten. The current
    // note, the current PR draft and the templates are live documents.
    {
        const corpusFiles = new Set([...DOC_FILES.filter((f) => f.endsWith('.md')), ...releaseDocs]);
        const anchorCache = new Map<string, ReadonlySet<string>>();
        const anchorsOf = (file: string): ReadonlySet<string> => {
            let set = anchorCache.get(file);
            if (set === undefined) {
                set = markdownAnchors(texts.get(file) ?? read(file));
                anchorCache.set(file, set);
            }
            return set;
        };
        const check = (from: string, line: number, target: string, fragment: string, lines: readonly string[]): void => {
            // A missing file is internal-links' finding; a non-Markdown target has no heading anchors to check.
            if (!existsSync(target) || !target.endsWith('.md')) return;
            if (isSuppressed(lines, line, 'anchor-parity')) return;
            if (!anchorsOf(target).has(decodeURIComponent(fragment).toLowerCase())) {
                fail(rel(from), line, 'anchor-parity', `"#${fragment}" is not a heading anchor of ${rel(target)}`);
            }
        };
        for (const file of corpusFiles) {
            const text = texts.get(file) ?? read(file);
            const lines = text.split(/\r?\n/);
            for (const link of fragmentLinks(text)) {
                const target = link.path === '' ? file : resolve(dirname(file), link.path);
                check(file, lineOf(text, link.index), target, link.fragment, lines);
            }
        }
        // The governance policy's `references.*` are read by agents as links: same rule.
        const policyText = readOr('.github/ai-governance.json');
        if (policyText !== null) {
            try {
                const policy = JSON.parse(policyText) as { references?: Record<string, unknown> };
                const policyLines = policyText.split(/\r?\n/);
                for (const [key, value] of Object.entries(policy.references ?? {})) {
                    if (typeof value !== 'string' || !value.includes('#')) continue;
                    const [path, fragment] = value.split('#', 2) as [string, string];
                    const at = policyText.indexOf(value);
                    const line = at >= 0 ? lineOf(policyText, at) : 1;
                    const target = join(root, path);
                    if (!existsSync(target)) {
                        if (isExpectedDocument(path)) skip(path, 'anchor-parity', `not present yet — .github/ai-governance.json references.${key} points into it`);
                        else fail('.github/ai-governance.json', line, 'anchor-parity', `references.${key} names "${path}", which does not exist`);
                        continue;
                    }
                    check(join(root, '.github', 'ai-governance.json'), line, target, fragment, policyLines);
                }
            } catch {
                // governance-sources reports invalid JSON.
            }
        }
    }

    // ── Rule: verified-on-parity ──────────────────────────────────
    for (const relPath of STAMPED_FILES) {
        const text = readDoc(relPath, 'verified-on-parity', `it carries a "Verified on ${manifest.verifiedOn}" stamp`);
        if (text === null) continue;
        const m = /(?:"verifiedOn"\s*:\s*"|Verified on )(\d{4}-\d{2}-\d{2})/.exec(text);
        if (!m) {
            fail(relPath, 1, 'verified-on-parity', `carries no "Verified on" stamp (manifest says ${manifest.verifiedOn})`);
        } else if (m[1] !== manifest.verifiedOn) {
            fail(relPath, lineOf(text, m.index), 'verified-on-parity', `stamped ${m[1]} but the manifest was verified on ${manifest.verifiedOn}`);
        }
    }

    // ── Rule: prose-language ──────────────────────────────────────
    {
        const releaseNotes = walk(join(root, 'release-notes'), (p) => p.endsWith('.md'));
        for (const file of [...new Set([...DOC_FILES, ...releaseNotes])]) {
            const text = texts.get(file) ?? read(file);
            for (const finding of findNonEnglishProse(text, file, { suppress: 'verify-docs:allow prose-language' })) {
                fail(rel(file), finding.line, 'prose-language',
                    `${finding.reason}: "${finding.snippet}" — write it in English, or mark demonstrated content with \`demo-language: <tag> (reason)\` on or above the line`);
            }
        }
    }

    // ── Rule: no-secret-material ──────────────────────────────────
    // Every document, example, release note, draft and data file: no test
    // token, no concrete bearer token, no registry / forge credential, no
    // PRIVATE KEY block with a body, no development-host path.
    {
        const needles = buildSecretNeedles(root);
        if (needles.length === 0) {
            skip('tests', 'no-secret-material', 'no token literal under tests/ — the needle table is empty (the pattern checks still run)');
        }
        const scanned = [...new Set([
            ...DOC_FILES,
            ...releaseDocs,
            ...walk(join(root, 'release-notes'), (p) => p.endsWith('.md')),
            ...walk(join(root, '.github', 'drafts'), (p) => p.endsWith('.md')),
            ...walk(join(root, 'examples'), (p) => p.endsWith('.json') || p.endsWith('.md')),
            ...walk(join(root, 'docs'), (p) => p.endsWith('.json')),
            ...['server.json', 'package.json', 'llms.txt', '.mcp.json', '.claude/settings.json'].map((p) => join(root, p)).filter((p) => existsSync(p)),
        ])];
        for (const file of scanned) {
            const text = texts.get(file) ?? read(file);
            const lines = text.split(/\r?\n/);
            for (const finding of findSecretMaterial(text, needles)) {
                const line = lineOf(text, finding.index);
                if (isSuppressed(lines, line, 'no-secret-material')) continue;
                fail(rel(file), line, 'no-secret-material', finding.reason);
            }
        }
    }

    // ── Rule: engine-data-parity ──────────────────────────────────
    {
        const engineVersion = engineInstalled ?? coreVersion;
        const source = engineInstalled !== null ? `node_modules/${ENGINE_PACKAGE} (${engineInstalled})` : `packages.${ENGINE_PACKAGE}.version of the manifest (${coreVersion})`;
        const dataDir = join(root, 'docs', 'data');
        for (const name of ENGINE_DATA_FILES) {
            const text = readOr(`docs/data/${name}`);
            if (text === null) {
                fail(`docs/data/${name}`, 1, 'engine-data-parity', `missing — the documents link the engine registry mirrored from ${ENGINE_PACKAGE} ${engineVersion}`);
            }
        }
        const zipErrorsText = readOr('src/zip-errors.ts') ?? '';
        for (const file of walk(dataDir, (p) => p.endsWith('.json'))) {
            const text = read(file);
            let data: { zipnativeVersion?: unknown; errors?: Array<{ code?: unknown }>; diagnostics?: Array<{ code?: unknown }>; exportCount?: unknown; exports?: unknown[] };
            try {
                data = JSON.parse(text) as typeof data;
            } catch (err) {
                fail(rel(file), 1, 'engine-data-parity', `not valid JSON — ${(err as Error).message}`);
                continue;
            }
            if (data.zipnativeVersion !== undefined && data.zipnativeVersion !== engineVersion) {
                const at = text.indexOf('"zipnativeVersion"');
                fail(rel(file), at === -1 ? 1 : lineOf(text, at), 'engine-data-parity', `pins zipnativeVersion ${String(data.zipnativeVersion)} but ${source} is the engine — regenerate the registry from the ${engineVersion} release`);
            }
            if (Array.isArray(data.errors) && Array.isArray(data.diagnostics) && zipErrorsText !== '') {
                const codes = (list: Array<{ code?: unknown }>): string[] => list.map((e) => e.code).filter((c): c is string => typeof c === 'string').sort();
                const expectCodes = [...zipErrorCodes(zipErrorsText)].sort();
                const expectDiags = [...zipDiagnosticCodes(zipErrorsText)].sort();
                const errorsIn = codes(data.errors);
                const diagsIn = codes(data.diagnostics);
                const delta = (have: string[], want: string[]): string => {
                    const missing = want.filter((c) => !have.includes(c));
                    const extra = have.filter((c) => !want.includes(c));
                    return [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unknown ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
                };
                if (JSON.stringify(errorsIn) !== JSON.stringify(expectCodes)) fail(rel(file), 1, 'engine-data-parity', `errors[] differs from ZIP_ERROR_CLASS of src/zip-errors.ts (${errorsIn.length} vs ${expectCodes.length}): ${delta(errorsIn, expectCodes)}`);
                if (JSON.stringify(diagsIn) !== JSON.stringify(expectDiags)) fail(rel(file), 1, 'engine-data-parity', `diagnostics[] differs from ZIP_DIAGNOSTIC_CODES of src/zip-errors.ts (${diagsIn.length} vs ${expectDiags.length}): ${delta(diagsIn, expectDiags)}`);
            }
            if (typeof data.exportCount === 'number' && Array.isArray(data.exports) && data.exports.length !== data.exportCount) {
                fail(rel(file), 1, 'engine-data-parity', `exportCount says ${data.exportCount} but exports[] has ${data.exports.length} rows`);
            }
        }
    }

    // ── Rule: verazip-counts ──────────────────────────────────────
    {
        const text = readOr('docs/data/verazip.json');
        if (text === null) {
            fail('docs/data/verazip.json', 1, 'verazip-counts', 'missing — it declares the corpus counts the documents quote');
        } else if (corpus === null) {
            skip('scripts/helpers/zip-corpus.mjs', 'verazip-counts', 'not present — the corpus definition the declaration is held to');
        } else {
            interface VerazipDeclaration {
                declared?: { conformant?: unknown; nonConformant?: unknown; hostileConformant?: unknown };
                checkIds?: unknown;
                requiredNegativeChecks?: unknown;
            }
            let declaration: VerazipDeclaration | null = null;
            try {
                declaration = JSON.parse(text) as VerazipDeclaration;
            } catch (err) {
                fail('docs/data/verazip.json', 1, 'verazip-counts', `not valid JSON — ${(err as Error).message}`);
            }
            if (declaration !== null) {
                const at = (key: string): number => Math.max(1, lineOf(text, Math.max(0, text.indexOf(`"${key}"`))));
                const want: Array<[string, unknown, number, string]> = [
                    ['conformant', declaration.declared?.conformant, corpus.corpusConformant, 'conformant archives'],
                    ['nonConformant', declaration.declared?.nonConformant, corpus.corpusNonConformant, 'crafted negatives'],
                    ['hostileConformant', declaration.declared?.hostileConformant, corpus.corpusHostileConformant, 'hostile-but-conformant archives'],
                ];
                for (const [key, stated, actual, what] of want) {
                    if (stated !== actual) fail('docs/data/verazip.json', at(key), 'verazip-counts', `declared.${key} is ${String(stated)} but scripts/helpers/zip-corpus.mjs defines ${actual} ${what}`);
                }
                if (declaration.checkIds !== corpus.checkIds) {
                    fail('docs/data/verazip.json', at('checkIds'), 'verazip-counts', `checkIds is ${String(declaration.checkIds)} but scripts/verazip-core.mjs CHECK_IDS has ${corpus.checkIds}`);
                }
                if (JSON.stringify(declaration.requiredNegativeChecks ?? null) !== JSON.stringify(corpus.requiredNegativeChecks)) {
                    fail('docs/data/verazip.json', at('requiredNegativeChecks'), 'verazip-counts', `requiredNegativeChecks differs from scripts/verazip-core.mjs REQUIRED_NEGATIVE_CHECKS [${corpus.requiredNegativeChecks.join(', ')}]`);
                }
                for (const [key, value] of [['corpusConformant', corpus.corpusConformant], ['corpusNonConformant', corpus.corpusNonConformant]] as const) {
                    if (manifest.derived[key] !== undefined && manifest.derived[key] !== value) {
                        fail(MANIFEST_REL, 1, 'verazip-counts', `derived.${key} says ${String(manifest.derived[key])} but the corpus defines ${value}`);
                    }
                }
            }
            // Every corpus figure the documents quote (the D-002 vocabulary of tests/docs-consistency.test.ts).
            const conformant = corpus.corpusConformant;
            const negatives = corpus.corpusNonConformant;
            const hostile = corpus.corpusHostileConformant;
            const total = conformant + negatives;
            const docs = [...VERAZIP_DOCS, `release-notes/v${selfVersion}.md`];
            for (const doc of docs) {
                const body = readOr(doc);
                if (body === null) {
                    if (isExpectedDocument(doc)) skip(doc, 'verazip-counts', 'not present yet — it quotes the corpus figures');
                    continue;
                }
                const lines = body.split(/\r?\n/);
                lines.forEach((l, i) => {
                    const n = i + 1;
                    if (isSuppressed(lines, n, 'verazip-counts') || isSuppressed(lines, n, 'stale-token')) return;
                    const bad = (quote: string, expected: string): void => fail(doc, n, 'verazip-counts', `"${quote}" — the corpus has ${expected}`);
                    for (const m of l.matchAll(/\b(\d+|three|four|five|six|seven) hostile-but-conformant/gi)) {
                        if (parseCount(m[1] as string) !== hostile) bad(m[0], `${hostile} hostile-but-conformant archives`);
                    }
                    for (const m of l.matchAll(/(?<![-\d.:])\b(\d+) (?:archives|conformant)\b/g)) {
                        const found = Number(m[1]);
                        if (found >= 1900 && found <= 2100) continue; // "ISO/IEC 21320-1:2015 conformant"
                        if (found !== total && found !== conformant) bad(m[0], `${total} archives, ${conformant} conformant`);
                    }
                    if (/PASS|XFAIL|corpus|archives/.test(l)) {
                        for (const m of l.matchAll(/\bof (\d+)\b(?! bytes)/g)) if (Number(m[1]) !== total) bad(m[0], `${total} archives`);
                    }
                    for (const m of l.matchAll(/\b(\d+|four|five|six) (?:raw-crafted |crafted )?(?:negative canaries|negatives|non-conformant)/gi)) {
                        if (parseCount(m[1] as string) !== negatives) bad(m[0], `${negatives} crafted negatives`);
                    }
                    for (const m of l.matchAll(/\b(\d+) (PASS|XFAIL)\b/g)) {
                        const expected = m[2] === 'PASS' ? conformant : negatives;
                        if (Number(m[1]) !== expected) bad(m[0], `${expected} ${m[2]}`);
                    }
                });
            }
        }
    }

    // ── Rule: npm-drift (--online only) ───────────────────────────
    if (options.online) {
        for (const [name, pkg] of Object.entries(manifest.packages)) {
            try {
                const res = await fetch(`https://registry.npmjs.org/${name}/latest`);
                if (!res.ok) {
                    warn(MANIFEST_REL, 1, 'npm-drift', `registry returned ${res.status} for ${name}`);
                    continue;
                }
                const data = (await res.json()) as Record<string, Record<string, string> | string>;
                const published = data['version'] as string;
                if (published !== pkg.version) {
                    const docsBehind = semverLess(pkg.version, published);
                    const reportFn = options.strict && docsBehind ? fail : warn;
                    reportFn(MANIFEST_REL, 1, 'npm-drift', `${name} is ${published} on npm but the manifest says ${pkg.version}`);
                }
                if (pkg.pinField) {
                    const field = data[pkg.pinField] as Record<string, string> | undefined;
                    const actualPin = field?.[ENGINE_PACKAGE];
                    if (actualPin && actualPin !== pkg.pin) {
                        const reportFn = options.strict ? fail : warn;
                        reportFn(MANIFEST_REL, 1, 'npm-drift', `${name} pins ${ENGINE_PACKAGE} ${actualPin} but the manifest says ${pkg.pin}`);
                    }
                }
            } catch (err) {
                warn(MANIFEST_REL, 1, 'npm-drift', `could not reach the registry for ${name}: ${(err as Error).message}`);
            }
        }
    } else {
        skips.push({ file: MANIFEST_REL, rule: 'npm-drift', message: 'offline — pass --online to compare the manifest with the npm registry' });
    }

    return { problems, skips, rules: rulesRun, files: DOC_FILES.length, verifiedOn: manifest.verifiedOn ?? null };
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = new Set(['--online', '--strict', '--require-all', '--json', '--rules', '--verbose', '--only']);

export function formatRules(): string {
    const width = Math.max(...RULES.map((r) => r.id.length));
    return RULES.map((r) => `${r.id.padEnd(width)}  ${r.description}`).join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
    const root = resolve(import.meta.dirname, '..');
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (!FLAGS.has(arg)) {
            console.error(`verify-docs: unknown argument "${arg}" — flags: ${[...FLAGS].join(' ')}`);
            return 2;
        }
        if (arg === '--only') i++;
    }
    if (argv.includes('--rules')) {
        console.log(formatRules());
        return 0;
    }
    let only: string | undefined;
    const onlyAt = argv.indexOf('--only');
    if (onlyAt !== -1) {
        only = argv[onlyAt + 1];
        if (only === undefined || !ALL_RULES.includes(only)) {
            console.error(`verify-docs: --only needs one of: ${ALL_RULES.join(', ')}`);
            return 2;
        }
    }
    const online = argv.includes('--online');
    const strict = argv.includes('--strict');
    const requireAll = argv.includes('--require-all');
    const jsonOut = argv.includes('--json');
    const table = argv.includes('--verbose') || process.stdout.isTTY === true;
    const { problems, skips, rules, files, verifiedOn } = await verifyDocs(root, { online, strict, requireAll, ...(only !== undefined ? { only } : {}) });
    const errors = problems.filter((p) => p.severity === 'error');
    const warnings = problems.filter((p) => p.severity === 'warn');

    if (jsonOut) {
        console.log(JSON.stringify({ ok: errors.length === 0, problems, skips, rules, files, verifiedOn }, null, 2));
        return errors.length > 0 ? 1 : 0;
    }
    const skipNote = skips.length === 0 ? '' : `, ${skips.length} skipped (${[...new Set(skips.map((s) => s.rule))].join(', ')})`;
    const byFile = new Map<string, Problem[]>();
    for (const p of errors) {
        if (!byFile.has(p.file)) byFile.set(p.file, []);
        byFile.get(p.file)!.push(p);
    }
    if (errors.length === 0) {
        const perRule = new Map<string, number>();
        for (const w of warnings) perRule.set(w.rule, (perRule.get(w.rule) ?? 0) + 1);
        const suffix = warnings.length === 0 ? '' : ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${[...perRule.entries()].map(([r, n]) => `${r} ×${n}`).join(', ')})`;
        if (table) {
            for (const s of skips) console.log(`  - skip [${s.rule}] ${s.file}: ${s.message}`);
        }
        console.log(`verify-docs: ${rules.length} rule${rules.length === 1 ? '' : 's'} passed across ${files} files${suffix}${skipNote} — source of truth ${MANIFEST_REL} (verified ${verifiedOn ?? '?'}).`);
        return 0;
    }
    if (table) {
        // On failure, list the errors only: warnings would bury them. They stay in --json and in the summary count.
        for (const [file, list] of [...byFile.entries()].sort()) {
            console.log(`\n${file}`);
            for (const p of list.sort((a, b) => a.line - b.line)) {
                console.log(`  ✗ ${String(p.line).padStart(5)}  [${p.rule}]  ${p.message}`);
            }
        }
        if (skips.length > 0) {
            console.log('\nskipped (input not present yet; --require-all makes them errors):');
            for (const s of skips) console.log(`  - [${s.rule}] ${s.file}: ${s.message}`);
        }
        console.log('');
    } else {
        for (const p of errors) console.log(`${p.file}:${p.line} [${p.rule}] ${p.message}`);
    }
    const ruleSet = new Set(errors.map((p) => p.rule));
    console.log(
        `verify-docs: ${errors.length} problem${errors.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'} (${ruleSet.size} rule${ruleSet.size === 1 ? '' : 's'})` +
            (warnings.length > 0 ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '') +
            `${skipNote} — fix the docs, or update ${MANIFEST_REL} if the manifest is what is wrong.`,
    );
    return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exit(await main(process.argv.slice(2)));
}
