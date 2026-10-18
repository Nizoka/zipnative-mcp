# Local testing guide (for contributors)

This guide shows how to verify, on your own machine, that zipnative-mcp builds,
passes its quality gate, and — most importantly — that the **archives it produces
are actually correct** (not just bytes that start with `PK`). It complements the
[Contributing guide](../../CONTRIBUTING.md).

## 1. Prerequisites

- **Node.js ≥ 22** (`node -v`). The package sets `"engines": { "node": ">=22" }`.
- A clean install:

  ```bash
  git clone https://github.com/Nizoka/zipnative-mcp.git
  cd zipnative-mcp
  npm install
  ```

There are **no** native build steps and no system archive tools required for the core
suite — `zipnative` is a zero-dependency pure-TypeScript engine, and the conformance
validator is a vendored script. The optional foreign-integrity pass (§5) uses whatever
`unzip` / `7z` / `bsdtar` / `python` / `jar` your machine already has.

## 2. The quality gate

[scripts/gate.ts](../../scripts/gate.ts) is the single definition of "green": CI, the
publish workflow, the contributor docs and the agent instructions all run it instead of
each carrying its own list of commands. It runs every step in order, writes each step's
full output to `test-output/.gate/<id>.log`, prints one line per step, and on the first
failure prints the tail of that step's log and stops. It is hermetic: no step needs the
network, `TZ` is pinned and the operator variables inherited from the shell are
scrubbed, so its verdict is the same on a laptop and on a runner.

```bash
npm run gate                                       # the CI profile: every step
npm run gate:fast                                  # typecheck:all, lint, test, server-json, verify:docs
npx tsx scripts/gate.ts --publish --require-all    # the release profile (publish.yml): a step that would skip fails
npx tsx scripts/gate.ts --only lint                # one step; --from build resumes from a step
```

(PowerShell swallows a bare `--`, so call the script directly when passing flags.)

| Step | What it checks |
| --- | --- |
| `typecheck:all` | Strict TypeScript over `src/`, `tests/` and `scripts/` (`tsconfig.scripts.json`), no `any`, schemas compile. |
| `lint` | ESLint over `src/` with `--max-warnings 0` (`no-console` — stdout is the stdio channel). |
| `build` | Emits `dist/` via `tsc -p tsconfig.build.json`. |
| `dist-check` / `dist-probe` | `dist/` is complete and carries nothing but `src/` (no `console.log`). |
| `smoke` | The **built** server answers over stdio and writes nothing but JSON-RPC frames to stdout. |
| `verify:tool-shape` | The `tools/list` fingerprint and its size budgets (§3.3). |
| `server-json` | `server.json` conforms to the vendored MCP registry schema. |
| `test:generate` / `verify:samples` | Every example through the built server, against the sample baseline (§3.3). |
| `test:coverage` | The vitest suite with v8 coverage; must stay above the thresholds in [vitest.config.ts](../../vitest.config.ts) (statements 94 / branches 90 / functions 95 / lines 94). Runs the catalogue superset gate. |
| `verify:docs` | The 28 offline documentation rules (§3.5). |
| `corpus:zip` / `verazip` | The veraZIP corpus and its ISO/IEC 21320-1 validation (§5). |
| `examples:check` | Examples-as-tests (§3.2). |

The fast profile runs `test` instead of `test:coverage`. Use `npm run test:watch` for a
fast inner loop while developing. Tests are deterministic (vitest runs under `TZ=UTC`,
forks pool, no shuffle), run under 60 s per file, and pass on Windows, macOS and Linux
(paths go through `node:path`; CRLF checkouts are handled). `.githooks/` holds an opt-in
pre-commit / pre-push pair (`npm run hooks:install`).

## 3. Verifying produced archives are correct

An archive that merely starts with `PK` can still be structurally broken, lie about
its sizes, or violate the ISO profile. Tests in this repo assert **real validity**
through three complementary layers.

### 3.1 Structural assertion helper (in tests)

[tests/_zip-assert.ts](../../tests/_zip-assert.ts) exports `assertValidZip()`, which
checks the PK magic, an **eager** `openZip()` by the engine (every local header
cross-checked, overlap table built), a clean `verifyZip()` report (`ok: true`,
`error: null`), **and** ISO/IEC 21320-1 conformance through the vendored validator
core (`assertIsoConformant`, an independent raw parser that never imports the
engine — so the engine is not attesting itself). Use it in any new test that
produces an archive:

```ts
import { callToolDirect } from '../src/server.js';
import { assertValidZip } from './_zip-assert.js';

const result = await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'hi' }] });
const blob = (result.content[1] as { resource: { blob: string } }).resource.blob;   // base64 mode: the embedded resource block
assertValidZip(blob, 'create_zip basic');   // throws with every finding listed
```

`expectCheck(bytes, 'WF/ENTRY-OVERLAP')` asserts a crafted negative fails with a
specific check id; `validateArchive`, `CHECK_IDS` (23) and `REQUIRED_NEGATIVE_CHECKS`
(4) are re-exported for direct use.

**Every archive a test produces through a tool must pass `assertValidZip`** — ISO
conformance included. Benign fixtures come from [tests/_zip-fixtures.ts](../../tests/_zip-fixtures.ts)
(`basicZip`, `richZip`, `highRatioZip`, `streamedZip`, `incrementalZip`,
`zip64ManyEntries`); hostile ones (`ZIP_SLIP`, `DEVICE_NAME`, `DUPLICATE_PATHS`,
`SYMLINK`, `OVERLAP`, `CD_MISMATCH`, `DECLARED_BOMB`, `LFH_NAME_MISMATCH`,
`LFH_METHOD_MISMATCH`, `CRC_OVERRIDE`, `TRAILING_GARBAGE`, `SFX_PREFIXED`,
`ENCRYPTED_FLAG`, `UNKNOWN_METHOD`, `STORE_DESCRIPTOR`, `DEFLATE_DESCRIPTOR`,
`CORRUPT_DEFLATE`, `INVALID_UTF8_NAME`, `CP437_NAME`, `MULTI_DISK`, `ZIP64_FORCED`,
`ZIP64_DROPPED`) are built in-test by the engine-independent raw builder
([tests/_fixtures/raw-zip-builder.ts](../../tests/_fixtures/raw-zip-builder.ts)) and are
**never committed** — the only committed archives are the two foreign-provenance
interop fixtures under `tests/fixtures/interop/` (bsdtar, PowerShell
`Compress-Archive`).

### 3.2 Examples-as-tests

Every file under [examples/](../../examples) is exercised by
[tests/examples.test.ts](../../tests/examples.test.ts):

- the referenced tool name(s) must exist in the live registry and the arguments must
  validate against the tool's `inputSchema`;
- each single-tool example whose placeholders are resolvable (`<zip-base64>`,
  `<rich-zip-base64>`, `<truncated-zip-base64>`, `<hostile-zip-slip-base64>`,
  `<raw-deflate-base64>`) is executed end-to-end and must not return `isError`; if it
  produces an archive, `assertValidZip` validates the bytes;
- multi-step examples are chained in order with `<base64 from step N>` substituted
  from step N's embedded resource;
- file-mode examples (`outputMode: 'file'`, `outputDir`, `zipPath`, `sourcePath`) are
  documentation-only in this suite: it sets no sandbox and skips their execution, but
  still validates the shape. The sample generator (§3.3) runs them for real.

This guarantees the published examples never drift from the real schemas. Run just
this suite with:

```bash
npm run examples:check        # = npx vitest run tests/examples.test.ts
```

### 3.3 Samples and the catalogue gates

**Samples.** `npm run test:generate` ([scripts/generate-samples.ts](../../scripts/generate-samples.ts))
drives every `examples/*.json` through the **built** server under a hermetic
environment — `TZ=UTC`, every operator variable scrubbed, a temporary sandbox holding
the frozen inputs of `tests/fixtures/examples/` (pinned by `tests/fixtures/SHA256SUMS`;
`incoming/report.zip`, `incoming/rich.zip`, `incoming/dump.bin`), so the file-mode
examples run too — and writes what each returns to `test-output/samples/`.
`npm run verify:samples` ([scripts/verify-samples.ts](../../scripts/verify-samples.ts))
fingerprints them against `tests/_fixtures/samples.sha256.json`: archives by their
bytes, results semantically, each sample held to the release that introduced it (a
`since` chain). Of the 54-sample baseline, 39 entries still carry `since: "1.0.0"`
(captured from the 1.0.0 tree before any 1.1.0 change) and 15 are anchored at 1.1.0
(the new examples, plus `describe-engine` and the governance draft, which quote the
version); the `sample-regression` workflow reruns the comparison on every change
that can alter emitted output. A diverging sample is either a regression or a declared
change ([docs/API_STABILITY.md](../API_STABILITY.md) §2).

**Catalogue parity.** The `tools/list` catalogue is fingerprinted structurally — names,
titles, annotations, schema types, enums, defaults, constraints, `required`,
`additionalProperties` and the number of `_meta.examples`, with every `description`
string stripped — by [scripts/tool-shape.ts](../../scripts/tool-shape.ts), and
[tests/catalogue-parity.test.ts](../../tests/catalogue-parity.test.ts) asserts the
live server matches the committed fixture `tests/_fixtures/tool-shape.json`. Wording
(descriptions, examples, server instructions) can change freely; a structural change
fails the suite until you refresh the fixture on purpose:

```bash
npm run build && npx tsx scripts/tool-shape.ts --write
npx tsx scripts/tool-shape.ts --check     # = npm run verify:tool-shape (also checks the size budgets)
npx tsx scripts/tool-shape.ts --stats     # tools/list bytes, SERVER_INSTRUCTIONS bytes, the counts
```

Review that diff under [docs/API_STABILITY.md](../API_STABILITY.md) §5 — it may
require a `TOOL_API_VERSION` bump. Never regenerate
`tests/_fixtures/tool-shape.v1.0.0.json`: it is the frozen published 1.0.0 catalogue,
and [tests/catalogue-superset.test.ts](../../tests/catalogue-superset.test.ts) holds
every later catalogue to it — no tool, property, enum value or default removed, nothing
newly required, no bound tightened, no annotation flipped — except the reviewed
`ACCEPTED_DELTAS` it lists (each declared in `API_STABILITY.md` §2).

### 3.4 Docs consistency

[tests/docs-consistency.test.ts](../../tests/docs-consistency.test.ts) pins the
counts and names quoted in README, AGENTS.md, `llms.txt`, `server.json`,
`CITATION.cff`, `CLAUDE.md` and `docs/data/*.json` to the code — the 15 tools in
registration order, 7 prompts, the 8 environment variables, every wrapper code and every
`ZIP_*` / diagnostic code in AGENTS.md §6, the 106-export ledger with its 88 / 9 / 9
reach counts (every `UNEXPOSED_EXPORTS` entry graded unexposed), the veraZIP corpus
counts quoted in the docs against `docs/data/verazip.json` (pinned by both
`tests/verazip-vendor.test.ts` and docs-consistency), the rule that every mention of an
SFX prefix next to `scan_zip_forward` says the tool refuses it, the cache clause on
every "no I/O outside the sandbox" statement in README / SECURITY.md /
`docs/guides/SECURITY.md`, and the README project-structure block. Update the docs, not
the tests. Its sibling `tests/schema-lockstep.test.ts` compares the Zod input schemas
(`z.toJSONSchema`) with the advertised `inputSchema`s so a `pattern`, enum, default or
bound can never exist on one side only.

### 3.5 The documentation verifier

`npm run verify:docs` ([scripts/verify-docs.ts](../../scripts/verify-docs.ts)) runs 28
offline rules (`--rules` lists them, `--only <rule>` narrows) over
[docs/assets/ecosystem.json](../assets/ecosystem.json), the manifest that holds every
count and canonical sentence: counts and stale tokens, tool / error / environment
parity, agent configuration, rulesets, internal links and heading anchors, "Verified
on" stamps, prose language, secret material, the engine data files and the veraZIP
counts. It prints `file:line [rule] message`; a finding is fixed in the document, or in
the manifest when the source tree moved. The `docs` workflow runs it on every change
and `--online --strict` on a schedule (the manifest against the npm registry).

### 3.6 Preparing a release

`npm run release:prepare -- --version X.Y.Z` (or
`npx tsx scripts/release-prepare.ts --version X.Y.Z`) applies the mechanical part of a
version bump in one pass — `package.json` and the lockfile, `src/version.ts`,
`server.json`, `docs/assets/ecosystem.json` and every "Verified on" stamp,
`CITATION.cff`, the `SECURITY.md` support table, the README engine badge, the
"Current release" prose — and scaffolds `release-notes/vX.Y.Z.md` and the PR draft. It
never bumps `TOOL_API_VERSION`: that is a reviewed decision
([docs/API_STABILITY.md](../API_STABILITY.md)).

### 3.7 Inspecting an archive you produced by hand

The read-only tools double as a verification toolkit. After producing an archive,
feed its bytes back in:

- **`inspect_zip`** — counts, methods, Zip64, the determinism verdict, every diagnostic; `check: [...]` for assertions.
- **`verify_zip`** — every entry's CRC / size / local-header agreement, without ever failing for an archive problem.
- **`list_zip_entries`** — the rows, incl. `sanitizedPath` and decoded flags.
- **`scan_zip_forward`** — what a lenient forward reader would see (dead bytes after an append-mode `modify_zip`, for instance).

A quick Node check against the built server:

```ts
import { callToolDirect } from './dist/server.js';

const made = await callToolDirect('create_zip', { entries: [{ name: 'a.txt', text: 'hello' }], includeSha256: true });
const blob = made.content[1].resource.blob;
console.log(await callToolDirect('inspect_zip', { zipBase64: blob, check: ['deterministic'], verbosity: 'summary' }));
console.log(await callToolDirect('verify_zip', { zipBase64: blob, verbosity: 'summary' }));
```

## 4. Writing archives to disk

To open the output in another tool, write it with the sandboxed file mode:

```bash
# 1. Enable file I/O by pointing the sandbox at a directory you own.
export ZIPNATIVE_MCP_OUTPUT_DIR="$PWD/.out"        # PowerShell: $env:ZIPNATIVE_MCP_OUTPUT_DIR = "$PWD/.out"
mkdir -p .out
```

Then call any archive-producing tool with `outputMode: 'file'` and a relative
`outputPath` ending in a container extension (`.zip` recommended; absolute paths,
`..` traversal and other extensions are rejected by the sandbox; an existing file is
never overwritten). `extract_zip` takes a relative `outputDir` instead. The same
directory serves `zipPath` / `sourcePath` inputs and is listed under
`resources/list`:

```bash
# macOS: open .out/demo.zip   ·   Windows: start .out\demo.zip   ·   Linux: unzip -l .out/demo.zip
```

## 5. External conformance (veraZIP) — level 0 always, level 1 optional

`assertValidZip` already applies the ISO/IEC 21320-1 validator inside the test suite.
The corpus gate runs the same validator over a manifest of 43 archives — the 39
conformant ones (what the built tools write, including `canonicalize_zip`, `merge_zip`,
`modify_zip` with `canonical` and the Zip64 streaming layout, plus the raw-crafted
shapes, four hostile-but-conformant among them) and 4 negative canaries — and adds the
foreign-integrity pass:

```bash
npm run validate:zip
# = npm run build
#   && npm run corpus:zip             # tool handlers + raw builder → test-output/zip/*.zip + manifest.json
#   && node scripts/validate-zip.mjs  # level 0 + level 1; reports under test-output/zip/reports/
```

Level 0 needs nothing and always runs. Level 1 uses the integrity tools present on
the machine — `tar -tf` (bsdtar), `unzip -t`, `7z t`, `python -m zipfile -t`,
`jar tf` — and reports absent ones as `SKIP` (never simulated). Outcomes per file are
`PASS` / `FAIL` / `XFAIL` / `XPASS` / `INFRA` / `SKIP`; exit codes: **0** every
expectation met (or level 1 skipped because no tool is usable and `VERAZIP_REQUIRED`
is unset — a skip, not a pass), **1** a conformance or refusal expectation failed /
`XPASS` / a level-1 tool rejected a conformant archive / the coverage canary
tripped, **2** no corpus, **3** `INFRA`. Set `VERAZIP_REQUIRED=1` to fail closed
(exit 3 when no level-1 tool is usable); CI always does. The full story — clause
table, the manifest shape, the hostile-but-conformant entries, the 7-Zip exclusions —
is in [CONFORMANCE.md](CONFORMANCE.md).

Installing the level-1 tools (Java 8+ for `jar`; **level 0 needs nothing**):

```bash
# macOS (bsdtar, python3 and jar ship with the OS / Xcode / a JDK; unzip is built in)
brew install p7zip

# Debian / Ubuntu
sudo apt-get install unzip p7zip-full python3 default-jdk-headless   # bsdtar: libarchive-tools
```

```powershell
# Windows — tar.exe (bsdtar) is built in since Windows 10; Python from python.org or winget
winget install 7zip.7zip
winget install Python.Python.3.12
# jar comes with any JDK (e.g. winget install Microsoft.OpenJDK.21); Info-ZIP unzip is optional
```

**CI status:** `.github/workflows/verazip.yml` runs the same flow with
`VERAZIP_REQUIRED=1` on **Linux and Windows** on every push and pull request and is
**blocking**; the gate's `ci` and `publish` profiles carry it too, so `publish.yml`
re-runs it before anything is packed. If you change anything the tools **write**
(`create_zip`, `modify_zip`, `canonicalize_zip`, `merge_zip`, `inflate_raw`, entry
naming, the corpus in `scripts/helpers/zip-corpus.mjs`) or the validator itself, run `npm run validate:zip` locally first —
and remember that exit 0 without any level-1 tool is a skip of level 1, not a proof
of it. A new writer path deserves a new corpus entry; a new refusal deserves a new
canary.

## 6. Smoke-testing the MCP server over stdio

The server speaks JSON-RPC over stdio. After `npm run build`:

```bash
node dist/cli.js
```

The cleanest way to drive it interactively is the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

From the Inspector you can list the 15 tools, inspect each schema and the
`_meta.examples`, read the seven prompts, and issue `tools/call` requests — a fast way
to confirm a new or changed tool behaves before writing assertions. Remember the
stdio frame cap (256 MiB) and that a request sent before the opening exchange is
dropped. The stdio smoke test in the suite drives the built CLI the same way (legacy
handshake and the 2026-07-28 `server/discover` probe), so run `npm run build` before
`npm test`. `tests/protocol-revisions.test.ts` opens the built CLI and the HTTP
transport with every legacy revision the SDK negotiates (2024-10-07, 2024-11-05,
2025-03-26, 2025-06-18, 2025-11-25); `tests/stdio-modern.test.ts` drives the
2026-07-28 envelope over stdio; `tests/http-shutdown.test.ts` sends SIGTERM to the HTTP
mode; `tests/autonomy.test.ts` replays the scripted agent scenario below on all four
transport × era combinations.

## 6a. Drive it from Claude Code / Claude Desktop / MCP Inspector

The repository ships a [`.mcp.json`](../../.mcp.json) so the **built** server can be
driven by a real MCP host without any installation step:

```json
{
  "mcpServers": {
    "zipnative": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/dist/cli.js"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "${CLAUDE_PROJECT_DIR}/test-output/mcp-sandbox" }
    }
  }
}
```

**Claude Code.** Run `npm run build` first (the entry is `dist/cli.js`; nothing is
published from `src/`). Open the repository in Claude Code: the project-scoped
`.mcp.json` is discovered automatically, `${CLAUDE_PROJECT_DIR}` is injected by Claude
Code (it is not a shell variable), and the first use asks you to approve the server
for this project — approve it once. The sandbox lands under
`test-output/mcp-sandbox/` (git-ignored); create the directory if your host does not.
`/mcp` in Claude Code lists the server, its 15 tools, the seven prompts and the
`zipnative://output/{+path}` resource template.

**Claude Desktop.** Same shape without `${CLAUDE_PROJECT_DIR}` — absolute paths only
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "zipnative-dev": {
      "command": "node",
      "args": ["/abs/path/to/zipnative-mcp/dist/cli.js"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "/abs/path/to/zipnative-mcp/test-output/mcp-sandbox" }
    }
  }
}
```

Restart Claude Desktop after editing the file; the tools appear under the server name.

**MCP Inspector.** No configuration at all — one command lists the catalogue, another
calls a tool:

```bash
npx @modelcontextprotocol/inspector --cli node dist/cli.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/cli.js --method tools/call --tool-name describe_engine --tool-arg 'fields=["ceilings","sandbox"]'
npx @modelcontextprotocol/inspector node dist/cli.js      # the interactive UI (set ZIPNATIVE_MCP_OUTPUT_DIR in the environment for file mode)
```

**The scenario to replay** — the same chain `tests/autonomy.test.ts` runs unattended;
ask the host to perform it step by step and compare with the expected results:

| Step | Ask for | Expected |
| --- | --- | --- |
| 1 | `describe_engine` | `server.name: zipnative-mcp`, `network: 'none'`, `sandbox.enabled: true`, the four `ceilings`, every cap under `caps`. |
| 2 | `create_zip` with two text entries, `compression: { deterministic: true }`, `includeSha256: true`, `outputMode: 'file'`, `outputPath: 'demo/build.zip'` | a `resource_link` `zipnative://output/demo/build.zip`; `summary.deterministic: true`, `deflateTier: 'pure-pinned'`, a `sha256`. |
| 3 | `verify_zip` with `zipPath: 'demo/build.zip'`, `verbosity: 'summary'` | `ok: true`, `error: null`, `failedCount: 0`, `skippedCount: 0`. |
| 4 | `inspect_zip` with the same `zipPath` and `check: ['deterministic', 'canonical-layout', 'safe-names', 'no-encryption']` | `checksPassed: true`, four `checks[]` rows with `ok: true`. |
| 5 | `list_zip_entries` with `fields: ['entries.name', 'entries.methodName', 'hasMore']` | the two names in canonical order, `hasMore: false`. |
| 6 | `read_zip_entry` with `name` of the first entry and `encoding: 'utf8'` | the `text` you wrote in step 2, `crcVerified: true`. |
| 7 | `modify_zip` with `zipPath`, `operations: [{ op: 'remove', name: <second entry> }]`, `mode: 'compact'`, `outputMode: 'file'`, `outputPath: 'demo/build-v2.zip'` | `summary.saveMode: 'compact'`, `entryCountAfter: 1`; `inspect_zip` on it reports `multipleEocd: false`, `canonicalLayout: true`. |
| 8 | `extract_zip` with `zipPath: 'demo/build-v2.zip'`, `outputMode: 'file'`, `outputDir: 'demo/unpacked'` | one `resource_link` per file, `fileCount: 1`, nothing overwritten (a second run is `OUTPUT_EXISTS`). |
| 9 | `resources/list` (the host's resource browser) | `zipnative://output/demo/build.zip`, `demo/build-v2.zip` and the extracted file, readable through `resources/read`. |

Every step is a single tool call with no human input other than the approval in step
0; every refusal you can provoke on the way (an absolute `outputPath`, a `zipPath`
outside the sandbox, `maxEntries` above the ceiling) carries a code in
`_meta.error.code` and, where one applies, a `data.remedy`.

To exercise the Streamable HTTP transport instead, set `ZIPNATIVE_MCP_PORT` (the
server binds loopback only and checks `Host` / `Origin`, with the Origin port pinned).
Without a token the endpoint has **no authentication** — any local process can reach
it — so also set `ZIPNATIVE_MCP_HTTP_TOKEN` (≥ 16 characters, no whitespace; a weaker
value aborts startup) and send `Authorization: Bearer <token>` on every request to
`/mcp`; a missing or wrong token gets `401` with `WWW-Authenticate: Bearer`. The
startup log tells you which mode you are in ("bearer token required" vs. "no
authentication (loopback only)"). `tests/_http-fixture.ts` shows the request shapes
for both protocol eras.

## 7. Interpreting coverage

`npm run test:coverage` prints a per-file table and fails if any metric drops below
the thresholds in [vitest.config.ts](../../vitest.config.ts) (`src/cli.ts` and
`src/index.ts` are excluded — they are exercised by the stdio smoke test, not by
in-process coverage). The thresholds sit a few points below the measured values on
the release branch so ordinary churn does not flap the gate; never lower them to make
a change pass — add tests. When you add code, add tests in the same PR so coverage
does not regress on the modules you touched; the uncovered lines the report names
are usually an error path (`IO_ERROR`, a `ZIP_*` code) that deserves a hostile
fixture.
