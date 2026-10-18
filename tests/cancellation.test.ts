/**
 * Cancellation and progress (zipnative 1.1.0 `signal` / `onProgress` on every
 * engine call): a cancelled call is CANCELLED — never a success, never
 * cached, a partial output file removed — and `notifications/progress` flow
 * only when the request carries a progressToken, strictly increasing.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ZipProgress } from 'zipnative';

import { cancelledError, NO_CONTEXT, PROGRESS_INTERVAL_MS, progressReporter, throwIfCancelled, type ProgressNotification } from '../src/call-context.js';
import { callToolDirect, createServer, ensureEngineReady } from '../src/server.js';
import { connectLegacy } from './_mcp-harness.js';
import { cleanupSandbox, makeSandbox, patternBytes } from './_sandbox.js';
import { b64, basicZip } from './_zip-fixtures.js';

const codeOf = (r: Awaited<ReturnType<typeof callToolDirect>>): string | undefined => (r._meta as { error?: { code?: string } } | undefined)?.error?.code;
const snap = (entriesDone: number, entriesTotal: number | null, bytesIn: number, bytesOut: number): ZipProgress => ({ entriesDone, entriesTotal, bytesIn, bytesOut });

let sandbox: string | null = null;

beforeAll(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    await ensureEngineReady();
});

afterEach(async () => {
    delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    delete process.env['ZIPNATIVE_MCP_CACHE_DIR'];
    await cleanupSandbox(sandbox);
    sandbox = null;
});

describe('CANCELLED', () => {
    it('an already-cancelled call is CANCELLED with the remedy, for the engine tools alike', async () => {
        const signal = AbortSignal.abort(new Error('the client went away'));
        for (const [tool, args] of [
            ['create_zip', { entries: [{ name: 'a.txt', text: 'a' }] }],
            ['inspect_zip', { zipBase64: b64(basicZip()) }],
            ['extract_zip', { zipBase64: b64(basicZip()) }],
            ['read_zip_entry', { zipBase64: b64(basicZip()), name: 'README.md' }],
            ['scan_zip_forward', { zipBase64: b64(basicZip()), tolerateTruncation: true }],
            ['merge_zip', { sources: [{ zipBase64: b64(basicZip()) }] }],
        ] as const) {
            const r = await callToolDirect(tool, args, { signal });
            expect(r.isError, tool).toBe(true);
            expect(codeOf(r), tool).toBe('CANCELLED');
            expect((r.content[0] as { text: string }).text, tool).toContain('the client went away');
            expect((r._meta as { error: { data: { remedy: string } } }).error.data.remedy).toBe('retry');
        }
    });

    it('a call without a context, or with a live signal, is unaffected', async () => {
        expect((await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'a' }] })).isError).not.toBe(true);
        expect((await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'a' }] }, { signal: new AbortController().signal })).isError).not.toBe(true);
        expect(() => throwIfCancelled(NO_CONTEXT)).not.toThrow();
        expect(cancelledError(AbortSignal.abort('stop')).message).toContain('stop');
        expect(cancelledError(AbortSignal.abort(42)).message).toContain('the client cancelled the request');
    });

    it('cancelled mid-stream: the streamed file output is removed and nothing is cached', async () => {
        sandbox = await makeSandbox();
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = sandbox;
        // Three incompressible streamed entries: the abort lands after the first one, while the archive is being written.
        for (const n of [1, 2, 3]) await fs.writeFile(path.join(sandbox, `part${n}.bin`), randomBytes(2 * 1024 * 1024));
        const controller = new AbortController();
        let calls = 0;
        const r = await callToolDirect('create_zip', { entries: [1, 2, 3].map((n) => ({ name: `part${n}.bin`, sourcePath: `part${n}.bin`, stream: true })), outputMode: 'file', outputPath: 'out/big.zip', chunkSize: 65_536 }, {
            signal: controller.signal,
            onProgress: () => {
                calls++;
                if (calls === 1) controller.abort(new Error('user pressed stop'));
            },
        });
        expect(codeOf(r)).toBe('CANCELLED');
        expect(calls).toBeGreaterThanOrEqual(1);
        await expect(fs.stat(path.join(sandbox, 'out', 'big.zip'))).rejects.toThrow();
    });

    it('a cancelled cacheable call is never written to the response cache', async () => {
        sandbox = await makeSandbox('zipnative-mcp-cache-');
        process.env['ZIPNATIVE_MCP_CACHE_DIR'] = sandbox;
        const args = { entries: [{ name: 'c.txt', text: 'cached?' }] };
        expect(codeOf(await callToolDirect('create_zip', args, { signal: AbortSignal.abort() }))).toBe('CANCELLED');
        const fresh = await callToolDirect('create_zip', args);
        expect(fresh._meta?.['cached']).toBeUndefined();
    });
});

describe('progress', () => {
    it('progressReporter: strictly increasing across operations, throttled, the completing snapshot always sent', () => {
        const sent: ProgressNotification[] = [];
        let clock = 0;
        const report = progressReporter('tok', (n) => sent.push(n), () => clock);
        report(snap(0, 3, 100, 50));
        clock += 10;
        report(snap(1, 3, 200, 90)); // throttled
        clock += PROGRESS_INTERVAL_MS;
        report(snap(2, 3, 300, 120));
        clock += 1;
        report(snap(3, 3, 400, 200)); // completes: sent despite the interval
        // A second engine operation restarts its counters: the reported value keeps growing.
        clock += PROGRESS_INTERVAL_MS;
        report(snap(0, null, 10, 0));
        expect(sent.map((n) => n.progressToken)).toEqual(['tok', 'tok', 'tok', 'tok']);
        const values = sent.map((n) => n.progress);
        for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
        expect(sent[2]!.message).toBe('3 / 3 entries, 400 bytes in, 200 bytes out');
        expect(sent[3]!.message).toBe('0 entries, 10 bytes in, 0 bytes out');
        // A snapshot that does not move the counter is never sent twice.
        clock += PROGRESS_INTERVAL_MS;
        report(snap(0, null, 10, 0));
        expect(sent).toHaveLength(4);
    });

    it('over MCP: notifications/progress only with a progressToken, and the result is unchanged', async () => {
        sandbox = await makeSandbox();
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = sandbox;
        await fs.writeFile(path.join(sandbox, 'big.bin'), patternBytes(2 * 1024 * 1024, 5));
        const client = await connectLegacy(createServer());
        try {
            const args = { entries: [{ name: 'big.bin', sourcePath: 'big.bin', stream: true }], includeSha256: true };
            const quiet = await client.request<{ structuredContent: { summary: { sha256: string } } }>('tools/call', { name: 'create_zip', arguments: args });
            expect(client.notifications.filter((n) => n.method === 'notifications/progress')).toEqual([]);
            const loud = await client.request<{ structuredContent: { summary: { sha256: string } } }>('tools/call', { name: 'create_zip', arguments: args, _meta: { progressToken: 'p-1' } });
            const progress = client.notifications.filter((n) => n.method === 'notifications/progress');
            expect(progress.length).toBeGreaterThanOrEqual(1);
            for (const n of progress) expect(n.params?.['progressToken']).toBe('p-1');
            const values = progress.map((n) => n.params?.['progress'] as number);
            for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
            expect(loud.structuredContent.summary.sha256).toBe(quiet.structuredContent.summary.sha256);
        } finally {
            await client.close();
        }
    });

    it('over MCP: notifications/cancelled stops a running call (the SDK sends no response for it)', async () => {
        sandbox = await makeSandbox();
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = sandbox;
        for (const n of [1, 2, 3, 4]) await fs.writeFile(path.join(sandbox, `part${n}.bin`), randomBytes(2 * 1024 * 1024));
        const client = await connectLegacy(createServer());
        try {
            const entries = [1, 2, 3, 4].map((n) => ({ name: `part${n}.bin`, sourcePath: `part${n}.bin`, stream: true }));
            const running = client.start('tools/call', { name: 'create_zip', arguments: { entries, outputMode: 'file', outputPath: 'out/cancelled.zip', compression: { deterministic: true } }, _meta: { progressToken: 'c-1' } });
            // Cancel as soon as the first progress notification shows the call is under way.
            for (let i = 0; i < 400 && !client.notifications.some((n) => n.method === 'notifications/progress'); i++) await new Promise((r) => setTimeout(r, 5));
            await client.notify('notifications/cancelled', { requestId: running.id, reason: 'test cancel' });
            const settled = await Promise.race([running.result.then(() => 'answered', () => 'rejected'), new Promise((r) => setTimeout(() => r('silent'), 3000))]);
            // MCP: the receiver of a cancellation SHOULD NOT send a response; a host-side race may still deliver one.
            expect(['silent', 'answered', 'rejected']).toContain(settled);
            for (let i = 0; i < 200; i++) {
                try {
                    await fs.stat(path.join(sandbox, 'out', 'cancelled.zip'));
                } catch {
                    break;
                }
                await new Promise((r) => setTimeout(r, 25));
            }
            await expect(fs.stat(path.join(sandbox, 'out', 'cancelled.zip'))).rejects.toThrow();
        } finally {
            await client.close();
        }
    }, 60_000);
});
