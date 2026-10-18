/**
 * The wrapper's own error codes (the server boundary: validation, sandbox,
 * caps, output, governance), with the one-line meaning and the fix an agent
 * acts on. The 39 `ZIP_*` engine codes pass through verbatim (see
 * src/zip-errors.ts). tests/error-codes.test.ts asserts every `ToolError`
 * code raised in `src/` is listed here, and the docs-consistency gate holds
 * the agent contract's error table to this list.
 */
export interface WrapperCodeEntry {
    readonly code: string;
    readonly meaning: string;
    readonly remedy: string;
}

export const WRAPPER_CODES: readonly WrapperCodeEntry[] = [
    { code: 'VALIDATION_ERROR', meaning: 'The input failed the schema: wrong type / bound / enum / pattern, an unknown or misspelt key (every object is strict), none or several of the exclusive input forms, an invalid glob, a prototype segment in a fields path.', remedy: 'Re-read the field schema (the message names the path); pass exactly one input form.' },
    { code: 'INPUT_TOO_LARGE', meaning: 'A decoded inline payload or the sum of inline payloads exceeds 128 MiB, or a zipPath / sourcePath file exceeds 1 GiB on a buffered tool.', remedy: 'Route the bytes through a sandbox file (data.remedy: zipPath), or split the input.' },
    { code: 'INPUT_NOT_FOUND', meaning: 'A zipPath / sourcePath does not exist in the sandbox (a dangling link too) or is not a regular file.', remedy: 'Check the relative path with resources/list; drop the file into ZIPNATIVE_MCP_OUTPUT_DIR.' },
    { code: 'ENTRY_TOO_LARGE', meaning: 'An entry above the 16 MiB inline cap (read_zip_entry, extract_zip base64 mode, scan_zip_forward data: include).', remedy: 'A range, outputMode: file, a filter, or data: verify (data.remedy names it).' },
    { code: 'ENTRY_NOT_UTF8', meaning: "encoding: 'utf8' on content that is not valid UTF-8.", remedy: "Read it with encoding: 'base64'." },
    { code: 'OUTPUT_TOO_LARGE', meaning: 'An inline result above its cap (50 MiB archive, 32 MiB extraction), a file output above the file cap, a resource above the 50 MiB read cap.', remedy: "outputMode: 'file' with ZIPNATIVE_MCP_OUTPUT_DIR set; a filter or includeData: false." },
    { code: 'OUTPUT_EXISTS', meaning: 'The target file already exists in the sandbox — the server never overwrites.', remedy: 'Choose another outputPath / outputDir, or remove the file yourself.' },
    { code: 'IO_ERROR', meaning: 'A filesystem operation failed, or a sandbox file changed (grew or shrank) while it was being read; the message never carries an absolute path.', remedy: 'Fix the sandbox directory, or retry once the file is complete (data.remedy: retry).' },
    { code: 'SECURITY_VIOLATION', meaning: 'File I/O with ZIPNATIVE_MCP_OUTPUT_DIR unset; a NUL byte; an absolute / drive / UNC path; a path escaping the sandbox; a real path (symlink, junction) outside it on a read or a write; a file swapped while it was being opened.', remedy: 'Set ZIPNATIVE_MCP_OUTPUT_DIR; pass relative paths only; remove the link.' },
    { code: 'MISSING_OUTPUT_PATH', meaning: "outputMode: 'file' without outputPath (or outputDir for extract_zip).", remedy: 'Pass a relative outputPath / outputDir.' },
    { code: 'INVALID_PATH', meaning: 'A path member is empty or not a string.', remedy: 'Pass a non-empty relative path.' },
    { code: 'INVALID_EXTENSION', meaning: 'An outputPath / zipPath that does not end in a container extension; .md for a governance draft; the inflate_raw allow-list.', remedy: 'Fix the extension (sourcePath and extracted files are not subject to it).' },
    { code: 'LIMIT_CEILING_EXCEEDED', meaning: 'A limits.* value, an explicit scan maxEntries or parallel.workers above its operator ceiling (data.env names the variable).', remedy: 'Lower the value, or the operator raises the ceiling for trusted input only.' },
    { code: 'UNKNOWN_RESOURCE', meaning: 'resources/read with a URI outside zipnative://output/, an empty path, or a missing file — surfaced as JSON-RPC error -32602.', remedy: 'List URIs with resources/list.' },
    { code: 'GOVERNANCE_VIOLATION', meaning: 'A draft_governance_issue draft breaks the AI-governance contract (a runtime dependency, no reproduction block, duplicateSearchPerformed: false).', remedy: 'Remove the dependency proposal, include the reproduction, confirm the duplicate search.' },
    { code: 'ENGINE_ERROR', meaning: 'Something that is not a ZipError escaped the engine or the runtime (a bug — data.errorClass: internal); the message never carries an absolute path.', remedy: 'Report it with a reproduction via draft_governance_issue.' },
];

export const WRAPPER_CODE_NAMES: readonly string[] = WRAPPER_CODES.map((c) => c.code);
