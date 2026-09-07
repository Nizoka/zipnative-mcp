/**
 * zipnative-mcp — veraZIP conformance corpus generator
 * ======================================================
 * Drives the BUILT MCP tool handlers (`dist/server.js` → `callToolDirect`,
 * exactly what `tools/call` runs) — never `src/` and never a globally
 * installed zipnative — to produce a small, deterministic corpus of archives
 * under `test-output/zip/`, covering the write-side tool surface (create_zip:
 * store / deflate levels, empty archive, mixed methods, unicode + deep names,
 * insertion / canonical order, comments, extra fields, unix modes, pinned and
 * wall-clock dates, the deterministic encoder pin, the worker pool, streamed
 * sources, file mode; modify_zip: append-only, compact, rename, an SFX
 * prefix) plus CRAFTED archives written by the engine-independent raw
 * builder (`scripts/helpers/raw-zip-builder.mjs`): a forced-Zip64 layout,
 * four spec-valid-but-hostile shapes the server must REFUSE, and four
 * well-formedness negatives the validator must REJECT. The corpus itself is
 * defined once in `scripts/helpers/zip-corpus.mjs` (shared with
 * tests/verazip.test.ts); `scripts/validate-zip.mjs` then validates every
 * file clause-by-clause against ISO/IEC 21320-1:2015.
 *
 * Usage:  npm run build && npm run corpus:zip
 *         node scripts/generate-zip-corpus.mjs
 * Exit:   0 when every file was written and every gate-time assertion held,
 *         1 at the first failing tool call or assertion (the tool's error
 *         text is reproduced), 2 when dist/server.js is missing.
 *
 * Dependency-free: imports only the compiled server module and node
 * built-ins. `ZIPNATIVE_MCP_OUTPUT_DIR` is pointed at
 * `test-output/zip/.sandbox` (recreated on every run) so the file-mode
 * entries (`sourcePath` + `stream: true`, `outputMode: 'file'`) have a
 * sandbox; the cache stays off (no `ZIPNATIVE_MCP_CACHE_DIR`).
 *
 * Anti-circularity: the raw builder never imports `zipnative` — its deflate
 * comes from node:zlib and its CRC-32 from a local table, so a crafted
 * negative is never shaped by the engine it exists to test. The server IS
 * invoked here (that is this script's job: producing the corpus and checking
 * the server's own verdicts on it), but never for parsing a crafted archive
 * on the validator's behalf.
 *
 * Gate-time assertions (exit 1 on any miss — a corpus that lies must never
 * reach the validator):
 *   - pass 1 (per file, right after it is written): the structural `after`
 *     assertions of the corpus — deterministic-a/b and parallel-* are
 *     byte-identical pairs; the streamed sample carries data descriptors; the
 *     append-only modify keeps the original bytes as its prefix and the
 *     removed payload (remanence); compact drops it; the SFX stub survives;
 *     file mode equals base64 mode; every file starts with `PK` (or carries
 *     a local-header signature after its declared prefix);
 *   - pass 2 (once the whole corpus exists, so a mismatch leaves every file
 *     on disk): every tool-produced conformant archive passes `verify_zip`
 *     with ok: true, and every `refusedBy` entry is refused by the named tool
 *     with isError and the declared ZIP_* code.
 *
 * Every manifest entry carries `expectConformant` and, for negatives, the
 * exact check id the validator must report (`expectedCheck`).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertRefused, assertVerified, buildCorpus, createContext, produceEntry } from './helpers/zip-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'test-output', 'zip');
const SANDBOX_DIR = join(OUT_DIR, '.sandbox');
const SERVER_MODULE = join(ROOT, 'dist', 'server.js');

if (!existsSync(SERVER_MODULE)) {
    process.stderr.write('dist/server.js not found — run `npm run build` first.\n');
    process.exit(2);
}

// The sandbox must be configured BEFORE the server module reads the
// environment (the tools read it per call, but keep the order obvious).
rmSync(SANDBOX_DIR, { recursive: true, force: true });
mkdirSync(SANDBOX_DIR, { recursive: true });
process.env.ZIPNATIVE_MCP_OUTPUT_DIR = SANDBOX_DIR;
delete process.env.ZIPNATIVE_MCP_CACHE_DIR;

const { callToolDirect, ensureEngineReady } = await import(pathToFileURL(SERVER_MODULE).href);

const log = (s) => process.stderr.write(`${s}\n`);
const out = (s) => process.stdout.write(`${s}\n`);

function fail(label, err) {
    log(`FAIL  ${label}`);
    for (const line of String(err instanceof Error ? err.message : err).split(/\r?\n/)) log(`      ${line}`);
    return 1;
}

async function main() {
    await ensureEngineReady();
    mkdirSync(OUT_DIR, { recursive: true });

    const corpus = buildCorpus({ call: callToolDirect, sandboxDir: SANDBOX_DIR });
    // Prune archives left over from an older corpus layout so the validator's
    // "unlisted file" note only ever points at something unexpected. Only
    // top-level *.zip files are pruned — manifest.json, .sandbox/ and reports/
    // are never touched.
    const current = new Set(corpus.map((e) => e.file));
    for (const stale of readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.zip') && !current.has(f))) {
        rmSync(join(OUT_DIR, stale));
        out(`  pruned ${stale}`);
    }

    // Server identity for the manifest header (through the tool surface, not a src/ import).
    const describe = await callToolDirect('describe_engine', { fields: ['server', 'engine'] });
    if (describe.isError === true) return fail('describe_engine', describe.content?.[0]?.text ?? 'unknown error');
    const { server, engine } = describe.structuredContent;

    const ctx = createContext({ call: callToolDirect, sandboxDir: SANDBOX_DIR });
    const manifest = [];
    let totalBytes = 0;

    // Pass 1: write every file (tool or raw builder) and run the per-entry
    // structural assertions (`after`).
    for (const entry of corpus) {
        let bytes;
        try {
            bytes = await produceEntry(entry, ctx);
        } catch (err) {
            return fail(entry.file, err);
        }
        rmSync(join(OUT_DIR, entry.file), { force: true });
        writeFileSync(join(OUT_DIR, entry.file), bytes);
        totalBytes += bytes.byteLength;
        manifest.push({
            file: entry.file,
            bytes: bytes.byteLength,
            producedBy: entry.producedBy,
            ...(entry.tool !== null ? { tool: entry.tool } : {}),
            ...(entry.arguments !== null ? { arguments: entry.arguments } : {}),
            expectConformant: entry.expectConformant,
            expectedCheck: entry.expectedCheck,
            refusedBy: entry.refusedBy !== null ? { tool: entry.refusedBy.tool, code: entry.refusedBy.code } : null,
            integrityExclude: entry.integrityExclude,
            prefixed: entry.prefixed,
        });
        const note = !entry.expectConformant
            ? `NEGATIVE canary — must fail ${entry.expectedCheck}`
            : entry.refusedBy !== null ? `conformant, refused by ${entry.refusedBy.tool} (${entry.refusedBy.code})` : entry.note;
        out(`  wrote  ${entry.file.padEnd(30)} ${String(bytes.byteLength).padStart(8)} B  ${entry.producedBy.padEnd(12)} ${entry.tool !== null ? entry.tool.padEnd(11) : 'raw-builder'}${note ? `  ${note}` : ''}`);
    }

    // Pass 2: the server's own verdicts on the corpus it produced / must refuse.
    out('');
    let verified = 0;
    for (const entry of corpus) {
        const bytes = ctx.get(entry.file);
        if (entry.expectConformant && entry.producedBy !== 'crafted') {
            try {
                await assertVerified(entry, bytes, ctx);
                verified++;
            } catch (err) {
                return fail(`${entry.file} (verify_zip)`, err);
            }
        }
        if (entry.refusedBy !== null) {
            try {
                const r = await assertRefused(entry, bytes, ctx);
                out(`  refusal ok  ${entry.file.padEnd(30)} ${r.tool} → ${r.code}`);
            } catch (err) {
                return fail(`${entry.file} (refusal)`, err);
            }
        }
    }
    out(`  verify ok   ${verified} tool-produced archive(s) pass verify_zip with ok: true`);

    const negatives = manifest.filter((m) => !m.expectConformant).length;
    const hostile = manifest.filter((m) => m.expectConformant && m.refusedBy !== null).length;
    writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify({
        generatedBy: 'scripts/generate-zip-corpus.mjs',
        server: { name: server.name, version: server.version, toolApiVersion: server.toolApiVersion, zipnative: engine.version },
        node: process.version,
        platform: process.platform,
        files: manifest,
    }, null, 2)}\n`);

    out('');
    out('  Summary');
    out(`    conformant (tool)      ${manifest.filter((m) => m.expectConformant && m.producedBy !== 'crafted').length}`);
    out(`    conformant (crafted)   ${manifest.filter((m) => m.expectConformant && m.producedBy === 'crafted').length}  (${hostile} hostile, refused by the server)`);
    out(`    negative canaries      ${negatives}`);
    out(`    total                  ${manifest.length} file(s), ${totalBytes} bytes`);
    out(`\nZIP corpus: ${manifest.length} file(s), ${totalBytes} bytes, ${negatives} negative canar${negatives === 1 ? 'y' : 'ies'} → test-output/zip/ (manifest.json written)`);
    return 0;
}

process.exit(await main());
