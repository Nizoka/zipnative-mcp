/**
 * Tests for `src/diagnostics.ts` — the de-duplicating, capped diagnostic sink.
 */
import { describe, it, expect } from 'vitest';
import type { ZipDiagnostic } from 'zipnative';

import { createDiagnosticSink, DIAGNOSTICS_OUTPUT_PROPERTIES } from '../src/diagnostics.js';
import { MAX_DIAGNOSTICS } from '../src/caps.js';
import { ZIP_DIAGNOSTIC_CODES } from '../src/zip-errors.js';

function emit(sink: ReturnType<typeof createDiagnosticSink>, d: ZipDiagnostic): void {
    (sink.options.onDiagnostic as (x: ZipDiagnostic) => void)(d);
}

describe('createDiagnosticSink', () => {
    it('starts empty and reports an empty block', () => {
        const sink = createDiagnosticSink();
        expect(sink.diagnostics).toEqual([]);
        expect(sink.counts).toEqual({});
        expect(sink.truncated).toBe(false);
        expect(sink.has('ZIP_PREPENDED_DATA')).toBe(false);
        expect(sink.report()).toEqual({ diagnostics: [], diagnosticCounts: {} });
        expect(sink.options.strict).toBeUndefined();
        expect(typeof sink.options.onDiagnostic).toBe('function');
    });

    it('strict:true is passed to the engine options', () => {
        expect(createDiagnosticSink(true).options.strict).toBe(true);
        expect(createDiagnosticSink(false).options).not.toHaveProperty('strict');
    });

    it('de-duplicates by code + entryName while counting every occurrence', () => {
        const sink = createDiagnosticSink();
        emit(sink, { code: 'ZIP_DUPLICATE_NAME', severity: 'warning', message: 'dup a', entryName: 'a' });
        emit(sink, { code: 'ZIP_DUPLICATE_NAME', severity: 'warning', message: 'dup a again', entryName: 'a' });
        emit(sink, { code: 'ZIP_DUPLICATE_NAME', severity: 'warning', message: 'dup b', entryName: 'b' });
        emit(sink, { code: 'ZIP_PREPENDED_DATA', severity: 'info', message: 'sfx' });
        emit(sink, { code: 'ZIP_PREPENDED_DATA', severity: 'info', message: 'sfx' });
        expect(sink.diagnostics).toEqual([
            { code: 'ZIP_DUPLICATE_NAME', severity: 'warning', message: 'dup a', entryName: 'a' },
            { code: 'ZIP_DUPLICATE_NAME', severity: 'warning', message: 'dup b', entryName: 'b' },
            { code: 'ZIP_PREPENDED_DATA', severity: 'info', message: 'sfx' },
        ]);
        expect(sink.counts).toEqual({ ZIP_DUPLICATE_NAME: 3, ZIP_PREPENDED_DATA: 2 });
        expect(sink.has('ZIP_DUPLICATE_NAME')).toBe(true);
        expect(sink.has('ZIP_MULTIPLE_EOCD')).toBe(false);
        expect(sink.truncated).toBe(false);
        const report = sink.report();
        expect(report.diagnosticCounts).toEqual(sink.counts);
        expect(report.diagnosticsTruncated).toBeUndefined();
        expect(report.diagnostics).not.toBe(sink.diagnostics);
        expect(report.diagnosticCounts).not.toBe(sink.counts);
        expect(report.diagnostics[2]).not.toHaveProperty('entryName');
    });

    it('caps the rows at MAX_DIAGNOSTICS and flags the truncation; counts stay exact', () => {
        const sink = createDiagnosticSink();
        for (let i = 0; i < MAX_DIAGNOSTICS + 50; i++) {
            emit(sink, { code: 'ZIP_NAME_MISMATCH', severity: 'warning', message: `m${i}`, entryName: `e${i}` });
        }
        expect(MAX_DIAGNOSTICS).toBe(200);
        expect(sink.diagnostics).toHaveLength(200);
        expect(sink.diagnostics[199]?.entryName).toBe('e199');
        expect(sink.truncated).toBe(true);
        expect(sink.counts['ZIP_NAME_MISMATCH']).toBe(250);
        expect(sink.report().diagnosticsTruncated).toBe(true);
        // A repeat of a kept row after the cap is neither counted twice as a row nor re-truncated.
        emit(sink, { code: 'ZIP_NAME_MISMATCH', severity: 'warning', message: 'again', entryName: 'e0' });
        expect(sink.diagnostics).toHaveLength(200);
        expect(sink.counts['ZIP_NAME_MISMATCH']).toBe(251);
    });

    it('the shared output schema lists every diagnostic code', () => {
        const description = DIAGNOSTICS_OUTPUT_PROPERTIES.diagnostics.description;
        for (const code of ZIP_DIAGNOSTIC_CODES) expect(description).toContain(code);
        expect(ZIP_DIAGNOSTIC_CODES).toHaveLength(12);
        expect(DIAGNOSTICS_OUTPUT_PROPERTIES.diagnostics.items.required).toEqual(['code', 'severity', 'message']);
        expect(DIAGNOSTICS_OUTPUT_PROPERTIES.diagnosticsTruncated.description).toContain('200');
    });
});
