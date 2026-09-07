---
name: Bug Report
about: Report a bug in zipnative-mcp (the MCP wrapper — schemas, sandbox, transport, output modes)
title: ''
labels: bug
assignees: ''
---

<!-- Engine behaviour (parsing, writing, DEFLATE, CRC, Zip64, limits, a ZIP_*
     code raised on a valid archive)? That belongs upstream:
     https://github.com/Nizoka/zipnative/issues/new/choose -->

## Description

<!-- A clear description of the bug. -->

## Steps to Reproduce

1.
2.
3.

## Expected Behavior

<!-- What should happen? -->

## Actual Behavior

<!-- What happens instead? Include the tool error text `<tool> failed [CODE]: …` and `_meta.error`. -->

## Environment

- **zipnative-mcp version:**
- **zipnative version:** <!-- describe_engine → engine.version -->
- **Runtime:** <!-- Node.js 22/24, Claude Desktop, Cursor, ChatGPT, HTTP mode, etc. -->
- **OS:**
- **Environment variables set:** <!-- ZIPNATIVE_MCP_OUTPUT_DIR, ZIPNATIVE_MCP_WORKERS, … (never paste ZIPNATIVE_MCP_HTTP_TOKEN) -->

## Minimal Reproduction

```json
{
  "method": "tools/call",
  "params": {
    "name": "inspect_zip",
    "arguments": { "zipBase64": "<base64 of a minimal archive>" }
  }
}
```

<!-- Attach the archive (or a generator script) when the bug depends on its bytes. -->

## Additional Context

<!-- Logs, stack traces, produced output, `verify_zip` report, etc. -->
