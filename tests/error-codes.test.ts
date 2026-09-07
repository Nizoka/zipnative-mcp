/**
 * Error-code inventory: every `ToolError('CODE', …)` literal in `src/` must be
 * (a) documented in the AGENTS.md error table and (b) exercised by at least
 * one test under `tests/`; and every one of the engine's 39 frozen `ZIP_*`
 * codes (passed through verbatim by `src/zip-errors.ts`) must either be named
 * by a test that reaches it or be listed in `UNREACHABLE_THROUGH_WRAPPER` with
 * the reason. The second half of this file adds the targeted tests for codes
 * that no tool suite reached before.
 */
import { existsSync, readdirSync, readFileSync, statSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ZipDataError, ZipLimitError, ZipSecurityError, ZipUnsupportedError } from 'zipnative';

import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_ENTRY_INLINE_BYTES, __resetCeilingsForTests } from '../src/caps.js';
import { GovernanceError, SecurityError, ToolError } from '../src/errors.js';
import { resolveCallLimits } from '../src/limits.js';
import { emitArchive, emitArchiveStream, writeSandboxedText } from '../src/output.js';
import { readResource } from '../src/resources.js';
import { resolveInputFile, resolveOutputFile } from '../src/sandbox.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { guard, guardAsync, mapZipError, ZIP_ERROR_CLASS, ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip, bytesOf, CD_MISMATCH, CORRUPT_DEFLATE, CRC_OVERRIDE, DEVICE_NAME, DUPLICATE_PATHS, ENCRYPTED_FLAG, highRatioZip, LFH_METHOD_MISMATCH, MULTI_DISK, OVERLAP, raw, SFX_PREFIXED, STORE_DESCRIPTOR, SYMLINK, TRAILING_GARBAGE, truncated, UNKNOWN_METHOD, ZIP64_CONTRADICTION, ZIP64_DROPPED, ZIP64_HUGE_COUNT, ZIP_SLIP } from './_zip-fixtures.js';

/** The documented `data.remedy` vocabulary (docs/API_STABILITY.md §2, AGENTS.md §6). */
const REMEDY_VOCABULARY = ["outputMode:'file'", 'range', 'filter', "encoding:'base64'", "data:'verify'", 'list_zip_entries', 'resources/list'] as const;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = path.join(ROOT, 'AGENTS.md');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
}

/** Every `ToolError('CODE'` / `ToolError(\n 'CODE'` literal under src/, de-duplicated. */
function collectSourceCodes(): string[] {
    const codes = new Set<string>();
    for (const file of walk(path.join(ROOT, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/ToolError\(\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1]!);
    }
    // Subclasses with a fixed code (SecurityError / GovernanceError) pass it through `super(...)`.
    const errors = readFileSync(path.join(ROOT, 'src', 'errors.ts'), 'utf8');
    for (const m of errors.matchAll(/super\(\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1]!);
    return [...codes].sort();
}

/** The wrapper's own vocabulary (AGENTS.md §6) — everything the server can raise that is not a frozen ZIP_* code. */
const WRAPPER_CODES = [
    'VALIDATION_ERROR', 'INPUT_TOO_LARGE', 'INPUT_NOT_FOUND', 'ENTRY_TOO_LARGE', 'ENTRY_NOT_UTF8', 'OUTPUT_TOO_LARGE', 'OUTPUT_EXISTS',
    'IO_ERROR', 'SECURITY_VIOLATION', 'MISSING_OUTPUT_PATH', 'INVALID_PATH', 'INVALID_EXTENSION', 'LIMIT_CEILING_EXCEEDED', 'UNKNOWN_RESOURCE',
    'GOVERNANCE_VIOLATION', 'ENGINE_ERROR',
] as const;

/**
 * Frozen engine codes no input can make this wrapper emit, with the reason.
 * Every other ZIP_* code must be named by a test that reaches it.
 */
const UNREACHABLE_THROUGH_WRAPPER: Readonly<Record<string, string>> = {
    // B-008 (corrected reason): the engine raises it for compression.level / chunkSize out of range (both bounded by Zod →
    // VALIDATION_ERROR), for an extra-field block above 65535 bytes (limits.maxExtraFieldBytes ≤ 65535 by schema fires FIRST as
    // ZIP_LIMIT_EXCEEDED) and for a '/'-terminated name carrying a payload on the modify path — refused earlier by the shared
    // refineEntryPayload Zod refinement since B-011 (VALIDATION_ERROR on create_zip and modify_zip alike).
    ZIP_INVALID_OPTION: 'every engine path that raises it is pre-empted: level / chunkSize bounds and the directory-with-payload shape are Zod VALIDATION_ERRORs, an oversized extra block trips limits.maxExtraFieldBytes first',
    ZIP_INPUT_TOO_LARGE: 'the server caps (128 MiB decoded base64, 1 GiB zipPath) sit below the engine 2 GiB bound, so INPUT_TOO_LARGE fires first',
    ZIP_API_MISUSE: 'the wrapper always drains iterators and never re-enters a writer after toBytes(); it is the engine guarding its own callers',
    ZIP_INTERNAL: 'an engine invariant failure; no input reaches it',
    ZIP_LIMIT_INVALID: 'the limits shape is validated by Zod (integers ≥ 1) before resolveCallLimits merges it, so the engine never sees an invalid bound',
    ZIP_UNSUPPORTED_ZIP64_STREAMING: 'needs a > 4 GiB streamed entry (stream:true on a sourcePath), above the practical test envelope',
    ZIP_UNSUPPORTED_CODEC_MODE: 'needs a registered codec without a synchronous decompressor; this server registers none beyond store / deflate, so ZIP_UNSUPPORTED_METHOD fires first',
};

describe('ToolError code inventory', () => {
    const codes = collectSourceCodes();
    const tests = walk(path.join(ROOT, 'tests'))
        .filter((f) => !f.endsWith('error-codes.test.ts'))
        .map((f) => ({ file: path.basename(f), text: readFileSync(f, 'utf8') }));
    const thisFile = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const targeted = thisFile.slice(thisFile.indexOf("describe('previously uncovered codes"));

    it('finds the wrapper vocabulary plus the ZIP_* literals the tools raise themselves', () => {
        expect(codes.length).toBeGreaterThanOrEqual(WRAPPER_CODES.length);
        for (const c of WRAPPER_CODES) expect(codes, c).toContain(c);
        // Every non-wrapper literal is one of the engine's frozen codes (never an invented one).
        for (const c of codes) {
            if (!(WRAPPER_CODES as readonly string[]).includes(c)) expect(ZIP_ERROR_CODES as readonly string[], `${c} is neither a wrapper code nor a frozen ZIP_* code`).toContain(c);
        }
    });

    it.skipIf(!existsSync(AGENTS))('documents every code in the AGENTS.md error table', () => {
        const agents = readFileSync(AGENTS, 'utf8');
        const missing = [...new Set([...codes, ...WRAPPER_CODES, ...ZIP_ERROR_CODES])].filter((c) => !agents.includes(`\`${c}\``));
        expect(missing, `codes missing from AGENTS.md error table: ${missing.join(', ')}`).toEqual([]);
    });

    it('exercises every wrapper code in at least one test under tests/', () => {
        // The targeted tests below count too, but only their describe/it bodies — not this
        // inventory list. A ZIP_* literal the tools raise defensively may instead be declared unreachable.
        const missing = codes.filter((c) => !tests.some((t) => t.text.includes(c)) && !targeted.includes(c) && !(c in UNREACHABLE_THROUGH_WRAPPER));
        expect(missing, `codes without a test that names them: ${missing.join(', ')}`).toEqual([]);
    });

    it('every frozen ZIP_* code is either reached by a test or declared unreachable with a reason', () => {
        expect(ZIP_ERROR_CODES).toHaveLength(39);
        expect(Object.keys(ZIP_ERROR_CLASS)).toEqual([...ZIP_ERROR_CODES]);
        const named = (c: string): boolean => tests.some((t) => t.text.includes(c)) || targeted.includes(c);
        const missing = ZIP_ERROR_CODES.filter((c) => !named(c) && !(c in UNREACHABLE_THROUGH_WRAPPER));
        expect(missing, `ZIP_* codes neither named by a test nor declared unreachable: ${missing.join(', ')}`).toEqual([]);
        // The unreachable list must not hide a code a test actually reaches.
        const contradicted = Object.keys(UNREACHABLE_THROUGH_WRAPPER).filter((c) => targeted.includes(`code).toBe('${c}')`));
        expect(contradicted).toEqual([]);
        for (const [code, reason] of Object.entries(UNREACHABLE_THROUGH_WRAPPER)) {
            expect(ZIP_ERROR_CODES as readonly string[], code).toContain(code);
            expect(reason.length, code).toBeGreaterThan(20);
        }
    });
});

/* -------------------------------------------------------------------------- */
/* Targeted tests for codes no tool suite reached before                      */
/* -------------------------------------------------------------------------- */

async function codeOf(p: Promise<unknown>): Promise<ToolError> {
    try {
        await p;
    } catch (err) {
        if (err instanceof ToolError) return err;
        throw err;
    }
    throw new Error('expected the call to reject');
}

async function refusal(tool: string, args: Record<string, unknown>): Promise<{ code: string; message: string; data: Record<string, unknown> | undefined }> {
    const r = await callToolDirect(tool, args);
    expect(r.isError, `${tool} should refuse: ${String(JSON.stringify(r.structuredContent)).slice(0, 200)}`).toBe(true);
    const err = (r._meta as { error: { code: string; message: string; data?: Record<string, unknown> } }).error;
    expect((r.content[0] as { text: string }).text).toBe(`${tool} failed [${err.code}]: ${err.message}`);
    return { code: err.code, message: err.message, data: err.data };
}

describe('previously uncovered codes', () => {
    const SANDBOX_ENV = 'ZIPNATIVE_MCP_OUTPUT_DIR';
    let sandboxDir: string;

    beforeAll(async () => {
        await ensureEngineReady();
    });
    afterEach(async () => {
        delete process.env[SANDBOX_ENV];
        delete process.env['ZIPNATIVE_MCP_MAX_ENTRIES'];
        delete process.env['ZIPNATIVE_MCP_WORKERS'];
        __resetCeilingsForTests();
        if (sandboxDir !== undefined) await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    async function enableSandbox(): Promise<string> {
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-codes-'));
        process.env[SANDBOX_ENV] = sandboxDir;
        return sandboxDir;
    }

    it("MISSING_OUTPUT_PATH: outputMode='file' without outputPath / outputDir, through the output layer and every file-writing tool", async () => {
        await enableSandbox();
        expect((await codeOf(emitArchive(new Uint8Array([1]), { mode: 'file' }))).code).toBe('MISSING_OUTPUT_PATH');
        expect((await codeOf(emitArchiveStream((async function* () { yield new Uint8Array(1); })(), undefined))).code).toBe('MISSING_OUTPUT_PATH');
        // The Zod layer leaves outputPath optional, so the tool / output layer reports it.
        expect((await refusal('create_zip', { entries: [{ name: 'a', text: 'a' }], outputMode: 'file' })).code).toBe('MISSING_OUTPUT_PATH');
        expect((await refusal('modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'setComment', comment: 'x' }], outputMode: 'file' })).code).toBe('MISSING_OUTPUT_PATH');
        expect((await refusal('inflate_raw', { dataBase64: b64(deflateRawSync(Buffer.from('x'))), maxOutput: 10, outputMode: 'file' })).code).toBe('MISSING_OUTPUT_PATH');
        expect((await refusal('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file' })).message).toContain('outputDir is required');
        expect((await refusal('draft_governance_issue', { title: 'Something is wrong here', summary: 'A summary long enough to pass.', issueType: 'docs', reproduction: { command: 'x', result: 'y' }, expectedBehavior: 'better', duplicateSearchPerformed: true, outputMode: 'file' })).code).toBe('MISSING_OUTPUT_PATH');
    });

    it('INVALID_PATH: an empty outputPath inside an enabled sandbox', async () => {
        await enableSandbox();
        let code: string | undefined;
        try {
            resolveOutputFile('');
        } catch (err) {
            code = err instanceof ToolError ? err.code : 'other';
        }
        expect(code).toBe('INVALID_PATH');
        expect((await codeOf(resolveInputFile('', null))).code).toBe('INVALID_PATH');
    });

    it('INVALID_EXTENSION / OUTPUT_EXISTS / IO_ERROR: the file-output guards through the tools', async () => {
        await enableSandbox();
        const entries = [{ name: 'a.txt', text: 'a' }];
        expect((await refusal('create_zip', { entries, outputMode: 'file', outputPath: 'out.tar' })).code).toBe('INVALID_EXTENSION');
        expect((await refusal('inspect_zip', { zipPath: 'notes.txt' })).code).toBe('INVALID_EXTENSION');
        const first = await callToolDirect('create_zip', { entries, outputMode: 'file', outputPath: 'once.zip' });
        expect(first.isError).not.toBe(true);
        const second = await refusal('create_zip', { entries, outputMode: 'file', outputPath: 'once.zip' });
        expect(second.code).toBe('OUTPUT_EXISTS');
        expect(second.data).toEqual({ path: 'once.zip' });
        // extract_zip never overwrites either: the second extraction into the same directory collides on the first file.
        const ex1 = await callToolDirect('extract_zip', { zipPath: 'once.zip', outputMode: 'file', outputDir: 'unpacked' });
        expect(ex1.isError).not.toBe(true);
        expect((await refusal('extract_zip', { zipPath: 'once.zip', outputMode: 'file', outputDir: 'unpacked' })).code).toBe('OUTPUT_EXISTS');
        // IO_ERROR: a name the filesystem refuses (win32: '<' is illegal; POSIX: a 300-byte name is ENAMETOOLONG).
        const bad = process.platform === 'win32' ? 'bad<name>.zip' : `${'a'.repeat(300)}.zip`;
        const io = await refusal('create_zip', { entries, outputMode: 'file', outputPath: bad });
        expect(io.code).toBe('IO_ERROR');
        expect(io.message).not.toContain(sandboxDir);
        expect((await refusal('modify_zip', { zipPath: 'once.zip', operations: [{ op: 'setComment', comment: 'x' }], outputMode: 'file', outputPath: bad })).code).toBe('IO_ERROR');
    });

    it('INPUT_NOT_FOUND: a missing zipPath / sourcePath (relative label only, never the absolute path)', async () => {
        await enableSandbox();
        for (const [tool, args] of [
            ['inspect_zip', { zipPath: 'missing.zip' }],
            ['scan_zip_forward', { zipPath: 'missing.zip' }],
            ['compute_crc32', { sourcePath: 'missing.bin' }],
            ['inflate_raw', { sourcePath: 'missing.bin', maxOutput: 10 }],
            ['create_zip', { entries: [{ name: 'a', sourcePath: 'missing.bin' }] }],
            ['create_zip', { entries: [{ name: 'a', sourcePath: 'missing.bin', stream: true }] }],
        ] as const) {
            const err = await refusal(tool, args);
            expect(err.code, tool).toBe('INPUT_NOT_FOUND');
            expect(err.message, tool).not.toContain(sandboxDir);
            expect(err.data?.['path'], tool).toMatch(/^missing\./);
        }
    });

    it('INPUT_TOO_LARGE: the byte caps (unit-tested through assertInputWithin; the tools call it with their own cap)', () => {
        expect(() => assertInputWithin(MAX_BASE64_INPUT_BYTES, MAX_BASE64_INPUT_BYTES, 'zipBase64 (decoded)')).not.toThrow();
        let err: ToolError | undefined;
        try {
            assertInputWithin(MAX_BASE64_INPUT_BYTES + 1, MAX_BASE64_INPUT_BYTES, 'zipBase64 (decoded)');
        } catch (e) {
            err = e as ToolError;
        }
        expect(err?.code).toBe('INPUT_TOO_LARGE');
        expect(err?.message).toContain(`${MAX_BASE64_INPUT_BYTES}-byte cap`);
        expect(err?.data).toEqual({ what: 'zipBase64 (decoded)', observed: MAX_BASE64_INPUT_BYTES + 1, cap: MAX_BASE64_INPUT_BYTES, remedy: 'zipPath' });
    });

    it('ENTRY_NOT_UTF8: reading binary content as text names the remedy', async () => {
        const zip = raw([{ name: 'bin.dat', data: new Uint8Array([0xff, 0xfe, 0x00, 0xc3]) }]);
        const err = await refusal('read_zip_entry', { zipBase64: b64(zip), name: 'bin.dat', encoding: 'utf8' });
        expect(err.code).toBe('ENTRY_NOT_UTF8');
        expect(err.data).toEqual({ entryName: 'bin.dat', remedy: "encoding:'base64'" });
        // The same bytes are fine as base64.
        const ok = await callToolDirect('read_zip_entry', { zipBase64: b64(zip), name: 'bin.dat' });
        expect((ok.structuredContent as { dataBase64: string }).dataBase64).toBe('//4Aww==');
    });

    it('ENTRY_TOO_LARGE: an entry declared above the 16 MiB inline cap (read_zip_entry, extract_zip, scan_zip_forward include; a range still works)', async () => {
        // A real 17 MiB zeros entry (the raw builder deflates it to a few KiB).
        const big = raw([{ name: 'big', data: new Uint8Array(17 * 1024 * 1024), method: 8 }]);
        const zipBase64 = b64(big);
        // Zeros deflate past the engine's default 1024:1 ratio guard: raise it (trusted input) so the wrapper cap is what fires.
        const limits = { maxCompressionRatio: 4096 };
        const read = await refusal('read_zip_entry', { zipBase64, name: 'big', limits });
        expect(read.code).toBe('ENTRY_TOO_LARGE');
        expect(read.data).toMatchObject({ entryName: 'big', sizeBytes: 17 * 1024 * 1024, cap: MAX_ENTRY_INLINE_BYTES, remedy: 'range' });
        expect((await refusal('extract_zip', { zipBase64, limits })).code).toBe('ENTRY_TOO_LARGE');
        expect((await refusal('scan_zip_forward', { zipBase64, data: 'include', limits })).code).toBe('ENTRY_TOO_LARGE');
        // Without the relaxation the engine's own bomb guard (the incremental ratio check while inflating) fires first.
        expect((await refusal('scan_zip_forward', { zipBase64, data: 'include' })).code).toBe('ZIP_LIMIT_EXCEEDED');
        // The plan (dry run) and a bounded window are still available.
        const plan = await callToolDirect('extract_zip', { zipBase64, includeData: false, limits });
        expect(plan.isError).not.toBe(true);
        const window = await callToolDirect('read_zip_entry', { zipBase64, name: 'big', range: { offset: 17 * 1024 * 1024 - 4, length: 16 }, limits });
        expect(window.isError).not.toBe(true);
        expect((window.structuredContent as { range: { returned: number } }).range.returned).toBe(4);
        // Raw mode caps the compressed payload instead (which is tiny here).
        const rawRead = await callToolDirect('read_zip_entry', { zipBase64, name: 'big', mode: 'raw', limits });
        expect(rawRead.isError).not.toBe(true);
    }, 60_000);

    it('OUTPUT_TOO_LARGE: extract_zip inline total cap and read_zip_entry / resources remedies', async () => {
        // Nine 4 MiB zeros entries: each is under the per-entry cap, the sum (36 MiB) is over the 32 MiB inline total.
        const chunk = new Uint8Array(4 * 1024 * 1024);
        const zip = raw(Array.from({ length: 9 }, (_, i) => ({ name: `z${i}`, data: chunk, method: 8 })));
        const limits = { maxCompressionRatio: 4096 };
        const err = await refusal('extract_zip', { zipBase64: b64(zip), limits });
        expect(err.code).toBe('OUTPUT_TOO_LARGE');
        expect(err.data).toMatchObject({ totalBytes: 36 * 1024 * 1024, remedy: "outputMode:'file'" });
        const scan = await refusal('scan_zip_forward', { zipBase64: b64(zip), data: 'include', limits });
        expect(scan.code).toBe('OUTPUT_TOO_LARGE');
        // A filter keeps the call under the cap.
        const filtered = await callToolDirect('extract_zip', { zipBase64: b64(zip), filter: { names: ['z0', 'z1'] }, limits });
        expect(filtered.isError, JSON.stringify(filtered.content[0])).not.toBe(true);
    }, 60_000);

    it('LIMIT_CEILING_EXCEEDED: per-call limits, scan maxEntries and parallel workers above the operator ceilings name the variable', async () => {
        process.env['ZIPNATIVE_MCP_MAX_ENTRIES'] = '10';
        process.env['ZIPNATIVE_MCP_WORKERS'] = '0';
        __resetCeilingsForTests();
        const zipBase64 = b64(basicZip());
        const limits = await refusal('inspect_zip', { zipBase64, limits: { maxEntries: 11 } });
        expect(limits.code).toBe('LIMIT_CEILING_EXCEEDED');
        expect(limits.data).toEqual({ limit: 'maxEntries', requested: 11, ceiling: 10, env: 'ZIPNATIVE_MCP_MAX_ENTRIES' });
        expect(limits.message).toContain('ZIPNATIVE_MCP_MAX_ENTRIES');
        expect((await refusal('verify_zip', { zipBase64, limits: { maxEntryUncompressedSize: 2 ** 40 } })).data).toMatchObject({ env: 'ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES' });
        expect((await refusal('scan_zip_forward', { zipBase64, maxEntries: 11 })).code).toBe('LIMIT_CEILING_EXCEEDED');
        expect((await refusal('create_zip', { entries: [{ name: 'a', text: 'a' }], parallel: { workers: 1 } })).data).toMatchObject({ limit: 'workers', ceiling: 0, env: 'ZIPNATIVE_MCP_WORKERS' });
        // A ceiling below the engine default tightens the default silently.
        expect(resolveCallLimits(undefined)).toEqual({ maxEntries: 10 });
        expect(resolveCallLimits({ maxEntries: 10 })).toEqual({ maxEntries: 10 });
        __resetCeilingsForTests();
        delete process.env['ZIPNATIVE_MCP_MAX_ENTRIES'];
        expect(resolveCallLimits(undefined)).toBeUndefined();
    });

    it('UNKNOWN_RESOURCE / SECURITY_VIOLATION / GOVERNANCE_VIOLATION: the fixed-code errors', async () => {
        await enableSandbox();
        expect((await codeOf(readResource('zipnative://output/nope.zip'))).code).toBe('UNKNOWN_RESOURCE');
        expect((await codeOf(readResource('https://example.com/x.zip'))).code).toBe('UNKNOWN_RESOURCE');
        const sec = new SecurityError('boom');
        expect(sec.code).toBe('SECURITY_VIOLATION');
        expect(sec.name).toBe('SecurityError');
        expect(sec).toBeInstanceOf(ToolError);
        const gov = new GovernanceError('nope');
        expect(gov.code).toBe('GOVERNANCE_VIOLATION');
        expect(gov.name).toBe('GovernanceError');
        expect((await refusal('inspect_zip', { zipPath: '../outside.zip' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file', outputDir: '/abs' })).code).toBe('SECURITY_VIOLATION');
        expect((await codeOf(writeSandboxedText('x', 'C:\\x.md'))).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('draft_governance_issue', { title: 'Add a fast path please', summary: 'We could add `fflate` to the runtime dependencies for speed.', issueType: 'performance', reproduction: { command: 'x', result: 'y' }, expectedBehavior: 'faster', duplicateSearchPerformed: true })).code).toBe('GOVERNANCE_VIOLATION');
    });

    it('ENGINE_ERROR: mapZipError on a plain Error (and the guard helpers) — ZipError subclasses keep their frozen code and detail', async () => {
        const plain = mapZipError(new Error('unexpected'), 'Failed to frobnicate');
        expect(plain.code).toBe('ENGINE_ERROR');
        expect(plain.message).toBe('Failed to frobnicate: unexpected');
        expect(plain.data).toEqual({ errorClass: 'internal' });
        expect(mapZipError('a string', 'ctx', undefined, { operationIndex: 2 }).data).toEqual({ errorClass: 'internal', operationIndex: 2 });
        // A ToolError passes through untouched.
        const already = new ToolError('OUTPUT_EXISTS', 'x');
        expect(mapZipError(already, 'ctx')).toBe(already);
        expect(() => guard('ctx', () => { throw new Error('sync'); })).toThrow(expect.objectContaining({ code: 'ENGINE_ERROR' }));
        await expect(guardAsync('ctx', async () => { throw new Error('async'); })).rejects.toMatchObject({ code: 'ENGINE_ERROR', message: 'ctx: async' });
        expect(guard('ctx', () => 42)).toBe(42);
        // zlib errors on the node-zlib tier map to the same codes as the pure tier.
        expect(mapZipError(Object.assign(new Error('bad'), { code: 'Z_DATA_ERROR' }), 'ctx', 'e.txt').code).toBe('ZIP_DEFLATE_CORRUPT');
        expect(mapZipError(Object.assign(new Error('bad'), { code: 'Z_BUF_ERROR' }), 'ctx').data).toEqual({ errorClass: 'parse', engineError: 'ZlibError' });
        // Engine subclasses: detail extraction.
        const limit = mapZipError(new ZipLimitError('ZIP_LIMIT_EXCEEDED', 'too big', 'maxEntries', 1, 4), 'ctx');
        expect(limit.data).toEqual({ errorClass: 'limit', engineError: 'ZipLimitError', limit: 'maxEntries', configured: 1, observed: 4 });
        const inf = mapZipError(new ZipLimitError('ZIP_LIMIT_EXCEEDED', 'too big', 'maxCompressionRatio', Infinity, 9), 'ctx');
        expect(inf.data).toMatchObject({ configured: 'Infinity' });
        expect(mapZipError(new ZipUnsupportedError('ZIP_UNSUPPORTED_ENCRYPTION', 'enc', 'zipcrypto'), 'ctx').data).toEqual({ errorClass: 'unsupported', engineError: 'ZipUnsupportedError', feature: 'zipcrypto' });
        expect(mapZipError(new ZipSecurityError('ZIP_PATH_TRAVERSAL', 'slip', '../x'), 'ctx').data).toEqual({ errorClass: 'security', engineError: 'ZipSecurityError', entryName: '../x' });
        const data = mapZipError(new ZipDataError('ZIP_CRC_MISMATCH', 'crc', 'f.txt', 0xdeadbeef, 1), 'ctx');
        expect(data.data).toEqual({ errorClass: 'data', engineError: 'ZipDataError', entryName: 'f.txt', expectedCrc: 'deadbeef', actualCrc: '00000001' });
        expect(mapZipError(new ZipDataError('ZIP_SIZE_MISMATCH', 'size'), 'ctx', 'fallback.txt').data).toEqual({ errorClass: 'data', engineError: 'ZipDataError', entryName: 'fallback.txt' });
    });

    it('B-008: ZIP_VALUE_UNREPRESENTABLE and ZIP_ZIP64_CONTRADICTION are reachable with tiny raw archives (inspect_zip; verify_zip lands them in error.code)', async () => {
        const huge = await refusal('inspect_zip', { zipBase64: b64(ZIP64_HUGE_COUNT()) });
        expect(huge.code).toBe('ZIP_VALUE_UNREPRESENTABLE');
        expect(huge.data).toMatchObject({ errorClass: 'parse', engineError: 'ZipFormatError' });
        expect(huge.message).toContain('MAX_SAFE_INTEGER');
        const contradiction = await refusal('inspect_zip', { zipBase64: b64(ZIP64_CONTRADICTION()) });
        expect(contradiction.code).toBe('ZIP_ZIP64_CONTRADICTION');
        expect(contradiction.data).toMatchObject({ errorClass: 'security', engineError: 'ZipSecurityError' });
        expect(ZIP_ERROR_CLASS.ZIP_ZIP64_CONTRADICTION).toBe('security');
        // The lazy readers refuse it too (the EOCD cross-check runs before any entry is parsed).
        expect((await refusal('list_zip_entries', { zipBase64: b64(ZIP64_CONTRADICTION()) })).code).toBe('ZIP_ZIP64_CONTRADICTION');
        expect((await refusal('extract_zip', { zipBase64: b64(ZIP64_CONTRADICTION()), includeData: false })).code).toBe('ZIP_ZIP64_CONTRADICTION');
        for (const [bytes, code] of [[ZIP64_HUGE_COUNT(), 'ZIP_VALUE_UNREPRESENTABLE'], [ZIP64_CONTRADICTION(), 'ZIP_ZIP64_CONTRADICTION']] as const) {
            const verified = await callToolDirect('verify_zip', { zipBase64: b64(bytes) });
            expect(verified.isError).not.toBe(true);
            expect(verified.structuredContent).toMatchObject({ ok: false, error: { code }, entryCount: 0 });
        }
    });

    it('A-014: every ENTRY_TOO_LARGE / OUTPUT_TOO_LARGE / INPUT_NOT_FOUND refusal carries data.remedy from the documented vocabulary', async () => {
        await enableSandbox();
        const big = raw([{ name: 'big', data: new Uint8Array(17 * 1024 * 1024), method: 8 }]);
        const stored = raw([{ name: 'big', data: new Uint8Array(17 * 1024 * 1024) }]);
        const many = raw(Array.from({ length: 9 }, (_, i) => ({ name: `z${i}`, data: new Uint8Array(4 * 1024 * 1024), method: 8 })));
        const limits = { maxCompressionRatio: 4096 };
        const cases: Array<[string, Record<string, unknown>, string, string]> = [
            ['read_zip_entry', { zipBase64: b64(big), name: 'big', limits }, 'ENTRY_TOO_LARGE', 'range'],
            ['read_zip_entry', { zipBase64: b64(stored), name: 'big', mode: 'raw', limits }, 'ENTRY_TOO_LARGE', 'range'],
            ['extract_zip', { zipBase64: b64(big), limits }, 'ENTRY_TOO_LARGE', "outputMode:'file'"],
            ['extract_zip', { zipBase64: b64(many), limits }, 'OUTPUT_TOO_LARGE', "outputMode:'file'"],
            ['scan_zip_forward', { zipBase64: b64(big), data: 'include', limits }, 'ENTRY_TOO_LARGE', "data:'verify'"],
            ['scan_zip_forward', { zipBase64: b64(many), data: 'include', limits }, 'OUTPUT_TOO_LARGE', "data:'verify'"],
            ['inspect_zip', { zipPath: 'missing.zip' }, 'INPUT_NOT_FOUND', 'resources/list'],
            ['compute_crc32', { sourcePath: 'missing.bin' }, 'INPUT_NOT_FOUND', 'resources/list'],
            ['create_zip', { entries: [{ name: 'a', sourcePath: 'missing.bin' }] }, 'INPUT_NOT_FOUND', 'resources/list'],
            ['read_zip_entry', { zipBase64: b64(basicZip()), index: 9 }, 'ZIP_ENTRY_NOT_FOUND', 'list_zip_entries'],
        ];
        for (const [tool, args, code, remedy] of cases) {
            const err = await refusal(tool, args);
            expect(err.code, tool).toBe(code);
            expect(err.data?.['remedy'], `${tool} ${code}`).toBe(remedy);
            expect(REMEDY_VOCABULARY as readonly string[], `${tool}: ${String(err.data?.['remedy'])}`).toContain(err.data?.['remedy']);
        }
        // The inline output cap (emitArchive) names the file mode; the base64-decoding remedy is asserted in ENTRY_NOT_UTF8 above.
        const inline = await codeOf(emitArchive(new Uint8Array(50 * 1024 * 1024 + 1), { mode: 'base64' }));
        expect(inline.data?.['remedy']).toBe("outputMode:'file'");
    }, 90_000);

    it('ZIP_* passthrough: hostile fixtures map to their frozen code with data.errorClass', async () => {
        const one = [{ name: 'a.txt', data: bytesOf('a') }];
        const cases: Array<[string, string, Record<string, unknown>, string]> = [
            ['ZIP_PATH_TRAVERSAL', 'extract_zip', { zipBase64: b64(ZIP_SLIP()) }, 'security'],
            ['ZIP_PATH_TRAVERSAL', 'extract_zip', { zipBase64: b64(DEVICE_NAME()), includeData: false }, 'security'],
            ['ZIP_EXTRACT_DUPLICATE_PATH', 'extract_zip', { zipBase64: b64(DUPLICATE_PATHS()) }, 'security'],
            ['ZIP_SYMLINK_REJECTED', 'extract_zip', { zipBase64: b64(SYMLINK()) }, 'security'],
            ['ZIP_ENTRY_OVERLAP', 'read_zip_entry', { zipBase64: b64(OVERLAP()), index: 0 }, 'security'],
            ['ZIP_CD_LFH_MISMATCH', 'read_zip_entry', { zipBase64: b64(LFH_METHOD_MISMATCH()), index: 0 }, 'security'],
            ['ZIP_CD_INCONSISTENT', 'list_zip_entries', { zipBase64: b64(CD_MISMATCH()) }, 'parse'],
            ['ZIP_CD_INCONSISTENT', 'inspect_zip', { zipBase64: b64(raw(one, { totalEntriesOverride: 0 })) }, 'parse'],
            ['ZIP_EOCD_NOT_FOUND', 'inspect_zip', { zipBase64: b64(TRAILING_GARBAGE()) }, 'parse'],
            ['ZIP_EOCD_NOT_FOUND', 'modify_zip', { zipBase64: b64(truncated(basicZip(), 60)), operations: [{ op: 'setComment', comment: 'x' }] }, 'parse'],
            ['ZIP_EOCD_INCONSISTENT', 'inspect_zip', { zipBase64: b64(raw(one, { cdOffsetOverride: 100_000 })) }, 'parse'],
            ['ZIP_RECORD_TRUNCATED', 'inspect_zip', { zipBase64: b64(raw(one, { cdSizeOverride: 5 })) }, 'parse'],
            ['ZIP_RECORD_TRUNCATED', 'extract_zip', { zipBase64: b64(raw([{ name: 'x', data: bytesOf('x'), localHeaderOffsetOverride: 0xffffffff }])) }, 'parse'],
            ['ZIP_SIGNATURE_MISMATCH', 'inspect_zip', { zipBase64: b64(raw(one, { cdOffsetOverride: 10 })) }, 'parse'],
            ['ZIP_SIGNATURE_MISMATCH', 'scan_zip_forward', { zipBase64: b64(SFX_PREFIXED()) }, 'parse'],
            ['ZIP_ZIP64_EOCD_MISPLACED', 'inspect_zip', { zipBase64: b64(ZIP64_DROPPED()) }, 'parse'],
            ['ZIP_ZIP64_LOCATOR_MISSING', 'inspect_zip', { zipBase64: b64(raw(one, { totalEntriesOverride: 0xffff })) }, 'parse'],
            ['ZIP_STREAM_TRUNCATED', 'scan_zip_forward', { zipBase64: b64(truncated(basicZip(), 60)), data: 'verify' }, 'parse'],
            ['ZIP_DEFLATE_TRUNCATED', 'inflate_raw', { dataBase64: b64(deflateRawSync(Buffer.alloc(4096)).subarray(0, 5)), maxOutput: 10_000 }, 'parse'],
            ['ZIP_DEFLATE_CORRUPT', 'inflate_raw', { dataBase64: b64(bytesOf('not deflate at all!!!')), maxOutput: 10_000 }, 'parse'],
            ['ZIP_CRC_MISMATCH', 'read_zip_entry', { zipBase64: b64(CRC_OVERRIDE()), index: 0 }, 'data'],
            ['ZIP_CRC_MISMATCH', 'extract_zip', { zipBase64: b64(CORRUPT_DEFLATE()) }, 'data'],
            ['ZIP_SIZE_MISMATCH', 'read_zip_entry', { zipBase64: b64(raw([{ name: 'a.txt', data: bytesOf('abcd'), uncompressedSizeOverride: 2 }])), index: 0 }, 'data'],
            ['ZIP_DESCRIPTOR_MISMATCH', 'scan_zip_forward', { zipBase64: b64(raw([{ name: 'x', data: bytesOf('xxxxxxxxxx'), method: 8, dataDescriptor: 'signed', descriptorUncompressedSizeOverride: 3 }])), data: 'verify' }, 'data'],
            ['ZIP_DECOMPRESSION_FAILED', 'scan_zip_forward', { zipBase64: b64(LFH_METHOD_MISMATCH()), data: 'verify' }, 'data'],
            ['ZIP_INFLATE_OUTPUT_OVERFLOW', 'inflate_raw', { dataBase64: b64(deflateRawSync(Buffer.alloc(4096))), maxOutput: 10 }, 'data'],
            ['ZIP_INFLATE_OUTPUT_OVERFLOW', 'inflate_raw', { dataBase64: b64(new Uint8Array(20)), maxOutput: 10, method: 'store' }, 'data'],
            ['ZIP_LIMIT_EXCEEDED', 'extract_zip', { zipBase64: b64(highRatioZip()), limits: { maxCompressionRatio: 2 } }, 'limit'],
            ['ZIP_LIMIT_EXCEEDED', 'create_zip', { entries: [{ name: 'a', text: 'x' }], comment: 'é'.repeat(40_000) }, 'limit'],
            ['ZIP_UNSUPPORTED_ENCRYPTION', 'read_zip_entry', { zipBase64: b64(ENCRYPTED_FLAG()), name: 'secret.txt' }, 'unsupported'],
            ['ZIP_UNSUPPORTED_METHOD', 'extract_zip', { zipBase64: b64(UNKNOWN_METHOD()) }, 'unsupported'],
            ['ZIP_UNSUPPORTED_METHOD', 'inflate_raw', { dataBase64: 'AAAA', maxOutput: 16, method: '93' }, 'unsupported'],
            ['ZIP_UNSUPPORTED_MULTI_DISK', 'inspect_zip', { zipBase64: b64(MULTI_DISK()) }, 'unsupported'],
            ['ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR', 'scan_zip_forward', { zipBase64: b64(STORE_DESCRIPTOR()) }, 'unsupported'],
            ['ZIP_STRICT_DIAGNOSTIC', 'inspect_zip', { zipBase64: b64(SFX_PREFIXED()), strict: true }, 'check'],
            ['ZIP_ENTRY_NOT_FOUND', 'read_zip_entry', { zipBase64: b64(basicZip()), name: 'nope.txt' }, 'not-found'],
            ['ZIP_ENTRY_NOT_FOUND', 'read_zip_entry', { zipBase64: b64(basicZip()), index: 99 }, 'not-found'],
            ['ZIP_ENTRY_NOT_FOUND', 'modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'replace', name: 'nope', text: 'x' }] }, 'not-found'],
            ['ZIP_ENTRY_EXISTS', 'modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'add', name: 'README.md', text: 'x' }] }, 'input'],
            ['ZIP_ENTRY_EXISTS', 'modify_zip', { zipBase64: b64(basicZip()), operations: [{ op: 'rename', from: 'README.md', to: 'src/index.js' }] }, 'input'],
            ['ZIP_DUPLICATE_ENTRY_NAME', 'modify_zip', { zipBase64: b64(raw([{ name: 'a', data: bytesOf('1') }, { name: 'a', data: bytesOf('2') }])), operations: [{ op: 'setComment', comment: 'x' }] }, 'input'],
            ['ZIP_INVALID_ENTRY_NAME', 'create_zip', { entries: [{ name: '../x', text: 'x' }] }, 'input'],
            ['ZIP_INVALID_ENTRY_NAME', 'create_zip', { entries: [{ name: '/abs', text: 'x' }] }, 'input'],
        ];
        for (const [expected, tool, args, errorClass] of cases) {
            const err = await refusal(tool, args);
            expect(err.code, `${tool} ${JSON.stringify(Object.keys(args))}`).toBe(expected);
            expect(err.data?.['errorClass'], expected).toBe(errorClass);
            expect(ZIP_ERROR_CLASS[expected as keyof typeof ZIP_ERROR_CLASS]).toBe(errorClass);
        }
        // verify_zip never fails for an archive problem: the same refusal lands in its `error` (never isError).
        const verified = await callToolDirect('verify_zip', { zipBase64: b64(MULTI_DISK()) });
        expect(verified.isError).not.toBe(true);
        expect(verified.structuredContent).toMatchObject({ ok: false, error: { code: 'ZIP_UNSUPPORTED_MULTI_DISK' } });
        // The data-descriptor mismatch with tolerateTruncation lands in scan's `error` instead of failing.
        const tolerated = await callToolDirect('scan_zip_forward', { zipBase64: b64(CRC_OVERRIDE()), data: 'verify', tolerateTruncation: true });
        expect(tolerated.isError).not.toBe(true);
        expect(tolerated.structuredContent).toMatchObject({ stoppedAt: 'error', truncated: true, error: { code: 'ZIP_CRC_MISMATCH' } });
        // And a tool that produced an archive under refusal-free input still passes the gate.
        const fine = await callToolDirect('create_zip', { entries: [{ name: 'a', text: 'x' }] });
        assertValidZip((fine.content[1] as { resource: { blob: string } }).resource.blob);
    }, 60_000);
});
