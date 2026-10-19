/**
 * zipnative-mcp — Sample fingerprinting core
 * ============================================
 * Shared by the `verify:samples` script and the vitest regression gate, so
 * both compute the identical fingerprint and there is one definition of what
 * "unchanged output" means. Ported from pkinative-mcp's
 * scripts/lib/sample-fingerprint.ts; the set here is written by the BUILT
 * server through `callToolDirect()` (scripts/generate-samples.ts →
 * test-output/samples/) from the hermetic `examples/*.json`.
 *
 * Two modes, chosen per sample by the generator (`modeFor`) and recorded in
 * `test-output/samples/manifest.json`, never guessed at verification time:
 *   • `bytes`    — SHA-256 of the file. Every archive the tools write over
 *     pinned inputs: the default timestamp is the DOS epoch, an explicit
 *     `date` is an instant written in UTC (`dosTimeMode: 'utc'`), the layout
 *     is canonical — so the bytes are a pure function of the call.
 *   • `semantic` — SHA-256 of the canonical JSON of `structuredContent` with
 *     the volatile members removed (`filePath`, `outputDir`: absolute paths
 *     into a temporary sandbox) and the host members neutralised (the Node
 *     version, the platform and the core count `describe_engine` probes and
 *     `draft_governance_issue` records, and the draft's `sizeBytes` that
 *     measures those lines: the baseline is made on the
 *     maintainer's machine and held on every CI runner). Every read / verdict
 *     result, and an archive written with `defaultDate: 'now'`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { OUTPUT_DIR, REPO_ROOT } from '../helpers/io.js';

export { OUTPUT_DIR, REPO_ROOT };
export const BASELINE_PATH = join(REPO_ROOT, 'tests', '_fixtures', 'samples.sha256.json');
export const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json');

export type FingerprintMode = 'bytes' | 'semantic';

/** Members of a result that change with the run or the host, never with the behaviour. */
export const VOLATILE_MEMBERS: readonly string[] = ['filePath', 'outputDir'];

/**
 * Members that name the host, not the behaviour, by the object that carries
 * them: `describe_engine.capabilities.cpuCount` / `.defaultWorkers` and
 * `draft_governance_issue.compliance.environment.node` / `.os`. The draft
 * markdown repeats the latter as its `- Node:` / `- OS:` lines (`HOST_LINE`).
 */
export const HOST_MEMBERS: Readonly<Record<string, readonly string[]>> = { capabilities: ['cpuCount', 'defaultWorkers'], environment: ['node', 'os'] };
const HOST_LINE = /^- (Node|OS): .*$/gm;

/**
 * The samples that report the host, declared: `draft_governance_issue` (its
 * compliance `environment` and the draft's Environment section). The
 * `describe_engine` example projects `capabilities` away with `fields`, so
 * its sample is host-independent. The regression suite holds the set of
 * samples {@link reportsHost} recognises to exactly this list, so a new
 * host-reporting member is a reviewed change, never a silent neutralisation.
 */
export const HOST_DEPENDENT_SAMPLES: readonly string[] = ['draft-governance-issue.json'];

/** True when the value carries a host member somewhere (a `capabilities` / `environment` object naming one). */
export function reportsHost(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(reportsHost);
    const obj = value as Record<string, unknown>;
    for (const [key, members] of Object.entries(HOST_MEMBERS)) {
        const holder = obj[key];
        if (holder !== null && typeof holder === 'object' && members.some((m) => m in (holder as Record<string, unknown>))) return true;
    }
    return Object.values(obj).some(reportsHost);
}

/**
 * The value with every host member replaced by `"<host>"` and the draft's host
 * lines neutralised. The draft result's `sizeBytes` is the byte length of its
 * `draftMarkdown`, host lines included, so it moves with the runner (the
 * first CI run of the baseline showed 5004 → 5025 B): it is neutralised
 * wherever it sits next to a `draftMarkdown` string.
 */
export function stripHost(value: unknown): unknown {
    if (typeof value === 'string') return value.replace(HOST_LINE, (_m, label: string) => `- ${label}: <host>`);
    if (Array.isArray(value)) return value.map(stripHost);
    if (value === null || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        const hostKeys = HOST_MEMBERS[k];
        if (hostKeys !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const inner: Record<string, unknown> = {};
            for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) inner[ik] = hostKeys.includes(ik) ? '<host>' : stripHost(iv);
            out[k] = inner;
        } else if (k === 'sizeBytes' && typeof obj['draftMarkdown'] === 'string') {
            out[k] = '<host>';
        } else {
            out[k] = stripHost(v);
        }
    }
    return out;
}

export interface Fingerprint {
    readonly mode: FingerprintMode;
    readonly hash: string;
    readonly size: number;
}

export interface BaselineEntry extends Fingerprint {
    /** The release whose output this hash is (carried forward while unchanged). */
    readonly since: string;
}

export interface Baseline {
    readonly $comment?: string;
    readonly baselineVersion: string;
    readonly provenance?: string;
    readonly timezone: string;
    readonly entries: Record<string, BaselineEntry>;
}

export interface ManifestEntry {
    readonly mode: FingerprintMode;
    readonly tool: string;
    readonly example: string;
    /** For an artefact fingerprinted semantically: the JSON result it stands for. */
    readonly sidecar?: string;
}

export interface SampleManifest {
    readonly generatedBy: string;
    readonly entries: Record<string, ManifestEntry>;
}

/** The version in package.json — stamped on newly baselined samples. */
export function currentVersion(): string {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function sha256Hex(data: Uint8Array | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return createHash('sha256').update(buf).digest('hex');
}

/** Yield every sample under `dir` (everything but the manifest), depth-first, in a stable order. */
export function* walkSamples(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) yield* walkSamples(p);
        else if (p !== MANIFEST_PATH) yield p;
    }
}

/** Forward-slashed path of a sample under `test-output/samples/`. */
export function relPath(abs: string): string {
    return relative(OUTPUT_DIR, abs).split('\\').join('/');
}

/**
 * Canonical JSON: object keys sorted at every depth, so the projection is
 * insertion-order independent and the hash is stable across runs.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The value with every volatile member removed, at every depth. */
export function stripVolatile(value: unknown, volatile: readonly string[] = VOLATILE_MEMBERS): unknown {
    if (Array.isArray(value)) return value.map((v) => stripVolatile(v, volatile));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!volatile.includes(k)) out[k] = stripVolatile(v, volatile);
    }
    return out;
}

/**
 * The semantic projection of a JSON sample: canonical JSON of the
 * `structuredContent` (the contract; the text block repeats it in prose) —
 * or, for a refusal, of `isError` and the code — without the volatile
 * members and with the host members neutralised. A sequence projects every step.
 */
export function semanticProjection(json: string): string {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const project = (result: Record<string, unknown>): unknown => {
        const error = (result['_meta'] as { error?: { code?: unknown } } | undefined)?.error;
        return {
            ...(result['isError'] === true ? { isError: true, code: error?.code ?? null } : {}),
            structuredContent: stripHost(stripVolatile(result['structuredContent'] ?? null)),
        };
    };
    const steps = parsed['steps'];
    return canonicalJson(Array.isArray(steps) ? { steps: (steps as Record<string, unknown>[]).map(project) } : project(parsed));
}

// ── Mode selection ───────────────────────────────────────────────────

/** True when the arguments ask for a wall-clock timestamp anywhere (`defaultDate: 'now'`). */
export function argsAskWallClock(args: unknown, depth = 0): boolean {
    if (depth > 8 || args === null || typeof args !== 'object') return false;
    if (Array.isArray(args)) return args.some((v) => argsAskWallClock(v, depth + 1));
    const obj = args as Record<string, unknown>;
    return obj['defaultDate'] === 'now' || Object.values(obj).some((v) => argsAskWallClock(v, depth + 1));
}

export interface ModeInput {
    /** The resolved arguments of the call that produced the artefact. */
    readonly args: Readonly<Record<string, unknown>>;
}

/** `bytes` for an archive over pinned inputs; `semantic` for one stamped with the wall clock. */
export function modeFor(input: ModeInput): FingerprintMode {
    return argsAskWallClock(input.args) ? 'semantic' : 'bytes';
}

// ── Fingerprinting ───────────────────────────────────────────────────

/** Fingerprint one sample in the mode the manifest recorded for it. */
export function fingerprint(absPath: string, entry: Pick<ManifestEntry, 'mode' | 'sidecar'>): Fingerprint {
    const bytes = readFileSync(absPath);
    if (entry.mode === 'bytes') return { mode: 'bytes', hash: sha256Hex(bytes), size: bytes.length };
    // An artefact in semantic mode stands for its sidecar's projection, prefixed so the two
    // entries never share a hash (a shared hash is what flags a collapsed showcase pair).
    if (entry.sidecar !== undefined) return { mode: 'semantic', hash: sha256Hex(`artefact\n${semanticProjection(readFileSync(join(OUTPUT_DIR, entry.sidecar), 'utf8'))}`), size: bytes.length };
    return { mode: 'semantic', hash: sha256Hex(semanticProjection(bytes.toString('utf8'))), size: bytes.length };
}

export function loadManifest(): SampleManifest | null {
    if (!existsSync(MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SampleManifest;
}

export interface FingerprintRun {
    readonly entries: Record<string, Fingerprint>;
    readonly unreadable: { readonly path: string; readonly error: string }[];
    /** Files on disk the manifest does not list, or listed but absent. */
    readonly unlisted: string[];
    readonly missing: string[];
}

/** Fingerprint every sample currently in `test-output/samples/`, in the mode its manifest entry names. */
export function fingerprintAll(): FingerprintRun {
    const entries: Record<string, Fingerprint> = {};
    const unreadable: { path: string; error: string }[] = [];
    const manifest = loadManifest();
    const listed = manifest?.entries ?? {};
    const onDisk = new Set<string>();
    for (const file of walkSamples(OUTPUT_DIR)) {
        const rel = relPath(file);
        onDisk.add(rel);
        const entry = listed[rel];
        if (entry === undefined) continue;
        try {
            entries[rel] = fingerprint(file, entry);
        } catch (err) {
            unreadable.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        }
    }
    const unlisted = [...onDisk].filter((rel) => !(rel in listed)).sort();
    const missing = Object.keys(listed).filter((rel) => !onDisk.has(rel)).sort();
    return { entries, unreadable, unlisted, missing };
}

export function loadBaseline(): Baseline | null {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
}

export interface Comparison {
    readonly changed: string[];
    readonly added: string[];
    readonly removed: string[];
}

export function compareToBaseline(entries: Record<string, Fingerprint>, baseline: Baseline): Comparison {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [rel, entry] of Object.entries(entries)) {
        const base = baseline.entries[rel];
        if (!base) { added.push(rel); continue; }
        if (base.mode !== entry.mode || base.hash !== entry.hash) changed.push(rel);
    }
    for (const rel of Object.keys(baseline.entries)) {
        if (!(rel in entries)) removed.push(rel);
    }
    return { changed, added, removed };
}

/**
 * Stamp each fingerprint with the release whose output it is.
 *
 * An entry that still hashes to what the previous manifest recorded keeps its
 * `since` untouched, which is what gives the chain meaning: an entry reading
 * `1.0.0` really is being held to the bytes v1.0.0 emitted. An entry whose
 * hash changed is being re-anchored to the tree under development, so it
 * takes the current version — otherwise a deliberate rebaseline would hide
 * inside a one-line hash diff instead of announcing itself.
 */
export function chainSince(
    entries: Record<string, Fingerprint>,
    previous: Baseline | null,
    version: string,
): Record<string, BaselineEntry> {
    const out: Record<string, BaselineEntry> = {};
    for (const key of Object.keys(entries).sort()) {
        const entry = entries[key] as Fingerprint;
        const before = previous?.entries[key];
        const unchanged = before !== undefined && before.mode === entry.mode && before.hash === entry.hash;
        out[key] = { ...entry, since: unchanged ? before.since : version };
    }
    return out;
}

/**
 * Samples that are expected to be byte-identical: each group is one output
 * produced two ways. Any other pair sharing a hash is a showcase whose "with"
 * and "without" variants collapsed into the same file.
 */
export const IDENTICAL_SAMPLE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [];

/**
 * Groups of samples that share a fingerprint without being listed in
 * {@link IDENTICAL_SAMPLE_GROUPS}. Empty when every duplicate is expected.
 */
export function unexpectedDuplicates(entries: Record<string, { readonly hash: string }>): string[][] {
    const byHash = new Map<string, string[]>();
    for (const [rel, entry] of Object.entries(entries)) {
        const group = byHash.get(entry.hash) ?? [];
        group.push(rel);
        byHash.set(entry.hash, group);
    }
    const allowed = IDENTICAL_SAMPLE_GROUPS.map((g) => [...g].sort().join('\n'));
    const out: string[][] = [];
    for (const group of byHash.values()) {
        if (group.length < 2) continue;
        const sorted = [...group].sort();
        if (!allowed.includes(sorted.join('\n'))) out.push(sorted);
    }
    return out.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}
