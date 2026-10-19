/**
 * The `limits` input fragment — zipnative's nine named `ZipLimits` bounds,
 * exposed by name on every engine-touching tool — and the operator ceilings
 * that per-call values may never exceed.
 *
 * Raising a limit is always an explicit decision (the engine's doctrine);
 * `Infinity` is not JSON, so "disable" is spelled as the ceiling. A value
 * above the ceiling is refused with `LIMIT_CEILING_EXCEEDED` naming the
 * environment variable an operator would raise.
 */
import { z } from 'zod';
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from 'zipnative';

import { getCeilings, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, type Ceilings } from './caps.js';
import { ToolError } from './errors.js';

/** The nine `ZipLimits` keys, in engine order (`maxEntryCompressedSize` joined in zipnative 1.1.0). */
export const LIMIT_KEYS = [
    'maxEntries',
    'maxEntryUncompressedSize',
    'maxEntryCompressedSize',
    'maxTotalUncompressedSize',
    'maxCompressionRatio',
    'maxNameBytes',
    'maxExtraFieldBytes',
    'maxCommentBytes',
    'maxCentralDirectoryBytes',
] as const satisfies readonly (keyof ZipLimits)[];

const U16 = 65_535;

/** JSON Schema fragment for the `limits` input (hand-kept in step with {@link LimitsSchema}). */
export const LIMITS_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    description:
        "Per-call override of zipnative's security bounds (CWE-400/409); absent keys keep the engine defaults (describe_engine.defaultLimits). A value above its operator ceiling is LIMIT_CEILING_EXCEEDED. Raise only for trusted input.",
    properties: {
        maxEntries: { type: 'integer', minimum: 1, description: 'Entries.' },
        maxEntryUncompressedSize: { type: 'integer', minimum: 1, description: 'Bytes, one entry decompressed.' },
        maxEntryCompressedSize: { type: 'integer', minimum: 1, description: 'Bytes, one compressed payload fetched by the byte-range reader (access range).' },
        maxTotalUncompressedSize: { type: 'integer', minimum: 1, description: 'Bytes, all entries decompressed.' },
        maxCompressionRatio: { type: 'number', minimum: 1, description: 'Declared ratio (entries ≥ 1 KiB compressed).' },
        maxNameBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Bytes.' },
        maxExtraFieldBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Bytes.' },
        maxCommentBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Bytes.' },
        maxCentralDirectoryBytes: { type: 'integer', minimum: 1, description: 'Bytes.' },
    },
} as const;

/** Zod twin of {@link LIMITS_INPUT_SCHEMA}. */
export const LimitsSchema = z.strictObject({
    maxEntries: z.number().int().min(1).optional(),
    maxEntryUncompressedSize: z.number().int().min(1).optional(),
    maxEntryCompressedSize: z.number().int().min(1).optional(),
    maxTotalUncompressedSize: z.number().int().min(1).optional(),
    maxCompressionRatio: z.number().min(1).optional(),
    maxNameBytes: z.number().int().min(1).max(U16).optional(),
    maxExtraFieldBytes: z.number().int().min(1).max(U16).optional(),
    maxCommentBytes: z.number().int().min(1).max(U16).optional(),
    maxCentralDirectoryBytes: z.number().int().min(1).optional(),
});

export type LimitsInput = z.infer<typeof LimitsSchema>;

function ceilingFor(key: keyof ZipLimits, ceilings: Ceilings): { ceiling: number; env: string } | null {
    if (key === 'maxEntryUncompressedSize' || key === 'maxEntryCompressedSize' || key === 'maxTotalUncompressedSize') {
        return { ceiling: ceilings.maxUncompressedBytes, env: MAX_UNCOMPRESSED_ENV };
    }
    if (key === 'maxEntries') return { ceiling: ceilings.maxEntries, env: MAX_ENTRIES_ENV };
    return null;
}

/**
 * Merge caller limits over the engine defaults, enforcing the operator
 * ceilings. Returns `undefined` when nothing was requested and no ceiling is
 * tighter than the engine default (so the engine's own defaults apply verbatim).
 */
export function resolveCallLimits(requested: LimitsInput | undefined, ceilings: Ceilings = getCeilings()): Partial<ZipLimits> | undefined {
    const out: Partial<Record<keyof ZipLimits, number>> = {};
    for (const key of LIMIT_KEYS) {
        const value = requested?.[key];
        const bound = ceilingFor(key, ceilings);
        if (value !== undefined) {
            if (bound !== null && value > bound.ceiling) {
                throw new ToolError(
                    'LIMIT_CEILING_EXCEEDED',
                    `limits.${key} = ${value} exceeds the operator ceiling ${bound.ceiling} (${bound.env}). Raise the ceiling in the server environment for trusted input only.`,
                    { limit: key, requested: value, ceiling: bound.ceiling, env: bound.env },
                );
            }
            out[key] = value;
        } else if (bound !== null && bound.ceiling < DEFAULT_ZIP_LIMITS[key]) {
            // A ceiling below the engine default tightens the default silently: the
            // operator asked for it, and an agent cannot exceed it anyway.
            out[key] = bound.ceiling;
        }
    }
    return Object.keys(out).length === 0 ? undefined : out;
}

/** The limits that are in force for a call, for reporting (`describe_engine`, summaries). */
export function effectiveLimits(requested: LimitsInput | undefined, ceilings: Ceilings = getCeilings()): ZipLimits {
    return { ...DEFAULT_ZIP_LIMITS, ...(resolveCallLimits(requested, ceilings) ?? {}) };
}
