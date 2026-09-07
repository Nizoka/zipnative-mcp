/**
 * zipnative-mcp — veraZIP conformance corpus definition
 * =======================================================
 * The ONE description of the archives the conformance gate validates, shared
 * by `scripts/generate-zip-corpus.mjs` (writes test-output/zip/ from the BUILT
 * dist/server.js) and `tests/verazip.test.ts` (runs the same entries in-process
 * against src/). Every entry names the MCP tool call that produces it — or the
 * raw-builder recipe for crafted archives — together with what the validator
 * and the server must say about it:
 *
 *   expectConformant  true: `validateArchive` must report zero failures;
 *                     false: it must report `expectedCheck` among them.
 *   refusedBy         `{ tool, code, arguments? }`: calling that tool on the
 *                     bytes must return isError with `[code]` in the text.
 *   after(bytes, ctx) structural assertion run once the bytes exist
 *                     (byte-identical pairs, prefix preservation, data
 *                     remanence, descriptor layout, diagnostics).
 *   verifyArguments   extra `verify_zip` arguments (the high-ratio sample).
 *
 * `buildCorpus({ call, sandboxDir })` is declarative: nothing is invoked until
 * `produceEntry` runs, so the vendor test can import it with a stub `call` to
 * count the entries against docs/data/verazip.json.
 *
 * Anti-circularity: this module never imports `zipnative`, `src/` or `dist/`.
 * The server is reached ONLY through the injected `call(tool, args)` (the
 * generator passes dist/server.js `callToolDirect`; the test passes src/), and
 * crafted archives come from `./raw-zip-builder.mjs`, whose bytes are never
 * shaped by the engine under test.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildRawZip } from './raw-zip-builder.mjs';

const te = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const equal = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

// ── Deterministic source material ──────────────────────────────────────
const README = 'zipnative-mcp conformance corpus — plain ASCII text\n'.repeat(20);
const NOTES = '# Notes\n\nThe same line, over and over, compresses well.\n'.repeat(40);
const PATTERN = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff);
const LARGE = Array.from({ length: 2000 }, (_, i) => `line ${String(i + 1).padStart(4, '0')}: the quick brown fox jumps over the lazy dog`).join('\n') + '\n';
const REMANENT = 'REMANENT-LOG-CONTENT\n';
const SFX_STUB = te.encode('#!/bin/sh\necho stub\n' + 'MZ-STUB-'.repeat(64));

const TEXT_ENTRIES = [
    { name: 'text/readme.txt', text: README },
    { name: 'text/notes.md', text: NOTES },
];
const BINARY_ENTRY = { name: 'binary/pattern.bin', dataBase64: b64(PATTERN) };
const MIXED_ENTRIES = [...TEXT_ENTRIES, BINARY_ENTRY];

/**
 * Server refusals, as OBSERVED (zipnative 1.0.0 through zipnative-mcp 1.0.0)
 * and re-verified at gate time: `{ tool, code }` is what the manifest records.
 *   - list_zip_entries is lazy by default and accepts an overlapping archive;
 *     the eager readers (inspect_zip, verify_zip) refuse it with
 *     ZIP_ENTRY_OVERLAP — inspect_zip is recorded.
 *   - a 2 GiB declared size on a 4-byte stored payload is refused on read
 *     (read_zip_entry through the chunked stream — a `range` window, the
 *     analogue of the CLI's `cat`) as ZIP_LIMIT_EXCEEDED (the 1 GiB
 *     maxEntryUncompressedSize bound), not as a CD/LFH mismatch. The default
 *     inline read is short-circuited earlier by the server's own 16 MiB
 *     inline cap (ENTRY_TOO_LARGE, a wrapper code), which is why the
 *     recorded refusal names the engine bound through the streamed path.
 *   - the LFH-name mismatch is NOT refused: the engine compares the names
 *     when it reads the payload, so verify_zip stays ok: true and emits the
 *     ZIP_NAME_MISMATCH diagnostic (asserted in `after`; inspect_zip's eager
 *     open does not compare names) — only the validator rejects the file.
 */
const REFUSE = {
    zipSlip: { tool: 'extract_zip', code: 'ZIP_PATH_TRAVERSAL' },
    deviceName: { tool: 'extract_zip', code: 'ZIP_PATH_TRAVERSAL' },
    duplicatePaths: { tool: 'extract_zip', code: 'ZIP_EXTRACT_DUPLICATE_PATH' },
    symlink: { tool: 'extract_zip', code: 'ZIP_SYMLINK_REJECTED' },
    overlap: { tool: 'inspect_zip', code: 'ZIP_ENTRY_OVERLAP' },
    cdMismatch: { tool: 'list_zip_entries', code: 'ZIP_CD_INCONSISTENT' },
    declaredBomb: { tool: 'read_zip_entry', code: 'ZIP_LIMIT_EXCEEDED', arguments: { name: 'bomb.bin', range: { offset: 0, length: 4 } } },
};

// ── Tool-call helpers (the only path to the server) ────────────────────

function errorText(result) {
    const first = result.content?.find((c) => c.type === 'text');
    return first?.text ?? 'unknown error';
}

/** Call a tool; throw with the tool's error text when `isError` is set. */
async function ok(ctx, tool, args) {
    const result = await ctx.call(tool, args);
    if (result.isError === true) throw new Error(`${tool}: ${errorText(result)}`);
    return result;
}

/** Call an archive-producing tool and return `{ bytes, result }` from the embedded resource block. */
async function archive(ctx, tool, args) {
    const result = await ok(ctx, tool, args);
    const block = (result.content ?? []).find((c) => c.type === 'resource' && typeof c.resource?.blob === 'string');
    if (block === undefined || block.resource.blob.length === 0) throw new Error(`${tool}: no embedded archive resource in the tool result.`);
    return { bytes: fromB64(block.resource.blob), result };
}

/** Call a read tool and return its `structuredContent`. */
async function structured(ctx, tool, args) {
    const result = await ok(ctx, tool, args);
    if (result.structuredContent === undefined) throw new Error(`${tool}: no structuredContent in the tool result.`);
    return result.structuredContent;
}

async function entryNames(ctx, bytes) {
    const listing = await structured(ctx, 'list_zip_entries', { zipBase64: b64(bytes), limit: 2000 });
    return listing.entries.map((e) => e.name);
}

async function entryRows(ctx, bytes) {
    const listing = await structured(ctx, 'list_zip_entries', { zipBase64: b64(bytes), limit: 2000 });
    return listing.entries;
}

function assert(condition, file, message) {
    if (!condition) throw new Error(`${file}: ${message}`);
}

function assertIdentical(ctx, a, b, what) {
    assert(equal(ctx.get(a), ctx.get(b)), b, `${what}: ${a} and ${b} are not byte-identical`);
}

/** Manifest-safe copy of the arguments: long strings (payloads) are abbreviated. */
function recorded(args) {
    const walk = (v) => {
        if (typeof v === 'string') return v.length > 120 ? `<${v.length} chars>` : v;
        if (Array.isArray(v)) return v.map(walk);
        if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(args);
}

// ── Corpus ──────────────────────────────────────────────────────────────

/**
 * Build the ordered corpus. `call(tool, args)` returns a CallToolResult and
 * `sandboxDir` is the directory `ZIPNATIVE_MCP_OUTPUT_DIR` points at (the
 * file-mode entries read and write there); both are carried by the context
 * `createContext` builds from the same values, so this function only needs
 * them to exist. Later entries consume earlier outputs through
 * `ctx.get(file)`, so execution is sequential in this order.
 */
export function buildCorpus({ call, sandboxDir }) {
    if (typeof call !== 'function') throw new TypeError('buildCorpus: call(tool, args) is required');
    void sandboxDir;
    const raw = [
        // ── Tool-produced, conformant ──────────────────────────────────
        {
            file: 'basic-store.zip',
            tool: 'create_zip',
            arguments: { entries: TEXT_ENTRIES, compression: { method: 'store' } },
            note: 'stored entries only',
        },
        ...[1, 6, 9].map((level) => ({
            file: `basic-deflate-${level}.zip`,
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, compression: { method: 'deflate', level } },
            note: `deflate level ${level}`,
            after: level === 9
                ? (bytes, ctx) => {
                    const sizes = [1, 6, 9].map((l) => ctx.get(`basic-deflate-${l}.zip`).length);
                    assert(sizes[0] >= sizes[1] && sizes[1] >= sizes[2], 'basic-deflate-9.zip', `compressed sizes are not monotone across levels 1/6/9: ${sizes.join(' / ')}`);
                }
                : undefined,
        })),
        {
            file: 'basic-empty.zip',
            tool: 'create_zip',
            arguments: { entries: [] },
            note: 'an empty archive is a valid archive (EOCD only)',
        },
        {
            file: 'basic-mixed-methods.zip',
            tool: 'create_zip',
            arguments: {
                entries: [
                    { name: 'text/readme.txt', text: README, compression: { method: 'deflate' } },
                    { name: 'binary/pattern.bin', dataBase64: b64(PATTERN), compression: { method: 'store' } },
                    { name: 'nested', directory: true },
                    { name: 'nested/inner/deep.txt', text: 'nested inline data\n' },
                ],
            },
            note: 'per-entry method + explicit directory + nested path',
        },
        {
            // bsdtar on Windows mangles non-ASCII names (documented upstream limitation).
            file: 'names-unicode-utf8.zip',
            tool: 'create_zip',
            arguments: {
                entries: [
                    { name: 'unicode/café/résumé.txt', text: 'non-ASCII path components (Latin-1 range)\n' },
                    { name: 'unicode/文档/说明.md', text: '# 说明\n\nCJK path components\n' },
                    { name: 'unicode/emoji-📦.txt', text: 'astral-plane code point in the name\n' },
                ],
            },
            integrityExclude: ['bsdtar@win32'],
            note: 'UTF-8 names with the EFS flag',
        },
        {
            file: 'names-deep-paths.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: `${'a/'.repeat(40)}deep.txt`, text: 'forty levels down\n' }, { name: 'shallow.txt', text: 'top level\n' }] },
            note: '40 directory levels',
        },
        {
            // EPUB-style layout: order 'insertion' keeps the call order so the
            // stored `mimetype` entry comes first (OCF requirement).
            file: 'order-insertion-epub.zip',
            tool: 'create_zip',
            arguments: {
                order: 'insertion',
                entries: [
                    { name: 'mimetype', text: 'application/epub+zip', compression: { method: 'store' } },
                    { name: 'META-INF/container.xml', text: '<?xml version="1.0"?><container version="1.0"/>\n' },
                    { name: 'OEBPS/chapter1.xhtml', text: NOTES },
                ],
            },
            note: "order 'insertion' — mimetype first, stored",
            after: async (bytes, ctx) => {
                const names = await entryNames(ctx, bytes);
                assert(names.join(',') === 'mimetype,META-INF/container.xml,OEBPS/chapter1.xhtml', 'order-insertion-epub.zip', `order 'insertion' — got ${names.join(',')}`);
                const rows = await entryRows(ctx, bytes);
                assert(rows[0].method === 0, 'order-insertion-epub.zip', `mimetype is method ${rows[0].method} (${rows[0].methodName}), expected 0 (store)`);
            },
        },
        {
            file: 'order-canonical.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: 'z.txt', text: 'last by name\n' }, { name: 'm/middle.txt', text: 'middle\n' }, { name: 'a.txt', text: 'first by name\n' }] },
            note: "order 'canonical' (default) sorts by raw UTF-8 name bytes",
            after: async (bytes, ctx) => {
                const names = await entryNames(ctx, bytes);
                assert(names.join(',') === 'a.txt,m/middle.txt,z.txt', 'order-canonical.zip', `canonical order — got ${names.join(',')}`);
            },
        },
        {
            file: 'comments-archive.zip',
            tool: 'create_zip',
            arguments: { entries: TEXT_ENTRIES, comment: 'zipnative-mcp conformance corpus — archive comment' },
            note: 'archive comment (UTF-8)',
        },
        {
            file: 'comments-entries.zip',
            tool: 'create_zip',
            arguments: {
                entries: [
                    { name: 'readme.txt', text: README, comment: 'per-entry comment (ASCII)' },
                    { name: 'notes.md', text: NOTES, comment: 'commentaire d’entrée — UTF-8' },
                ],
            },
            note: 'per-entry comments',
        },
        {
            file: 'extra-fields.zip',
            tool: 'create_zip',
            arguments: {
                entries: [
                    { name: 'readme.txt', text: README, extraFields: [{ id: 0x6a6a, dataBase64: b64(Uint8Array.from([0xde, 0xad, 0xbe, 0xef])) }] },
                    { name: 'notes.md', text: NOTES, extraFields: [{ id: 0x5a5a, dataBase64: 'AQIDBA==' }, { id: 0x6b6b, dataBase64: '' }] },
                ],
            },
            note: 'private extra fields written verbatim',
            after: async (bytes, ctx) => {
                const rows = await entryRows(ctx, bytes);
                const ids = (name) => (rows.find((e) => e.name === name)?.extraFields ?? []).map((x) => x.id).join(',');
                assert(ids('readme.txt') === String(0x6a6a), 'extra-fields.zip', `readme.txt extra field ids: ${ids('readme.txt')}`);
                assert(ids('notes.md') === `${0x5a5a},${0x6b6b}`, 'extra-fields.zip', `notes.md extra field ids: ${ids('notes.md')}`);
            },
        },
        {
            file: 'attributes-unix.zip',
            tool: 'create_zip',
            arguments: {
                entries: [
                    { name: 'bin/run.sh', text: '#!/bin/sh\necho ok\n', unixMode: '0755' },
                    { name: 'etc/config.txt', text: 'key=value\n', unixMode: '0644' },
                    { name: 'etc', directory: true, unixMode: '0755' },
                ],
            },
            note: 'unixMode → external attributes',
        },
        {
            file: 'dates-pinned.zip',
            tool: 'create_zip',
            arguments: {
                defaultDate: '2024-06-01T12:34:56Z',
                entries: [{ name: 'default-date.txt', text: 'takes defaultDate\n' }, { name: 'own-date.txt', text: 'takes its own date\n', date: '2001-02-03T04:05:06Z' }],
            },
            note: 'fixed ISO instants — reproducible',
        },
        {
            file: 'dates-now.zip',
            tool: 'create_zip',
            arguments: { defaultDate: 'now', entries: TEXT_ENTRIES },
            note: "defaultDate 'now' — conformant but not reproducible (ZIP_TIMESTAMP_NOT_PINNED)",
            after: (bytes, ctx) => {
                const codes = (ctx.resultOf('dates-now.zip').structuredContent?.diagnostics ?? []).map((d) => d.code);
                assert(codes.includes('ZIP_TIMESTAMP_NOT_PINNED'), 'dates-now.zip', `create_zip emitted no ZIP_TIMESTAMP_NOT_PINNED diagnostic (got ${codes.join(', ') || 'none'})`);
                assert(ctx.resultOf('dates-now.zip').structuredContent?.summary?.deterministic === false, 'dates-now.zip', 'summary.deterministic should be false');
            },
        },
        {
            file: 'deterministic-a.zip',
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, compression: { deterministic: true }, includeSha256: true },
            note: 'pinned pure-TS encoder',
        },
        {
            file: 'deterministic-b.zip',
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, compression: { deterministic: true }, includeSha256: true },
            note: 'same call again — must be byte-identical to deterministic-a',
            after: (bytes, ctx) => {
                assertIdentical(ctx, 'deterministic-a.zip', 'deterministic-b.zip', 'two deterministic runs');
                const sha = (f) => ctx.resultOf(f).structuredContent?.summary?.sha256;
                assert(typeof sha('deterministic-a.zip') === 'string' && sha('deterministic-a.zip') === sha('deterministic-b.zip'), 'deterministic-b.zip', 'summary.sha256 differs between the two runs');
            },
        },
        {
            file: 'parallel-sequential.zip',
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, compression: { deterministic: true } },
            note: 'sequential writer (reference for the parallel pair)',
        },
        {
            file: 'parallel-parallel.zip',
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, compression: { deterministic: true }, parallel: { workers: 2, minWorkerJobSize: 1 } },
            note: 'worker pool — must be byte-identical to parallel-sequential',
            after: (bytes, ctx) => {
                assertIdentical(ctx, 'parallel-sequential.zip', 'parallel-parallel.zip', 'sequential vs parallel {workers:2}');
                assert(ctx.resultOf('parallel-parallel.zip').structuredContent?.summary?.parallel?.requested === true, 'parallel-parallel.zip', 'summary.parallel.requested should be true');
            },
        },
        {
            // `stream: true` routes a sandbox file through addStream(), i.e. the
            // data-descriptor layout (flag bit 3, permitted by ISO 21320-1).
            file: 'streaming-descriptor.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: 'streamed.bin', sourcePath: 'inputs/streamed.bin', stream: true }, { name: 'streamed-text.txt', sourcePath: 'inputs/streamed.txt', stream: true }] },
            note: 'addStream entries — every entry carries a data descriptor (needs the sandbox)',
            produce: async (ctx, entry) => {
                await ctx.sandboxFile('inputs/streamed.bin', PATTERN);
                await ctx.sandboxFile('inputs/streamed.txt', te.encode(LARGE));
                return archive(ctx, entry.tool, entry.arguments);
            },
            after: async (bytes, ctx) => {
                const rows = await entryRows(ctx, bytes);
                assert(rows.length === 2, 'streaming-descriptor.zip', `expected 2 entries, got ${rows.length}`);
                const missing = rows.filter((e) => e.usesDataDescriptor !== true).map((e) => e.name);
                assert(missing.length === 0, 'streaming-descriptor.zip', `stream:true entries without a data descriptor: ${missing.join(', ')}`);
                assert(ctx.resultOf('streaming-descriptor.zip').structuredContent?.summary?.streamedCount === 2, 'streaming-descriptor.zip', 'summary.streamedCount should be 2');
            },
        },
        {
            file: 'incremental-original.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: 'config.json', text: '{ "version": 1 }\n' }, { name: 'data/large.txt', text: LARGE }, { name: 'obsolete.log', text: REMANENT }] },
            note: 'base archive for the modify_zip samples',
        },
        {
            file: 'incremental-appended.zip',
            tool: 'modify_zip',
            arguments: {
                zipBase64: '<bytes of incremental-original.zip>',
                operations: [
                    { op: 'replace', name: 'config.json', text: '{ "version": 2, "features": ["incremental", "compact"] }\n' },
                    { op: 'add', name: 'CHANGES.md', text: '# Changes\n\n- config.json bumped to v2\n- obsolete.log removed\n' },
                    { op: 'remove', name: 'obsolete.log' },
                ],
                mode: 'append',
            },
            note: "mode 'append' — original bytes kept as prefix, removed payload still present (remanence)",
            produce: (ctx, entry) => archive(ctx, entry.tool, { ...entry.arguments, zipBase64: b64(ctx.get('incremental-original.zip')) }),
            after: (bytes, ctx) => {
                const original = ctx.get('incremental-original.zip');
                assert(equal(bytes.subarray(0, original.length), original), 'incremental-appended.zip', 'append-mode modify_zip did not keep the original bytes as its prefix');
                assert(Buffer.from(bytes).includes(REMANENT.trim()), 'incremental-appended.zip', 'append-mode output no longer contains the removed payload — remanence contract changed');
            },
        },
        {
            file: 'incremental-compacted.zip',
            tool: 'modify_zip',
            arguments: {
                zipBase64: '<bytes of incremental-original.zip>',
                operations: [
                    { op: 'replace', name: 'config.json', text: '{ "version": 2, "features": ["incremental", "compact"] }\n' },
                    { op: 'add', name: 'CHANGES.md', text: '# Changes\n\n- config.json bumped to v2\n- obsolete.log removed\n' },
                    { op: 'remove', name: 'obsolete.log' },
                ],
                mode: 'compact',
            },
            note: "mode 'compact' — removed payload truly gone",
            produce: (ctx, entry) => archive(ctx, entry.tool, { ...entry.arguments, zipBase64: b64(ctx.get('incremental-original.zip')) }),
            after: async (bytes, ctx) => {
                assert(!Buffer.from(bytes).includes(REMANENT.trim()), 'incremental-compacted.zip', 'compact output still contains the removed payload (REMANENT-LOG-CONTENT)');
                const names = await entryNames(ctx, bytes);
                assert(!names.includes('obsolete.log') && names.includes('CHANGES.md'), 'incremental-compacted.zip', `unexpected entry list: ${names.join(',')}`);
            },
        },
        {
            file: 'incremental-rename-only.zip',
            tool: 'modify_zip',
            arguments: { zipBase64: '<bytes of incremental-original.zip>', operations: [{ op: 'rename', from: 'config.json', to: 'config/v1.json' }] },
            note: 'rename without touching any payload',
            produce: (ctx, entry) => archive(ctx, entry.tool, { ...entry.arguments, zipBase64: b64(ctx.get('incremental-original.zip')) }),
            after: async (bytes, ctx) => {
                const names = await entryNames(ctx, bytes);
                assert(names.includes('config/v1.json') && !names.includes('config.json'), 'incremental-rename-only.zip', `rename not reflected: ${names.join(',')}`);
            },
        },
        {
            file: 'edge-empty-entries.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: 'empty.txt', text: '' }, { name: 'empty-dir', directory: true }, { name: 'nonempty.txt', text: 'x\n' }] },
            note: 'zero-length file + empty directory',
        },
        {
            file: 'edge-high-ratio.zip',
            tool: 'create_zip',
            arguments: { entries: [{ name: 'zeros.bin', dataBase64: b64(new Uint8Array(1024 * 1024)) }, { name: 'small.txt', text: 'x' }] },
            verifyArguments: { limits: { maxCompressionRatio: 2048 } },
            note: '1 MiB of zeros — ratio ≈ 1000:1 (verify_zip with maxCompressionRatio 2048)',
        },
        {
            // create_zip → prepend an SFX-style stub (stored offsets become
            // base-relative) → modify_zip setComment so the EOCD is re-anchored by
            // the server, which keeps the stub verbatim (append-only save): the
            // file starts with the stub, not with PK (`prefixed: true`). 7-Zip's
            // CLI refuses archives it must open with an offset (documented upstream).
            file: 'edge-sfx-prefixed.zip',
            producedBy: 'tool+crafted',
            tool: 'modify_zip',
            arguments: { zipBase64: '<SFX stub + create_zip bytes>', operations: [{ op: 'setComment', comment: 'sfx sample' }] },
            prefixed: true,
            integrityExclude: ['7z'],
            note: 'SFX stub kept in front of the archive (prefixed: true)',
            produce: async (ctx, entry) => {
                const { bytes: plain } = await archive(ctx, 'create_zip', { entries: TEXT_ENTRIES });
                const stubbed = new Uint8Array(SFX_STUB.length + plain.length);
                stubbed.set(SFX_STUB, 0);
                stubbed.set(plain, SFX_STUB.length);
                return archive(ctx, entry.tool, { ...entry.arguments, zipBase64: b64(stubbed) });
            },
            after: (bytes, ctx) => {
                assert(equal(bytes.subarray(0, SFX_STUB.length), SFX_STUB), 'edge-sfx-prefixed.zip', 'the SFX stub was not preserved in front of the archive');
                const codes = (ctx.resultOf('edge-sfx-prefixed.zip').structuredContent?.diagnostics ?? []).map((d) => d.code);
                assert(codes.includes('ZIP_PREPENDED_DATA'), 'edge-sfx-prefixed.zip', `modify_zip emitted no ZIP_PREPENDED_DATA diagnostic (got ${codes.join(', ') || 'none'})`);
            },
        },
        {
            file: 'file-mode-sandbox.zip',
            tool: 'create_zip',
            arguments: { entries: MIXED_ENTRIES, outputMode: 'file', outputPath: 'out/file-mode-sandbox.zip' },
            note: "outputMode 'file' (streamed to the sandbox) — byte-identical to base64 mode",
            produce: async (ctx, entry) => {
                const result = await ok(ctx, entry.tool, entry.arguments);
                const filePath = result.structuredContent?.filePath;
                if (typeof filePath !== 'string') throw new Error('create_zip (file mode): no filePath in structuredContent.');
                const link = (result.content ?? []).find((c) => c.type === 'resource_link');
                if (link === undefined || !String(link.uri).startsWith('zipnative://output/')) throw new Error('create_zip (file mode): no zipnative://output/ resource_link in the result.');
                const bytes = new Uint8Array(await fs.readFile(filePath));
                return { bytes, result };
            },
            after: async (bytes, ctx) => {
                const { bytes: inline } = await archive(ctx, 'create_zip', { entries: MIXED_ENTRIES });
                assert(equal(bytes, inline), 'file-mode-sandbox.zip', 'file-mode bytes differ from base64-mode bytes for the same call');
            },
        },

        // ── Crafted (raw builder), conformant ──────────────────────────
        {
            file: 'zip64-forced.zip',
            producedBy: 'crafted',
            note: 'zip64 EOCD + locator forced on a tiny archive (ZIP64 version 1 is permitted)',
            produce: () => buildRawZip([
                { name: 'first.txt', data: te.encode('zip64 EOCD + locator forced on a tiny archive\n'), method: 8, versionNeeded: 45 },
                { name: 'second.bin', data: Uint8Array.from({ length: 64 }, (_, i) => i), versionNeeded: 45 },
            ], { forceZip64: true }),
            after: async (bytes, ctx) => {
                const report = await structured(ctx, 'inspect_zip', { zipBase64: b64(bytes) });
                assert(report.isZip64 === true, 'zip64-forced.zip', 'inspect_zip reports isZip64 false');
            },
        },
        // ISO-conformant but hostile: spec-valid does not mean safe. The
        // validator accepts them; the server must refuse them with the named code.
        {
            file: 'hostile-zip-slip.zip',
            producedBy: 'crafted',
            refusedBy: REFUSE.zipSlip,
            note: "'../' name escapes the extraction root (CWE-22)",
            produce: () => buildRawZip([
                { name: '../evil.txt', data: te.encode('escapes the extraction root\n') },
                { name: 'ok.txt', data: te.encode('benign sibling\n') },
            ]),
        },
        {
            file: 'hostile-device-name.zip',
            producedBy: 'crafted',
            refusedBy: REFUSE.deviceName,
            note: 'reserved DOS device name (CWE-67)',
            produce: () => buildRawZip([
                { name: 'aux.txt', data: te.encode('reserved DOS device name\n') },
                { name: 'ok.txt', data: te.encode('benign sibling\n') },
            ]),
        },
        {
            file: 'hostile-duplicate-paths.zip',
            producedBy: 'crafted',
            refusedBy: REFUSE.duplicatePaths,
            note: 'two entries mapping to the same sanitized path (CWE-694)',
            produce: () => buildRawZip([
                { name: 'same.txt', data: te.encode('first\n') },
                { name: './same.txt', data: te.encode('second\n') },
            ]),
        },
        {
            file: 'hostile-symlink.zip',
            producedBy: 'crafted',
            refusedBy: REFUSE.symlink,
            note: 'symlink entry (S_IFLNK external attributes, CWE-59)',
            produce: () => buildRawZip([
                { name: 'link', data: te.encode('/etc/passwd'), externalAttributes: (0o120777 << 16) >>> 0 },
                { name: 'ok.txt', data: te.encode('benign sibling\n') },
            ]),
        },

        // ── Crafted negatives: the validator MUST reject with the named check ─
        {
            file: 'neg-overlap.zip',
            producedBy: 'crafted',
            expectConformant: false,
            expectedCheck: 'WF/ENTRY-OVERLAP',
            refusedBy: REFUSE.overlap,
            note: 'two central records point at the same local header',
            produce: () => buildRawZip([
                { name: 'one.txt', data: te.encode('first payload\n') },
                { name: 'two.txt', data: te.encode('second payload\n'), localHeaderOffsetOverride: 0 },
            ]),
        },
        {
            file: 'neg-cd-mismatch.zip',
            producedBy: 'crafted',
            expectConformant: false,
            expectedCheck: 'WF/CD-COUNT',
            refusedBy: REFUSE.cdMismatch,
            note: 'EOCD declares 9 entries, the central directory holds 2',
            produce: () => buildRawZip([
                { name: 'one.txt', data: te.encode('first payload\n') },
                { name: 'two.txt', data: te.encode('second payload\n') },
            ], { totalEntriesOverride: 9 }),
        },
        {
            file: 'neg-declared-bomb.zip',
            producedBy: 'crafted',
            expectConformant: false,
            expectedCheck: 'WF/LFH-SIZE-MISMATCH',
            refusedBy: REFUSE.declaredBomb,
            note: 'central directory declares 2 GiB for a 4-byte stored payload',
            produce: () => buildRawZip([
                { name: 'bomb.bin', data: te.encode('tiny'), uncompressedSizeOverride: 2 * 1024 * 1024 * 1024 },
            ]),
        },
        {
            file: 'neg-lfh-name-mismatch.zip',
            producedBy: 'crafted',
            expectConformant: false,
            expectedCheck: 'WF/LFH-NAME-MISMATCH',
            note: 'local header carries a different name — not refused, ZIP_NAME_MISMATCH diagnostic only',
            produce: () => buildRawZip([
                { name: 'central.txt', data: te.encode('the local header says otherwise\n'), lfhNameOverride: te.encode('locally.txt') },
            ]),
            after: async (bytes, ctx) => {
                const report = await structured(ctx, 'verify_zip', { zipBase64: b64(bytes) });
                assert(report.ok === true && report.error === null, 'neg-lfh-name-mismatch.zip', `verify_zip no longer accepts the archive (ok=${report.ok}, error=${JSON.stringify(report.error)}) — the refusal contract changed; record it as refusedBy`);
                const codes = (report.diagnostics ?? []).map((d) => d.code);
                assert(codes.includes('ZIP_NAME_MISMATCH'), 'neg-lfh-name-mismatch.zip', `verify_zip emitted no ZIP_NAME_MISMATCH diagnostic (got ${codes.join(', ') || 'none'})`);
            },
        },
    ];

    return raw.map((e) => ({
        file: e.file,
        producedBy: e.producedBy ?? (e.tool !== undefined ? 'tool' : 'crafted'),
        tool: e.tool ?? null,
        arguments: e.arguments !== undefined ? recorded(e.arguments) : null,
        expectConformant: e.expectConformant !== false,
        expectedCheck: e.expectedCheck ?? null,
        refusedBy: e.refusedBy ?? null,
        integrityExclude: e.integrityExclude ?? [],
        prefixed: e.prefixed === true,
        note: e.note ?? '',
        scriptOnly: e.scriptOnly === true,
        verifyArguments: e.verifyArguments ?? {},
        // `produce` sees the ORIGINAL arguments (payloads intact); `arguments`
        // above is the manifest copy with long strings abbreviated.
        produce: e.produce !== undefined
            ? (ctx, entry) => e.produce(ctx, { ...entry, arguments: e.arguments ?? null })
            : (ctx, entry) => archive(ctx, entry.tool, e.arguments),
        after: e.after,
    }));
}

/** Corpus counts for docs/data/verazip.json (`hostileConformant` ⊆ `conformant`). */
export function corpusCounts(entries) {
    const conformant = entries.filter((e) => e.expectConformant);
    return {
        conformant: conformant.length,
        nonConformant: entries.length - conformant.length,
        hostileConformant: conformant.filter((e) => e.refusedBy !== null).length,
    };
}

/**
 * Execution context shared by the entries: produced bytes and tool results by
 * file name, plus the sandbox writer for file-mode inputs.
 */
export function createContext({ call, sandboxDir }) {
    const bytes = new Map();
    const results = new Map();
    return {
        call,
        sandboxDir,
        get: (file) => {
            const b = bytes.get(file);
            if (b === undefined) throw new Error(`${file}: not produced yet (corpus order matters)`);
            return b;
        },
        set: (file, b, result) => {
            bytes.set(file, b);
            if (result !== undefined) results.set(file, result);
        },
        resultOf: (file) => results.get(file) ?? {},
        /** Write a file inside the sandbox (relative path) and return that relative path. */
        sandboxFile: async (relative, data) => {
            if (sandboxDir === null || sandboxDir === undefined) throw new Error(`sandbox required to write ${relative} (set sandboxDir)`);
            const abs = join(sandboxDir, ...relative.split('/'));
            await fs.mkdir(dirname(abs), { recursive: true });
            await fs.writeFile(abs, data);
            return relative;
        },
    };
}

/** Produce one entry's bytes (running `after`), register them in `ctx`, and return them. */
export async function produceEntry(entry, ctx) {
    const produced = await entry.produce(ctx, entry);
    const bytes = produced instanceof Uint8Array ? produced : produced.bytes;
    const result = produced instanceof Uint8Array ? undefined : produced.result;
    ctx.set(entry.file, bytes, result);
    // Sanity: written bytes must at least start like a ZIP — at offset 0, or
    // (SFX-prefixed sample) a local-file-header signature right after the stub.
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sigAt = entry.prefixed ? buf.indexOf(Buffer.from('PK\x03\x04', 'latin1')) : 0;
    assert(entry.prefixed ? sigAt > 0 : buf.subarray(0, 2).equals(Buffer.from('PK', 'ascii')), entry.file, entry.prefixed ? 'output has no local-file-header signature after the SFX stub.' : 'output does not start with PK.');
    if (entry.after !== undefined) await entry.after(bytes, ctx);
    return bytes;
}

/** `verify_zip` must report `ok: true` for every tool-produced conformant archive. Throws otherwise. */
export async function assertVerified(entry, bytes, ctx) {
    const report = await structured(ctx, 'verify_zip', { zipBase64: b64(bytes), entries: 'failed', ...entry.verifyArguments });
    if (report.ok !== true) {
        const detail = report.error !== null && report.error !== undefined ? `[${report.error.code}] ${report.error.message}` : `${report.failedCount} failed entr${report.failedCount === 1 ? 'y' : 'ies'}: ${(report.entries ?? []).map((e) => e.name).join(', ')}`;
        throw new Error(`${entry.file}: verify_zip is not ok — ${detail}`);
    }
    return report;
}

/** The `refusedBy` tool must refuse the bytes with `[code]` in its error text. Throws otherwise. */
export async function assertRefused(entry, bytes, ctx) {
    const { tool, code, arguments: extra } = entry.refusedBy;
    const args = { zipBase64: b64(bytes), ...(tool === 'extract_zip' ? { includeData: false } : {}), ...(extra ?? {}) };
    const result = await ctx.call(tool, args);
    const text = errorText(result);
    const observed = result._meta?.error?.code ?? null;
    if (result.isError !== true || observed !== code || !text.includes(`[${code}]`)) {
        throw new Error(`${entry.file}: expected ${tool} to refuse with ${code}, observed ${result.isError === true ? `[${observed ?? '?'}] ${text}` : 'success'}`);
    }
    return { tool, code, text };
}
