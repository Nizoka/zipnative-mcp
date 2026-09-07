/**
 * Tool: modify_zip — incremental modification through `createZipModifier`:
 * add / replace / remove / rename entries and set the comment, then either
 * `save()` (append-only: original bytes verbatim, no recompression, the
 * SAME buffer back when nothing changed) or `saveCompact()` (canonical
 * rewrite, still no recompression, removed data truly gone).
 *
 * DATA REMANENCE (the engine's warning, restated): `remove` / `replace` +
 * mode 'append' does NOT erase content — every original byte stays in the
 * output and the superseded payloads remain recoverable. Use mode 'compact'
 * for true deletion. The ZIP_DEAD_BYTES_RATIO diagnostic fires when more
 * than half of an append-mode output is dead bytes.
 */
import { z } from 'zod';
import { createZipModifier, openZip, type ZipModifierOptions } from 'zipnative';

import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { assertInputWithin, MAX_BASE64_INPUT_BYTES, MAX_MODIFY_OPERATIONS } from '../caps.js';
import { createDiagnosticSink, type DiagnosticsReport } from '../diagnostics.js';
import { ensureEngineReady } from '../engine.js';
import {
    COMPRESSION_INPUT_SCHEMA,
    CompressionSchema,
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
import { emitArchive, OUTPUT_INPUT_PROPERTIES, type OutputResult } from '../output.js';
import { guard } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, sha256Hex, STRICT_INPUT_PROPERTY } from './_shared.js';

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
                        properties: { op: { type: 'string', enum: ['add', 'replace'] }, ...payloadProps, directory: { type: 'boolean', default: false, description: 'add only: an explicit directory entry.' } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'name'],
                        properties: { op: { type: 'string', enum: ['remove'] }, name: { type: 'string', minLength: 1 } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'from', 'to'],
                        properties: { op: { type: 'string', enum: ['rename'] }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1, maxLength: 4096 } },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        required: ['op', 'comment'],
                        properties: { op: { type: 'string', enum: ['setComment'] }, comment: { type: 'string', maxLength: U16 } },
                    },
                ],
            },
        },
        mode: {
            type: 'string',
            enum: ['append', 'compact'],
            default: 'append',
            description: "'append' (default): save() — original bytes verbatim + appended entries + new central directory; removed/replaced payloads REMAIN in the file (data remanence). 'compact': saveCompact() — canonical rewrite without recompression, removed data truly gone, SFX prefix dropped.",
        },
        compression: COMPRESSION_INPUT_SCHEMA,
        defaultDate: DEFAULT_DATE_SCHEMA,
        includeSha256: { type: 'boolean', default: false },
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
        compression: CompressionSchema.optional(),
        defaultDate: z.string().optional(),
        includeSha256: z.boolean().default(false),
        ...EngineOptionsShape,
        outputMode: z.enum(['base64', 'file']).default('base64'),
        outputPath: z.string().optional(),
    })
    .superRefine(refineArchiveInput);

export interface ModifyZipSummary {
    readonly saveMode: 'append' | 'compact';
    readonly operationsApplied: number;
    readonly entryCountBefore: number;
    readonly entryCountAfter: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly grewByBytes: number;
    readonly noOp: boolean;
    readonly sha256?: string;
}

export type ModifyZipResult = OutputResult & DiagnosticsReport & { readonly summary: ModifyZipSummary };

export async function modifyZipTool(rawInput: unknown): Promise<ModifyZipResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict);
    const limits = resolveCallLimits(input.limits);
    const reader = guard('Failed to open archive', () => openZip(bytes, { ...(limits !== undefined ? { limits } : {}), ...sink.options }));
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

    const outputBytes = guard(input.mode === 'compact' ? 'Failed to save (compact)' : 'Failed to save (append)', () => (input.mode === 'compact' ? modifier.saveCompact() : modifier.save()));
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
            ...(sha256 !== undefined ? { sha256 } : {}),
        },
        ...sink.report(),
    };
}
