# Conformance and validation — the veraZIP gate

> ZIP has no veraPDF — so this server ships the closest thing, inherited from the
> engine: an independent clause-by-clause ISO/IEC 21320-1:2015 validator that runs over
> every kind of archive the tools write, plus a foreign-integrity pass with the mainstream
> extractors present on the machine. This page is the authority story: what "valid"
> means for a ZIP archive, who checks it, what a pass proves — and what it does not.

The engine's original guide is
[zipnative `docs/guides/conformance.md`](https://github.com/Nizoka/zipnative/blob/main/docs/guides/conformance.md);
the CLI's adaptation is in [zipnative-cli `CONTRIBUTING.md`](https://github.com/Nizoka/zipnative-cli/blob/main/CONTRIBUTING.md).
This document describes the gate as it runs in **this** repository.

---

## 1. Why there was no veraPDF for ZIP

PDF/A has veraPDF: an authoritative validator that checks a closed ISO constraint
list. ZIP has nothing comparable, for two verifiable reasons:

- **JHOVE has no ZIP module.** The digital-preservation validator's module list
  covers AIFF, GIF, HTML, JPEG, PDF, TIFF, WAVE, XML and friends — not ZIP. A ZIP fed
  to JHOVE falls through to BYTESTREAM, which reports *every* byte sequence as
  well-formed: a gate that cannot fail.
- **`zip -T` is an alias.** Info-ZIP's own manual documents `-T` as running
  `unzip -tqq` on the archive — no validation power over `unzip -t`, which itself
  only re-reads entries and checks CRCs.

What the archival community actually does is independent extraction plus fixity
(Archivematica's posture). And the ISO-standardised ZIP profile — **ISO/IEC
21320-1:2015 (Document Container File)**, recognised by the Library of Congress
(fdd000361) and the basis of what OOXML and EPUB constrain — had no open-source
validator at all. zipnative built one; this repository vendors its core.

## 2. Level 0 — the ISO/IEC 21320-1:2015 validator

`scripts/verazip-core.mjs` (`validateArchive(bytes, file)`) checks one archive clause
by clause against the standard's closed constraint list, veraPDF-style: each failure
is tagged with the check id that rejects it.

**Independent by construction.** The core is **vendored** from the engine
(`zipnative/scripts/validate-zip.ts`, commit `4f1bc36`, via the 1:1 `.mjs` port in
zipnative-cli; both upstream hashes are recorded in the file header and pinned by
`tests/verazip-vendor.test.ts`). It raw-parses the bytes with its own EOCD /
central-directory / local-header reader and never imports `zipnative`, `src/` or
`dist/` — a validator that shared the engine's parser would attest the engine with
the engine. When upstream's `validate-zip.ts` changes, re-port the parser body 1:1
(types erased) and bump both hashes in the same PR.

Two families of checks (22 ids, `CHECK_IDS`):

1. **APPNOTE well-formedness** — the cross-checks lenient extractors skip:
   `WF/EOCD-NOT-FOUND`, `WF/ZIP64-LOCATOR`, `WF/ZIP64-EOCD`, `WF/CD-OFFSET`,
   `WF/CD-COUNT`, `WF/CD-SIZE`, `WF/LFH-SIGNATURE`, `WF/LFH-METHOD-MISMATCH`,
   `WF/LFH-NAME-MISMATCH`, `WF/LFH-SIZE-MISMATCH`, `WF/LFH-CRC-MISMATCH`,
   `WF/DESCRIPTOR-MISMATCH`, `WF/ENTRY-OVERLAP` — central directory ↔ local header
   agreement (method, name, sizes, CRC), exact offsets, entry counts, overlapping
   entries, data-descriptor validation against the authoritative central-directory
   values.
2. **The ISO profile** — the normative annotations ISO/IEC 21320-1 applies to
   PKWARE APPNOTE 6.3.3:

| Clause (check id) | Constraint |
|---|---|
| 4.3.3 / 4.4.1.5 (`ISO21320-1/APPNOTE-4.3.3`, `…-4.4.1.5`) | No multi-volume, split or spanned archives |
| 4.3.6 / 4.3.8 (`…-4.3.8`) | No encryption of file data |
| 4.3.9.6 / 4.3.10 (`…-4.3.10`) | No central-directory encryption, no archive decryption header |
| 4.3.13 (`…-4.3.13`) | No digital-signature record |
| 4.4.3 (`…-4.4.3`) | Version needed to extract ≤ 45; ZIP64 version 1 may be used, version 2 shall not |
| 4.4.4 (`…-4.4.4`) | General-purpose bits 0, 4–10 and 12–15 shall not be set (bit 3, data descriptors, **is** permitted); non-ASCII names / comments require bit 11, and bit 11 requires valid UTF-8 |
| 4.4.5 (`…-4.4.5`) | Compression method 0 (stored) or 8 (deflated) only |
| Note 1 (`…-NOTE-1`) | Volume labels, Deflate64, DCL Implode and patched data are excluded |

The rows group the standard's clauses; the emitted tags name the closest structural
clause. The standard's remaining Table-1 rows disregard whole APPNOTE sections
(manifest files, the encryption chapters) and need no byte-level check.

**Every archive the tools write conforms to this profile.** Two places enforce it:

- **In the test suite**, `assertValidZip` (`tests/_zip-assert.ts`) is applied to
  every archive a test produces through a tool: PK magic, an eager engine open, a
  clean `verifyZip` report, **and** `assertIsoConformant` through the vendored core.
  A test that produces an archive and does not assert it is a review finding.
- **In the corpus gate** (`npm run validate:zip`), described next.

### Conformant does not mean safe

Four of the hostile fixtures — zip-slip, a Windows device name, duplicate paths, a
symlink entry — are **perfectly ISO-conformant**: the standard constrains the container's structure,
not the meaning of entry names. That is precisely why the engine's secure-by-default
extraction guards ([`SECURITY.md`](SECURITY.md)) exist on top of conformance. The
corpus manifest records for those entries which tool **must refuse** them and with
which code (`refusedBy: { tool: 'extract_zip', code: 'ZIP_PATH_TRAVERSAL' }`, …), the
gate checks that refusal too, and prints `conformant but refused by zipnative-mcp`
instead of pretending the profile catches what it does not.

## 3. The corpus

`npm run corpus:zip` (`scripts/generate-zip-corpus.mjs`, the corpus itself defined in
`scripts/helpers/zip-corpus.mjs`) drives the **built** tool handlers (`dist/`, through
`callToolDirect`) plus the engine-independent raw builder
(`scripts/helpers/raw-zip-builder.mjs`, vendored from zipnative — the test suite uses
its TypeScript twin `tests/_fixtures/raw-zip-builder.ts`) to write
38 archives to `test-output/zip/` with a `manifest.json`:

```jsonc
{
  "generatedBy": "scripts/generate-zip-corpus.mjs",
  "server": { "name": "zipnative-mcp", "version": "1.0.0", "toolApiVersion": "1.0.0", "zipnative": "1.0.0" },
  "node": "v22.x", "platform": "linux",
  "files": [{
    "file": "create-deterministic.zip", "bytes": 1234,
    "producedBy": "tool" | "crafted" | "tool+crafted",
    "tool": "create_zip", "arguments": { … },          // when producedBy includes "tool"
    "expectConformant": true, "expectedCheck": null,     // or false + the check id a canary must fail
    "refusedBy": null | { "tool": "extract_zip", "code": "ZIP_PATH_TRAVERSAL" },
    "integrityExclude": [],                              // documented level-1 tool limitations, per file
    "prefixed": false                                    // true for an SFX-style prefixed entry
  }]
}
```

The conformant entries cover every writer path the tools expose — `create_zip`
buffered, streamed (`stream: true`), `parallel`, `compression.deterministic`, store
and deflate, comments, `order: 'insertion'` (an EPUB-style `mimetype`-first layout),
`extraFields`, `unixMode`, directory entries; `modify_zip` in `append` and
`compact` mode — plus the raw-crafted files: a forced-Zip64 layout crafted by the
raw builder (`create_zip` Zip64 auto-promotion is covered by `tests/zip64.test.ts`)
and the hostile-but-conformant quartet.
**Four raw-crafted negative canaries** (`expectConformant: false`) must be rejected
with their declared check id — `WF/ENTRY-OVERLAP`, `WF/CD-COUNT`,
`WF/LFH-SIZE-MISMATCH`, `WF/LFH-NAME-MISMATCH` (`REQUIRED_NEGATIVE_CHECKS`), the
well-formedness cross-checks lenient extractors forgive. A coverage canary fails the
run if a manifest file is missing, is not a ZIP, or a required check id has no
canary — a corpus generator that silently dropped a canary would otherwise shrink the
gate without anyone noticing. `docs/data/verazip.json` pins the declared counts so
the documentation and the manifest cannot drift apart.

## 4. Level 1 — foreign integrity pass

The same run re-tests every conformant archive with the independent integrity
checkers present on the machine (`scripts/helpers/interop-tools.mjs`, vendored from
the engine): `tar -tf` (bsdtar), `unzip -t`, `7z t`, `python -m zipfile -t`, `jar tf`.
Absent tools are reported as `SKIP integrity <tool>` — never simulated. Exit codes
are read per each tool's own contract (Info-ZIP unzip's documented exit 1 "warning
errors … but processing completed successfully anyway" — fires on an empty archive
and on SFX prefixes — and 7-Zip's exit 1 warnings count as a pass). Tool limitations
are carried as documented per-file exclusions (`integrityExclude`) rather than
loosened exit codes: bsdtar on Windows mangles non-ASCII names; 7-Zip's CLI refuses
archives it must open with an offset (SFX prefixes) in `t` and `x` both; and on the
**append-mode `modify_zip` output** 7-Zip extracts the stale replaced payload and
misses the appended entry — the parser differential recorded in
[`INCREMENTAL.md`](INCREMENTAL.md), observed on a mainstream tool. Level 2 (the
differential-extraction matrix) stays in the engine's own interop suite.

## 5. Outcomes and exit codes

Per manifest file the validator reports:

| Outcome | Meaning |
|---|---|
| `PASS` | conformant, as expected (and refused by the named tool when `refusedBy` is set) |
| `FAIL` | non-conformant although expected conformant; or a negative canary that failed with the *wrong* check id; or a `refusedBy` tool that did not refuse |
| `XFAIL` | a negative canary rejected with its declared check id |
| `XPASS` | a negative canary accepted — the validator is not validating; always fatal |
| `INFRA` | parser exception / unreadable file — not a verdict |
| `SKIP` | a level-1 tool absent on this machine |

Per-file JSON reports and a `summary.json` land in `test-output/zip/reports/`.

| Exit | Meaning |
|------|---------|
| 0 | Every expectation met — **or** no level-1 tool is usable and `VERAZIP_REQUIRED` is unset: level 1 is **skipped** (exit 0 is a skip of level 1, not a pass of it; level 0 verdicts still hold) |
| 1 | A conformance expectation was not met (`FAIL` / `XPASS`), a level-1 tool rejected a conformant archive, the coverage canary tripped, the corpus has no negative canary, or a required check id has no canary |
| 2 | Corpus directory / manifest absent — run `npm run corpus:zip` first |
| 3 | `INFRA`: a file produced an INFRA outcome, or (`VERAZIP_REQUIRED=1` only) zero level-1 tools are usable |

Environment: `VERAZIP_REQUIRED=1` fails closed (no usable level-1 tool → exit 3
instead of a skip; set in CI, unset locally so a bare machine never blocks).

## 6. Running it locally

```bash
npm run validate:zip
# = npm run build
#   && npm run corpus:zip             # tool handlers + raw builder → test-output/zip/*.zip + manifest.json
#   && node scripts/validate-zip.mjs  # level 0 (ISO profile) + level 1 (foreign integrity), reports under test-output/zip/reports/
```

Level 0 needs nothing — pure byte parsing — and always runs. Level 1 uses whatever
integrity tools your machine has and skips the rest visibly; which tools to install
per OS is in [`LOCAL_TESTING.md`](LOCAL_TESTING.md) §5. Only `test-output/zip/` is
scanned. To check a single archive you produced by hand, feed its bytes to the core
from a Node one-liner:

```bash
node -e "import('./scripts/verazip-core.mjs').then(m => console.log(m.validateArchive(require('fs').readFileSync(process.argv[1]), process.argv[1])))" .out/demo.zip
```

## 7. Where it blocks

- `.github/workflows/verazip.yml` — the same scripts with `VERAZIP_REQUIRED=1` on
  **Linux and Windows**, on every push and pull request. The workflow carries no
  `paths:` filter, so it can be a required check without the "Expected — Waiting for
  status" trap; tool versions land in the job summary and the reports are uploaded
  as artifacts.
- `.github/workflows/publish.yml` — the gate re-runs between the GitHub Release and
  `npm publish`: a release can never publish a server whose archives the reference
  validator rejects.

No dependency is added — the validator is a script and the foreign tools are
external.
