/**
 * Custom error type for tool-level failures (returned to the client as
 * `isError: true`). `code` is either one of the wrapper codes documented in
 * AGENTS.md §6 or one of zipnative's 39 frozen `ZIP_*` codes carried verbatim
 * (see src/zip-errors.ts). `data` carries machine-readable detail (the limit
 * that fired, the entry name, the unsupported feature, …) and is surfaced as
 * `_meta.error.data` — never anything secret.
 */
export class ToolError extends Error {
    public override readonly name: string = 'ToolError';
    public readonly code: string;
    public readonly data: Readonly<Record<string, unknown>> | undefined;

    public constructor(code: string, message: string, data?: Readonly<Record<string, unknown>>) {
        super(message);
        this.code = code;
        this.data = data;
    }
}

/**
 * Custom error for security-related violations (path traversal, sandbox escapes).
 */
export class SecurityError extends ToolError {
    public override readonly name: string = 'SecurityError';

    public constructor(message: string) {
        super('SECURITY_VIOLATION', message);
    }
}

/**
 * Custom error for AI-governance / human-in-the-loop policy violations raised
 * by `draft_governance_issue` (code `GOVERNANCE_VIOLATION`).
 *
 * The server never opens GitHub issues; it only produces a local, compliant
 * draft. This error fires when a would-be draft breaks the non-negotiable
 * governance contract (proposing a runtime dependency, missing a local
 * reproduction, or skipping the duplicate search) so the human reviewer is
 * forced to fix the draft before they submit it under their own identity.
 */
export class GovernanceError extends ToolError {
    public override readonly name: string = 'GovernanceError';

    public constructor(message: string) {
        super('GOVERNANCE_VIOLATION', message);
    }
}

/**
 * Replace every absolute filesystem path in a message with `<path>`: a POSIX
 * path of two segments or more, a Windows drive path, or a UNC path. Used on
 * messages the server did not write itself (a raw Node or runtime error), so
 * an escaped `ENOENT, open 'C:\Users\…'` never tells the client where the
 * server runs. URIs (`zipnative://output/…`) and relative names are kept.
 */
export function redactAbsolutePaths(message: string): string {
    return message
        .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s'"`,;)]*/g, '<path>')
        .replace(/(?<![\w:/.~-])\/(?:[^\s'"`,;)/]+\/)+[^\s'"`,;)]*/g, '<path>');
}
