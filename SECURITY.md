# Security Policy

## Supported versions

The latest published minor on npm receives security patches. Older versions are unsupported once a new minor lands.

| Version | Supported |
| ------- | --------- |
| `1.0.x` | yes |
| < 1.0 (never published to npm) | no |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report suspected vulnerabilities privately via GitHub Security Advisories:
<https://github.com/Nizoka/zipnative-mcp/security/advisories/new> (**Security → Report a vulnerability** on the repository). Include:

- A description of the vulnerability.
- Reproduction steps or a minimal proof of concept — for an archive-shaped issue, the archive itself (or the `create_zip` arguments that produce it) and the tool call.
- The version of `zipnative-mcp`, `zipnative` and Node.js you tested against.
- Any suggested mitigation.

You will receive an acknowledgement within **7 days**. We aim to ship a fix and a coordinated public advisory within **30 days** of the initial report (or sooner for critical issues). Engine-level findings (parser, writer, extraction guards) belong to [Nizoka/zipnative](https://github.com/Nizoka/zipnative/security/advisories/new) — report to both when unsure.

## Threat model

`zipnative-mcp` is designed to run as a local MCP server, spawned by a trusted host (Claude Desktop, Cursor, etc.) and communicating over stdio (or a loopback-only Streamable HTTP endpoint when `ZIPNATIVE_MCP_PORT` is set). The threat model assumes:

- The **host process is trusted** (the user installed it themselves).
- The **operator** who sets the environment variables is trusted.
- The **LLM controlling the host is untrusted** — it may send arbitrary, malicious tool arguments (names, paths, limits, base64).
- **Archive inputs are untrusted** — every header, name, size, flag and payload may lie.
- The **filesystem outside `ZIPNATIVE_MCP_OUTPUT_DIR` must remain inaccessible** — for reads as much as for writes; with the variable unset the server has no filesystem access at all.

In particular we defend against (details and CWE ids in [docs/guides/SECURITY.md](docs/guides/SECURITY.md)):

- **Zip-slip path traversal and Windows reserved device names** (`../`, absolute paths, drive letters, backslashes, UNC, NUL, NTFS alternate data streams, `CON` / `NUL` / `COM1`…) — the engine's `rejectTraversal: true` default in `extract_zip`; the engine's sanitized path is the only thing ever joined onto the output directory; `sanitize_entry_paths` exposes the same gate for external sinks. Relaxing it *skips* unsafe names, never emits them.
- **Decompression bombs** (high ratio, nesting, entry floods) — the engine's eight `ZipLimits` bounds, enforced *during* inflation; per-call `limits` can never exceed the operator ceilings `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS` (`LIMIT_CEILING_EXCEEDED`; an invalid ceiling refuses to start); `inflate_raw` requires a `maxOutput` bound.
- **Symlink entries** — `rejectSymlinks: true` by default; a symlink accepted through `rejectSymlinks: false` is written as a regular file holding the link target text, never materialised as a link. A symlinked directory pre-planted inside the sandbox cannot redirect a write outside it (realpath re-check after every `mkdir -p`).
- **Overlapping entries, central-vs-local header differentials, Zip64 sentinel spoofing, ambiguous EOCD records** — always-on engine checks with no opt-out (`ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION`, `ZIP_EOCD_NOT_FOUND`).
- **Duplicate entry names shadowing each other** — `onDuplicate: 'error'` by default.
- **Sandbox escape through tool arguments** — every path (`zipPath`, `sourcePath`, `outputPath`, `outputDir`) resolves through one module: relative only, NUL / absolute / UNC / `..` rejected, container-extension allow-list on archive paths, absolute paths never echoed.
- **Arbitrary file overwrite** — every write opens with `wx` (`OUTPUT_EXISTS`); partial files are removed on failure; the input archive is never touched.
- **Resource exhaustion through the exchange** — 256 MiB stdio frame / HTTP body cap (413), 128 MiB decoded base64 input per call, 1 GiB buffered path input, 16 MiB per inline entry, 32 MiB per inline extraction, 50 MiB per inline output, 4 GiB streamed file output (enforced while writing), bounded JSON shapes, 200 diagnostics per result.
- **Prototype pollution** — `additionalProperties: false` on every JSON Schema input object; Zod strict objects at every nesting level (unknown keys are rejected with `VALIDATION_ERROR`, never silently stripped).
- **Malformed base64 at the boundary** — `data:` URIs, PEM text, nested URIs, double-encoded or empty payloads are rejected with a coded error before the engine runs.
- **Code injection through the engine's extension points** — `registerCodec`, `setInflateImpl`, `setDeflateImpl` and `ParallelZipOptions.workerUrl` are not exposed; no tool argument can name a module or a worker script.
- **DNS rebinding against the HTTP transport** — bound to `127.0.0.1`, foreign `Host` / `Origin` answered with 403, the `Origin` port pinned to the server port, `GET` / `DELETE` with 405.
- **Unauthenticated local access to the HTTP transport** — *only when the operator opts in:* `ZIPNATIVE_MCP_HTTP_TOKEN` (≥ 16 characters, no whitespace; a weaker value aborts startup) makes every request to `/mcp` require `Authorization: Bearer <token>`; anything else is answered `401` with `WWW-Authenticate: Bearer realm="zipnative-mcp"` — followed by `, error="invalid_token"` only when the request carried credentials, per RFC 6750 §3.1 — before the MCP handler runs. The comparison is constant-time (SHA-256 + `timingSafeEqual`) and the token is never logged or echoed. stdio mode needs no token (the host owns the pipe).
- **Listener exhaustion on keep-alive HTTP connections** — disconnect detection is attached per response, not per socket.
- **Diagnostics corrupting the stdio wire** — a diagnostics sink is installed on every engine call, so the engine's `console.warn` fallback is never reached.

We do **not** currently defend against:

- **Other local processes reaching the HTTP endpoint when `ZIPNATIVE_MCP_HTTP_TOKEN` is unset.** The default HTTP mode (`ZIPNATIVE_MCP_PORT` without a token) has **no authentication**: the loopback bind and the Host / Origin guard stop browsers and remote hosts, not a process running on the same machine. Set the token whenever anything untrusted can run locally; the startup log states which mode is active (`bearer token required` / `no authentication (loopback only)`).
- **Encrypted archives.** There is no decryption in 1.x by policy (ZipCrypto is broken; supporting it would create false confidence). Encrypted entries are detected and refused with `ZIP_UNSUPPORTED_ENCRYPTION` — never decrypted, never silently skipped by the default extraction.
- **Content of extracted files.** The server does not execute, render or scan what it extracts; treat content from an untrusted archive as untrusted in the caller.
- **The forward reader's trust caveat.** `scan_zip_forward` reads local headers alone and says so (`trust: 'local-headers-only'`); a hostile archive can present different content there than the authoritative readers report. Use it only for streams you cannot seek and never feed its names to a filesystem without `sanitize_entry_paths`.
- **Data remanence of `modify_zip mode: 'append'`.** The append-only save keeps original bytes verbatim, so removed or replaced payloads remain recoverable from the output; `mode: 'compact'` is the true deletion path. Documented loudly on the tool.
- **A maliciously-crafted archive causing a crash inside `zipnative`** beyond what its fuzzing suite covers (the engine is responsible for parser hardening — please report such issues to both projects).
- **Anything stored in the opt-in response cache** (`ZIPNATIVE_MCP_CACHE_DIR`) — it writes tool output as plaintext at rest, which is why path inputs, file-mode calls, wall-clock and worker calls, `describe_engine` and `draft_governance_issue` are never cached; protect the directory like the output sandbox.
- **A residual window between the realpath check and the exclusive open** in file mode — the documented posture is "use an empty or trusted destination".

## Network egress: none

The server makes **no outbound network call, ever**. There is no network code path: no `fetch`, no socket other than the opt-in loopback listener that *receives* MCP requests. No tool argument, environment variable or archive content can name a URL; nothing is sent to GitHub or to a telemetry endpoint; `draft_governance_issue` produces a local draft and stops. `describe_engine.network` is the constant `'none'` and every tool advertises `openWorldHint: false`.

The seven environment variables carry no egress role: `ZIPNATIVE_MCP_OUTPUT_DIR` (the sandbox for reads and writes; unset = no file I/O), `ZIPNATIVE_MCP_CACHE_DIR` (opt-in response cache), `ZIPNATIVE_MCP_PORT` (loopback HTTP transport), `ZIPNATIVE_MCP_HTTP_TOKEN` (**secret**, bearer token for that transport), `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES`, `ZIPNATIVE_MCP_MAX_ENTRIES`, `ZIPNATIVE_MCP_WORKERS` (operator ceilings).

## Release integrity

Packages are published from CI via **npm Trusted Publishing (OIDC)** with **provenance attestations** — verify with `npm audit signatures`. A CycloneDX **SBOM** (generated by the exact-pinned `@cyclonedx/cyclonedx-npm` devDependency, build-time only) is attached to every GitHub Release. The full quality gate — typecheck, lint, tests with coverage, build, `npm audit`, and the ISO/IEC 21320-1 conformance gate — re-runs between the Release and `npm publish`. Nobody publishes from a laptop (`publishConfig.provenance` makes a local `npm publish` fail). Every GitHub Action is pinned to a commit SHA; CI runs CodeQL and OpenSSF Scorecard.

Supply chain at runtime: three dependencies — `zipnative` (zero dependencies), `@modelcontextprotocol/server`, `zod` — and no new one, ever.

## Compatibility promise

- The **tool API** (13 tool names, input / output schemas, the 16 wrapper error codes, the `_meta.error` envelope, the 7 environment variables) is stable under [docs/API_STABILITY.md](docs/API_STABILITY.md): removals, renames and narrowings are semver-major.
- The **39 `ZIP_*` error codes** and **11 diagnostic codes** are passed through verbatim from the engine, where they are frozen; removing or renaming one is a zipnative major and therefore a zipnative-mcp major. Registry: [docs/data/errors.json](docs/data/errors.json).
- The **bytes** `create_zip`, `modify_zip` and `inflate_raw` produce for a given input are byte-identical across patch and minor releases; a change to them — including the engine's `deterministic: true` encoder — is semver-major.
- **Security defaults are never weakened** in a non-major release: `rejectTraversal`, `rejectSymlinks`, `onDuplicate: 'error'`, the `ZipLimits` defaults, the operator ceiling defaults, the sandbox rules and the no-overwrite rule.

## Disclosure policy

Confirmed vulnerabilities are fixed in a patch release with a GitHub Security Advisory and a CHANGELOG entry crediting the reporter (unless anonymity is requested).

## Disclosure history

_None yet._
