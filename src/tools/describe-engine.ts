/**
 * Tool: describe_engine — an offline capability preflight (the `zipnative
 * doctor --json` of this server): server and engine versions, the deflate
 * tier in use, runtime streaming codecs and workers, the codec registry,
 * the engine's default limits, the operator ceilings and the server caps,
 * the frozen error / diagnostic vocabularies, and the engine exports this
 * server deliberately does not expose (with the reason).
 */
import { z } from 'zod';
import { activeDeflateTier, DEFAULT_ZIP_LIMITS, getCodec, METHOD_DEFLATE, METHOD_STORE, VERSION as ZIPNATIVE_VERSION } from 'zipnative';

import { CAPS, getCeilings, MAX_ENTRIES_ENV, MAX_UNCOMPRESSED_ENV, WORKERS_ENV, MAX_FILE_OUTPUT_ENV } from '../caps.js';
import { ensureEngineReady, probeRuntime } from '../engine.js';
import { PROJECTION_INPUT_PROPERTIES } from '../projection.js';
import { getOutputSandbox } from '../sandbox.js';
import { TOOL_API_VERSION, ZIPNATIVE_MCP_VERSION } from '../version.js';
import { ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CODES } from '../zip-errors.js';
import { parseInput, ProjectionShape } from './_shared.js';

export const DESCRIBE_ENGINE_NAME = 'describe_engine';

export const DESCRIBE_ENGINE_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { ...PROJECTION_INPUT_PROPERTIES },
} as const;

const InputSchema = z.strictObject({ ...ProjectionShape });

/** Engine exports this server deliberately does not expose, with the reason (mirrored in docs). */
export const UNEXPOSED_EXPORTS: ReadonlyArray<{ readonly export: string; readonly rationale: string }> = [
    { export: 'registerCodec / ZipCodec / CodecCompressOptions', rationale: 'A codec is executable code; JSON cannot carry one and zipnative ships no extra codec by policy.' },
    { export: 'setInflateImpl / setDeflateImpl', rationale: 'Runtime code injection; the server owns tier selection and reports it here.' },
    { export: 'initNodeZipCodecs', rationale: 'Startup concern — called once by the server before serving.' },
    { export: 'ParallelZipOptions.workerUrl', rationale: 'Filesystem / bundler path injection from a tool argument; the packaged worker resolves itself.' },
    { export: 'ZipCommonOptions.onDiagnostic', rationale: 'Always installed by the server (every result carries diagnostics[]); strict IS exposed.' },
    { export: 'ZipReader.bytes / ZipModifier.reader', rationale: 'The input itself.' },
    { export: 'ByteSource (external ReadableStream)', rationale: 'JSON-RPC has no stream channel; the server builds ByteSources internally from zipPath / sourcePath.' },
    { export: 'ZipWriter.addRaw / RawEntryMeta', rationale: 'The caller vouches for the CRC and the sizes: an agent could forge an inconsistent archive. merge_zip exposes addFromReader, the checked transplant.' },
    { export: 'ZipCommonOptions.nameDecoder / ZipNameDecoder', rationale: 'A decoder is a function; legacy code-page names (Shift-JIS, CP866) stay CP437-decoded with rawNameHex kept for forensics. A label-based input is a later candidate.' },
    { export: 'ZipCodec.createDecompressor / ZipDecompressor', rationale: 'Part of the codec contract; no codec can be registered here (registerCodec is unexposed). codecs[].incremental reports it for the built-in store and deflate.' },
    { export: 'openZipRange over a remote ByteRangeSource (rangeSourceFromBytes)', rationale: 'No network path, ever: the byte-range reader is fed only by a sandbox file (access: range on inspect_zip, list_zip_entries, read_zip_entry) or by inline bytes.' },
];

export interface DescribeEngineResult {
    readonly server: { readonly name: string; readonly version: string; readonly toolApiVersion: string; readonly protocol: string; readonly toolCount: number };
    readonly engine: { readonly name: string; readonly version: string; readonly deflateTier: { readonly default: string; readonly deterministic: string } };
    readonly capabilities: { readonly nodeZlib: boolean; readonly compressionStream: boolean; readonly decompressionStream: boolean; readonly workerThreads: boolean; readonly cpuCount: number; readonly defaultWorkers: number };
    readonly codecs: ReadonlyArray<{ readonly id: number; readonly name: string; readonly sync: boolean; readonly stream: boolean; readonly incremental: boolean }>;
    readonly defaultLimits: Record<string, number>;
    readonly ceilings: { readonly maxUncompressedBytes: number; readonly maxEntries: number; readonly maxWorkers: number; readonly maxFileOutputBytes: number; readonly env: readonly string[] };
    readonly caps: typeof CAPS;
    readonly sandbox: { readonly enabled: boolean; readonly cacheEnabled: boolean };
    readonly network: 'none';
    readonly errorCodes: readonly string[];
    readonly diagnosticCodes: readonly string[];
    readonly unexposed: typeof UNEXPOSED_EXPORTS;
}

export const DESCRIBE_ENGINE_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['server', 'engine', 'capabilities', 'codecs', 'defaultLimits', 'ceilings', 'caps', 'sandbox', 'network', 'errorCodes', 'diagnosticCodes', 'unexposed'],
    properties: {
        server: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, version: { type: 'string' }, toolApiVersion: { type: 'string' }, protocol: { type: 'string' }, toolCount: { type: 'integer' } } },
        engine: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, version: { type: 'string' }, deflateTier: { type: 'object', additionalProperties: false, properties: { default: { type: 'string' }, deterministic: { type: 'string' } } } } },
        capabilities: { type: 'object', additionalProperties: false, properties: { nodeZlib: { type: 'boolean' }, compressionStream: { type: 'boolean' }, decompressionStream: { type: 'boolean' }, workerThreads: { type: 'boolean' }, cpuCount: { type: 'integer' }, defaultWorkers: { type: 'integer' } } },
        codecs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, name: { type: 'string' }, sync: { type: 'boolean' }, stream: { type: 'boolean' }, incremental: { type: 'boolean', description: 'The codec exposes createDecompressor (zipnative 1.1.0): the forward reader and the byte-range reader decode it in O(chunk).' } } } },
        defaultLimits: { type: 'object', additionalProperties: { type: 'number' } },
        ceilings: { type: 'object', additionalProperties: false, properties: { maxUncompressedBytes: { type: 'integer' }, maxEntries: { type: 'integer' }, maxWorkers: { type: 'integer' }, maxFileOutputBytes: { type: 'integer' }, env: { type: 'array', items: { type: 'string' } } } },
        caps: { type: 'object', additionalProperties: { type: 'integer' } },
        sandbox: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, cacheEnabled: { type: 'boolean' } } },
        network: { type: 'string', enum: ['none'] },
        errorCodes: { type: 'array', items: { type: 'string' } },
        diagnosticCodes: { type: 'array', items: { type: 'string' } },
        unexposed: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { export: { type: 'string' }, rationale: { type: 'string' } } } },
    },
} as const;

let _toolCount = 0;
/** Set by the server at registration so the tool can report the catalogue size. */
export function __setToolCount(n: number): void {
    _toolCount = n;
}

export async function describeEngine(rawInput: unknown): Promise<DescribeEngineResult> {
    parseInput(InputSchema, rawInput);
    await ensureEngineReady();
    const runtime = await probeRuntime();
    const ceilings = getCeilings();
    const codecs = [METHOD_STORE, METHOD_DEFLATE].map((id) => {
        const codec = getCodec(id);
        return { id, name: id === METHOD_STORE ? 'store' : 'deflate', sync: codec?.decompressSync !== undefined, stream: codec?.decompressStream !== undefined, incremental: codec?.createDecompressor !== undefined };
    });
    return {
        server: { name: 'zipnative-mcp', version: ZIPNATIVE_MCP_VERSION, toolApiVersion: TOOL_API_VERSION, protocol: 'MCP 2026-07-28 + legacy 2024/2025 initialize', toolCount: _toolCount },
        engine: { name: 'zipnative', version: ZIPNATIVE_VERSION, deflateTier: { default: activeDeflateTier(false), deterministic: activeDeflateTier(true) } },
        capabilities: { ...runtime },
        codecs,
        defaultLimits: { ...DEFAULT_ZIP_LIMITS },
        ceilings: { ...ceilings, env: [MAX_UNCOMPRESSED_ENV, MAX_ENTRIES_ENV, WORKERS_ENV, MAX_FILE_OUTPUT_ENV] },
        caps: CAPS,
        sandbox: { enabled: getOutputSandbox() !== null, cacheEnabled: (process.env['ZIPNATIVE_MCP_CACHE_DIR'] ?? '') !== '' },
        network: 'none',
        errorCodes: [...ZIP_ERROR_CODES],
        diagnosticCodes: [...ZIP_DIAGNOSTIC_CODES],
        unexposed: UNEXPOSED_EXPORTS,
    };
}

export function describeSummary(r: DescribeEngineResult): Record<string, unknown> {
    return { server: r.server, engine: r.engine, capabilities: r.capabilities, sandbox: r.sandbox, network: r.network };
}
