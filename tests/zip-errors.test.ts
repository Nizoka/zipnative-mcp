/**
 * Tests for `src/zip-errors.ts` — the engine error → ToolError mapping.
 */
import { describe, it, expect } from 'vitest';
import { ZipDataError, ZipError, ZipFormatError, ZipLimitError, ZipSecurityError, ZipUnsupportedError } from 'zipnative';

import { guard, guardAsync, mapZipError, ZIP_DIAGNOSTIC_CODES, ZIP_ERROR_CLASS, ZIP_ERROR_CODES } from '../src/zip-errors.js';
import { ToolError } from '../src/errors.js';

describe('zip-errors', () => {
    it('the frozen vocabularies have the documented sizes and classes', () => {
        expect(ZIP_ERROR_CODES).toHaveLength(39);
        expect(ZIP_DIAGNOSTIC_CODES).toHaveLength(11);
        expect(new Set(ZIP_ERROR_CODES).size).toBe(39);
        const classes = new Set(Object.values(ZIP_ERROR_CLASS));
        expect([...classes].sort()).toEqual(['check', 'data', 'input', 'internal', 'limit', 'not-found', 'parse', 'security', 'unsupported', 'usage']);
        expect(ZIP_ERROR_CLASS.ZIP_ENTRY_OVERLAP).toBe('security');
        expect(ZIP_ERROR_CLASS.ZIP_LIMIT_EXCEEDED).toBe('limit');
        expect(ZIP_ERROR_CODES[0]).toBe('ZIP_INVALID_OPTION');
        expect(ZIP_ERROR_CODES[38]).toBe('ZIP_UNSUPPORTED_CODEC_MODE');
    });

    it('maps a base ZipError with its class and engine name', () => {
        const mapped = mapZipError(new ZipError('ZIP_ENTRY_EXISTS', 'zipnative: exists'), 'Failed to add');
        expect(mapped).toBeInstanceOf(ToolError);
        expect(mapped.code).toBe('ZIP_ENTRY_EXISTS');
        expect(mapped.message).toBe('Failed to add: zipnative: exists');
        expect(mapped.data).toEqual({ errorClass: 'input', engineError: 'ZipError' });
    });

    it('maps a ZipFormatError and applies the caller-supplied entry name and extra fields', () => {
        const mapped = mapZipError(new ZipFormatError('ZIP_RECORD_TRUNCATED', 'zipnative: short'), 'Failed', 'x.txt', { operationIndex: 3 });
        expect(mapped.code).toBe('ZIP_RECORD_TRUNCATED');
        expect(mapped.data).toEqual({ errorClass: 'parse', engineError: 'ZipFormatError', entryName: 'x.txt', operationIndex: 3 });
    });

    it('maps a ZipLimitError with limit / configured / observed (Infinity as a string)', () => {
        const mapped = mapZipError(new ZipLimitError('ZIP_LIMIT_EXCEEDED', 'zipnative: too many', 'maxEntries', 10, 11), 'Failed');
        expect(mapped.code).toBe('ZIP_LIMIT_EXCEEDED');
        expect(mapped.data).toEqual({ errorClass: 'limit', engineError: 'ZipLimitError', limit: 'maxEntries', configured: 10, observed: 11 });
        const invalid = mapZipError(new ZipLimitError('ZIP_LIMIT_INVALID', 'zipnative: bad', 'maxEntries', Number.NaN, Number.POSITIVE_INFINITY), 'Failed');
        expect(invalid.data).toMatchObject({ errorClass: 'usage', limit: 'maxEntries', configured: 'NaN', observed: 'Infinity' });
    });

    it('maps a ZipSecurityError with the engine entry name winning over the caller one', () => {
        const mapped = mapZipError(new ZipSecurityError('ZIP_PATH_TRAVERSAL', 'zipnative: slip', '../evil'), 'Failed', 'caller-name');
        expect(mapped.code).toBe('ZIP_PATH_TRAVERSAL');
        expect(mapped.data).toEqual({ errorClass: 'security', engineError: 'ZipSecurityError', entryName: '../evil' });
        const noName = mapZipError(new ZipSecurityError('ZIP_ENTRY_OVERLAP', 'zipnative: overlap'), 'Failed');
        expect(noName.data).toEqual({ errorClass: 'security', engineError: 'ZipSecurityError' });
    });

    it('maps a ZipDataError with CRCs as 8-hex (null when absent)', () => {
        const crc = mapZipError(new ZipDataError('ZIP_CRC_MISMATCH', 'zipnative: crc', 'c.txt', 0xdeadbeef, 0x0d4a1185), 'Failed');
        expect(crc.data).toEqual({ errorClass: 'data', engineError: 'ZipDataError', entryName: 'c.txt', expectedCrc: 'deadbeef', actualCrc: '0d4a1185' });
        const onlyExpected = mapZipError(new ZipDataError('ZIP_CRC_MISMATCH', 'zipnative: crc', undefined, 1), 'Failed', 'fallback');
        expect(onlyExpected.data).toEqual({ errorClass: 'data', engineError: 'ZipDataError', entryName: 'fallback', expectedCrc: '00000001', actualCrc: null });
        const size = mapZipError(new ZipDataError('ZIP_SIZE_MISMATCH', 'zipnative: size', 's.txt'), 'Failed');
        expect(size.data).toEqual({ errorClass: 'data', engineError: 'ZipDataError', entryName: 's.txt' });
    });

    it('maps a ZipUnsupportedError with its feature', () => {
        const mapped = mapZipError(new ZipUnsupportedError('ZIP_UNSUPPORTED_ENCRYPTION', 'zipnative: enc', 'zipcrypto'), 'Failed', 'secret.txt');
        expect(mapped.data).toEqual({ errorClass: 'unsupported', engineError: 'ZipUnsupportedError', entryName: 'secret.txt', feature: 'zipcrypto' });
        const method = mapZipError(new ZipUnsupportedError('ZIP_UNSUPPORTED_METHOD', 'zipnative: m', 'method:93'), 'Failed');
        expect(method.data).toMatchObject({ feature: 'method:93' });
    });

    it('maps node:zlib error codes onto the deflate codes regardless of tier', () => {
        const data = Object.assign(new Error('invalid stored block lengths'), { code: 'Z_DATA_ERROR' });
        const mapped = mapZipError(data, 'Failed to inflate', 'e.bin', { operationIndex: 1 });
        expect(mapped.code).toBe('ZIP_DEFLATE_CORRUPT');
        expect(mapped.message).toBe('Failed to inflate: invalid stored block lengths');
        expect(mapped.data).toEqual({ errorClass: 'parse', engineError: 'ZlibError', entryName: 'e.bin', operationIndex: 1 });
        expect(mapZipError(Object.assign(new Error('unexpected end of file'), { code: 'Z_BUF_ERROR' }), 'F').code).toBe('ZIP_DEFLATE_TRUNCATED');
        expect(mapZipError(Object.assign(new Error('dict'), { code: 'Z_NEED_DICT' }), 'F').code).toBe('ZIP_DEFLATE_CORRUPT');
        expect(mapZipError(Object.assign(new Error('dict'), { code: 'Z_NEED_DICT' }), 'F').data).not.toHaveProperty('entryName');
        expect(mapZipError(Object.assign(new Error('x'), { code: 'ENOENT' }), 'F').code).toBe('ENGINE_ERROR');
    });

    it('passes a ToolError through untouched', () => {
        const original = new ToolError('OUTPUT_EXISTS', 'exists', { path: 'x' });
        expect(mapZipError(original, 'Failed')).toBe(original);
    });

    it('falls back to ENGINE_ERROR for anything else', () => {
        const err = mapZipError(new TypeError('boom'), 'Failed', 'n', { extra: 1 });
        expect(err.code).toBe('ENGINE_ERROR');
        expect(err.message).toBe('Failed: boom');
        expect(err.data).toEqual({ errorClass: 'internal', extra: 1 });
        const str = mapZipError('string thrown', 'Failed');
        expect(str.code).toBe('ENGINE_ERROR');
        expect(str.message).toBe('Failed: string thrown');
        expect(str.data).toEqual({ errorClass: 'internal' });
        expect(mapZipError(undefined, 'Failed').message).toBe('Failed: undefined');
    });

    it('guard returns the value or throws the mapped error', () => {
        expect(guard('ctx', () => 42)).toBe(42);
        expect(() => guard('ctx', () => { throw new ZipError('ZIP_INTERNAL', 'x'); })).toThrow(expect.objectContaining({ code: 'ZIP_INTERNAL', message: 'ctx: x', data: { errorClass: 'internal', engineError: 'ZipError' } }));
        expect(() => guard('ctx', () => { throw new Error('plain'); }, 'e', { op: 'add' })).toThrow(expect.objectContaining({ code: 'ENGINE_ERROR', data: { errorClass: 'internal', op: 'add' } }));
    });

    it('guardAsync awaits the value or rejects with the mapped error', async () => {
        await expect(guardAsync('ctx', async () => 'ok')).resolves.toBe('ok');
        await expect(guardAsync('ctx', async () => { throw new ZipSecurityError('ZIP_SYMLINK_REJECTED', 'link', 'l'); }, 'x')).rejects.toMatchObject({ code: 'ZIP_SYMLINK_REJECTED', data: { entryName: 'l' } });
        await expect(guardAsync('ctx', () => Promise.reject(new ToolError('IO_ERROR', 'io')))).rejects.toMatchObject({ code: 'IO_ERROR', message: 'io' });
    });
});
