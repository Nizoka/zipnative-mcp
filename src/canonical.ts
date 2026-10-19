/**
 * The canonical-form options shared by `canonicalize_zip` and `modify_zip`
 * (`canonical`): zipnative 1.1.0's `CanonicalOptions`, exposed by name.
 *
 * The canonical form is what zipnative's own writer emits under the
 * determinism contract — entries sorted by raw name bytes, one timestamp
 * (the DOS epoch, or the pinned `date`), the UTF-8 flag on every name, no
 * extra field but Zip64, the constant version-made-by, no data descriptor —
 * reached WITHOUT recompressing a payload. The engine owns the rules; this
 * module only maps the JSON input onto them. `date` is read as UTC, like
 * every date this server writes (`dosTimeMode: 'utc'`).
 */
import { z } from 'zod';
import type { CanonicalOptions } from 'zipnative';

import { ISO_DATE_PATTERN, parseEntryDate } from './entry-spec.js';

const DATE_DESCRIPTION = 'The one timestamp written on every entry (ISO-8601, 1980-01-01 … 2107-12-31, read as UTC; 2-second DOS granularity). Default: the DOS epoch 1980-01-01T00:00:00 — the deterministic default. Pass the same value to inspect_zip `canonicalDate` to verify the result.';
const KEEP_COMMENTS_DESCRIPTION = 'Keep the archive comment and the entry comments (default false: the canonical form carries none).';
const KEEP_ATTRIBUTES_DESCRIPTION = "Keep each entry's external attributes — Unix modes, DOS attributes (default true); false writes the canonical defaults (0o100644 files, 0o40755 directories).";

/** JSON Schema properties of the canonical options (spread into canonicalize_zip; nested as modify_zip `canonical`). */
export const CANONICAL_OPTION_PROPERTIES = {
    date: { type: 'string', pattern: ISO_DATE_PATTERN, description: DATE_DESCRIPTION },
    keepComments: { type: 'boolean', default: false, description: KEEP_COMMENTS_DESCRIPTION },
    keepExternalAttributes: { type: 'boolean', default: true, description: KEEP_ATTRIBUTES_DESCRIPTION },
} as const;

/** Zod twin of {@link CANONICAL_OPTION_PROPERTIES}. */
export const CanonicalOptionShape = {
    date: z.string().regex(new RegExp(ISO_DATE_PATTERN)).optional(),
    keepComments: z.boolean().default(false),
    keepExternalAttributes: z.boolean().default(true),
};

export interface CanonicalOptionInput {
    readonly date?: string | undefined;
    readonly keepComments: boolean;
    readonly keepExternalAttributes: boolean;
}

/** Map the JSON options onto the engine's `CanonicalOptions` (`where` names the field in a date refusal). */
export function toCanonicalOptions(input: CanonicalOptionInput, where: string): CanonicalOptions {
    return {
        ...(input.date !== undefined ? { date: parseEntryDate(input.date, `${where}date`) } : {}),
        keepComments: input.keepComments,
        keepExternalAttributes: input.keepExternalAttributes,
    };
}
