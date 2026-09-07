/**
 * The single filesystem boundary of the server.
 *
 * Every path a tool reads (`zipPath`, `sourcePath`) or writes (`outputPath`,
 * `outputDir`, extracted files, governance drafts) resolves through this
 * module against the one operator-configured directory
 * `ZIPNATIVE_MCP_OUTPUT_DIR`. Unset ⇒ every file input and output is disabled
 * and the tools work on base64 only. The guards are the ones pdfnative-mcp
 * applies to its output sandbox (NUL bytes, absolute / UNC paths, `..`
 * traversal, extension allow-list) plus a realpath check on the parent
 * directory so a symlinked directory inside the sandbox cannot redirect a
 * write outside it.
 */
import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';

import { SecurityError, ToolError } from './errors.js';

/** Canonical environment variable naming the sandbox directory. */
export const OUTPUT_DIR_ENV = 'ZIPNATIVE_MCP_OUTPUT_DIR';

/** Detect Windows absolute and UNC paths even when running on POSIX CI. */
const WINDOWS_ABSOLUTE_OR_UNC = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Container formats that are ZIP archives on the wire. The allow-list bounds
 * what `zipPath` / `outputPath` may name so the sandbox never becomes a
 * general file store (extracted files are written under an `outputDir` and
 * are not subject to it).
 */
export const ZIP_CONTAINER_EXTENSIONS: readonly string[] = [
    '.zip', '.jar', '.war', '.ear', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
    '.epub', '.vsix', '.nupkg', '.whl', '.apk', '.ipa', '.xpi', '.crx', '.kmz',
];

/** Returns the configured sandbox directory (absolute), or `null` when file I/O is disabled. */
export function getOutputSandbox(): string | null {
    const raw = process.env[OUTPUT_DIR_ENV];
    if (raw !== undefined && raw.trim() !== '') return path.resolve(raw);
    return null;
}

function requireSandbox(): string {
    const sandbox = getOutputSandbox();
    if (sandbox === null) {
        throw new SecurityError(
            `File input/output is disabled. Set ${OUTPUT_DIR_ENV} to an allow-listed directory to enable zipPath / sourcePath / outputMode='file', or pass the bytes as base64.`,
        );
    }
    return sandbox;
}

/**
 * Resolve a relative user path inside the sandbox. Shared by every read and
 * write: rejects NUL bytes, absolute / UNC paths and traversal.
 */
function resolveRelative(userPath: unknown, what: string): { sandbox: string; resolved: string } {
    const sandbox = requireSandbox();
    if (typeof userPath !== 'string' || userPath.length === 0) {
        throw new ToolError('INVALID_PATH', `${what} must be a non-empty string.`);
    }
    if (userPath.includes('\0')) {
        throw new SecurityError(`${what} contains a NUL byte.`);
    }
    if (path.isAbsolute(userPath) || WINDOWS_ABSOLUTE_OR_UNC.test(userPath)) {
        throw new SecurityError(`${what} must be relative to the configured sandbox directory.`);
    }
    const resolved = path.resolve(sandbox, userPath);
    const relative = path.relative(sandbox, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new SecurityError(`${what} '${userPath}' escapes the sandbox directory.`);
    }
    return { sandbox, resolved };
}

function hasAllowedExtension(resolved: string, extensions: readonly string[]): boolean {
    const lower = resolved.toLowerCase();
    return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Resolve a relative output file path (archive or `.md` draft). Throws
 * `INVALID_EXTENSION` when the name does not end in one of `extensions`.
 */
export function resolveOutputFile(userPath: unknown, extensions: readonly string[] = ZIP_CONTAINER_EXTENSIONS, what = 'outputPath'): string {
    const { resolved } = resolveRelative(userPath, what);
    if (!hasAllowedExtension(resolved, extensions)) {
        throw new ToolError('INVALID_EXTENSION', `${what} must end with one of: ${extensions.join(', ')}.`);
    }
    return resolved;
}

/** Resolve a relative output directory (for `extract_zip` file mode). */
export function resolveOutputDir(userPath: unknown, what = 'outputDir'): string {
    return resolveRelative(userPath, what).resolved;
}

/**
 * Resolve a relative input file inside the sandbox and stat it. Throws
 * `INPUT_NOT_FOUND` when absent (message carries the relative path only) and
 * `INVALID_EXTENSION` when `extensions` is given and the name does not match.
 */
export async function resolveInputFile(
    userPath: unknown,
    extensions: readonly string[] | null,
    what = 'zipPath',
): Promise<{ resolved: string; size: number }> {
    const { resolved } = resolveRelative(userPath, what);
    if (extensions !== null && !hasAllowedExtension(resolved, extensions)) {
        throw new ToolError('INVALID_EXTENSION', `${what} must end with one of: ${extensions.join(', ')}.`);
    }
    let stat;
    try {
        stat = await fs.stat(resolved);
    } catch {
        throw new ToolError('INPUT_NOT_FOUND', `${what} '${String(userPath)}' does not exist in the sandbox.`, { path: String(userPath) });
    }
    if (!stat.isFile()) {
        throw new ToolError('INPUT_NOT_FOUND', `${what} '${String(userPath)}' is not a regular file.`, { path: String(userPath) });
    }
    return { resolved, size: stat.size };
}

/**
 * Defence in depth for writes under a directory the caller chose: after
 * `mkdir -p`, the *real* path of the parent must still live inside the real
 * sandbox (a pre-existing symlinked directory would otherwise redirect the
 * write). Throws `SECURITY_VIOLATION`.
 */
export async function assertRealpathInside(parentDir: string): Promise<void> {
    const sandbox = requireSandbox();
    const [realSandbox, realParent] = await Promise.all([fs.realpath(sandbox), fs.realpath(parentDir)]);
    const relative = path.relative(realSandbox, realParent);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new SecurityError(`Refusing to write under '${parentDir}': its real location is outside the sandbox.`);
    }
}

/** Map a Node fs error on a write to the wrapper codes (never leaks the absolute path). */
export function mapWriteError(err: unknown, relativeLabel: string): ToolError {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'EEXIST') {
        return new ToolError('OUTPUT_EXISTS', `'${relativeLabel}' already exists in the sandbox — the server never overwrites; choose another path.`, { path: relativeLabel });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new ToolError('IO_ERROR', `Could not write '${relativeLabel}': ${code ?? 'error'} — ${message.replace(/'[^']*'/g, "'…'")}`, { path: relativeLabel, ...(code !== undefined ? { errno: code } : {}) });
}

/** Write bytes exclusively (`wx`), creating parent directories. */
export async function writeExclusive(resolved: string, bytes: Uint8Array, relativeLabel: string): Promise<void> {
    await ensureParent(resolved, relativeLabel);
    try {
        await fs.writeFile(resolved, bytes, { flag: 'wx' });
    } catch (err) {
        throw mapWriteError(err, relativeLabel);
    }
}

/** Create the parent directory (mapping fs failures such as a file in the way) and check its real path. */
export async function ensureParent(resolved: string, relativeLabel: string): Promise<void> {
    try {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
    } catch (err) {
        throw mapWriteError(err, relativeLabel);
    }
    await assertRealpathInside(path.dirname(resolved));
}

/**
 * Open an exclusive write stream (`wx`) after the same guards. The caller
 * owns the stream and must unlink the file on failure via {@link discardPartial}.
 */
export async function openExclusiveWriteStream(resolved: string, relativeLabel: string): Promise<WriteStream> {
    await ensureParent(resolved, relativeLabel);
    const stream = createWriteStream(resolved, { flags: 'wx' });
    await new Promise<void>((resolveOpen, reject) => {
        stream.once('open', () => resolveOpen());
        stream.once('error', (err) => reject(mapWriteError(err, relativeLabel)));
    });
    return stream;
}

/** Remove a partially written file, ignoring errors (the original failure is what matters). */
export async function discardPartial(resolved: string): Promise<void> {
    try {
        await fs.unlink(resolved);
    } catch {
        /* already gone or never created */
    }
}

/** POSIX-style relative label for messages and resource names. */
export function relativeLabel(resolved: string): string {
    const sandbox = getOutputSandbox();
    if (sandbox === null) return path.basename(resolved);
    return path.relative(sandbox, resolved).split(path.sep).join('/');
}
