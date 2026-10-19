# Support

Need help with `zipnative-mcp`? Here's where to go:

- **Bug?** [Open an issue](https://github.com/Nizoka/zipnative-mcp/issues/new?labels=bug) — include the `tools/call` payload (or the `create_zip` arguments that produce the archive), the `_meta.error` block verbatim, and the `describe_engine` result.
- **Feature request?** [Open an issue](https://github.com/Nizoka/zipnative-mcp/issues/new?labels=enhancement) or a PR. The `draft_governance_issue` tool produces a compliant draft for a human to submit.
- **Question?** [Start a discussion](https://github.com/Nizoka/zipnative-mcp/discussions) or check existing threads first. The [agent contract](docs/AGENT_CONTRACT.md) (every error code with its fix in §6), the [AI agent guide](docs/AI_GUIDE.md) and the [knowledge base](docs/KNOWLEDGE_BASE.md) answer most "which tool / why was this refused" questions; `describe_engine` shows the limits, ceilings and caps in force.
- **Security issue?** Read [SECURITY.md](SECURITY.md) — please **do not** open a public issue.
- **ZIP engine bugs** (parsing, writing, extraction guards, determinism and canonicalisation, the byte-range reader, limits, codecs): file upstream at [Nizoka/zipnative](https://github.com/Nizoka/zipnative/issues). A refusal whose message names a relaxation, a limit or an operator ceiling is the security posture working, not a bug; a `CANCELLED` result means the client cancelled the request.
- **CLI questions**: the companion [zipnative-cli](https://github.com/Nizoka/zipnative-cli) exposes the same engine on the command line.
- **MCP protocol questions**: see [modelcontextprotocol.io](https://modelcontextprotocol.io) or the [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

We aim to triage issues within 5 business days. This is an open-source project maintained by volunteers — please be patient and constructive.
