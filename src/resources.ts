/**
 * Native MCP resources — expose sandboxed files as re-referenceable resource URIs.
 *
 * When the host enables the sandbox (`ZIPNATIVE_MCP_OUTPUT_DIR`), every regular
 * file under it (archives written by `create_zip` / `modify_zip`, files written
 * by `extract_zip`, archives the operator dropped in for `zipPath`) becomes an
 * addressable MCP resource under the `zipnative://output/<relative-path>`
 * scheme, discoverable via `resources/list` and fetchable via `resources/read`.
 * File-producing tools additionally emit a `resource_link` to what they wrote.
 *
 * State is intentionally minimal and bounded: the server holds no in-memory
 * registry — `resources/list` reflects the live contents of the sandbox
 * directory, and every read is re-validated to stay inside it. When the
 * sandbox is disabled, there are simply no resources.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

import { ToolError } from './errors.js';
import { MAX_LISTED_RESOURCES, MAX_RESOURCE_READ_BYTES, MAX_RESOURCE_WALK_DEPTH as MAX_WALK_DEPTH } from './caps.js';
import { getOutputSandbox, openSandboxFile, readExactly, resolveSandboxPath, ZIP_CONTAINER_EXTENSIONS } from './sandbox.js';

/** URI scheme + authority for sandboxed resources. */
export const RESOURCE_URI_PREFIX = 'zipnative://output/';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    '.zip': 'application/zip',
    '.jar': 'application/java-archive',
    '.war': 'application/java-archive',
    '.ear': 'application/java-archive',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.epub': 'application/epub+zip',
    '.vsix': 'application/zip',
    '.nupkg': 'application/zip',
    '.whl': 'application/zip',
    '.apk': 'application/vnd.android.package-archive',
    '.ipa': 'application/zip',
    '.xpi': 'application/x-xpinstall',
    '.crx': 'application/x-chrome-extension',
    '.kmz': 'application/vnd.google-earth.kmz',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
};

/** MIME type by extension (`application/octet-stream` when unknown). */
export function mimeTypeFor(filePath: string): string {
    return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** True when the extension names a ZIP container. */
export function isArchivePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return ZIP_CONTAINER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface ResourceDescriptor {
    readonly uri: string;
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly mimeType: string;
    readonly size: number;
}

export interface ResourceContents {
    readonly uri: string;
    readonly mimeType: string;
    readonly blob: string;
}

function uriForRelative(relative: string): string {
    return RESOURCE_URI_PREFIX + relative.split(path.sep).join('/');
}

/** Build the resource URI for an absolute file path if it lives inside the sandbox; otherwise `null`. */
export function resourceUriForPath(absPath: string): string | null {
    const sandbox = getOutputSandbox();
    if (sandbox === null) return null;
    const relative = path.relative(sandbox, absPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return uriForRelative(relative);
}

/** Build a `resource_link` descriptor for an absolute sandbox path, or `null` when outside the sandbox. */
export function resourceLinkForPath(absPath: string): { uri: string; name: string; title: string; mimeType: string } | null {
    const uri = resourceUriForPath(absPath);
    if (uri === null) return null;
    const relative = uri.slice(RESOURCE_URI_PREFIX.length);
    return { uri, name: relative, title: relative.split('/').pop() ?? relative, mimeType: mimeTypeFor(absPath) };
}

async function walkFiles(sandbox: string, dir: string, depth: number, out: string[]): Promise<void> {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_LISTED_RESOURCES) return;
    let entries: Dirent[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
        /* v8 ignore next 3 -- unreadable directory is skipped defensively. */
    } catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_LISTED_RESOURCES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(sandbox, full, depth + 1, out);
        } else if (entry.isFile()) {
            out.push(path.relative(sandbox, full));
        }
    }
}

/** List every sandboxed regular file as an MCP resource. Empty when the sandbox is disabled. */
export async function listResources(): Promise<ResourceDescriptor[]> {
    const sandbox = getOutputSandbox();
    if (sandbox === null) return [];
    const relatives: string[] = [];
    await walkFiles(sandbox, sandbox, 0, relatives);
    relatives.sort();

    const descriptors: ResourceDescriptor[] = [];
    for (const relative of relatives) {
        let size = 0;
        try {
            size = (await fs.stat(path.join(sandbox, relative))).size;
            /* v8 ignore next 1 -- racing deletion between walk and stat. */
        } catch { /* keep size 0 */ }
        const posix = relative.split(path.sep).join('/');
        const kind = isArchivePath(relative) ? 'Archive' : 'File';
        descriptors.push({
            uri: uriForRelative(relative),
            name: posix,
            title: path.basename(relative),
            description: `${kind} at ${posix} (${size} bytes) in the zipnative-mcp sandbox.`,
            mimeType: mimeTypeFor(relative),
            size,
        });
    }
    return descriptors;
}

/**
 * Read a `zipnative://output/<relative>` resource and return its bytes as a
 * base64 blob. Re-validates the path against the sandbox before reading.
 *
 * @throws {ToolError} `UNKNOWN_RESOURCE` for a bad scheme or a missing file;
 *         `SECURITY_VIOLATION` when the path escapes the sandbox;
 *         `OUTPUT_TOO_LARGE` when the file exceeds the read cap.
 */
export async function readResource(uri: string): Promise<ResourceContents> {
    if (!uri.startsWith(RESOURCE_URI_PREFIX)) {
        throw new ToolError('UNKNOWN_RESOURCE', `Unsupported resource URI: ${uri}`);
    }
    let relative: string;
    try {
        relative = decodeURIComponent(uri.slice(RESOURCE_URI_PREFIX.length));
    } catch {
        // A malformed percent-escape is a bad URI from the client (-32602), not an internal error (A-014).
        throw new ToolError('UNKNOWN_RESOURCE', `Malformed resource URI: ${uri}`);
    }
    if (relative.length === 0) {
        throw new ToolError('UNKNOWN_RESOURCE', 'Resource URI is missing a path.');
    }
    const resolved = resolveSandboxPath(relative, 'resource path');
    // One handle from the open to the last byte: the real-path check (a pre-planted junction /
    // symlink must not redirect a read outside the sandbox) is bound to the file actually read.
    const opened = await openSandboxFile(resolved, 'resource path');
    if (opened === 'absent' || opened === 'not-a-file') {
        throw new ToolError('UNKNOWN_RESOURCE', `No resource found at ${uri}.`);
    }
    try {
        if (opened.size > MAX_RESOURCE_READ_BYTES) {
            throw new ToolError('OUTPUT_TOO_LARGE', `Resource ${uri} (${opened.size} bytes) exceeds the maximum read size (${MAX_RESOURCE_READ_BYTES} bytes).`);
        }
        const bytes = await readExactly(opened.handle, opened.size, `resource ${uri}`);
        return { uri, mimeType: mimeTypeFor(resolved), blob: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') };
    } finally {
        await opened.handle.close();
    }
}

/** MCP resource template describing the sandbox address space (`resources/templates/list`). */
export interface ResourceTemplate {
    readonly uriTemplate: string;
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly mimeType: string;
}

/** Static resource-template list (RFC 6570 reserved expansion). Empty when the sandbox is disabled. */
export function listResourceTemplates(): ResourceTemplate[] {
    if (getOutputSandbox() === null) return [];
    return [
        {
            uriTemplate: `${RESOURCE_URI_PREFIX}{+path}`,
            name: 'sandbox-file',
            title: 'Sandbox file (archives and extracted files)',
            description:
                'An archive written by create_zip / modify_zip / canonicalize_zip / merge_zip, a file written by extract_zip or inflate_raw, or a file placed in the sandbox for zipPath / sourcePath, addressed by its path relative to ZIPNATIVE_MCP_OUTPUT_DIR. The template names the archive type; each resources/list entry carries the MIME type of its own extension. Enumerate concrete URIs with resources/list.',
            mimeType: 'application/zip',
        },
    ];
}
