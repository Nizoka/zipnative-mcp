/**
 * Entry filters shared by `list_zip_entries`, `extract_zip` and
 * `scan_zip_forward`: exact names, a path prefix, or globs. The glob matcher is
 * vendored from zipnative-cli `src/utils/glob.ts` (dependency-free).
 *
 * Names are `/`-separated (archive convention). Glob syntax:
 *   **      any number of segments (also matches zero segments when written `**\/`)
 *   *       any run of characters within a segment
 *   ?       exactly one character within a segment
 *   [abc]   character class (passed through to the regex)
 * A pattern without `/` matches at any depth (`*.txt` ≡ `**\/*.txt`); a
 * pattern ending in `/` matches the whole subtree. Matching is case-sensitive.
 */
import { z } from 'zod';

import { MAX_FILTER_GLOBS, MAX_FILTER_NAMES } from './caps.js';

const RE_SPECIAL = /[.+^${}()|\\]/g;

function escapeLiteral(s: string): string {
    return s.replace(RE_SPECIAL, '\\$&');
}

/** Compile a glob pattern into an anchored RegExp over `/`-separated names. */
export function compileGlob(pattern: string): RegExp {
    let p = pattern.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    let source = '';
    let anyDepth = !p.includes('/');
    if (p.endsWith('/')) {
        p = p.slice(0, -1);
        source = '(?:/.*)?';
        anyDepth = false;
    }
    let body = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i] as string;
        if (c === '*') {
            if (p[i + 1] === '*') {
                i++;
                if (p[i + 1] === '/') {
                    i++;
                    body += '(?:.*/)?';
                } else {
                    body += '.*';
                }
            } else {
                body += '[^/]*';
            }
        } else if (c === '?') {
            body += '[^/]';
        } else if (c === '[') {
            const end = p.indexOf(']', i + 1);
            if (end === -1) {
                body += '\\[';
            } else {
                body += p.slice(i, end + 1);
                i = end;
            }
        } else {
            body += escapeLiteral(c);
        }
    }
    const prefix = anyDepth ? '(?:.*/)?' : '';
    return new RegExp(`^${prefix}${body}${source}$`);
}

/** JSON Schema fragment for the `filter` input (hand-kept in step with {@link FilterSchema}). */
export const FILTER_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    description:
        "Select entries by name. `names` (exact, case-sensitive), `prefix` (path prefix) and `glob` (patterns: `*` within a segment, `**` across segments, `?` one character; a pattern without `/` matches at any depth, a trailing `/` matches a whole subtree) are ANDed when several are given; `includeDirectories` (default false) keeps explicit directory entries.",
    properties: {
        names: { type: 'array', maxItems: MAX_FILTER_NAMES, items: { type: 'string', minLength: 1 }, description: 'Exact entry names to keep (case-sensitive; every duplicate of a name is kept).' },
        prefix: { type: 'string', minLength: 1, description: "Keep entries whose name starts with this prefix (e.g. 'src/')." },
        glob: { type: 'array', maxItems: MAX_FILTER_GLOBS, items: { type: 'string', minLength: 1 }, description: "Glob patterns; an entry matching ANY pattern is kept (e.g. ['**/*.json', 'docs/'])." },
        includeDirectories: { type: 'boolean', default: false, description: 'Keep explicit directory entries (names ending in `/`).' },
    },
} as const;

/** Zod twin of {@link FILTER_INPUT_SCHEMA}. */
export const FilterSchema = z.strictObject({
    names: z.array(z.string().min(1)).max(MAX_FILTER_NAMES).optional(),
    prefix: z.string().min(1).optional(),
    glob: z.array(z.string().min(1)).max(MAX_FILTER_GLOBS).optional(),
    includeDirectories: z.boolean().default(false),
});

export type FilterInput = z.infer<typeof FilterSchema>;

export type NameFilter = (name: string, isDirectory: boolean) => boolean;

/**
 * Compile a filter input into a predicate over (name, isDirectory). With no
 * input every non-directory entry passes. Directory names are matched with
 * and without their trailing slash.
 */
export function compileEntryFilter(input: FilterInput | undefined): NameFilter {
    const includeDirectories = input?.includeDirectories === true;
    const names = input?.names !== undefined ? new Set(input.names) : null;
    const prefix = input?.prefix;
    const globs = input?.glob !== undefined ? input.glob.map(compileGlob) : null;
    return (name, isDirectory) => {
        if (isDirectory && !includeDirectories) return false;
        const n = name.replace(/\\/g, '/');
        const bare = n.endsWith('/') ? n.slice(0, -1) : n;
        if (names !== null && !names.has(n) && !names.has(bare)) return false;
        if (prefix !== undefined && !n.startsWith(prefix)) return false;
        if (globs !== null && !globs.some((re) => re.test(n) || re.test(bare))) return false;
        return true;
    };
}

/** True when the filter keeps every non-directory entry (fast path). */
export function isPassThrough(input: FilterInput | undefined): boolean {
    return input === undefined || (input.names === undefined && input.prefix === undefined && input.glob === undefined);
}
