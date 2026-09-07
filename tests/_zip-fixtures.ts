/**
 * Shared archive fixtures for the tool suites.
 *
 * Benign archives are built THROUGH THE ENGINE (createZip / createZipModifier)
 * so they exercise the real writer; hostile archives are built with the
 * engine-independent raw builder (`_fixtures/raw-zip-builder.ts`, vendored from
 * zipnative) so the reader is never tested only against our own writer —
 * the anti-circularity rule the engine's own test-suite follows.
 */
import { deflateRawSync } from 'node:zlib';
import { createZip, createZipModifier, openZip, type CreateZipOptions } from 'zipnative';

import { buildRawZip, type RawEntrySpec, type RawZipOptions } from './_fixtures/raw-zip-builder.js';

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

export function truncated(bytes: Uint8Array, keep: number): Uint8Array {
    return bytes.subarray(0, keep);
}

export function raw(entries: readonly RawEntrySpec[], options?: RawZipOptions): Uint8Array {
    return buildRawZip(entries, options);
}
