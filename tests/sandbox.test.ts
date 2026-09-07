/**
 * The single filesystem boundary (`src/sandbox.ts`) and the output emitters
 * built on it (`src/output.ts`): every read and write resolves against
 * ZIPNATIVE_MCP_OUTPUT_DIR, refuses NUL / absolute / UNC / traversal paths,
 * enforces the container-extension allow-list, never overwrites (`wx`),
 * re-checks the real path of the parent (symlinked directories), bounds the
 * output size, and removes a partial file when a streamed write fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_BASE64_OUTPUT_BYTES, MAX_FILE_OUTPUT_BYTES } from '../src/caps.js';
import { SecurityError, ToolError } from '../src/errors.js';
import { displayName, emitArchive, emitArchiveStream, writeSandboxedText } from '../src/output.js';
import { readResource } from '../src/resources.js';
import { callToolDirect, ensureEngineReady } from '../src/server.js';
import { b64, basicZip } from './_zip-fixtures.js';
import {
    assertRealpathInside,
    discardPartial,
    getOutputSandbox,
    mapWriteError,
    openExclusiveWriteStream,
    OUTPUT_DIR_ENV,
    relativeLabel,
    resolveInputFile,
    resolveOutputDir,
    resolveOutputFile,
    writeExclusive,
    ZIP_CONTAINER_EXTENSIONS,
} from '../src/sandbox.js';

const ENV_KEY = 'ZIPNATIVE_MCP_OUTPUT_DIR';

async function codeOf(p: Promise<unknown>): Promise<ToolError> {
    try {
        await p;
    } catch (err) {
        if (err instanceof ToolError) return err;
        throw err;
    }
    throw new Error('expected the call to reject');
}

describe('sandbox resolution', () => {
    let sandboxDir: string;

    beforeEach(async () => {
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-sandbox-'));
        process.env[ENV_KEY] = sandboxDir;
    });
    afterEach(async () => {
        delete process.env[ENV_KEY];
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('names the canonical environment variable and resolves it to an absolute directory', () => {
        expect(OUTPUT_DIR_ENV).toBe(ENV_KEY);
        expect(getOutputSandbox()).toBe(path.resolve(sandboxDir));
        process.env[ENV_KEY] = '   ';
        expect(getOutputSandbox()).toBeNull();
    });

    it('sandbox disabled → SECURITY_VIOLATION for every read and write', async () => {
        delete process.env[ENV_KEY];
        expect(getOutputSandbox()).toBeNull();
        expect(() => resolveOutputFile('a.zip')).toThrow(SecurityError);
        expect(() => resolveOutputDir('out')).toThrow(SecurityError);
        expect((await codeOf(resolveInputFile('a.zip', null))).code).toBe('SECURITY_VIOLATION');
        expect((await codeOf(emitArchive(new Uint8Array([1]), { mode: 'file', outputPath: 'a.zip' }))).code).toBe('SECURITY_VIOLATION');
        expect((await codeOf(assertRealpathInside(os.tmpdir()))).code).toBe('SECURITY_VIOLATION');
        // The message names the variable an operator must set.
        expect((await codeOf(writeSandboxedText('x', 'a.md'))).message).toContain(ENV_KEY);
    });

    it('rejects NUL bytes', () => {
        expect(() => resolveOutputFile('foo\0bar.zip')).toThrow(SecurityError);
        expect(() => resolveOutputDir('foo\0bar')).toThrow(SecurityError);
    });

    it('rejects absolute, UNC and drive-letter paths (both separators, even on POSIX)', () => {
        for (const p of ['C:\\Windows\\System32\\evil.zip', 'C:/x/evil.zip', '\\\\server\\share\\evil.zip', '/etc/passwd.zip', path.join(sandboxDir, 'inside.zip')]) {
            expect(() => resolveOutputFile(p), p).toThrow(SecurityError);
            expect(() => resolveOutputDir(p), p).toThrow(SecurityError);
        }
    });

    it("rejects '..' traversal and the sandbox root itself", () => {
        expect(() => resolveOutputFile('../escape.zip')).toThrow(SecurityError);
        expect(() => resolveOutputFile('sub/../../escape.zip')).toThrow(SecurityError);
        expect(() => resolveOutputDir('..')).toThrow(SecurityError);
        expect(() => resolveOutputDir('.')).toThrow(SecurityError);
        expect(() => resolveOutputDir('sub/..')).toThrow(SecurityError);
        // A '..' segment that stays inside is fine.
        expect(resolveOutputDir('a/../b')).toBe(path.join(sandboxDir, 'b'));
    });

    it('rejects an empty or non-string path with INVALID_PATH', () => {
        for (const bad of ['', undefined, 42, null]) {
            let code: string | undefined;
            try {
                resolveOutputFile(bad);
            } catch (err) {
                code = err instanceof ToolError ? err.code : 'other';
            }
            expect(code, String(bad)).toBe('INVALID_PATH');
        }
    });

    it('enforces the container-extension allow-list on archive paths (INVALID_EXTENSION)', async () => {
        expect(() => resolveOutputFile('foo.exe')).toThrow(ToolError);
        let err: ToolError | undefined;
        try {
            resolveOutputFile('notes.txt');
        } catch (e) {
            err = e as ToolError;
        }
        expect(err?.code).toBe('INVALID_EXTENSION');
        expect(err?.message).toContain('.zip');
        for (const ext of ZIP_CONTAINER_EXTENSIONS) {
            expect(resolveOutputFile(`out/file${ext.toUpperCase()}`)).toBe(path.join(sandboxDir, 'out', `file${ext.toUpperCase()}`));
        }
        expect((await codeOf(resolveInputFile('in.txt', ZIP_CONTAINER_EXTENSIONS))).code).toBe('INVALID_EXTENSION');
        // A custom allow-list (text artifacts) and no allow-list (any file) both work.
        expect(resolveOutputFile('drafts/issue.md', ['.md'])).toBe(path.join(sandboxDir, 'drafts', 'issue.md'));
    });

    it('resolveInputFile: INPUT_NOT_FOUND for a missing file or a directory, and the size of a real file', async () => {
        const missing = await codeOf(resolveInputFile('nope.zip', null));
        expect(missing.code).toBe('INPUT_NOT_FOUND');
        expect(missing.message).not.toContain(sandboxDir);
        expect(missing.data).toEqual({ path: 'nope.zip', remedy: 'resources/list' });
        expect(missing.message).toContain('resources/list');
        await fs.mkdir(path.join(sandboxDir, 'dir'));
        expect((await codeOf(resolveInputFile('dir', null, 'sourcePath'))).message).toContain('not a regular file');
        await fs.writeFile(path.join(sandboxDir, 'real.bin'), Buffer.alloc(10));
        const found = await resolveInputFile('real.bin', null, 'sourcePath');
        expect(found).toEqual({ resolved: path.join(sandboxDir, 'real.bin'), size: 10 });
    });

    it('relativeLabel is POSIX-style relative to the sandbox (basename when disabled)', () => {
        expect(relativeLabel(path.join(sandboxDir, 'a', 'b.zip'))).toBe('a/b.zip');
        delete process.env[ENV_KEY];
        expect(relativeLabel(path.join(sandboxDir, 'a', 'b.zip'))).toBe('b.zip');
        expect(displayName('/x/y/z.zip')).toBe('z.zip');
    });
});

describe('exclusive writes', () => {
    let sandboxDir: string;

    beforeEach(async () => {
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-write-'));
        process.env[ENV_KEY] = sandboxDir;
    });
    afterEach(async () => {
        delete process.env[ENV_KEY];
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('emits base64 by default and writes a file inside the sandbox (parent directories created)', async () => {
        const inline = await emitArchive(new Uint8Array([1, 2, 3, 4]), { mode: 'base64' });
        expect(inline).toEqual({ mode: 'base64', sizeBytes: 4, base64: 'AQIDBA==', mimeType: 'application/zip' });
        const result = await emitArchive(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { mode: 'file', outputPath: 'sub/out.zip' });
        expect(result.mode).toBe('file');
        expect(result.filePath).toBe(path.join(sandboxDir, 'sub', 'out.zip'));
        expect(result.mimeType).toBe('application/zip');
        expect((await fs.readFile(result.filePath!)).length).toBe(4);
    });

    it("`wx`: the second write to the same path is OUTPUT_EXISTS (the server never overwrites)", async () => {
        await emitArchive(new Uint8Array([1]), { mode: 'file', outputPath: 'once.zip' });
        const err = await codeOf(emitArchive(new Uint8Array([2]), { mode: 'file', outputPath: 'once.zip' }));
        expect(err.code).toBe('OUTPUT_EXISTS');
        expect(err.message).toContain('once.zip');
        expect(err.message).not.toContain(sandboxDir);
        expect(err.data).toEqual({ path: 'once.zip' });
        expect((await fs.readFile(path.join(sandboxDir, 'once.zip')))[0]).toBe(1);
        // The streamed path refuses the same way, without touching the file.
        const stream = await codeOf(openExclusiveWriteStream(path.join(sandboxDir, 'once.zip'), 'once.zip'));
        expect(stream.code).toBe('OUTPUT_EXISTS');
    });

    it('MISSING_OUTPUT_PATH when file mode has no outputPath', async () => {
        expect((await codeOf(emitArchive(new Uint8Array([1]), { mode: 'file' }))).code).toBe('MISSING_OUTPUT_PATH');
        expect((await codeOf(emitArchiveStream((async function* () { yield new Uint8Array([1]); })(), undefined))).code).toBe('MISSING_OUTPUT_PATH');
    });

    it('OUTPUT_TOO_LARGE: inline cap (50 MiB) with a remedy, file cap (4 GiB) checked before any write', async () => {
        const inline = await codeOf(emitArchive(new Uint8Array(MAX_BASE64_OUTPUT_BYTES + 1), { mode: 'base64' }));
        expect(inline.code).toBe('OUTPUT_TOO_LARGE');
        expect(inline.message).toContain("outputMode:'file'");
        expect(inline.data).toEqual({ sizeBytes: MAX_BASE64_OUTPUT_BYTES + 1, cap: MAX_BASE64_OUTPUT_BYTES, remedy: "outputMode:'file'" });
        expect(MAX_FILE_OUTPUT_BYTES).toBe(4 * 1024 * 1024 * 1024);
        // The file cap is a byte-length comparison made before the path resolves: a
        // length-only stand-in exercises it without allocating 4 GiB.
        const oversized = { byteLength: MAX_FILE_OUTPUT_BYTES + 1 } as unknown as Uint8Array;
        const file = await codeOf(emitArchive(oversized, { mode: 'file', outputPath: 'huge.zip' }));
        expect(file.code).toBe('OUTPUT_TOO_LARGE');
        expect(file.message).toContain('file cap — split the content');
        expect(file.data).toEqual({ sizeBytes: MAX_FILE_OUTPUT_BYTES + 1, cap: MAX_FILE_OUTPUT_BYTES });
        await expect(fs.stat(path.join(sandboxDir, 'huge.zip'))).rejects.toThrow();
    });

    it('emitArchiveStream writes chunks with bounded memory and removes the partial file on failure', async () => {
        async function* good(): AsyncGenerator<Uint8Array, void, undefined> {
            yield new Uint8Array([0x50, 0x4b]);
            yield new Uint8Array(70_000);
        }
        const ok = await emitArchiveStream(good(), 'streamed/ok.zip');
        expect(ok).toEqual({ mode: 'file', sizeBytes: 70_002, filePath: path.join(sandboxDir, 'streamed', 'ok.zip'), mimeType: 'application/zip' });
        expect((await fs.stat(ok.filePath!)).size).toBe(70_002);

        async function* broken(): AsyncGenerator<Uint8Array, void, undefined> {
            yield new Uint8Array([0x50, 0x4b]);
            throw new ToolError('ZIP_DEFLATE_CORRUPT', 'simulated engine failure mid-stream');
        }
        const err = await codeOf(emitArchiveStream(broken(), 'streamed/partial.zip'));
        expect(err.code).toBe('ZIP_DEFLATE_CORRUPT');
        await expect(fs.stat(path.join(sandboxDir, 'streamed', 'partial.zip'))).rejects.toThrow();

        // The file cap is enforced while streaming (before the chunk is written).
        async function* oversized(): AsyncGenerator<Uint8Array, void, undefined> {
            yield { byteLength: MAX_FILE_OUTPUT_BYTES + 1 } as unknown as Uint8Array;
        }
        const capped = await codeOf(emitArchiveStream(oversized(), 'streamed/capped.zip'));
        expect(capped.code).toBe('OUTPUT_TOO_LARGE');
        expect(capped.message).toContain('split the content');
        await expect(fs.stat(path.join(sandboxDir, 'streamed', 'capped.zip'))).rejects.toThrow();
        // Non-container extensions are refused before the stream is opened.
        expect((await codeOf(emitArchiveStream(good(), 'streamed/raw.bin'))).code).toBe('INVALID_EXTENSION');
        expect(await emitArchiveStream(good(), 'streamed/raw.bin', { extensions: ['.bin'], mimeType: 'application/octet-stream' })).toMatchObject({ mode: 'file', mimeType: 'application/octet-stream' });
    });

    it('IO_ERROR: an unwritable file name is mapped without leaking the absolute path', async () => {
        // win32 refuses '<' in a file name (EINVAL); POSIX refuses a 300-byte name (ENAMETOOLONG).
        const bad = process.platform === 'win32' ? 'bad<name>.zip' : `${'a'.repeat(300)}.zip`;
        const err = await codeOf(emitArchive(new Uint8Array([1]), { mode: 'file', outputPath: bad }));
        expect(err.code).toBe('IO_ERROR');
        expect(err.message).toContain(bad);
        expect(err.message).not.toContain(sandboxDir);
        expect(err.data?.['path']).toBe(bad);
        expect(typeof err.data?.['errno']).toBe('string');
        const streamed = await codeOf(emitArchiveStream((async function* () { yield new Uint8Array([1]); })(), bad));
        expect(streamed.code).toBe('IO_ERROR');
    });

    it('mapWriteError distinguishes EEXIST from other errnos and tolerates non-Error values', () => {
        const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
        expect(mapWriteError(exists, 'x.zip')).toMatchObject({ code: 'OUTPUT_EXISTS', data: { path: 'x.zip' } });
        const denied = Object.assign(new Error("EACCES: permission denied, open '/secret/place/x.zip'"), { code: 'EACCES' });
        const mapped = mapWriteError(denied, 'x.zip');
        expect(mapped.code).toBe('IO_ERROR');
        expect(mapped.message).not.toContain('/secret/place');
        expect(mapped.message).toContain("'…'");
        expect(mapped.data).toEqual({ path: 'x.zip', errno: 'EACCES' });
        expect(mapWriteError('boom', 'y.zip')).toMatchObject({ code: 'IO_ERROR', data: { path: 'y.zip' } });
    });

    it('writeExclusive + discardPartial: the low-level primitives', async () => {
        const target = path.join(sandboxDir, 'deep', 'er', 'file.zip');
        await writeExclusive(target, new Uint8Array([7]), 'deep/er/file.zip');
        expect((await fs.readFile(target))[0]).toBe(7);
        expect((await codeOf(writeExclusive(target, new Uint8Array([8]), 'deep/er/file.zip'))).code).toBe('OUTPUT_EXISTS');
        await discardPartial(target);
        await expect(fs.stat(target)).rejects.toThrow();
        await discardPartial(target); // already gone: silent
    });

    it('assertRealpathInside: a symlinked directory pointing outside the sandbox is refused', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-outside-'));
        const link = path.join(sandboxDir, 'escape');
        try {
            try {
                await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (err) {
                // Symlink creation needs a privilege this host does not grant (win32 without Developer Mode).
                console.warn(`[sandbox] symlink not available (${(err as Error).message}); skipping the realpath assertion`);
                return;
            }
            await expect(assertRealpathInside(sandboxDir)).resolves.toBeUndefined();
            await expect(assertRealpathInside(path.join(sandboxDir, 'escape'))).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
            // Through the write path: mkdir -p succeeds (the link exists), the realpath check still refuses.
            const err = await codeOf(emitArchive(new Uint8Array([1]), { mode: 'file', outputPath: 'escape/out.zip' }));
            expect(err.code).toBe('SECURITY_VIOLATION');
            expect(err.message).toBe("Refusing outputPath 'escape': its real location (a symlink or junction) is outside the sandbox.");
            expect(err.message).not.toContain(outside);
            await expect(fs.stat(path.join(outside, 'out.zip'))).rejects.toThrow();
            const streamed = await codeOf(emitArchiveStream((async function* () { yield new Uint8Array([1]); })(), 'escape/out2.zip'));
            expect(streamed.code).toBe('SECURITY_VIOLATION');
        } finally {
            await fs.rm(outside, { recursive: true, force: true });
        }
    });
});

/**
 * A-002 — the READ side of the sandbox follows no pre-planted junction /
 * symlink outside ZIPNATIVE_MCP_OUTPUT_DIR: every path input (zipPath,
 * sourcePath, resource URI) is refused when the file's real location lies
 * outside the real sandbox, on win32 (junction) and POSIX (symlinks) alike.
 */
describe('A-002: junction / symlink escape is refused on every read path', () => {
    let sandboxDir: string;
    let outside: string;

    beforeEach(async () => {
        await ensureEngineReady();
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-a002-'));
        outside = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-a002-outside-'));
        process.env[ENV_KEY] = sandboxDir;
        await fs.writeFile(path.join(outside, 'secret.zip'), basicZip());
        await fs.writeFile(path.join(outside, 'secret.bin'), Buffer.from([1, 2, 3, 4]));
    });
    afterEach(async () => {
        delete process.env[ENV_KEY];
        await fs.rm(sandboxDir, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    });

    /** Plant a directory link inside the sandbox pointing outside; false when the host grants no symlink privilege. */
    async function plantDirLink(name: string, kind: 'junction' | 'dir'): Promise<boolean> {
        try {
            await fs.symlink(outside, path.join(sandboxDir, name), kind);
            return true;
        } catch (err) {
            console.warn(`[sandbox] ${kind} link not available (${(err as Error).message}); skipping`);
            return false;
        }
    }

    async function refusal(tool: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
        const r = await callToolDirect(tool, args);
        expect(r.isError, `${tool} must refuse: ${String(JSON.stringify(r.structuredContent)).slice(0, 200)}`).toBe(true);
        return (r._meta as { error: { code: string; message: string } }).error;
    }

    const READ_PATHS: Array<[string, (rel: string) => Record<string, unknown>]> = [
        ['inspect_zip', (rel) => ({ zipPath: `${rel}/secret.zip` })],
        ['list_zip_entries', (rel) => ({ zipPath: `${rel}/secret.zip` })],
        ['verify_zip', (rel) => ({ zipPath: `${rel}/secret.zip` })],
        ['scan_zip_forward', (rel) => ({ zipPath: `${rel}/secret.zip` })],
        ['extract_zip', (rel) => ({ zipPath: `${rel}/secret.zip`, includeData: false })],
        ['modify_zip', (rel) => ({ zipPath: `${rel}/secret.zip`, operations: [{ op: 'setComment', comment: 'x' }] })],
        ['compute_crc32', (rel) => ({ sourcePath: `${rel}/secret.bin` })],
        ['inflate_raw', (rel) => ({ sourcePath: `${rel}/secret.bin`, maxOutput: 100, method: 'store' })],
        ['create_zip', (rel) => ({ entries: [{ name: 'a', sourcePath: `${rel}/secret.bin` }] })],
        ['create_zip', (rel) => ({ entries: [{ name: 'a', sourcePath: `${rel}/secret.bin`, stream: true }] })],
    ];

    it('a directory junction (win32) / directory symlink (POSIX) inside the sandbox is refused by every tool taking zipPath / sourcePath and by resources/read', async () => {
        const kind = process.platform === 'win32' ? 'junction' : 'dir';
        if (!(await plantDirLink('jump', kind))) return;
        for (const [tool, args] of READ_PATHS) {
            const err = await refusal(tool, args('jump'));
            expect(err.code, tool).toBe('SECURITY_VIOLATION');
            expect(err.message, tool).toContain('real location');
            expect(err.message, tool).not.toContain(outside);
            expect(err.message, tool).not.toContain(sandboxDir);
        }
        await expect(readResource('zipnative://output/jump/secret.zip')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        // The listing never follows the link either.
        const list = await callToolDirect('describe_engine', {});
        expect(list.isError).not.toBe(true);
        // A regular file next to the link still reads: the guard is about the real path, not the presence of a link.
        await fs.writeFile(path.join(sandboxDir, 'ok.zip'), basicZip());
        expect((await callToolDirect('inspect_zip', { zipPath: 'ok.zip' })).isError).not.toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a FILE symlink (POSIX) pointing outside the sandbox is refused too — the real path of the file itself is checked', async () => {
        try {
            await fs.symlink(path.join(outside, 'secret.zip'), path.join(sandboxDir, 'link.zip'), 'file');
            await fs.symlink(path.join(outside, 'secret.bin'), path.join(sandboxDir, 'link.bin'), 'file');
        } catch (err) {
            console.warn(`[sandbox] file symlink not available (${(err as Error).message}); skipping`);
            return;
        }
        expect((await refusal('inspect_zip', { zipPath: 'link.zip' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('scan_zip_forward', { zipPath: 'link.zip' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('compute_crc32', { sourcePath: 'link.bin' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('inflate_raw', { sourcePath: 'link.bin', maxOutput: 10, method: 'store' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('create_zip', { entries: [{ name: 'a', sourcePath: 'link.bin' }] })).code).toBe('SECURITY_VIOLATION');
        await expect(readResource('zipnative://output/link.zip')).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
        await expect(resolveInputFile('link.zip', null)).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('a link that stays INSIDE the sandbox is fine (the check is about the real location, not the link)', async () => {
        await fs.mkdir(path.join(sandboxDir, 'real'));
        await fs.writeFile(path.join(sandboxDir, 'real', 'in.zip'), basicZip());
        try {
            await fs.symlink(path.join(sandboxDir, 'real'), path.join(sandboxDir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (err) {
            console.warn(`[sandbox] link not available (${(err as Error).message}); skipping`);
            return;
        }
        const r = await callToolDirect('inspect_zip', { zipPath: 'alias/in.zip', verbosity: 'summary' });
        expect(r.isError).not.toBe(true);
        expect((r.structuredContent as { entryCount: number }).entryCount).toBe(4);
    });

    it('the write side refuses a junction parent as before (create_zip / extract_zip into the link)', async () => {
        if (!(await plantDirLink('jump', process.platform === 'win32' ? 'junction' : 'dir'))) return;
        expect((await refusal('create_zip', { entries: [{ name: 'a', text: 'a' }], outputMode: 'file', outputPath: 'jump/out.zip' })).code).toBe('SECURITY_VIOLATION');
        expect((await refusal('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'jump/out' })).code).toBe('SECURITY_VIOLATION');
        await expect(fs.stat(path.join(outside, 'out.zip'))).rejects.toThrow();
        // No FILE ever lands outside. (extract_zip's `mkdir -p` of outputDir runs before the realpath check, so an
        // empty directory may be created through the link — a known, harmless side effect; nothing is written into it.)
        const leaked = await fs.readdir(path.join(outside, 'out')).catch(() => [] as string[]);
        expect(leaked).toEqual([]);
    });
});

describe.skipIf(process.platform !== 'win32')('win32 sandbox edge cases', () => {
    let sandboxDir: string;

    beforeEach(async () => {
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-win32-'));
        process.env[ENV_KEY] = sandboxDir;
    });
    afterEach(async () => {
        delete process.env[ENV_KEY];
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('a case-folded name collision on NTFS is OUTPUT_EXISTS (the server never overwrites)', async () => {
        await emitArchive(new Uint8Array([1]), { mode: 'file', outputPath: 'Report.zip' });
        const err = await codeOf(emitArchive(new Uint8Array([2]), { mode: 'file', outputPath: 'report.zip' }));
        expect(err.code).toBe('OUTPUT_EXISTS');
        expect((await fs.readFile(path.join(sandboxDir, 'Report.zip')))[0]).toBe(1);
    });

    it("a reserved device name ('CON.zip', 'nul.zip') never escapes the sandbox: refused as IO_ERROR / OUTPUT_EXISTS, or (Windows 11) written as a regular file inside it", async () => {
        // Windows 11 (22H2+) stopped mapping `CON.<ext>` to the console device; older hosts refuse the open.
        // Either way the bytes must not leave the sandbox, and a second write must never overwrite.
        const writers: Array<[string, () => Promise<unknown>]> = [
            ['CON.zip', () => emitArchive(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { mode: 'file', outputPath: 'CON.zip' })],
            ['nul.zip', () => emitArchiveStream((async function* () { yield new Uint8Array([0x50, 0x4b, 0x05, 0x06]); })(), 'nul.zip')],
        ];
        for (const [name, write] of writers) {
            let first: ToolError | null = null;
            try {
                await write();
            } catch (err) {
                first = err as ToolError;
            }
            if (first !== null) {
                expect(['IO_ERROR', 'OUTPUT_EXISTS'], name).toContain(first.code);
                expect(first.message, name).not.toContain(sandboxDir);
                expect((await fs.readdir(sandboxDir)).map((n) => n.toLowerCase()), name).not.toContain(name.toLowerCase());
            } else {
                const st = await fs.stat(path.join(sandboxDir, name));
                expect(st.isFile(), name).toBe(true);
                expect(st.size, name).toBe(4);
                expect((await codeOf(write())).code, `${name} second write`).toBe('OUTPUT_EXISTS');
            }
        }
        // The bare device name has no container extension and never reaches the filesystem.
        expect(() => resolveOutputFile('CON')).toThrow(expect.objectContaining({ code: 'INVALID_EXTENSION' }));
    });

    it('a path beyond 260 characters is either written intact or refused as IO_ERROR without a partial file', async () => {
        const deep = `${Array.from({ length: 12 }, (_, i) => `segment-${i}-${'x'.repeat(20)}`).join('/')}/deep.zip`;
        expect(deep.length).toBeGreaterThan(260);
        let outcome: ToolError | { filePath?: string };
        try {
            outcome = await emitArchive(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { mode: 'file', outputPath: deep });
        } catch (err) {
            outcome = err as ToolError;
        }
        if (outcome instanceof ToolError) {
            expect(outcome.code).toBe('IO_ERROR');
            expect(outcome.message).not.toContain(sandboxDir);
        } else {
            expect((await fs.stat(outcome.filePath as string)).size).toBe(4);
        }
    });

    it('an outputDir written with backslashes stays inside the sandbox', async () => {
        const r = await callToolDirect('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file', outputDir: 'out\\nested' });
        expect(r.isError).not.toBe(true);
        expect((await fs.stat(path.join(sandboxDir, 'out', 'nested', 'README.md'))).isFile()).toBe(true);
        expect((await codeOf(callToolDirect('extract_zip', { zipBase64: b64(basicZip()), outputMode: 'file', outputDir: '..\\escape' }).then((x) => { if (x.isError === true) throw new ToolError((x._meta as { error: { code: string } }).error.code, 'x'); return x; }))).code).toBe('SECURITY_VIOLATION');
    });
});

describe('writeSandboxedText (governance drafts)', () => {
    let sandboxDir: string;

    beforeEach(async () => {
        sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-mcp-text-'));
        process.env[ENV_KEY] = sandboxDir;
    });
    afterEach(async () => {
        delete process.env[ENV_KEY];
        await fs.rm(sandboxDir, { recursive: true, force: true });
    });

    it('writes a sandboxed .md text artifact', async () => {
        const { filePath, sizeBytes } = await writeSandboxedText('# Draft\n\nbody — ünïcödé', 'drafts/issue.md');
        expect(filePath).toBe(path.join(sandboxDir, 'drafts', 'issue.md'));
        expect(await fs.readFile(filePath, 'utf8')).toBe('# Draft\n\nbody — ünïcödé');
        expect(sizeBytes).toBe(Buffer.byteLength('# Draft\n\nbody — ünïcödé', 'utf8'));
    });

    it('accepts only the .md extension, refuses traversal and never overwrites', async () => {
        expect((await codeOf(writeSandboxedText('x', 'issue.txt'))).code).toBe('INVALID_EXTENSION');
        expect((await codeOf(writeSandboxedText('x', 'issue.zip'))).code).toBe('INVALID_EXTENSION');
        await expect(writeSandboxedText('x', '../escape.md')).rejects.toThrow(SecurityError);
        await writeSandboxedText('first', 'once.md');
        expect((await codeOf(writeSandboxedText('second', 'once.md'))).code).toBe('OUTPUT_EXISTS');
        expect(await fs.readFile(path.join(sandboxDir, 'once.md'), 'utf8')).toBe('first');
    });

    it('bounds the artifact by the inline cap', async () => {
        const huge = { byteLength: MAX_BASE64_OUTPUT_BYTES + 1 };
        // Buffer.from(text) is what the guard measures; build a string just over the cap cheaply.
        const text = 'x'.repeat(huge.byteLength);
        expect((await codeOf(writeSandboxedText(text, 'huge.md'))).code).toBe('OUTPUT_TOO_LARGE');
    });
});
