/**
 * Prototype-pollution resistance (ported from pkinative-mcp 1.0.0): an input
 * carrying `__proto__`, `constructor` or `prototype` keys — at the top level,
 * inside an entry, an operation, the limits block, a filter, a compression or
 * parallel block, an assert block, a governance reproduction, or a projection
 * path — never reaches `Object.prototype` and is refused with a documented
 * code. The inputs are built with JSON.parse so `__proto__` is an OWN
 * property, exactly as a JSON-RPC frame delivers it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { callToolDirect, createServer, ensureEngineReady, toolNames } from '../src/server.js';
import { selectFields } from '../src/projection.js';
import { WRAPPER_CODE_NAMES } from '../src/wrapper-codes.js';
import { ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { connectLegacy } from './_mcp-harness.js';
import { b64, basicZip } from './_zip-fixtures.js';

const DOCUMENTED = new Set<string>([...WRAPPER_CODE_NAMES, ...ZIP_ERROR_CODES]);
const POISON = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}';
const poison = (): Record<string, unknown> => JSON.parse(POISON) as Record<string, unknown>;
/** Wrap a JSON value so that `__proto__` appears as an own key at the given place. */
function withPoison(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(`${JSON.stringify(value).slice(0, -1)},${POISON.slice(1)}`) as Record<string, unknown>;
}

const ZIP = b64(basicZip());
const PROTO_SNAPSHOT = Object.getOwnPropertyNames(Object.prototype).sort();
const ARRAY_SNAPSHOT = Object.getOwnPropertyNames(Array.prototype).sort();

function assertUnpolluted(label: string): void {
    expect(({} as Record<string, unknown>)['polluted'], label).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>)['polluted'], label).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort(), label).toEqual(PROTO_SNAPSHOT);
    expect(Object.getOwnPropertyNames(Array.prototype).sort(), label).toEqual(ARRAY_SNAPSHOT);
}

async function call(tool: string, args: unknown, label: string): Promise<string | null> {
    const result = await callToolDirect(tool, args);
    assertUnpolluted(`${label}: after ${tool}`);
    const code = (result._meta as { error?: { code?: string } } | undefined)?.error?.code ?? null;
    if (result.isError === true) {
        expect(code, label).not.toBeNull();
        expect(DOCUMENTED.has(code!), `${label}: ${code}`).toBe(true);
    }
    return code;
}

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    await ensureEngineReady();
});

describe('prototype pollution', () => {
    it('a poisoned top-level object is VALIDATION_ERROR for every tool (strict objects refuse unknown keys)', async () => {
        for (const tool of toolNames()) {
            expect(await call(tool, poison(), tool), tool).toBe('VALIDATION_ERROR');
        }
    });

    it('a poisoned nested block is refused at every depth', async () => {
        expect(await call('create_zip', { entries: [withPoison({ name: 'a', text: 'a' })] }, 'entry')).toBe('VALIDATION_ERROR');
        expect(await call('create_zip', { entries: [{ name: 'a', text: 'a' }], compression: poison() }, 'compression')).toBe('VALIDATION_ERROR');
        expect(await call('create_zip', { entries: [{ name: 'a', text: 'a' }], parallel: poison() }, 'parallel')).toBe('VALIDATION_ERROR');
        expect(await call('modify_zip', { zipBase64: ZIP, operations: [withPoison({ op: 'remove', name: 'README.md' })] }, 'operation')).toBe('VALIDATION_ERROR');
        expect(await call('inspect_zip', { zipBase64: ZIP, limits: poison() }, 'limits')).toBe('VALIDATION_ERROR');
        expect(await call('inspect_zip', { zipBase64: ZIP, assert: poison() }, 'assert')).toBe('VALIDATION_ERROR');
        expect(await call('list_zip_entries', { zipBase64: ZIP, filter: poison() }, 'filter')).toBe('VALIDATION_ERROR');
        expect(await call('extract_zip', { zipBase64: ZIP, filter: withPoison({ glob: ['*.md'] }) }, 'extract filter')).toBe('VALIDATION_ERROR');
        expect(await call('draft_governance_issue', {
            title: 'A reasonable title', summary: 'A summary that is long enough.', issueType: 'bug', reproduction: withPoison({ command: 'x', result: 'y' }),
            expectedBehavior: 'works', duplicateSearchPerformed: true,
        }, 'reproduction')).toBe('VALIDATION_ERROR');
    });

    it('a prototype segment anywhere in a fields path is VALIDATION_ERROR (ported A2-052)', async () => {
        for (const fields of [['__proto__'], ['entries.constructor'], ['prototype.x'], ['a.__proto__.b']]) {
            expect(await call('list_zip_entries', { zipBase64: ZIP, fields }, JSON.stringify(fields))).toBe('VALIDATION_ERROR');
        }
        expect(await call('list_zip_entries', { zipBase64: ZIP, fields: ['entryCount', 'entries.name'] }, 'legit')).toBeNull();
        expect(await call('inspect_zip', { zipBase64: ZIP, verbosity: '__proto__' }, 'verbosity')).toBe('VALIDATION_ERROR');
    });

    it('selectFields walks own properties only and keeps a __proto__ key as data', () => {
        const value = JSON.parse('{"a":1,"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
        expect(selectFields(value, ['toString'])).toEqual({});
        expect(selectFields({ a: 1 }, ['constructor'])).toEqual({});
        const merged = selectFields(value, ['a', '__proto__']) as Record<string, unknown>;
        expect(Object.hasOwn(merged, 'a')).toBe(true);
        assertUnpolluted('selectFields');
    });

    it('entry names and comments that spell prototype keys are ordinary strings', async () => {
        const code = await call('create_zip', { entries: [{ name: '__proto__', text: 'x' }, { name: 'constructor/prototype', text: 'y' }], comment: '__proto__' }, 'names');
        expect(code).toBeNull();
    });
});

describe('A-017: prototype pollution through the MCP transport', () => {
    it('A-017: over the transport a root __proto__ key is stripped by the SDK envelope (zod record) and the call runs clean; a nested one is VALIDATION_ERROR', async () => {
        const client = await connectLegacy(createServer());
        try {
            const root = JSON.parse('{"name":"sanitize_entry_paths","arguments":{"names":["a.txt"],"__proto__":{"polluted":"yes"}}}') as Record<string, unknown>;
            const stripped = await client.request<{ isError?: boolean; structuredContent: { results: Array<{ sanitized: string }> } }>('tools/call', root);
            expect(stripped.isError).not.toBe(true);
            expect(stripped.structuredContent.results[0]?.sanitized).toBe('a.txt');
            const nested = JSON.parse('{"name":"create_zip","arguments":{"entries":[{"name":"a","text":"a","__proto__":{"polluted":"yes"}}]}}') as Record<string, unknown>;
            const refused = await client.request<{ isError?: boolean; content: Array<{ text?: string }> }>('tools/call', nested);
            expect(refused.isError).toBe(true);
            expect(refused.content[0]?.text).toContain('[VALIDATION_ERROR]');
            assertUnpolluted('after the poisoned frames');
            const ok = await client.request<{ isError?: boolean; structuredContent: { results: Array<{ sanitized: string }> } }>('tools/call', { name: 'sanitize_entry_paths', arguments: { names: ['a.txt'] } });
            expect(ok.isError).not.toBe(true);
            expect(ok.structuredContent.results[0]?.sanitized).toBe('a.txt');
        } finally {
            await client.close();
        }
    });
});

describe('A-017: an object whose prototype was replaced (what a __proto__ key becomes after the transport rebuilt the object)', () => {
    it('A-017: is VALIDATION_ERROR at the root and nested, naming the key, and leaves Object.prototype alone', async () => {
        const replaced = (own: Record<string, unknown>): Record<string, unknown> => Object.assign(Object.create({ polluted: 'yes' }) as Record<string, unknown>, own);
        const root = await callToolDirect('sanitize_entry_paths', replaced({ names: ['a.txt'] }));
        expect((root._meta as { error?: { code?: string; message?: string } }).error?.code).toBe('VALIDATION_ERROR');
        expect((root._meta as { error?: { message?: string } }).error?.message).toContain('__proto__');
        const nested = await callToolDirect('create_zip', { entries: [replaced({ name: 'a', text: 'a' })] });
        expect((nested._meta as { error?: { code?: string; message?: string } }).error?.code).toBe('VALIDATION_ERROR');
        expect((nested._meta as { error?: { message?: string } }).error?.message).toContain('arguments.entries[0]');
        assertUnpolluted('replaced prototypes');
    });
});
