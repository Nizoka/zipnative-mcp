/**
 * In-process MCP client harness for tests.
 *
 * Drives a `createServer()` instance through the SDK's `InMemoryTransport`
 * with raw JSON-RPC, so tests exercise the real wire path (request/result
 * validation, codec projection) instead of reaching into SDK internals.
 * Era: legacy 2025-11-25 `initialize` handshake by default (what today's
 * hosts speak); the HTTP tests cover the 2026-07-28 envelope separately.
 */
import { InMemoryTransport, type Server } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export class McpRpcError extends Error {
    readonly code: number;
    readonly data: unknown;
    constructor(err: JsonRpcError) {
        super(err.message);
        this.name = 'McpRpcError';
        this.code = err.code;
        this.data = err.data;
    }
}

export interface McpTestClient {
    request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
    listTools(): Promise<{ tools: Array<Record<string, unknown> & { name: string }> }>;
    callTool<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
    readResource<T = Record<string, unknown>>(uri: string): Promise<T>;
    getPrompt<T = Record<string, unknown>>(name: string): Promise<T>;
    /** Every server notification received so far (progress, logging, …), in order. */
    readonly notifications: Array<{ readonly method: string; readonly params?: Record<string, unknown> }>;
    /** Send a request and get its id with the pending result (to cancel it with notifications/cancelled). */
    start<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): { readonly id: number; readonly result: Promise<T> };
    /** Send a client notification. */
    notify(method: string, params?: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
}

/**
 * Connect a fresh (or supplied) server through an in-memory transport and
 * complete the legacy `initialize` handshake.
 */
export async function connectLegacy(server: Server = createServer(), protocolVersion = '2025-11-25'): Promise<McpTestClient> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let nextId = 1;

    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    clientSide.onmessage = (message) => {
        if (!('id' in message) || message.id === undefined || message.id === null) {
            if ('method' in message) notifications.push({ method: message.method, ...('params' in message && message.params !== undefined ? { params: message.params as Record<string, unknown> } : {}) });
            return;
        }
        const entry = pending.get(Number(message.id));
        if (entry === undefined) return;
        pending.delete(Number(message.id));
        if ('error' in message) {
            entry.reject(new McpRpcError(message.error as JsonRpcError));
        } else if ('result' in message) {
            entry.resolve(message.result);
        }
    };

    await server.connect(serverSide);
    await clientSide.start();

    const start = <T,>(method: string, params: Record<string, unknown> = {}): { id: number; result: Promise<T> } => {
        const id = nextId++;
        const result = new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve: (v) => resolve(v as T), reject });
            void clientSide.send({ jsonrpc: '2.0', id, method, params });
        });
        return { id, result };
    };
    const request = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => start<T>(method, params).result;

    await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'zipnative-mcp-tests', version: '0.0.0' },
    });
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    return {
        request,
        listTools: () => request('tools/list'),
        callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
        readResource: (uri) => request('resources/read', { uri }),
        getPrompt: (name) => request('prompts/get', { name }),
        notifications,
        start,
        notify: (method, params) => clientSide.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
        close: async () => {
            await clientSide.close();
            await server.close();
        },
    };
}
