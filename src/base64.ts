/**
 * Shared base64 decoding with agent-friendly diagnostics.
 *
 * `Buffer.from(x, 'base64')` never throws — it silently skips invalid
 * characters — so the classic mistakes an LLM makes (a `data:…;base64,`
 * URI, plain text, base64 encoded twice) would surface much later as opaque
 * engine errors. These helpers catch them at the boundary with a remedy in
 * the message.
 */
import { ToolError } from './errors.js';

const DATA_URI_RE = /^data:[^,]*;base64,/i;

/** Decode base64 (tolerating whitespace and a `data:…;base64,` prefix). */
export function decodeBase64Field(value: string, field: string): Uint8Array {
    const stripped = value.replace(DATA_URI_RE, '').replace(/\s+/g, '');
    if (stripped.length === 0 || /[^A-Za-z0-9+/=_-]/.test(stripped)) {
        throw new ToolError('VALIDATION_ERROR', `${field} is not valid base64 (plain base64 string expected, no data: URI, no PEM armour).`);
    }
    return new Uint8Array(Buffer.from(stripped, 'base64'));
}

/**
 * Decode a base64 ZIP archive. Only the unmistakable agent mistakes are
 * intercepted here (empty payload, nested `data:` URI, PEM text, base64
 * encoded twice); everything else is handed to the engine, whose parser is the
 * authority on what is and is not a ZIP archive.
 */
export function decodeZipBase64(value: string, field = 'zipBase64'): Uint8Array {
    const bytes = decodeBase64Field(value, field);
    if (bytes.length === 0) {
        throw new ToolError('VALIDATION_ERROR', `${field} decodes to an empty buffer.`);
    }
    const head = Buffer.from(bytes.subarray(0, 10)).toString('latin1');
    const hint = head.startsWith('-----BEGIN')
        ? 'the value is PEM text, not an archive'
        : head.startsWith('data:')
            ? 'the value is a nested data: URI'
            : head.startsWith('UEsDB') || head.startsWith('UEsFB')
                ? 'the value is base64 encoded twice'
                : undefined;
    if (hint !== undefined) {
        throw new ToolError('VALIDATION_ERROR', `${field} does not decode to a ZIP archive: ${hint}. Pass the raw archive bytes as base64 (exactly once).`);
    }
    return bytes;
}

/** Encode bytes as standard base64 (no line breaks). */
export function encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
