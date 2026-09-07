#!/usr/bin/env node
/**
 * Structural fingerprint of the tool catalogue (`tools/list`) with every
 * `description` doc string removed (a schema *property* named description is kept): names, titles, annotations, input/output
 * schema shapes (types, enums, defaults, constraints, required,
 * additionalProperties) and the number of `_meta.examples`.
 *
 *   node scripts/tool-shape.mjs            # print the fingerprint
 *   node scripts/tool-shape.mjs --write    # refresh tests/_fixtures/tool-shape.json
 *   node scripts/tool-shape.mjs --stats    # measured catalogue figures (tools/list bytes, instructions bytes, counts)
 *
 * `tests/catalogue-parity.test.ts` asserts the live catalogue matches the
 * committed fixture, so wording can be tuned freely (descriptions, examples,
 * instructions) while any schema change must be a deliberate, reviewed
 * fixture update (docs/API_STABILITY.md §5).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { listToolsPayload, __prompts, __serverInstructions } = await import('../dist/server.js');
const { ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CODES } = await import('../dist/zip-errors.js');

export function strip(node) {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) if (!(k === 'description' && typeof v === 'string')) out[k] = strip(v);
    return out;
}

export function toolShape(tools) {
    return tools.map((t) => ({
        name: t.name,
        title: t.title,
        annotations: t.annotations,
        inputSchema: strip(t.inputSchema),
        outputSchema: strip(t.outputSchema),
        exampleCount: (t._meta?.examples ?? []).length,
    }));
}

const payload = listToolsPayload();
const shape = toolShape(payload.tools);
const json = JSON.stringify(shape, null, 1) + '\n';
if (process.argv.includes('--stats')) {
    // The figures the release notes quote (Verification table, "Catalogue" row).
    const stats = {
        toolsListBytes: Buffer.byteLength(JSON.stringify(payload)),
        serverInstructionsBytes: Buffer.byteLength(__serverInstructions),
        tools: payload.tools.length,
        prompts: __prompts.length,
        zipErrorCodes: ZIP_ERROR_CODES.length,
        diagnosticCodes: ZIP_DIAGNOSTIC_CODES.length,
        examples: payload.tools.reduce((n, t) => n + (t._meta?.examples ?? []).length, 0),
    };
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
} else if (process.argv.includes('--write')) {
    const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', '_fixtures', 'tool-shape.json');
    writeFileSync(target, json);
    console.log(`wrote ${target} (${shape.length} tools)`);
} else {
    process.stdout.write(json);
}
