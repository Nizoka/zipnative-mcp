#!/usr/bin/env tsx
/**
 * zipnative-mcp — Release preparation (ported from pkinative-mcp 1.0.0)
 * =====================================================================
 * Applies the mechanical part of a version bump in one pass, so a release
 * never spreads the same number across a dozen files edited by hand.
 *
 * What it edits, in order (every touched file is printed):
 *   1. package.json + package-lock.json `version` (root + `packages[""]`)
 *   2. src/version.ts `ZIPNATIVE_MCP_VERSION` and server.json `version`
 *      (top level and `packages[0]`) — the lock-step tests/metadata.test.ts asserts
 *   3. docs/assets/ecosystem.json `packages.zipnative-mcp.version` + `verifiedOn`,
 *      and the "Verified on" stamp of every file verify-docs holds to it
 *      (llms.txt, docs/KNOWLEDGE_BASE.md, docs/AGENT_CONTRACT.md)
 *   4. CITATION.cff `version` + `date-released`
 *   4b. CHANGELOG.md `## [X.Y.Z] - date` heading (when the entry exists) and
 *       .github/SECURITY-INSIGHTS.yml `last-updated` / `last-reviewed`
 *   5. SECURITY.md supported-versions table
 *   6. README.md engine badge (the engine version is the package.json
 *      dependency floor) and the `Current release X.Y.Z` prose of llms.txt,
 *      CLAUDE.md, AGENTS.md and .github/copilot-instructions.md
 *   7. release-notes/vX.Y.Z.md scaffolded from release-notes/TEMPLATE.md, and
 *      .github/drafts/pr-vX.Y.Z.md scaffolded from release-notes/PR_TEMPLATE.md
 *      (.github/drafts/TEMPLATE.md is the governance ISSUE template, not a PR one)
 *
 * A file that does not exist yet is reported as "not present" and skipped —
 * the documentation set grows release by release — while a file that exists
 * but lacks the pattern it owns is a problem (exit 1: edit by hand). The
 * engine badge and the `Current release` prose are optional: a present file
 * without them is skipped, not a problem.
 *
 * `TOOL_API_VERSION` (src/version.ts) is NOT bumped here: it moves only when
 * a schema or an error code changes, which is a reviewed decision
 * (docs/API_STABILITY.md), not a mechanical one.
 *
 * It never reserialises JSON or YAML: each edit is a targeted regex on the
 * one field it owns, so formatting, key order and comments survive and the
 * diff reads as the bump and nothing else.
 *
 * Usage:
 *   npx tsx scripts/release-prepare.ts --version 1.1.0
 *   npx tsx scripts/release-prepare.ts --version 1.1.0 --date 2026-11-01 --previous v1.0.0
 *   npx tsx scripts/release-prepare.ts --version 1.1.0 --dry-run
 *
 * (PowerShell swallows a bare `--`, so call the script directly rather than
 * going through `npm run release:prepare`.)
 *
 * Exit codes:
 *   0 — done, or the dry run reported what would change
 *   1 — a pattern a present file owns was not found
 *   2 — bad usage (invalid semver or date), or git could not name the previous tag
 *
 * The script writes files and nothing else: it never commits, tags, pushes or
 * publishes — those are the maintainer's steps.
 *
 * The pure functions are exported and covered by
 * tests/tools/release-prepare.test.ts; only `main()` touches git and disk.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The text of `file`, or null when it is absent — the read decides, never an existence check before it. */
function readIfPresent(file: string): string | null {
    try {
        return readFileSync(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
}

/** Progress goes to stdout through one writer (the lint config reserves `console` for warn / error). */
function say(line: string): void {
    process.stdout.write(`${line}\n`);
}

// ── Types ───────────────────────────────────────────────────────────

/** Result of one targeted edit. `text` equals the input when nothing changed. */
export interface Rewrite {
    readonly text: string;
    /** How many places the owning pattern was found — changed or already right. */
    readonly matched: number;
}

export interface Options {
    readonly version: string;
    readonly date: string;
    readonly previous: string | null;
    readonly dryRun: boolean;
}

// ── Small helpers ───────────────────────────────────────────────────

const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isSemver(v: string): boolean {
    return SEMVER.test(v);
}

export function isIsoDate(d: string): boolean {
    return ISO_DATE.test(d) && !Number.isNaN(Date.parse(d));
}

/** Today as YYYY-MM-DD in UTC — the same clock CI uses. */
export function todayUtc(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/** `v1.0.0` → `1.0.0`. */
export function stripTag(tag: string): string {
    return tag.replace(/^v/, '');
}

/** `1.7.3` → `1.7`. */
export function minorLine(version: string): string {
    return version.split('.').slice(0, 2).join('.');
}

/** Replace with a counter, so the caller learns whether the pattern existed at all. */
function replaceCounting(text: string, re: RegExp, replacement: (...groups: string[]) => string): Rewrite {
    let matched = 0;
    const out = text.replace(re, (...args: unknown[]) => {
        matched++;
        return replacement(...(args as string[]));
    });
    return { text: out, matched };
}

// ── 1. package.json / package-lock.json ─────────────────────────────

/**
 * The top-level `"version"` of an npm manifest sits at the file's base indent
 * (two or four spaces). Nested `version` keys — every dependency in the
 * lockfile — are deeper and are left alone: only the FIRST `"version"` at the
 * shallowest indent is the package's.
 */
export function bumpJsonVersion(text: string, version: string): Rewrite {
    return replaceCounting(text, /^( {2}| {4})("version":[ \t]*")([^"]*)(")/m, (_m, indent, a, _old, c) => `${indent}${a}${version}${c}`);
}

/** The lockfile carries the version twice: at the root and under `packages[""]`. */
export function bumpLockVersion(text: string, version: string): Rewrite {
    const root = bumpJsonVersion(text, version);
    const pkg = replaceCounting(
        root.text,
        /("packages":\s*\{\s*"":\s*\{[^}]*?"version":[ \t]*")([^"]*)(")/,
        (_m, a, _old, c) => `${a}${version}${c}`,
    );
    return { text: pkg.text, matched: root.matched + pkg.matched };
}

/** The `zipnative` dependency floor of package.json (`^1.1.0` → `1.1.0`), or null. */
export function engineVersion(packageJson: string): string | null {
    const m = /"dependencies":\s*\{[^}]*"zipnative":\s*"[\^~]?(\d+\.\d+\.\d+)"/.exec(packageJson);
    return m?.[1] ?? null;
}

// ── 2. src/version.ts and server.json ───────────────────────────────

/** `export const ZIPNATIVE_MCP_VERSION = '1.0.0';` */
export function bumpVersionTs(text: string, version: string): Rewrite {
    return replaceCounting(text, /(export const ZIPNATIVE_MCP_VERSION\s*=\s*['"])([^'"]*)(['"])/, (_m, a, _old, c) => `${a}${version}${c}`);
}

/**
 * server.json names the version at the top level and once per package entry.
 * Every `"version"` whose value is a plain semver triple is the server's own
 * (the registry schema has no other versioned field), so all of them move.
 */
export function bumpServerJson(text: string, version: string): Rewrite {
    return replaceCounting(text, /("version":[ \t]*")(\d+\.\d+\.\d+)(")/g, (_m, a, _old, c) => `${a}${version}${c}`);
}

// ── 3. ecosystem.json + "Verified on" stamps ────────────────────────

/** `packages.zipnative-mcp.version` and the top-level `verifiedOn`. */
export function bumpManifest(text: string, version: string, date: string): Rewrite {
    const v = replaceCounting(
        text,
        /("packages":\s*\{\s*"zipnative-mcp":\s*\{\s*"version":[ \t]*")([^"]*)(")/,
        (_m, a, _old, c) => `${a}${version}${c}`,
    );
    const d = replaceCounting(v.text, /^( {2}"verifiedOn":[ \t]*")([^"]*)(")/m, (_m, a, _old, c) => `${a}${date}${c}`);
    return { text: d.text, matched: v.matched + d.matched };
}

/**
 * The files whose `Verified on YYYY-MM-DD` stamp verify-docs holds to the
 * manifest's `verifiedOn` (scripts/verify-docs.ts `STAMPED_FILES`; the test
 * suite asserts the two lists agree).
 */
export const STAMPED_FILES: readonly string[] = ['llms.txt', 'docs/KNOWLEDGE_BASE.md', 'docs/AGENT_CONTRACT.md'];

/**
 * The entry-point artefacts carry a `Verified on YYYY-MM-DD` sentence that
 * verify-docs requires to equal the manifest's date exactly — bumping one
 * without the other fails the build.
 */
export function restampVerifiedOn(text: string, date: string): Rewrite {
    return replaceCounting(text, /(Verified on |"verifiedOn":[ \t]*")\d{4}-\d{2}-\d{2}/, (_m, a) => `${a}${date}`);
}

// ── 4. CITATION.cff ─────────────────────────────────────────────────

/**
 * The software's own `version:` — not `cff-version:`, which is the format
 * revision (the anchored `^version` cannot match a line starting with `cff-`).
 * `date-released` is rewritten when present (keeping its quoting style) and
 * added directly under `version:` otherwise, so a citation names the date.
 */
export function bumpCitation(text: string, version: string, date: string): Rewrite {
    const v = replaceCounting(text, /^(version:[ \t]*)([^\r\n]*)/m, (_m, a) => `${a}${version}`);
    if (v.matched === 0) return v;
    if (/^date-released:/m.test(v.text)) {
        const d = replaceCounting(v.text, /^(date-released:[ \t]*)([^\r\n]*)/m, (_m, a, old) => `${a}${/^["']/.test(old) ? `"${date}"` : date}`);
        return { text: d.text, matched: v.matched + d.matched };
    }
    const eol = v.text.includes('\r\n') ? '\r\n' : '\n';
    const out = v.text.replace(/^(version:[^\r\n]*)/m, `$1${eol}date-released: ${date}`);
    return { text: out, matched: v.matched + 1 };
}

// ── 5. SECURITY.md ──────────────────────────────────────────────────

/**
 * This repository supports one minor line at a time:
 *
 *   | `1.0.x` | yes |
 *   | < 1.0 (never published to npm) | no |
 *
 * A minor or major bump rewrites both rows to the new line (`| \`1.1.x\` | yes |`
 * then `| \`< 1.1\` | no |` — the old cut-off's wording described the line
 * that is now unsupported, so it is not carried over); a patch release lands
 * on the line already listed, so the table is left exactly as it is.
 */
export function bumpSecurityTable(text: string, version: string): Rewrite {
    const line = minorLine(version);
    const re = /^\| `(\d+\.\d+)\.x`[ \t]*\|[ \t]*yes[ \t]*\|[ \t]*(\r?\n)\|[^|\r\n]*\|[ \t]*no[ \t]*\|/m;
    return replaceCounting(text, re, (whole, supported, eol) => (supported === line ? whole : `| \`${line}.x\` | yes |${eol}| \`< ${line}\` | no |`));
}

// ── 6. README badge and "Current release" prose ─────────────────────

/**
 * The shields.io engine badge as README.md writes it — the whole URL, anchored
 * at the start of the text or a Markdown boundary (`(`, a quote, whitespace),
 * so a badge under another host can never match: `https://img.shields.io/badge/zipnative-1.0-<colour>.svg`.
 */
const ENGINE_BADGE = /(^|[\s("'`<])(https?:\/\/img\.shields\.io\/badge\/zipnative-)(\d+\.\d+)(-)/m;

/** The shields.io engine badge: `badge/zipnative-1.0-<colour>.svg` names the engine's minor line. */
export function bumpReadmeEngineBadge(text: string, engine: string): Rewrite {
    return replaceCounting(text, ENGINE_BADGE, (_m, prefix, a, _old, c) => `${prefix}${a}${minorLine(engine)}${c}`);
}

/**
 * `Current release: X.Y.Z` — bold or plain, with or without the colon (the
 * copilot instructions wrap it as `Current release\n1.0.0`). Only the first
 * occurrence moves; an engine version quoted beside it is left alone.
 */
const CURRENT_RELEASE = /(Current (?:release|version):?\s*\**v?)(\d+\.\d+\.\d+)/;

export function bumpCurrentRelease(text: string, version: string): Rewrite {
    return replaceCounting(text, CURRENT_RELEASE, (_m, a) => `${a}${version}`);
}

/** The prose that names the server's current release (each one optional). */
export const CURRENT_RELEASE_FILES: readonly string[] = ['llms.txt', 'CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];

// ── 8. Release dates a slipped tag leaves stale ─────────────────────

/** The `## [X.Y.Z] - YYYY-MM-DD` heading of the version's CHANGELOG entry. */
export function changelogHeading(version: string): RegExp {
    return new RegExp(`^(## \\[${version.replace(/\./g, '\\.')}\\] - )(\\d{4}-\\d{2}-\\d{2})`, 'm');
}

/** Re-date the version's CHANGELOG heading; 0 matches when the entry is not written yet. */
export function bumpChangelogDate(text: string, version: string, date: string): Rewrite {
    return replaceCounting(text, changelogHeading(version), (_m, a) => `${a}${date}`);
}

const INSIGHTS_DATES = /^([ \t]*last-(?:updated|reviewed):[ \t]*)['"]?(\d{4}-\d{2}-\d{2})['"]?/gm;
export const INSIGHTS_DATE_LINE = /^[ \t]*last-(?:updated|reviewed):/m;

/** Re-stamp the OpenSSF Security Insights review dates (quoted, as the file writes them). */
export function bumpInsightsDates(text: string, date: string): Rewrite {
    return replaceCounting(text, INSIGHTS_DATES, (_m, a) => `${a}'${date}'`);
}

// ── 7. Release note and PR draft scaffolds ──────────────────────────

/**
 * release-notes/TEMPLATE.md and release-notes/PR_TEMPLATE.md carry the
 * document as a fenced ```markdown block whose own code fences are escaped as
 * \`\`\`. Extract it, resolve the `vX.Y.Z` / `X.Y.Z` / `vX.Y.Z-1` /
 * `YYYY-MM-DD` placeholders and unescape.
 */
export function scaffoldFromTemplate(template: string, version: string, date: string, previousTag: string, templateName = 'the template'): string {
    const m = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(template);
    if (!m) throw new Error(`${templateName} has no \`\`\`markdown block to scaffold from`);
    return (
        (m[1] as string)
            .replace(/vX\.Y\.Z-1/g, previousTag)
            .replace(/vX\.Y\.Z/g, `v${version}`)
            .replace(/X\.Y\.Z/g, version)
            .replace(/YYYY-MM-DD/g, date)
            .replace(/\\`\\`\\`/g, '```') + '\n'
    );
}

// ── CLI ─────────────────────────────────────────────────────────────

export const USAGE =
    'usage: npx tsx scripts/release-prepare.ts --version X.Y.Z [--date YYYY-MM-DD] [--previous vA.B.C] [--dry-run]';

/** Returns the options, or a usage error message. */
export function parseArgs(argv: readonly string[]): Options | string {
    let version: string | null = null;
    let date: string | null = null;
    let previous: string | null = null;
    let dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        const value = (): string | null => (i + 1 < argv.length ? (argv[++i] as string) : null);
        if (arg === '--dry-run') dryRun = true;
        else if (arg === '--version') version = value();
        else if (arg === '--date') date = value();
        else if (arg === '--previous') previous = value();
        else if (arg.startsWith('--version=')) version = arg.slice('--version='.length);
        else if (arg.startsWith('--date=')) date = arg.slice('--date='.length);
        else if (arg.startsWith('--previous=')) previous = arg.slice('--previous='.length);
        else return `unknown argument "${arg}"\n${USAGE}`;
    }
    if (version === null) return `--version is required\n${USAGE}`;
    if (!isSemver(version)) return `--version "${version}" is not a plain semver triple (X.Y.Z)`;
    if (date !== null && !isIsoDate(date)) return `--date "${date}" is not an ISO date (YYYY-MM-DD)`;
    if (previous !== null && !isSemver(stripTag(previous))) return `--previous "${previous}" is not a tag of the form vA.B.C`;
    return { version, date: date ?? todayUtc(), previous: previous === null ? null : `v${stripTag(previous)}`, dryRun };
}

function git(root: string, args: string[]): string | null {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout : null;
}

export function main(argv: readonly string[], root = resolve(import.meta.dirname, '..')): number {
    const parsed = parseArgs(argv);
    if (typeof parsed === 'string') {
        console.error(`release-prepare: ${parsed}`);
        return 2;
    }
    const opts = parsed;
    const rel = (p: string): string => relative(root, p).replace(/\\/g, '/');

    const previousTag = opts.previous ?? git(root, ['describe', '--tags', '--abbrev=0'])?.trim() ?? null;
    if (!previousTag || !isSemver(stripTag(previousTag))) {
        console.error('release-prepare: could not determine the previous tag (git describe --tags --abbrev=0); pass --previous vA.B.C');
        return 2;
    }
    const previousVersion = stripTag(previousTag);
    const { version, date, dryRun } = opts;
    const mark = dryRun ? '~' : '+';
    let problems = 0;
    let absent = 0;
    const packageJson = readIfPresent(join(root, 'package.json'));
    const engine = packageJson === null ? null : engineVersion(packageJson);

    say(
        `release-prepare: v${version} (previous ${previousTag}, date ${date}, engine zipnative ${engine ?? '?'})${dryRun ? ' — dry run, nothing is written' : ''}`,
    );

    /** Read, rewrite, report, and write unless --dry-run. A file that is not present yet is skipped (the read decides, never a check before it). */
    const edit = (relPath: string, what: string, fn: (text: string) => Rewrite): void => {
        const abs = join(root, relPath);
        const before = readIfPresent(abs);
        if (before === null) {
            say(`  -  ${relPath} — not present (skipped)`);
            absent++;
            return;
        }
        const r = fn(before);
        if (r.matched === 0) {
            say(`  !  ${relPath} — ${what}: pattern not found, edit by hand`);
            problems++;
        } else if (r.text === before) {
            say(`  =  ${relPath} — ${what}: already current`);
        } else {
            say(`  ${mark}  ${relPath} — ${what}`);
            if (!dryRun) writeFileSync(abs, r.text);
        }
    };

    /** `edit`, except that a present file without the pattern is skipped: the field is optional documentation. */
    const editOptional = (relPath: string, what: string, pattern: RegExp, fn: (text: string) => Rewrite): void => {
        const text = readIfPresent(join(root, relPath));
        if (text !== null && !pattern.test(text)) {
            say(`  -  ${relPath} — no ${what} (skipped)`);
            absent++;
            return;
        }
        edit(relPath, what, fn);
    };

    /**
     * Scaffold a file from a template unless it exists; a missing template is
     * skipped. The write is exclusive (`wx`): an existing target is reported by
     * the write itself, never by a check before it.
     */
    const scaffold = (targetRel: string, templateRel: string): void => {
        const target = join(root, targetRel);
        const templateText = readIfPresent(join(root, templateRel));
        if (templateText === null) {
            if (readIfPresent(target) !== null) {
                say(`  =  ${rel(target)} — exists, left alone`);
            } else {
                say(`  -  ${templateRel} — not present (skipped)`);
                absent++;
            }
            return;
        }
        let body: string;
        try {
            body = scaffoldFromTemplate(templateText, version, date, previousTag, templateRel);
        } catch (err) {
            say(`  !  ${rel(target)} — ${err instanceof Error ? err.message : String(err)}, edit by hand`);
            problems++;
            return;
        }
        if (dryRun) {
            say(readIfPresent(target) === null ? `  ${mark}  ${rel(target)} — scaffolded from ${templateRel}` : `  =  ${rel(target)} — exists, left alone`);
            return;
        }
        mkdirSync(dirname(target), { recursive: true });
        try {
            writeFileSync(target, body, { flag: 'wx' });
            say(`  ${mark}  ${rel(target)} — scaffolded from ${templateRel}`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            say(`  =  ${rel(target)} — exists, left alone`);
        }
    };

    say('\n1. Package manifests');
    edit('package.json', 'version', (t) => bumpJsonVersion(t, version));
    edit('package-lock.json', 'version (root + packages[""])', (t) => bumpLockVersion(t, version));

    say('\n2. Version lock-step (tests/metadata.test.ts)');
    edit('src/version.ts', 'ZIPNATIVE_MCP_VERSION', (t) => bumpVersionTs(t, version));
    edit('server.json', 'version (top level + package entry)', (t) => bumpServerJson(t, version));

    say('\n3. Ecosystem manifest and the Verified-on stamps it governs');
    edit('docs/assets/ecosystem.json', `packages.zipnative-mcp.version + verifiedOn ${date}`, (t) => bumpManifest(t, version, date));
    for (const file of STAMPED_FILES) edit(file, `Verified on ${date}`, (t) => restampVerifiedOn(t, date));

    say('\n4. Citation metadata');
    edit('CITATION.cff', `version + date-released ${date}`, (t) => bumpCitation(t, version, date));

    say('\n5. Supported versions');
    edit('SECURITY.md', `${minorLine(version)}.x supported, older lines unsupported`, (t) => bumpSecurityTable(t, version));

    say('\n6. README engine badge and Current-release prose');
    if (engine !== null) {
        editOptional('README.md', `zipnative engine badge ${minorLine(engine)}`, ENGINE_BADGE, (t) => bumpReadmeEngineBadge(t, engine));
    }
    for (const file of CURRENT_RELEASE_FILES) {
        editOptional(file, `Current release ${version}`, CURRENT_RELEASE, (t) => bumpCurrentRelease(t, version));
    }

    say('\n7. Release note and PR draft');
    scaffold(`release-notes/v${version}.md`, 'release-notes/TEMPLATE.md');
    scaffold(`.github/drafts/pr-v${version}.md`, 'release-notes/PR_TEMPLATE.md');

    say('\n8. Release dates (a tag that slips re-runs this step)');
    editOptional('CHANGELOG.md', `## [${version}] heading dated ${date}`, changelogHeading(version), (t) => bumpChangelogDate(t, version, date));
    editOptional('.github/SECURITY-INSIGHTS.yml', `last-updated / last-reviewed ${date}`, INSIGHTS_DATE_LINE, (t) => bumpInsightsDates(t, date));

    say(`
Next steps
  1. git diff --stat                      review: the diff should read as the bump and nothing else
  2. npm run verify:docs                  every count and version the docs quote
  3. write release-notes/v${version}.md and the CHANGELOG.md entry ## [${version}] - ${date}
     (every sample rebaseline goes in the note's Upgrade section; add the compare link;
     re-run this script with --date if the tag slips: it re-dates the heading and the Security Insights stamps)
  4. decide whether TOOL_API_VERSION moves (docs/API_STABILITY.md) — it is not bumped here
  5. npx tsx scripts/gate.ts --publish --require-all   the full release gate, veraZIP included (previous release: v${previousVersion})
  6. fill .github/drafts/pr-v${version}.md — every figure from a command run on the branch
  See CONTRIBUTING.md § Release for the merge, tag and publish steps (the maintainer's).`);

    if (absent > 0) say(`\nrelease-prepare: ${absent} file${absent === 1 ? '' : 's'} or field${absent === 1 ? '' : 's'} not present yet (marked "-"), skipped.`);
    if (problems > 0) {
        say(`\nrelease-prepare: ${problems} step${problems === 1 ? '' : 's'} need${problems === 1 ? 's' : ''} a hand edit (marked "!").`);
        return 1;
    }
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exit(main(process.argv.slice(2)));
}
