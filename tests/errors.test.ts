/**
 * The error boundary: every failure that leaves a tool is coded, and a raw
 * runtime message never names a host path.
 */
import { describe, expect, it } from 'vitest';

import { redactAbsolutePaths, ToolError } from '../src/errors.js';
import { callToolDirect } from '../src/server.js';

describe('redactAbsolutePaths', () => {
    it('replaces Windows drive, UNC and POSIX absolute paths, keeps URIs and relative names', () => {
        expect(redactAbsolutePaths("ENOENT: no such file or directory, open 'C:\\Users\\me\\sandbox\\a.zip'")).toBe("ENOENT: no such file or directory, open '<path>'");
        expect(redactAbsolutePaths('EACCES on D:/data/x.bin, retry')).toBe('EACCES on <path>, retry');
        expect(redactAbsolutePaths('share \\\\srv\\share\\f.zip gone')).toBe('share <path> gone');
        expect(redactAbsolutePaths("open '/home/me/sandbox/a.zip' failed")).toBe("open '<path>' failed");
        expect(redactAbsolutePaths('see zipnative://output/builds/a.zip and src/a.ts')).toBe('see zipnative://output/builds/a.zip and src/a.ts');
        expect(redactAbsolutePaths('a ratio of 1/2 and 3/4')).toBe('a ratio of 1/2 and 3/4');
    });
});

describe('the tool error boundary', () => {
    it('an escaped non-ToolError is ENGINE_ERROR with errorClass internal and a redacted message, never an uncoded failure', async () => {
        const boom = (): never => {
            throw new Error("open '/var/lib/secret/place/x.zip' exploded");
        };
        const hostile = new Proxy({}, { ownKeys: boom, get: boom, has: boom, getOwnPropertyDescriptor: boom });
        const r = await callToolDirect('compute_crc32', hostile);
        expect(r.isError).toBe(true);
        const error = (r._meta as { error?: { code?: string; data?: { errorClass?: string } } } | undefined)?.error;
        expect(error?.code).toBe('ENGINE_ERROR');
        expect(error?.data?.errorClass).toBe('internal');
        const text = (r.content[0] as { text: string }).text;
        expect(text).toMatch(/^compute_crc32 failed \[ENGINE_ERROR\]: /);
        expect(text).not.toContain('/var/lib/secret');
        expect(text).toContain('<path>');
    });

    it('a ToolError keeps its code, message and data', () => {
        const err = new ToolError('IO_ERROR', 'x', { remedy: 'retry' });
        expect([err.code, err.message, err.data]).toEqual(['IO_ERROR', 'x', { remedy: 'retry' }]);
    });
});
