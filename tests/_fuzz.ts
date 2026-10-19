/**
 * Seeded fuzzing helpers — deterministic by construction (ported from
 * pkinative-mcp tests/_fuzz.ts, itself from pdfnative-mcp).
 *
 * A fuzz suite that uses `Math.random()` finds a bug once and never again.
 * Every generator here draws from mulberry32 with a fixed seed, so a failure
 * reproduces on every machine from the case number alone, and the suite has
 * the same cost on every run. No dependency: the PRNG is eight lines.
 */

/** mulberry32: a small, well-distributed 32-bit PRNG. */
export function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Rng {
    readonly next: () => number;
    readonly int: (min: number, max: number) => number;
    readonly bool: (p?: number) => boolean;
    readonly pick: <T>(items: readonly T[]) => T;
}

export function rng(seed: number): Rng {
    const next = prng(seed);
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    return {
        next,
        int,
        bool: (p = 0.5) => next() < p,
        pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T,
    };
}

/** Values that break naive validators: wrong types, extremes, prototype keys, odd strings, ZIP look-alikes. */
export const HOSTILE_VALUES: readonly unknown[] = [
    null, true, false, 0, -1, 1, 1.5, -0, 1e21, -1e21, Number.MAX_SAFE_INTEGER, NaN, Infinity,
    '', ' ', 'null', 'undefined', '__proto__', 'constructor', 'prototype', '0', '-1', '1e9',
    'auto', 'range', 'memory', 'file', 'inline', 'compact', 'append', 'last', '2027-13-01T00:00:00Z', '1979-12-31T23:59:59Z',
    'UEsDBA==', 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', '!!!not-base64!!!', 'data:application/zip;base64,UEsFBg==',
    '**', '[z-a]', '*a*a*a*a*a*a*a*a*a*a*a*a*b', '\\', '{', 'a'.repeat(1100),
    '\u0000', '\u202e', '\ud800', '<script>', '../../etc/passwd', 'C:\\Windows\\system32', '//server/share', 'aux.zip', 'out/../../x.zip',
    [], [0], [''], ['x'], [null], [{}], Array.from({ length: 300 }, () => 'x'),
    {}, { __proto__: null }, { constructor: 1 }, { length: 4 }, { offset: -1, length: 1 }, { prefix: '' }, { glob: '[' }, { zipBase64: '' }, { zipBase64: 'x', zipPath: 'x' },
];

const ERROR_LINE = / failed \[([A-Z][A-Z0-9_]+)\]: /;

export interface FuzzResult {
    readonly isError?: boolean;
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly _meta?: Record<string, unknown>;
}

/** The ToolError code of a failed call, or null when the failure carries none (an unexpected throw). */
export function errorCodeOf(result: FuzzResult): string | null {
    const meta = (result._meta?.['error'] as { code?: string } | undefined)?.code;
    if (meta !== undefined) return meta;
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    return ERROR_LINE.exec(text)?.[1] ?? null;
}

/** Little-endian u32 / u16 writes, for the structural mutations. */
function writeU32(out: Uint8Array, at: number, value: number): void {
    if (at < 0 || at + 4 > out.length) return;
    out[at] = value & 0xff;
    out[at + 1] = (value >>> 8) & 0xff;
    out[at + 2] = (value >>> 16) & 0xff;
    out[at + 3] = (value >>> 24) & 0xff;
}

/** The offset of the last end-of-central-directory signature, or -1. */
function eocdAt(bytes: Uint8Array): number {
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    return -1;
}

/**
 * Flip, truncate, overwrite or lie about the structure of an archive,
 * deterministically. The structural cases aim at the fields a ZIP reader
 * trusts: the EOCD counts and offsets, the central-directory sizes, the
 * local-header lengths.
 */
export function mutate(bytes: Uint8Array, r: Rng): Uint8Array {
    const out = new Uint8Array(bytes);
    const eocd = eocdAt(out);
    switch (r.int(0, 7)) {
        case 0: // truncate
            return out.subarray(0, r.int(0, Math.max(0, out.length - 1)));
        case 1: // flip a few bytes anywhere
            for (let i = 0, n = r.int(1, 8); i < n; i++) out[r.int(0, out.length - 1)] = r.int(0, 255);
            return out;
        case 2: // corrupt the first local header (method, flags, sizes, name length)
            for (let i = 0, n = r.int(1, 6); i < n; i++) out[r.int(4, Math.min(out.length - 1, 29))] = r.int(0, 255);
            return out;
        case 3: // zero a window
            out.fill(0, r.int(0, out.length - 1), r.int(0, out.length));
            return out;
        case 4: // EOCD: lie about the entry counts
            if (eocd >= 0) {
                out[eocd + 8] = r.int(0, 255);
                out[eocd + 10] = r.pick([0x00, 0x01, 0xff]);
                out[eocd + 11] = r.pick([0x00, 0xff]);
            }
            return out;
        case 5: // EOCD: point the central directory somewhere else, or claim a size past the buffer
            if (eocd >= 0) writeU32(out, eocd + r.pick([12, 16]), r.pick([0, 1, 0xffffffff, out.length, r.int(0, out.length)]));
            return out;
        case 6: // central directory: corrupt sizes / offsets of the first record
            if (eocd >= 0) {
                const cd = (out[eocd + 16] ?? 0) | ((out[eocd + 17] ?? 0) << 8) | ((out[eocd + 18] ?? 0) << 16) | ((out[eocd + 19] ?? 0) << 24);
                writeU32(out, cd + r.pick([16, 20, 24, 42]), r.pick([0, 0xffffffff, 0x7fffffff, r.int(0, 0xffff)]));
            }
            return out;
        default: { // duplicate a slice at the end (trailing data), or before the start (a prefix)
            const at = r.int(0, out.length - 1);
            const slice = out.subarray(at, Math.min(out.length, at + r.int(1, 64)));
            return r.bool() ? new Uint8Array([...out, ...slice]) : new Uint8Array([...slice, ...out]);
        }
    }
}
