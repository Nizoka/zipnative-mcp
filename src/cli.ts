#!/usr/bin/env node
/**
 * CLI entry — wires the MCP server to a stdio transport (default) or a
 * Streamable HTTP endpoint when ZIPNATIVE_MCP_PORT is set.
 *
 * Protocol: MCP 2026-07-28 (stateless, `server/discover`, `subscriptions/listen`)
 * with automatic fallback to the 2025-era `initialize` handshake, so both
 * current and legacy clients (Claude Desktop, Cursor, Continue, …) are served
 * by the same binary.
 *
 * Transport selection:
 *   - stdio (default): suitable for local host integration (Claude Desktop, Cursor, etc.)
 *   - ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES / ZIPNATIVE_MCP_MAX_ENTRIES / ZIPNATIVE_MCP_WORKERS
 *     are the operator ceilings per-call `limits` cannot exceed (read once; an
 *     invalid value refuses to start).
 *   - HTTP: set ZIPNATIVE_MCP_PORT=<port> to expose the MCP endpoint on that port.
 *           Requests are POST /mcp (2026-07-28 clients send `Mcp-Method` / `Mcp-Name`
 *           headers and the `_meta` envelope; 2025-era clients use `initialize`).
 *           GET/DELETE answer 405 (stateless serving; no SSE resumability).
 *           Bound to 127.0.0.1 only; foreign Host/Origin headers are rejected (403).
 *
 * @example Claude Desktop config (stdio)
 * ```json
 * {
 *   "mcpServers": {
 *     "zipnative": {
 *       "command": "npx",
 *       "args": ["-y", "zipnative-mcp"],
 *       "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "/Users/me/Documents/mcp-archives" }
 *     }
 *   }
 * }
 * ```
 *
 * @example HTTP mode
 * ```bash
 * ZIPNATIVE_MCP_PORT=3000 npx zipnative-mcp
 * # Then connect via: http://127.0.0.1:3000/mcp
 * ```
 */
import { isAbsolute } from 'node:path';

import { getCeilings, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, STDIO_MAX_FRAME_BYTES, WORKERS_ENV } from './caps.js';
import { createServer, ensureEngineReady } from './server.js';

function log(line: string): void {
    process.stderr.write(`[zipnative-mcp] ${line}\n`);
}

async function main(): Promise<void> {
    await ensureEngineReady();
    // Operator ceilings are read once; an invalid value throws before serving.
    const ceilings = getCeilings();
    for (const [env, value] of [[MAX_UNCOMPRESSED_ENV, ceilings.maxUncompressedBytes], [MAX_ENTRIES_ENV, ceilings.maxEntries], [WORKERS_ENV, ceilings.maxWorkers]] as const) {
        if (process.env[env] !== undefined && process.env[env] !== '') log(`${env} = ${value}`);
    }

    const factory = (): ReturnType<typeof createServer> => createServer();
    const onerror = (err: Error): void => log(`transport error: ${err.message}`);
    // An operator knob is valid or the server does not start — never a silent fallback to stdio
    // (1.0.0 read '8080.5' as 8080 and 'abc' / '70000' as "no port").
    const portEnv = process.env['ZIPNATIVE_MCP_PORT'];
    const portText = portEnv?.trim() ?? '';
    const port = portText !== '' ? Number(portText) : null;
    if (port !== null && (!/^\d+$/.test(portText) || port < 1 || port > 65535)) {
        throw new Error(`ZIPNATIVE_MCP_PORT must be an integer between 1 and 65535 (got ${JSON.stringify(portEnv)}); unset it for stdio.`);
    }
    // The sandbox is an absolute path (README) or the server does not start: a relative value would
    // resolve against whatever directory the host happened to launch the server from.
    const outputDir = process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
    if (outputDir !== undefined && outputDir.trim() !== '' && !isAbsolute(outputDir.trim())) {
        throw new Error(`ZIPNATIVE_MCP_OUTPUT_DIR must be an absolute path (got ${JSON.stringify(outputDir)}).`);
    }

    if (port !== null) {
        // --- HTTP / Streamable HTTP transport ---
        const { createMcpHandler } = await import('@modelcontextprotocol/server');
        const { applySecurityHeaders, guardLoopback, hardenHttpServer, sendWebResponse, toWebRequest, RequestTooLargeError, MAX_REQUEST_BODY_BYTES } = await import('./http.js');
        const { createServer: createHttpServer } = await import('node:http');
        const { guardBearer, readHttpToken } = await import('./auth.js');
        // Opt-in bearer token (ZIPNATIVE_MCP_HTTP_TOKEN); a weak value throws before we listen.
        const httpToken = readHttpToken();

        // Both eras: 2026-07-28 requests are served by a fresh per-request instance;
        // 2025-era requests fall back to the stateless streamable-HTTP idiom.
        // The SDK's own body bound (4 MiB by default) is raised to the documented 256 MiB envelope:
        // up to 1.0.0 an inline archive above ~4 MiB failed over HTTP while stdio accepted it.
        const handler = createMcpHandler(factory, { legacy: 'stateless', onerror, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
        const origin = `http://127.0.0.1:${port}`;

        const httpServer = createHttpServer((req, res) => {
            void (async () => {
                applySecurityHeaders(res);
                try {
                    const path = new URL(req.url ?? '/', origin).pathname;
                    if (path !== '/mcp') {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Not Found. MCP endpoint is POST /mcp');
                        return;
                    }
                    const request = await toWebRequest(req, origin, res);
                    const response = guardLoopback(request) ?? guardBearer(request, httpToken) ?? (await handler.fetch(request));
                    await sendWebResponse(res, response);
                } catch (err) {
                    if (err instanceof RequestTooLargeError) {
                        if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'text/plain' });
                        res.end('Payload Too Large');
                        return;
                    }
                    onerror(err instanceof Error ? err : new Error(String(err)));
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                    }
                    res.end();
                }
            })();
        });

        hardenHttpServer(httpServer);

        const shutdown = async (signal: string): Promise<void> => {
            log(`received ${signal}, shutting down...`);
            try {
                await handler.close();
                httpServer.close();
            } finally {
                process.exit(0);
            }
        };
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));

        await new Promise<void>((resolve, reject) => {
            httpServer.listen(port, '127.0.0.1', () => {
                log(`ready (HTTP transport, MCP 2026-07-28 + legacy) on ${origin}/mcp${httpToken !== null ? ' — bearer token required' : ' — no authentication (loopback only)'}`);
                resolve();
            });
            httpServer.once('error', reject);
        });
    } else {
        // --- stdio transport (default) ---
        const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');

        // SDK v2 caps a single stdio frame at 10 MiB by default and closes the
        // transport (exiting the server) on overflow. Our tools legitimately
        // accept far larger inputs (multi-MiB base64 archives), so raise the cap
        // to the server's own envelope (see STDIO_MAX_FRAME_BYTES).
        const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_FRAME_BYTES });

        // The opening exchange pins the protocol era for this process
        // (`server/discover` probe → 2026-07-28, `initialize` → legacy).
        const handle = serveStdio(factory, { legacy: 'serve', onerror, transport });

        const shutdown = async (signal: string): Promise<void> => {
            log(`received ${signal}, shutting down...`);
            try {
                await handle.close();
            } finally {
                process.exit(0);
            }
        };
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));

        log('ready (stdio transport, MCP 2026-07-28 + legacy)');
    }
}

main().catch((err: unknown) => {
    // Configuration errors (weak token, bad ceiling) are reported as one clean line; anything
    // unexpected keeps its stack so the operator can file it.
    const configError = err instanceof Error && /ZIPNATIVE_MCP_/.test(err.message);
    const message = err instanceof Error ? (configError ? err.message : err.stack ?? err.message) : String(err);
    log(`fatal: ${message}`);
    process.exit(1);
});
