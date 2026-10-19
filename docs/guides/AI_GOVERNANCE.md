# AI Governance & Human-In-The-Loop (HITL)

> How an AI agent may propose bugs and improvements for the zipnative project
> **without ever writing to GitHub**. The agent is a **draftsman**; a human is the
> only gate that submits.

This guide is the narrative companion to the machine-readable contract in
[`.github/ai-governance.json`](../../.github/ai-governance.json) and the
agent-and-human protocol in [`.github/AGENT_RULES.md`](../../.github/AGENT_RULES.md).
It is surfaced to agents through the `draft_governance_issue` tool and the
`governance_contract` / `draft_issue_workflow` MCP prompts.

---

## 1. The one rule

**The zipnative-mcp server contains no code path that can write to GitHub, and no
network code path at all.** It cannot open an issue, comment, PR, or release, and it
cannot send a byte to any host. It produces a **local draft** plus a **compliance
report** and stops. A human must review the draft and submit it themselves, under
their own GitHub identity.

This is a guarantee **by construction**, not merely by policy: there is no GitHub SDK
and no `fetch` / socket call anywhere in the server; the only listener it can open is
the opt-in loopback HTTP transport that *receives* MCP requests. No tool argument, no
environment variable and no archive content can ever name a URL. `describe_engine`
reports `network: 'none'` and every tool advertises `openWorldHint: false`.

---

## 2. Why this exists

The zipnative project has two hard, non-negotiable properties that an
autonomously-filing agent would routinely break:

- **No new runtime dependencies.** The zipnative engine has zero; zipnative-mcp
  carries exactly three (zipnative, the MCP SDK, zod) and adds none. A well-meaning
  agent that "fixes" a bug by proposing `npm install some-lib` violates the core
  philosophy.
- **Signal over noise.** Auto-filed, unreproduced, or duplicate issues erode the
  tracker for human maintainers — and a ZIP bug report without the archive (or the
  `create_zip` arguments that produce it) cannot be acted on at all.

Keeping a human in the loop preserves both, while still letting agents do the
valuable up-front work: reproduce, categorise, decide which repository is at fault,
and draft a high-quality issue.

---

## 3. The contract (seven non-negotiable rules)

The same policy is written at three levels of detail: the seven rules below, which the
`governance_contract` prompt returns; the nine numbered rules of
[`.github/AGENT_RULES.md`](../../.github/AGENT_RULES.md), which add *right repository*
and *anti-goals stay out*; and the eight-item `pre_issue_checklist` of
`.github/ai-governance.json`, the machine-readable form.

1. **No new runtime dependencies** — never propose adding an external runtime npm
   package beyond the three the server already has. (Enforced: a draft that suggests
   `npm install <pkg>`, a `yarn/pnpm/bun add`, or edits `"dependencies"` is rejected
   with `GOVERNANCE_VIOLATION`.)
2. **No duplicates** — search **open AND closed** issues/PRs before drafting.
   (`duplicateSearchPerformed` must be `true`.)
3. **Local reproduction** — run a minimal repro (an MCP tool call or a Node/TS
   snippet) first and capture the exact command + result. (Enforced: `reproduction` is a
   required input of the tool, and `npm run verify:issue` requires a fenced
   ```` ``` ```` reproduction block in a hand-written draft.)
4. **Byte-identity / schema awareness** — keep default output byte-identical
   (`compression.deterministic: true` bytes are semver-major, see
   [`API_STABILITY.md`](../API_STABILITY.md) §3) and keep every JSON Schema aligned
   with its Zod twin.
5. **Security defaults are never weakened without a human** — `rejectTraversal`,
   `rejectSymlinks`, `onDuplicate`, the `ZipLimits` bounds, the operator ceilings and
   the sandbox rules are not knobs an agent may propose to loosen by default.
6. **Human-in-the-loop gate** — produce a **local** draft only; a human reviews and
   submits.
7. **Identity integrity** — remind the user that the issue publishes under **their**
   GitHub identity and that they share responsibility for its content.

---

## 4. The workflow

```
1. Detect a bug or improvement while working locally.
2. Reproduce it — run a minimal MCP tool call or Node/TS snippet; capture the exact command + result.
3. Confirm zero new runtime dependency is required (a hard blocker otherwise).
4. Search existing open AND closed issues/PRs for duplicates.
5. Decide the target: engine behaviour (parsing, writing, limits, codecs) → 'zipnative';
   wrapper behaviour (schemas, sandbox, transport) → 'zipnative-mcp'.
6. Call draft_governance_issue with the title, summary, issueType, targetRepo, reproduction,
   expected vs actual, and affected packages.
7. Present the returned draft markdown AND the compliance report to the user.
8. STOP. The user reviews, then manually opens the issue on GitHub under their own identity.
```

The `draft_issue_workflow` MCP prompt returns exactly these steps.

### Engine or wrapper?

| Symptom | Target |
|---|---|
| `_meta.error.code` is `ZIP_INTERNAL` or `ZIP_API_MISUSE` | `zipnative` |
| `ENGINE_ERROR` (a non-`ZipError` throw, `data.errorClass: 'internal'`) | `zipnative` when the reproduction is a bare engine call, `zipnative-mcp` otherwise |
| A parse refusal on an archive every foreign tool opens, a wrong `verify_zip` verdict, a non-conformant archive from `create_zip` / `canonicalize_zip` / `merge_zip` (the veraZIP gate fails), a `deterministic: true` byte change, a `canonicalize_zip` output that `analyzeDeterminism()` rejects | `zipnative` |
| A refusal whose message names a relaxation or a limit (`ZIP_PATH_TRAVERSAL`, `ZIP_LIMIT_EXCEEDED`, …) | not a bug — the security posture working |
| A schema / Zod mismatch, a sandbox refusal on a legitimate relative path, a projection that drops a field, a wrong `_meta.error.data` shape, a wrong `summary`, a transport problem | `zipnative-mcp` |

---

## 5. Using the `draft_governance_issue` tool

Minimal call — drafting a wrapper feature request from a `list_zip_entries` observation
(the same request `examples/draft-governance-issue.json` carries):

```jsonc
{
  "title": "Expose a label-based nameEncoding input for legacy archive names",
  "issueType": "feature",
  "targetRepo": "zipnative-mcp",
  "summary": "Archives written by older Japanese and Russian tools store Shift-JIS or CP866 names without the UTF-8 flag; list_zip_entries shows them as CP437 mojibake. zipnative 1.1.0 can decode them (nameDecoder), but zipnative-mcp deliberately exposes no decoder. A closed enum of TextDecoder labels would reach the feature without accepting code from the caller.",
  "reproduction": {
    "command": "list_zip_entries on an archive whose names are Shift-JIS bytes without flag bit 11",
    "result": "every name is decoded as CP437 (nameEncoding: 'cp437'); rawNameHex shows the original Shift-JIS bytes"
  },
  "expectedBehavior": "An optional nameEncoding input (a closed enum such as 'shift_jis' | 'cp866' | 'windows-1251') decodes the names before path sanitisation; the default stays CP437.",
  "actualBehavior": "The names cannot be decoded by any tool input.",
  "affectedPackages": ["zipnative-mcp"],
  "duplicateSearchPerformed": true
}
```

Optional inputs:

| Field | Default | Notes |
|-------|---------|-------|
| `targetRepo` | `zipnative-mcp` | Documentation label only — the server never contacts it. `zipnative` for the engine, `zipnative-mcp` for the wrapper. |
| `actualBehavior` | reproduction result | What actually happened. |
| `affectedPackages` | `['zipnative-mcp']` | Impacted packages. |
| `outputMode` | `inline` | `file` also writes the draft `.md` into `ZIPNATIVE_MCP_OUTPUT_DIR`. |
| `outputPath` | — | Relative `.md` path inside the sandbox (only when `outputMode: 'file'`). |

Bounds: `title` 8–160 characters; `summary`, `expectedBehavior`, `actualBehavior` and
the two `reproduction` fields at most 16 384 characters each (since 1.1.0 —
`VALIDATION_ERROR` above; the policy scan is linear and the bound keeps a draft
reviewable).

### What you get back

- `draftMarkdown` — the full issue (summary, fenced reproduction, expected / actual,
  environment, compliance checklist, the identity reminder and the human-gate
  statement), ready for a human to review and paste into GitHub.
- `compliance` — a structured report the agent MUST present alongside the draft:
  `zeroDependencyConfirmed`, `reproductionCommand`, `reproductionResult`,
  `duplicateSearchPerformed`, `affectedPackages`, `identityReminderShown`,
  `humanGate`, and the captured `environment` (`node`, `os`, `zipnativeMcp`).
- `warnings` — advisory notes (e.g. a recommended field appears to be missing).

The tool result carries two text blocks — the human-gate notice
(`DRAFT ONLY — not submitted …`) and the draft — so a host that renders only text
still shows both.

### When it refuses (`GOVERNANCE_VIOLATION`)

The draft is rejected before you can submit it if it:

- proposes an external runtime dependency, or
- sets `duplicateSearchPerformed: false`.

A call without `reproduction` never reaches the policy: the field is required, so it is
`VALIDATION_ERROR`. The tool always fences the reproduction command, so the "no
reproduction code block" check fires only on a hand-written draft (`npm run verify:issue`).

Fix the draft and call again. This keeps the human from ever submitting a
contract-breaking issue.

---

## 6. Verifying a draft on disk

When `outputMode: 'file'` is used, the draft `.md` lands in the sandbox
`ZIPNATIVE_MCP_OUTPUT_DIR` (and is listed under `resources/list` as
`zipnative://output/<path>`) — the tool never writes anywhere else. Copy it to
`.github/drafts/` (the human's review staging area — git-ignored except its README,
the templates and the `pr-*.md` / `issue-*.md` drafts a maintainer chooses to keep)
and re-check it with the same policy the tool applied:

```bash
npm run verify:issue -- .github/drafts/<draft>.md
```

No CI job runs this verifier over `.github/drafts/` (drafts are work in progress);
run it locally before presenting a draft.

`scripts/verify-issue.mjs` is the dependency-free, build-independent CLI mirror of
`validateIssueMarkdown()` in [`src/governance.ts`](../../src/governance.ts): the same
checks (no runtime-dependency proposal, a fenced reproduction block, the required
fields as an advisory), with the same linear-time dependency pattern. Exit 0 on pass,
1 on a policy violation, 2 on a usage or I/O error. `tests/governance.test.ts` asserts
that the two apply the same policy, and that the policy embedded in the server equals
`.github/ai-governance.json`.

---

## 7. What the server will never do

- Open, edit, comment on, or close a GitHub issue or PR.
- Trigger a release.
- Make any outbound network request, or emit telemetry — there is no code that could.
- Persist your draft anywhere except the opt-in `ZIPNATIVE_MCP_OUTPUT_DIR` sandbox
  when you explicitly ask for `outputMode: 'file'` (and never over an existing file).

The agent drafts. The human decides. That is the whole contract.
