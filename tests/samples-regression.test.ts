/**
 * Sample regression gate, ported from pkinative-mcp 1.0.0
 * (tests/samples-regression.test.ts) onto this repository's two-mode
 * fingerprint (scripts/lib/sample-fingerprint.ts).
 *
 * The sample set lives in the git-ignored `test-output/samples/`, which only
 * `npm run test:generate` populates (it drives the BUILT server, so
 * `npm run build` comes first) together with `manifest.json`, the mode the
 * generator chose for every file. This suite SKIPS the corpus half when the
 * set is absent in a plain local run; under the gate's ci / publish
 * profiles, which run build → test:generate before test:coverage and set
 * GATE_REQUIRE_ARTIFACTS=1, a missing set FAILS this file instead. The
 * committed baseline (tests/_fixtures/samples.sha256.json) is held in every
 * run: its chain, its provenance, and the mode of every archive row — read
 * back from the example that produced it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadExamples, type Example } from '../scripts/lib/example-runner.js';
import {
    BASELINE_PATH, HOST_DEPENDENT_SAMPLES, IDENTICAL_SAMPLE_GROUPS, MANIFEST_PATH, OUTPUT_DIR, VOLATILE_MEMBERS,
    argsAskWallClock, canonicalJson, chainSince, compareToBaseline, currentVersion, fingerprintAll,
    loadBaseline, loadManifest, modeFor, reportsHost, semanticProjection, stripHost, stripVolatile,
    unexpectedDuplicates, walkSamples,
    type Baseline, type Fingerprint, type FingerprintMode,
} from '../scripts/lib/sample-fingerprint.js';

/** The release that introduced the chain: the 1.0.0 outputs, captured before the 1.1.0 work began. */
const CHAIN_ORIGIN = '1.0.0';
const MODES: readonly FingerprintMode[] = ['bytes', 'semantic'];
/** What verify-samples writes when no manifest exists yet — a baseline that still carries it was never accounted for. */
const TEMPLATE_PROVENANCE = /^Initial baseline: every entry is anchored/;

const samples = [...walkSamples(OUTPUT_DIR)];
const haveCorpus = samples.length > 0 && existsSync(MANIFEST_PATH);
if (!haveCorpus && process.env['GATE_REQUIRE_ARTIFACTS'] === '1') {
    throw new Error('test-output/samples/ is empty but GATE_REQUIRE_ARTIFACTS=1: the gate generates the samples before test:coverage — run `npm run build && npm run test:generate`');
}

const rank = (v: string): number => {
    const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
    return a * 1e6 + b * 1e3 + c;
};

/** `roundtrip-create-verify-extract.step1.zip` → the example and the step (0-based) that wrote it; `x.json` → the sidecar. */
function locate(rel: string): { readonly example: string; readonly step: number; readonly sidecar: boolean } {
    const m = /^([A-Za-z0-9_-]+)(?:\.step(\d+))?\.([a-z0-9]+)$/.exec(rel);
    expect(m, `${rel} is not <example>[.stepN].<ext>`).not.toBeNull();
    const [, example, step, ext] = m as RegExpExecArray;
    return { example: example as string, step: step === undefined ? 0 : Number(step) - 1, sidecar: ext === 'json' };
}

const examples = new Map<string, Example>(loadExamples().map((e) => [e.name, e]));

describe.skipIf(!haveCorpus)('sample regression: the generated set against the baseline', () => {
    it('every tracked sample still emits what its reference release emitted', () => {
        const baseline = loadBaseline();
        expect(baseline, `missing baseline at ${BASELINE_PATH}`).not.toBeNull();

        const { entries, unreadable, unlisted, missing } = fingerprintAll();
        expect(unreadable, 'samples that could not be fingerprinted').toEqual([]);
        expect(unlisted, 'files on disk the manifest does not list').toEqual([]);
        expect(missing, 'manifest entries with no file on disk').toEqual([]);

        const { changed, removed } = compareToBaseline(entries, baseline!);
        expect(changed, 'samples whose output changed').toEqual([]);
        expect(removed, 'baseline entries with no generated sample').toEqual([]);
        // `added` is deliberately not asserted: a sample introduced by the release under development
        // has no earlier reference to be held to. `verify-samples --strict` is the opt-in gate for that.
    });

    it('the manifest is the generator\'s: one of the two modes per file, the example and tool named, a sidecar for every semantic artefact', () => {
        const manifest = loadManifest()!;
        expect(manifest.generatedBy).toBe('scripts/generate-samples.ts');
        const rels = Object.keys(manifest.entries);
        expect(rels.length).toBe(samples.length);
        for (const rel of rels) {
            const entry = manifest.entries[rel]!;
            expect(MODES, `${rel}: mode ${entry.mode}`).toContain(entry.mode);
            expect(entry.tool.length, `${rel}: tool`).toBeGreaterThan(0);
            expect(examples.has(entry.example), `${rel}: example ${entry.example}`).toBe(true);
            const at = locate(rel);
            expect(at.example).toBe(entry.example);
            if (at.sidecar) {
                expect(entry.mode, `${rel}: a JSON result is always semantic`).toBe('semantic');
                expect(entry.sidecar).toBeUndefined();
            } else if (entry.mode === 'semantic') {
                expect(entry.sidecar, `${rel}: a semantic artefact stands for its sidecar`).toBe(`${entry.example}.json`);
                expect(existsSync(join(OUTPUT_DIR, entry.sidecar!)), `${rel}: sidecar on disk`).toBe(true);
            } else {
                expect(entry.sidecar).toBeUndefined();
            }
        }
    });

    it('the recorded mode of every archive is what modeFor re-derives from the example step', () => {
        const manifest = loadManifest()!;
        for (const [rel, entry] of Object.entries(manifest.entries)) {
            const at = locate(rel);
            if (at.sidecar) continue;
            const step = examples.get(at.example)!.steps[at.step];
            expect(step, `${rel}: examples/${at.example}.json has no step ${at.step + 1}`).toBeDefined();
            expect(step!.tool, rel).toBe(entry.tool);
            expect(modeFor({ args: step!.arguments }), rel).toBe(entry.mode);
        }
    });

    it('the samples that report the host are exactly the declared ones', () => {
        const manifest = loadManifest()!;
        const reporting = Object.keys(manifest.entries)
            .filter((rel) => locate(rel).sidecar)
            .filter((rel) => {
                const parsed = JSON.parse(String(readSample(rel))) as Record<string, unknown>;
                return reportsHost(parsed['structuredContent']);
            })
            .sort();
        expect(reporting).toEqual([...HOST_DEPENDENT_SAMPLES].sort());
    });

    it('no two samples share a fingerprint unless declared identical', () => {
        expect(unexpectedDuplicates(fingerprintAll().entries)).toEqual([]);
    });
});

function readSample(rel: string): Buffer {
    return readFileSync(join(OUTPUT_DIR, rel));
}

describe('sample regression: the committed baseline', () => {
    const baseline = loadBaseline() as Baseline;

    it('exists, is UTC, and carries a written provenance', () => {
        expect(baseline, `missing ${BASELINE_PATH}`).not.toBeNull();
        expect(baseline.timezone).toBe('UTC');
        expect(baseline.provenance ?? '').not.toMatch(TEMPLATE_PROVENANCE);
        expect((baseline.provenance ?? '').length).toBeGreaterThan(80);
    });

    it('every entry is anchored to a release between the chain origin and the current version', () => {
        const current = rank(currentVersion());
        for (const [rel, entry] of Object.entries(baseline.entries)) {
            expect(MODES, rel).toContain(entry.mode);
            expect(entry.hash, rel).toMatch(/^[0-9a-f]{64}$/);
            expect(rank(entry.since), `${rel}: since ${entry.since}`).toBeGreaterThanOrEqual(rank(CHAIN_ORIGIN));
            expect(rank(entry.since), `${rel}: since ${entry.since}`).toBeLessThanOrEqual(current);
        }
        expect(rank(baseline.baselineVersion)).toBeLessThanOrEqual(current);
    });

    it('every archive row names an example step that writes pinned bytes', () => {
        for (const [rel, entry] of Object.entries(baseline.entries)) {
            const at = locate(rel);
            const example = examples.get(at.example);
            expect(example, `${rel}: no examples/${at.example}.json`).toBeDefined();
            if (at.sidecar) continue;
            const step = example!.steps[at.step]!;
            expect(entry.mode, rel).toBe(modeFor({ args: step.arguments }));
        }
    });
});

describe('sample fingerprint: the projection', () => {
    it('canonicalJson sorts keys at every depth', () => {
        expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
        expect(canonicalJson(undefined)).toBe('null');
    });

    it('stripVolatile removes the sandbox paths at every depth and nothing else', () => {
        expect(VOLATILE_MEMBERS).toEqual(['filePath', 'outputDir']);
        expect(stripVolatile({ filePath: '/tmp/x', sizeBytes: 3, entries: [{ filePath: '/tmp/y', name: 'a' }], outputDir: '/tmp' })).toEqual({ sizeBytes: 3, entries: [{ name: 'a' }] });
    });

    it('stripHost neutralises the declared host members and the draft lines', () => {
        expect(stripHost({ capabilities: { cpuCount: 8, defaultWorkers: 7, nodeZlib: true } })).toEqual({ capabilities: { cpuCount: '<host>', defaultWorkers: '<host>', nodeZlib: true } });
        expect(stripHost({ environment: { node: 'v22', os: 'win32', zipnativeMcp: '1.1.0' } })).toEqual({ environment: { node: '<host>', os: '<host>', zipnativeMcp: '1.1.0' } });
        expect(stripHost('x\n- Node: v22.1.0\n- OS: linux 6\n- zipnative-mcp: 1.1.0')).toBe('x\n- Node: <host>\n- OS: <host>\n- zipnative-mcp: 1.1.0');
        // CI-001: the draft's sizeBytes is the length of a markdown that names the host; a sizeBytes elsewhere is behaviour.
        expect(stripHost({ draftMarkdown: '- OS: win32 10', sizeBytes: 14, title: 't' })).toEqual({ draftMarkdown: '- OS: <host>', sizeBytes: '<host>', title: 't' });
        expect(stripHost({ sizeBytes: 14, entries: [{ sizeBytes: 3 }] })).toEqual({ sizeBytes: 14, entries: [{ sizeBytes: 3 }] });
        expect(reportsHost({ a: [{ capabilities: { cpuCount: 2 } }] })).toBe(true);
        expect(reportsHost({ capabilities: { nodeZlib: true } })).toBe(false);
    });

    it('semanticProjection keeps the refusal code and drops the message, the blobs and the sandbox paths', () => {
        const a = semanticProjection(JSON.stringify({ isError: true, _meta: { error: { code: 'X', message: 'at /tmp/a' } }, structuredContent: { filePath: '/a' } }));
        const b = semanticProjection(JSON.stringify({ isError: true, _meta: { error: { code: 'X', message: 'at /tmp/b' } }, structuredContent: { filePath: '/b' } }));
        expect(a).toBe(b);
        expect(semanticProjection(JSON.stringify({ steps: [{ structuredContent: { n: 1 } }] }))).toBe('{"steps":[{"structuredContent":{"n":1}}]}');
    });

    it('modeFor: bytes for pinned archives, semantic for a wall-clock stamp anywhere in the call', () => {
        expect(modeFor({ args: { entries: [{ name: 'a', text: 'a' }] } })).toBe('bytes');
        expect(modeFor({ args: { defaultDate: 'now', entries: [] } })).toBe('semantic');
        expect(argsAskWallClock({ nested: [{ deeper: { defaultDate: 'now' } }] })).toBe(true);
        expect(argsAskWallClock({ defaultDate: '2024-01-01T00:00:00Z' })).toBe(false);
    });

    it('chainSince keeps an unchanged entry\'s release and re-anchors a changed one', () => {
        const fp = (hash: string): Fingerprint => ({ mode: 'bytes', hash, size: 1 });
        const previous: Baseline = { baselineVersion: '1.0.0', timezone: 'UTC', entries: { a: { ...fp('1'), since: '1.0.0' }, b: { ...fp('2'), since: '1.0.0' } } };
        const out = chainSince({ a: fp('1'), b: fp('3'), c: fp('4') }, previous, '1.1.0');
        expect(out).toEqual({ a: { ...fp('1'), since: '1.0.0' }, b: { ...fp('3'), since: '1.1.0' }, c: { ...fp('4'), since: '1.1.0' } });
    });

    it('unexpectedDuplicates flags collapsed pairs only', () => {
        expect(IDENTICAL_SAMPLE_GROUPS).toEqual([]);
        expect(unexpectedDuplicates({ a: { hash: 'x' }, b: { hash: 'x' }, c: { hash: 'y' } })).toEqual([['a', 'b']]);
    });
});
