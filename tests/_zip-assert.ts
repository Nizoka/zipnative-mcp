/**
 * Structural assertions every archive produced by a tool test must pass:
 * the PK magic, an eager open by the engine, a clean `verifyZip` report and
 * ISO/IEC 21320-1 conformance by the vendored veraZIP core (an independent
 * raw parser that never imports the engine — so the engine is not attesting
 * itself).
 */
import { expect } from 'vitest';
import { openZip, verifyZip } from 'zipnative';

import { validateArchive, type ArchiveReport } from '../scripts/verazip-core.mjs';

export { validateArchive, CHECK_IDS, REQUIRED_NEGATIVE_CHECKS } from '../scripts/verazip-core.mjs';

export function toBytes(input: Uint8Array | string): Uint8Array {
    return typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'base64')) : input;
}

/** Throws (with every finding listed) unless the bytes are ISO/IEC 21320-1 conformant. */
export function assertIsoConformant(input: Uint8Array | string, label = 'archive'): ArchiveReport {
    const report = validateArchive(toBytes(input), label);
    const lines = report.failures.map((f) => `${f.check}: ${f.detail}`);
    expect(lines, `${label} is not ISO/IEC 21320-1 conformant`).toEqual([]);
    return report;
}

/** Asserts a declared negative canary fails with the expected check id. */
export function expectCheck(input: Uint8Array | string, checkId: string, label = 'archive'): ArchiveReport {
    const report = validateArchive(toBytes(input), label);
    expect(report.failures.map((f) => f.check), `${label} should fail ${checkId}`).toContain(checkId);
    return report;
}

/** Full validity: magic + eager engine open + verifyZip ok + ISO conformance. */
export function assertValidZip(input: Uint8Array | string, label = 'archive'): void {
    const bytes = toBytes(input);
    expect(bytes.length, `${label}: too short to be a ZIP`).toBeGreaterThanOrEqual(22);
    expect([bytes[0], bytes[1]], `${label}: PK magic`).toEqual([0x50, 0x4b]);
    const reader = openZip(bytes, { validate: 'eager', onDiagnostic: () => undefined });
    expect(reader.entryCount).toBeGreaterThanOrEqual(0);
    const report = verifyZip(bytes);
    expect(report.error, `${label}: verifyZip structural error`).toBeNull();
    expect(report.ok, `${label}: verifyZip not ok`).toBe(true);
    assertIsoConformant(bytes, label);
}
