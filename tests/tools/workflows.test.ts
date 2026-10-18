import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Workflow, supply-chain and contributor invariants ─────────────────
//
// None of this is visible to the type checker or to the test suite proper:
// a floating action tag, a checkout that keeps the job token, a release job
// that quietly skips the veraZIP judges, an npm client that drifts between
// two publishes. Each is locked here as a plain-text assertion on the files
// that carry it. Ported from pkinative-mcp 1.0.0 (tests/tools/workflows.test.ts),
// with the veraZIP workflow this repository keeps instead of OpenSSL interop
// and zipnative 1.1.0's verify → publish → attest release graph.

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort();
// Every tracked text blob is LF (.gitattributes eol=lf), but a working copy
// may still be CRLF on Windows; normalise so the regexes below see one line ending.
const readWorkflow = (f: string): string => readFileSync(join(WORKFLOWS, f), 'utf8').replace(/\r\n/g, '\n');
const readText = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
/** Escape every regular-expression metacharacter, backslash included, of a literal. */
const escapeRegExp = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

const HARDEN_RUNNER = 'step-security/harden-runner@';

/** The seven contexts the main ruleset requires, in ruleset order. */
const REQUIRED_CHECKS = [
    'ci (22)', 'ci (24)', 'os (windows-latest)', 'os (macos-latest)', 'sample-regression',
    'verazip (ubuntu-latest)', 'verazip (windows-latest)',
];

/** Every `- name:`/`- uses:` step block of every job, in order, keyed by job id. */
function jobSteps(text: string): Map<string, string[]> {
    const jobs = new Map<string, string[]>();
    const jobsAt = text.search(/^jobs:\s*$/m);
    if (jobsAt < 0) return jobs;
    let job: string | null = null;
    let steps: string[] | null = null;
    for (const line of text.slice(jobsAt).split('\n').slice(1)) {
        const jobHead = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (jobHead) { job = jobHead[1] ?? null; steps = null; continue; }
        if (/^ {4}steps:\s*$/.test(line) && job !== null) { steps = []; jobs.set(job, steps); continue; }
        if (steps === null) continue;
        if (/^ {6}- /.test(line)) steps.push(line);
        else if (/^ {8,}\S/.test(line) && steps.length > 0) steps[steps.length - 1] += `\n${line}`;
    }
    return jobs;
}

/** The body of one job, from its `  <id>:` line to the next job head, comment lines dropped. */
function jobBody(text: string, id: string): string {
    const m = new RegExp(`^ {2}${escapeRegExp(id)}:\\s*\\n([\\s\\S]*?)(?=^ {2}[a-z-]+:\\s*$|(?![\\s\\S]))`, 'm').exec(text);
    return (m?.[1] ?? '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

function requiredContexts(): string[] {
    const ruleset = JSON.parse(readText('.github', 'rulesets', 'main.json')) as {
        rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }>;
    };
    return ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks?.map((c) => c.context) ?? [];
}

// ── Actions: pinned, hardened, credential-free ───────────────────────

describe('every workflow', () => {
    const allFiles = workflowFiles.map((f) => ({ label: f, text: readWorkflow(f) }));

    it('is the expected set of workflows', () => {
        expect(workflowFiles).toEqual([
            'audit.yml', 'ci.yml', 'codeql.yml', 'dependency-review.yml', 'docs.yml',
            'node-current.yml', 'publish.yml', 'sample-regression.yml', 'scorecard.yml', 'verazip.yml',
        ]);
    });

    it('pins every action to a 40-hex commit SHA with a version comment', () => {
        for (const { label, text } of allFiles) {
            const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)[^\n]*$/gm)];
            expect(uses.length, `${label} declares no action`).toBeGreaterThan(0);
            for (const m of uses) {
                const ref = m[1] ?? '';
                expect(ref, `${label}: ${ref}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
                expect(m[0], `${label}: ${ref} lacks a "# vX.Y.Z" comment`).toMatch(/#\s*v\d+\.\d+\.\d+\s*$/);
            }
        }
    });

    it('pins each action to ONE SHA across the tree (no version drift between workflows)', () => {
        const pins = new Map<string, Set<string>>();
        for (const { text } of allFiles) {
            for (const m of text.matchAll(/uses:\s*([^@\s]+)@([0-9a-f]{40})/g)) {
                const name = m[1] ?? '';
                // github/codeql-action/{init,autobuild,analyze,upload-sarif} share one release.
                const action = name.startsWith('github/codeql-action/') ? 'github/codeql-action' : name;
                const set = pins.get(action) ?? new Set<string>();
                set.add(m[2] ?? '');
                pins.set(action, set);
            }
        }
        for (const [action, shas] of pins) expect([...shas], action).toHaveLength(1);
    });

    it('every actions/checkout step disables persist-credentials', () => {
        for (const { label, text } of allFiles) {
            const re = /uses: actions\/checkout@[^\n]*\n((?:[ \t]+[^\n]*\n)*)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                const block = (m[1] ?? '').split('\n').filter((l) => l.trim() !== '' && !/^\s+- /.test(l));
                expect(block.some((l) => /persist-credentials:\s*false/.test(l)), `${label}: checkout keeps credentials`).toBe(true);
            }
        }
    });

    it('declares top-level permissions with contents: read (or read-all)', () => {
        for (const { label, text } of allFiles) {
            expect(text, `${label}: permissions`).toMatch(/^permissions:(?:\s*read-all\s*$|\s*\n(?: {2}[a-z-]+:\s*\w+\s*\n)* {2}contents:\s*read\s*$)/m);
        }
    });

    it('grants no write permission at the workflow level', () => {
        for (const { label, text } of allFiles) {
            const top = /^permissions:[^\n]*\n((?: {2}[^\n]*\n)*)/m.exec(text)?.[1] ?? '';
            expect(top, label).not.toMatch(/:\s*write/);
        }
    });
});

describe('every workflow job', () => {
    it('starts with harden-runner in audit mode (skipped on macOS only, by condition)', () => {
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            const jobs = jobSteps(text);
            expect(jobs.size, `${f}: no job with steps`).toBeGreaterThan(0);
            for (const [job, steps] of jobs) {
                const first = steps[0] ?? '';
                expect(first, `${f} › ${job}: first step`).toContain(HARDEN_RUNNER);
                expect(first, `${f} › ${job}: egress policy`).toMatch(/egress-policy:\s*audit/);
                const conditional = /if:\s*runner\.os != 'macOS'/.test(first);
                const hasMacLeg = /macos-latest/.test(jobBody(text, job));
                expect(conditional, `${f} › ${job}: harden-runner is conditional only on a job with a macOS leg`).toBe(hasMacLeg);
            }
        }
    });

    it('installs dependencies with --ignore-scripts', () => {
        for (const f of workflowFiles) {
            for (const m of readWorkflow(f).matchAll(/run: npm ci\b[^\n]*/g)) {
                expect(m[0], f).toContain('npm ci --ignore-scripts');
            }
        }
    });

    it('declares permissions, a timeout and (except publish) a cancelling concurrency group', () => {
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            expect(text, `${f}: permissions`).toMatch(/^permissions:/m);
            for (const job of jobSteps(text).keys()) {
                expect(jobBody(text, job), `${f} › ${job}: timeout`).toMatch(/timeout-minutes:\s*\d+/);
            }
            if (f === 'publish.yml') continue;
            if (['audit.yml', 'dependency-review.yml'].includes(f)) continue; // single short job, no cancel needed
            expect(text, `${f}: concurrency`).toMatch(/concurrency:\s*\n\s*group:[^\n]+\n\s*cancel-in-progress:\s*true/);
        }
    });

    it('requires the veraZIP level-1 judges wherever the gate runs', () => {
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            if (!/scripts\/gate\.ts --(?:ci|publish) --require-all/.test(text) && f !== 'verazip.yml') continue;
            expect(text, `${f}: VERAZIP_REQUIRED`).toMatch(/VERAZIP_REQUIRED:\s*'1'/);
        }
    });

    it('never names a write-capable token secret', () => {
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            expect(text, f).not.toMatch(/secrets\.(?!GITHUB_TOKEN)[A-Z_]+/);
        }
    });

    it('analyses with the security-extended suite like zipnative, over the shipped code', () => {
        const codeql = readWorkflow('codeql.yml');
        expect(codeql).toMatch(/queries:\s*security-extended/);
        expect(codeql).toMatch(/config-file:\s*\.\/\.github\/codeql\/codeql-config\.yml/);
        // security-events: write lives on the job (Scorecard Token-Permissions, alert #3).
        expect(jobBody(codeql, 'analyze')).toMatch(/security-events:\s*write/);
        const config = readText('.github', 'codeql', 'codeql-config.yml');
        expect(config).toMatch(/^paths-ignore:\s*\n\s*- dist\s*$/m);
        expect(config).not.toMatch(/^\s*- tests\s*$/m);
    });
});

// ── The gate is the only definition of green ─────────────────────────

describe('ci.yml', () => {
    const ci = readWorkflow('ci.yml');

    it('keeps the job id and matrix the ruleset requires (ci (22), ci (24))', () => {
        expect(ci).toMatch(/^ {2}ci:\s*$/m);
        expect(ci).toMatch(/node-version:\s*\[22, 24\]/);
        expect(requiredContexts()).toEqual(REQUIRED_CHECKS);
    });

    it('runs the gate with --require-all and audits outside it', () => {
        expect(ci).toMatch(/run: npx tsx scripts\/gate\.ts --ci --require-all/);
        expect(ci).toMatch(/run: npm audit --audit-level=high/);
        expect(ci).toMatch(/if: failure\(\)[\s\S]*upload-artifact[\s\S]*test-output\/\.gate\//);
    });

    it('does not path-ignore the docs: they are contracts', () => {
        expect(ci).not.toMatch(/- '\*\*\.md'/);
        expect(ci).not.toMatch(/- 'docs\/\*\*'/);
    });

    it('A-009: the pull_request trigger has no path filter (its jobs are required checks)', () => {
        const pr = /^ {2}pull_request:\s*\n((?: {4}[^\n]*\n)*)/m.exec(ci)?.[1] ?? '';
        expect(pr).toMatch(/branches:/);
        expect(pr).not.toMatch(/paths(-ignore)?:/);
    });

    it('lists no gate step by hand', () => {
        for (const job of ['ci', 'os']) {
            const gated = (jobSteps(ci).get(job) ?? []).join('\n');
            expect(gated, job).toContain('scripts/gate.ts');
            for (const step of ['typecheck:all', 'test:coverage', 'validate:zip', 'corpus:zip', 'verify:samples', 'verify:docs', 'npm run build', 'npm run lint', 'npm test', 'node dist/cli.js']) {
                expect(gated, `${job}: ${step}`).not.toMatch(new RegExp(`run: (npm run )?${escapeRegExp(step)}\\s*$`, 'm'));
            }
        }
    });

    it('runs the same gate on windows-latest and macos-latest from the pinned Node line', () => {
        const steps = jobSteps(ci).get('os') ?? [];
        const index = (needle: string): number => steps.findIndex((s) => s.includes(needle));
        expect(ci).toMatch(/^ {2}os:\s*\n\s*runs-on:\s*\$\{\{ matrix\.os \}\}/m);
        expect(ci).toMatch(/os:\s*\[windows-latest, macos-latest\]/);
        expect(steps.some((s) => /node-version-file:\s*\.nvmrc/.test(s)), 'setup-node reads .nvmrc').toBe(true);
        expect(index('run: npm ci --ignore-scripts')).toBeGreaterThanOrEqual(0);
        expect(index('run: npx tsx scripts/gate.ts --ci --require-all')).toBeGreaterThan(index('run: npm ci --ignore-scripts'));
        expect(ci).toMatch(/harden-runner supports Windows runners in audit mode only/);
    });
});

// ── veraZIP: the external judge, on two images ───────────────────────

describe('verazip.yml', () => {
    const wf = readWorkflow('verazip.yml');
    const steps = jobSteps(wf).get('verazip') ?? [];
    const index = (needle: string | RegExp): number => steps.findIndex((s) => (typeof needle === 'string' ? s.includes(needle) : needle.test(s)));

    it('runs on push, pull request and on demand, with no paths filter', () => {
        expect(wf).toMatch(/^on:\s*\n\s*push:\s*\n\s*branches:[^\n]*\n\s*pull_request:/m);
        expect(wf).toMatch(/workflow_dispatch:/);
        expect(wf).not.toMatch(/^\s*paths(-ignore)?:/m);
    });

    it('is the `verazip` job over Linux and Windows, both required checks', () => {
        expect(wf).toMatch(/^ {2}verazip:\s*\n\s*runs-on:\s*\$\{\{ matrix\.os \}\}/m);
        expect(wf).toMatch(/os:\s*\[ubuntu-latest, windows-latest\]/);
        expect(wf).not.toMatch(/^ {4}name:/m); // the default `verazip (<os>)` context names
        expect(requiredContexts()).toEqual(expect.arrayContaining(['verazip (ubuntu-latest)', 'verazip (windows-latest)']));
    });

    it('installs, records the tools, builds, generates the corpus and validates in order', () => {
        const order = [
            index('run: npm ci --ignore-scripts'),
            index('Record tool versions (Linux)'),
            index('Record tool versions (Windows)'),
            index('run: npm run build'),
            index('run: npm run corpus:zip'),
            index('node scripts/validate-zip.mjs'),
        ];
        expect(order.every((i) => i >= 0), `steps: ${order.join(',')}`).toBe(true);
        for (let i = 1; i < order.length; i++) expect(order[i], `step ${i}`).toBeGreaterThan(order[i - 1] ?? -1);
        expect(wf).toMatch(/VERAZIP_REQUIRED:\s*'1'/);
    });

    it('uploads the manifest and the reports always, and writes a verdict summary', () => {
        const upload = steps[index('upload-artifact')] ?? '';
        expect(upload).toMatch(/if: always\(\)/);
        expect(upload).toContain('test-output/zip/manifest.json');
        expect(upload).toContain('test-output/zip/reports/');
        const summary = steps[index('Job summary')] ?? '';
        expect(summary).toMatch(/if: always\(\)/);
        expect(summary).toMatch(/GITHUB_STEP_SUMMARY/);
        expect(summary).toMatch(/INFRA/);
        expect(wf).not.toMatch(/^\s*continue-on-error:/m);
    });

    it('declares the corpus counts docs/data/verazip.json declares', () => {
        const declared = (JSON.parse(readText('docs', 'data', 'verazip.json')) as {
            declared: { conformant: number; nonConformant: number; hostileConformant: number };
        }).declared;
        const total = declared.conformant + declared.nonConformant;
        expect(wf).toContain(`a corpus of ${total} archives`);
        expect(wf).toContain(`(${declared.conformant} conformant, ${declared.hostileConformant} of which`);
        expect(wf).toContain(`+ ${declared.nonConformant} negative canaries`);
    });
});

// ── Publish: verify → publish → attest → registry ────────────────────

describe('publish.yml', () => {
    const publish = readWorkflow('publish.yml');
    const jobs = jobSteps(publish);

    it('is the four-job release graph', () => {
        expect([...jobs.keys()]).toEqual(['verify', 'publish', 'attest', 'registry']);
        expect(jobBody(publish, 'publish')).toMatch(/needs:\s*verify/);
        expect(jobBody(publish, 'attest')).toMatch(/needs:\s*publish/);
        expect(jobBody(publish, 'registry')).toMatch(/needs:\s*\[verify, attest\]/);
    });

    it('mints an OIDC token and never reads an NPM_TOKEN secret', () => {
        expect(publish).toMatch(/^\s*id-token:\s*write/m);
        expect(publish).not.toMatch(/NPM_TOKEN\s*\}\}/);
        expect(publish).not.toMatch(/NODE_AUTH_TOKEN/);
    });

    it('publishes from the npm-publish environment, one release at a time', () => {
        expect(jobBody(publish, 'publish')).toMatch(/^\s*environment:\s*npm-publish\s*$/m);
        expect(publish).toMatch(/concurrency:\s*\n\s*group:\s*publish\s*\n\s*cancel-in-progress:\s*false/);
        // Only the publish job enters the environment the Trusted Publishing entry names.
        expect((publish.match(/^\s*environment:/gm) ?? []).length).toBe(1);
    });

    it('gives the verify job no id-token: dev dependencies can never mint a publishing token', () => {
        const verify = jobBody(publish, 'verify');
        expect(verify).not.toMatch(/id-token:\s*write/);
        expect(verify).not.toMatch(/contents:\s*write/);
    });

    it('holds contents: write in the attest job only, with exactly three permissions there', () => {
        const writes = [...jobs.keys()].filter((j) => /contents:\s*write/.test(jobBody(publish, j)));
        expect(writes).toEqual(['attest']);
        const perms = /permissions:\s*\n((?:\s{6}[a-z-]+:\s*\w+\s*\n)+)/.exec(jobBody(publish, 'attest'));
        expect(perms).not.toBeNull();
        const granted = (perms?.[1] ?? '').trim().split('\n').map((l) => l.trim()).sort();
        expect(granted).toEqual(['attestations: write', 'contents: write', 'id-token: write']);
    });

    it('A-004: the publish gate fails closed on veraZIP (VERAZIP_REQUIRED on the gate step)', () => {
        const gate = (jobs.get('verify') ?? []).find((s) => s.includes('scripts/gate.ts --publish --require-all')) ?? '';
        expect(gate).toMatch(/VERAZIP_REQUIRED:\s*'1'/);
    });

    it('A-010: the pinned npm client is installed without lifecycle scripts', () => {
        for (const m of publish.matchAll(/npm install -g[^\n]*/g)) expect(m[0]).toContain('--ignore-scripts');
    });

    it('pins the npm client to one exact 11.x release, at least 11.5.1, in the jobs that pack and publish', () => {
        const pins = [...publish.matchAll(/npm install -g (?:--ignore-scripts )?npm@(\S+)/g)].map((m) => m[1] ?? '');
        expect(pins.length).toBe(2);
        expect(new Set(pins).size).toBe(1);
        const pin = pins[0] ?? '';
        expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
        const [major = 0, minor = 0, patch = 0] = pin.split('.').map(Number);
        expect(major === 11 && (minor > 5 || (minor === 5 && patch >= 1))).toBe(true);
        expect(publish).toContain(`test "$(npm --version)" = "${pin}"`);
    });

    it('builds on the .nvmrc Node line, runs the publish gate, packs once and publishes that tarball with provenance', () => {
        expect(publish).toMatch(/node-version-file:\s*\.nvmrc/);
        expect(publish).not.toMatch(/node-version:\s*'>=/);
        const steps = jobs.get('verify') ?? [];
        const index = (needle: string | RegExp): number => steps.findIndex((s) => (typeof needle === 'string' ? s.includes(needle) : needle.test(s)));
        const install = index('run: npm ci --ignore-scripts');
        const audit = index('run: npm audit --audit-level=high');
        const gate = index('run: npx tsx scripts/gate.ts --publish --require-all');
        const dry = index('run: npm pack --dry-run');
        const pack = index('npm pack --json');
        expect([install, audit, gate, dry, pack].every((i) => i >= 0)).toBe(true);
        expect(install).toBeLessThan(audit);
        expect(audit).toBeLessThan(gate);
        expect(gate).toBeLessThan(dry);
        expect(dry).toBeLessThan(pack);
        expect(steps[pack]).toMatch(/npm sbom --sbom-format cyclonedx --omit dev --package-lock-only/);
        expect(publish).not.toMatch(/cyclonedx-npm/);
        expect((publish.match(/npm pack --json/g) ?? []).length).toBe(1);
        expect(jobBody(publish, 'publish')).toMatch(/run: npm publish "\.\/zipnative-mcp-\$\{VERSION\}\.tgz" --provenance --access public\s*$/m);
        for (const hand of ['npm run validate:zip', 'npm run corpus:zip', 'npm run verify:samples', 'npm run test:coverage', 'npm run typecheck:all']) {
            expect(publish, hand).not.toContain(`run: ${hand}`);
        }
    });

    it('re-checks the handed-on tarball against the verify job digests before publishing', () => {
        const publishJob = jobBody(publish, 'publish');
        expect(publishJob).toMatch(/sparse-checkout:\s*\.nvmrc/);
        expect(publishJob).not.toMatch(/npm ci/);
        expect(publishJob).toMatch(/sha256sum --check --strict SHA256SUMS/);
        expect(publishJob).toMatch(/The tarball holds version/);
    });

    it('verifies the tag against package.json and server.json', () => {
        expect(publish).toMatch(/does not match package\.json version/);
        expect(publish).toMatch(/require\('\.\/server\.json'\)\.version/);
    });

    it('attests the tarball and the SBOM after comparing them with what the registry serves', () => {
        const body = jobBody(publish, 'attest');
        expect(body).toMatch(/npm view "zipnative-mcp@\$\{VERSION\}" dist\.integrity/);
        expect(body).toMatch(/cmp "registry\/zipnative-mcp-\$\{VERSION\}\.tgz"/);
        expect(body).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40}/);
        expect(body).toMatch(/zipnative-mcp-\$\{\{ env\.VERSION \}\}\.cdx\.json/);
        expect(body).toMatch(/gh release view "v\$\{VERSION\}"[\s\S]*gh release upload "v\$\{VERSION\}"[^\n]*--clobber/);
        expect(body).not.toMatch(/gh release create/);
    });

    it('publishes server.json to the MCP registry with mcp-publisher pinned by version and SHA-256', () => {
        const body = jobBody(publish, 'registry');
        expect(body).toMatch(/MCP_PUBLISHER_VERSION:\s*v\d+\.\d+\.\d+\s*$/m);
        expect(body).toMatch(/MCP_PUBLISHER_SHA256:\s*[0-9a-f]{64}\s*$/m);
        expect(body).toMatch(/sha256sum --check --strict/);
        expect(body).toMatch(/mcp-publisher login github-oidc/);
        expect(body).toMatch(/mcp-publisher publish/);
        expect(body).toMatch(/id-token:\s*write/);
        expect(body).not.toMatch(/contents:\s*write/);
        expect(body).toMatch(/if: \$\{\{ !inputs\.dry-run \}\}/);
    });

    it('lists the endpoints for the future block policy', () => {
        for (const host of ['github.com', 'api.github.com', 'registry.npmjs.org', 'fulcio.sigstore.dev', 'rekor.sigstore.dev', 'tuf-repo-cdn.sigstore.dev', 'registry.modelcontextprotocol.io']) {
            expect(publish).toContain(host);
        }
    });
});

describe('package.json publish settings', () => {
    const pkg = JSON.parse(readText('package.json')) as {
        publishConfig?: Record<string, unknown>;
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
    };

    it('declares public access with provenance', () => {
        expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
    });

    it('keeps exactly three runtime dependencies', () => {
        expect(Object.keys(pkg.dependencies).sort()).toEqual(['@modelcontextprotocol/server', 'zipnative', 'zod']);
    });

    it('does not rely on lifecycle scripts that .npmrc disables', () => {
        // ignore-scripts=true: `prepare` would never run, so the build is a gate step.
        expect(pkg.scripts['prepare']).toBeUndefined();
        expect(pkg.scripts['prepublishOnly']).toBe('npm run build');
    });

    it('exposes the opt-in git hooks', () => {
        expect(pkg.scripts['hooks:install']).toBe('node scripts/install-git-hooks.mjs');
        expect(pkg.scripts['hooks:uninstall']).toBe('node scripts/install-git-hooks.mjs --uninstall');
        expect(existsSync(join(ROOT, '.githooks', 'pre-commit'))).toBe(true);
        expect(existsSync(join(ROOT, '.githooks', 'pre-push'))).toBe(true);
        expect(readText('.githooks', 'pre-push')).toContain('scripts/gate.ts --fast');
        expect(readText('.githooks', 'pre-commit')).toMatch(/npm run lint/);
    });

    it('names every script the workflows call', () => {
        for (const f of workflowFiles) {
            for (const m of readWorkflow(f).matchAll(/npm run ([a-z:-]+)/g)) {
                expect(pkg.scripts[m[1] ?? ''], `${f}: npm run ${m[1]}`).toBeDefined();
            }
        }
    });
});

// ── Sample regression: a required check with no paths filter ─────────

describe('sample-regression.yml', () => {
    const wf = readWorkflow('sample-regression.yml');

    it('runs on every push and pull request, with no paths filter, deciding the scope inside', () => {
        expect(wf).toMatch(/^on:\s*\n\s*push:\s*\n\s*branches:[^\n]*\n\s*pull_request:/m);
        expect(wf).not.toMatch(/^\s*paths(-ignore)?:/m);
        expect(wf).toMatch(/package-lock\\\.json/);
        expect(wf).toMatch(/tests\/fixtures\//); // the frozen example inputs the samples read
    });

    it('builds the server before generating and verifying strictly', () => {
        const steps = jobSteps(wf).get('sample-regression') ?? [];
        const index = (needle: string): number => steps.findIndex((s) => s.includes(needle));
        expect(index('run: npm run build')).toBeGreaterThan(index('run: npm ci --ignore-scripts'));
        expect(index('run: npm run test:generate')).toBeGreaterThan(index('run: npm run build'));
        expect(index('run: npx tsx scripts/verify-samples.ts --strict')).toBeGreaterThan(index('run: npm run test:generate'));
    });
});

// ── Node Current: advisory, never required, never masked ─────────────

describe('node-current.yml', () => {
    const wf = readWorkflow('node-current.yml');

    it('runs the gate on Node 26 as an advisory check, with no continue-on-error', () => {
        expect(wf).toMatch(/node-version:\s*26/);
        expect(wf).toMatch(/run: npx tsx scripts\/gate\.ts --ci --require-all/);
        expect(wf).not.toMatch(/^\s*continue-on-error:/m); // a YAML key, not the comment that explains its absence
        expect(requiredContexts().some((c) => /node/i.test(c))).toBe(false);
    });
});

// ── Dependency hygiene ───────────────────────────────────────────────

describe('dependency review and audit', () => {
    it('reviews every pull request for high vulnerabilities and licences (Apache-2.0 for the SDK)', () => {
        const review = readWorkflow('dependency-review.yml');
        expect(review).toMatch(/^on:\s*\n\s*pull_request:/m);
        expect(review).toMatch(/uses: actions\/dependency-review-action@[0-9a-f]{40}/);
        expect(review).toMatch(/fail-on-severity:\s*high/);
        expect(review).toMatch(/allow-licenses:[^\n]*\bMIT\b[^\n]*\bApache-2\.0\b/);
        expect(review).not.toMatch(/^\s*deny-licenses:/m);
        expect(review).not.toMatch(/allow-licenses:.*(GPL|MPL-2\.0|LicenseRef)/);
        expect(review).toMatch(/comment-summary-in-pr:\s*on-failure/);
    });

    it('audits the lockfile weekly, the runtime tree at the lowest level', () => {
        const audit = readWorkflow('audit.yml');
        expect(audit).toMatch(/schedule:\s*\n\s*- cron:/);
        expect(audit).toMatch(/workflow_dispatch:/);
        expect(audit).toMatch(/run: npm ci --ignore-scripts/);
        expect(audit).toMatch(/run: npm audit --audit-level=high/);
        expect(audit).toMatch(/run: npm audit --omit dev --audit-level=low/);
    });

    it('.npmrc, .nvmrc and .node-version carry the contributor defaults', () => {
        expect(readText('.npmrc')).toBe('ignore-scripts=true\nfund=false\naudit-level=high\n');
        expect(readText('.node-version')).toBe('22\n');
        expect(readText('.nvmrc')).toBe('22\n');
    });

    it('keeps dependabot on npm and github-actions, weekly, with the toolchain majors held back', () => {
        const bot = readText('.github', 'dependabot.yml');
        expect(bot).toMatch(/package-ecosystem:\s*npm/);
        expect(bot).toMatch(/package-ecosystem:\s*github-actions/);
        expect((bot.match(/interval:\s*weekly/g) ?? []).length).toBe(2);
        for (const name of ['typescript', 'eslint', '@eslint/js', 'vitest', '@types/node']) {
            expect(bot).toMatch(new RegExp(`dependency-name:\\s*"${escapeRegExp(name)}"\\s*\\n\\s*update-types:\\s*\\["version-update:semver-major"\\]`));
        }
    });

    it('protects release tags with a ruleset the maintainer creates tags under', () => {
        const tags = JSON.parse(readText('.github', 'rulesets', 'tags.json')) as {
            target: string; conditions: { ref_name: { include: string[] } }; rules: Array<{ type: string }>;
        };
        expect(tags.target).toBe('tag');
        expect(tags.conditions.ref_name.include).toEqual(['refs/tags/v*']);
        expect(tags.rules.map((r) => r.type).sort()).toEqual(['deletion', 'non_fast_forward', 'update']);
    });

    it('main ruleset: targets the default branch, no deletion, no force push, pull request required with threads resolved', () => {
        const main = JSON.parse(readText('.github', 'rulesets', 'main.json')) as {
            target: string; conditions: { ref_name: { include: string[] } }; rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
        };
        expect(main.target).toBe('branch');
        // The live 1.0.0 ruleset had `include: []` and protected nothing (Scorecard Branch-Protection, alert #1).
        expect(main.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
        const types = main.rules.map((r) => r.type);
        expect(types).toEqual(expect.arrayContaining(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']));
        const pr = main.rules.find((r) => r.type === 'pull_request')?.parameters ?? {};
        expect(pr['required_review_thread_resolution']).toBe(true);
    });

    it('every required context is produced by a workflow job', () => {
        const produced = new Set<string>();
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            for (const job of jobSteps(text).keys()) {
                const body = jobBody(text, job);
                const name = /^ {4}name:\s*(.+)$/m.exec(body)?.[1]?.trim();
                const matrix = /^\s*(node-version|os):\s*\[([^\]]+)\]/m.exec(body);
                if (matrix !== null && name === undefined) {
                    for (const v of (matrix[2] ?? '').split(',')) produced.add(`${job} (${v.trim()})`);
                } else {
                    produced.add(name ?? job);
                }
            }
        }
        for (const context of requiredContexts()) expect(produced.has(context), context).toBe(true);
    });
});

// ── Security Insights: true of the workflows ─────────────────────────

describe('SECURITY-INSIGHTS.yml', () => {
    const insights = readText('.github', 'SECURITY-INSIGHTS.yml');

    it('names every workflow it cites, and those workflows exist', () => {
        for (const m of insights.matchAll(/\(([a-z-]+\.yml)/g)) {
            expect(workflowFiles, m[1]).toContain(m[1]);
        }
    });

    it('declares the three distribution points the publish workflow serves', () => {
        expect(insights).toContain('https://www.npmjs.com/package/zipnative-mcp');
        expect(insights).toContain('https://github.com/Nizoka/zipnative-mcp/releases');
        expect(insights).toContain('https://registry.modelcontextprotocol.io');
    });
});

// ── Contributor checklist parity ─────────────────────────────────────

describe('pull request template', () => {
    const template = readText('.github', 'pull_request_template.md');

    it('lists the gate, the release flow and the ZIP-specific checks', () => {
        expect(template).toMatch(/`npm run gate` passes/);
        for (const mention of ['ROADMAP.md', 'release-notes/vX.Y.Z.md', 'rebaseline', 'AGENT_RULES.md', 'TOOL_API_VERSION', 'validate:zip', 'assertValidZip', 'No ZIP parsing in `src/`']) {
            expect(template).toContain(mention);
        }
    });

    it('mirrors CONTRIBUTING.md §Pull Request Checklist word for word', () => {
        const section = /## Pull Request Checklist\s*\n([\s\S]*?)\n## /.exec(readText('CONTRIBUTING.md'));
        expect(section).not.toBeNull();
        const items = (section?.[1] ?? '').split('\n').filter((l) => l.startsWith('- [ ]'));
        expect(items.length).toBeGreaterThan(5);
        // Links are rewritten to reach CONTRIBUTING.md from .github/; the wording is identical.
        const normalise = (s: string): string => s.replace(/\]\((?:\.\.\/CONTRIBUTING\.md)?#/g, '](#');
        const templateItems = template.split('\n').filter((l) => l.startsWith('- [ ]'));
        expect(templateItems.map(normalise).sort()).toEqual(items.map(normalise).sort());
    });
});
