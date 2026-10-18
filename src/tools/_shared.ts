/**
 * Zod fragments shared by every tool (kept in lock-step with the JSON Schema
 * fragments exported by the modules they mirror).
 */
import { z } from 'zod';

import { MAX_FIELDS_PATHS } from '../caps.js';
import { ToolError } from '../errors.js';
import { LimitsSchema } from '../limits.js';
import { FIELD_PATH_PATTERN } from '../projection.js';

/** `verbosity` / `fields` (see `PROJECTION_INPUT_PROPERTIES`). */
export const ProjectionShape = {
    verbosity: z.enum(['full', 'summary']).default('full'),
    fields: z.array(z.string().min(1).regex(new RegExp(FIELD_PATH_PATTERN))).max(MAX_FIELDS_PATHS).optional(),
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
        description: 'Turn the first engine diagnostic into a ZIP_STRICT_DIAGNOSTIC error.',
    },
} as const;

/**
 * Refuse any object whose prototype is not the plain one (A-017). A JSON frame
 * can only produce such an object through a `__proto__` key: the transport's
 * envelope parsing copies keys by assignment, which turns an own `__proto__`
 * key into the prototype of the rebuilt object and drops it from the keys the
 * strict schemas see — the call would otherwise succeed silently instead of
 * being refused like the same key arriving in-process. Walks nested objects
 * and arrays; strings and other primitives are not walked.
 */
function assertPlainPrototypes(value: unknown, path: string, seen: Set<object>): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, i) => assertPlainPrototypes(item, `${path}[${i}]`, seen));
        return;
    }
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) {
        throw new ToolError('VALIDATION_ERROR', `Invalid arguments: ${path} carries a prototype other than Object.prototype (a "__proto__" key in the request); remove the key.`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) assertPlainPrototypes(item, `${path}.${key}`, seen);
}

/** Parse with a schema and convert a failure into `VALIDATION_ERROR`. */
export function parseInput<T>(schema: z.ZodType<T>, rawInput: unknown): T {
    assertPlainPrototypes(rawInput, 'arguments', new Set());
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
