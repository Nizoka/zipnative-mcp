---
name: release-audit
description: Pre-release audit of zipnative-mcp — two parallel auditors (security, hardening and protocol conformance; API coverage, doctrine and docs parity), an adversarial verifier, an agent-autonomy pass and a GO/NO-GO ledger under .audit/<version>/. Run by the maintainer before every release; never invoked by the model on its own.
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(npm run *), Bash(npx tsx scripts/*), Bash(npx vitest *), Bash(node dist/cli.js*), Bash(git diff*), Bash(git log*), Bash(git show*), Agent
argument-hint: [release-notes/vX.Y.Z.md] [previous-tag]
---

# Release audit

Audit the release described by `$0` (default: the newest `release-notes/v*.md`) against everything that changed since `$1` (default: the previous `v*` tag from `git tag -l`). The audit produces findings, never fixes: every fix goes through the normal edit → gate loop afterwards, and the ledger records what was fixed.

Read `ledger.md` first for the ledger and verdict formats. Each phase below hands a template to the agents it spawns; the agents return findings, you file them.

## Ledger location

`.audit/<version>/` — git-ignored (check `.gitignore` covers it before writing; it is NOT under `test-output/`, which Claude Code is denied to Read), so nothing here is ever committed. One Markdown file per report: auditor-a, auditor-b, verifier-1, auditor-d, verifier-2, then the ledger and the verdict (formats in `ledger.md`). A report never quotes `ZIPNATIVE_MCP_HTTP_TOKEN` or any operator secret.

## Phase A and B — two auditors, in parallel

Spawn both with the Agent tool in the same message (distinct angles; neither sees the other's report):

- **Auditor A — security, hardening and protocol conformance.** Template: `auditor-a.md`. The sandbox (one handle per read, `wx` writes, realpath on both sides), the extraction guards, the limits and the operator ceilings, the cache gate, the refusal paths, cancellation, both protocol eras on both transports, the supply chain of the workflows; at least one assertion per claim is *reproduced with a command* (a test, a script, a `tools/call` against the BUILT server), not inferred from reading.
- **Auditor B — API coverage, doctrine and docs parity.** Template: `auditor-b.md`. Every engine export reached by a tool or honestly listed in `UNEXPOSED_EXPORTS` (`docs/data/core-exports.json`), the doctrine (no network, no decryption, no ZIP parsing of our own, relaxations as named inputs), the README tool matrix, `docs/AGENT_CONTRACT.md`, `llms.txt`, `docs/API_STABILITY.md`, the live `tools/list` descriptions, `SERVER_INSTRUCTIONS`, `server.json`, the sample baseline, the veraZIP corpus — every surface an agent or a human reads — compared with the behaviour that actually shipped.

Both write their report in the finding format of `ledger.md` (id, severity, claim, evidence command, observed, expected).

## Phase C — adversarial verifier

Spawn one verifier (template: `verifier.md`) with both reports. It re-derives every finding from scratch — re-runs the evidence command, reads the cited lines — and stamps each one `CONFIRMED | DOWNGRADED | REJECTED | DUPLICATE` with a one-line justification. Auditors have about 10 % false findings; the verifier exists to keep them out of the ledger. A finding the verifier cannot reproduce is `REJECTED`, not "probably fine".

## Phase D — agent-autonomy pass, then verify

Spawn Auditor D (template: `auditor-b.md`, section "Autonomy pass") with one question: *can an agent that has only what an MCP host shows it — `tools/list` (names, descriptions, input schemas, `_meta.examples`), `serverInfo.instructions`, `resources/list`, plus `llms.txt` and `docs/AGENT_CONTRACT.md` — drive every 1.x feature without reading `src/`?* It picks every feature the release note names plus a sample of older ones, writes the `tools/call` it would send from those surfaces alone, and sends it to the built server. Then a second verifier pass (template: `verifier.md`) over its findings.

## Phase E — GO / NO-GO

Merge the confirmed findings into the ledger, then write the verdict file (both formats are in `ledger.md`):

- **GO** — no CONFIRMED finding of severity `blocker`; every `major` has a fix commit or an explicit maintainer waiver in the ledger.
- **NO-GO** — otherwise. List the blockers first, each with its evidence command, so the fix loop starts from the ledger, not from memory.

Report the verdict, the counts per severity and per stamp, and the ledger path. Do not push, tag, open a PR or publish: `scripts/release-prepare.ts` and the maintainer take over from `GO`.

## Driving the built server

The server speaks newline-delimited JSON-RPC on stdio and exits when stdin closes, so one call is one shell command — write the request lines to a file with Write, then `node dist/cli.js < request.jsonl`. Read the frames on stdout; the boot log is on stderr. `tests/_mcp-harness.ts` is the same harness in test form (it also captures notifications and sends `notifications/cancelled`), and `scripts/helpers/server.ts` calls the built `dist/server.js` without a transport. Set `ZIPNATIVE_MCP_OUTPUT_DIR` to a temporary directory for the file-mode and `zipPath` paths, never to a directory that holds real data.

## Known blind spots

Add a check for each of these to the auditor briefs; they are where an audit of this server misses something.

- **The host time zone.** A ZIP timestamp is MS-DOS fields with no zone. Every engine call must carry `dosTimeMode: 'utc'` (the diagnostic sink sets it); a new engine call that bypasses the sink writes local time and makes a pinned `create_zip` / `modify_zip` / `canonicalize_zip` call host-dependent — and the response cache treats it as one. Run `tests/reproducible-build.test.ts` (it spawns `dist/cli.js` under two zones) after every change to a writer path.
- **Check-then-use on a sandbox path.** Every read must go through `openSandboxFile` / `openInputFile` (one handle from the open to the last byte, bound by device and inode); a `fs.readFile(path)` or `createReadStream(path)` added anywhere under `src/` reopens the path after the check. Grep for both.
- **`ok: false` versus `isError` versus thrown.** `verify_zip` reports archive problems in `ok` / `error` / `skipped`, never `isError`; a refusal reported as a verdict hides a bug, a verdict reported as an error breaks the agent's decision tree, an uncoded throw is `ENGINE_ERROR`. Send a malformed, a truncated and a hostile archive to each read tool and check the shapes.
- **Skipped versus failed.** zipnative's archive rule: a design-time skip (encrypted, stream-only codec) passes only when its local header agrees; an unknown method (`skipped: 'unsupported-method'`) fails. A count that moves an entry between `failedCount` and `skippedCount` changes a CI verdict.
- **The guards are relaxations, never defaults.** `rejectTraversal`, `rejectSymlinks`, `onDuplicate`, the `limits` bounds, overlap / CD-LFH / Zip64 checks: each stays on unless the caller names it. A new tool that opens an archive must get the same defaults (`merge_zip` verifies CRCs before copying; `canonicalize_zip` refuses duplicate names).
- **The limits bounded by the ceilings.** Every `limits.*` key must be clamped by its operator ceiling with `LIMIT_CEILING_EXCEEDED`; a new limit the engine adds is a new row in `src/limits.ts` and a ceiling mapping, or it is unbounded (`tests/limits.test.ts` checks `DEFAULT_ZIP_LIMITS` against `LIMIT_KEYS`).
- **Byte-range reads.** `access: 'range'` feeds the sandbox file's handle to `openZipRange`; there must never be a URL form, and `inspect_zip` over ranges has no determinism verdict — its determinism checks must fail closed, never pass.
- **Cancellation.** A cancelled call is `CANCELLED`, never cached, and a partial output file is removed — on Windows the descriptor must be closed before the unlink. `tests/cancellation.test.ts` drives it in-process and over MCP.
- **`UNEXPOSED_EXPORTS` honesty.** An export that is neither reached by a tool nor listed is a coverage gap; a listed rationale that is no longer true is a documentation lie. Reconcile against `docs/data/core-exports.json` and the engine's `docs/assets/api.json`.
- **Cache poisoning through an unkeyed input.** `ZIPNATIVE_MCP_CACHE_DIR` serves earlier bytes for equal arguments; anything that changes a result without appearing in the arguments must gate or namespace the entry — a path input, `defaultDate: 'now'`, the worker pool, an operator ceiling, the engine version. Check `isCacheable` and `CACHE_API_VERSION` (`src/server.ts`) for every new input and knob.
- **`structuredContent` versus `outputSchema` under projection.** The read tools' output schemas are projectable, so a projected result always validates — which also means a field that drifted never fails validation. Check every new output member on the default, the `summary` and a projected path.
- **Two schemas per tool, kept in step by hand.** `tests/schema-lockstep.test.ts` compares them; for each new input, send one value the JSON Schema accepts and check the handler accepts it, and one it rejects.
- **Capability negotiation and the legacy fallback.** The same binary serves MCP 2026-07-28 and the 2025-era handshake, on stdio and HTTP. `tests/stdio-modern.test.ts`, `tests/protocol-revisions.test.ts`, `tests/http-modern.test.ts` and `tests/autonomy.test.ts` are the only places the eras are exercised.
- **stdout purity.** One `console.log` under `src/` corrupts the stdio framing for every host; the gate's `smoke` and `dist-probe` steps catch the built tree, ESLint `no-console` the source.
- **What the tools write stays ISO/IEC 21320-1 conformant.** A new writer path needs a corpus entry in `scripts/helpers/zip-corpus.mjs`; `npm run validate:zip` (or the gate's `corpus:zip` + `verazip`) is the judge, not the engine.
- **`TOOL_API_VERSION`.** A schema or code change that ships without the bump leaves hosts and the response cache on a stale contract. Diff `tests/_fixtures/tool-shape.json` against the previous tag; `tests/catalogue-superset.test.ts` holds the 1.0.0 catalogue.
- Regex-driven `verify:docs` rules are blind to wording: they prove counts, versions, links and presence, never that a sentence is true.
- CI assumptions live outside the repo: Trusted Publishing needs npm ≥ 11.5.1 on the runner (publish.yml installs it), the `npm-publish` environment must exist and be bound on npmjs.com, the rulesets must be applied (`gh api`), and the level-1 extractors of the veraZIP gate are whatever the runner image carries; a green local gate proves nothing about the publish job.
- Auditors have ~10 % false findings — never file an unverified finding, and never let a `REJECTED` one reach the verdict.
- Publish-related strings in a shell command trip the guard hook (`.claude/hooks/guard.mjs`, wired to Bash and PowerShell): anything containing `npm publish`, `gh release`, `git push` or `git tag <name>` inside a segment, a `$( )`, or an interpreter payload is refused. Write such strings into files with Edit or Write, never through `echo` or a heredoc.
