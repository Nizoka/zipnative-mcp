/**
 * Autonomous-agent proof (plan Appendix C, scenario C17, steps S0–S17): a
 * scripted client with no human in the loop drives the server end to end on
 * every transport × era pair —
 *   T1 stdio legacy (2025-11-25 `initialize`)   T2 stdio modern (2026-07-28 envelope)
 *   T3 HTTP legacy (stateless fallback)         T4 HTTP modern + bearer token
 * — with the operator environment the plan prescribes (sandbox, cache dir,
 * ZIPNATIVE_MCP_MAX_ENTRIES=5000, ZIPNATIVE_MCP_WORKERS=2).
 *
 * Invariants asserted over the whole run: no interactive step, no unexpected
 * `isError`, every error carries `_meta.error.code` and a remedy in its message,
 * a cache hit is visible on the wire (`_meta.cached`), stdout carries nothing
 * but JSON-RPC frames (stdio), every produced archive is ISO/IEC 21320-1
 * conformant, and the session shuts down cleanly.
 *
 * The stdio transports need `npm run build` (dist/cli.js); locally they are
 * skipped when dist/ is absent, under CI a missing dist/ fails (tests/cli-stdio.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toolNames } from '../src/server.js';
import {
    AGENT_TRANSPORTS,
    expectCleanStdioExit,
    hasDist,
    isModernTransport,
    isStdioTransport,
    McpRpcError,
    openAgent,
    SERVER_INFO_KEY,
    type AgentCallToolResult,
    type AgentClient,
    type AgentCloseReport,
} from './_agent-client.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip, OVERLAP, truncated, ZIP_SLIP } from './_zip-fixtures.js';

const TOKEN = 'autonomy-scenario-token-0123456789';

/** The archive the scenario builds: a comment on README.md makes every one of the 22 ZipEntry fields observable. */
const README = '# Report\n\n' + 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12) + '\n';
const ENTRIES = [
    { name: 'README.md', text: README, comment: 'entry comment' },
    { name: 'src/index.js', text: 'export const answer = 42;\n' },
    { name: 'docs/guide.md', text: '# Guide\n' + 'the guide says the same thing many times over '.repeat(60) + '\n' },
    { name: 'assets', directory: true },
];

/** EntryView keys that map the engine's 22 `ZipEntry` fields (rawName → rawNameHex, compressionMethod → method). */
const MAPPED_ENTRY_FIELDS = [
    'name', 'rawNameHex', 'nameEncoding', 'comment', 'method', 'compressedSize', 'uncompressedSize', 'crc32',
    'lastModified', 'dosDate', 'dosTime', 'flags', 'versionMadeBy', 'versionNeeded', 'internalAttributes',
    'externalAttributes', 'localHeaderOffset', 'extraFields', 'isDirectory', 'isEncrypted', 'usesDataDescriptor', 'usesZip64',
] as const;

/**
 * The remedy every error message must name (plan C-grid: "each error message
 * names the remedy"), keyed by the codes this scenario provokes on purpose.
 */
const REMEDY_BY_CODE: Readonly<Record<string, RegExp>> = {
    LIMIT_CEILING_EXCEEDED: /ZIPNATIVE_MCP_(MAX_ENTRIES|WORKERS)/,
    ZIP_PATH_TRAVERSAL: /rejectTraversal: false/,
    ZIP_ENTRY_OVERLAP: /rejected/,
    ZIP_ENTRY_NOT_FOUND: /list_zip_entries/,
    GOVERNANCE_VIOLATION: /must be true/,
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sc = (r: AgentCallToolResult): Record<string, unknown> => r.structuredContent as Record<string, unknown>;
const text0 = (r: AgentCallToolResult): string => (r.content[0] as { text?: string })?.text ?? '';
const errorMeta = (r: AgentCallToolResult): { code: string; message: string; data?: Record<string, unknown> } =>
    (r._meta as { error: { code: string; message: string; data?: Record<string, unknown> } }).error;
/** The embedded-resource blob of an archive-producing result (base64 mode). */
function blobOf(r: AgentCallToolResult): string {
    const block = r.content.find((c) => c.type === 'resource') as { resource?: { blob?: string; mimeType?: string } } | undefined;
    expect(block?.resource?.blob, 'embedded resource block').toBeDefined();
    return block!.resource!.blob!;
}
function ok(r: AgentCallToolResult): AgentCallToolResult {
    expect(r.isError, text0(r)).not.toBe(true);
    return r;
}

describe.each(AGENT_TRANSPORTS)('C17 autonomous scenario over %s', (transport) => {
    const stdio = isStdioTransport(transport);
    const modern = isModernTransport(transport);

    describe.skipIf(stdio && !hasDist)('S0–S17', () => {
        let sandbox: string;
        let cacheDir: string;
        let agent: AgentClient;
        let report: AgentCloseReport | null = null;
        // Cross-step state.
        let reportZipPath: string;
        let baseSha256: string;
        let readmeEntry: Record<string, unknown>;
        let extractedFileCount = 0;

        beforeAll(async () => {
            sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `zipnative-autonomy-${transport}-`));
            cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), `zipnative-autonomy-cache-${transport}-`));
            agent = await openAgent(transport, {
                env: {
                    ZIPNATIVE_MCP_OUTPUT_DIR: sandbox,
                    ZIPNATIVE_MCP_CACHE_DIR: cacheDir,
                    ZIPNATIVE_MCP_MAX_ENTRIES: '5000',
                    ZIPNATIVE_MCP_WORKERS: '2',
                },
                ...(transport === 'http-modern' ? { token: TOKEN } : {}),
            });
        }, 30_000);

        afterAll(async () => {
            if (report === null) report = await agent.close();
            await fs.rm(sandbox, { recursive: true, force: true });
            await fs.rm(cacheDir, { recursive: true, force: true });
        });

        it('S0 handshake: server identity and instructions arrive on the opening exchange', () => {
            const h = agent.handshake;
            expect(String(h['instructions'])).toContain('DECISION TREE');
            if (modern) {
                expect(h['resultType']).toBe('complete');
                expect(h['supportedVersions']).toContain('2026-07-28');
                expect(((h['_meta'] as Record<string, unknown>)[SERVER_INFO_KEY] as { name: string }).name).toBe('zipnative-mcp');
            } else {
                expect(h['protocolVersion']).toBe('2025-11-25');
                expect((h['serverInfo'] as { name: string }).name).toBe('zipnative-mcp');
            }
        });

        it('S1 tools/list: the 15-tool catalogue in registration order (public 24 h cache hint on the modern era)', async () => {
            const list = await agent.request<{ tools: Array<{ name: string; inputSchema: unknown; outputSchema?: unknown }>; ttlMs?: number; cacheScope?: string; resultType?: string }>('tools/list');
            expect(list.tools.map((t) => t.name)).toEqual(toolNames());
            expect(list.tools).toHaveLength(15);
            for (const t of list.tools) expect(t.inputSchema).toBeDefined();
            if (modern) {
                expect(list.resultType).toBe('complete');
                expect(list.ttlMs).toBe(86_400_000);
                expect(list.cacheScope).toBe('public');
            } else {
                expect(list.ttlMs).toBeUndefined();
            }
        });

        it('S2 describe_engine: sandbox, cache and the operator ceilings are visible to the agent', async () => {
            const r = ok(await agent.callTool('describe_engine', {}));
            const d = sc(r);
            expect(d['sandbox']).toEqual({ enabled: true, cacheEnabled: true });
            expect(d['ceilings']).toMatchObject({ maxEntries: 5000, maxWorkers: 2, env: ['ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES', 'ZIPNATIVE_MCP_MAX_ENTRIES', 'ZIPNATIVE_MCP_WORKERS', 'ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES'] });
            expect(d['network']).toBe('none');
            expect((d['server'] as { toolCount: number }).toolCount).toBe(15);
            expect((d['errorCodes'] as string[]).length).toBe(39);
            expect((d['diagnosticCodes'] as string[]).length).toBe(12);
            expect((r._meta as Record<string, unknown> | undefined)?.['cached']).toBeUndefined();
        });

        it('S3 create_zip (file mode, deterministic tier): resource_link, pure-pinned tier, conformant bytes', async () => {
            const r = ok(await agent.callTool('create_zip', { entries: ENTRIES, compression: { deterministic: true }, includeSha256: true, outputMode: 'file', outputPath: 'work/report.zip' }));
            const s = sc(r);
            expect(s['mode']).toBe('file');
            const link = r.content.find((c) => c.type === 'resource_link') as { uri: string; mimeType: string } | undefined;
            expect(link?.uri).toBe('zipnative://output/work/report.zip');
            expect(link?.mimeType).toBe('application/zip');
            expect(s['summary']).toMatchObject({ entryCount: 4, fileCount: 3, directoryCount: 1, deterministic: true, deflateTier: 'pure-pinned', order: 'canonical' });
            reportZipPath = s['filePath'] as string;
            expect(reportZipPath.startsWith(sandbox)).toBe(true);
            const bytes = await fs.readFile(reportZipPath);
            expect(bytes.byteLength).toBe(s['sizeBytes']);
            assertValidZip(new Uint8Array(bytes), 'S3 report.zip');
            baseSha256 = sha256(bytes);
        });

        it('S3b create_zip (base64) twice: identical sha256 to the file, second call served from the cache (_meta.cached through the wire)', async () => {
            const args = { entries: ENTRIES, compression: { deterministic: true }, includeSha256: true };
            const first = ok(await agent.callTool('create_zip', args));
            expect((first._meta as Record<string, unknown> | undefined)?.['cached']).toBeUndefined();
            const firstBytes = Buffer.from(blobOf(first), 'base64');
            assertValidZip(new Uint8Array(firstBytes), 'S3b base64');
            expect((sc(first)['summary'] as { sha256: string }).sha256).toBe(baseSha256);
            expect(sha256(firstBytes)).toBe(baseSha256);

            const second = ok(await agent.callTool('create_zip', args));
            expect((second._meta as Record<string, unknown>)['cached']).toBe(true);
            expect(blobOf(second)).toBe(blobOf(first));
            expect(second.structuredContent).toEqual(first.structuredContent);
        });

        it('S3c create_zip (parallel): byte-identical to the sequential writer and never cached', async () => {
            const args = { entries: ENTRIES, compression: { deterministic: true }, includeSha256: true, parallel: { workers: 2, minWorkerJobSize: 1 } };
            const a = ok(await agent.callTool('create_zip', args));
            expect((sc(a)['summary'] as { sha256: string; parallel: unknown }).sha256).toBe(baseSha256);
            expect((sc(a)['summary'] as { parallel: unknown }).parallel).toEqual({ requested: true, workers: 2 });
            expect((a._meta as Record<string, unknown> | undefined)?.['cached']).toBeUndefined();
            assertValidZip(blobOf(a), 'S3c parallel');
            const b = ok(await agent.callTool('create_zip', args));
            expect((b._meta as Record<string, unknown> | undefined)?.['cached']).toBeUndefined();
            expect(blobOf(b)).toBe(blobOf(a));
        });

        it('S4 verify_zip by zipPath: the smallest probe returns exactly {ok, error, failedCount}', async () => {
            const r = ok(await agent.callTool('verify_zip', { zipPath: 'work/report.zip', verbosity: 'summary', fields: ['ok', 'error', 'failedCount'] }));
            expect(r.structuredContent).toEqual({ ok: true, error: null, failedCount: 0 });
            expect(r._meta === undefined || (r._meta as Record<string, unknown>)['unmatchedFields'] === undefined).toBe(true);
        });

        it('S5 inspect_zip as a CI gate: six checks + assertions pass', async () => {
            const check = ['deterministic', 'canonical-layout', 'no-encryption', 'no-symlinks', 'safe-names', 'no-duplicates'];
            const r = ok(await agent.callTool('inspect_zip', { zipPath: 'work/report.zip', check, assert: { maxEntries: 10, has: ['README.md', 'docs/guide.md'] } }));
            const s = sc(r);
            expect(s['checksPassed']).toBe(true);
            const checks = s['checks'] as Array<{ check: string; ok: boolean }>;
            expect(checks.map((c) => c.check)).toEqual([...check, 'max-entries=10', 'has=README.md', 'has=docs/guide.md']);
            expect(checks.every((c) => c.ok)).toBe(true);
            expect(s['entryCount']).toBe(4);
            expect(s['determinism']).toMatchObject({ deterministic: true, canonicalLayout: true });
            expect(text0(r)).toContain('checksPassed=true');
        });

        it('S6 list_zip_entries: pagination and the 22 mapped entry fields', async () => {
            const page1 = sc(ok(await agent.callTool('list_zip_entries', { zipPath: 'work/report.zip', limit: 2 })));
            expect(page1).toMatchObject({ entryCount: 4, matchedCount: 4, offset: 0, limit: 2, returnedCount: 2, hasMore: true });
            const page2 = sc(ok(await agent.callTool('list_zip_entries', { zipPath: 'work/report.zip', limit: 2, offset: 2 })));
            expect(page2).toMatchObject({ returnedCount: 2, hasMore: false });
            const names = [...(page1['entries'] as Array<{ name: string }>), ...(page2['entries'] as Array<{ name: string }>)].map((e) => e.name);
            expect(names).toEqual(['README.md', 'assets/', 'docs/guide.md', 'src/index.js']);
            readmeEntry = (page1['entries'] as Array<Record<string, unknown>>)[0]!;
            for (const key of MAPPED_ENTRY_FIELDS) expect(readmeEntry, `entry field ${key}`).toHaveProperty(key);
            expect(readmeEntry['comment']).toBe('entry comment');
            expect(readmeEntry['sanitizedPath']).toBe('README.md');
            const summary = sc(ok(await agent.callTool('list_zip_entries', { zipPath: 'work/report.zip', verbosity: 'summary' })));
            expect(summary['names']).toEqual(names);
        });

        it('S7 read_zip_entry: utf8 text, a byte range, then raw → inflate_raw → compute_crc32 closes the loop', async () => {
            const asText = sc(ok(await agent.callTool('read_zip_entry', { zipPath: 'work/report.zip', name: 'README.md', encoding: 'utf8' })));
            expect(asText['text']).toBe(README);
            expect(asText).toMatchObject({ mode: 'data', crcVerified: true, sizeBytes: Buffer.byteLength(README) });

            const window = sc(ok(await agent.callTool('read_zip_entry', { zipPath: 'work/report.zip', index: 0, encoding: 'utf8', range: { offset: 2, length: 6 } })));
            expect(window['text']).toBe(README.slice(2, 8));
            expect(window['range']).toEqual({ offset: 2, length: 6, returned: 6 });
            expect(window['crcVerified']).toBe(false);

            const raw = sc(ok(await agent.callTool('read_zip_entry', { zipPath: 'work/report.zip', name: 'README.md', mode: 'raw' })));
            expect(raw['mode']).toBe('raw');
            const method = (raw['entry'] as { methodName: string }).methodName;
            const inflated = ok(await agent.callTool('inflate_raw', { dataBase64: raw['dataBase64'], maxOutput: 65_536, method }));
            const inflatedBlob = blobOf(inflated);
            expect(Buffer.from(inflatedBlob, 'base64').toString('utf8')).toBe(README);
            expect(sc(inflated)['summary']).toMatchObject({ finished: true, leftover: 0, bytesOut: Buffer.byteLength(README) });

            const crc = sc(ok(await agent.callTool('compute_crc32', { dataBase64: inflatedBlob, expect: readmeEntry['crc32'] })));
            expect(crc['matches']).toBe(true);
            expect(crc['hex']).toBe(readmeEntry['crc32']);
        });

        it('S8 modify_zip: append (remanence, multiple EOCD) then compact (canonical layout, removed entry truly gone)', async () => {
            const appended = ok(await agent.callTool('modify_zip', {
                zipPath: 'work/report.zip',
                operations: [{ op: 'add', name: 'CHANGELOG.md', text: '# Changes\n' }, { op: 'remove', name: 'docs/guide.md' }],
                outputMode: 'file',
                outputPath: 'work/report-v2.zip',
            }));
            expect(sc(appended)['summary']).toMatchObject({ saveMode: 'append', operationsApplied: 2, entryCountBefore: 4, entryCountAfter: 4, noOp: false });
            const v2 = await fs.readFile(path.join(sandbox, 'work', 'report-v2.zip'));
            assertValidZip(new Uint8Array(v2), 'S8 append');
            // Append mode keeps the original bytes verbatim as a prefix.
            expect(sha256(v2.subarray(0, (await fs.readFile(reportZipPath)).byteLength))).toBe(baseSha256);
            const v2Report = sc(ok(await agent.callTool('inspect_zip', { zipPath: 'work/report-v2.zip' })));
            expect(v2Report['multipleEocd']).toBe(true);
            expect(v2Report['entryCount']).toBe(4);

            const compacted = ok(await agent.callTool('modify_zip', {
                zipPath: 'work/report-v2.zip',
                operations: [{ op: 'setComment', comment: 'compacted by the agent' }],
                mode: 'compact',
                outputMode: 'file',
                outputPath: 'work/report-v3.zip',
            }));
            expect(sc(compacted)['summary']).toMatchObject({ saveMode: 'compact', entryCountAfter: 4, noOp: false });
            const v3 = await fs.readFile(path.join(sandbox, 'work', 'report-v3.zip'));
            assertValidZip(new Uint8Array(v3), 'S8 compact');
            expect(v3.byteLength).toBeLessThan(v2.byteLength);
            const v3Report = sc(ok(await agent.callTool('inspect_zip', { zipPath: 'work/report-v3.zip' })));
            expect(v3Report).toMatchObject({ multipleEocd: false, comment: 'compacted by the agent', entryCount: 4 });
            expect((v3Report['determinism'] as { canonicalLayout: boolean }).canonicalLayout).toBe(true);

            const gone = await agent.callTool('read_zip_entry', { zipPath: 'work/report-v3.zip', name: 'docs/guide.md' });
            expect(gone.isError).toBe(true);
            expect(errorMeta(gone).code).toBe('ZIP_ENTRY_NOT_FOUND');
            expect(text0(gone)).toMatch(/^read_zip_entry failed \[ZIP_ENTRY_NOT_FOUND\]: /);
            const stillThere = sc(ok(await agent.callTool('read_zip_entry', { zipPath: 'work/report-v3.zip', name: 'CHANGELOG.md', encoding: 'utf8' })));
            expect(stillThere['text']).toBe('# Changes\n');
        });

        it('S9 extract_zip: dry run first, then file mode with one resource_link per file', async () => {
            const plan = sc(ok(await agent.callTool('extract_zip', { zipPath: 'work/report-v3.zip', includeData: false })));
            expect(plan).toMatchObject({ mode: 'base64', dryRun: true, fileCount: 3, skipped: [] });
            const planned = (plan['entries'] as Array<{ path: string; dataBase64?: string }>);
            expect(planned.map((e) => e.path)).toEqual(['CHANGELOG.md', 'README.md', 'src/index.js']);
            expect(planned.every((e) => e.dataBase64 === undefined)).toBe(true);

            const r = ok(await agent.callTool('extract_zip', { zipPath: 'work/report-v3.zip', outputMode: 'file', outputDir: 'unpacked' }));
            const s = sc(r);
            expect(s).toMatchObject({ mode: 'file', dryRun: false, fileCount: 3 });
            extractedFileCount = s['fileCount'] as number;
            const links = r.content.filter((c) => c.type === 'resource_link') as Array<{ uri: string }>;
            expect(links.map((l) => l.uri).sort()).toEqual(['zipnative://output/unpacked/CHANGELOG.md', 'zipnative://output/unpacked/README.md', 'zipnative://output/unpacked/src/index.js']);
            for (const row of s['entries'] as Array<{ filePath: string; sizeBytes: number }>) {
                expect((await fs.stat(row.filePath)).size).toBe(row.sizeBytes);
            }
            expect(await fs.readFile(path.join(sandbox, 'unpacked', 'README.md'), 'utf8')).toBe(README);
        });

        it('S10 resources: list, templates and read expose the sandbox (private, ttl 0 on the modern era)', async () => {
            const list = await agent.request<{ resources: Array<{ uri: string; mimeType: string; size: number }>; ttlMs?: number; cacheScope?: string }>('resources/list');
            const uris = list.resources.map((r) => r.uri);
            expect(uris).toEqual(expect.arrayContaining(['zipnative://output/work/report.zip', 'zipnative://output/work/report-v2.zip', 'zipnative://output/work/report-v3.zip', 'zipnative://output/unpacked/README.md']));
            expect(uris.filter((u) => u.startsWith('zipnative://output/unpacked/'))).toHaveLength(extractedFileCount);
            if (modern) {
                expect(list.ttlMs).toBe(0);
                expect(list.cacheScope).toBe('private');
            }
            const templates = await agent.request<{ resourceTemplates: Array<{ uriTemplate: string }>; cacheScope?: string }>('resources/templates/list');
            expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(['zipnative://output/{+path}']);
            if (modern) expect(templates.cacheScope).toBe('private');
            const read = await agent.request<{ contents: Array<{ uri: string; mimeType: string; blob: string }> }>('resources/read', { uri: 'zipnative://output/unpacked/README.md' });
            expect(read.contents[0]?.mimeType).toBe('text/markdown');
            expect(Buffer.from(read.contents[0]?.blob ?? '', 'base64').toString('utf8')).toBe(README);
            const archive = await agent.request<{ contents: Array<{ blob: string; mimeType: string }> }>('resources/read', { uri: 'zipnative://output/work/report.zip' });
            expect(archive.contents[0]?.mimeType).toBe('application/zip');
            expect(sha256(Buffer.from(archive.contents[0]?.blob ?? '', 'base64'))).toBe(baseSha256);
        });

        it('S11 scan_zip_forward on a truncated stream: tolerant scan returns the partial inventory with the error', async () => {
            // A-003: under ZIPNATIVE_MCP_MAX_ENTRIES=5000 the scanner's default budget (10000) is
            // clamped to the ceiling — the agent passes no maxEntries and the result echoes 5000.
            const cut = b64(truncated(basicZip(), 60));
            const r = ok(await agent.callTool('scan_zip_forward', { zipBase64: cut, tolerateTruncation: true }));
            const s = sc(r);
            expect(s).toMatchObject({ trust: 'local-headers-only', stoppedAt: 'error', truncated: true, entryCount: 1, inputBytes: 60, bytesDelivered: 60, maxEntries: 5000 });
            expect(['ZIP_STREAM_TRUNCATED', 'ZIP_RECORD_TRUNCATED', 'ZIP_SIGNATURE_MISMATCH']).toContain((s['error'] as { code: string }).code);
            expect((s['entries'] as Array<{ name: string }>).map((e) => e.name)).toEqual(['README.md']);
            expect(text0(r)).toContain('TRUNCATED');
        });

        it('S12 hostile archives: zip-slip refused (or skipped on request), overlap refused by inspect and reported by verify', async () => {
            const slip = await agent.callTool('extract_zip', { zipBase64: b64(ZIP_SLIP()) });
            expect(slip.isError).toBe(true);
            expect(errorMeta(slip)).toMatchObject({ code: 'ZIP_PATH_TRAVERSAL', data: { errorClass: 'security', entryName: '../../evil.txt' } });
            expect(text0(slip)).toMatch(/^extract_zip failed \[ZIP_PATH_TRAVERSAL\]: /);

            const skipped = sc(ok(await agent.callTool('extract_zip', { zipBase64: b64(ZIP_SLIP()), rejectTraversal: false, includeData: false })));
            expect(skipped).toMatchObject({ fileCount: 0, entries: [], skipped: [{ entryName: '../../evil.txt', reason: 'unsafe-path' }] });

            const overlap = await agent.callTool('inspect_zip', { zipBase64: b64(OVERLAP()) });
            expect(overlap.isError).toBe(true);
            expect(errorMeta(overlap)).toMatchObject({ code: 'ZIP_ENTRY_OVERLAP', data: { errorClass: 'security' } });

            const verified = ok(await agent.callTool('verify_zip', { zipBase64: b64(OVERLAP()), verbosity: 'summary' }));
            expect(sc(verified)).toMatchObject({ ok: false, error: { code: 'ZIP_ENTRY_OVERLAP' }, verifiedCount: 0 });
            expect(text0(verified)).toContain('structural refusal [ZIP_ENTRY_OVERLAP]');
        });

        it('S13 operator ceilings: a per-call limit above the ceiling is refused and names the environment variable', async () => {
            const entries = await agent.callTool('inspect_zip', { zipBase64: b64(basicZip()), limits: { maxEntries: 6000 } });
            expect(entries.isError).toBe(true);
            expect(errorMeta(entries)).toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED', data: { limit: 'maxEntries', requested: 6000, ceiling: 5000, env: 'ZIPNATIVE_MCP_MAX_ENTRIES' } });
            const within = ok(await agent.callTool('inspect_zip', { zipBase64: b64(basicZip()), limits: { maxEntries: 5000 }, verbosity: 'summary' }));
            expect(sc(within)['entryCount']).toBe(4);

            const workers = await agent.callTool('create_zip', { entries: [{ name: 'a.txt', text: 'a' }], parallel: { workers: 3 } });
            expect(workers.isError).toBe(true);
            expect(errorMeta(workers)).toMatchObject({ code: 'LIMIT_CEILING_EXCEEDED', data: { limit: 'workers', requested: 3, ceiling: 2, env: 'ZIPNATIVE_MCP_WORKERS' } });
        });

        it('S14 protocol errors: unknown tool / resource / prompt are JSON-RPC -32602, never isError', async () => {
            await expect(agent.request('tools/call', { name: 'nope', arguments: {} })).rejects.toSatisfy((e: unknown) => e instanceof McpRpcError && e.code === -32602 && e.message.includes('[UNKNOWN_TOOL] Unknown tool: nope'));
            await expect(agent.request('resources/read', { uri: 'zipnative://output/missing.zip' })).rejects.toSatisfy((e: unknown) => e instanceof McpRpcError && e.code === -32602);
            await expect(agent.request('prompts/get', { name: 'nope' })).rejects.toSatisfy((e: unknown) => e instanceof McpRpcError && e.code === -32602 && e.message.includes('[UNKNOWN_PROMPT]'));
        });

        it('S15 draft_governance_issue: a file-mode draft is written (never submitted); a skipped duplicate search is a GOVERNANCE_VIOLATION', async () => {
            const draft = {
                title: 'read_zip_entry mode raw should accept a range for payloads above the inline cap',
                summary: 'A compressed payload above the 16 MiB inline cap is not retrievable through mode raw at all; only the decompressed content is reachable (mode data with a range, or extract_zip file mode).',
                issueType: 'feature',
                targetRepo: 'zipnative-mcp',
                reproduction: { command: "read_zip_entry { zipBase64, name, mode: 'raw' } on an entry whose compressed size exceeds 16 MiB", result: 'ENTRY_TOO_LARGE (data.remedy: range)' },
                expectedBehavior: 'A range on the raw stream, as mode data offers on the decompressed one.',
                affectedPackages: ['zipnative-mcp'],
            };
            const r = ok(await agent.callTool('draft_governance_issue', { ...draft, duplicateSearchPerformed: true, outputMode: 'file', outputPath: 'drafts/raw-range.md' }));
            expect(text0(r)).toContain('DRAFT ONLY');
            const s = sc(r);
            expect(s['outputMode']).toBe('file');
            expect(await fs.readFile(s['filePath'] as string, 'utf8')).toBe(s['draftMarkdown']);
            expect(s['compliance']).toMatchObject({ zeroDependencyConfirmed: true, duplicateSearchPerformed: true, identityReminderShown: true });
            const listed = await agent.request<{ resources: Array<{ uri: string; mimeType: string }> }>('resources/list');
            expect(listed.resources.find((x) => x.uri === 'zipnative://output/drafts/raw-range.md')?.mimeType).toBe('text/markdown');

            const refused = await agent.callTool('draft_governance_issue', { ...draft, duplicateSearchPerformed: false });
            expect(refused.isError).toBe(true);
            expect(errorMeta(refused).code).toBe('GOVERNANCE_VIOLATION');
        });

        it('S16 prompts: the seven recipes are listed and secure_extraction names extract_zip', async () => {
            const list = await agent.request<{ prompts: Array<{ name: string }>; cacheScope?: string }>('prompts/list');
            expect(list.prompts.map((p) => p.name)).toEqual(['governance_contract', 'draft_issue_workflow', 'secure_extraction', 'reproducible_archive', 'incremental_update', 'forensic_scan', 'verify_before_trust']);
            if (modern) expect(list.cacheScope).toBe('public');
            const prompt = await agent.request<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>('prompts/get', { name: 'secure_extraction' });
            expect(prompt.messages[0]?.role).toBe('user');
            expect(prompt.messages[0]?.content.text).toContain('extract_zip');
            expect(prompt.messages[0]?.content.text).toContain('verify_zip');
        });

        it('S17 shutdown: every error carried a code and a remedy, stdout stayed JSON-only, the session closed cleanly', async () => {
            // Every isError result of the run: `_meta.error.code`, the "<tool> failed [CODE]: " text, a remedy in the message.
            expect(agent.errors.map((e) => errorMeta(e.result).code)).toEqual([
                'ZIP_ENTRY_NOT_FOUND', 'ZIP_PATH_TRAVERSAL', 'ZIP_ENTRY_OVERLAP', 'LIMIT_CEILING_EXCEEDED', 'LIMIT_CEILING_EXCEEDED', 'GOVERNANCE_VIOLATION',
            ]);
            for (const { tool, result } of agent.errors) {
                const meta = errorMeta(result);
                expect(typeof meta.code).toBe('string');
                expect(text0(result)).toBe(`${tool} failed [${meta.code}]: ${meta.message}`);
                const remedy = REMEDY_BY_CODE[meta.code];
                expect(remedy, `no remedy pattern registered for ${meta.code}`).toBeDefined();
                expect(meta.message, `${meta.code} message must name the remedy`).toMatch(remedy!);
            }

            report = await agent.close();
            if (stdio) {
                for (const line of report.stdoutLines) {
                    expect(() => JSON.parse(line), `non-JSON stdout line: ${line.slice(0, 120)}`).not.toThrow();
                }
                expect(report.stderr).toContain('ready (stdio transport');
                expect(report.stderr).toContain('ZIPNATIVE_MCP_MAX_ENTRIES = 5000');
                expect(report.stderr).toContain('ZIPNATIVE_MCP_WORKERS = 2');
                expectCleanStdioExit(report);
            } else {
                expect(report.exitCode).toBe(0);
                expect(report.stdoutLines).toEqual([]);
            }
        });
    });
});
