/**
 * The `limits` input fragment — zipnative's eight named `ZipLimits` bounds,
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

/** The eight `ZipLimits` keys, in engine order. */
export const LIMIT_KEYS = [
    'maxEntries',
    'maxEntryUncompressedSize',
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
        "Override zipnative's named security bounds for this call (CWE-400 / CWE-409 guards). Every key is optional; absent keys keep the engine defaults (maxEntries 100000, maxEntryUncompressedSize 1 GiB, maxTotalUncompressedSize 8 GiB, maxCompressionRatio 1024, maxNameBytes 4096, maxExtraFieldBytes 65535, maxCommentBytes 65535, maxCentralDirectoryBytes 256 MiB). Values above the operator ceilings (ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES, ZIPNATIVE_MCP_MAX_ENTRIES) are refused with LIMIT_CEILING_EXCEEDED. Raise a bound for trusted input only.",
    properties: {
        maxEntries: { type: 'integer', minimum: 1, description: 'Maximum central-directory entry count.' },
        maxEntryUncompressedSize: { type: 'integer', minimum: 1, description: 'Maximum decompressed size of one entry, bytes.' },
        maxTotalUncompressedSize: { type: 'integer', minimum: 1, description: 'Maximum total decompressed size across an extraction, bytes.' },
        maxCompressionRatio: { type: 'number', minimum: 1, description: 'Maximum declared uncompressed/compressed ratio for entries >= 1 KiB compressed (zip-bomb guard).' },
        maxNameBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Maximum entry-name length in bytes.' },
        maxExtraFieldBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Maximum extra-field block length in bytes.' },
        maxCommentBytes: { type: 'integer', minimum: 1, maximum: U16, description: 'Maximum comment length in bytes.' },
        maxCentralDirectoryBytes: { type: 'integer', minimum: 1, description: 'Maximum central-directory size in bytes.' },
    },
} as const;

/** Zod twin of {@link LIMITS_INPUT_SCHEMA}. */
export const LimitsSchema = z.strictObject({
    maxEntries: z.number().int().min(1).optional(),
    maxEntryUncompressedSize: z.number().int().min(1).optional(),
    maxTotalUncompressedSize: z.number().int().min(1).optional(),
    maxCompressionRatio: z.number().min(1).optional(),
    maxNameBytes: z.number().int().min(1).max(U16).optional(),
    maxExtraFieldBytes: z.number().int().min(1).max(U16).optional(),
    maxCommentBytes: z.number().int().min(1).max(U16).optional(),
    maxCentralDirectoryBytes: z.number().int().min(1).optional(),
});

export type LimitsInput = z.infer<typeof LimitsSchema>;

function ceilingFor(key: keyof ZipLimits, ceilings: Ceilings): { ceiling: number; env: string } | null {
    if (key === 'maxEntryUncompressedSize' || key === 'maxTotalUncompressedSize') {
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
