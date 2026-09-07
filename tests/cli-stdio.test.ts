import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end stdio smoke: spawns the built CLI and drives it over
 * newline-delimited JSON-RPC exactly as an MCP host would.
 *
 * Guards the two properties a stdio server cannot violate: stdout carries
 * nothing but JSON-RPC frames (engine diagnostics must stay on stderr), and
 * both protocol eras are served by the same process (2025 `initialize`
 * handshake here; `server/discover` probe for 2026-07-28 hosts).
 *
 * Requires `npm run build` (dist/cli.js). Locally the suite is skipped with a
 * console note when dist/ is absent; under CI (`process.env.CI` set) a missing
 * dist/ is a hard failure — the workflows must build before testing, otherwise
 * this end-to-end smoke would silently vanish from the release gate.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', 'dist', 'cli.js');
const hasDist = existsSync(CLI);
const inCi = process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';

if (!hasDist && !inCi) {
    console.warn(`[cli-stdio] dist/cli.js not found — run \`npm run build\` first; skipping the stdio smoke suite (it FAILS under CI).`);
}

describe('dist/cli.js presence', () => {
    it.runIf(inCi)('is built before the test run in CI (build must precede test in every workflow)', () => {
        expect(hasDist, `dist/cli.js is missing under CI — run \`npm run build\` before \`npm test\` (see .github/workflows/*.yml)`).toBe(true);
    });
});

interface Frame {
    id?: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
}

interface StdioSession {
    frames: Frame[];
    stdoutLines: string[];
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * After every expected response arrived the child is asked to stop. On POSIX
 * that is a real SIGTERM (the server's handler closes the transport and exits
 * 0). On win32 `child.kill('SIGTERM')` is Node's emulation over
 * TerminateProcess: the process is torn down without running any handler and
 * reports `{ code: null, signal: 'SIGTERM' }` (or code 1), so a clean-exit
 * assertion is impossible there — the tests below only assert termination on
 * Windows and assert `code 0 / signal null` on POSIX.
 */
function runStdioSession(messages: Array<Record<string, unknown>>, expectIds: number[]): Promise<StdioSession> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ZIPNATIVE_MCP_PORT: '' } });
        const stdoutLines: string[] = [];
        const frames: Frame[] = [];
        let stderr = '';
        let buffer = '';
        const pending = new Set(expectIds);
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`stdio session timed out; stderr: ${stderr}`));
        }, 20_000);

        child.stderr.on('data', (c: Buffer) => {
            stderr += c.toString('utf8');
        });
        child.stdout.on('data', (c: Buffer) => {
            buffer += c.toString('utf8');
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line.length === 0) continue;
                stdoutLines.push(line);
                try {
                    const frame = JSON.parse(line) as Frame;
                    frames.push(frame);
                    if (typeof frame.id === 'number') pending.delete(frame.id);
                } catch {
                    /* non-JSON line — asserted by the test */
                }
                if (pending.size === 0) {
                    child.kill('SIGTERM');
                }
            }
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ frames, stdoutLines, stderr, exitCode: code, signal });
        });
        child.on('error', reject);
        for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    });
}

/** Clean-exit assertion, platform-aware (see runStdioSession). */
function expectCleanExit(session: StdioSession): void {
    if (process.platform === 'win32') {
        // TerminateProcess: the child is gone, but no exit code is meaningful.
        expect(session.exitCode !== null || session.signal !== null, 'child process did not terminate').toBe(true);
        return;
    }
    expect(session.signal, `server was killed by ${session.signal} instead of exiting on SIGTERM; stderr: ${session.stderr}`).toBeNull();
    expect(session.exitCode, `SIGTERM exit code; stderr: ${session.stderr}`).toBe(0);
}

describe.skipIf(!hasDist)('dist/cli.js over stdio', () => {
    it.each(['2025-03-26', '2025-06-18'])('negotiates the older 2025 revision %s on stdio and serves tools/list', async (version) => {
        const session = await runStdioSession(
            [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'legacy', version: '0' } } },
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
            ],
            [1, 2],
        );
        const init = session.frames.find((f) => f.id === 1)?.result as { protocolVersion?: string } | undefined;
        expect(init?.protocolVersion).toBe(version);
        const tools = (session.frames.find((f) => f.id === 2)?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
        expect(tools.length).toBe(13);
    });

    it('serves a legacy initialize → tools/list → tools/call session with JSON-only stdout', async () => {
        const session = await runStdioSession(
            [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
                {
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    // defaultDate:'now' triggers the ZIP_TIMESTAMP_NOT_PINNED diagnostic — it must land in the result, never on stdout.
                    params: { name: 'create_zip', arguments: { entries: [{ name: 'hello.txt', text: 'hello stdio' }], defaultDate: 'now' } },
                },
            ],
            [1, 2, 3],
        );

        // Every stdout line must be a JSON-RPC frame — engine diagnostics (the
        // unpinned-timestamp warning triggered above) must never leak onto stdout.
        for (const line of session.stdoutLines) {
            expect(() => JSON.parse(line), `non-JSON stdout line: ${line.slice(0, 120)}`).not.toThrow();
        }
        expect(session.stderr).toContain('[zipnative-mcp] ready (stdio transport');

        const init = session.frames.find((f) => f.id === 1)?.result as { protocolVersion?: string; serverInfo?: { name?: string } } | undefined;
        expect(init?.protocolVersion).toBe('2025-11-25');
        expect(init?.serverInfo?.name).toBe('zipnative-mcp');

        const tools = (session.frames.find((f) => f.id === 2)?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
        expect(tools.length).toBe(13);

        const call = session.frames.find((f) => f.id === 3)?.result as { isError?: boolean; content?: Array<{ type: string; resource?: { mimeType?: string } }>; structuredContent?: { diagnostics?: Array<{ code: string }> } } | undefined;
        expect(call?.isError).not.toBe(true);
        expect(call?.content?.some((c) => c.type === 'resource' && c.resource?.mimeType === 'application/zip')).toBe(true);
        expect(call?.structuredContent?.diagnostics?.map((d) => d.code)).toContain('ZIP_TIMESTAMP_NOT_PINNED');
    });

    it('exits cleanly on SIGTERM once the session is done', async () => {
        const session = await runStdioSession(
            [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }],
            [1],
        );
        expect(session.frames.find((f) => f.id === 1)?.result).toBeDefined();
        expectCleanExit(session);
    });

    it('answers a 2026-07-28 server/discover probe', async () => {
        const session = await runStdioSession(
            [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'server/discover',
                    params: {
                        _meta: {
                            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                            'io.modelcontextprotocol/clientCapabilities': {},
                            'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '0' },
                        },
                    },
                },
            ],
            [1],
        );
        const result = session.frames.find((f) => f.id === 1)?.result as { supportedVersions?: string[]; resultType?: string } | undefined;
        expect(result?.resultType).toBe('complete');
        expect(result?.supportedVersions).toContain('2026-07-28');
    });
});

describe.skipIf(!hasDist)('dist/cli.js over stdio — large frames', () => {
    it('accepts a single JSON-RPC frame larger than the SDK default 10 MiB cap without dying', async () => {
        const big = 'A'.repeat(11 * 1024 * 1024); // ~11 MiB base64 string (decodes to zeros → not an archive, but the frame must arrive)
        const session = await runStdioSession(
            [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_zip', arguments: { zipBase64: big } } },
                { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
            ],
            [1, 2, 3],
        );
        expect(session.stderr).not.toContain('ReadBuffer exceeded');
        const call = session.frames.find((f) => f.id === 2)?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
        expect(call?.isError).toBe(true); // not a ZIP → tool error (ZIP_EOCD_NOT_FOUND), delivered
        expect(call?.content?.[0]?.text).toContain('ZIP_EOCD_NOT_FOUND');
        expect(session.frames.find((f) => f.id === 3)?.result).toBeDefined(); // the server is still alive afterwards
        expectCleanExit(session);
    }, 60_000);
});

describe.skipIf(!hasDist)('dist/cli.js — operator ceilings (ZIPNATIVE_MCP_MAX_ENTRIES)', () => {
    function spawnWithCeiling(value: string): Promise<{ code: number | null; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [CLI], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ZIPNATIVE_MCP_PORT: '', ZIPNATIVE_MCP_MAX_ENTRIES: value },
            });
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`startup timed out; stderr: ${stderr}`));
            }, 20_000);
            child.stderr.on('data', (c: Buffer) => {
                stderr += c.toString('utf8');
                // A valid ceiling is logged before "ready"; stop the child once it is serving.
                if (stderr.includes('ready (stdio transport')) child.kill('SIGTERM');
            });
            child.on('exit', (code) => {
                clearTimeout(timer);
                resolve({ code, stderr });
            });
            child.on('error', reject);
        });
    }

    it('refuses to start on an invalid value', async () => {
        const { code, stderr } = await spawnWithCeiling('lots');
        expect(code).toBe(1);
        expect(stderr).toContain('fatal:');
        expect(stderr).toContain('ZIPNATIVE_MCP_MAX_ENTRIES');
    });

    it('logs the applied ceiling and serves on a valid value', async () => {
        const { stderr } = await spawnWithCeiling('5000');
        expect(stderr).toContain('ZIPNATIVE_MCP_MAX_ENTRIES = 5000');
        expect(stderr).toContain('ready (stdio transport');
    });
});
