/**
 * zipnative-mcp — raw byte-level ZIP builder (veraZIP corpus)
 * ============================================================
 * Writes local headers, central directory, Zip64 records and the EOCD by
 * hand so the corpus generator can craft archives the engine must REFUSE
 * (spec-valid but hostile) and archives the validator must REJECT (crafted
 * negatives) without either being shaped by the engine under test.
 *
 * VENDORED from zipnative (the engine does not ship tests/ in its npm
 * tarball, so the builder is copied, not imported):
 *   upstream file:   tests/helpers/raw-zip-builder.ts
 *   upstream commit: 4f1bc3619372e8543bccea65d2365bf0c048a10c (zipnative 1.0.0)
 *   upstream blob:   e4b43d9d28f7bec4b50298cb144e87e0c009a77b
 *   via:             tests/_fixtures/raw-zip-builder.ts (this repo's typed copy
 *                    for the vitest fixtures) and zipnative-cli 1.0.0
 *                    scripts/generate-zip-corpus.mjs (whose inline writer is the
 *                    same builder with a local CRC-32 table). This module is the
 *                    plain-.mjs port: types erased, CRC-32 from a local table
 *                    (node:zlib.crc32 needs Node 22.2+; the engine floor is
 *                    22.0), deflate from node:zlib.
 *   sync rule:       when upstream's raw-zip-builder.ts changes, re-port 1:1 and
 *                    bump the blob hash above in the same PR.
 *                    tests/verazip-vendor.test.ts pins the hashes.
 *
 * INDEPENDENT BY CONSTRUCTION: node built-ins only. This module never
 * imports `zipnative`, `src/` or `dist/` — a crafted negative written by the
 * engine's own writer would prove nothing about the engine's reader, and a
 * hostile sample written by the engine could not be hostile in a way the
 * engine did not anticipate. Deterministic given identical specs.
 */

import { deflateRawSync } from 'node:zlib';

// ── CRC-32 (IEEE 802.3, polynomial 0xEDB88320) from a local table ────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
}

/** CRC-32 of `bytes` (the ZIP checksum), computed without the engine. */
export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const te = new TextEncoder();

function nameBytes(name) {
    return typeof name === 'string' ? te.encode(name) : name;
}

function u16(view, pos, value) {
    view.setUint16(pos, value, true);
}
function u32(view, pos, value) {
    view.setUint32(pos, value >>> 0, true);
}

/**
 * Build a complete ZIP archive from raw entry specs.
 *
 * Entry spec: `{ name (string | Uint8Array), data?, method? (0 = store,
 * 8 = deflate via node:zlib), flags?, dosTime?, dosDate?, extraLocal?,
 * extraCentral?, comment?, externalAttributes?, versionMadeBy?,
 * versionNeeded? }` plus the attack overrides — central directory:
 * `crcOverride`, `compressedSizeOverride`, `uncompressedSizeOverride`,
 * `localHeaderOffsetOverride`; local header: `lfhMethodOverride`,
 * `lfhCrcOverride`, `lfhNameOverride`, `corruptDataAt`; data descriptor:
 * `dataDescriptor` ('signed' | 'signless' | 'signed64' | 'signless64' —
 * sets bit 3 and zeroes the LFH crc/size fields while the CD keeps the REAL
 * values), `descriptorCrcOverride`, `descriptorCompressedSizeOverride`,
 * `descriptorUncompressedSizeOverride`.
 *
 * Options: `{ comment?, prepend? (SFX-stub simulation; stored offsets stay
 * inner-relative), append? (trailing garbage), forceZip64? (zip64 EOCD +
 * locator with sentinel classic fields), totalEntriesOverride?,
 * cdSizeOverride?, cdOffsetOverride?, zip64TotalEntriesOverride?,
 * zip64DropRecord? }`.
 */
export function buildRawZip(entries, options = {}) {
    const parts = [];
    let offset = 0;
    const centralRecords = [];

    for (const spec of entries) {
        const name = nameBytes(spec.name);
        const data = spec.data ?? new Uint8Array(0);
        const method = spec.method ?? 0;
        const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
        if (spec.corruptDataAt !== undefined && stored.length > spec.corruptDataAt) {
            stored[spec.corruptDataAt] ^= 0xff;
        }
        const crc = spec.crcOverride ?? crc32(data);
        const descriptorForm = spec.dataDescriptor;
        const flags = (spec.flags ?? 0) | (descriptorForm !== undefined ? 0x0008 : 0);
        const dosTime = spec.dosTime ?? 0;
        const dosDate = spec.dosDate ?? 0x0021;
        const extraLocal = spec.extraLocal ?? new Uint8Array(0);
        const extraCentral = spec.extraCentral ?? new Uint8Array(0);
        const comment = spec.comment ?? new Uint8Array(0);
        const versionNeeded = spec.versionNeeded ?? 20;

        const lfhName = spec.lfhNameOverride ?? name;
        const lfh = new Uint8Array(30 + lfhName.length + extraLocal.length);
        const lv = new DataView(lfh.buffer);
        u32(lv, 0, 0x04034b50);
        u16(lv, 4, versionNeeded);
        u16(lv, 6, flags);
        u16(lv, 8, spec.lfhMethodOverride ?? method);
        u16(lv, 10, dosTime);
        u16(lv, 12, dosDate);
        u32(lv, 14, descriptorForm !== undefined ? 0 : (spec.lfhCrcOverride ?? crc));
        u32(lv, 18, descriptorForm !== undefined ? 0 : stored.length);
        u32(lv, 22, descriptorForm !== undefined ? 0 : data.length);
        u16(lv, 26, lfhName.length);
        u16(lv, 28, extraLocal.length);
        lfh.set(lfhName, 30);
        lfh.set(extraLocal, 30 + lfhName.length);

        const cfh = new Uint8Array(46 + name.length + extraCentral.length + comment.length);
        const cv = new DataView(cfh.buffer);
        u32(cv, 0, 0x02014b50);
        u16(cv, 4, spec.versionMadeBy ?? 0x031e);
        u16(cv, 6, versionNeeded);
        u16(cv, 8, flags);
        u16(cv, 10, method);
        u16(cv, 12, dosTime);
        u16(cv, 14, dosDate);
        u32(cv, 16, crc);
        u32(cv, 20, spec.compressedSizeOverride ?? stored.length);
        u32(cv, 24, spec.uncompressedSizeOverride ?? data.length);
        u16(cv, 28, name.length);
        u16(cv, 30, extraCentral.length);
        u16(cv, 32, comment.length);
        u16(cv, 34, 0);
        u16(cv, 36, 0);
        u32(cv, 38, spec.externalAttributes ?? 0);
        u32(cv, 42, spec.localHeaderOffsetOverride ?? offset);
        cfh.set(name, 46);
        cfh.set(extraCentral, 46 + name.length);
        cfh.set(comment, 46 + name.length + extraCentral.length);
        centralRecords.push(cfh);

        parts.push(lfh, stored);
        offset += lfh.length + stored.length;

        if (descriptorForm !== undefined) {
            const dCrc = spec.descriptorCrcOverride ?? crc;
            const dCsize = spec.descriptorCompressedSizeOverride ?? stored.length;
            const dUsize = spec.descriptorUncompressedSizeOverride ?? data.length;
            const signed = descriptorForm.startsWith('signed');
            const wide = descriptorForm.endsWith('64');
            const descriptor = new Uint8Array((signed ? 4 : 0) + 4 + (wide ? 16 : 8));
            const dvd = new DataView(descriptor.buffer);
            let pos = 0;
            if (signed) {
                u32(dvd, 0, 0x08074b50);
                pos = 4;
            }
            u32(dvd, pos, dCrc);
            if (wide) {
                dvd.setBigUint64(pos + 4, BigInt(dCsize), true);
                dvd.setBigUint64(pos + 12, BigInt(dUsize), true);
            } else {
                u32(dvd, pos + 4, dCsize);
                u32(dvd, pos + 8, dUsize);
            }
            parts.push(descriptor);
            offset += descriptor.length;
        }
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const record of centralRecords) {
        parts.push(record);
        cdSize += record.length;
        offset += record.length;
    }

    const comment = options.comment ?? new Uint8Array(0);
    const totalEntries = options.totalEntriesOverride ?? entries.length;
    const cdSizeField = options.cdSizeOverride ?? cdSize;
    const cdOffsetField = options.cdOffsetOverride ?? cdOffset;

    if (options.forceZip64 === true) {
        const z64Pos = offset;
        if (options.zip64DropRecord !== true) {
            const z64 = new Uint8Array(56);
            const zv = new DataView(z64.buffer);
            u32(zv, 0, 0x06064b50);
            zv.setBigUint64(4, 44n, true);            // size of remainder
            u16(zv, 12, 0x032d);
            u16(zv, 14, 45);
            u32(zv, 16, 0);
            u32(zv, 20, 0);
            zv.setBigUint64(24, BigInt(options.zip64TotalEntriesOverride ?? totalEntries), true);
            zv.setBigUint64(32, BigInt(options.zip64TotalEntriesOverride ?? totalEntries), true);
            zv.setBigUint64(40, BigInt(cdSizeField), true);
            zv.setBigUint64(48, BigInt(cdOffsetField), true);
            parts.push(z64);
            offset += 56;
        }
        const locator = new Uint8Array(20);
        const lv2 = new DataView(locator.buffer);
        u32(lv2, 0, 0x07064b50);
        u32(lv2, 4, 0);
        lv2.setBigUint64(8, BigInt(z64Pos), true);
        u32(lv2, 16, 1);
        parts.push(locator);
        offset += 20;
    }

    const eocd = new Uint8Array(22 + comment.length);
    const ev = new DataView(eocd.buffer);
    u32(ev, 0, 0x06054b50);
    u16(ev, 4, 0);
    u16(ev, 6, 0);
    const sentinel = options.forceZip64 === true;
    u16(ev, 8, sentinel ? 0xffff : totalEntries);
    u16(ev, 10, sentinel ? 0xffff : totalEntries);
    u32(ev, 12, sentinel ? 0xffffffff : cdSizeField);
    u32(ev, 16, sentinel ? 0xffffffff : cdOffsetField);
    u16(ev, 20, comment.length);
    eocd.set(comment, 22);
    parts.push(eocd);

    // Assemble: prepend + inner archive (inner-relative offsets) + append.
    const prepend = options.prepend ?? new Uint8Array(0);
    const append = options.append ?? new Uint8Array(0);
    const innerLength = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(prepend.length + innerLength + append.length);
    out.set(prepend, 0);
    let pos = prepend.length;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    out.set(append, pos);
    return out;
}

/** Build an extra-field block from `{ id, data }` pairs. */
export function buildExtraField(fields) {
    const total = fields.reduce((sum, f) => sum + 4 + f.data.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const f of fields) {
        view.setUint16(pos, f.id, true);
        view.setUint16(pos + 2, f.data.length, true);
        out.set(f.data, pos + 4);
        pos += 4 + f.data.length;
    }
    return out;
}
