import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { callToolDirect, createServer, ensureEngineReady, toolNames, __serverMetadata, __serverInstructions, __prompts, SERVER_CACHE_HINTS } from '../src/server.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from '../src/version.js';
import { connectLegacy, McpRpcError } from './_mcp-harness.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip, OVERLAP, richZip, truncated } from './_zip-fixtures.js';

/** One-shot JSON-RPC request through the in-memory transport (legacy era). */
async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = await connectLegacy();
    try {
        return await client.request<T>(method, params);
    } finally {
        await client.close();
    }
}

const OUTPUT_ENV = 'ZIPNATIVE_MCP_OUTPUT_DIR';

const ALL_TOOLS = [
    'compute_crc32',
    'create_zip',
    'describe_engine',
    'draft_governance_issue',
    'extract_zip',
    'inflate_raw',
    'inspect_zip',
    'list_zip_entries',
    'modify_zip',
    'read_zip_entry',
    'sanitize_entry_paths',
    'scan_zip_forward',
    'verify_zip',
];

/** Tools whose default mode never touches the filesystem AND whose file mode does not exist. */
const READ_ONLY_TOOLS = ['inspect_zip', 'list_zip_entries', 'read_zip_entry', 'verify_zip', 'scan_zip_forward', 'sanitize_entry_paths', 'compute_crc32', 'describe_engine'];

const ALL_PROMPTS = ['draft_issue_workflow', 'forensic_scan', 'governance_contract', 'incremental_update', 'reproducible_archive', 'secure_extraction', 'verify_before_trust'];

describe('server', () => {
    beforeAll(async () => {
        delete process.env[OUTPUT_ENV];
        await ensureEngineReady();
    });

    it('exposes stable metadata', () => {
        expect(__serverMetadata.name).toBe('zipnative-mcp');
        expect(__serverMetadata.version).toBe(ZIPNATIVE_MCP_VERSION);
        expect(__serverMetadata.engineVersion).toBe(ZIPNATIVE_VERSION);
    });

    it('advertises a human-readable title and description in serverInfo (MCP Implementation)', () => {
        // 2025-11-25 added Implementation.description to mirror server.json; hosts and
        // the MCP registry surface it during initialization.
        expect(typeof __serverMetadata.title).toBe('string');
        expect(__serverMetadata.title.length).toBeGreaterThan(0);
        expect(__serverMetadata.description).toMatch(/MCP server/i);
        expect(__serverMetadata.description).toMatch(/13 tools/);
        expect(__serverMetadata.description).toMatch(/no network ever/);
    });

    it('SERVER_INSTRUCTIONS advertises the decision tree, security posture and pitfalls for AI clients', () => {
        expect(__serverInstructions).toContain(`zipnative-mcp: 13 tools over the zipnative v${ZIPNATIVE_VERSION}`);
        expect(__serverInstructions).toContain(`Tool API ${TOOL_API_VERSION}`);
        expect(__serverInstructions).toContain('MCP 2026-07-28');
        expect(__serverInstructions).toContain('DECISION TREE');
        expect(__serverInstructions).toContain('SECURITY POSTURE');
        expect(__serverInstructions).toContain('COMMON PITFALLS');
        expect(__serverInstructions).toContain('No network, ever');
        // Cite each tool and each prompt by name.
        expect(toolNames().sort()).toEqual(ALL_TOOLS);
        for (const t of toolNames()) expect(__serverInstructions, t).toContain(t);
        for (const p of __prompts) expect(__serverInstructions, p.name).toContain(p.name);
        expect(__serverInstructions).toContain('ZIPNATIVE_MCP_OUTPUT_DIR');
        expect(__serverInstructions).toContain('zipnative://output/');
    });

    it('exposes MCP prompts for the AI-governance contract, the issue workflow and five recipes', async () => {
        const promptList = (await rpc('prompts/list')) as {
            prompts: Array<{ name: string; title?: string; description?: string }>;
        };
        const promptNames = promptList.prompts.map((p) => p.name).sort();
        expect(promptNames).toEqual(ALL_PROMPTS);
        for (const p of promptList.prompts) {
            expect(typeof p.title, p.name).toBe('string');
            expect((p.description ?? '').length, p.name).toBeGreaterThan(20);
        }
        // Recipe prompts are self-contained text: every one names the tool it drives.
        for (const [name, tool] of [
            ['secure_extraction', 'extract_zip'],
            ['reproducible_archive', 'create_zip'],
            ['incremental_update', 'modify_zip'],
            ['forensic_scan', 'scan_zip_forward'],
            ['verify_before_trust', 'verify_zip'],
            ['draft_issue_workflow', 'draft_governance_issue'],
        ] as const) {
            const recipe = (await rpc('prompts/get', { name })) as { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> };
            expect(recipe.messages[0]?.role).toBe('user');
            expect(recipe.messages[0]?.content.type).toBe('text');
            expect(recipe.messages[0]?.content.text, name).toContain(tool);
        }
        const got = (await rpc('prompts/get', { name: 'governance_contract' })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };
        expect(got.messages[0]?.role).toBe('user');
        expect(got.messages[0]?.content.text).toMatch(/DRAFTSMAN/);

        // Unknown prompt names are rejected on the wire (-32602 with a coded prefix).
        const err = await rpc('prompts/get', { name: 'nope' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpRpcError);
        expect((err as McpRpcError).code).toBe(-32602);
        expect((err as McpRpcError).message).toContain('[UNKNOWN_PROMPT]');
    });

    it('lists all 13 tools with apiVersion, 1–2 examples and annotations each', async () => {
        const response = (await rpc('tools/list')) as {
            tools: Array<{ name: string; title?: string; description: string; _meta?: { apiVersion?: string; examples?: Array<{ title: string; input: unknown }> }; annotations?: Record<string, boolean> }>;
        };

        const names = response.tools.map((t) => t.name).sort();
        expect(names).toEqual(ALL_TOOLS);
        // Registration order is stable and starts with the read tools.
        expect(response.tools.map((t) => t.name)).toEqual(toolNames());

        for (const t of response.tools) {
            expect(t._meta?.apiVersion, t.name).toBe(TOOL_API_VERSION);
            expect(t._meta?.apiVersion).toBe('1.0.0');
            expect(Array.isArray(t._meta?.examples), t.name).toBe(true);
            expect((t._meta?.examples ?? []).length, t.name).toBeGreaterThan(0);
            expect((t._meta?.examples ?? []).length, `${t.name}: at most 2 examples (token budget)`).toBeLessThanOrEqual(2);
            for (const ex of t._meta?.examples ?? []) {
                expect(typeof ex.title).toBe('string');
                expect(ex.input !== null && typeof ex.input === 'object').toBe(true);
            }
            expect(typeof t.title, t.name).toBe('string');
            expect(t.description.length, t.name).toBeGreaterThan(80);
        }
    });

    it("A-020: every tool description names a sibling tool or carries an explicit 'prefer' / 'use it' / 'when' cue", async () => {
        const response = (await rpc('tools/list')) as { tools: Array<{ name: string; description: string }> };
        const names = response.tools.map((t) => t.name);
        const offenders: string[] = [];
        for (const t of response.tools) {
            const siblings = names.filter((n) => n !== t.name && t.description.includes(n));
            const cue = /prefer|use it|when/i.test(t.description);
            if (siblings.length === 0 && !cue) offenders.push(t.name);
        }
        expect(offenders).toEqual([]);
        // The five descriptions the audit flagged carry the routing clause the fix added.
        const byName = new Map(response.tools.map((t) => [t.name, t.description]));
        expect(byName.get('extract_zip')).toContain('read_zip_entry');
        expect(byName.get('modify_zip')).toContain('create_zip');
        expect(byName.get('inflate_raw')).toContain('read_zip_entry');
        expect(byName.get('describe_engine')).toMatch(/Call it first|whenever/);
        expect(byName.get('draft_governance_issue')).toContain('describe_engine');
    });

    it('annotations: readOnlyHint exactly for the read tools, openWorldHint false everywhere, never destructive', async () => {
        const response = (await rpc('tools/list')) as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
        const readOnly = response.tools.filter((t) => t.annotations?.['readOnlyHint'] === true).map((t) => t.name).sort();
        expect(readOnly).toEqual([...READ_ONLY_TOOLS].sort());
        for (const t of response.tools) {
            expect(t.annotations, `${t.name} has annotations`).toBeDefined();
            expect(t.annotations!['openWorldHint'], t.name).toBe(false);
            expect(t.annotations!['destructiveHint'], t.name).toBe(false);
            expect(t.annotations!['idempotentHint'], t.name).toBe(true);
            expect(typeof t.annotations!['readOnlyHint'], t.name).toBe('boolean');
        }
    });

    it('tool input schemas are JSON Schema 2020-12 compatible (dialect-agnostic)', async () => {
        // 2025-11-25 (SEP-1613) establishes JSON Schema 2020-12 as the default dialect
        // when `$schema` is omitted. Our hand-written schemas stay dialect-agnostic by
        // avoiding constructs whose meaning changed across drafts ($ref/$defs/definitions,
        // draft-04 boolean exclusiveMinimum/Maximum, draft-07 dependencies). This guard
        // fails if any tool reintroduces a dialect-sensitive keyword.
        const response = (await rpc('tools/list')) as {
            tools: Array<{ name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>;
        };

        const FORBIDDEN = new Set(['$ref', '$defs', 'definitions', 'dependencies']);
        const scan = (node: unknown, toolName: string, at: string): void => {
            if (Array.isArray(node)) {
                node.forEach((v, i) => scan(v, toolName, `${at}[${i}]`));
                return;
            }
            if (node === null || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                expect(FORBIDDEN.has(key), `${toolName}${at}.${key} is dialect-sensitive`).toBe(false);
                // Draft-04 allowed boolean exclusiveMinimum/Maximum; 2020-12 requires a number.
                if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean') {
                    throw new Error(`${toolName}${at}.${key} uses the draft-04 boolean form`);
                }
                scan(value, toolName, `${at}.${key}`);
            }
        };

        for (const t of response.tools) {
            expect(t.inputSchema['type']).toBe('object');
            expect(t.inputSchema['additionalProperties']).toBe(false);
            scan(t.inputSchema, t.name, '.inputSchema');
            if (t.outputSchema !== undefined) scan(t.outputSchema, t.name, '.outputSchema');
        }
    });

    it('rejects unknown tools with JSON-RPC -32602 on the wire (callToolDirect keeps the isError form for in-process callers)', async () => {
        await expect(rpc('tools/call', { name: 'nope', arguments: {} })).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('[UNKNOWN_TOOL] Unknown tool: nope') });
        const direct = await callToolDirect('nope', {});
        expect(direct.isError).toBe(true);
        expect((direct.content[0] as { text: string }).text).toBe('Unknown tool: nope');
    });

    it('round-trips create_zip → verify_zip through the wire; the archive arrives once, as an embedded resource', async () => {
        const client = await connectLegacy();
        try {
            const created = (await client.callTool('create_zip', {
                entries: [{ name: 'README.md', text: '# Smoke\n' }, { name: 'src/index.js', text: 'export {};\n' }, { name: 'assets/', directory: true }],
                // summary.deterministic is the cross-runtime guarantee: it needs the pinned pure-TS encoder.
                compression: { deterministic: true },
                includeSha256: true,
            })) as {
                isError?: boolean;
                content: Array<{ type: string; text?: string; resource?: { uri?: string; blob?: string; mimeType?: string } }>;
                structuredContent?: { mode?: string; base64?: string; sizeBytes?: number; summary?: Record<string, unknown>; diagnostics?: unknown[] };
            };
            expect(created.isError).not.toBe(true);
            expect(created.content[0]?.text ?? '').toContain('produced');
            expect(created.structuredContent?.mode).toBe('base64');
            expect(typeof created.structuredContent?.sizeBytes).toBe('number');
            expect(created.structuredContent?.diagnostics).toEqual([]);
            expect(created.structuredContent?.summary).toMatchObject({ entryCount: 3, fileCount: 2, directoryCount: 1, streamedCount: 0, deterministic: true, order: 'canonical', parallel: { requested: false, workers: 0 } });
            expect(created.structuredContent?.summary?.['deflateTier']).toEqual(expect.any(String));
            expect(created.structuredContent?.summary?.['sha256']).toMatch(/^[0-9a-f]{64}$/);
            // Without the pin the bytes are stable per environment only: summary.deterministic is false.
            const unpinned = (await client.callTool('create_zip', { entries: [{ name: 'a.txt', text: 'a' }] })) as { structuredContent?: { summary?: Record<string, unknown> } };
            expect(unpinned.structuredContent?.summary?.['deterministic']).toBe(false);
            // Token-frugal: base64 is NOT duplicated into structuredContent; it is
            // delivered once as an embedded resource content block.
            expect(created.structuredContent?.base64).toBeUndefined();
            const resourceBlock = created.content.find((c) => c.type === 'resource');
            expect(resourceBlock?.resource?.mimeType).toBe('application/zip');
            expect(resourceBlock?.resource?.uri).toMatch(/^data:application\/zip;base64,/);
            const blob = resourceBlock?.resource?.blob ?? '';
            expect(blob.length).toBeGreaterThan(0);
            expect(blob.length).toBeLessThanOrEqual(Math.ceil((created.structuredContent!.sizeBytes! + 2) / 3) * 4);
            assertValidZip(blob, 'create_zip round trip');

            const verified = (await client.callTool('verify_zip', { zipBase64: blob })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: { ok: boolean; error: unknown; entryCount: number; verifiedCount: number } };
            expect(verified.isError).not.toBe(true);
            expect(verified.content[0]?.text).toContain('OK');
            expect(verified.structuredContent).toMatchObject({ ok: true, error: null, entryCount: 3, verifiedCount: 3, failedCount: 0, skippedCount: 0 });
        } finally {
            await client.close();
        }
    });

    it('returns success payload for a file-mode tool call with a resource_link', async () => {
        const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-server-file-'));
        process.env[OUTPUT_ENV] = sandboxDir;
        try {
            const response = (await rpc('tools/call', {
                name: 'create_zip',
                arguments: { entries: [{ name: 'a.txt', text: 'saved' }], outputMode: 'file', outputPath: 'from-server/file.zip' },
            })) as {
                isError?: boolean;
                content: Array<{ type: string; text?: string; uri?: string; name?: string }>;
                structuredContent?: { mode?: string; filePath?: string };
            };
            expect(response.isError).not.toBe(true);
            expect(response.content[0]?.text ?? '').toContain('wrote');
            expect(response.structuredContent?.mode).toBe('file');
            expect(response.structuredContent?.filePath).toBe(path.join(sandboxDir, 'from-server', 'file.zip'));
            const link = response.content.find((c) => c.type === 'resource_link');
            expect(link).toMatchObject({ uri: 'zipnative://output/from-server/file.zip', name: 'from-server/file.zip' });
            assertValidZip(await fs.readFile(response.structuredContent!.filePath!), 'file mode');
        } finally {
            delete process.env[OUTPUT_ENV];
            await fs.rm(sandboxDir, { recursive: true, force: true });
        }
    });

    it('surfaces tool validation failures as isError responses with the coded envelope', async () => {
        const response = (await rpc('tools/call', { name: 'create_zip', arguments: { entries: 'nope' } })) as { isError?: boolean; content: Array<{ text: string }>; _meta?: { error?: { code: string; message: string } } };
        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toMatch(/^create_zip failed \[VALIDATION_ERROR\]: /);
        expect(response._meta?.error?.code).toBe('VALIDATION_ERROR');
        // Both inputs missing / both present are validation errors too.
        const none = await callToolDirect('inspect_zip', {});
        expect((none._meta as { error: { code: string; message: string } }).error.message).toContain('exactly one of zipBase64 / zipPath');
        const both = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), zipPath: 'a.zip' });
        expect((both._meta as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('carries a ZIP_* refusal in the error envelope (_meta.error.code / data) — overlapping entries are a security refusal', async () => {
        const direct = await callToolDirect('inspect_zip', { zipBase64: b64(OVERLAP()) });
        expect(direct.isError).toBe(true);
        expect((direct.content[0] as { text: string }).text).toMatch(/^inspect_zip failed \[ZIP_ENTRY_OVERLAP\]: Failed to open archive: /);
        const error = (direct._meta as { error: { code: string; message: string; data: Record<string, unknown> } }).error;
        expect(error.code).toBe('ZIP_ENTRY_OVERLAP');
        expect(error.data['errorClass']).toBe('security');
        expect(error.data['engineError']).toBe('ZipSecurityError');
        // The same envelope crosses the wire unchanged.
        const wire = (await rpc('tools/call', { name: 'inspect_zip', arguments: { zipBase64: b64(OVERLAP()) } })) as { isError?: boolean; _meta?: { error?: { code: string; data?: Record<string, unknown> } } };
        expect(wire.isError).toBe(true);
        expect(wire._meta?.error?.code).toBe('ZIP_ENTRY_OVERLAP');
        expect(wire._meta?.error?.data?.['errorClass']).toBe('security');
        // A limit refusal carries the engine's machine-readable detail.
        const limit = await callToolDirect('inspect_zip', { zipBase64: b64(basicZip()), limits: { maxEntries: 1 } });
        const detail = (limit._meta as { error: { code: string; data: Record<string, unknown> } }).error;
        expect(detail.code).toBe('ZIP_LIMIT_EXCEEDED');
        expect(detail.data).toMatchObject({ errorClass: 'limit', limit: 'maxEntries', configured: 1, observed: 4 });
    });

    it('verify_zip never fails for an archive problem: a truncated archive is ok:false with error.code, not isError', async () => {
        const r = await callToolDirect('verify_zip', { zipBase64: b64(truncated(basicZip(), 60)) });
        expect(r.isError).not.toBe(true);
        expect((r.content[0] as { text: string }).text).toContain('NOT OK');
        expect(r.structuredContent).toMatchObject({ ok: false, error: { code: 'ZIP_EOCD_NOT_FOUND' }, entryCount: 0 });
    });

    it('advertises the MCP resources capability with list, read and templates handlers', async () => {
        // With no sandbox configured, listing is empty (stateless, safe default).
        delete process.env[OUTPUT_ENV];
        const res = await rpc<{ resources: unknown[] }>('resources/list');
        expect(res.resources).toEqual([]);
        const templates = await rpc<{ resourceTemplates: unknown[] }>('resources/templates/list');
        expect(templates.resourceTemplates).toEqual([]);
        // Spec 2026-07-28: resource-not-found is -32602 (Invalid params) on every revision.
        await expect(rpc('resources/read', { uri: 'zipnative://output/nope.zip' })).rejects.toMatchObject({ code: -32602 });
    });

    it('lists tools in a deterministic order and constructs with valid cache hints', async () => {
        const a = (await rpc<{ tools: Array<{ name: string }> }>('tools/list')).tools.map((t) => t.name);
        const b = (await rpc<{ tools: Array<{ name: string }> }>('tools/list')).tools.map((t) => t.name);
        expect(a).toEqual(b);
        expect(SERVER_CACHE_HINTS['tools/list']).toEqual({ ttlMs: 86_400_000, cacheScope: 'public' });
        expect(SERVER_CACHE_HINTS['prompts/list'].cacheScope).toBe('public');
        expect(SERVER_CACHE_HINTS['server/discover']).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
        for (const key of ['resources/list', 'resources/templates/list', 'resources/read'] as const) {
            expect(SERVER_CACHE_HINTS[key], key).toEqual({ ttlMs: 0, cacheScope: 'private' });
        }
        expect(() => createServer()).not.toThrow();
    });

    it('includes outputSchema for every tool', async () => {
        const response = (await rpc('tools/list')) as {
            tools: Array<{ name: string; outputSchema?: { type?: string; additionalProperties?: boolean } }>
        };
        for (const tool of response.tools) {
            expect(tool.outputSchema, `${tool.name} should have outputSchema`).toBeDefined();
            expect(tool.outputSchema?.type).toBe('object');
            expect(tool.outputSchema?.additionalProperties).toBe(false);
        }
    });
});

describe('token-frugal projection (verbosity / fields)', () => {
    beforeAll(async () => {
        delete process.env[OUTPUT_ENV];
        await ensureEngineReady();
    });

    type CallResponse = { isError?: boolean; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };

    async function call(name: string, args: Record<string, unknown>): Promise<CallResponse> {
        const r = (await rpc('tools/call', { name, arguments: args })) as CallResponse;
        expect(r.isError, `${name}: ${JSON.stringify(r)}`.slice(0, 300)).not.toBe(true);
        return r;
    }

    // richZip pins one entry to 2024 (not the DOS epoch) — reproducible per call, but not "deterministic"
    // in the engine's sense; basicZip is epoch-dated, canonical and UTF-8 flagged.
    const zipBase64 = b64(richZip());
    const plain = b64(basicZip());

    it('inspect_zip full output (default) is unchanged and includes the heavy arrays', async () => {
        const res = await call('inspect_zip', { zipBase64 });
        const sc = res.structuredContent!;
        expect(Array.isArray(sc['methods'])).toBe(true);
        expect(sc['determinism']).toEqual({ epochTimestamps: false, canonicalOrder: true, utf8Flags: true, noDataDescriptors: true, canonicalLayout: true, deterministic: false });
        expect(sc['comment']).toBe('archive comment — ünïcödé');
        expect(sc['deterministic']).toBeUndefined();
        expect(sc['diagnosticCount']).toBeUndefined();
    });

    it("inspect_zip verbosity='summary' collapses to scalars and drops arrays / nested objects", async () => {
        const res = await call('inspect_zip', { zipBase64: plain, verbosity: 'summary' });
        const sc = res.structuredContent!;
        expect(sc['entryCount']).toBe(4);
        expect(sc['deterministic']).toBe(true);
        expect(sc['canonicalLayout']).toBe(true);
        expect(sc['diagnosticCount']).toBe(0);
        expect(sc['methods']).toBeUndefined();
        expect(sc['determinism']).toBeUndefined();
        expect(sc['diagnostics']).toBeUndefined();
        expect(sc['comment']).toBeUndefined();
    });

    it('inspect_zip fields projection returns only the requested paths (dot-paths included)', async () => {
        const res = await call('inspect_zip', { zipBase64: plain, fields: ['entryCount', 'determinism.deterministic'] });
        expect(res.structuredContent).toEqual({ entryCount: 4, determinism: { deterministic: true } });
    });

    it('inspect_zip composes summary then fields, and check results survive the summary', async () => {
        const res = await call('inspect_zip', { zipBase64: plain, check: ['deterministic', 'no-encryption'], verbosity: 'summary', fields: ['checksPassed', 'entryCount'] });
        expect(res.structuredContent).toEqual({ checksPassed: true, entryCount: 4 });
        const checks = await call('inspect_zip', { zipBase64, check: ['deterministic', 'epoch-timestamps', 'canonical-order'], fields: ['checks.check', 'checks.ok'] });
        expect(checks.structuredContent).toEqual({ checks: [{ check: 'deterministic', ok: false }, { check: 'epoch-timestamps', ok: false }, { check: 'canonical-order', ok: true }] });
    });

    it("verify_zip verbosity='summary' returns a compact verdict without entries[]", async () => {
        const full = await call('verify_zip', { zipBase64 });
        expect(Array.isArray(full.structuredContent!['entries'])).toBe(true);
        const res = await call('verify_zip', { zipBase64, verbosity: 'summary' });
        const sc = res.structuredContent!;
        expect(sc['ok']).toBe(full.structuredContent!['ok']);
        expect(sc['ok']).toBe(true);
        expect(sc['error']).toBeNull();
        expect(sc['verifiedCount']).toBe(5);
        expect(sc['diagnosticCount']).toBe(0);
        expect(sc['entries']).toBeUndefined();
    });

    it("list_zip_entries verbosity='summary' keeps the names only", async () => {
        const res = await call('list_zip_entries', { zipBase64, verbosity: 'summary' });
        const sc = res.structuredContent!;
        expect(sc['names']).toEqual(['README.md', 'assets/', 'bin/run.sh', 'café/résumé.txt', 'empty.txt']);
        expect(sc['entries']).toBeUndefined();
        expect(sc['hasMore']).toBe(false);
        const projected = await call('list_zip_entries', { zipBase64, fields: ['entries.name', 'entries.uncompressedSize', 'matchedCount'] });
        expect(projected.structuredContent).toEqual({
            matchedCount: 5,
            entries: [
                { name: 'README.md', uncompressedSize: 8 },
                { name: 'assets/', uncompressedSize: 0 },
                { name: 'bin/run.sh', uncompressedSize: 18 },
                { name: 'café/résumé.txt', uncompressedSize: 13 },
                { name: 'empty.txt', uncompressedSize: 0 },
            ],
        });
    });

    it("extract_zip verbosity='summary' replaces rows by paths; read_zip_entry summary keeps the scalar facts", async () => {
        const ex = await call('extract_zip', { zipBase64, includeData: false, verbosity: 'summary' });
        expect(ex.structuredContent).toEqual({ mode: 'base64', dryRun: true, fileCount: 4, totalBytes: 39, skippedCount: 0, paths: ['README.md', 'bin/run.sh', 'café/résumé.txt', 'empty.txt'], diagnosticCount: 0 });
        const rd = await call('read_zip_entry', { zipBase64, name: 'README.md', encoding: 'utf8', verbosity: 'summary' });
        expect(rd.structuredContent).toEqual({ name: 'README.md', index: 0, mode: 'data', sizeBytes: 8, crcVerified: true, textLength: 8, diagnosticCount: 0 });
    });

    it("scan_zip_forward / sanitize_entry_paths / describe_engine verbosity='summary' shapes", async () => {
        const scan = await call('scan_zip_forward', { zipBase64, verbosity: 'summary' });
        expect(scan.structuredContent).toEqual({ trust: 'local-headers-only', entryCount: 5, keptCount: 5, stoppedAt: 'central-directory', truncated: false, names: ['README.md', 'assets/', 'bin/run.sh', 'café/résumé.txt', 'empty.txt'], diagnosticCount: 0 });
        const san = await call('sanitize_entry_paths', { names: ['ok/a.txt', '../evil', 'C:\\x'], verbosity: 'summary' });
        expect(san.structuredContent).toEqual({ count: 3, rejectedCount: 2, rejectedNames: ['../evil', 'C:\\x'] });
        const eng = await call('describe_engine', { verbosity: 'summary' });
        expect(Object.keys(eng.structuredContent!).sort()).toEqual(['capabilities', 'engine', 'network', 'sandbox', 'server']);
        const fields = await call('describe_engine', { fields: ['server.toolCount', 'network', 'ceilings.env'] });
        expect(fields.structuredContent).toEqual({ server: { toolCount: 13 }, network: 'none', ceilings: { env: ['ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES', 'ZIPNATIVE_MCP_MAX_ENTRIES', 'ZIPNATIVE_MCP_WORKERS'] } });
    });

    it('unmatched fields are reported in _meta.unmatchedFields over the wire', async () => {
        const res = await call('inspect_zip', { zipBase64, fields: ['entrycount'] });
        expect(res.structuredContent).toEqual({});
        expect(res._meta).toMatchObject({ unmatchedFields: ['entrycount'] });
        expect((res._meta as { availableFields: string[] }).availableFields).toContain('entryCount');
    });
});
