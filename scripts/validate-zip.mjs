/**
 * zipnative-mcp — veraZIP: ISO/IEC 21320-1:2015 conformance validator
 * =====================================================================
 * Validates every archive in `test-output/zip/` (the corpus written by
 * scripts/generate-zip-corpus.mjs from the BUILT MCP tool handlers) against
 * ISO/IEC 21320-1:2015 (Document Container File — the ISO-standardised ZIP
 * profile, Library of Congress fdd000361), clause by clause, the way
 * veraPDF validates a closed ISO constraint list for PDF/A, and compares
 * each verdict with the manifest's expectation.
 *
 * VENDORED from zipnative (the engine does not ship scripts/ in its npm
 * tarball, so the validator is copied, not imported):
 *   upstream file:   scripts/validate-zip.ts
 *   upstream commit: e6f0b3f592e15be7b45a88b08fc3178862bce2d9 (zipnative 1.1.0)
 *   upstream blob:   604321fa40ef1afba04eb9ce14f53e0c19efa474
 *   via:             zipnative-cli 1.0.0 scripts/validate-zip.mjs (the 1:1 .mjs
 *                    port with the manifest driver). The parser body lives in
 *                    scripts/verazip-core.mjs so this driver and the vitest gate
 *                    (tests/_zip-assert.ts, tests/verazip.test.ts) share ONE source.
 *   sync rule:       when upstream's validate-zip.ts changes, re-port the parser
 *                    body 1:1 (types erased) into verazip-core.mjs and bump BOTH
 *                    hashes there and here in the same PR.
 *                    tests/verazip-vendor.test.ts pins the 23-id check vocabulary
 *                    and these hashes.
 *
 * INDEPENDENT BY CONSTRUCTION: the validator core raw-parses the bytes with
 * its own EOCD/CD/LFH reader and NEVER imports `zipnative`, `src/` or
 * `dist/` — a validator that shared the engine's parser would attest the
 * engine with the engine (the same anti-circularity rule the raw ZIP
 * builder in scripts/helpers/raw-zip-builder.mjs follows). This driver
 * imports only that core, the foreign-tool roster and node built-ins; it
 * never loads the server. The vendor test machine-checks this at text level.
 *
 * Three levels:
 *   0. ISO/IEC 21320-1 clause checks + APPNOTE well-formedness
 *      cross-checks (CD↔LFH agreement, offsets, overlap) — the checks
 *      lenient extractors forgive. ALWAYS runs.
 *   1. Foreign integrity pass (`unzip -t`, `7z t`, `python -m zipfile
 *      -t`, `tar -tf`, `jar tf`) over the conformant corpus when the
 *      tools exist — never simulated, absent tools are SKIPped.
 *   2. The differential-extraction matrix stays in zipnative's own
 *      interop suite (the posture Archivematica applies to ZIP packages:
 *      independent extraction + fixity).
 *
 * Usage:
 *   npm run validate:zip                 # build + corpus + validate
 *   node scripts/validate-zip.mjs        # validate an existing corpus only
 *
 * Environment:
 *   VERAZIP_REQUIRED=1        fail-closed: zero usable level-1 tools is an
 *                             INFRA failure (exit 3) instead of a skip. Set
 *                             in CI; unset locally so a bare machine never
 *                             blocks. Level 0 needs no tool and always runs.
 *   VERAZIP_REPORT_DIR=<dir>  where the per-file JSON reports and summary.json
 *                             go (default test-output/zip/reports/).
 *   VERAZIP_TOOLS=<ids|none>  restrict level 1 to a comma-separated subset of
 *                             bsdtar,unzip,7z,python-zipfile,jar; `none`
 *                             disables level 1 entirely.
 *
 * Outcomes per manifest file (one line each on stdout):
 *   PASS   conformant, and the manifest expected conformance.
 *   FAIL   non-conformant although the manifest expected conformance (first
 *          findings listed), OR a declared negative that failed with the
 *          WRONG check id — the crafted canary no longer proves what it
 *          claims to prove.
 *   XFAIL  non-conformant as expected — a negative canary rejected with its
 *          declared check id among the failures.
 *   XPASS  conformant although the manifest expects a failure: the validator
 *          is not validating ("accepts everything") — always fatal.
 *   INFRA  the parser threw or the file could not be read. Not a verdict.
 *   SKIP   reserved (every manifest entry is validated at level 0; level-1
 *          tools report `SKIP integrity <tool>` when absent).
 *
 * Exit codes:
 *   0 — every expectation met (or no level-1 tool is usable and
 *       VERAZIP_REQUIRED is unset: level 1 is SKIPPED — exit 0 is a skip of
 *       level 1, not a pass of it; level 0 verdicts still hold).
 *   1 — a conformance expectation was not met (FAIL / XPASS), a level-1 tool
 *       rejected a conformant archive, the coverage canary tripped (a
 *       manifest file is missing or is not a ZIP, or the corpus counts no
 *       longer match docs/data/verazip.json `declared`), the corpus has no
 *       negative canary, or a REQUIRED_NEGATIVE_CHECKS id has no canary.
 *   2 — the corpus directory / manifest is absent (run `npm run corpus:zip`).
 *   3 — INFRA: a file produced an INFRA outcome, or (VERAZIP_REQUIRED=1 only)
 *       zero level-1 tools are usable.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INTEGRITY_TOOLS } from './helpers/interop-tools.mjs';
import { REQUIRED_NEGATIVE_CHECKS, validateArchive } from './verazip-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = join(ROOT, 'test-output', 'zip');
const MANIFEST = join(CORPUS_DIR, 'manifest.json');
const DECLARED = join(ROOT, 'docs', 'data', 'verazip.json');
const REPORT_DIR = process.env.VERAZIP_REPORT_DIR ? resolve(process.env.VERAZIP_REPORT_DIR) : join(CORPUS_DIR, 'reports');
const REQUIRED = process.env.VERAZIP_REQUIRED === '1' || process.env.VERAZIP_REQUIRED === 'true';
const TOOL_FILTER = process.env.VERAZIP_TOOLS === undefined
    ? null
    : process.env.VERAZIP_TOOLS.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

const EXIT_OK = 0;
const EXIT_CONFORMANCE = 1;
const EXIT_NO_CORPUS = 2;
const EXIT_INFRA = 3;

const log = (s) => process.stderr.write(`${s}\n`);
const out = (s) => process.stdout.write(`${s}\n`);
const posix = (p) => p.split('\\').join('/');

// ── Main ─────────────────────────────────────────────────────────────

function infraExit(reason) {
    out(`  INFRA  ${reason}`);
    out('\nveraZIP infrastructure failure (VERAZIP_REQUIRED=1): level 1 validated nothing.');
    return EXIT_INFRA;
}

function main() {
    if (!existsSync(CORPUS_DIR) || !existsSync(MANIFEST)) {
        log('No ZIP corpus found in test-output/zip/. Run `npm run corpus:zip` first.');
        return EXIT_NO_CORPUS;
    }

    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const entries = Array.isArray(manifest.files) ? manifest.files : [];
    const listed = entries.map((f) => f.file);

    // Coverage canary: every manifest entry must exist on disk and at least
    // start like a ZIP — `PK` at offset 0 (local header, or the EOCD of an
    // empty archive), or for an entry flagged `prefixed: true` (SFX stub kept
    // in front of the archive) a local-file-header signature after the stub.
    // Never let the corpus shrink silently.
    const cases = [];
    let canaryFailures = 0;
    for (const entry of entries) {
        const name = entry.file;
        const file = join(CORPUS_DIR, name);
        if (!existsSync(file)) {
            log(`Coverage canary: ${name} is listed in manifest.json but missing on disk.`);
            canaryFailures++;
            continue;
        }
        let raw;
        try {
            raw = readFileSync(file);
        } catch (e) {
            log(`Coverage canary: ${name} cannot be read (${e instanceof Error ? e.message : String(e)}).`);
            canaryFailures++;
            continue;
        }
        const prefixed = entry.prefixed === true;
        const looksLikeZip = prefixed
            ? raw.indexOf(Buffer.from('PK\x03\x04', 'latin1')) > 0
            : raw.subarray(0, 2).equals(Buffer.from('PK', 'ascii'));
        if (!looksLikeZip) {
            log(`Coverage canary: ${name} ${prefixed ? 'has no local-file-header signature after its declared prefix' : 'does not start with PK'}.`);
            canaryFailures++;
            continue;
        }
        cases.push({
            file,
            name,
            expectConformant: entry.expectConformant !== false,
            expectedCheck: typeof entry.expectedCheck === 'string' ? entry.expectedCheck : null,
            refusedBy: entry.refusedBy && typeof entry.refusedBy === 'object' ? entry.refusedBy : null,
            integrityExclude: Array.isArray(entry.integrityExclude) ? entry.integrityExclude : [],
        });
    }
    const unlisted = readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith('.zip') && !listed.includes(f));
    if (unlisted.length > 0) {
        log(`Note: ${unlisted.length} ZIP(s) in test-output/zip/ are not in manifest.json and are ignored: ${unlisted.join(', ')}`);
    }
    if (listed.length === 0) {
        log('manifest.json lists no files. Run `npm run corpus:zip` first.');
        return EXIT_CONFORMANCE;
    }
    if (canaryFailures > 0) {
        log(`\nCoverage canary failed for ${canaryFailures} of ${listed.length} file(s).`);
        return EXIT_CONFORMANCE;
    }
    const negatives = cases.filter((c) => !c.expectConformant);
    log(`Corpus: ${listed.length} file(s) in manifest.json — ${negatives.length} negative canar${negatives.length === 1 ? 'y' : 'ies'}.`);
    if (negatives.length === 0) {
        // Without a file the validator must reject, a validator that accepts
        // everything would be indistinguishable from a fully conformant corpus.
        log('Negative canary missing: manifest.json has no file with expectConformant: false. Regenerate the corpus.');
        return EXIT_CONFORMANCE;
    }
    const declaredChecks = new Set(negatives.map((c) => c.expectedCheck).filter((c) => c !== null));
    const missingChecks = REQUIRED_NEGATIVE_CHECKS.filter((id) => !declaredChecks.has(id));
    if (missingChecks.length > 0) {
        log(`Coverage canary: no negative entry declares expectedCheck ${missingChecks.join(', ')} — the corpus generator must craft one for each of REQUIRED_NEGATIVE_CHECKS.`);
        return EXIT_CONFORMANCE;
    }
    for (const c of negatives) {
        if (c.expectedCheck === null) {
            log(`Coverage canary: ${c.name} is a negative entry without an expectedCheck id.`);
            return EXIT_CONFORMANCE;
        }
    }

    // ── Count canary (the zipnative ecosystem.json pattern) ──────────
    // docs/data/verazip.json is what the README / CONTRIBUTING / CONFORMANCE
    // guide quote; the corpus on disk must match it in both directions.
    const conformantCount = cases.length - negatives.length;
    const hostileCount = cases.filter((c) => c.expectConformant && c.refusedBy !== null).length;
    let declared;
    try {
        declared = JSON.parse(readFileSync(DECLARED, 'utf8')).declared;
    } catch (e) {
        log(`Coverage canary: cannot read docs/data/verazip.json (${e instanceof Error ? e.message : String(e)}).`);
        return EXIT_CONFORMANCE;
    }
    if (declared === undefined
        || declared.conformant !== conformantCount
        || declared.nonConformant !== negatives.length
        || declared.hostileConformant !== hostileCount) {
        log(`\nCoverage canary: scanned ${conformantCount} conformant (${hostileCount} hostile) + ${negatives.length} declared-non-conformant `
            + 'sample(s) but docs/data/verazip.json declares '
            + `${declared?.conformant ?? '(missing)'} (${declared?.hostileConformant ?? '(missing)'} hostile) + ${declared?.nonConformant ?? '(missing)'}.`
            + '\nAdded or removed a sample? Update declared in docs/data/verazip.json. Neither? Generation or validation regressed.');
        return EXIT_CONFORMANCE;
    }

    mkdirSync(REPORT_DIR, { recursive: true });
    log(`veraZIP: ISO/IEC 21320-1:2015 conformance over ${cases.length} archive(s)${REQUIRED ? ' — VERAZIP_REQUIRED=1 (fail-closed)' : ''}`);
    log(`Reports → ${posix(relative(ROOT, REPORT_DIR))}/`);

    // ── Level 0: ISO clause checks + well-formedness cross-checks ────
    const counts = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0, INFRA: 0 };
    const results = [];
    const showFindings = (failures) => {
        const shown = failures.slice(0, 5);
        for (const f of shown) out(`        - ${f.check}: ${f.detail}`);
        if (failures.length > shown.length) out(`        … (${failures.length - shown.length} more)`);
    };
    for (const c of cases) {
        const rel = posix(relative(ROOT, c.file));
        let report;
        try {
            report = validateArchive(new Uint8Array(readFileSync(c.file)), c.name);
        } catch (e) {
            counts.INFRA++;
            const detail = e instanceof Error ? e.message : String(e);
            out(`  INFRA  [iso21320]  ${rel}  (parser exception: ${detail})`);
            results.push({ ...c, outcome: 'INFRA', entries: 0, failures: [], notes: [`parser exception: ${detail}`] });
            continue;
        }
        const codes = report.failures.map((f) => f.check);
        let outcome;
        if (report.failures.length === 0 && c.expectConformant) {
            outcome = 'PASS';
            const refused = c.refusedBy !== null ? `  (conformant but refused by the server: ${c.refusedBy.tool} → ${c.refusedBy.code})` : '';
            out(`  PASS   [iso21320]  ${rel}  (${report.entries} entries)${refused}`);
        } else if (report.failures.length === 0) {
            outcome = 'XPASS';
            out(`  XPASS  [iso21320]  ${rel}  (negative canary ACCEPTED — expected ${c.expectedCheck} to fire; the validator is not validating)`);
        } else if (!c.expectConformant && codes.includes(c.expectedCheck)) {
            outcome = 'XFAIL';
            out(`  XFAIL  [iso21320]  ${rel}  (negative canary rejected as expected: ${c.expectedCheck})`);
        } else if (!c.expectConformant) {
            outcome = 'FAIL';
            out(`  FAIL   [iso21320]  ${rel}  (negative canary rejected, but ${c.expectedCheck} did not fire)`);
            showFindings(report.failures);
        } else {
            outcome = 'FAIL';
            out(`  FAIL   [iso21320]  ${rel}`);
            showFindings(report.failures);
        }
        for (const n of report.notes) out(`        note: ${n}`);
        counts[outcome]++;
        results.push({ ...c, outcome, entries: report.entries, failures: report.failures, notes: report.notes });
    }

    // ── Level 1: foreign integrity pass over the conformant corpus ───
    const conformant = results.filter((r) => r.outcome === 'PASS');
    const tools = TOOL_FILTER === null
        ? INTEGRITY_TOOLS
        : TOOL_FILTER.includes('none') ? [] : INTEGRITY_TOOLS.filter((t) => TOOL_FILTER.includes(t.id));
    if (TOOL_FILTER !== null) {
        const unknown = TOOL_FILTER.filter((id) => id !== 'none' && !INTEGRITY_TOOLS.some((t) => t.id === id));
        if (unknown.length > 0) log(`VERAZIP_TOOLS: unknown tool id(s) ignored: ${unknown.join(', ')}`);
    }
    const toolDescriptions = {};
    const integrity = new Map(results.map((r) => [r.name, {}]));
    let usableTools = 0;
    let integrityFailures = 0;
    log('');
    for (const tool of tools) {
        const description = tool.describe();
        toolDescriptions[tool.id] = description;
        if (description === null) {
            log(`SKIP  integrity ${tool.id} (not available)`);
            for (const r of conformant) integrity.get(r.name)[tool.id] = 'skip';
            continue;
        }
        usableTools++;
        let ok = 0;
        let excluded = 0;
        const failed = [];
        for (const r of conformant) {
            const exclusions = r.integrityExclude;
            if (exclusions.includes(tool.id) || exclusions.includes(`${tool.id}@${process.platform}`)) {
                excluded++;
                integrity.get(r.name)[tool.id] = 'excluded';
                continue;
            }
            if (tool.test(r.file)) {
                ok++;
                integrity.get(r.name)[tool.id] = 'ok';
            } else {
                failed.push(r.name);
                integrity.get(r.name)[tool.id] = 'fail';
            }
        }
        if (failed.length === 0) {
            const skipNote = excluded > 0 ? ` (${excluded} documented exclusion(s))` : '';
            log(`OK    integrity ${tool.id}: ${ok}/${conformant.length - excluded}${skipNote} — ${description}`);
        } else {
            integrityFailures += failed.length;
            log(`FAIL  integrity ${tool.id}: ${failed.length} archive(s) rejected — ${failed.join(', ')}`);
            log('      reproduce locally with the tool\'s own test command on the file(s) above; '
                + 'exit codes are read per tool contract (scripts/helpers/interop-tools.mjs)');
        }
    }
    for (const tool of INTEGRITY_TOOLS) {
        if (!(tool.id in toolDescriptions)) toolDescriptions[tool.id] = null;
    }

    // ── Reports ──────────────────────────────────────────────────────
    for (const r of results) {
        const report = {
            file: r.name,
            outcome: r.outcome,
            entries: r.entries,
            failures: r.failures,
            notes: r.notes,
            refusedBy: r.refusedBy,
            integrity: integrity.get(r.name),
        };
        writeFileSync(join(REPORT_DIR, `${r.name.replace(/\.zip$/i, '')}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
    writeFileSync(join(REPORT_DIR, 'summary.json'), `${JSON.stringify({
        counts,
        corpus: { conformant: conformantCount, hostileConformant: hostileCount, nonConformant: negatives.length },
        tools: toolDescriptions,
        platform: process.platform,
        node: process.version,
    }, null, 2)}\n`);

    // ── Verdict ──────────────────────────────────────────────────────
    out('');
    out(`Summary: ${counts.PASS} PASS, ${counts.XFAIL} XFAIL, ${counts.FAIL} FAIL, ${counts.XPASS} XPASS, ${counts.INFRA} INFRA (of ${cases.length}).`);
    if (counts.INFRA > 0) {
        out('INFRA: the parser produced no verdict for some files — not a conformance result. See the reports.');
        return EXIT_INFRA;
    }
    if (counts.XPASS > 0) {
        out('XPASS: a file that must be rejected was accepted — the validator accepts everything; do not trust the PASS lines.');
        return EXIT_CONFORMANCE;
    }
    if (counts.FAIL > 0) return EXIT_CONFORMANCE;
    if (integrityFailures > 0) {
        out(`Level 1: ${integrityFailures} foreign-tool rejection(s) of conformant archives.`);
        return EXIT_CONFORMANCE;
    }
    if (usableTools === 0) {
        if (REQUIRED) return infraExit(`no usable level-1 integrity tool (${tools.length === 0 ? 'VERAZIP_TOOLS disabled level 1' : 'none of ' + tools.map((t) => t.id).join(', ') + ' is installed'})`);
        out('\nSKIPPED: no foreign integrity tool available — level 1 validated nothing (exit 0 is a skip, not a pass; set VERAZIP_REQUIRED=1 to fail instead). Level 0 verdicts above still hold.');
        return EXIT_OK;
    }
    out('All expectations met.');
    return EXIT_OK;
}

process.exit(main());
