---
description: "Use when touching the sandbox, file IO, path handling, size caps, engine limits, extraction guards or the HTTP transport."
applyTo: "src/sandbox.ts,src/output.ts,src/archive-input.ts,src/caps.ts,src/limits.ts,src/filter.ts,src/tools/extract-zip.ts,src/tools/create-zip.ts,src/tools/modify-zip.ts,src/tools/merge-zip.ts,src/tools/canonicalize-zip.ts,src/http.ts,src/auth.ts,src/cache.ts"
---
# Security Standards

## Filesystem confinement
- ONE boundary: `ZIPNATIVE_MCP_OUTPUT_DIR` (`src/sandbox.ts`, an absolute path). Every read (`zipPath`, `sourcePath`,
  `resources/read`) and write (`outputPath`, `outputDir`, extracted files, governance drafts) resolves through it;
  unset ⇒ file I/O is disabled and the tools work on base64 only.
- Reject: NUL bytes, absolute / Windows drive / UNC paths, `..` traversal, an output name outside
  `ZIP_CONTAINER_EXTENSIONS` (`.md` for drafts); check the parent's realpath after `mkdir -p` (a symlinked directory must
  not redirect a write); write exclusively (`wx`) — the server never overwrites (`OUTPUT_EXISTS`).
- Reads go through ONE open handle (`openInputFile` / `readInputFile`): open, fstat, prove the real path inside the
  sandbox and bind it to the handle by device and inode, then read only the handle — a planted symlink or junction, or a
  file swapped during the open, is `SECURITY_VIOLATION`; a file that grows or shrinks during the read is `IO_ERROR`. The
  byte-range reader (`access: 'range'`) reads the same handle, never a URL.
- Extraction joins ONLY the engine's sanitized path under `outputDir`; a symlink accepted through `rejectSymlinks:false`
  is written as a regular file holding the target text, never materialised as a link.
- Never leak an absolute path in an error: use `relativeLabel`; the `ENGINE_ERROR` boundary redacts absolute paths.

## Engine guards stay on
- `rejectTraversal`, `rejectSymlinks`, `onDuplicate:'error'` and the engine's nine `ZipLimits` defaults are the defaults;
  a relaxation is an explicit, named input and is documented in the tool description with its CWE. Overlap and
  central/local divergence detection have no opt-out; `modify_zip` opens its input eagerly; `merge_zip` verifies every
  entry before copying it (`verify: true`); `addRaw()` stays unexposed.
- `limits.*` widen a bound for one call only and can never exceed the operator ceilings (`LIMIT_CEILING_EXCEEDED` names
  the env var). Never add a ceiling that a tool argument can raise.
- The engine holds no decryption code: encrypted entries are detected (`ZIP_UNSUPPORTED_ENCRYPTION`), never decrypted —
  do not add any.
- Globs compile to a linear-time matcher (`src/filter.ts`, CWE-1333); never reintroduce a backtracking RegExp over
  attacker-controlled names.
- Weakening any default is a human decision recorded in the PR (`.github/AGENT_RULES.md` rule 6).

## Byte and count caps (`src/caps.ts`)
- 256 MiB stdio frame / HTTP body; 128 MiB decoded base64 input; 1 GiB buffered `zipPath` (larger: byte ranges);
  50 MiB inline output; file output 4 GiB by default (`ZIPNATIVE_MCP_MAX_FILE_OUTPUT_BYTES`); 16 MiB inline entry;
  32 MiB inline extraction total; list limit 200 / 2000; create ≤ 100 000 entries (aligned with the engine default
  `maxEntries` so Zip64 output stays reachable); modify ≤ 1000 ops; merge ≤ 32 sources, ≤ 1 GiB in all;
  sanitize ≤ 10 000 names; filter names ≤ 1000 / globs ≤ 32 of ≤ 1024 characters; extra fields ≤ 16; `fields` ≤ 16;
  scan default `maxEntries` 10 000 (clamped to the ceiling); ≤ 50 resource links; `resources/list` ≤ 1000 entries /
  depth 8 / 50 MiB read; cache 3600 s / 256 MiB; diagnostics capped at 200 rows. Every constant is advertised by
  `describe_engine.caps` and quoted in the docs — change both.

## Network and HTTP
- There is NO network code path in this server and none may be added — not behind an env var, not for telemetry, not
  for GitHub. A tool argument never carries a URL that is fetched (`tests/no-network.test.ts`).
- HTTP mode (`ZIPNATIVE_MCP_PORT`) binds loopback, checks Host/Origin and bounds headers, body and timeouts
  (`src/http.ts`; `nosniff` + `no-store` on every response; Host/Origin and the bearer token are checked before the
  body is read); `ZIPNATIVE_MCP_HTTP_TOKEN` (`src/auth.ts`, ≥ 16 chars,
  constant-time compare, RFC 6750 challenge) is the only authentication — recommend it, and document that without it
  any local process can reach the endpoint.
- The cache (`ZIPNATIVE_MCP_CACHE_DIR`) stores results in plaintext: never cache path inputs, file outputs,
  environment-dependent or environment-embedding results, or a cancelled call; the key carries the four operator ceilings,
  and the directory must be absolute.

## Dependency and CI security
- Exactly three runtime dependencies (zipnative, `@modelcontextprotocol/server`, zod); adding one is a governance blocker.
- npm publish via OIDC Trusted Publishing only; the verify job attaches a CycloneDX SBOM (`npm sbom`).
- Keep the lockfile committed and audit in CI; keep CodeQL and Scorecard workflows; every action is SHA-pinned; every
  checkout uses `persist-credentials: false`; every job starts with harden-runner except the documented macOS gate leg;
  installs use `--ignore-scripts`.
- Foreign-provenance fixtures (`tests/fixtures/interop/`) are never regenerated by the engine.
