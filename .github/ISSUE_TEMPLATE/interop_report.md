---
name: Interop report
about: An archive a zipnative-mcp tool wrote that another tool rejects, or a real-world archive the tools mishandle
title: '[interop] '
labels: interop
assignees: ''
---

<!-- The server contains no ZIP logic of its own: bytes are written and read
     by the zipnative engine. This template collects the evidence; if the root
     cause is in the engine (it usually is), the maintainers move the report
     to https://github.com/Nizoka/zipnative/issues/new/choose and the server
     ships the fixed engine in a patch release. -->

## Direction

- [ ] `create_zip` / `modify_zip` **wrote** an archive that another tool rejects
- [ ] Another tool **wrote** an archive that `inspect_zip` / `extract_zip` / `verify_zip` / … mishandles

## The other tool

Name and **exact version** (e.g. `unzip 6.00`, `7-Zip 24.08`, `Windows 11 Explorer`,
`macOS 15 Archive Utility`, `Temurin 21 jar`, `Python 3.12 zipfile`):

## The tool call

```json
{
  "method": "tools/call",
  "params": {
    "name": "create_zip",
    "arguments": { "entries": [] }
  }
}
```

## Evidence

- Error/output from the other tool:
- zipnative-mcp result: `<tool> failed [CODE]: …`, `verify_zip` report, or `inspect_zip` diagnostics:
- Archive attached, or generator script, or `7z l -slt` dump:
- veraZIP verdict, if you ran it (`npm run validate:zip` on a checkout with the archive copied into `test-output/zip/` is NOT needed — `verify_zip` + `inspect_zip` output is enough):

## Producer

If the archive came from a real-world producer (Word, a build tool, a phone),
name it — the engine's interop corpus grows from these reports.
