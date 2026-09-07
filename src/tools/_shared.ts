/**
 * Zod fragments shared by every tool (kept in lock-step with the JSON Schema
 * fragments exported by the modules they mirror).
 */
import { z } from 'zod';

import { MAX_FIELDS_PATHS } from '../caps.js';
import { ToolError } from '../errors.js';
import { LimitsSchema } from '../limits.js';

/** `verbosity` / `fields` (see `PROJECTION_INPUT_PROPERTIES`). */
export const ProjectionShape = {
    verbosity: z.enum(['full', 'summary']).default('full'),
    fields: z.array(z.string().min(1)).max(MAX_FIELDS_PATHS).optional(),
};

/** `strict` / `limits` (see `LIMITS_INPUT_SCHEMA`). */
export const EngineOptionsShape = {
    strict: z.boolean().default(false),
    limits: LimitsSchema.optional(),
};

/** JSON Schema property for `strict`. */
export const STRICT_INPUT_PROPERTY = {
    strict: {
        type: 'boolean',
        default: false,
        description: 'Escalate the first engine diagnostic (prepended data, duplicate name, name mismatch, …) to a ZIP_STRICT_DIAGNOSTIC error instead of reporting it.',
    },
} as const;

/** Parse with a schema and convert a failure into `VALIDATION_ERROR`. */
export function parseInput<T>(schema: z.ZodType<T>, rawInput: unknown): T {
    const parsed = schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
        throw new ToolError('VALIDATION_ERROR', `Invalid arguments: ${parsed.error.message}`);
    }
    return parsed.data;
}

/** SHA-256 of bytes as lowercase hex (determinism proofs). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
}
