/**
 * Tool: modify_zip — incremental modification through `createZipModifier`:
 * add / replace / remove / rename entries and set the comment, then either
 * `save()` (append-only: original bytes verbatim, no recompression, the
 * SAME buffer back when nothing changed) or `saveCompact()` (a rewrite
 * without the dead bytes, entries sorted by raw name bytes, still no
 * recompression, removed data truly gone). With `canonical` (zipnative 1.1.0,
 * compact only) the rewrite also normalises every entry into the canonical
 * deterministic form — `saveCompact({ canonical })`, the same rules as
 * canonicalize_zip, applied after the edits.
 *
 * DATA REMANENCE (the engine's warning, restated): `remove` / `replace` +
 * mode 'append' does NOT erase content — every original byte stays in the
 * output and the superseded payloads remain recoverable. Use mode 'compact'
 * for true deletion. The ZIP_DEAD_BYTES_RATIO diagnostic fires when more
 * than half of an append-mode output is dead bytes.
 */
import { z } from 'zod';
import { createZipModifier, openZip, type ZipModifierOptions } from 'zipnative';

import { NO_CONTEXT, throwIfCancelled, type CallContext } from '../call-context.js';
import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_MODIFY_OPERATIONS } from '../caps.js';
import { CANONICAL_OPTION_PROPERTIES, CanonicalOptionShape, toCanonicalOptions } from '../canonical.js';
import { createDiagnosticSink, type DiagnosticsReport } from '../diagnostics.js';
import { ensureEngineReady } from '../engine.js';
import {
    COMPRESSION_INPUT_SCHEMA,
    CompressionSchema,
    DEFAULT_DATE_PATTERN,
    DEFAULT_DATE_SCHEMA,
    ENTRY_PAYLOAD_PROPERTIES,
    EntryPayloadShape,
    loadPayload,
    refineEntryPayload,
    toAddEntryOptions,
    toCompression,
    toDefaultDate,
} from '../entry-spec.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { emitArchive, OUTPUT_INPUT_PROPERTIES, OutputShape, type OutputResult } from '../output.js';
import { guard } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, sha256Hex, STRICT_INPUT_PROPERTY } from './_shared.js';
import { archiveOutputSchemaWith } from './create-zip.js';

export const MODIFY_ZIP_NAME = 'modify_zip';

const U16 = 65_535;

const { directory: _directoryProp, ...payloadProps } = ENTRY_PAYLOAD_PROPERTIES;
void _directoryProp;

export const MODIFY_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['operations'],
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        operations: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_MODIFY_OPERATIONS,
            description: 'Edits applied in order. add: new entry (ZIP_ENTRY_EXISTS if present); replace: existing entry (ZIP_ENTRY_NOT_FOUND otherwise); remove; rename (never overwrites: remove the target first); setComment.',
            items: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'name'],
                        properties: { op: { type: 'string', enum: ['add', 'replace'], description: "'add' a new entry (ZIP_ENTRY_EXISTS if present) or 'replace' an existing one (ZIP_ENTRY_NOT_FOUND otherwise)." }, ...payloadProps, directory: { type: 'boolean', default: false, description: 'add only: an explicit directory entry.' } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'name'],
                        properties: { op: { type: 'string', enum: ['remove'], description: 'Remove an entry (its bytes remain in the file under mode append).' }, name: { type: 'string', minLength: 1, description: 'Entry name to remove (exact, case-sensitive).' } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'from', 'to'],
                        properties: { op: { type: 'string', enum: ['rename'], description: 'Rename an entry without recompression; never overwrites an existing name.' }, from: { type: 'string', minLength: 1, description: 'Current entry name.' }, to: { type: 'string', minLength: 1, maxLength: 4096, description: 'New entry name (must not exist).' } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'comment'],
                        properties: { op: { type: 'string', enum: ['setComment'], description: 'Replace the archive comment.' }, comment: { type: 'string', maxLength: U16, description: 'New archive comment (UTF-8, ≤ 65535 bytes).' } },
                    },
                ],
            },
        },
        mode: {
            type: 'string',
            enum: ['append', 'compact'],
            default: 'append',
            description: "'append' (default): save() — original bytes verbatim + appended entries + new central directory; removed/replaced payloads REMAIN in the file (data remanence). 'compact': saveCompact() — a rewrite without recompression, entries sorted by raw name bytes, removed data truly gone, SFX prefix dropped (add `canonical` for the canonical deterministic form).",
        },
        canonical: {
            type: 'object',
            additionalProperties: false,
            description: "mode 'compact' only (zipnative 1.1.0 saveCompact({ canonical })): after the edits, rewrite every entry into the canonical deterministic form — sorted by raw name bytes, one timestamp, UTF-8 flags, Zip64-only extras, version-made-by 0x032D — still without recompression. `{}` takes the defaults. The same rules as canonicalize_zip.",
            properties: CANONICAL_OPTION_PROPERTIES,
        },
        compression: COMPRESSION_INPUT_SCHEMA,
        defaultDate: DEFAULT_DATE_SCHEMA,
        includeSha256: { type: 'boolean', default: false, description: 'Add `summary.sha256` of the produced bytes.' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...OUTPUT_INPUT_PROPERTIES,
    },
} as const;

const WriteOp = z
    .strictObject({ op: z.enum(['add', 'replace']), ...EntryPayloadShape })
    .superRefine((v, ctx) => {
        refineEntryPayload(v, ctx);
        if (v.op === 'replace' && v.directory) ctx.addIssue({ code: 'custom', message: 'replace cannot target a directory entry', path: ['directory'] });
    });
const RemoveOp = z.strictObject({ op: z.literal('remove'), name: z.string().min(1) });
const RenameOp = z.strictObject({ op: z.literal('rename'), from: z.string().min(1), to: z.string().min(1).max(4096) });
const CommentOp = z.strictObject({ op: z.literal('setComment'), comment: z.string().max(U16) });

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        operations: z.array(z.union([WriteOp, RemoveOp, RenameOp, CommentOp])).min(1).max(MAX_MODIFY_OPERATIONS),
        mode: z.enum(['append', 'compact']).default('append'),
        canonical: z.strictObject(CanonicalOptionShape).optional(),
        compression: CompressionSchema.optional(),
        defaultDate: z.string().regex(new RegExp(DEFAULT_DATE_PATTERN)).optional(),
        includeSha256: z.boolean().default(false),
        ...EngineOptionsShape,
        ...OutputShape,
    })
    .superRefine((value, ctx) => {
        refineArchiveInput(value, ctx);
        if (value.canonical !== undefined && value.mode !== 'compact') ctx.addIssue({ code: 'custom', message: "canonical applies to mode 'compact' only (an append-mode save keeps the original bytes verbatim)", path: ['canonical'] });
    });

export const MODIFY_ZIP_OUTPUT_SCHEMA = archiveOutputSchemaWith(
    {
        saveMode: { type: 'string', enum: ['append', 'compact'] },
        operationsApplied: { type: 'integer', minimum: 0 },
        entryCountBefore: { type: 'integer', minimum: 0 },
        entryCountAfter: { type: 'integer', minimum: 0 },
        inputBytes: { type: 'integer', minimum: 0 },
        outputBytes: { type: 'integer', minimum: 0 },
        grewByBytes: { type: 'integer', description: 'outputBytes − inputBytes (negative after a compacting rewrite).' },
        noOp: { type: 'boolean', description: 'true when the engine returned the input buffer unchanged (no pending edit, same comment).' },
        canonical: { type: 'boolean', description: "Present (true) when the compact rewrite produced the canonical deterministic form (input canonical)." },
        sha256: { type: 'string', description: 'Present with includeSha256.' },
    },
    'modify_zip summary.',
);

export interface ModifyZipSummary {
    readonly saveMode: 'append' | 'compact';
    readonly operationsApplied: number;
    readonly entryCountBefore: number;
    readonly entryCountAfter: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly grewByBytes: number;
    readonly noOp: boolean;
    readonly canonical?: true;
    readonly sha256?: string;
}

export type ModifyZipResult = OutputResult & DiagnosticsReport & { readonly summary: ModifyZipSummary };

export async function modifyZipTool(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<ModifyZipResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict, context);
    const limits = resolveCallLimits(input.limits);
    // Eager: the append path never re-reads the existing entries, so a lazy
    // open would carry an overlapping (smuggling) or truncated-header archive
    // into the output unchecked. Every local header and the overlap table are
    // cross-checked up front, as inspect_zip does by default.
    const reader = guard('Failed to open archive', () => openZip(bytes, { validate: 'eager', ...(limits !== undefined ? { limits } : {}), ...sink.options }));
    // A-006: the eager pass checks extents only; the append path also needs each
    // entry's local header and declared sizes cross-checked before its bytes are
    // re-emitted (a method / CRC / size divergence, a declared-size bomb). The
    // engine's raw read does exactly that without decompressing; compaction
    // reads every entry anyway. Encrypted entries cannot be read raw and are
    // carried as they are (their extents were checked by the eager pass).
    if (input.mode === 'append') {
        for (const entry of reader.entries()) {
            throwIfCancelled(context);
            if (entry.isDirectory || entry.isEncrypted) continue;
            guard('Failed to check an entry of the archive', () => reader.readEntryRaw(entry), entry.name);
        }
    }
    const defaultDate = toDefaultDate(input.defaultDate);
    const compression = toCompression(input.compression);
    const options: ZipModifierOptions = {
        ...(compression !== undefined ? { compression } : {}),
        ...(defaultDate !== undefined ? { defaultDate } : {}),
        ...(limits !== undefined ? { limits } : {}),
        ...sink.options,
    };
    const modifier = guard('Failed to create the modifier', () => createZipModifier(reader, options));

    let inlineBytes = 0;
    for (let i = 0; i < input.operations.length; i++) {
        const op = input.operations[i] as z.infer<typeof InputSchema>['operations'][number];
        const where = `operations[${i}]`;
        const extra = { operationIndex: i, op: op.op };
        switch (op.op) {
            case 'add':
            case 'replace': {
                const entryOptions = toAddEntryOptions(op, where);
                if (op.directory) {
                    guard(`Failed to add directory '${op.name}'`, () => modifier.addEntry(op.name.endsWith('/') ? op.name : `${op.name}/`, new Uint8Array(0), entryOptions), op.name, extra);
                    break;
                }
                const { data } = await loadPayload(op, where);
                if (op.sourcePath === undefined) {
                    inlineBytes += data.byteLength;
                    assertInputWithin(inlineBytes, MAX_BASE64_INPUT_BYTES, 'inline entry payloads (total)');
                }
                if (op.op === 'add') guard(`Failed to add entry '${op.name}'`, () => modifier.addEntry(op.name, data, entryOptions), op.name, extra);
                else guard(`Failed to replace entry '${op.name}'`, () => modifier.replaceEntry(op.name, data, entryOptions), op.name, extra);
                break;
            }
            case 'remove':
                guard(`Failed to remove entry '${op.name}'`, () => modifier.removeEntry(op.name), op.name, extra);
                break;
            case 'rename':
                guard(`Failed to rename entry '${op.from}'`, () => modifier.renameEntry(op.from, op.to), op.from, extra);
                break;
            case 'setComment':
                guard('Failed to set the archive comment', () => modifier.setComment(op.comment), undefined, extra);
                break;
        }
    }

    const canonical = input.canonical !== undefined ? toCanonicalOptions(input.canonical, 'canonical.') : undefined;
    const outputBytes = guard(input.mode === 'compact' ? 'Failed to save (compact)' : 'Failed to save (append)', () => (input.mode === 'compact' ? modifier.saveCompact(canonical !== undefined ? { canonical } : undefined) : modifier.save()));
    const noOp = outputBytes === reader.bytes;
    const entryCountAfter = guard('Failed to re-open the saved archive', () => openZip(outputBytes, { onDiagnostic: () => undefined }).entryCount);
    const out = await emitArchive(outputBytes, { mode: input.outputMode, outputPath: input.outputPath });
    const sha256 = input.includeSha256 ? await sha256Hex(outputBytes) : undefined;
    return {
        ...out,
        summary: {
            saveMode: input.mode,
            operationsApplied: input.operations.length,
            entryCountBefore: reader.entryCount,
            entryCountAfter,
            inputBytes: bytes.byteLength,
            outputBytes: outputBytes.byteLength,
            grewByBytes: outputBytes.byteLength - bytes.byteLength,
            noOp,
            ...(canonical !== undefined ? { canonical: true as const } : {}),
            ...(sha256 !== undefined ? { sha256 } : {}),
        },
        ...sink.report(),
    };
}
