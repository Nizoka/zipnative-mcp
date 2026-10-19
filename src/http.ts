/**
 * Minimal bridge between `node:http` and the web-standard `Request` /
 * `Response` pair consumed by the MCP SDK v2 HTTP handler
 * (`createMcpHandler(...).fetch`). Deliberately dependency-free: the
 * `@modelcontextprotocol/node` adapter would pull in an HTTP framework, which
 * this project's zero-dependency policy forbids.
 *
 * Also hosts the loopback guard (DNS-rebinding protection): the endpoint binds
 * to 127.0.0.1 only, so Host and Origin are pinned to loopback authorities and
 * any foreign value is answered with 403 before the request reaches MCP.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    originValidationResponse,
} from '@modelcontextprotocol/server';

/** Methods that carry a body per RFC 9110 (GET/HEAD/DELETE must not pass one to `Request`). */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** Largest request body accepted (256 MiB — the same envelope as the stdio frame cap). */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024;

/** Thrown by {@link toWebRequest} when the body exceeds {@link MAX_REQUEST_BODY_BYTES}. */
export class RequestTooLargeError extends Error {
    constructor(limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = 'RequestTooLargeError';
    }
}

/**
 * Convert a Node request into a web-standard `Request`. The body is buffered
 * (MCP JSON-RPC bodies are bounded) so the SDK can clone it for era detection;
 * headers are copied verbatim (array values joined with `, `), and the
 * request is aborted when the client connection closes so long-lived
 * `subscriptions/listen` streams are torn down promptly.
 */
export interface ToWebRequestOptions {
    /** Body cap in bytes (default {@link MAX_REQUEST_BODY_BYTES}); exposed so tests can exercise the 413 path cheaply. */
    readonly maxBodyBytes?: number;
}

/**
 * The request line and headers only, as a Web `Request` without a body (A-015): the Host / Origin
 * and bearer guards run on it BEFORE the body is buffered, so a foreign or unauthenticated client
 * cannot make the server read up to 256 MiB first.
 */
export function toWebHead(req: IncomingMessage, origin: string): Request {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    return new Request(new URL(req.url ?? '/', origin), { method: 'GET', headers });
}

export async function toWebRequest(req: IncomingMessage, origin: string, res?: ServerResponse, opts?: ToWebRequestOptions): Promise<Request> {
    const maxBodyBytes = opts?.maxBodyBytes ?? MAX_REQUEST_BODY_BYTES;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const method = (req.method ?? 'GET').toUpperCase();
    const controller = new AbortController();
    // Abort the in-flight MCP request when the client goes away. For POST the
    // request side is fully consumed before the handler runs, so the reliable
    // signal is the *response* closing before it finished — observed on the
    // per-request response object, never on the (keep-alive, shared) socket,
    // so listeners cannot accumulate across requests on one connection.
    const onGone = (): void => {
        if (!controller.signal.aborted) controller.abort();
    };
    req.once('close', () => {
        if (!req.readableEnded || !req.complete) onGone();
    });
    res?.once('close', () => {
        if (!res.writableFinished) onGone();
    });
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (BODY_METHODS.has(method)) {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
            total += buf.byteLength;
            if (total > maxBodyBytes) throw new RequestTooLargeError(maxBodyBytes);
            chunks.push(buf);
        }
        init.body = new Uint8Array(Buffer.concat(chunks));
    }
    return new Request(new URL(req.url ?? '/', origin), init);
}

/**
 * Headers set on every HTTP response, whatever produced it (the MCP handler,
 * the loopback / token guards, the 404 / 413 / 500 paths): a JSON-RPC answer
 * is never content-sniffed by a browser nor stored by an intermediary.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
};

/**
 * Node `http.Server` timeouts (1.1.0): a client that trickles its headers or
 * its body can no longer hold a socket open indefinitely (slowloris). The
 * request timeout leaves room for a 256 MiB body on a slow loopback.
 */
export const HTTP_SERVER_LIMITS = {
    headersTimeoutMs: 30_000,
    requestTimeoutMs: 300_000,
    keepAliveTimeoutMs: 5_000,
    maxHeadersCount: 100,
} as const;

/** Apply {@link HTTP_SERVER_LIMITS} to a Node HTTP server. */
export function hardenHttpServer(server: { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; maxHeadersCount: number | null }): void {
    server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeoutMs;
    server.requestTimeout = HTTP_SERVER_LIMITS.requestTimeoutMs;
    server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeoutMs;
    server.maxHeadersCount = HTTP_SERVER_LIMITS.maxHeadersCount;
}

/** Set {@link SECURITY_HEADERS} on a Node response before anything is written. */
export function applySecurityHeaders(res: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * Write a web-standard `Response` to a Node response. Streams (SSE) are piped
 * chunk by chunk; the Node side closing cancels the web stream.
 */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    // The SDK sets its own Cache-Control on a legacy-era 200 (`no-cache, no-transform`); the
    // documented promise is `no-store` on every response, so the security headers win (R-027).
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers[name.toLowerCase()] = value;
    res.writeHead(response.status, headers);
    if (response.body === null) {
        res.end();
        return;
    }
    const body = response.body;
    const nodeStream = Readable.fromWeb(body as unknown as NodeReadableStream);
    res.once('close', () => {
        if (!res.writableFinished) nodeStream.destroy();
    });
    await new Promise<void>((resolve, reject) => {
        nodeStream.once('error', reject);
        res.once('finish', resolve);
        res.once('close', resolve);
        nodeStream.pipe(res);
    });
}

/**
 * DNS-rebinding / Origin protection. Returns a 403 `Response` when the Host or
 * Origin header names anything other than a loopback authority, `undefined`
 * when the request may proceed. Missing Origin (non-browser clients) passes.
 */
export function guardLoopback(request: Request): Response | undefined {
    return (
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins()) ??
        originPortResponse(request)
    );
}

/**
 * The SDK's Origin check is port-agnostic (any `http://localhost:<n>` passes).
 * A local web page served on another port is still a cross-site caller, so
 * additionally require the Origin port to be this server's own port.
 */
function originPortResponse(request: Request): Response | undefined {
    const origin = request.headers.get('origin');
    if (origin === null || origin === '') return undefined;
    let originPort: string;
    try {
        originPort = new URL(origin).port;
    } catch {
        return forbidden('Invalid Origin header');
    }
    const ownPort = new URL(request.url).port;
    if (originPort === ownPort) return undefined;
    return forbidden(`Origin port ${originPort === '' ? '(default)' : originPort} does not match the server port ${ownPort}`);
}

function forbidden(message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
    });
}
