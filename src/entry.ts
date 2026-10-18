/**
 * One JSON view of an archive entry, shared by `list_zip_entries`,
 * `read_zip_entry`, `extract_zip` and `scan_zip_forward`. Vendored from
 * zipnative-cli `src/utils/entryfmt.ts` so an agent that knows the CLI's
 * `--json` rows reads the same field names here: flags decoded through the
 * engine's `FLAG_*` masks, `methodName`, CRC as 8-hex, unix mode as octal,
 * named extra fields, plus the sanitised path the extraction sink would use.
 */
import {
    FLAG_DATA_DESCRIPTOR,
    FLAG_ENCRYPTED,
    FLAG_STRONG_ENCRYPTION,
    FLAG_UTF8,
    METHOD_DEFLATE,
    METHOD_STORE,
    getCodec,
    getUnixMode,
    isSymlinkEntry,
    sanitizeEntryPath,
    type StreamedZipHeader,
    type ZipEntry,
    type ZipExtraField,
    type ZipNameEncoding,
} from 'zipnative';

export interface DecodedFlags {
    readonly raw: number;
    readonly encrypted: boolean;
    readonly dataDescriptor: boolean;
    readonly strongEncryption: boolean;
    readonly utf8: boolean;
}

export interface ExtraFieldRow {
    readonly id: number;
    readonly idHex: string;
    readonly name: string | null;
    readonly length: number;
    /** Present with `includeExtraData: true`. */
    readonly dataBase64?: string;
}

/** The per-entry JSON row (the CLI's `schema entries` shape, `long` form). */
export interface EntryView {
    readonly index: number;
    readonly name: string;
    /** `'custom'` (zipnative 1.1.0) only ever comes from a `nameDecoder`, which this server does not expose. */
    readonly nameEncoding: ZipNameEncoding;
    readonly isDirectory: boolean;
    /** `null` from a forward scan (no central-directory attributes). */
    readonly isSymlink: boolean | null;
    readonly method: number;
    readonly methodName: string;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly ratio: string;
    readonly crc32: string;
    readonly lastModified: string;
    readonly isEncrypted: boolean;
    /** `null` from a forward scan. */
    readonly usesZip64: boolean | null;
    readonly usesDataDescriptor: boolean;
    readonly unixMode: string | null;
    /** The path the secure extraction sink would use, or `null` when the name cannot be made safe. */
    readonly sanitizedPath: string | null;
    readonly comment?: string;
    readonly flags: DecodedFlags;
    readonly versionMadeBy?: number;
    readonly versionNeeded: number;
    readonly hostSystem?: string;
    readonly internalAttributes?: number;
    readonly externalAttributes?: number;
    readonly localHeaderOffset?: number;
    readonly dosDate: number;
    readonly dosTime: number;
    readonly extraFields: readonly ExtraFieldRow[];
    /** The stored name bytes, hex — forensics for cp437 / invalid UTF-8 names. */
    readonly rawNameHex: string;
    /** The stored comment bytes, hex (present when the entry has a comment). */
    readonly commentHex?: string;
}

const EXTRA_FIELD_NAMES: Readonly<Record<number, string>> = {
    0x0001: 'Zip64 extended information',
    0x0007: 'AV info',
    0x0008: 'Extended language encoding',
    0x0009: 'OS/2',
    0x000a: 'NTFS',
    0x000c: 'OpenVMS',
    0x000d: 'UNIX',
    0x000e: 'File stream and fork descriptors',
    0x000f: 'Patch descriptor',
    0x0014: 'PKCS#7 store',
    0x0015: 'X.509 certificate ID (file)',
    0x0016: 'X.509 certificate ID (CD)',
    0x0017: 'Strong encryption header',
    0x0018: 'Record management controls',
    0x0019: 'PKCS#7 encryption recipient list',
    0x0065: 'IBM S/390 attributes',
    0x4690: 'POSZIP 4690',
    0x5455: 'Extended timestamp (UT)',
    0x5855: 'Info-ZIP UNIX (original)',
    0x6375: 'Info-ZIP Unicode comment',
    0x7075: 'Info-ZIP Unicode path',
    0x7855: 'Info-ZIP UNIX (new)',
    0x7875: 'Info-ZIP UNIX (uid/gid)',
    0x9901: 'AES encryption (WinZip)',
    0xa220: 'Microsoft Open Packaging growth hint',
};

/** APPNOTE 4.4.2.2 host systems (upper byte of `versionMadeBy`). */
const HOST_SYSTEMS: Readonly<Record<number, string>> = {
    0: 'ms-dos', 1: 'amiga', 2: 'openvms', 3: 'unix', 4: 'vm-cms', 5: 'atari-st', 6: 'os2-hpfs',
    7: 'macintosh', 8: 'z-system', 9: 'cp-m', 10: 'ntfs', 11: 'mvs', 12: 'vse', 13: 'acorn-risc',
    14: 'vfat', 15: 'alternate-mvs', 16: 'beos', 17: 'tandem', 18: 'os400', 19: 'darwin',
};

export function decodeFlags(flags: number): DecodedFlags {
    return {
        raw: flags,
        encrypted: (flags & FLAG_ENCRYPTED) !== 0,
        dataDescriptor: (flags & FLAG_DATA_DESCRIPTOR) !== 0,
        strongEncryption: (flags & FLAG_STRONG_ENCRYPTION) !== 0,
        utf8: (flags & FLAG_UTF8) !== 0,
    };
}

export function methodName(method: number): string {
    if (method === METHOD_STORE) return 'store';
    if (method === METHOD_DEFLATE) return 'deflate';
    const codec = getCodec(method);
    return codec !== null ? codec.name : `method-${method}`;
}

export function crcHex(crc: number): string {
    return (crc >>> 0).toString(16).padStart(8, '0');
}

export function bytesToHex(raw: Uint8Array): string {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('hex');
}

const utf8Lossy = new TextDecoder('utf-8');

/** Decode a raw comment leniently (invalid sequences become U+FFFD; the hex form keeps the truth). */
export function decodeComment(raw: Uint8Array): string {
    return raw.length === 0 ? '' : utf8Lossy.decode(raw);
}

/** Percentage saved, the CLI's `ratio` string. */
export function formatRatio(compressed: number, uncompressed: number): string {
    if (uncompressed === 0) return '0%';
    return `${Math.max(0, Math.round(100 - (compressed / uncompressed) * 100))}%`;
}

/** Four octal digits: permission bits plus the setuid/setgid/sticky digit ("0644", "4755"). */
function octal(mode: number): string {
    return (mode & 0o7777).toString(8).padStart(4, '0');
}

function extraRows(fields: readonly ZipExtraField[], withData: boolean): ExtraFieldRow[] {
    return fields.map((f) => ({
        id: f.id,
        idHex: '0x' + f.id.toString(16).padStart(4, '0'),
        name: EXTRA_FIELD_NAMES[f.id] ?? null,
        length: f.data.length,
        ...(withData ? { dataBase64: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength).toString('base64') } : {}),
    }));
}

/** Directory names are checked without their trailing slash, like the extraction sink. */
export function sanitizedPathOf(name: string, isDirectory: boolean): string | null {
    return sanitizeEntryPath(isDirectory && name.endsWith('/') ? name.slice(0, -1) : name);
}

export interface EntryViewOptions {
    readonly includeExtraData?: boolean;
}

/** View from a central-directory entry (full metadata). */
export function viewFromEntry(entry: ZipEntry, index: number, options: EntryViewOptions = {}): EntryView {
    const mode = getUnixMode(entry);
    const comment = decodeComment(entry.comment);
    return {
        index,
        name: entry.name,
        nameEncoding: entry.nameEncoding,
        isDirectory: entry.isDirectory,
        isSymlink: isSymlinkEntry(entry),
        method: entry.compressionMethod,
        methodName: methodName(entry.compressionMethod),
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        ratio: formatRatio(entry.compressedSize, entry.uncompressedSize),
        crc32: crcHex(entry.crc32),
        lastModified: entry.lastModified.toISOString(),
        isEncrypted: entry.isEncrypted,
        usesZip64: entry.usesZip64,
        usesDataDescriptor: entry.usesDataDescriptor,
        unixMode: mode === null ? null : octal(mode),
        sanitizedPath: sanitizedPathOf(entry.name, entry.isDirectory),
        ...(comment.length > 0 ? { comment } : {}),
        flags: decodeFlags(entry.flags),
        versionMadeBy: entry.versionMadeBy,
        versionNeeded: entry.versionNeeded,
        hostSystem: HOST_SYSTEMS[entry.versionMadeBy >> 8] ?? `host-${entry.versionMadeBy >> 8}`,
        internalAttributes: entry.internalAttributes,
        externalAttributes: entry.externalAttributes,
        localHeaderOffset: entry.localHeaderOffset,
        dosDate: entry.dosDate,
        dosTime: entry.dosTime,
        extraFields: extraRows(entry.extraFields, options.includeExtraData === true),
        rawNameHex: bytesToHex(entry.rawName),
        ...(entry.comment.length > 0 ? { commentHex: bytesToHex(entry.comment) } : {}),
    };
}

/** View from a forward-streamed local header (no central-directory-only fields). */
export function viewFromHeader(header: StreamedZipHeader, index: number, options: EntryViewOptions = {}): EntryView {
    return {
        index,
        name: header.name,
        nameEncoding: header.nameEncoding,
        isDirectory: header.isDirectory,
        isSymlink: null,
        method: header.compressionMethod,
        methodName: methodName(header.compressionMethod),
        compressedSize: header.compressedSize,
        uncompressedSize: header.uncompressedSize,
        ratio: formatRatio(header.compressedSize, header.uncompressedSize),
        crc32: crcHex(header.crc32),
        lastModified: header.lastModified.toISOString(),
        isEncrypted: header.isEncrypted,
        usesZip64: null,
        usesDataDescriptor: (header.flags & FLAG_DATA_DESCRIPTOR) !== 0,
        unixMode: null,
        sanitizedPath: sanitizedPathOf(header.name, header.isDirectory),
        flags: decodeFlags(header.flags),
        versionNeeded: header.versionNeeded,
        dosDate: header.dosDate,
        dosTime: header.dosTime,
        extraFields: extraRows(header.extraFields, options.includeExtraData === true),
        rawNameHex: bytesToHex(header.rawName),
    };
}

/** JSON Schema of one {@link EntryView} (every property optional: rows are projectable). */
export const ENTRY_VIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        index: { type: 'integer', minimum: 0, description: 'Position in the central directory (or in the forward scan).' },
        name: { type: 'string' },
        nameEncoding: { type: 'string', enum: ['utf-8', 'cp437', 'custom'] },
        isDirectory: { type: 'boolean' },
        isSymlink: { type: ['boolean', 'null'], description: 'Unix mode S_IFLNK; null from a forward scan.' },
        method: { type: 'integer', description: 'Compression method id (0 store, 8 deflate).' },
        methodName: { type: 'string' },
        compressedSize: { type: 'integer', minimum: 0 },
        uncompressedSize: { type: 'integer', minimum: 0 },
        ratio: { type: 'string', description: "Percentage saved, e.g. '63%'." },
        crc32: { type: 'string', description: 'CRC-32 of the uncompressed data, 8 lowercase hex digits.' },
        lastModified: { type: 'string', description: 'ISO-8601 (DOS time has 2-second granularity; UT extra refines it).' },
        isEncrypted: { type: 'boolean' },
        usesZip64: { type: ['boolean', 'null'] },
        usesDataDescriptor: { type: 'boolean' },
        unixMode: { type: ['string', 'null'], description: "Octal permission bits when Unix-authored ('0644'), else null." },
        sanitizedPath: { type: ['string', 'null'], description: 'The relative path a secure extraction would use; null when the name cannot be made safe (traversal, absolute, drive/UNC, NUL, ADS, device name).' },
        comment: { type: 'string' },
        flags: {
            type: 'object',
            additionalProperties: false,
            properties: {
                raw: { type: 'integer' },
                encrypted: { type: 'boolean' },
                dataDescriptor: { type: 'boolean' },
                strongEncryption: { type: 'boolean' },
                utf8: { type: 'boolean' },
            },
        },
        versionMadeBy: { type: 'integer' },
        versionNeeded: { type: 'integer' },
        hostSystem: { type: 'string' },
        internalAttributes: { type: 'integer' },
        externalAttributes: { type: 'integer' },
        localHeaderOffset: { type: 'integer', minimum: 0 },
        dosDate: { type: 'integer' },
        dosTime: { type: 'integer' },
        extraFields: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'integer' },
                    idHex: { type: 'string' },
                    name: { type: ['string', 'null'] },
                    length: { type: 'integer', minimum: 0 },
                    dataBase64: { type: 'string' },
                },
            },
        },
        rawNameHex: { type: 'string' },
        commentHex: { type: 'string' },
    },
} as const;
