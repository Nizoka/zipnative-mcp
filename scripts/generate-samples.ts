#!/usr/bin/env tsx
/**
 * zipnative-mcp — reproducible sample generator
 * ===============================================
 * Drives the BUILT server (`dist/server.js`, through the same
 * `callToolDirect()` an MCP host reaches) over every `examples/*.json` and
 * writes what it returns to `test-output/samples/`, where
 * `scripts/verify-samples.ts` fingerprints it against the committed baseline
 * (tests/_fixtures/samples.sha256.json).
 *
 * Per example `<name>`:
 *   <name>.json          the result: `structuredContent` and `content` with
 *                        every base64 blob removed (one step), or
 *                        `{ steps: [ … ] }` (a sequence); an `expectError`
 *                        example records the refusal (`isError`, `code`)
 *   <name>.zip           the archive bytes when one was produced (embedded
 *                        resource or, in file mode, the sandbox file); a
 *                        sequence writes <name>.stepN.zip; `inflate_raw`
 *                        output is written as <name>.bin
 *   manifest.json        the fingerprint mode of every file (bytes / semantic
 *                        — scripts/lib/sample-fingerprint.ts), so the verifier
 *                        never guesses
 * A `documentationOnly` example is validated against its tool's input schema
 * and never executed.
 *
 * Hermetic (helpers/hermetic.ts): UTC, every operator variable scrubbed, then
 * `ZIPNATIVE_MCP_OUTPUT_DIR` pointed at a temporary sandbox holding the
 * fixture files of helpers/io.ts SANDBOX_FILES, so the `zipPath` /
 * `sourcePath` inputs resolve and nothing is read outside the repository. The
 * output directory is emptied first, so a stale sample can never be
 * fingerprinted as if this run had produced it.
 *
 * Usage:  npm run build && npm run test:generate
 *         npx tsx scripts/generate-samples.ts [--quiet | --verbose] [--json]
 * Exit:   0 every sample written · 1 a tool call failed (its message is
 *         reproduced) or an example is not hermetic · 2 dist/ is missing or
 *         bad usage.
 */

// Must be first: pins TZ and scrubs operator knobs before dist/ is loaded.
import './helpers/hermetic.js';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { OUTPUT_DIR, formatBytes, parseOutputMode, prepareSandbox, removeSandbox } from './helpers/io.js';
import { artefactOf, errorCode, loadBuiltServer, type ToolResult } from './helpers/server.js';
import { blockingPlaceholders, loadExamples, runExample, validateAgainstSchema } from './lib/example-runner.js';
import { MANIFEST_PATH, canonicalJson, modeFor, type FingerprintMode, type ManifestEntry } from './lib/sample-fingerprint.js';

interface Written {
    readonly file: string;
    readonly size: number;
    readonly mode: FingerprintMode;
}

/** The file extension of an artefact, from its MIME type. */
export function extensionFor(mimeType: string): string {
    return mimeType === 'application/zip' ? '.zip' : '.bin';
}

/** The result without its base64 blobs: structuredContent as is, content blocks with `blob` / data-URI `uri` dropped. */
export function withoutBlobs(result: ToolResult): Record<string, unknown> {
    const content = (result.content ?? []).map((c) => {
        if (c.type !== 'resource' || c.resource === undefined) return c;
        const { blob: _blob, uri: _uri, ...rest } = c.resource;
        void _blob;
        void _uri;
        return { ...c, resource: rest };
    });
    return {
        ...(result.isError === true ? { isError: true } : {}),
        content,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result._meta !== undefined ? { _meta: result._meta } : {}),
    };
}

async function main(): Promise<number> {
    const mode = parseOutputMode(process.argv.slice(2));
    if ('error' in mode) {
        process.stderr.write(`${mode.error}\n`);
        return 2;
    }
    const { quiet, json } = mode;
    const say = (s: string): void => { if (!json && !quiet) process.stdout.write(`${s}\n`); };

    const server = await loadBuiltServer();
    if (server === null) {
        process.stderr.write('dist/server.js not found — run `npm run build` first.\n');
        return 2;
    }
    const tools = server.listToolsPayload().tools;
    const toolOf = (name: string): (typeof tools)[number] | undefined => tools.find((t) => t.name === name);

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const written: Written[] = [];
    const manifest: Record<string, ManifestEntry> = {};
    const write = (rel: string, data: Buffer | string, entry: ManifestEntry): void => {
        const target = join(OUTPUT_DIR, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        manifest[rel] = entry;
        written.push({ file: rel, size: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength, mode: entry.mode });
        say(`  wrote  ${rel.padEnd(52)} [${entry.mode}]`);
    };
    const started = Date.now();
    let documentationOnly = 0;

    for (const example of loadExamples()) {
        const blocking = blockingPlaceholders(example);
        if (blocking.length > 0) {
            process.stderr.write(`FAIL  examples/${example.name}\n      not hermetic: ${blocking.map((b) => `<${b}>`).join(', ')}\n`);
            return 1;
        }
        if (example.documentationOnly) {
            const failures = validateAgainstSchema(example, (tool) => toolOf(tool)?.inputSchema);
            if (failures.length > 0) {
                process.stderr.write(`FAIL  examples/${example.name}\n      ${failures.join('\n      ')}\n`);
                return 1;
            }
            documentationOnly++;
            say(`  valid  examples/${example.name} (documentation only, schema-checked)`);
            continue;
        }
        // One fresh sandbox per example: file-mode outputs never collide (writes are exclusive).
        const sandbox = prepareSandbox();
        try {
            let outputs;
            try {
                outputs = await runExample(example, {
                    call: async (tool, args) => {
                        const result = await server.callToolDirect(tool, args);
                        const artefact = result.isError === true ? null : artefactOf(result);
                        return { result, artefactBase64: artefact === null ? null : artefact.bytes.toString('base64'), isError: result.isError === true, code: errorCode(result) };
                    },
                });
            } catch (err) {
                process.stderr.write(`FAIL  examples/${example.name}\n      ${err instanceof Error ? err.message : String(err)}\n`);
                return 1;
            }
            const sequence = outputs.length > 1;
            const sidecar = `${example.name}.json`;
            const records = outputs.map((o) => withoutBlobs(o.result as ToolResult));
            write(sidecar, `${canonicalJson(sequence ? { steps: records } : records[0])}\n`, { mode: 'semantic', tool: outputs[outputs.length - 1]?.tool ?? '', example: example.name });
            for (const o of outputs) {
                const artefact = o.artefactBase64 === null ? null : artefactOf(o.result as ToolResult);
                if (artefact === null) continue;
                const file = `${example.name}${sequence ? `.step${o.step}` : ''}${extensionFor(artefact.mimeType)}`;
                const fpMode = modeFor({ args: o.arguments });
                write(file, artefact.bytes, { mode: fpMode, tool: o.tool, example: example.name, ...(fpMode === 'semantic' ? { sidecar } : {}) });
            }
        } finally {
            removeSandbox(sandbox);
        }
    }
    writeFileSync(MANIFEST_PATH, `${JSON.stringify({ generatedBy: 'scripts/generate-samples.ts', entries: manifest }, null, 2)}\n`);

    const bytes = written.reduce((sum, w) => sum + w.size, 0);
    const seconds = (Date.now() - started) / 1000;
    const modes = { bytes: written.filter((w) => w.mode === 'bytes').length, semantic: written.filter((w) => w.mode === 'semantic').length };
    if (json) {
        process.stdout.write(`${JSON.stringify({ generated: written.length, bytes, seconds, modes, documentationOnly, outputDir: OUTPUT_DIR, files: written }, null, 2)}\n`);
        return 0;
    }
    process.stdout.write(`${written.length} samples (${modes.bytes} bytes, ${modes.semantic} semantic), ${formatBytes(bytes)}, ${seconds.toFixed(1)} s → test-output/samples/${documentationOnly > 0 ? ` (${documentationOnly} documentation-only example(s) schema-checked)` : ''}\n`);
    return 0;
}

process.exit(await main());
