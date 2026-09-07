// veraZIP vendor pins — text-level guards over the conformance-gate scripts.
//
// scripts/verazip-core.mjs (the validator core) and scripts/validate-zip.mjs
// (its manifest driver) are VENDORED copies of zipnative's
// scripts/validate-zip.ts, scripts/helpers/interop-tools.mjs of zipnative's
// tests/helpers/interop-tools.ts and scripts/helpers/raw-zip-builder.mjs of
// zipnative's tests/helpers/raw-zip-builder.ts (the engine does not ship
// scripts/ or tests/ in its npm tarball). These tests read the scripts as
// text and pin:
//   - the upstream commit + blob hashes each port was taken from (bump them
//     in the same PR as a re-port);
//   - the frozen 22-id check vocabulary (`fail('<id>'` literals == CHECK_IDS);
//   - the anti-circularity invariant: the validator core has NO imports at
//     all; the driver, the foreign-tool helper, the raw builder and the corpus
//     definition never import `zipnative`, `src/` or `dist/`; the corpus
//     generator loads ONLY the built dist/server.js;
//   - the level-1 tool roster;
//   - REQUIRED_NEGATIVE_CHECKS == the corpus's declared `expectedCheck` set
//     (the coverage canary can only trip on a real regression);
//   - docs/data/verazip.json `declared` counts == the corpus definition (the
//     numbers README / CONTRIBUTING / CONFORMANCE quote).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildCorpus, corpusCounts } from '../scripts/helpers/zip-corpus.mjs';
import { CHECK_IDS, REQUIRED_NEGATIVE_CHECKS } from '../scripts/verazip-core.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const core = read('scripts/verazip-core.mjs');
const driver = read('scripts/validate-zip.mjs');
const tools = read('scripts/helpers/interop-tools.mjs');
const builder = read('scripts/helpers/raw-zip-builder.mjs');
const corpusSource = read('scripts/helpers/zip-corpus.mjs');
const generator = read('scripts/generate-zip-corpus.mjs');

const UPSTREAM_COMMIT = '4f1bc3619372e8543bccea65d2365bf0c048a10c';
const UPSTREAM_VALIDATOR_BLOB = '5ddea000a3b6a4adfb720d673a43664972118139';
const UPSTREAM_TOOLS_BLOB = '2fef80f17e302384a0f6a5f57f7a0f14911401f5';
const UPSTREAM_BUILDER_BLOB = 'e4b43d9d28f7bec4b50298cb144e87e0c009a77b';

/** The frozen ISO/IEC 21320-1 + well-formedness vocabulary of the vendored validator. */
const EXPECTED_CHECK_IDS = [
    'ISO21320-1/APPNOTE-4.3.3',
    'ISO21320-1/APPNOTE-4.3.8',
    'ISO21320-1/APPNOTE-4.3.10',
    'ISO21320-1/APPNOTE-4.3.13',
    'ISO21320-1/APPNOTE-4.4.1.5',
    'ISO21320-1/APPNOTE-4.4.3',
    'ISO21320-1/APPNOTE-4.4.4',
    'ISO21320-1/APPNOTE-4.4.5',
    'ISO21320-1/APPNOTE-NOTE-1',
    'WF/EOCD-NOT-FOUND',
    'WF/ZIP64-LOCATOR',
    'WF/ZIP64-EOCD',
    'WF/CD-OFFSET',
    'WF/CD-COUNT',
    'WF/CD-SIZE',
    'WF/LFH-SIGNATURE',
    'WF/LFH-METHOD-MISMATCH',
    'WF/LFH-NAME-MISMATCH',
    'WF/LFH-SIZE-MISMATCH',
    'WF/LFH-CRC-MISMATCH',
    'WF/DESCRIPTOR-MISMATCH',
    'WF/ENTRY-OVERLAP',
];

const literals = (source: string, re: RegExp): string[] => Array.from(source.matchAll(re), (m) => m[1] as string);

function expectNoEngineImport(source: string, label: string): void {
    expect(source, `${label} imports zipnative`).not.toMatch(/from\s+['"]zipnative/);
    expect(source, `${label} requires zipnative`).not.toMatch(/require\(\s*['"]zipnative/);
    expect(source, `${label} imports src/`).not.toMatch(/from\s+['"][^'"]*\/src\//);
    expect(source, `${label} imports dist/`).not.toMatch(/from\s+['"][^'"]*\/dist\//);
    expect(source, `${label} loads dist/`).not.toMatch(/import\(\s*[^)]*dist/);
}

describe('veraZIP vendored validator core (scripts/verazip-core.mjs)', () => {
    it('pins the upstream commit and blob it was ported from', () => {
        expect(core).toMatch(new RegExp(`upstream commit:\\s+${UPSTREAM_COMMIT}`));
        expect(core).toMatch(new RegExp(`upstream blob:\\s+${UPSTREAM_VALIDATOR_BLOB}`));
        expect(core).toMatch(/upstream file:\s+scripts\/validate-zip\.ts/);
    });

    it('emits exactly the frozen 22-id check vocabulary', () => {
        const ids = new Set(literals(core, /\bfail\('([^']+)'/g));
        expect(EXPECTED_CHECK_IDS).toHaveLength(22);
        expect([...ids].sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
        expect([...CHECK_IDS].sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
    });

    it('has no import statements at all (anti-circularity by construction)', () => {
        expect(core).not.toMatch(/^\s*import\s/m);
        expect(core).not.toMatch(/\brequire\s*\(/);
        expect(core).not.toMatch(/\bimport\s*\(/);
    });

    it('declares the four REQUIRED_NEGATIVE_CHECKS within the vocabulary', () => {
        expect([...REQUIRED_NEGATIVE_CHECKS]).toHaveLength(4);
        for (const id of REQUIRED_NEGATIVE_CHECKS) expect(EXPECTED_CHECK_IDS).toContain(id);
    });
});

describe('veraZIP driver (scripts/validate-zip.mjs)', () => {
    it('pins the upstream commit and blob and imports the shared core', () => {
        expect(driver).toMatch(new RegExp(`upstream commit:\\s+${UPSTREAM_COMMIT}`));
        expect(driver).toMatch(new RegExp(`upstream blob:\\s+${UPSTREAM_VALIDATOR_BLOB}`));
        expect(driver).toMatch(/upstream file:\s+scripts\/validate-zip\.ts/);
        expect(driver).toContain("from './verazip-core.mjs'");
        expect(driver).toContain("from './helpers/interop-tools.mjs'");
        expect(driver).not.toMatch(/\bfunction validateArchive\b/);
    });

    it('never imports zipnative, src/ or dist/ (anti-circularity)', () => {
        for (const [source, label] of [[driver, 'validate-zip.mjs'], [tools, 'interop-tools.mjs'], [builder, 'raw-zip-builder.mjs'], [corpusSource, 'zip-corpus.mjs']] as const) {
            expectNoEngineImport(source, label);
        }
    });

    it('documents the outcomes, exit codes and environment contract', () => {
        for (const token of ['PASS', 'FAIL', 'XFAIL', 'XPASS', 'INFRA', 'VERAZIP_REQUIRED', 'VERAZIP_REPORT_DIR', 'VERAZIP_TOOLS', 'summary.json', 'docs/data/verazip.json']) {
            expect(driver).toContain(token);
        }
        expect(driver).toContain('Added or removed a sample? Update declared');
    });
});

describe('level-1 foreign tools (scripts/helpers/interop-tools.mjs)', () => {
    it('pins the upstream blob it was ported from', () => {
        expect(tools).toMatch(new RegExp(`upstream blob:\\s+${UPSTREAM_TOOLS_BLOB}`));
        expect(tools).toMatch(/upstream file:\s+tests\/helpers\/interop-tools\.ts/);
    });

    it('exposes exactly the five integrity tools, in upstream order', () => {
        expect(literals(tools, /\bid:\s*'([^']+)'/g)).toEqual(['bsdtar', 'unzip', '7z', 'python-zipfile', 'jar']);
        expect(tools).toContain('export const INTEGRITY_TOOLS');
    });
});

describe('raw ZIP builder (scripts/helpers/raw-zip-builder.mjs)', () => {
    it('pins the upstream commit and blob it was ported from', () => {
        expect(builder).toMatch(new RegExp(`upstream commit:\\s+${UPSTREAM_COMMIT}`));
        expect(builder).toMatch(new RegExp(`upstream blob:\\s+${UPSTREAM_BUILDER_BLOB}`));
        expect(builder).toMatch(/upstream file:\s+tests\/helpers\/raw-zip-builder\.ts/);
    });

    it('computes CRC-32 from a local table (no engine, no node:zlib.crc32)', () => {
        expect(builder).toContain('export function crc32');
        expect(builder).toContain('export function buildRawZip');
        expect(builder).not.toMatch(/crc32 as zlibCrc32/);
    });
});

describe('corpus definition (scripts/helpers/zip-corpus.mjs) and generator', () => {
    const stubCall = async (): Promise<never> => {
        throw new Error('the stub call must never be invoked while building the corpus');
    };
    const corpus = buildCorpus({ call: stubCall, sandboxDir: null });
    const declared = JSON.parse(read('docs/data/verazip.json')) as {
        declared: { conformant: number; nonConformant: number; hostileConformant: number };
        checkIds: number;
        requiredNegativeChecks: string[];
    };

    it('generator drives only the built dist/server.js and never imports zipnative or src/', () => {
        expect(generator).toContain("join(ROOT, 'dist', 'server.js')");
        expect(generator).toContain('pathToFileURL(SERVER_MODULE)');
        expect(generator).not.toMatch(/from\s+['"]zipnative/);
        expect(generator).not.toMatch(/from\s+['"][^'"]*\/src\//);
        expect(generator).not.toMatch(/require\(\s*['"]zipnative/);
    });

    it('declares every REQUIRED_NEGATIVE_CHECKS id as an expectedCheck — and nothing else', () => {
        const crafted = new Set(literals(corpusSource, /expectedCheck:\s*'([^']+)'/g));
        expect([...crafted].sort()).toEqual([...REQUIRED_NEGATIVE_CHECKS].sort());
        const fromEntries = new Set(corpus.filter((e) => !e.expectConformant).map((e) => e.expectedCheck));
        expect([...fromEntries].sort()).toEqual([...REQUIRED_NEGATIVE_CHECKS].sort());
    });

    it('matches the counts docs/data/verazip.json declares', () => {
        expect(corpusCounts(corpus)).toEqual(declared.declared);
        expect(declared.declared.hostileConformant).toBeLessThanOrEqual(declared.declared.conformant);
        expect(declared.checkIds).toBe(22);
        expect([...declared.requiredNegativeChecks].sort()).toEqual([...REQUIRED_NEGATIVE_CHECKS].sort());
    });

    it('is well-formed: unique files, negatives carry a check id, refusals name a ZIP_* code', () => {
        expect(new Set(corpus.map((e) => e.file)).size).toBe(corpus.length);
        for (const e of corpus) {
            expect(e.file).toMatch(/\.zip$/);
            if (!e.expectConformant) expect(e.expectedCheck).not.toBeNull();
            if (e.refusedBy !== null) expect(e.refusedBy.code).toMatch(/^ZIP_[A-Z0-9_]+$/);
            if (e.producedBy === 'tool') expect(e.tool).not.toBeNull();
        }
    });
});
