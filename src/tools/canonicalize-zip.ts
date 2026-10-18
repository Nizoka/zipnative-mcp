/**
 * Tool: canonicalize_zip — make ANY archive reproducible: zipnative 1.1.0's
 * `canonicalizeZip()` rewrites a Gradle, Maven, `zip`, Explorer or 7-Zip
 * archive into the canonical deterministic form the engine's own writer emits
 * (entries sorted by raw name bytes, one timestamp, UTF-8 flags, no extra
 * field but Zip64, the constant version-made-by, no data descriptor) WITHOUT
 * recompressing a payload: the compressed bytes are copied bit for bit, so a
 * corrupt or encrypted entry travels unchanged and nothing is decoded.
 * Idempotent — canonicalising the result again yields the same bytes — and
 * byte-stable across runtimes, because no codec runs.
 *
 * The result is checked once more by the engine's own `analyzeDeterminism()`
 * (with the same pinned date) and the verdict is reported, so an agent never
 * has to take the rewrite on trust. Duplicate-name archives are refused like
 * the modifier refuses them.
 */
import { z } from 'zod';
import { analyzeDeterminism, canonicalizeZip, openZip } from 'zipnative';

import { NO_CONTEXT, type CallContext } from '../call-context.js';
import { ARCHIVE_INPUT_PROPERTIES, ARCHIVE_INPUT_SHAPE, loadArchive, refineArchiveInput } from '../archive-input.js';
import { CANONICAL_OPTION_PROPERTIES, CanonicalOptionShape, toCanonicalOptions } from '../canonical.js';
import { createDiagnosticSink, type DiagnosticsReport } from '../diagnostics.js';
import { ensureEngineReady } from '../engine.js';
import { LIMITS_INPUT_SCHEMA, resolveCallLimits } from '../limits.js';
import { emitArchive, OUTPUT_INPUT_PROPERTIES, OutputShape, type OutputResult } from '../output.js';
import { guard } from '../zip-errors.js';
import { EngineOptionsShape, parseInput, sha256Hex, STRICT_INPUT_PROPERTY } from './_shared.js';
import { archiveOutputSchemaWith } from './create-zip.js';

export const CANONICALIZE_ZIP_NAME = 'canonicalize_zip';

export const CANONICALIZE_ZIP_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ...ARCHIVE_INPUT_PROPERTIES,
        ...CANONICAL_OPTION_PROPERTIES,
        includeSha256: { type: 'boolean', default: false, description: 'Add `summary.sha256` of the produced bytes (the reproducibility proof to compare across builds).' },
        ...STRICT_INPUT_PROPERTY,
        limits: LIMITS_INPUT_SCHEMA,
        ...OUTPUT_INPUT_PROPERTIES,
    },
} as const;

const InputSchema = z
    .strictObject({
        ...ARCHIVE_INPUT_SHAPE,
        ...CanonicalOptionShape,
        includeSha256: z.boolean().default(false),
        ...EngineOptionsShape,
        ...OutputShape,
    })
    .superRefine(refineArchiveInput);

export const CANONICALIZE_ZIP_OUTPUT_SCHEMA = archiveOutputSchemaWith(
    {
        entryCount: { type: 'integer', minimum: 0 },
        inputBytes: { type: 'integer', minimum: 0 },
        outputBytes: { type: 'integer', minimum: 0 },
        alreadyCanonical: { type: 'boolean', description: 'true when the input already was in this canonical form (the output bytes equal the input bytes).' },
        canonicalForm: { type: 'boolean', description: "zipnative's analyzeDeterminism() verdict on the output, with the same pinned date — true for every successful rewrite." },
        pinnedDate: { type: ['string', 'null'], description: 'The timestamp every entry carries (ISO-8601, UTC); null for the DOS epoch.' },
        keepComments: { type: 'boolean' },
        keepExternalAttributes: { type: 'boolean' },
        sha256: { type: 'string', description: 'Present with includeSha256.' },
    },
    'canonicalize_zip summary.',
);

export interface CanonicalizeZipSummary {
    readonly entryCount: number;
    readonly inputBytes: number;
    readonly outputBytes: number;
    readonly alreadyCanonical: boolean;
    readonly canonicalForm: boolean;
    readonly pinnedDate: string | null;
    readonly keepComments: boolean;
    readonly keepExternalAttributes: boolean;
    readonly sha256?: string;
}

export type CanonicalizeZipResult = OutputResult & DiagnosticsReport & { readonly summary: CanonicalizeZipSummary };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

export async function canonicalizeZipTool(rawInput: unknown, context: CallContext = NO_CONTEXT): Promise<CanonicalizeZipResult> {
    const input = parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const { bytes } = await loadArchive(input);
    const sink = createDiagnosticSink(input.strict, context);
    const limits = resolveCallLimits(input.limits);
    const canonical = toCanonicalOptions(input, '');
    const output = guard('Failed to canonicalise the archive', () => canonicalizeZip(bytes, { ...canonical, ...(limits !== undefined ? { limits } : {}), ...sink.options }));
    const report = guard('Failed to analyse the canonical output', () => analyzeDeterminism(output, { ...(limits !== undefined ? { limits } : {}), ...(canonical.date !== undefined ? { date: canonical.date } : {}), dosTimeMode: 'utc' }));
    const entryCount = guard('Failed to re-open the canonical output', () => openZip(output, { onDiagnostic: () => undefined, ...(limits !== undefined ? { limits } : {}) }).entryCount);
    const out = await emitArchive(output, { mode: input.outputMode, outputPath: input.outputPath });
    const sha256 = input.includeSha256 ? await sha256Hex(output) : undefined;
    return {
        ...out,
        summary: {
            entryCount,
            inputBytes: bytes.byteLength,
            outputBytes: output.byteLength,
            alreadyCanonical: sameBytes(bytes, output),
            canonicalForm: report.deterministic,
            pinnedDate: canonical.date === undefined ? null : canonical.date.toISOString(),
            keepComments: input.keepComments,
            keepExternalAttributes: input.keepExternalAttributes,
            ...(sha256 !== undefined ? { sha256 } : {}),
        },
        ...sink.report(),
    };
}
