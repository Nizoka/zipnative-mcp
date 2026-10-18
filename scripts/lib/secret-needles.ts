/**
 * zipnative-mcp — secret material a document must never carry
 * ===========================================================
 * The `no-secret-material` rule of scripts/verify-docs.ts (ported from
 * pkinative-mcp 1.0.0). A ZIP server holds no key material of its own: the
 * one secret it handles is the operator's bearer token
 * (`ZIPNATIVE_MCP_HTTP_TOKEN`), and the leaks worth catching in a document,
 * an example, a release note or a draft are:
 *
 *   - a token literal the test suite uses (`const TOKEN = '…'` under tests/):
 *     a document that copies one teaches every reader a known credential;
 *   - a concrete `ZIPNATIVE_MCP_HTTP_TOKEN=<value>` / `Authorization: Bearer
 *     <value>` whose value is not an obvious placeholder (`<token>`, `…`,
 *     `change-me…`, `$TOKEN`);
 *   - a registry or forge credential (`npm_…`, `ghp_…`, `github_pat_…`);
 *   - a PRIVATE KEY PEM block with a real base64 body;
 *   - an absolute path of the development host.
 *
 * Pure over text except `buildSecretNeedles(root)`, which reads the test
 * sources the way pkinative's read its key fixtures. Scripts never import
 * `tests/` or `src/`, so the needles are recomputed from text.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Shortest needle kept: a token below this is too short to be a credential (the server refuses < 16). */
export const MIN_NEEDLE_LENGTH = 16;

/** `const TOKEN = 'correct-horse…'`, `HTTP_TOKEN: "…"` — a token-named binding to a string literal. */
const TOKEN_LITERAL = /\b[A-Z_]*TOKEN[A-Z_]*\s*[:=]\s*(['"`])([^'"`\s]{16,})\1/g;

/** The token literals of one source text (tests/auth.test.ts, the HTTP fixtures). */
export function tokenLiterals(sourceText: string): string[] {
    const out = new Set<string>();
    TOKEN_LITERAL.lastIndex = 0;
    for (const m of sourceText.matchAll(TOKEN_LITERAL)) {
        const value = m[2] as string;
        if (!isPlaceholderSecret(value)) out.add(value);
    }
    return [...out];
}

/**
 * The needle table: every token literal the test suite binds (tests/**.ts).
 * Returns `[]` when `tests/` is absent, so a caller can skip rather than fail.
 */
export function buildSecretNeedles(root: string): readonly string[] {
    const dir = join(root, 'tests');
    if (!existsSync(dir)) return [];
    const needles = new Set<string>();
    const walk = (d: string): void => {
        for (const entry of readdirSync(d).sort()) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            const full = join(d, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(?:ts|mts|mjs)$/.test(entry)) for (const t of tokenLiterals(readFileSync(full, 'utf8'))) needles.add(t);
        }
    };
    walk(dir);
    return [...needles].filter((n) => n.length >= MIN_NEEDLE_LENGTH).sort();
}

/**
 * True when a secret-shaped value is an illustration rather than a credential:
 * an angle-bracket or shell placeholder, an ellipsis, a run of x / *, or a
 * value that says what it is (`change-me`, `your-token`, `example`, `secret`).
 */
export function isPlaceholderSecret(value: string): boolean {
    if (/[<>{}$…]|\.\.\./.test(value)) return true;
    if (/x{4,}|\*{3,}|0{8,}/i.test(value)) return true;
    return /change|replace|your|example|placeholder|secret|token|random|redacted|dummy|sample/i.test(value);
}

export interface SecretFinding {
    /** Character offset of the match in the text. */
    readonly index: number;
    readonly reason: string;
}

/** `-----BEGIN (EC |RSA |ENCRYPTED )?PRIVATE KEY-----` followed by a base64 body of 40+ characters (whitespace ignored). */
export const PRIVATE_KEY_BLOCK = /-----BEGIN (?:EC |RSA |ENCRYPTED |OPENSSH )?PRIVATE KEY-----\s*((?:[A-Za-z0-9+/=]+\s*)+)/g;

/** Registry and forge credentials by their published prefixes. */
export const CREDENTIAL_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
    { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, what: 'an npm access token' },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, what: 'a GitHub token' },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, what: 'a GitHub fine-grained token' },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, what: 'an AWS access key id' },
];

/** `ZIPNATIVE_MCP_HTTP_TOKEN=value`, `"ZIPNATIVE_MCP_HTTP_TOKEN": "value"`, `$env:ZIPNATIVE_MCP_HTTP_TOKEN = 'value'`. */
const TOKEN_ASSIGNMENT = /\bZIPNATIVE_MCP_HTTP_TOKEN["']?\s*[:=]\s*["']?([^\s"'`,;)]+)/g;
/** `Authorization: Bearer value` with a concrete value. */
const BEARER_VALUE = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g;

/** Paths of the development host that a published document must never carry. */
export const DEV_HOST_PATHS: readonly RegExp[] = [/\bD:\\/g, /\/d\/Github\//g, /\bC:\\Users\\/g];

/**
 * Every secret-material finding in a text: a needle of the table, a concrete
 * bearer token, a registry or forge credential, a private-key PEM block with
 * a real body, or a development-host absolute path.
 */
export function findSecretMaterial(text: string, needles: readonly string[]): SecretFinding[] {
    const out: SecretFinding[] = [];
    for (const n of needles) {
        const at = text.indexOf(n);
        if (at !== -1) out.push({ index: at, reason: `carries a token literal of the test suite (${n.slice(0, 6)}…, ${n.length} chars) — documents illustrate a token with <token>` });
    }
    for (const re of [TOKEN_ASSIGNMENT, BEARER_VALUE]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const value = m[1] as string;
            if (value.length < MIN_NEEDLE_LENGTH || isPlaceholderSecret(value) || needles.includes(value)) continue;
            out.push({ index: m.index, reason: `carries a concrete bearer token (${value.slice(0, 4)}…, ${value.length} chars) — documents illustrate a token with <token> or change-me` });
        }
    }
    for (const { pattern, what } of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        const hit = pattern.exec(text);
        if (hit !== null) out.push({ index: hit.index, reason: `carries ${what} (${hit[0].slice(0, 8)}…)` });
    }
    PRIVATE_KEY_BLOCK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRIVATE_KEY_BLOCK.exec(text)) !== null) {
        const body = (m[1] as string).replace(/\s+/g, '');
        if (body.length >= 40) out.push({ index: m.index, reason: 'carries a PRIVATE KEY PEM block with a base64 body — documents illustrate keys with an ellipsis, never with bytes' });
    }
    for (const re of DEV_HOST_PATHS) {
        re.lastIndex = 0;
        const hit = re.exec(text);
        if (hit !== null) out.push({ index: hit.index, reason: `carries a development-host absolute path (${hit[0]}…) — documents quote relative paths only` });
    }
    return out.sort((a, b) => a.index - b.index);
}
