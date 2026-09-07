/**
 * MCP 2026-07-28 normative conformance of the tool catalogue:
 *
 *   - server/tools, Output Schema: "Servers MUST provide structured results
 *     that conform to this schema" — every `structuredContent` this server
 *     can emit (full result, `verbosity:'summary'`, `fields` projections,
 *     presence-gated fields, file mode, diagnostics / summary extras) is
 *     validated against the advertised `outputSchema` with the SDK's own
 *     JSON Schema 2020-12 engine.
 *   - `_meta.examples[].input` ("a self-contained input") must validate
 *     against the tool's `inputSchema`, and placeholder-free examples must
 *     execute without VALIDATION_ERROR.
 *   - Every object schema keeps `additionalProperties: false` (SECURITY.md
 *     invariant), no `$ref` / network dereference.
 *   - server.json satisfies the registry limits that the publisher enforces.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

import { callToolDirect, ensureEngineReady, listToolsPayload } from '../src/server.js';
import { b64, basicZip, CRC_OVERRIDE, DEVICE_NAME, ENCRYPTED_FLAG, richZip, SFX_PREFIXED, streamedZip, truncated, ZIP_SLIP } from './_zip-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JSON = path.join(ROOT, 'server.json');

const validator = new AjvJsonSchemaValidator();
const tools = listToolsPayload().tools;
const byName = new Map(tools.map((t) => [t.name, t]));

function validateAgainst(schema: unknown, value: unknown): string | null {
    const v = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
    const r = v(value);
    return r.valid ? null : r.errorMessage;
}

async function callSc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const r = await callToolDirect(name, args);
    expect(r.isError, `${name}: ${JSON.stringify(r.content?.[0]).slice(0, 300)}`).not.toBe(true);
    return r.structuredContent as Record<string, unknown> | undefined;
}

const DRAFT = {
    title: 'scan_zip_forward misreports stoppedAt on an SFX prefix',
    summary: 'A stream that starts with a self-extractor stub ends with stoppedAt "eof" instead of "error".',
    issueType: 'bug',
    targetRepo: 'zipnative-mcp',
    reproduction: { command: 'scan_zip_forward { zipBase64: <sfx>, tolerateTruncation: true }', result: 'stoppedAt: "eof"' },
    expectedBehavior: 'stoppedAt "error" with error.code ZIP_SIGNATURE_MISMATCH.',
    duplicateSearchPerformed: true,
};

describe('MCP 2026-07-28 — structuredContent conforms to outputSchema (SDK 2020-12 validator)', () => {
    let plain: string;
    let rich: string;
    let streamed: string;
    const rawDeflate = b64(deflateRawSync(Buffer.from('hello hello hello')));

    beforeAll(async () => {
        await ensureEngineReady();
        plain = b64(basicZip());
        rich = b64(richZip());
        streamed = b64(await streamedZip());
    });

    const cases: Array<[string, () => Record<string, unknown>]> = [
        // inspect_zip: full, summary, fields, check / assert variants, diagnostics present, hostile-but-openable
        ['inspect_zip', () => ({ zipBase64: rich })],
        ['inspect_zip', () => ({ zipBase64: rich, verbosity: 'summary' })],
        ['inspect_zip', () => ({ zipBase64: plain, check: ['deterministic', 'safe-names', 'store-only'], fields: ['entryCount', 'checks', 'checksPassed'] })],
        ['inspect_zip', () => ({ zipBase64: plain, assert: { maxEntries: 10, minEntries: 1, maxUncompressedBytes: 1_000_000, maxRatio: 100, has: ['README.md', 'missing'], method: 'deflate' } })],
        ['inspect_zip', () => ({ zipBase64: b64(SFX_PREFIXED()), validate: 'lazy' })],
        ['inspect_zip', () => ({ zipBase64: b64(DEVICE_NAME()), check: ['safe-names'], verbosity: 'summary' })],
        ['inspect_zip', () => ({ zipBase64: streamed, check: ['canonical-layout'] })],
        // list_zip_entries: full, summary, fields, paging, filter, extra data
        ['list_zip_entries', () => ({ zipBase64: rich })],
        ['list_zip_entries', () => ({ zipBase64: rich, verbosity: 'summary' })],
        ['list_zip_entries', () => ({ zipBase64: rich, includeExtraData: true, validate: 'eager' })],
        ['list_zip_entries', () => ({ zipBase64: plain, offset: 1, limit: 1, fields: ['entries.name', 'entries.sanitizedPath', 'hasMore'] })],
        ['list_zip_entries', () => ({ zipBase64: plain, filter: { prefix: 'src/', glob: ['**/*.js'] } })],
        // read_zip_entry: data (base64 / utf8 / range), raw, verify, summary
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'README.md' })],
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'README.md', encoding: 'utf8' })],
        ['read_zip_entry', () => ({ zipBase64: plain, index: 0, range: { offset: 2, length: 5 } })],
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'docs/guide.md', mode: 'raw' })],
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'src/index.js', mode: 'verify' })],
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'src/index.js', mode: 'verify', verbosity: 'summary' })],
        ['read_zip_entry', () => ({ zipBase64: plain, name: 'README.md', fields: ['entry.name', 'sizeBytes'] })],
        // verify_zip: ok, failed rows, skipped rows, structural error, summary, none
        ['verify_zip', () => ({ zipBase64: rich })],
        ['verify_zip', () => ({ zipBase64: b64(CRC_OVERRIDE()), entries: 'failed' })],
        ['verify_zip', () => ({ zipBase64: b64(ENCRYPTED_FLAG()), entries: 'skipped' })],
        ['verify_zip', () => ({ zipBase64: b64(truncated(basicZip(), 60)) })],
        ['verify_zip', () => ({ zipBase64: rich, verbosity: 'summary' })],
        ['verify_zip', () => ({ zipBase64: rich, entries: 'none', maxEntries: 1 })],
        ['verify_zip', () => ({ zipBase64: rich, maxEntries: 2 })],
        ['verify_zip', () => ({ zipBase64: rich, fields: ['ok', 'entries.name', 'entries.ok'] })],
        // extract_zip: inline, dry run, filter, relaxed traversal (skipped rows), summary
        ['extract_zip', () => ({ zipBase64: rich })],
        ['extract_zip', () => ({ zipBase64: rich, includeData: false })],
        ['extract_zip', () => ({ zipBase64: plain, filter: { names: ['README.md'] }, verbosity: 'summary' })],
        ['extract_zip', () => ({ zipBase64: b64(ZIP_SLIP()), rejectTraversal: false })],
        ['extract_zip', () => ({ zipBase64: rich, fields: ['entries.path', 'fileCount'] })],
        // scan_zip_forward: complete (none / verify / include), truncated with tolerateTruncation, summary, streamed, filter
        ['scan_zip_forward', () => ({ zipBase64: rich })],
        ['scan_zip_forward', () => ({ zipBase64: rich, data: 'verify' })],
        ['scan_zip_forward', () => ({ zipBase64: plain, data: 'include', filter: { glob: ['*.md'] } })],
        ['scan_zip_forward', () => ({ zipBase64: b64(truncated(basicZip(), 60)), tolerateTruncation: true })],
        ['scan_zip_forward', () => ({ zipBase64: b64(SFX_PREFIXED()), tolerateTruncation: true, verbosity: 'summary' })],
        ['scan_zip_forward', () => ({ zipBase64: streamed, data: 'verify' })],
        ['scan_zip_forward', () => ({ zipBase64: plain, maxEntries: 2 })],
        // stateless tools
        ['sanitize_entry_paths', () => ({ names: ['docs/readme.md', '../../etc/passwd', 'C:\\Windows\\win.ini', 'aux.txt', 'a/./b//c.txt', '', 'a\0b', '//unc/share', 'x:y', '.'] })],
        ['sanitize_entry_paths', () => ({ names: ['ok', '../no'], verbosity: 'summary' })],
        ['compute_crc32', () => ({ text: 'hello world', expect: '0d4a1185' })],
        ['compute_crc32', () => ({ dataBase64: 'aGVsbG8=', seed: 12345 })],
        ['compute_crc32', () => ({ dataBase64: '' })],
        ['describe_engine', () => ({})],
        ['describe_engine', () => ({ verbosity: 'summary' })],
        ['describe_engine', () => ({ fields: ['defaultLimits', 'ceilings', 'sandbox'] })],
        // archive producers (base64)
        ['create_zip', () => ({ entries: [{ name: 'README.md', text: '# Hello\n' }, { name: 'dir/', directory: true }, { name: 'bin', dataBase64: 'AAEC', compression: { method: 'store' }, unixMode: '0755', comment: 'c' }], includeSha256: true, comment: 'archive' })],
        ['create_zip', () => ({ entries: [{ name: 'a.txt', text: 'x' }], defaultDate: 'now' })],
        ['create_zip', () => ({ entries: [] })],
        ['create_zip', () => ({ entries: [{ name: 'a.txt', text: 'x'.repeat(4096) }], compression: { deterministic: true, level: 9 }, parallel: { workers: 0 } })],
        ['modify_zip', () => ({ zipBase64: plain, operations: [{ op: 'replace', name: 'README.md', text: 'replaced' }, { op: 'add', name: 'new.txt', text: 'n' }, { op: 'remove', name: 'docs/guide.md' }, { op: 'rename', from: 'src/index.js', to: 'src/main.js' }, { op: 'setComment', comment: 'edited' }], includeSha256: true })],
        ['modify_zip', () => ({ zipBase64: plain, operations: [{ op: 'remove', name: 'README.md' }], mode: 'compact' })],
        ['modify_zip', () => ({ zipBase64: plain, operations: [{ op: 'setComment', comment: '' }] })],
        ['inflate_raw', () => ({ dataBase64: rawDeflate, maxOutput: 1024 })],
        ['inflate_raw', () => ({ dataBase64: b64(Buffer.concat([deflateRawSync(Buffer.from('abc')), Buffer.from('tail')])), maxOutput: 1024 })],
        ['inflate_raw', () => ({ dataBase64: 'AAEC', maxOutput: 3, method: 'store' })],
        ['draft_governance_issue', () => DRAFT],
    ];

    for (const [name, args] of cases) {
        it(`${name} ${JSON.stringify(Object.keys(args()).filter((k) => k !== 'zipBase64')).slice(0, 70)} validates`, async () => {
            const sc = await callSc(name, args());
            const schema = byName.get(name)?.outputSchema;
            expect(schema, `${name} advertises an outputSchema`).toBeDefined();
            expect(validateAgainst(schema, sc)).toBeNull();
        });
    }

    it('file-mode results validate too (create_zip, modify_zip, inflate_raw, extract_zip, draft_governance_issue)', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-schema-'));
        process.env['ZIPNATIVE_MCP_OUTPUT_DIR'] = dir;
        try {
            const created = await callSc('create_zip', { entries: [{ name: 'a.txt', text: 'f' }], outputMode: 'file', outputPath: 'a/b.zip' });
            expect(validateAgainst(byName.get('create_zip')!.outputSchema, created)).toBeNull();
            const modified = await callSc('modify_zip', { zipPath: 'a/b.zip', operations: [{ op: 'add', name: 'c.txt', sourcePath: 'a/b.zip' }], outputMode: 'file', outputPath: 'a/c.zip' });
            expect(validateAgainst(byName.get('modify_zip')!.outputSchema, modified)).toBeNull();
            const inflated = await callSc('inflate_raw', { dataBase64: rawDeflate, maxOutput: 1024, outputMode: 'file', outputPath: 'a/inflated.txt' });
            expect(validateAgainst(byName.get('inflate_raw')!.outputSchema, inflated)).toBeNull();
            const extracted = await callSc('extract_zip', { zipPath: 'a/c.zip', outputMode: 'file', outputDir: 'out', emptyDirectories: true });
            expect(validateAgainst(byName.get('extract_zip')!.outputSchema, extracted)).toBeNull();
            const extractedSummary = await callSc('extract_zip', { zipPath: 'a/c.zip', outputMode: 'file', outputDir: 'out2', verbosity: 'summary' });
            expect(validateAgainst(byName.get('extract_zip')!.outputSchema, extractedSummary)).toBeNull();
            const streamedCreate = await callSc('create_zip', { entries: [{ name: 'big.zip', sourcePath: 'a/b.zip', stream: true }], outputMode: 'file', outputPath: 'a/streamed.zip', chunkSize: 1024 });
            expect(validateAgainst(byName.get('create_zip')!.outputSchema, streamedCreate)).toBeNull();
            const draft = await callSc('draft_governance_issue', { ...DRAFT, outputMode: 'file', outputPath: 'drafts/issue.md' });
            expect(validateAgainst(byName.get('draft_governance_issue')!.outputSchema, draft)).toBeNull();
            const crc = await callSc('compute_crc32', { sourcePath: 'a/b.zip' });
            expect(validateAgainst(byName.get('compute_crc32')!.outputSchema, crc)).toBeNull();
            const scanned = await callSc('scan_zip_forward', { zipPath: 'a/c.zip', data: 'verify' });
            expect(validateAgainst(byName.get('scan_zip_forward')!.outputSchema, scanned)).toBeNull();
        } finally {
            delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('tool catalogue hygiene', () => {
    it('every object schema keeps additionalProperties:false and no schema uses $ref', () => {
        const walk = (node: unknown, at: string, issues: string[]): void => {
            if (Array.isArray(node)) {
                node.forEach((n, i) => walk(n, `${at}[${i}]`, issues));
                return;
            }
            if (node === null || typeof node !== 'object') return;
            const o = node as Record<string, unknown>;
            const isObjectType = o['type'] === 'object' || (Array.isArray(o['type']) && (o['type'] as unknown[]).includes('object'));
            if (isObjectType && o['properties'] !== undefined && o['additionalProperties'] !== false) issues.push(`${at}: object without additionalProperties:false`);
            if ('$ref' in o) issues.push(`${at}: $ref`);
            for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`, issues);
        };
        const issues: string[] = [];
        for (const t of tools) {
            walk(t.inputSchema, `${t.name}.inputSchema`, issues);
            if (t.outputSchema !== undefined) walk(t.outputSchema, `${t.name}.outputSchema`, issues);
        }
        expect(issues).toEqual([]);
    });

    it('A-013: every input-schema property (recursively, union arms and array items included) has a non-empty description', () => {
        const missing: string[] = [];
        const walk = (node: unknown, at: string): void => {
            if (node === null || typeof node !== 'object') return;
            const o = node as Record<string, unknown>;
            if (o['properties'] !== undefined) {
                for (const [k, v] of Object.entries(o['properties'] as Record<string, Record<string, unknown>>)) {
                    const d = v['description'];
                    if (typeof d !== 'string' || d.trim().length === 0) missing.push(`${at}.${k}`);
                    walk(v, `${at}.${k}`);
                }
            }
            if (o['items'] !== undefined) walk(o['items'], `${at}[]`);
            for (const [i, arm] of ((o['oneOf'] ?? o['anyOf'] ?? []) as unknown[]).entries()) walk(arm, `${at}|${i}`);
        };
        let total = 0;
        const count = (node: unknown): void => {
            if (node === null || typeof node !== 'object') return;
            const o = node as Record<string, unknown>;
            if (o['properties'] !== undefined) {
                for (const v of Object.values(o['properties'] as Record<string, unknown>)) {
                    total++;
                    count(v);
                }
            }
            if (o['items'] !== undefined) count(o['items']);
            for (const arm of (o['oneOf'] ?? o['anyOf'] ?? []) as unknown[]) count(arm);
        };
        for (const t of tools) {
            walk(t.inputSchema, t.name);
            count(t.inputSchema);
        }
        expect(total).toBeGreaterThan(200);
        expect(missing, `undescribed input properties: ${missing.join(', ')}`).toEqual([]);
    });

    it('B-016: create_zip / modify_zip / inflate_raw declare a typed summary, and every summary key a call emits is declared', async () => {
        await ensureEngineReady();
        const cases: Array<[string, Record<string, unknown>]> = [
            ['create_zip', { entries: [{ name: 'a.txt', text: 'a' }], includeSha256: true, parallel: { workers: 0 } }],
            ['modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'remove', name: 'README.md' }], includeSha256: true }],
            ['inflate_raw', { dataBase64: b64(Buffer.concat([deflateRawSync(Buffer.from('abc')), Buffer.from('tail')])), maxOutput: 1024 }],
        ];
        for (const [name, args] of cases) {
            const schema = byName.get(name)!.outputSchema as { properties: { summary: { additionalProperties: boolean; properties: Record<string, unknown> } } };
            const declared = Object.keys(schema.properties.summary.properties);
            expect(declared.length, name).toBeGreaterThanOrEqual(8);
            expect(schema.properties.summary.additionalProperties, name).toBe(false);
            const sc = (await callSc(name, args)) as { summary: Record<string, unknown> };
            for (const key of Object.keys(sc.summary)) expect(declared, `${name}.summary.${key}`).toContain(key);
            expect(validateAgainst(schema, sc)).toBeNull();
        }
        expect(Object.keys((byName.get('create_zip')!.outputSchema as { properties: { summary: { properties: object } } }).properties.summary.properties)).toEqual(expect.arrayContaining(['deterministic', 'deflateTier', 'sha256', 'parallel']));
        expect(Object.keys((byName.get('modify_zip')!.outputSchema as { properties: { summary: { properties: object } } }).properties.summary.properties)).toEqual(expect.arrayContaining(['saveMode', 'noOp', 'grewByBytes', 'sha256']));
        expect(Object.keys((byName.get('inflate_raw')!.outputSchema as { properties: { summary: { properties: object } } }).properties.summary.properties)).toEqual(expect.arrayContaining(['bytesConsumed', 'leftover', 'finished', 'maxOutput']));
    });

    it('every _meta.examples[].input validates against its inputSchema', () => {
        const failures: string[] = [];
        for (const t of tools) {
            const examples = ((t._meta as { examples?: Array<{ title: string; input: unknown }> })?.examples) ?? [];
            expect(examples.length, `${t.name} has examples`).toBeGreaterThan(0);
            for (const ex of examples) {
                const err = validateAgainst(t.inputSchema, ex.input);
                if (err !== null) failures.push(`${t.name} :: ${ex.title} :: ${err}`);
            }
        }
        expect(failures).toEqual([]);
    });

    it('placeholder-free _meta.examples execute without VALIDATION_ERROR (and placeholder ones resolve to a real archive)', async () => {
        await ensureEngineReady();
        const failures: string[] = [];
        const zipBase64 = b64(richZip());
        for (const t of tools) {
            const examples = ((t._meta as { examples?: Array<{ title: string; input: Record<string, unknown> }> })?.examples) ?? [];
            for (const ex of examples) {
                const serialized = JSON.stringify(ex.input);
                const hasPlaceholder = serialized.includes('<');
                if (hasPlaceholder && !serialized.includes('"<zip-base64>"')) continue;
                // The only placeholder the catalogue uses is <zip-base64>; file-mode examples need a sandbox and are skipped.
                if (ex.input['outputMode'] === 'file') continue;
                const input = JSON.parse(serialized.replaceAll('"<zip-base64>"', JSON.stringify(zipBase64))) as Record<string, unknown>;
                const r = await callToolDirect(t.name, input);
                const text = (r.content?.[0] as { text?: string } | undefined)?.text ?? '';
                if (r.isError === true && text.includes('VALIDATION_ERROR')) failures.push(`${t.name} :: ${ex.title} :: ${text.slice(0, 160)}`);
            }
        }
        expect(failures).toEqual([]);
    }, 120_000);

    it.skipIf(!existsSync(SERVER_JSON))('server.json respects the registry limits the publisher enforces', () => {
        const manifest = JSON.parse(readFileSync(SERVER_JSON, 'utf8')) as { description: string; name: string; version: string };
        expect(manifest.description.length).toBeLessThanOrEqual(100);
        expect(manifest.name).toMatch(/^io\.github\.[A-Za-z0-9-]+\/[a-z0-9-]+$/);
    });
});
