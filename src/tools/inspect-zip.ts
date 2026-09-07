/**
 * Tool: inspect_zip — archive facts, per-method statistics, a determinism
 * verdict, every diagnostic the parse emitted, and optional CI assertions.
 * Opens the archive EAGERLY by default (every local header cross-checked,
 * overlap table built up front) so a hostile archive is refused here rather
 * than silently summarised. The report shape mirrors `zipnative inspect --json`.
 */
import { z } from 'zod';
import { FLAG_UTF8, METHOD_DEFLATE, METHOD_STORE, isSymlinkEntry, openZip, type ZipEntry } from 'zipnative';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES, type DiagnosticsReport } from '../diagnostics.js';
import { bytesToHex, decodeComment, formatRatio, methodName, sanitizedPathOf } from '../entry.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { guard } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, ProjectionShape, STRICT_INPUT_PROPERTY } from './_shared.js';

export const INSPECT_ZIP_NAME = 'inspect_zip';

const DOS_EPOCH_DATE = 0x0021; // 1980-01-01
const DOS_EPOCH_TIME = 0x0000;

/** The CLI's `--check` vocabulary (simple assertions). */
export const INSPECT_CHECKS = [
    'deterministic', 'epoch-timestamps', 'canonical-order', 'utf8-names', 'no-data-descriptor',
    'canonical-layout', 'no-zip64', 'zip64', 'no-encryption', 'no-symlinks', 'safe-names', 'no-duplicates',
    'no-diagnostics', 'store-only', 'deflate-only',
] as const;

export const INSPECT_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        validate: {
            type: 'string',
            enum: ['eager', 'lazy'],
            default: 'eager',
            description: "'eager' (default) cross-checks every local header and the overlap table up front — hostile shapes are refused here; 'lazy' defers to first read (cheaper on huge archives).",
        },
        check: {
            type: 'array',
            maxItems: 15,
            items: { type: 'string', enum: [...INSPECT_CHECKS] },
            description: "CI assertions evaluated over the report: deterministic, epoch-timestamps, canonical-order, utf8-names, no-data-descriptor, canonical-layout, no-zip64, zip64, no-encryption, no-symlinks, safe-names, no-duplicates, no-diagnostics, store-only, deflate-only. Result: `checks[]` + `checksPassed`.",
        },
        assert: {
            type: 'object',
            additionalProperties: false,
            description: 'Parametrised assertions (each becomes a `checks[]` row).',
            properties: {
                maxEntries: { type: 'integer', minimum: 0, description: 'The archive must hold at most this many entries.' },
                minEntries: { type: 'integer', minimum: 0, description: 'The archive must hold at least this many entries.' },
                maxUncompressedBytes: { type: 'integer', minimum: 0, description: 'Sum of the declared uncompressed sizes must not exceed this.' },
                maxRatio: { type: 'number', minimum: 1, description: 'Worst per-entry uncompressed/compressed ratio allowed.' },
                has: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1 }, description: 'Entry names that must be present (exact).' },
                method: { type: 'string', enum: ['store', 'deflate'], description: 'Every entry must use this method.' },
            },
        },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...PROJECTION_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        validate: z.enum(['eager', 'lazy']).default('eager'),
        check: z.array(z.enum(INSPECT_CHECKS)).max(15).optional(),
        assert: z
            .strictObject({
                maxEntries: z.number().int().min(0).optional(),
                minEntries: z.number().int().min(0).optional(),
                maxUncompressedBytes: z.number().int().min(0).optional(),
                maxRatio: z.number().min(1).optional(),
                has: z.array(z.string().min(1)).max(100).optional(),
                method: z.enum(['store', 'deflate']).optional(),
            })
            .optional(),
        ...EngineOptionsShape,
        ...ProjectionShape,
    })
    .superRefine(refineArchiveInput);

export interface CheckResult {
    readonly check: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface InspectZipResult extends DiagnosticsReport {
    readonly archiveBytes: number;
    readonly entryCount: number;
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly isZip64: boolean;
    readonly comment: string;
    readonly commentBytes: number;
    readonly commentHex?: string;
    readonly prependedData: boolean;
    readonly multipleEocd: boolean;
    readonly compressedBytes: number;
    readonly uncompressedBytes: number;
    readonly ratio: string;
    readonly methods: ReadonlyArray<{ readonly id: number; readonly name: string; readonly count: number }>;
    readonly encryptedCount: number;
    readonly symlinkCount: number;
    readonly dataDescriptorCount: number;
    readonly zip64EntryCount: number;
    readonly utf8NameCount: number;
    readonly cp437NameCount: number;
    readonly duplicateNameCount: number;
    readonly unsafeNameCount: number;
    readonly earliestDate: string | null;
    readonly latestDate: string | null;
    readonly determinism: {
        readonly epochTimestamps: boolean;
        readonly canonicalOrder: boolean;
        readonly utf8Flags: boolean;
        readonly noDataDescriptors: boolean;
        readonly canonicalLayout: boolean;
        readonly deterministic: boolean;
    };
    readonly checks?: readonly CheckResult[];
    readonly checksPassed?: boolean;
}

export const INSPECT_ZIP_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['archiveBytes', 'entryCount', 'isZip64', 'determinism', 'diagnostics'],
    properties: {
        archiveBytes: { type: 'integer', minimum: 0 },
        entryCount: { type: 'integer', minimum: 0 },
        fileCount: { type: 'integer', minimum: 0 },
        directoryCount: { type: 'integer', minimum: 0 },
        isZip64: { type: 'boolean', description: 'A Zip64 end-of-central-directory record is present.' },
        comment: { type: 'string', description: 'Archive comment (UTF-8, lossy).' },
        commentBytes: { type: 'integer', minimum: 0 },
        commentHex: { type: 'string' },
        prependedData: { type: 'boolean', description: 'SFX-style prefix before the first local header (offsets shifted).' },
        multipleEocd: { type: 'boolean' },
        compressedBytes: { type: 'integer', minimum: 0 },
        uncompressedBytes: { type: 'integer', minimum: 0 },
        ratio: { type: 'string' },
        methods: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'integer' }, name: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
            },
        },
        encryptedCount: { type: 'integer', minimum: 0 },
        symlinkCount: { type: 'integer', minimum: 0 },
        dataDescriptorCount: { type: 'integer', minimum: 0 },
        zip64EntryCount: { type: 'integer', minimum: 0 },
        utf8NameCount: { type: 'integer', minimum: 0 },
        cp437NameCount: { type: 'integer', minimum: 0 },
        duplicateNameCount: { type: 'integer', minimum: 0 },
        unsafeNameCount: { type: 'integer', minimum: 0, description: 'Names sanitizeEntryPath() refuses (traversal, absolute, drive/UNC, NUL, ADS, device names).' },
        earliestDate: { type: ['string', 'null'] },
        latestDate: { type: ['string', 'null'] },
        determinism: {
            type: 'object',
            additionalProperties: false,
            description: '`deterministic` = reproducible (epoch timestamps + canonical order + UTF-8 flags); `canonicalLayout` = the buffered layout (no data descriptors) — a streamed archive is reproducible but not canonical.',
            properties: {
                epochTimestamps: { type: 'boolean' },
                canonicalOrder: { type: 'boolean' },
                utf8Flags: { type: 'boolean' },
                noDataDescriptors: { type: 'boolean' },
                canonicalLayout: { type: 'boolean' },
                deterministic: { type: 'boolean' },
            },
        },
        ...DIAGNOSTICS_OUTPUT_PROPERTIES,
        checks: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: { check: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } },
            },
        },
        checksPassed: { type: 'boolean', description: 'Present when check / assert was supplied: true when every assertion holds.' },
    },
} as const;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const d = (a[i] as number) - (b[i] as number);
        if (d !== 0) return d;
    }
    return a.length - b.length;
}

function isAscii(bytes: Uint8Array): boolean {
    for (const b of bytes) if (b > 0x7f) return false;
    return true;
}

type Report = Omit<InspectZipResult, 'checks' | 'checksPassed'>;

function evaluate(input: z.infer<typeof InputSchema>, report: Report, entries: readonly ZipEntry[]): CheckResult[] {
    const results: CheckResult[] = [];
    const d = report.determinism;
    for (const c of input.check ?? []) {
        let ok = false;
        let detail = '';
        switch (c) {
            case 'deterministic': ok = d.deterministic; detail = JSON.stringify(d); break;
            case 'epoch-timestamps': ok = d.epochTimestamps; detail = ok ? 'all entries at the DOS epoch' : 'non-epoch timestamps present'; break;
            case 'canonical-order': ok = d.canonicalOrder; detail = ok ? 'central directory in canonical raw-name order' : 'not in canonical order'; break;
            case 'utf8-names': ok = d.utf8Flags; detail = ok ? 'non-ASCII names carry the UTF-8 flag' : 'non-ASCII name without the UTF-8 flag'; break;
            case 'no-data-descriptor':
            case 'canonical-layout': ok = report.dataDescriptorCount === 0; detail = `${report.dataDescriptorCount} data-descriptor entries`; break;
            case 'no-zip64': ok = !report.isZip64 && report.zip64EntryCount === 0; detail = `zip64 EOCD: ${report.isZip64}, zip64 entries: ${report.zip64EntryCount}`; break;
            case 'zip64': ok = report.isZip64 || report.zip64EntryCount > 0; detail = `zip64 EOCD: ${report.isZip64}, zip64 entries: ${report.zip64EntryCount}`; break;
            case 'no-encryption': ok = report.encryptedCount === 0; detail = `${report.encryptedCount} encrypted entries`; break;
            case 'no-symlinks': ok = report.symlinkCount === 0; detail = `${report.symlinkCount} symlink entries`; break;
            case 'safe-names': ok = report.unsafeNameCount === 0; detail = `${report.unsafeNameCount} unsafe names`; break;
            case 'no-duplicates': ok = report.duplicateNameCount === 0; detail = `${report.duplicateNameCount} duplicate names`; break;
            case 'no-diagnostics': ok = report.diagnostics.length === 0; detail = `${report.diagnostics.length} diagnostics`; break;
            case 'store-only': ok = entries.every((e) => e.compressionMethod === METHOD_STORE); detail = `methods: ${report.methods.map((m) => m.name).join(',') || 'none'}`; break;
            case 'deflate-only': ok = entries.every((e) => e.compressionMethod === METHOD_DEFLATE); detail = `methods: ${report.methods.map((m) => m.name).join(',') || 'none'}`; break;
        }
        results.push({ check: c, ok, detail });
    }
    const a = input.assert;
    if (a !== undefined) {
        if (a.maxEntries !== undefined) results.push({ check: `max-entries=${a.maxEntries}`, ok: entries.length <= a.maxEntries, detail: `${entries.length} entries (max ${a.maxEntries})` });
        if (a.minEntries !== undefined) results.push({ check: `min-entries=${a.minEntries}`, ok: entries.length >= a.minEntries, detail: `${entries.length} entries (min ${a.minEntries})` });
        if (a.maxUncompressedBytes !== undefined) results.push({ check: `max-uncompressed=${a.maxUncompressedBytes}`, ok: report.uncompressedBytes <= a.maxUncompressedBytes, detail: `${report.uncompressedBytes} bytes uncompressed (max ${a.maxUncompressedBytes})` });
        if (a.maxRatio !== undefined) {
            const worst = entries.reduce((m, e) => (e.compressedSize > 0 ? Math.max(m, e.uncompressedSize / e.compressedSize) : m), 0);
            results.push({ check: `max-ratio=${a.maxRatio}`, ok: worst <= a.maxRatio, detail: `worst entry ratio ${worst.toFixed(1)}:1 (max ${a.maxRatio}:1)` });
        }
        for (const name of a.has ?? []) {
            const present = entries.some((e) => e.name === name);
            results.push({ check: `has=${name}`, ok: present, detail: present ? `entry "${name}" present` : `entry "${name}" missing` });
        }
        if (a.method !== undefined) {
            const want = a.method === 'store' ? METHOD_STORE : METHOD_DEFLATE;
            const ok = entries.every((e) => e.compressionMethod === want);
            results.push({ check: `method=${a.method}`, ok, detail: `all entries use ${a.method}: ${ok}` });
        }
    }
    return results;
}

export async function inspectZip(rawInput: unknown): Promise<InspectZipResult> {
    const input = parseInput(InputSchema, rawInput);
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict);
    const limits = resolveCallLimits(input.limits);
    const reader = guard('Failed to open archive', () => openZip(bytes, { validate: input.validate, ...(limits !== undefined ? { limits } : {}), ...sink.options }));
    const entries: ZipEntry[] = guard('Failed to read the central directory', () => [...reader.entries()]);

    let fileCount = 0;
    let directoryCount = 0;
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    const methodCounts = new Map<number, number>();
    let encryptedCount = 0;
    let symlinkCount = 0;
    let dataDescriptorCount = 0;
    let zip64EntryCount = 0;
    let utf8NameCount = 0;
    let cp437NameCount = 0;
    const seen = new Set<string>();
    let duplicateNameCount = 0;
    let unsafeNameCount = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;
    let epochTimestamps = true;
    let canonicalOrder = true;
    let utf8Flags = true;
    let prev: ZipEntry | null = null;

    for (const e of entries) {
        if (e.isDirectory) directoryCount++;
        else fileCount++;
        compressedBytes += e.compressedSize;
        uncompressedBytes += e.uncompressedSize;
        methodCounts.set(e.compressionMethod, (methodCounts.get(e.compressionMethod) ?? 0) + 1);
        if (e.isEncrypted) encryptedCount++;
        if (isSymlinkEntry(e)) symlinkCount++;
        if (e.usesDataDescriptor) dataDescriptorCount++;
        if (e.usesZip64) zip64EntryCount++;
        if (e.nameEncoding === 'utf-8') utf8NameCount++;
        else cp437NameCount++;
        if (seen.has(e.name)) duplicateNameCount++;
        seen.add(e.name);
        if (sanitizedPathOf(e.name, e.isDirectory) === null) unsafeNameCount++;
        if (earliest === null || e.lastModified < earliest) earliest = e.lastModified;
        if (latest === null || e.lastModified > latest) latest = e.lastModified;
        if (e.dosDate !== DOS_EPOCH_DATE || e.dosTime !== DOS_EPOCH_TIME) epochTimestamps = false;
        if (prev !== null && compareBytes(prev.rawName, e.rawName) > 0) canonicalOrder = false;
        if ((e.flags & FLAG_UTF8) === 0 && !isAscii(e.rawName)) utf8Flags = false;
        prev = e;
    }
    const noDataDescriptors = dataDescriptorCount === 0;

    const report: Report = {
        archiveBytes: bytes.byteLength,
        entryCount: reader.entryCount,
        fileCount,
        directoryCount,
        isZip64: reader.isZip64,
        comment: decodeComment(reader.comment),
        commentBytes: reader.comment.length,
        ...(reader.comment.length > 0 ? { commentHex: bytesToHex(reader.comment) } : {}),
        prependedData: sink.has('ZIP_PREPENDED_DATA'),
        multipleEocd: sink.has('ZIP_MULTIPLE_EOCD'),
        compressedBytes,
        uncompressedBytes,
        ratio: formatRatio(compressedBytes, uncompressedBytes),
        methods: [...methodCounts.entries()].sort((a, b) => a[0] - b[0]).map(([id, count]) => ({ id, name: methodName(id), count })),
        encryptedCount,
        symlinkCount,
        dataDescriptorCount,
        zip64EntryCount,
        utf8NameCount,
        cp437NameCount,
        duplicateNameCount,
        unsafeNameCount,
        earliestDate: earliest === null ? null : (earliest as Date).toISOString(),
        latestDate: latest === null ? null : (latest as Date).toISOString(),
        determinism: {
            epochTimestamps,
            canonicalOrder,
            utf8Flags,
            noDataDescriptors,
            canonicalLayout: noDataDescriptors,
            deterministic: epochTimestamps && canonicalOrder && utf8Flags,
        },
        ...sink.report(),
    };

    if (input.check === undefined && input.assert === undefined) return report;
    const checks = evaluate(input, report, entries);
    return { ...report, checks, checksPassed: checks.every((c) => c.ok) };
}

/** Summary projection (`verbosity: 'summary'`). */
export function inspectSummary(r: InspectZipResult): Record<string, unknown> {
    return {
        archiveBytes: r.archiveBytes,
        entryCount: r.entryCount,
        isZip64: r.isZip64,
        compressedBytes: r.compressedBytes,
        uncompressedBytes: r.uncompressedBytes,
        encryptedCount: r.encryptedCount,
        unsafeNameCount: r.unsafeNameCount,
        duplicateNameCount: r.duplicateNameCount,
        deterministic: r.determinism.deterministic,
        canonicalLayout: r.determinism.canonicalLayout,
        diagnosticCount: r.diagnostics.length,
        ...(r.checksPassed !== undefined ? { checksPassed: r.checksPassed } : {}),
    };
}

export const INSPECT_ZIP_SUMMARY_PROPERTIES = {
    deterministic: { type: 'boolean', description: 'summary only: the determinism verdict.' },
    canonicalLayout: { type: 'boolean', description: 'summary only: buffered (no data descriptor) layout.' },
    diagnosticCount: { type: 'integer', minimum: 0, description: 'summary only: number of distinct diagnostics.' },
} as const;
