/**
 * zipnative-mcp — the server surface, derived from the source tree
 * ================================================================
 * `docs/assets/ecosystem.json` quotes counts the docs repeat in prose: how
 * many tools, prompts, wrapper codes, frozen `ZIP_*` codes, diagnostics,
 * `ZipLimits` keys, operator variables, examples, samples, corpus entries.
 * None of those figures is hand-maintained here: they are read from the
 * files the server is built from — the `<NAME>_NAME` constants under
 * `src/tools/`, the `TOOLS` registry of `src/server.ts` (its `name:` rows in
 * registration order), the `PROMPTS` table of the same file, every
 * `ToolError('CODE'` literal under `src/`, the `WRAPPER_CODES` table of
 * `src/wrapper-codes.ts`, the `ZIP_ERROR_CLASS` / `ZIP_DIAGNOSTIC_CODES`
 * tables of `src/zip-errors.ts`, the `LIMITS_INPUT_SCHEMA` of
 * `src/limits.ts`, every `ZIPNATIVE_MCP_*` token under `src/` — and from
 * directory walks for the examples, the tests and the sample baseline.
 *
 * Scripts never import `src/` (scripts/helpers/server.ts), and `verify:docs`
 * runs before any build: every parser below is a pure function over text,
 * unit-tested in tests/tools/mcp-surface.test.ts. `computeDerived()` and the
 * `…(root)` readers are the functions that touch the filesystem. Ported from
 * pkinative-mcp 1.0.0 (which reads a split registry of group files); the zip
 * server keeps one flat `TOOLS` array in src/server.ts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The operator-variable prefix (every variable the server reads). */
export const ENV_PREFIX = 'ZIPNATIVE_MCP_';

/**
 * Tokens shaped like an operator variable that are not one: the version
 * constant of src/version.ts and the test-only slow-suite switch.
 */
export const NON_OPERATOR_ENV_TOKENS: readonly string[] = ['ZIPNATIVE_MCP_VERSION', 'ZIPNATIVE_MCP_SLOW_TESTS'];

// ── Pure parsers ─────────────────────────────────────────────────────

/** `export const CREATE_ZIP_NAME = 'create_zip';` → `['CREATE_ZIP_NAME', 'create_zip']`, or null. */
export function toolNameConstant(toolModuleText: string): readonly [string, string] | null {
    const m = /^export const ([A-Z][A-Z0-9_]*_NAME)\s*=\s*'([a-z][a-z0-9_]*)'\s*;/m.exec(toolModuleText);
    return m ? [m[1] as string, m[2] as string] : null;
}

/** The text of a top-level `const NAME… = [` … `];` table, or null. */
function tableText(text: string, name: string): string | null {
    const start = text.search(new RegExp(`^(?:export )?const ${name}\\b[^=\\n]*=\\s*\\[`, 'm'));
    if (start === -1) return null;
    const rest = text.slice(start);
    const end = rest.search(/^\];/m);
    return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The `name:` rows of the `TOOLS` registry, in registration order: either a
 * `<NAME>_NAME` constant (resolved by the caller through src/tools/) or a
 * string literal. Only rows at the entry's own indentation (8 spaces) count,
 * so a nested `name:` (an example input) never does.
 */
export function registryToolRefs(serverText: string): string[] {
    const table = tableText(serverText, 'TOOLS');
    if (table === null) return [];
    return [...table.matchAll(/^ {8}name:\s*(?:([A-Z][A-Z0-9_]*_NAME)|'([a-z][a-z0-9_]*)')\s*,/gm)].map((m) => (m[1] ?? m[2]) as string);
}

/** The `name: '<prompt>'` entries of the `PROMPTS` table. */
export function promptNames(serverText: string): string[] {
    const table = tableText(serverText, 'PROMPTS');
    if (table === null) return [];
    return [...table.matchAll(/^ {8}name:\s*'([a-z][a-z0-9_]*)'\s*,/gm)].map((m) => m[1] as string);
}

/** Every `ToolError('CODE'` literal of one source text (a line break after the parenthesis is allowed). */
export function toolErrorCodes(sourceText: string): string[] {
    return [...sourceText.matchAll(/ToolError\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string);
}

/** The fixed codes `src/errors.ts` subclasses pass through `super('CODE'`. */
export function subclassErrorCodes(errorsText: string): string[] {
    return [...errorsText.matchAll(/super\(\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string);
}

/** The `code: 'CODE'` rows of the wrapper-code table (`src/wrapper-codes.ts`), in table order. */
export function wrapperCodes(wrapperText: string): string[] {
    return [...new Set([...wrapperText.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string))];
}

/** The keys of `ZIP_ERROR_CLASS` (src/zip-errors.ts): the frozen `ZIP_*` error codes, in table order. */
export function zipErrorCodes(zipErrorsText: string): string[] {
    const start = zipErrorsText.search(/^export const ZIP_ERROR_CLASS\s*=\s*\{/m);
    if (start === -1) return [];
    const rest = zipErrorsText.slice(start);
    const end = rest.search(/^\}/m);
    const table = end === -1 ? rest : rest.slice(0, end);
    return [...new Set([...table.matchAll(/^\s+(ZIP_[A-Z0-9_]+)\s*:\s*'/gm)].map((m) => m[1] as string))];
}

/** The entries of `ZIP_DIAGNOSTIC_CODES` (src/zip-errors.ts), in table order; comments are skipped. */
export function zipDiagnosticCodes(zipErrorsText: string): string[] {
    const table = tableText(zipErrorsText, 'ZIP_DIAGNOSTIC_CODES');
    if (table === null) return [];
    const out: string[] = [];
    for (const line of table.split(/\r?\n/)) {
        if (/^\s*(?:\/\/|\*)/.test(line)) continue;
        for (const m of line.matchAll(/'(ZIP_[A-Z0-9_]+)'/g)) if (!out.includes(m[1] as string)) out.push(m[1] as string);
    }
    return out;
}

/** The `ZipLimits` keys of `LIMITS_INPUT_SCHEMA` (src/limits.ts): the JSON-Schema `maxX: { type: … }` rows. */
export function limitKeys(limitsText: string): string[] {
    return [...new Set([...limitsText.matchAll(/^\s+(max[A-Z][A-Za-z]*):\s*\{\s*type:/gm)].map((m) => m[1] as string))];
}

/** The first-column codes of the `## 6. Error reference` section of the agent contract (every table of it). */
export function contractErrorRows(contractText: string): string[] {
    const start = contractText.search(/^## 6\. /m);
    if (start === -1) return [];
    const rest = contractText.slice(start + 1);
    const end = rest.search(/^## /m);
    const section = end === -1 ? rest : rest.slice(0, end);
    const out: string[] = [];
    for (const line of section.split(/\r?\n/)) {
        const cell = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1];
        if (cell === undefined) continue;
        for (const m of cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) out.push(m[1] as string);
    }
    return [...new Set(out)];
}

/** Every backticked lower_snake token with an underscore — the shape of a tool name — in a text. */
export function snakeTokens(text: string): string[] {
    return [...new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1] as string))];
}

/** Every operator-variable token (`ZIPNATIVE_MCP_*`) in a text. */
export function envVarTokens(text: string): string[] {
    return [...new Set([...text.matchAll(/\bZIPNATIVE_MCP_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g)].map((m) => m[0]))];
}

/** The `environmentVariables[].name` list of the packages of `server.json`. */
export function serverJsonEnvVars(serverJsonText: string): string[] {
    const parsed = JSON.parse(serverJsonText) as { packages?: Array<{ environmentVariables?: Array<{ name?: unknown }> }> };
    const out: string[] = [];
    for (const pkg of parsed.packages ?? []) {
        for (const v of pkg.environmentVariables ?? []) if (typeof v.name === 'string' && !out.includes(v.name)) out.push(v.name);
    }
    return out;
}

/** The numbered rows of the `## 1. Tool catalogue` table: backticked name in the second column. */
export function contractCatalogueTools(contractText: string): string[] {
    const start = contractText.search(/^## 1\. /m);
    if (start === -1) return [];
    const rest = contractText.slice(start + 1);
    const end = rest.search(/^## /m);
    const section = end === -1 ? rest : rest.slice(0, end);
    const out: string[] = [];
    for (const line of section.split(/\r?\n/)) {
        const m = /^\|\s*\d+\s*\|\s*`([a-z][a-z0-9_]*)`/.exec(line);
        if (m) out.push(m[1] as string);
    }
    return out;
}

/** `[1.1.0]: https://…/compare/v1.0.0...v1.1.0` → `{ label, from, to }` per link definition, in file order. */
export interface CompareLink {
    readonly label: string;
    readonly from: string | null;
    readonly to: string;
    readonly line: number;
}

export function changelogCompareLinks(changelogText: string): CompareLink[] {
    const out: CompareLink[] = [];
    changelogText.split(/\r?\n/).forEach((text, i) => {
        const compare = /^\[([^\]]+)\]:\s*\S+\/compare\/(\S+?)\.\.\.(\S+)\s*$/.exec(text);
        if (compare) {
            out.push({ label: compare[1] as string, from: compare[2] as string, to: compare[3] as string, line: i + 1 });
            return;
        }
        const tag = /^\[([^\]]+)\]:\s*\S+\/releases\/tag\/(\S+)\s*$/.exec(text);
        if (tag) out.push({ label: tag[1] as string, from: null, to: tag[2] as string, line: i + 1 });
    });
    return out;
}

/** `## [1.1.0] - 2026-11-01` / `## [Unreleased]` headings, in file order. */
export function changelogHeadings(changelogText: string): Array<{ label: string; line: number }> {
    const out: Array<{ label: string; line: number }> = [];
    changelogText.split(/\r?\n/).forEach((text, i) => {
        const m = /^## \[([^\]]+)\]/.exec(text);
        if (m) out.push({ label: m[1] as string, line: i + 1 });
    });
    return out;
}

export interface LadderFinding {
    readonly line: number;
    readonly message: string;
}

/**
 * The compare-link ladder: every heading has a link definition, every link
 * compares the previous heading's tag with its own, and `[Unreleased]`
 * starts at the newest released tag. The first release has a tag link.
 */
export function checkChangelogLadder(changelogText: string): LadderFinding[] {
    const headings = changelogHeadings(changelogText);
    const links = new Map(changelogCompareLinks(changelogText).map((l) => [l.label, l] as const));
    const out: LadderFinding[] = [];
    const released = headings.filter((h) => h.label !== 'Unreleased');
    headings.forEach((h) => {
        const link = links.get(h.label);
        if (!link) {
            out.push({ line: h.line, message: `heading [${h.label}] has no link definition at the foot of the file` });
            return;
        }
        if (h.label === 'Unreleased') {
            const newest = released[0]?.label;
            if (newest !== undefined && (link.from !== `v${newest}` || link.to !== 'HEAD')) {
                out.push({ line: link.line, message: `[Unreleased] must compare v${newest}...HEAD — found ${link.from ?? '(tag link)'}...${link.to}` });
            }
            return;
        }
        const index = released.findIndex((r) => r.label === h.label);
        const previous = released[index + 1]?.label;
        if (link.to !== `v${h.label}`) out.push({ line: link.line, message: `[${h.label}] must end at v${h.label} — found ${link.to}` });
        if (previous !== undefined && link.from !== `v${previous}`) {
            out.push({ line: link.line, message: `[${h.label}] must compare v${previous}...v${h.label} — found ${link.from ?? '(tag link)'}...${link.to}` });
        }
    });
    for (const [label, link] of links) {
        if (!headings.some((h) => h.label === label)) out.push({ line: link.line, message: `link definition [${label}] has no heading` });
    }
    return out;
}

// ── Filesystem ───────────────────────────────────────────────────────

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

function readOr(path: string): string | null {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Tool names declared under `src/tools/`, keyed by their `<NAME>_NAME` constant. */
export function declaredTools(root: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const file of walk(join(root, 'src', 'tools'), (p) => p.endsWith('.ts'))) {
        const pair = toolNameConstant(readFileSync(file, 'utf8'));
        if (pair) out.set(pair[0], pair[1]);
    }
    return out;
}

/** The registered tool names, in `TOOLS` order (`tools/list` order), resolved through src/tools/. */
export function toolNames(root: string): string[] {
    const serverText = readOr(join(root, 'src', 'server.ts'));
    if (serverText === null) return [];
    const declared = declaredTools(root);
    const out: string[] = [];
    for (const ref of registryToolRefs(serverText)) {
        const name = /_NAME$/.test(ref) ? declared.get(ref) : ref;
        if (name !== undefined && !out.includes(name)) out.push(name);
    }
    return out;
}

/** Every `ToolError` code raised under `src/` (literals and the subclasses' fixed codes), sorted. */
export function errorCodes(root: string): string[] {
    const codes = new Set<string>();
    for (const file of walk(join(root, 'src'), (p) => p.endsWith('.ts'))) {
        for (const c of toolErrorCodes(readFileSync(file, 'utf8'))) codes.add(c);
    }
    const errorsText = readOr(join(root, 'src', 'errors.ts'));
    if (errorsText !== null) for (const c of subclassErrorCodes(errorsText)) codes.add(c);
    return [...codes].sort();
}

/** Every operator variable the source names (`ZIPNATIVE_MCP_*` under src/, the non-variables excluded), sorted. */
export function sourceEnvVars(root: string): string[] {
    const out = new Set<string>();
    for (const file of walk(join(root, 'src'), (p) => p.endsWith('.ts'))) {
        for (const t of envVarTokens(readFileSync(file, 'utf8'))) if (!NON_OPERATOR_ENV_TOKENS.includes(t)) out.add(t);
    }
    return [...out].sort();
}

function baselineEntryCount(root: string): number {
    const text = readOr(join(root, 'tests', '_fixtures', 'samples.sha256.json'));
    if (text === null) return 0;
    try {
        const parsed = JSON.parse(text) as { entries?: Record<string, unknown> };
        return Object.keys(parsed.entries ?? {}).length;
    } catch {
        return 0;
    }
}

export interface DerivedCounts {
    readonly tools: number;
    readonly prompts: number;
    readonly errorCodes: number;
    readonly wrapperCodes: number;
    readonly zipErrorCodes: number;
    readonly zipDiagnosticCodes: number;
    readonly limits: number;
    readonly envVars: number;
    readonly examples: number;
    readonly testFiles: number;
    readonly samples: number;
}

/** The figures a filesystem walk of the source tree derives (the corpus counts are `corpusFigures`). */
export function computeDerived(root: string): DerivedCounts {
    const serverText = readOr(join(root, 'src', 'server.ts')) ?? '';
    const zipErrorsText = readOr(join(root, 'src', 'zip-errors.ts')) ?? '';
    return {
        tools: toolNames(root).length,
        prompts: promptNames(serverText).length,
        errorCodes: errorCodes(root).length,
        wrapperCodes: wrapperCodes(readOr(join(root, 'src', 'wrapper-codes.ts')) ?? '').length,
        zipErrorCodes: zipErrorCodes(zipErrorsText).length,
        zipDiagnosticCodes: zipDiagnosticCodes(zipErrorsText).length,
        limits: limitKeys(readOr(join(root, 'src', 'limits.ts')) ?? '').length,
        envVars: sourceEnvVars(root).length,
        examples: walk(join(root, 'examples'), (p) => p.endsWith('.json')).length,
        testFiles: walk(join(root, 'tests'), (p) => p.endsWith('.test.ts')).length,
        samples: baselineEntryCount(root),
    };
}

export interface CorpusFigures {
    readonly corpusEntries: number;
    readonly corpusConformant: number;
    readonly corpusNonConformant: number;
    readonly corpusHostileConformant: number;
    readonly checkIds: number;
    readonly requiredNegativeChecks: readonly string[];
}

/**
 * The veraZIP corpus counts of the tree at `root`: `scripts/helpers/zip-corpus.mjs`
 * (`buildCorpus` with a stub `call` — the definition is declarative, nothing
 * runs) and the validator vocabulary of `scripts/verazip-core.mjs`. Null when
 * either module is absent (a synthetic tree, a partial checkout).
 */
export async function corpusFigures(root: string): Promise<CorpusFigures | null> {
    const corpusPath = join(root, 'scripts', 'helpers', 'zip-corpus.mjs');
    const corePath = join(root, 'scripts', 'verazip-core.mjs');
    if (!existsSync(corpusPath) || !existsSync(corePath)) return null;
    const { pathToFileURL } = await import('node:url');
    const corpus = (await import(pathToFileURL(corpusPath).href)) as typeof import('../helpers/zip-corpus.mjs');
    const core = (await import(pathToFileURL(corePath).href)) as typeof import('../verazip-core.mjs');
    const entries = corpus.buildCorpus({ call: () => Promise.reject(new Error('the corpus is only counted here')), sandboxDir: null });
    const counts = corpus.corpusCounts(entries);
    return {
        corpusEntries: entries.length,
        corpusConformant: counts.conformant,
        corpusNonConformant: counts.nonConformant,
        corpusHostileConformant: counts.hostileConformant,
        checkIds: core.CHECK_IDS.length,
        requiredNegativeChecks: [...core.REQUIRED_NEGATIVE_CHECKS],
    };
}
