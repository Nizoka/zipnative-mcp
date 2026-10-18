/**
 * Entry filters shared by `list_zip_entries`, `extract_zip` and
 * `scan_zip_forward`: exact names, a path prefix, or globs. The glob syntax is
 * the one zipnative-cli `src/utils/glob.ts` defines (dependency-free).
 *
 * Names are `/`-separated (archive convention). Glob syntax:
 *   **      any number of segments (also matches zero segments when written `**\/`)
 *   *       any run of characters within a segment
 *   ?       exactly one character within a segment
 *   [abc]   character class: ranges `a-z`, negation `[^…]` (one character, `/` included)
 * A pattern without `/` matches at any depth (`*.txt` ≡ `**\/*.txt`); a
 * pattern ending in `/` matches the whole subtree. Matching is case-sensitive.
 *
 * Linear-time matching (1.1.0). Up to 1.0.0 a pattern was translated into a
 * backtracking RegExp, and an archive controls the names it is matched
 * against: `*a*a*a` over a 2 000-character name took seconds (CWE-1333). The
 * pattern now compiles to a token list run as a Thompson NFA — every step
 * advances a set of at most `tokens + 1` states, so one match costs
 * O(name × pattern) whatever the input. An invalid class range (`[z-a]`) is a
 * `VALIDATION_ERROR` at the boundary instead of an uncaught `SyntaxError`.
 */
import { z } from 'zod';

import { MAX_FILTER_GLOBS, MAX_FILTER_NAMES, MAX_GLOB_LENGTH } from './caps.js';

type Token =
    | { readonly kind: 'literal'; readonly char: number }
    /** `?` — one code unit other than `/`. */
    | { readonly kind: 'one' }
    /** `[…]` — one code unit in (or, negated, outside) the ranges. */
    | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: ReadonlyArray<readonly [number, number]> }
    /** `*` — zero or more code units other than `/`. */
    | { readonly kind: 'star' }
    /** `**` — zero or more code units, `/` included. */
    | { readonly kind: 'globstar' }
    /** `**\/` (and the implicit any-depth prefix) — empty, or anything ending in `/`. */
    | { readonly kind: 'dirs' }
    /** A trailing `/` — empty, or `/` followed by anything (the whole subtree). */
    | { readonly kind: 'subtree' };

const SLASH = 0x2f;

/** Thrown by {@link compileGlob} for a pattern no matcher can be built from. */
export class GlobSyntaxError extends Error {
    override readonly name = 'GlobSyntaxError';
}

/** Parse the body of a `[…]` class (between the brackets). */
function parseClass(body: string): Extract<Token, { kind: 'class' }> {
    const negated = body.startsWith('^');
    const chars = negated ? body.slice(1) : body;
    const ranges: Array<readonly [number, number]> = [];
    for (let i = 0; i < chars.length; i++) {
        const lo = chars.charCodeAt(i);
        if (chars[i + 1] === '-' && i + 2 < chars.length) {
            const hi = chars.charCodeAt(i + 2);
            if (hi < lo) throw new GlobSyntaxError(`invalid character class range '${chars[i]}-${chars[i + 2]}' (the end precedes the start)`);
            ranges.push([lo, hi]);
            i += 2;
        } else {
            ranges.push([lo, lo]);
        }
    }
    return { kind: 'class', negated, ranges };
}

/** Tokenise a glob pattern (the syntax of the module header). */
function tokenize(pattern: string): Token[] {
    let p = pattern.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    let subtree = false;
    let anyDepth = !p.includes('/');
    if (p.endsWith('/')) {
        p = p.slice(0, -1);
        subtree = true;
        anyDepth = false;
    }
    const tokens: Token[] = anyDepth ? [{ kind: 'dirs' }] : [];
    for (let i = 0; i < p.length; i++) {
        const c = p[i] as string;
        if (c === '*') {
            if (p[i + 1] === '*') {
                i++;
                if (p[i + 1] === '/') {
                    i++;
                    tokens.push({ kind: 'dirs' });
                } else {
                    tokens.push({ kind: 'globstar' });
                }
            } else {
                tokens.push({ kind: 'star' });
            }
        } else if (c === '?') {
            tokens.push({ kind: 'one' });
        } else if (c === '[') {
            const end = p.indexOf(']', i + 1);
            if (end === -1) {
                tokens.push({ kind: 'literal', char: c.charCodeAt(0) });
            } else {
                tokens.push(parseClass(p.slice(i + 1, end)));
                i = end;
            }
        } else {
            tokens.push({ kind: 'literal', char: c.charCodeAt(0) });
        }
    }
    if (subtree) tokens.push({ kind: 'subtree' });
    return tokens;
}

function classMatches(token: Extract<Token, { kind: 'class' }>, code: number): boolean {
    const inside = token.ranges.some(([lo, hi]) => code >= lo && code <= hi);
    return token.negated ? !inside : inside;
}

/** A compiled glob: `test(name)` in O(name × pattern). */
export interface GlobMatcher {
    test(name: string): boolean;
}

/*
 * NFA states: `2 * i` is "about to match token i" (i === tokens.length is the
 * accepting state); `2 * i + 1` is "inside token i" — used by `dirs`
 * (consumed something, may only leave right after a `/`) and `subtree`
 * (consumed the `/`, swallows the rest).
 */

/** Add `state` and every state reachable from it without consuming input. */
function close(tokens: readonly Token[], state: number, into: Set<number>): void {
    if (into.has(state)) return;
    into.add(state);
    if (state % 2 === 1) {
        // Inside `subtree`: the rest of the name is accepted.
        if (tokens[(state - 1) / 2]?.kind === 'subtree') close(tokens, 2 * tokens.length, into);
        return;
    }
    const token = tokens[state / 2];
    if (token === undefined) return;
    if (token.kind === 'star' || token.kind === 'globstar' || token.kind === 'dirs' || token.kind === 'subtree') close(tokens, state + 2, into);
}

/** Compile a glob pattern into a linear-time matcher over `/`-separated names. */
export function compileGlob(pattern: string): GlobMatcher {
    const tokens = tokenize(pattern);
    const accept = 2 * tokens.length;
    const start = new Set<number>();
    close(tokens, 0, start);
    return {
        test(name: string): boolean {
            let current = start;
            for (let at = 0; at < name.length && current.size > 0; at++) {
                const code = name.charCodeAt(at);
                const next = new Set<number>();
                for (const state of current) {
                    const index = state >> 1;
                    const token = tokens[index];
                    if (token === undefined) continue;
                    if (state % 2 === 1) {
                        if (token.kind === 'dirs') {
                            close(tokens, state, next);
                            if (code === SLASH) close(tokens, 2 * index + 2, next);
                        } else {
                            close(tokens, state, next);
                        }
                        continue;
                    }
                    switch (token.kind) {
                        case 'literal':
                            if (code === token.char) close(tokens, state + 2, next);
                            break;
                        case 'one':
                            if (code !== SLASH) close(tokens, state + 2, next);
                            break;
                        case 'class':
                            if (classMatches(token, code)) close(tokens, state + 2, next);
                            break;
                        case 'star':
                            if (code !== SLASH) close(tokens, state, next);
                            break;
                        case 'globstar':
                            close(tokens, state, next);
                            break;
                        case 'dirs':
                            close(tokens, state + 1, next);
                            if (code === SLASH) close(tokens, state + 2, next);
                            break;
                        case 'subtree':
                            if (code === SLASH) close(tokens, state + 1, next);
                            break;
                    }
                }
                current = next;
            }
            return current.has(accept);
        },
    };
}

/** Null when `pattern` compiles, else the reason it does not. */
export function globError(pattern: string): string | null {
    try {
        compileGlob(pattern);
        return null;
    } catch (err) {
        /* v8 ignore next */
        return err instanceof Error ? err.message : String(err);
    }
}

/** JSON Schema fragment for the `filter` input (hand-kept in step with {@link FilterSchema}). */
export const FILTER_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    description:
        "Select entries by name. `names` (exact, case-sensitive), `prefix` (path prefix) and `glob` (patterns: `*` within a segment, `**` across segments, `?` one character, `[a-z]` / `[^…]` one character of a class; a pattern without `/` matches at any depth, a trailing `/` matches a whole subtree) are ANDed when several are given; `includeDirectories` (default false) keeps explicit directory entries.",
    properties: {
        names: { type: 'array', maxItems: MAX_FILTER_NAMES, items: { type: 'string', minLength: 1 }, description: 'Exact entry names to keep (case-sensitive; every duplicate of a name is kept).' },
        prefix: { type: 'string', minLength: 1, description: "Keep entries whose name starts with this prefix (e.g. 'src/')." },
        glob: { type: 'array', maxItems: MAX_FILTER_GLOBS, items: { type: 'string', minLength: 1, maxLength: MAX_GLOB_LENGTH }, description: `Glob patterns (≤ ${MAX_GLOB_LENGTH} characters each, matched in linear time); an entry matching ANY pattern is kept (e.g. ['**/*.json', 'docs/']). An invalid class range such as '[z-a]' is a VALIDATION_ERROR.` },
        includeDirectories: { type: 'boolean', default: false, description: 'Keep explicit directory entries (names ending in `/`).' },
    },
} as const;

/** Zod twin of {@link FILTER_INPUT_SCHEMA}. */
export const FilterSchema = z.strictObject({
    names: z.array(z.string().min(1)).max(MAX_FILTER_NAMES).optional(),
    prefix: z.string().min(1).optional(),
    glob: z.array(
        z.string().min(1).max(MAX_GLOB_LENGTH).superRefine((pattern, ctx) => {
            const reason = globError(pattern);
            if (reason !== null) ctx.addIssue({ code: 'custom', message: `invalid glob: ${reason}` });
        }),
    ).max(MAX_FILTER_GLOBS).optional(),
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
