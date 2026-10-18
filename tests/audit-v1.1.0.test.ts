/**
 * Lock tests of the zipnative-mcp 1.1.0 release audit (.audit/1.1.0/, two
 * independent auditors and a verifier). Each test is named after the finding
 * it closes; the finding's evidence command, re-run after the fix, is the
 * assertion below.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { __resetCeilingsForTests, MAX_UNCOMPRESSED_ENV } from '../src/caps.js';
import { ToolError } from '../src/errors.js';
import { readResource } from '../src/resources.js';
import { cacheNamespace, callToolDirect, ensureEngineReady } from '../src/server.js';
import { buildRawZip } from './_fixtures/raw-zip-builder.js';
import { JSON_HEADERS, legacyInitBody, send, startHttpFixture } from './_http-fixture.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip, bytesOf, DECLARED_BOMB, LFH_METHOD_MISMATCH, UNKNOWN_METHOD } from './_zip-fixtures.js';

type CallResult = Awaited<ReturnType<typeof callToolDirect>>;
const codeOf = (r: CallResult): string | undefined => (r._meta as { error?: { code?: string } } | undefined)?.error?.code;

/** A context whose signal is already aborted, as the MCP layer passes it after notifications/cancelled. */
function cancelled(): { signal: AbortSignal } {
    const controller = new AbortController();
    controller.abort(new Error('the client cancelled the request'));
    return { signal: controller.signal };
}

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    await ensureEngineReady();
});

describe('A-002: merge_zip verifies every copied payload or refuses it', () => {
    it('A-002: an entry whose method has no codec is ZIP_UNSUPPORTED_METHOD under verify:true (the default)', async () => {
        const r = await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(UNKNOWN_METHOD()) }, { zipBase64: b64(basicZip()) }] });
        expect(r.isError).toBe(true);
        expect(codeOf(r)).toBe('ZIP_UNSUPPORTED_METHOD');
    });

    it('A-002: verify:false still copies it unverified (the explicit relaxation), and says so', async () => {
        const r = await callToolDirect('merge_zip', { sources: [{ zipBase64: b64(UNKNOWN_METHOD()) }, { zipBase64: b64(basicZip()) }], verify: false });
        expect(r.isError, JSON.stringify(r.content[0])).not.toBe(true);
        expect((r.structuredContent as { summary: { verified: boolean } }).summary.verified).toBe(false);
    });
});

describe('A-003: cancellation reaches compute_crc32, inflate_raw and the start of verify_zip', () => {
    it('A-003: compute_crc32 under a cancelled request is CANCELLED', async () => {
        const r = await callToolDirect('compute_crc32', { text: 'x'.repeat(3 * 1024 * 1024) }, cancelled());
        expect(codeOf(r)).toBe('CANCELLED');
    });

    it('A-003: inflate_raw under a cancelled request is CANCELLED', async () => {
        const r = await callToolDirect('inflate_raw', { dataBase64: 'S0xKBgA=', maxOutput: 16 }, cancelled());
        expect(codeOf(r)).toBe('CANCELLED');
    });

    it('A-003: verify_zip honours a cancellation that arrives before the verification starts', async () => {
        const r = await callToolDirect('verify_zip', { zipBase64: b64(basicZip()) }, cancelled());
        expect(codeOf(r)).toBe('CANCELLED');
    });

    it('A-003: the chunked CRC equals the whole-input CRC (no behaviour change)', async () => {
        const text = 'zipnative '.repeat(300_000);
        const r = await callToolDirect('compute_crc32', { text });
        const { crc32 } = await import('zipnative');
        expect((r.structuredContent as { crc32: number }).crc32).toBe(crc32(new TextEncoder().encode(text)) >>> 0);
    });
});

describe('A-006: modify_zip append refuses what every other mutating tool refuses', () => {
    it('A-006: a central/local method divergence is refused before anything is re-emitted', async () => {
        const r = await callToolDirect('modify_zip', { zipBase64: b64(LFH_METHOD_MISMATCH()), operations: [{ op: 'setComment', comment: 'x' }] });
        expect(r.isError).toBe(true);
        expect(codeOf(r)).toBe('ZIP_CD_LFH_MISMATCH');
    });

    it('A-006: a declared-size bomb is refused (ZIP_LIMIT_EXCEEDED)', async () => {
        const r = await callToolDirect('modify_zip', { zipBase64: b64(DECLARED_BOMB()), operations: [{ op: 'setComment', comment: 'x' }] });
        expect(r.isError).toBe(true);
        expect(codeOf(r)).toBe('ZIP_LIMIT_EXCEEDED');
    });

    it('A-006: a clean archive still appends, byte-preserving', async () => {
        const original = basicZip();
        const r = await callToolDirect('modify_zip', { zipBase64: b64(original), operations: [{ op: 'add', name: 'new.txt', text: 'new' }] });
        expect(r.isError).not.toBe(true);
        const block = r.content.find((c) => c.type === 'resource') as { resource: { blob: string } };
        const out = new Uint8Array(Buffer.from(block.resource.blob, 'base64'));
        expect(Buffer.from(out.subarray(0, 30)).equals(Buffer.from(original.subarray(0, 30)))).toBe(true);
        assertValidZip(out, 'append');
    });
});

describe('A-007: the response-cache namespace carries the operator ceilings', () => {
    afterEach(() => {
        delete process.env[MAX_UNCOMPRESSED_ENV];
        __resetCeilingsForTests();
    });

    it('A-007: lowering a ceiling moves every cache key to a new namespace', () => {
        __resetCeilingsForTests();
        const before = cacheNamespace();
        process.env[MAX_UNCOMPRESSED_ENV] = String(1024 * 1024);
        __resetCeilingsForTests();
        const after = cacheNamespace();
        expect(after).not.toBe(before);
        expect(after).toContain(`ceilings:${1024 * 1024},`);
    });
});

describe('A-014: a malformed resource URI is a client error', () => {
    it('A-014: a bad percent-escape is UNKNOWN_RESOURCE (-32602), never an internal error', async () => {
        const err = await readResource('zipnative://output/%E0%A4%A').then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe('UNKNOWN_RESOURCE');
    });
});

describe('A-015: the HTTP guards run before the body is read', () => {
    it('A-015: a foreign Host with a body above the cap is 403 (refused on the headers), not 413', async () => {
        const fx = await startHttpFixture({ maxBodyBytes: 16 });
        try {
            const reply = await send(fx.port, { headers: { ...JSON_HEADERS, host: 'evil.example:80' }, body: legacyInitBody() });
            expect(reply.status).toBe(403);
        } finally {
            await fx.close();
        }
    });

    it('A-015: a missing bearer token with a body above the cap is 401, not 413', async () => {
        const fx = await startHttpFixture({ maxBodyBytes: 16, httpToken: 'a-long-enough-test-token-0123' });
        try {
            const reply = await send(fx.port, { headers: { ...JSON_HEADERS }, body: legacyInitBody() });
            expect(reply.status).toBe(401);
        } finally {
            await fx.close();
        }
    });
});

describe('B-009: verify_zip diagnostics are de-duplicated and capped like every other tool', () => {
    it('B-009: 250 distinct diagnostics give 200 rows and diagnosticsTruncated', async () => {
        const entries = Array.from({ length: 250 }, (_, i) => ({ name: new Uint8Array([0xff, 0xfe, ...bytesOf(`n${i}.txt`)]), data: bytesOf('x'), flags: 0x0800 }));
        const r = await callToolDirect('verify_zip', { zipBase64: b64(buildRawZip(entries)), entries: 'none' });
        expect(r.isError).not.toBe(true);
        const sc = r.structuredContent as { diagnostics: unknown[]; diagnosticsTruncated?: boolean };
        expect(sc.diagnostics).toHaveLength(200);
        expect(sc.diagnosticsTruncated).toBe(true);
    });

    it('B-009: a clean archive keeps the 1.0.0 shape (no truncation flag, no counts)', async () => {
        const r = await callToolDirect('verify_zip', { zipBase64: b64(basicZip()) });
        const sc = r.structuredContent as Record<string, unknown>;
        expect(sc['diagnosticsTruncated']).toBeUndefined();
        expect(sc['diagnosticCounts']).toBeUndefined();
    });
});
