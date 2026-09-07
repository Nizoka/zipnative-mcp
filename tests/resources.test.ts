/**
 * Tests for the native MCP resources layer — every regular file in the
 * sandbox (archives written by create_zip / modify_zip, files written by
 * extract_zip, archives dropped in for zipPath) exposed as
 * zipnative://output/… resource URIs.
 */
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isArchivePath, listResources, listResourceTemplates, mimeTypeFor, readResource, resourceLinkForPath, resourceUriForPath, RESOURCE_URI_PREFIX } from '../src/resources.js';
import { callToolDirect, createServer, ensureEngineReady } from '../src/server.js';
import { connectLegacy, McpRpcError } from './_mcp-harness.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip } from './_zip-fixtures.js';

const ENV_KEY = 'ZIPNATIVE_MCP_OUTPUT_DIR';

const ENTRIES = [{ name: 'README.md', text: '# resources\n' }, { name: 'src/index.js', text: 'export {};\n' }, { name: 'data.json', text: '{"a":1}' }];

async function writeSampleZip(name = 'report.zip'): Promise<string> {
    const r = await callToolDirect('create_zip', { entries: ENTRIES, outputMode: 'file', outputPath: name });
    expect(r.isError, JSON.stringify(r.content[0])).not.toBe(true);
    return (r.structuredContent as { filePath: string }).filePath;
}

async function freshSandbox(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-res-'));
    process.env[ENV_KEY] = dir;
    return dir;
}

describe('MCP resources', () => {
    beforeAll(async () => {
        await ensureEngineReady();
    });
    afterEach(() => {
        delete process.env[ENV_KEY];
    });

    it('returns no resources when the sandbox is disabled', async () => {
        delete process.env[ENV_KEY];
        expect(await listResources()).toEqual([]);
        expect(listResourceTemplates()).toEqual([]);
        expect(resourceUriForPath('/anywhere/x.zip')).toBeNull();
        expect(resourceLinkForPath('/anywhere/x.zip')).toBeNull();
    });

    it('lists sandboxed archives and extracted files as resources with a MIME type by extension', async () => {
        await freshSandbox();
        await writeSampleZip('report.zip');
        await writeSampleZip('nested/deep.epub');
        const extracted = await callToolDirect('extract_zip', { zipPath: 'report.zip', outputMode: 'file', outputDir: 'unpacked' });
        expect(extracted.isError).not.toBe(true);
        const resources = await listResources();
        const byUri = new Map(resources.map((r) => [r.uri, r]));
        expect([...byUri.keys()]).toEqual([
            `${RESOURCE_URI_PREFIX}nested/deep.epub`,
            `${RESOURCE_URI_PREFIX}report.zip`,
            `${RESOURCE_URI_PREFIX}unpacked/README.md`,
            `${RESOURCE_URI_PREFIX}unpacked/data.json`,
            `${RESOURCE_URI_PREFIX}unpacked/src/index.js`,
        ]);
        expect(byUri.get(`${RESOURCE_URI_PREFIX}report.zip`)).toMatchObject({ name: 'report.zip', title: 'report.zip', mimeType: 'application/zip' });
        expect(byUri.get(`${RESOURCE_URI_PREFIX}report.zip`)!.description).toMatch(/^Archive at report\.zip \(\d+ bytes\)/);
        expect(byUri.get(`${RESOURCE_URI_PREFIX}nested/deep.epub`)).toMatchObject({ name: 'nested/deep.epub', title: 'deep.epub', mimeType: 'application/epub+zip' });
        expect(byUri.get(`${RESOURCE_URI_PREFIX}unpacked/README.md`)).toMatchObject({ mimeType: 'text/markdown', title: 'README.md' });
        expect(byUri.get(`${RESOURCE_URI_PREFIX}unpacked/README.md`)!.description).toMatch(/^File at unpacked\/README\.md/);
        expect(byUri.get(`${RESOURCE_URI_PREFIX}unpacked/data.json`)!.mimeType).toBe('application/json');
        expect(byUri.get(`${RESOURCE_URI_PREFIX}unpacked/src/index.js`)!.mimeType).toBe('text/javascript');
        for (const r of resources) expect(r.size).toBeGreaterThan(0);
    });

    it('mimeTypeFor / isArchivePath cover the container allow-list and fall back to octet-stream', () => {
        expect(mimeTypeFor('a.JAR')).toBe('application/java-archive');
        expect(mimeTypeFor('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        expect(mimeTypeFor('a.unknownext')).toBe('application/octet-stream');
        expect(mimeTypeFor('noext')).toBe('application/octet-stream');
        expect(isArchivePath('x/y.VSIX')).toBe(true);
        expect(isArchivePath('x/y.md')).toBe(false);
    });

    it('reads an archive back as a base64 blob that passes the full validity gate', async () => {
        await freshSandbox();
        await writeSampleZip('report.zip');
        const contents = await readResource(`${RESOURCE_URI_PREFIX}report.zip`);
        expect(contents.uri).toBe(`${RESOURCE_URI_PREFIX}report.zip`);
        expect(contents.mimeType).toBe('application/zip');
        assertValidZip(contents.blob, 'report.zip');
        // Extracted files are readable too, with their own MIME type; URI-encoded paths decode.
        await callToolDirect('extract_zip', { zipPath: 'report.zip', outputMode: 'file', outputDir: 'un packed' });
        const md = await readResource(`${RESOURCE_URI_PREFIX}un%20packed/README.md`);
        expect(md.mimeType).toBe('text/markdown');
        expect(Buffer.from(md.blob, 'base64').toString('utf8')).toBe('# resources\n');
    });

    it('maps an absolute sandbox path to a resource URI / resource_link', async () => {
        const dir = await freshSandbox();
        expect(resourceUriForPath(path.join(dir, 'sub', 'a.zip'))).toBe(`${RESOURCE_URI_PREFIX}sub/a.zip`);
        expect(resourceLinkForPath(path.join(dir, 'sub', 'a.zip'))).toEqual({ uri: `${RESOURCE_URI_PREFIX}sub/a.zip`, name: 'sub/a.zip', title: 'a.zip', mimeType: 'application/zip' });
        expect(resourceUriForPath(path.join(os.tmpdir(), 'outside.zip'))).toBeNull();
        expect(resourceUriForPath(dir)).toBeNull();
    });

    it('rejects a path-traversal URI with SECURITY_VIOLATION', async () => {
        await freshSandbox();
        await expect(readResource(`${RESOURCE_URI_PREFIX}../escape.zip`)).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        await expect(readResource(`${RESOURCE_URI_PREFIX}..%2Fescape.zip`)).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        await expect(readResource(`${RESOURCE_URI_PREFIX}/etc/passwd`)).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('rejects an unknown scheme, an empty path, a missing file and a directory with UNKNOWN_RESOURCE', async () => {
        await freshSandbox();
        await fs.mkdir(path.join(process.env[ENV_KEY]!, 'folder'));
        await expect(readResource('file:///etc/passwd')).rejects.toMatchObject({ code: 'UNKNOWN_RESOURCE' });
        await expect(readResource(RESOURCE_URI_PREFIX)).rejects.toMatchObject({ code: 'UNKNOWN_RESOURCE' });
        await expect(readResource(`${RESOURCE_URI_PREFIX}nope.zip`)).rejects.toMatchObject({ code: 'UNKNOWN_RESOURCE' });
        await expect(readResource(`${RESOURCE_URI_PREFIX}folder`)).rejects.toMatchObject({ code: 'UNKNOWN_RESOURCE' });
    });

    it('lists a resource template for the sandbox address space', async () => {
        await freshSandbox();
        const templates = listResourceTemplates();
        expect(templates).toHaveLength(1);
        expect(templates[0]!.uriTemplate).toBe(`${RESOURCE_URI_PREFIX}{+path}`);
        expect(templates[0]!.mimeType).toBe('application/zip');
        expect(templates[0]!.description).toContain('ZIPNATIVE_MCP_OUTPUT_DIR');
    });

    it('emits a resource_link with a human-readable name in file-mode results (create_zip and extract_zip)', async () => {
        await freshSandbox();
        const client = await connectLegacy(createServer());
        try {
            const res = (await client.callTool('create_zip', { entries: ENTRIES, outputMode: 'file', outputPath: 'sub/r.zip' })) as { content: Array<{ type: string; uri?: string; name?: string; title?: string; mimeType?: string }> };
            const link = res.content.find((c) => c.type === 'resource_link');
            expect(link).toEqual({ type: 'resource_link', uri: `${RESOURCE_URI_PREFIX}sub/r.zip`, name: 'sub/r.zip', title: 'r.zip', mimeType: 'application/zip' });
            const ex = (await client.callTool('extract_zip', { zipPath: 'sub/r.zip', outputMode: 'file', outputDir: 'out' })) as { content: Array<{ type: string; uri?: string; name?: string }> };
            const links = ex.content.filter((c) => c.type === 'resource_link').map((c) => c.uri);
            expect(links).toEqual([`${RESOURCE_URI_PREFIX}out/README.md`, `${RESOURCE_URI_PREFIX}out/data.json`, `${RESOURCE_URI_PREFIX}out/src/index.js`]);
        } finally {
            await client.close();
        }
    });
});

describe('MCP resources over the wire (resources/list, resources/read, resources/templates/list)', () => {
    beforeAll(async () => {
        await ensureEngineReady();
    });
    afterEach(() => {
        delete process.env[ENV_KEY];
    });

    it('serves the sandbox listing, template and blob through the JSON-RPC handlers', async () => {
        await freshSandbox();
        await writeSampleZip('wire.zip');
        const client = await connectLegacy();
        try {
            const list = await client.request<{ resources: Array<{ uri: string; name: string; title: string; description: string; mimeType: string; size: number }> }>('resources/list');
            expect(list.resources.map((r) => r.uri)).toEqual([`${RESOURCE_URI_PREFIX}wire.zip`]);
            expect(list.resources[0]).toMatchObject({ name: 'wire.zip', title: 'wire.zip', mimeType: 'application/zip' });
            const templates = await client.request<{ resourceTemplates: Array<{ uriTemplate: string }> }>('resources/templates/list');
            expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual([`${RESOURCE_URI_PREFIX}{+path}`]);
            const read = await client.readResource<{ contents: Array<{ uri: string; mimeType: string; blob: string }> }>(`${RESOURCE_URI_PREFIX}wire.zip`);
            expect(read.contents).toHaveLength(1);
            expect(read.contents[0]!.mimeType).toBe('application/zip');
            assertValidZip(read.contents[0]!.blob, 'wire.zip');
            expect(read.contents[0]!.blob).toBe(b64(await fs.readFile(path.join(process.env[ENV_KEY]!, 'wire.zip'))));
        } finally {
            await client.close();
        }
    });

    it('reads an EXTRACTED file and a governance draft back over the wire with their own MIME types; the listing sees both', async () => {
        await freshSandbox();
        await writeSampleZip('src.zip');
        const extracted = await callToolDirect('extract_zip', { zipPath: 'src.zip', outputMode: 'file', outputDir: 'unpacked' });
        expect(extracted.isError).not.toBe(true);
        const draft = await callToolDirect('draft_governance_issue', {
            title: 'inspect_zip reports the wrong ratio for stored entries',
            summary: 'The ratio string is inverted for stored entries in the summary projection.',
            issueType: 'bug',
            reproduction: { command: 'inspect_zip { zipBase64, verbosity: "summary" }', result: 'ratio "0.5:1"' },
            expectedBehavior: 'ratio "1.0:1"',
            duplicateSearchPerformed: true,
            outputMode: 'file',
            outputPath: 'drafts/issue.md',
        });
        expect(draft.isError).not.toBe(true);
        const client = await connectLegacy();
        try {
            const list = await client.request<{ resources: Array<{ uri: string; mimeType: string }> }>('resources/list');
            expect(list.resources.map((r) => r.uri)).toEqual([
                `${RESOURCE_URI_PREFIX}drafts/issue.md`,
                `${RESOURCE_URI_PREFIX}src.zip`,
                `${RESOURCE_URI_PREFIX}unpacked/README.md`,
                `${RESOURCE_URI_PREFIX}unpacked/data.json`,
                `${RESOURCE_URI_PREFIX}unpacked/src/index.js`,
            ]);
            const md = await client.readResource<{ contents: Array<{ uri: string; mimeType: string; blob: string }> }>(`${RESOURCE_URI_PREFIX}unpacked/README.md`);
            expect(md.contents[0]).toMatchObject({ uri: `${RESOURCE_URI_PREFIX}unpacked/README.md`, mimeType: 'text/markdown' });
            expect(Buffer.from(md.contents[0]!.blob, 'base64').toString('utf8')).toBe('# resources\n');
            const json = await client.readResource<{ contents: Array<{ mimeType: string; blob: string }> }>(`${RESOURCE_URI_PREFIX}unpacked/data.json`);
            expect(json.contents[0]?.mimeType).toBe('application/json');
            expect(JSON.parse(Buffer.from(json.contents[0]!.blob, 'base64').toString('utf8'))).toEqual({ a: 1 });
            const issue = await client.readResource<{ contents: Array<{ mimeType: string; blob: string }> }>(`${RESOURCE_URI_PREFIX}drafts/issue.md`);
            expect(issue.contents[0]?.mimeType).toBe('text/markdown');
            expect(Buffer.from(issue.contents[0]!.blob, 'base64').toString('utf8')).toContain('DRAFT ONLY');
        } finally {
            await client.close();
        }
    });

    it('maps UNKNOWN_RESOURCE and SECURITY_VIOLATION to JSON-RPC -32602 (Invalid params) on the legacy wire', async () => {
        await freshSandbox();
        const client = await connectLegacy();
        try {
            // Spec 2026-07-28: resource-not-found is -32602 on every revision.
            await expect(client.readResource(`${RESOURCE_URI_PREFIX}missing.zip`)).rejects.toMatchObject({ code: -32602 });
            const traversal = await client.readResource(`${RESOURCE_URI_PREFIX}../escape.zip`).catch((e: unknown) => e);
            expect(traversal).toBeInstanceOf(McpRpcError);
            expect((traversal as McpRpcError).code).toBe(-32602);
            expect((traversal as McpRpcError).message).toContain('[SECURITY_VIOLATION]');
            // With no sandbox, the listing is empty and every read is not-found.
            delete process.env[ENV_KEY];
            expect((await client.request<{ resources: unknown[] }>('resources/list')).resources).toEqual([]);
            expect((await client.request<{ resourceTemplates: unknown[] }>('resources/templates/list')).resourceTemplates).toEqual([]);
            await expect(client.readResource(`${RESOURCE_URI_PREFIX}wire.zip`)).rejects.toMatchObject({ code: -32602 });
        } finally {
            await client.close();
        }
    });

    it('a zipPath chain: create_zip → verify_zip → resources/read never re-sends the bytes', async () => {
        await freshSandbox();
        const zipBase64 = b64(basicZip());
        const created = await callToolDirect('modify_zip', { zipBase64, operations: [{ op: 'add', name: 'extra.txt', text: 'added' }], outputMode: 'file', outputPath: 'chain/mod.zip' });
        expect(created.isError).not.toBe(true);
        const verified = await callToolDirect('verify_zip', { zipPath: 'chain/mod.zip', verbosity: 'summary' });
        expect(verified.isError).not.toBe(true);
        expect((verified.structuredContent as { ok: boolean; entryCount: number }).ok).toBe(true);
        expect((verified.structuredContent as { ok: boolean; entryCount: number }).entryCount).toBe(5);
        const contents = await readResource(`${RESOURCE_URI_PREFIX}chain/mod.zip`);
        assertValidZip(contents.blob, 'chain/mod.zip');
    });
});
