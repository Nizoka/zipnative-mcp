# A diagnostic message points to docs/determinism.md, which moved to docs/guides/determinism.md

> **Type:** docs · **Target:** zipnative

## Summary

The message of a determinism diagnostic (src/core/zip-diagnostics.ts around line 160 in zipnative 1.1.0) names docs/determinism.md as the place to read more, but the file in the repository is docs/guides/determinism.md. Wrappers relay engine messages verbatim (zipnative-mcp, zipnative-cli), so the stale path reaches every agent and user that reads the diagnostic.

## Minimal reproduction

Command / tool call:

```
git -C ../zipnative grep -n 'docs/determinism.md' -- src; git -C ../zipnative ls-files docs | grep determinism (zipnative-mcp audit row D-016)
```

Result:

```
The source names docs/determinism.md; only docs/guides/determinism.md exists.
```

## Expected behavior

The diagnostic message names docs/guides/determinism.md (or a stable URL of the published guide).

## Actual behavior

The source names docs/determinism.md; only docs/guides/determinism.md exists.

## Environment

- Node: v22.23.2
- OS: win32 10.0.26200
- zipnative-mcp: 1.1.0
- Affected packages: zipnative

## Compliance

- [x] Zero new runtime dependency proposed
- [x] Searched open and closed issues/PRs for duplicates
- [x] Minimal reproduction executed locally
- [x] Expected vs actual documented

---

> This draft, if submitted, is published under YOUR GitHub identity. You share responsibility for its content. Review it fully before you open the issue manually.

> DRAFT ONLY. The zipnative-mcp server never opens, edits, or submits GitHub issues, comments, PRs, or releases, and makes no outbound network call, ever (it has no network code path). A human MUST explicitly review this draft and submit it themselves.
