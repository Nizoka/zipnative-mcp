/**
 * Hostile-input suite for the whole catalogue: mutated archives through every
 * reader, verdict and rewriter tool, and hostile values on every top-level
 * input property of every tool.
 *
 * The invariant, for every generated call:
 *
 *     the call succeeds, OR it fails with a ToolError that carries a code
 *     from the documented vocabulary (the wrapper codes or a ZIP_* code),
 *     AND an archive a rewriter emits from a mutated input is still a
 *     structurally valid, ISO/IEC 21320-1 conformant archive that introduces
 *     no corruption the input did not already carry.
 *
 * A failure without a code is an unexpected throw that escaped a handler; an
 * ENGINE_ERROR on a mutated input means the boundary let through something the
 * engine then choked on. Both are findings. Seeded (tests/_fuzz.ts): the same
 * cases on every machine, no flakiness. This is not coverage-guided fuzzing
 * (SECURITY.md says so); it is a deterministic regression net.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openZip, verifyZip } from 'zipnative';

import { callToolDirect, ensureEngineReady, listToolsPayload, toolNames } from '../src/server.js';
import { WRAPPER_CODE_NAMES } from '../src/wrapper-codes.js';
import { ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { errorCodeOf, HOSTILE_VALUES, mutate, rng, type Rng } from './_fuzz.js';
import { assertIsoConformant, validateArchive } from './_zip-assert.js';
import { b64, basicZip, richZip } from './_zip-fixtures.js';

/** Every code a call may fail with. */
const DOCUMENTED_CODES = new Set<string>([...WRAPPER_CODE_NAMES, ...ZIP_ERROR_CODES]);

type CallResult = Awaited<ReturnType<typeof callToolDirect>>;

interface Outcome { readonly ok: boolean; readonly code: string | null; readonly result: CallResult }

async function attempt(tool: string, args: unknown, label: string): Promise<Outcome> {
    const result = await callToolDirect(tool, args);
    if (result.isError !== true) return { ok: true, code: null, result };
    const code = errorCodeOf(result as never);
    const text = (result.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '';
    expect(code, `${label}: a failure must carry a ToolError code — got: ${text.slice(0, 200)}`).not.toBeNull();
    expect(DOCUMENTED_CODES.has(code ?? ''), `${label}: ${code} is not in the documented vocabulary`).toBe(true);
    expect(code, `${label}: the boundary let a mutated input reach the engine unguarded — ${text.slice(0, 200)}`).not.toBe('ENGINE_ERROR');
    return { ok: false, code, result };
}

/** The archive an `archive`-kind tool returned inline, or null. */
function archiveOf(result: CallResult): Uint8Array | null {
    const block = result.content.find((c) => c.type === 'resource') as { resource?: { blob?: string } } | undefined;
    const blob = block?.resource?.blob;
    return blob === undefined ? null : new Uint8Array(Buffer.from(blob, 'base64'));
}

/** The names of the entries verifyZip fails in an archive (an empty set for a clean one). */
function failedEntries(bytes: Uint8Array): Set<string> {
    const report = verifyZip(bytes);
    return new Set(report.entries.filter((e) => !e.ok && !(e.skipped === 'encrypted' || e.skipped === 'stream-only-codec')).map((e) => e.name));
}

/**
 * A rewriter emits a structurally valid, ISO/IEC 21320-1 conformant archive
 * and introduces no corruption: an entry whose payload fails verification in
 * the output already failed it in the input (canonicalize_zip and the modifier
 * copy compressed bytes verbatim, by contract; merge_zip verifies first).
 */
function assertNoCorruptionIntroduced(input: Uint8Array, output: Uint8Array, label: string): void {
    expect(() => openZip(output, { validate: 'eager', onDiagnostic: () => undefined }), `${label}: output does not open eagerly`).not.toThrow();
    // ISO/IEC 21320-1: the append path keeps the input's bytes verbatim, so a defect the input carried may
    // survive; a defect only the output has is a writer bug.
    const isoBefore = new Set(validateArchive(input, `${label} input`).failures.map((f) => f.check));
    const isoIntroduced = validateArchive(output, label).failures.filter((f) => !isoBefore.has(f.check)).map((f) => `${f.check}: ${f.detail}`);
    expect(isoIntroduced, `${label}: ISO/IEC 21320-1 failures introduced by the rewrite`).toEqual([]);
    if (isoBefore.size === 0) assertIsoConformant(output, label);
    const before = failedEntries(input);
    for (const name of failedEntries(output)) {
        expect(before.has(name) || [...before].some((b) => b.endsWith(name) || name.endsWith(b)), `${label}: '${name}' fails verification in the output only`).toBe(true);
    }
}

const BASIC = basicZip();
const RICH = richZip();

/** Each archive-reading tool, the fixture it mutates and how the mutant is passed. */
const MUTATION_TARGETS: ReadonlyArray<{
    readonly tool: string;
    readonly base: Uint8Array;
    readonly args: (mutant: string, r: Rng) => Record<string, unknown>;
    readonly writes?: true;
}> = [
    { tool: 'inspect_zip', base: RICH, args: (m, r) => ({ zipBase64: m, validate: r.pick(['eager', 'lazy']), access: r.pick(['auto', 'memory', 'range']) }) },
    { tool: 'list_zip_entries', base: RICH, args: (m, r) => ({ zipBase64: m, includeExtraData: r.bool(), includeExtendedTimestamps: r.bool(), includeUnixIds: r.bool() }) },
    { tool: 'read_zip_entry', base: BASIC, args: (m, r) => ({ zipBase64: m, name: 'docs/guide.md', mode: r.pick(['data', 'raw', 'verify']) }) },
    { tool: 'read_zip_entry', base: BASIC, args: (m, r) => ({ zipBase64: m, index: r.int(0, 3), range: { offset: r.int(0, 64), length: r.int(1, 512) }, access: r.pick(['memory', 'range']) }) },
    { tool: 'verify_zip', base: RICH, args: (m) => ({ zipBase64: m }) },
    { tool: 'extract_zip', base: BASIC, args: (m, r) => ({ zipBase64: m, includeData: r.bool() }) },
    { tool: 'scan_zip_forward', base: BASIC, args: (m, r) => ({ zipBase64: m, tolerateTruncation: r.bool() }) },
    { tool: 'canonicalize_zip', base: RICH, args: (m, r) => ({ zipBase64: m, keepComments: r.bool(), keepExternalAttributes: r.bool() }), writes: true },
    { tool: 'modify_zip', base: BASIC, args: (m, r) => ({ zipBase64: m, mode: r.pick(['append', 'compact']), operations: [{ op: 'rename', from: 'src/index.js', to: 'src/main.js' }] }), writes: true },
    { tool: 'merge_zip', base: BASIC, args: (m, r) => ({ sources: [{ zipBase64: m }, { zipBase64: b64(RICH) }], onConflict: r.pick(['first', 'last']) }), writes: true },
    { tool: 'inflate_raw', base: BASIC, args: (m, r) => ({ dataBase64: m, maxOutput: r.int(1, 1 << 20), allowTrailing: r.bool() }) },
    { tool: 'compute_crc32', base: BASIC, args: (m) => ({ dataBase64: m }) },
];

const CASES_PER_TARGET = 40;

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    await ensureEngineReady();
});

describe('seeded archive mutations', () => {
    for (const [t, target] of MUTATION_TARGETS.entries()) {
        it(`${target.tool} #${t}: every mutant is a success or a coded refusal; a rewritten archive stays valid`, async () => {
            const r = rng(0x5eed_0000 + t);
            const seen = new Set<string>();
            for (let i = 0; i < CASES_PER_TARGET; i++) {
                const mutant = mutate(target.base, r);
                const label = `${target.tool} #${t} case ${i}`;
                const outcome = await attempt(target.tool, target.args(b64(mutant), r), label);
                seen.add(outcome.ok ? 'ok' : outcome.code ?? '?');
                if (outcome.ok && target.writes === true) {
                    const archive = archiveOf(outcome.result);
                    expect(archive, `${label}: an archive tool succeeded without an archive`).not.toBeNull();
                    if (archive !== null) assertNoCorruptionIntroduced(mutant, archive, label);
                }
            }
            // The mutations must actually reach the refusal paths, not only the happy one. verify_zip reports a
            // damaged archive as a verdict and compute_crc32 checksums any bytes: both always succeed by design.
            if (target.tool !== 'verify_zip' && target.tool !== 'compute_crc32') {
                expect(seen.size, `${target.tool}: outcomes ${[...seen].join(', ')}`).toBeGreaterThan(1);
            }
        }, 60_000);
    }
});

describe('hostile values on every top-level input', () => {
    /** A valid baseline call for each tool; the hostile value replaces one property of it. */
    const BASELINE: Record<string, Record<string, unknown>> = {
        inspect_zip: { zipBase64: b64(BASIC) },
        list_zip_entries: { zipBase64: b64(BASIC) },
        read_zip_entry: { zipBase64: b64(BASIC), name: 'README.md' },
        verify_zip: { zipBase64: b64(BASIC) },
        extract_zip: { zipBase64: b64(BASIC) },
        scan_zip_forward: { zipBase64: b64(BASIC) },
        sanitize_entry_paths: { names: ['a.txt', '../b.txt'] },
        create_zip: { entries: [{ name: 'a.txt', text: 'a' }] },
        modify_zip: { zipBase64: b64(BASIC), operations: [{ op: 'remove', name: 'README.md' }] },
        canonicalize_zip: { zipBase64: b64(BASIC) },
        merge_zip: { sources: [{ zipBase64: b64(BASIC) }, { zipBase64: b64(RICH) }], onConflict: 'last' },
        compute_crc32: { text: 'abc' },
        inflate_raw: { dataBase64: 'S0xKBgA=', maxOutput: 16 },
        describe_engine: {},
        draft_governance_issue: {
            title: 'Fuzz baseline issue', summary: 'A seeded fuzz baseline that must validate.', issueType: 'bug',
            reproduction: { command: 'tools/call draft_governance_issue', result: 'baseline' }, expectedBehavior: 'A local draft is produced.', duplicateSearchPerformed: true,
        },
    };

    it('covers every tool of the catalogue', () => {
        expect(Object.keys(BASELINE).sort()).toEqual([...toolNames()].sort());
    });

    it('every baseline call succeeds (so a refusal below is caused by the hostile value)', async () => {
        for (const [tool, args] of Object.entries(BASELINE)) {
            const outcome = await attempt(tool, args, `${tool} baseline`);
            expect(outcome.ok, `${tool} baseline: ${outcome.code}`).toBe(true);
        }
    }, 60_000);

    for (const tool of listToolsPayload().tools) {
        it(`${tool.name}: a hostile value on any input is a success or a coded refusal`, async () => {
            const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
            const r = rng(0xf022 ^ tool.name.length);
            for (const prop of props) {
                // Every property gets a fixed sweep of hostile values plus a seeded sample, so the suite stays bounded.
                const values = [HOSTILE_VALUES[0], HOSTILE_VALUES[13], ...Array.from({ length: 6 }, () => r.pick(HOSTILE_VALUES))];
                for (const value of values) {
                    // outputMode 'file' is refused (no sandbox) with a coded error; never let a hostile value write anywhere.
                    const args = { ...BASELINE[tool.name], [prop]: value };
                    await attempt(tool.name, args, `${tool.name}.${prop}=${JSON.stringify(value)?.slice(0, 40)}`);
                }
            }
            // Unknown keys and a non-object argument are VALIDATION_ERROR, never a throw. The own `__proto__`
            // key is built by JSON.parse, as a JSON-RPC frame delivers it (an object literal would set the prototype).
            const base = JSON.stringify(BASELINE[tool.name]);
            const poisoned = JSON.parse(`${base === '{}' ? '{' : `${base.slice(0, -1)},`}"__proto__":{"polluted":true}}`) as Record<string, unknown>;
            expect((await attempt(tool.name, poisoned, `${tool.name} own __proto__ key`)).code).toBe('VALIDATION_ERROR');
            expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
            expect((await attempt(tool.name, { ...BASELINE[tool.name], extra: 1 }, `${tool.name} extra key`)).code).toBe('VALIDATION_ERROR');
            for (const shape of [null, [], 'x', 42]) {
                const outcome = await attempt(tool.name, shape, `${tool.name} arguments=${JSON.stringify(shape)}`);
                if (!outcome.ok) expect(outcome.code).toBe('VALIDATION_ERROR');
            }
        }, 60_000);
    }
});
