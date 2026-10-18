# openZip({ validate: 'eager' }) checks extents but not the local-header fields its doc names

> **Type:** bug · **Target:** zipnative

## Summary

The validate: 'eager' option is documented as cross-checking every local header up front, but the eager pass only proves extents (overlap, reach into the central directory, Zip64 spoofing). A method / CRC / size divergence between the central record and the local header, or a declared-size bomb, is detected only when the entry is read. A caller that re-emits entries without reading them (ZipModifier.save(), the append path) therefore carries a divergent entry into its output unless it reads every entry raw first, which zipnative-mcp now does as a workaround.

## Minimal reproduction

Command / tool call:

```
Build a one-entry stored archive whose local header says method 8 while the central record says 0 (the raw builder of tests/_fixtures/raw-zip-builder.ts, lfhMethodOverride: 8); then const r = openZip(bytes, { validate: 'eager' }); createZipModifier(r).save(); r.readEntryRaw(r.entries().next().value);
```

Result:

```
openZip succeeds; save() re-emits the entry whose local header names another method; readEntryRaw() on the same entry throws ZIP_CD_LFH_MISMATCH (and ZIP_LIMIT_EXCEEDED for the declared bomb).
```

## Expected behavior

validate: 'eager' runs the same local-header cross-check and declared-size enforcement as readEntryRaw() for every entry (no decompression), or the documentation scopes the eager pass to extents only.

## Actual behavior

openZip succeeds; save() re-emits the entry whose local header names another method; readEntryRaw() on the same entry throws ZIP_CD_LFH_MISMATCH (and ZIP_LIMIT_EXCEEDED for the declared bomb).

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
