/**
 * Examples-as-tests: every file under `examples/` is loaded, its referenced
 * tool name(s) are checked against the live tool registry and its arguments
 * against the input schema, and any example whose placeholders resolve is
 * executed end-to-end through the MCP `tools/call` handler. Archive-producing
 * results then have their bytes structurally validated via `assertValidZip`.
 *
 * Placeholder vocabulary (the ONLY `<...>` tokens an example may use):
 *   <zip-base64>               base64 of basicZip()
 *   <rich-zip-base64>          richZip()
 *   <truncated-zip-base64>     the first 60 bytes of basicZip()
 *   <hostile-zip-slip-base64>  ZIP_SLIP()
 *   <raw-deflate-base64>       base64 of deflateRawSync('hello hello hello')
 *   <base64 from step N>       the resource.blob of step N's result (1-based)
 *
 * File-mode examples (outputMode:'file', outputDir, zipPath, sourcePath) are
 * documentation-only: the runner sets no sandbox and skips their execution,
 * but still validates tool names and argument shapes.
 *
 * This guarantees the published examples never drift from the real schemas or
 * runtime behaviour: a stale field name or renamed tool fails CI immediately.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

import { callToolDirect, ensureEngineReady, listToolsPayload } from '../src/server.js';
import { connectLegacy, type McpTestClient } from './_mcp-harness.js';
import { assertValidZip } from './_zip-assert.js';
import { b64, basicZip, richZip, truncated, ZIP_SLIP } from './_zip-fixtures.js';

const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

interface ExampleStep {
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
}
interface ExampleFile {
    readonly description?: string;
    readonly tool?: string;
    readonly arguments?: Record<string, unknown>;
    readonly steps?: ReadonlyArray<ExampleStep>;
    /** A refusal demo: the (single-tool) example must return isError with this `_meta.error.code`. */
    readonly expectError?: string;
}

interface CallResponse {
    isError?: boolean;
    content: Array<{ type: string; text?: string; resource?: { blob?: string; mimeType?: string } }>;
    structuredContent?: Record<string, unknown>;
    _meta?: { error?: { code: string; message: string } };
}

const PLACEHOLDER_RE = /^<(.+)>$/;
const STEP_REF_RE = /^base64 from step (\d+)$/;

/** Recursively collect every `<...>` placeholder token in `value`. */
function placeholdersIn(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') {
        const m = PLACEHOLDER_RE.exec(value);
        if (m !== null) out.push(m[1]!);
    } else if (Array.isArray(value)) {
        for (const v of value) placeholdersIn(v, out);
    } else if (value !== null && typeof value === 'object') {
        for (const v of Object.values(value)) placeholdersIn(v, out);
    }
    return out;
}

/** Recursively test whether any string in `value` contains an `<...>` placeholder token. */
function hasPlaceholder(value: unknown): boolean {
    return placeholdersIn(value).length > 0;
}

/** File-mode examples reference the sandbox and are documentation-only. */
function isFileMode(args: Record<string, unknown>): boolean {
    const text = JSON.stringify(args);
    return text.includes('"outputMode":"file"') || text.includes('"outputDir"') || text.includes('"zipPath"') || text.includes('"sourcePath"');
}

/** Normalise a single-tool or multi-step example into a flat list of steps. */
function toSteps(example: ExampleFile): ExampleStep[] {
    if (Array.isArray(example.steps)) return [...example.steps];
    if (typeof example.tool === 'string') {
        return [{ tool: example.tool, arguments: example.arguments ?? {} }];
    }
    return [];
}

const KNOWN_PLACEHOLDERS: Readonly<Record<string, () => string>> = {
    'zip-base64': () => b64(basicZip()),
    'rich-zip-base64': () => b64(richZip()),
    'truncated-zip-base64': () => b64(truncated(basicZip(), 60)),
    'hostile-zip-slip-base64': () => b64(ZIP_SLIP()),
    'raw-deflate-base64': () => b64(deflateRawSync(Buffer.from('hello hello hello'))),
};

/** Resolve one `<placeholder>` token; `outputs[i]` is the archive produced by step i+1. */
function resolvePlaceholder(token: string, outputs: ReadonlyArray<string | undefined>): string {
    const stepRef = STEP_REF_RE.exec(token);
    if (stepRef !== null) {
        const out = outputs[Number(stepRef[1]) - 1];
        if (out === undefined) throw new Error(`step ${stepRef[1]} produced no archive to chain`);
        return out;
    }
    const known = KNOWN_PLACEHOLDERS[token];
    if (known === undefined) throw new Error(`unknown example placeholder '<${token}>' — the vocabulary is: ${Object.keys(KNOWN_PLACEHOLDERS).map((k) => `<${k}>`).join(', ')}, <base64 from step N>`);
    return known();
}

function resolveArguments(value: unknown, outputs: ReadonlyArray<string | undefined>): unknown {
    if (typeof value === 'string') {
        const m = PLACEHOLDER_RE.exec(value);
        return m === null ? value : resolvePlaceholder(m[1]!, outputs);
    }
    if (Array.isArray(value)) return value.map((v) => resolveArguments(v, outputs));
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = resolveArguments(v, outputs);
        return out;
    }
    return value;
}

/** The archive an executed step produced (an embedded resource of MIME type application/zip), if any. */
function zipBlobOf(response: CallResponse): string | undefined {
    const block = response.content.find((c) => c.type === 'resource' && c.resource?.mimeType === 'application/zip');
    return block?.resource?.blob;
}

const exampleFiles = existsSync(EXAMPLES_DIR)
    ? readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];

if (exampleFiles.length === 0) {
    console.warn(`[examples] no examples/*.json found under ${EXAMPLES_DIR}; the examples suite is a no-op until the documentation examples land.`);
}

const validator = new AjvJsonSchemaValidator();
const inputSchemas = new Map(listToolsPayload().tools.map((t) => [t.name, t.inputSchema]));

let knownTools: Set<string>;
let client: McpTestClient;

describe.skipIf(exampleFiles.length === 0)('examples/*.json', () => {
    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        await ensureEngineReady();
        client = await connectLegacy();
        const list = await client.listTools();
        knownTools = new Set(list.tools.map((t) => t.name));
    });

    afterAll(async () => {
        await client.close();
    });

    it('discovers at least one example and every file name is kebab-case', () => {
        expect(exampleFiles.length).toBeGreaterThanOrEqual(1);
        for (const f of exampleFiles) expect(f, 'examples/<kebab>.json').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/);
    });

    for (const file of exampleFiles) {
        describe(file, () => {
            const raw = readFileSync(path.join(EXAMPLES_DIR, file), 'utf8');

            it('is valid JSON with a description and a tool or steps', () => {
                const parsed = JSON.parse(raw) as ExampleFile;
                expect(typeof parsed.description).toBe('string');
                expect((parsed.description ?? '').length).toBeGreaterThan(10);
                const steps = toSteps(parsed);
                expect(steps.length, 'example must declare a tool or steps').toBeGreaterThan(0);
                // Exactly one of the two forms.
                expect(typeof parsed.tool === 'string' && Array.isArray(parsed.steps)).toBe(false);
                // A refusal demo names a real code and is a single-tool example.
                if (parsed.expectError !== undefined) {
                    expect(parsed.expectError).toMatch(/^[A-Z][A-Z0-9_]+$/);
                    expect(steps.length).toBe(1);
                }
            });

            it('references only registered tools, object arguments that validate against the input schema, and known placeholders', () => {
                const steps = toSteps(JSON.parse(raw) as ExampleFile);
                steps.forEach((step, i) => {
                    expect(knownTools, `unknown tool '${step.tool}' in ${file}`).toContain(step.tool);
                    expect(typeof step.arguments).toBe('object');
                    expect(step.arguments).not.toBeNull();
                    // Placeholders are strings, so the shape validates structurally even before substitution.
                    const v = validator.getValidator(inputSchemas.get(step.tool) as Parameters<typeof validator.getValidator>[0]);
                    const r = v(step.arguments);
                    expect(r.valid, `${file} step ${i + 1} (${step.tool}): ${r.valid ? '' : r.errorMessage}`).toBe(true);
                    for (const token of placeholdersIn(step.arguments)) {
                        const stepRef = STEP_REF_RE.exec(token);
                        if (stepRef !== null) {
                            expect(Number(stepRef[1]), `${file} step ${i + 1}: <${token}> must reference an earlier step`).toBeLessThanOrEqual(i);
                            expect(Number(stepRef[1])).toBeGreaterThanOrEqual(1);
                        } else {
                            expect(Object.keys(KNOWN_PLACEHOLDERS), `${file} step ${i + 1}: unknown placeholder <${token}>`).toContain(token);
                        }
                    }
                });
            });

            it('executes end-to-end when self-contained (single tool, placeholders resolvable, not file mode)', async () => {
                const parsed = JSON.parse(raw) as ExampleFile;
                const steps = toSteps(parsed);
                const step = steps[0]!;
                if (steps.length !== 1 || isFileMode(step.arguments)) {
                    // Multi-step examples run in the chained suite below; file-mode
                    // examples are documentation-only (the structural checks above
                    // already guarantee they stay current).
                    return;
                }
                const args = resolveArguments(step.arguments, []) as Record<string, unknown>;
                expect(hasPlaceholder(args)).toBe(false);
                const response = (await client.callTool(step.tool, args)) as CallResponse;
                if (parsed.expectError !== undefined) {
                    // A refusal demo: the documented code must be the one the server returns.
                    expect(response.isError, `${file}: expected a ${parsed.expectError} refusal`).toBe(true);
                    expect(response._meta?.error?.code, `${file}: ${response.content[0]?.text ?? ''}`).toBe(parsed.expectError);
                    expect(response.content[0]?.text).toContain(`[${parsed.expectError}]`);
                    return;
                }
                expect(response.isError, `${file}: ${response.content[0]?.text ?? ''}`).not.toBe(true);
                const blob = zipBlobOf(response);
                if (blob !== undefined && blob.length > 0) assertValidZip(blob, file);
            }, 60_000);
        });
    }
});

/* -------------------------------------------------------------------------- */
/* Multi-step examples run for real, chained in order                         */
/* -------------------------------------------------------------------------- */

const chainedFiles = exampleFiles.filter((f) => {
    const parsed = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, f), 'utf8')) as ExampleFile;
    const steps = toSteps(parsed);
    return steps.length > 1 && !steps.some((s) => isFileMode(s.arguments));
});

describe.skipIf(chainedFiles.length === 0)('examples/*.json — multi-step examples run end-to-end', () => {
    beforeAll(async () => {
        delete process.env['ZIPNATIVE_MCP_OUTPUT_DIR'];
        await ensureEngineReady();
    });

    for (const file of chainedFiles) {
        it(`${file}: every step succeeds with the previous step's output substituted`, async () => {
            const steps = toSteps(JSON.parse(readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')) as ExampleFile);
            const outputs: Array<string | undefined> = [];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i]!;
                const args = resolveArguments(step.arguments, outputs) as Record<string, unknown>;
                expect(hasPlaceholder(args), `${file} step ${i + 1}: unresolved placeholder`).toBe(false);
                const response = (await callToolDirect(step.tool, args)) as CallResponse;
                const text = response.content[0]?.text ?? '';
                expect(response.isError, `${file} step ${i + 1} (${step.tool}): ${text}`).not.toBe(true);
                expect(text, `${file} step ${i + 1} (${step.tool}) failed validation`).not.toContain('VALIDATION_ERROR');
                const blob = zipBlobOf(response);
                if (blob !== undefined && blob.length > 0) assertValidZip(blob, `${file} step ${i + 1}`);
                outputs.push(blob);
            }
        }, 120_000);
    }
});
