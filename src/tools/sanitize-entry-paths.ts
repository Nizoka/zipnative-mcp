/**
 * Tool: sanitize_entry_paths — the engine's single traversal gate,
 * `sanitizeEntryPath()`, over a list of names: the safe relative form each
 * name maps to, or null with the rule that rejected it. The gate is the
 * `sanitized` value; `reason` is an explanatory re-derivation.
 */
import { z } from 'zod';
import { sanitizeEntryPath } from 'zipnative';

import { MAX_SANITIZE_NAMES } from '../caps.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { parseInput, ProjectionShape } from './_shared.js';

export const SANITIZE_ENTRY_PATHS_NAME = 'sanitize_entry_paths';

export const SANITIZE_REASONS = ['empty', 'nul', 'absolute', 'drive', 'unc', 'traversal', 'ads', 'device-name', 'no-segments'] as const;
export type SanitizeReason = (typeof SANITIZE_REASONS)[number];

export const SANITIZE_ENTRY_PATHS_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['names'],
    properties: {
        names: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_SANITIZE_NAMES,
            items: { type: 'string', maxLength: 4096 },
            description: 'Entry names to check (as stored in an archive).',
        },
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z.strictObject({
    names: z.array(z.string().max(4096)).min(1).max(MAX_SANITIZE_NAMES),
    ...ProjectionShape,
});

export interface SanitizeRow {
    readonly name: string;
    readonly sanitized: string | null;
    readonly rejected: boolean;
    readonly reason?: SanitizeReason;
}

export interface SanitizeEntryPathsResult {
    readonly count: number;
    readonly rejectedCount: number;
    readonly results: readonly SanitizeRow[];
}

export const SANITIZE_ENTRY_PATHS_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['count', 'rejectedCount', 'results'],
    properties: {
        count: { type: 'integer', minimum: 0 },
        rejectedCount: { type: 'integer', minimum: 0 },
        results: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    name: { type: 'string' },
                    sanitized: { type: ['string', 'null'], description: "Safe '/'-separated relative path to join under an extraction root, or null." },
                    rejected: { type: 'boolean' },
                    reason: { type: 'string', enum: [...SANITIZE_REASONS] },
                },
            },
        },
    },
} as const;

const RESERVED_WIN_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Re-derive the rule that made the engine return null (same order as the engine). */
export function sanitizeReason(name: string): SanitizeReason {
    if (name.length === 0) return 'empty';
    if (name.includes('\0')) return 'nul';
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('//')) return 'unc';
    if (normalized.startsWith('/')) return 'absolute';
    if (/^[A-Za-z]:/.test(normalized)) return 'drive';
    for (const segment of normalized.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') return 'traversal';
        if (segment.includes(':')) return 'ads';
        if (RESERVED_WIN_DEVICE.test(segment)) return 'device-name';
    }
    return 'no-segments';
}

export async function sanitizeEntryPaths(rawInput: unknown): Promise<SanitizeEntryPathsResult> {
    const input = parseInput(InputSchema, rawInput);
    const results: SanitizeRow[] = input.names.map((name) => {
        const sanitized = sanitizeEntryPath(name);
        return sanitized === null
            ? { name, sanitized: null, rejected: true, reason: sanitizeReason(name) }
            : { name, sanitized, rejected: false };
    });
    return { count: results.length, rejectedCount: results.filter((r) => r.rejected).length, results };
}

export function sanitizeSummary(r: SanitizeEntryPathsResult): Record<string, unknown> {
    return { count: r.count, rejectedCount: r.rejectedCount, rejectedNames: r.results.filter((x) => x.rejected).map((x) => x.name) };
}

export const SANITIZE_ENTRY_PATHS_SUMMARY_PROPERTIES = {
    rejectedNames: { type: 'array', items: { type: 'string' }, description: 'summary only: the rejected names.' },
} as const;
