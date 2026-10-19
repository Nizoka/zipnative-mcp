/**
 * I/O helpers shared by the sample generator, the verifiers and the gate.
 * Ported from pkinative-mcp's scripts/helpers/io.ts; the generators drive
 * the BUILT server (`dist/server.js`) through the same `callToolDirect()`
 * the `tools/call` handler reaches, so files are written by the script from
 * the returned bytes.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
/** Every generated artefact lives under here; git-ignored. */
export const TEST_OUTPUT_DIR = resolve(REPO_ROOT, 'test-output');
/** The reproducible sample set (`npm run test:generate`). */
export const OUTPUT_DIR = resolve(TEST_OUTPUT_DIR, 'samples');
/** The frozen inputs of the published examples (tests/fixtures/PROVENANCE.md). */
export const FIXTURES_DIR = resolve(REPO_ROOT, 'tests', 'fixtures', 'examples');
/** The published MCP call payloads. */
export const EXAMPLES_DIR = resolve(REPO_ROOT, 'examples');

export const SANDBOX_ENV = 'ZIPNATIVE_MCP_OUTPUT_DIR';

/**
 * The example placeholder vocabulary: each token names a frozen fixture whose
 * base64 replaces it (tests/examples.test.ts resolves the same tokens from the
 * builders of tests/_zip-fixtures.ts, and tests/example-fixtures.test.ts holds
 * the two equal).
 */
export const PLACEHOLDER_FIXTURES: Readonly<Record<string, string>> = {
    'zip-base64': 'basic.zip',
    'rich-zip-base64': 'rich.zip',
    'truncated-zip-base64': 'truncated.zip',
    'hostile-zip-slip-base64': 'zip-slip.zip',
    'raw-deflate-base64': 'raw-deflate.bin',
};

/**
 * The files a file-mode example finds in the sandbox (sandbox-relative path →
 * fixture name), so the `zipPath` / `sourcePath` inputs of the published
 * examples resolve and those examples run instead of being documentation-only.
 */
export const SANDBOX_FILES: Readonly<Record<string, string>> = {
    'incoming/report.zip': 'basic.zip',
    'incoming/rich.zip': 'rich.zip',
    'incoming/dump.bin': 'dump.bin',
};

export function fixturePath(name: string): string {
    return join(FIXTURES_DIR, name);
}

export function fixtureExists(name: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(name) && existsSync(fixturePath(name));
}

export function fixtureBytes(name: string): Buffer {
    if (!fixtureExists(name)) throw new Error(`unknown fixture "${name}" (tests/fixtures/examples)`);
    return readFileSync(fixturePath(name));
}

/** The base64 of the fixture a placeholder token names, or null for a token outside the vocabulary. */
export function placeholderBase64(token: string): string | null {
    const name = PLACEHOLDER_FIXTURES[token];
    return name === undefined ? null : fixtureBytes(name).toString('base64');
}

/**
 * A fresh sandbox holding {@link SANDBOX_FILES}, exported to the server as
 * `ZIPNATIVE_MCP_OUTPUT_DIR`. Call after ./hermetic.js has scrubbed the
 * inherited values. Returns the directory; `removeSandbox` deletes it and
 * forgets the variable.
 */
export function prepareSandbox(prefix = 'zipnative-mcp-samples-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    for (const [rel, fixture] of Object.entries(SANDBOX_FILES)) {
        const target = join(dir, ...rel.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(fixturePath(fixture), target);
    }
    process.env[SANDBOX_ENV] = dir;
    return dir;
}

export function removeSandbox(dir: string | null): void {
    Reflect.deleteProperty(process.env, SANDBOX_ENV);
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
}

export interface OutputMode {
    /** Summary lines only. Implied when stdout is not a terminal, unless --verbose. */
    readonly quiet: boolean;
    /** Machine-readable output on stdout. Implies quiet for everything else. */
    readonly json: boolean;
}

/**
 * Parse the `--quiet` / `--verbose` / `--json` trio shared by the sample
 * scripts. A pipe (CI log, an agent's captured output, `scripts/gate.ts`)
 * gets the quiet form by default so a human at a terminal sees the full
 * table and everyone else sees a few lines; `--verbose` forces the table
 * through a pipe, `--quiet` forces the summary at a terminal.
 *
 * Returns an error message for anything else, so callers can exit 2.
 */
export function parseOutputMode(argv: readonly string[], isTTY: boolean = process.stdout.isTTY === true): OutputMode | { readonly error: string } {
    let quiet = false;
    let verbose = false;
    let json = false;
    for (const a of argv) {
        if (a === '--quiet') quiet = true;
        else if (a === '--verbose') verbose = true;
        else if (a === '--json') json = true;
        else return { error: `Unknown argument "${a}". Expected --quiet, --verbose and/or --json.` };
    }
    if (quiet && verbose) return { error: '--quiet and --verbose are mutually exclusive.' };
    return { quiet: json || quiet || (!isTTY && !verbose), json };
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
