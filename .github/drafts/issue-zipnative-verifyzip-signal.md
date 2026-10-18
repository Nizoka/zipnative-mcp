# verifyZip() takes no signal / onProgress (the one long call that cannot be cancelled)

> **Type:** feature · **Target:** zipnative

## Summary

zipnative 1.1.0 added signal and onProgress to every asynchronous call, but verifyZip(bytes, options) is synchronous and its VerifyZipOptions carries only limits. A wrapper that verifies a large archive (zipnative-mcp verify_zip) can neither stop nor report progress: a cancelled MCP request keeps the process busy until the whole archive has been decompressed and checked, and every other request waits behind it.

## Minimal reproduction

Command / tool call:

```
const w = createZip(); w.add('big.bin', new Uint8Array(200 * 1024 * 1024)); const bytes = w.toBytes(); const t = Date.now(); setTimeout(() => console.log('timer fired after', Date.now() - t, 'ms'), 300); verifyZip(bytes);
```

Result:

```
verifyZip returns ok:true after about 3 s; the 300 ms timer (standing for an AbortController.abort() from a cancelled request) only fires after it returned, and VerifyZipOptions has no signal or onProgress to pass.
```

## Expected behavior

VerifyZipOptions accepts signal and onProgress like the other 1.1.0 entry points (or an async verifyZipAsync), checking the signal between entries / chunks and reporting ZipProgress per verified entry.

## Actual behavior

verifyZip returns ok:true after about 3 s; the 300 ms timer (standing for an AbortController.abort() from a cancelled request) only fires after it returned, and VerifyZipOptions has no signal or onProgress to pass.

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
