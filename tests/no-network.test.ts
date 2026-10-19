/**
 * A-009 — the "no network" doctrine, held mechanically: no `fetch(`, no
 * `https`, no `dns`, no `net`, no WebSocket anywhere under src/; `node:http`
 * only in the loopback listener (src/http.ts, types only) and the CLI that
 * starts it (src/cli.ts, dynamically, so a stdio session never loads it). The
 * engine's byte-range reader is fed only by a sandbox file handle or inline
 * bytes (src/archive-input.ts), never by a remote source. No tool input is
 * named like a URL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listToolsPayload } from '../src/server.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
}

/** Source with comments stripped: the doctrine is about code, and a comment may name what the code refuses. */
function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES = walk(SRC).map((f) => [path.relative(SRC, f).split(path.sep).join('/'), code(readFileSync(f, 'utf8'))] as const);
const source = (file: string): string => FILES.find(([f]) => f === file)?.[1] ?? '';

describe('A-009: no network code path', () => {
    it('no fetch, https, dns, net, tls, http2 or WebSocket anywhere under src/', () => {
        for (const [file, text] of FILES) {
            // A global fetch() is a network client; `handler.fetch(request)` is the SDK's in-process Web-API handler.
            expect(text, file).not.toMatch(/(?<![.\w])fetch\s*\(/);
            expect(text, file).not.toMatch(/from\s+['"](?:node:)?(?:https|dns|tls|net|http2|dgram)['"]|require\(['"](?:node:)?(?:https|dns|tls|net|http2|dgram)['"]\)|import\(['"](?:node:)?(?:https|dns|tls|net|http2|dgram)['"]\)|WebSocket|XMLHttpRequest/);
        }
    });

    it('node:http is imported only by the loopback listener (types) and, dynamically, by the CLI that starts it', () => {
        const importers = FILES.filter(([, text]) => /['"]node:http['"]|['"]http['"]/.test(text)).map(([file]) => file).sort();
        expect(importers).toEqual(['cli.ts', 'http.ts']);
        const cli = source('cli.ts');
        expect(cli).toMatch(/await import\(['"]node:http['"]\)/);
        expect(cli).not.toMatch(/^import .* from ['"]node:http['"]/m);
        expect(cli).toMatch(/listen\(port, '127\.0\.0\.1'/);
        const http = source('http.ts');
        expect(http).toMatch(/^import type \{[^}]*\} from 'node:http';$/m);
        expect(http).toMatch(/localhostAllowedHostnames/);
        expect(http).not.toMatch(/\bhttp\.(request|get)\(|createConnection|\brequest\(\s*['"`]http/);
    });

    it('the byte-range reader is built from a sandbox file handle or inline bytes, never a remote source', () => {
        const input = source('archive-input.ts');
        expect(input).toMatch(/rangeSourceFromBytes/);
        expect(input).toMatch(/openInputFile|openSandboxFile/);
        for (const [file, text] of FILES) {
            expect(text, file).not.toMatch(/https?:\/\/[^'"`\s]*['"`]\s*[,)]/); // no URL literal handed to a call
        }
    });

    it('no tool input is named like a URL or an endpoint', () => {
        const names = new Set<string>();
        const collect = (schema: unknown): void => {
            if (schema === null || typeof schema !== 'object') return;
            const props = (schema as { properties?: Record<string, unknown> }).properties;
            if (props !== undefined) {
                for (const [k, v] of Object.entries(props)) {
                    names.add(k);
                    collect(v);
                }
            }
            const items = (schema as { items?: unknown }).items;
            if (items !== undefined) collect(items);
            for (const arm of ((schema as { anyOf?: unknown[] }).anyOf ?? (schema as { oneOf?: unknown[] }).oneOf ?? [])) collect(arm);
        };
        for (const tool of listToolsPayload().tools) collect(tool.inputSchema);
        const offenders = [...names].filter((n) => /url|uri|endpoint|href|fetch|download|proxy|host|remote/i.test(n));
        expect(offenders).toEqual([]);
    });
});
