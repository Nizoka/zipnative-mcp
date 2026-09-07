/**
 * Shared archive fixtures for the tool suites.
 *
 * Benign archives are built THROUGH THE ENGINE (createZip / createZipModifier)
 * so they exercise the real writer; hostile archives are built with the
 * engine-independent raw builder (`_fixtures/raw-zip-builder.ts`, vendored from
 * zipnative) so the reader is never tested only against our own writer —
 * the anti-circularity rule the engine's own test-suite follows.
 */
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { createZip, createZipModifier, openZip, type CreateZipOptions } from 'zipnative';

import { buildExtraField, buildRawZip, type RawEntrySpec, type RawZipOptions } from './_fixtures/raw-zip-builder.js';

const te = new TextEncoder();

export function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function bytesOf(text: string): Uint8Array {
    return te.encode(text);
}

/** A small text archive: README.md, src/index.js, docs/guide.md, a directory entry. */
export function basicZip(options: CreateZipOptions = {}): Uint8Array {
    const w = createZip({ onDiagnostic: () => undefined, ...options });
    w.add('README.md', '# Hello\n\nA small archive for the tests.\n');
    w.add('src/index.js', 'export const answer = 42;\n');
    w.add('docs/guide.md', '# Guide\n' + 'lorem ipsum dolor sit amet '.repeat(40) + '\n');
    w.addDirectory('assets');
    return w.toBytes();
}

/** Same content as basicZip but with an archive comment, entry comments, a unix mode and a pinned date. */
export function richZip(): Uint8Array {
    const w = createZip({ comment: 'archive comment — ünïcödé', onDiagnostic: () => undefined });
    w.add('README.md', '# Hello\n', { comment: 'entry comment', date: new Date(Date.UTC(2024, 5, 1, 12, 34, 56)) });
    w.add('bin/run.sh', '#!/bin/sh\necho hi\n', { externalAttributes: ((0o100755 << 16) >>> 0) });
    w.add('café/résumé.txt', 'unicode names', { extraFields: [{ id: 0x6a6a, data: new Uint8Array([1, 2, 3]) }] });
    w.add('empty.txt', new Uint8Array(0));
    w.addDirectory('assets', { externalAttributes: ((0o40755 << 16) >>> 0) | 0x10 });
    return w.toBytes();
}

/** A 1 MiB of zeros entry (deflate) — high ratio, useful for limits tests. */
export function highRatioZip(): Uint8Array {
    const w = createZip({ onDiagnostic: () => undefined });
    w.add('zeros.bin', new Uint8Array(1024 * 1024));
    w.add('small.txt', 'x');
    return w.toBytes();
}

/** An archive written with the streaming (data-descriptor) layout. */
export async function streamedZip(): Promise<Uint8Array> {
    const w = createZip({ onDiagnostic: () => undefined });
    async function* source(text: string): AsyncGenerator<Uint8Array, void, undefined> {
        yield te.encode(text.slice(0, 5));
        yield te.encode(text.slice(5));
    }
    w.addStream('streamed/a.txt', source('hello streamed world '.repeat(50)));
    w.add('buffered.txt', 'plain');
    const parts: Uint8Array[] = [];
    for await (const chunk of w.stream()) parts.push(chunk);
    return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
}

/** Append-mode incremental save with dead bytes (a replaced entry). */
export function incrementalZip(): { original: Uint8Array; appended: Uint8Array; compacted: Uint8Array } {
    const original = basicZip();
    const m1 = createZipModifier(openZip(original, { onDiagnostic: () => undefined }), { onDiagnostic: () => undefined });
    m1.replaceEntry('README.md', '# Replaced\n');
    m1.addEntry('new.txt', 'added');
    const appended = m1.save();
    const m2 = createZipModifier(openZip(original, { onDiagnostic: () => undefined }), { onDiagnostic: () => undefined });
    m2.removeEntry('docs/guide.md');
    const compacted = m2.saveCompact();
    return { original, appended, compacted };
}

/** An archive with 70 000 tiny entries (Zip64 central-directory count). Slow: build lazily. */
export function zip64ManyEntries(count = 70_000): Uint8Array {
    const w = createZip({ onDiagnostic: () => undefined });
    const data = new Uint8Array([0x41]);
    for (let i = 0; i < count; i++) w.add(`e/${i.toString(36)}`, data);
    return w.toBytes();
}

// ── Hostile archives (raw builder — engine-independent) ─────────────

export const ZIP_SLIP = (): Uint8Array => buildRawZip([{ name: '../../evil.txt', data: bytesOf('evil') }]);
export const DEVICE_NAME = (): Uint8Array => buildRawZip([{ name: 'aux.txt', data: bytesOf('device') }, { name: 'ok.txt', data: bytesOf('ok') }]);
export const DUPLICATE_PATHS = (): Uint8Array => buildRawZip([{ name: 'dup.txt', data: bytesOf('first') }, { name: './dup.txt', data: bytesOf('second') }]);
export const SYMLINK = (): Uint8Array => buildRawZip([{ name: 'link', data: bytesOf('/etc/passwd'), externalAttributes: (0o120777 << 16) >>> 0 }, { name: 'ok.txt', data: bytesOf('ok') }]);
export const OVERLAP = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('aaaa') }, { name: 'b.txt', data: bytesOf('bbbb'), localHeaderOffsetOverride: 0 }]);
export const CD_MISMATCH = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a') }], { totalEntriesOverride: 9 });
export const DECLARED_BOMB = (): Uint8Array => buildRawZip([{ name: 'bomb.bin', data: deflateRawSync(new Uint8Array(4096)), method: 8, uncompressedSizeOverride: 2 * 1024 * 1024 * 1024 }], {});
export const LFH_NAME_MISMATCH = (): Uint8Array => buildRawZip([{ name: 'central.txt', data: bytesOf('x'), lfhNameOverride: bytesOf('locallll.txt') }]);
export const LFH_METHOD_MISMATCH = (): Uint8Array => buildRawZip([{ name: 'm.txt', data: bytesOf('mmmm'), lfhMethodOverride: 8 }]);
export const CRC_OVERRIDE = (): Uint8Array => buildRawZip([{ name: 'c.txt', data: bytesOf('crc'), crcOverride: 0xdeadbeef, lfhCrcOverride: 0xdeadbeef }]);
export const TRAILING_GARBAGE = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a') }], { append: new Uint8Array(70_000) });
export const SFX_PREFIXED = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('sfx') }], { prepend: bytesOf('MZ-STUB-'.repeat(64)) });
export const ENCRYPTED_FLAG = (): Uint8Array => buildRawZip([{ name: 'secret.txt', data: bytesOf('secret'), flags: 0x0001 }, { name: 'ok.txt', data: bytesOf('ok') }]);
export const UNKNOWN_METHOD = (): Uint8Array => buildRawZip([{ name: 'w.bin', data: bytesOf('w'), method: 93 }]);
export const STORE_DESCRIPTOR = (): Uint8Array => buildRawZip([{ name: 'sd.txt', data: bytesOf('stored with descriptor'), dataDescriptor: 'signed' }]);
export const DEFLATE_DESCRIPTOR = (): Uint8Array => buildRawZip([{ name: 'dd.txt', data: bytesOf('deflated with descriptor '.repeat(20)), method: 8, dataDescriptor: 'signed' }]);
export const CORRUPT_DEFLATE = (): Uint8Array => buildRawZip([{ name: 'bad.txt', data: bytesOf('some compressible text '.repeat(64)), method: 8, corruptDataAt: 3 }]);
export const INVALID_UTF8_NAME = (): Uint8Array => buildRawZip([{ name: new Uint8Array([0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]), data: bytesOf('x'), flags: 0x0800 }]);
export const CP437_NAME = (): Uint8Array => buildRawZip([{ name: new Uint8Array([0x82, 0x2e, 0x74, 0x78, 0x74]), data: bytesOf('x') }]);
export const MULTI_DISK = (): Uint8Array => {
    const bytes = buildRawZip([{ name: 'a.txt', data: bytesOf('a') }]);
    // Patch the EOCD "number of this disk" field (offset +4 from the EOCD signature).
    const eocd = bytes.length - 22;
    bytes[eocd + 4] = 1;
    return bytes;
};
export const ZIP64_FORCED = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a') }], { forceZip64: true });
export const ZIP64_DROPPED = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a') }], { forceZip64: true, zip64DropRecord: true });
/** Zip64 EOCD (count 1) with the classic EOCD counts patched to a NON-sentinel 5: a parser-differential archive (ZIP_ZIP64_CONTRADICTION). */
export const ZIP64_CONTRADICTION = (): Uint8Array => {
    const bytes = ZIP64_FORCED();
    const eocd = bytes.length - 22;
    bytes[eocd + 8] = 5;
    bytes[eocd + 9] = 0;
    bytes[eocd + 10] = 5;
    bytes[eocd + 11] = 0;
    return bytes;
};
/** Zip64 EOCD declaring 2^60 entries — above Number.MAX_SAFE_INTEGER (ZIP_VALUE_UNREPRESENTABLE). */
export const ZIP64_HUGE_COUNT = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a') }], { forceZip64: true, zip64TotalEntriesOverride: 2 ** 60 });
/** A central 0x7075 Unicode Path extra (version 1, CRC of the header name) naming a DIFFERENT file (ZIP_UNICODE_PATH_CONFLICT). */
export const UNICODE_PATH_CONFLICT = (): Uint8Array => {
    const unicodeName = bytesOf('other.txt');
    const data = new Uint8Array(5 + unicodeName.length);
    data[0] = 1;
    new DataView(data.buffer).setUint32(1, zlibCrc32(Buffer.from('a.txt')), true);
    data.set(unicodeName, 5);
    return buildRawZip([{ name: 'a.txt', data: bytesOf('a'), extraCentral: buildExtraField([{ id: 0x7075, data }]) }]);
};
/** A central extra block whose header declares 16 bytes but holds 2 (ZIP_EXTRA_FIELD_MALFORMED). */
export const MALFORMED_EXTRA = (): Uint8Array => buildRawZip([{ name: 'a.txt', data: bytesOf('a'), extraCentral: new Uint8Array([0x6a, 0x6a, 0x10, 0x00, 0x01, 0x02]) }]);
/** A 0x0001 Zip64 extra supplying a size for classic fields that are NOT sentinels (ZIP_ZIP64_EXTRA_IGNORED). */
export const ZIP64_EXTRA_IGNORED = (): Uint8Array => {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setBigUint64(0, 1n, true);
    return buildRawZip([{ name: 'a.txt', data: bytesOf('a'), extraCentral: buildExtraField([{ id: 0x0001, data }]) }]);
};
/** Two entries with the same name (ZIP_DUPLICATE_NAME on a name-keyed lookup; the last one wins). */
export const DUPLICATE_NAME = (): Uint8Array => buildRawZip([{ name: 'a', data: bytesOf('first') }, { name: 'a', data: bytesOf('second') }]);
/** An entry flagged both encrypted (bit 0) and strong-encryption (bit 6). */
export const STRONG_ENCRYPTION_FLAG = (): Uint8Array => buildRawZip([{ name: 'aes.bin', data: bytesOf('x'), flags: 0x0001 | 0x0040 }, { name: 'ok.txt', data: bytesOf('ok') }]);
/** An entry whose central directory carries an Info-ZIP extended timestamp (UT, 0x5455) with `mtime`. */
export const UT_TIMESTAMP_MTIME = 1_700_000_000;
export const UT_TIMESTAMP = (): Uint8Array => {
    const data = new Uint8Array(5);
    data[0] = 0x01; // flags: mtime present
    new DataView(data.buffer).setUint32(1, UT_TIMESTAMP_MTIME, true);
    return buildRawZip([{ name: 'ut.txt', data: bytesOf('ut'), extraCentral: buildExtraField([{ id: 0x5455, data }]), extraLocal: buildExtraField([{ id: 0x5455, data }]) }]);
};
/** The second entry's central-directory offset points INTO the central directory (an entry reaching past its own data). */
export const OFFSET_INTO_CD = (): Uint8Array => {
    const entries = [{ name: 'a.txt', data: bytesOf('aaaa') }, { name: 'b.txt', data: bytesOf('bbbb') }];
    const plain = buildRawZip(entries);
    const cdStart = Buffer.from(plain).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    return buildRawZip([entries[0]!, { ...entries[1]!, localHeaderOffsetOverride: cdStart }]);
};

/**
 * Every hostile fixture above, by name — the set a "never isError for an
 * archive problem" contract is checked against.
 */
export const HOSTILE_FIXTURES: Readonly<Record<string, () => Uint8Array>> = {
    ZIP_SLIP, DEVICE_NAME, DUPLICATE_PATHS, SYMLINK, OVERLAP, CD_MISMATCH, DECLARED_BOMB, LFH_NAME_MISMATCH, LFH_METHOD_MISMATCH, CRC_OVERRIDE,
    TRAILING_GARBAGE, SFX_PREFIXED, ENCRYPTED_FLAG, UNKNOWN_METHOD, STORE_DESCRIPTOR, DEFLATE_DESCRIPTOR, CORRUPT_DEFLATE, INVALID_UTF8_NAME, CP437_NAME,
    MULTI_DISK, ZIP64_FORCED, ZIP64_DROPPED, ZIP64_CONTRADICTION, ZIP64_HUGE_COUNT, UNICODE_PATH_CONFLICT, MALFORMED_EXTRA, ZIP64_EXTRA_IGNORED,
    DUPLICATE_NAME, STRONG_ENCRYPTION_FLAG, UT_TIMESTAMP, OFFSET_INTO_CD,
};

export function truncated(bytes: Uint8Array, keep: number): Uint8Array {
    return bytes.subarray(0, keep);
}

/** Offset of the central directory as the EOCD declares it (the raw builder emits no prefix unless asked). */
export function centralDirectoryOffset(bytes: Uint8Array): number {
    const eocd = bytes.length - 22;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(eocd + 16, true);
}

export function raw(entries: readonly RawEntrySpec[], options?: RawZipOptions): Uint8Array {
    return buildRawZip(entries, options);
}
