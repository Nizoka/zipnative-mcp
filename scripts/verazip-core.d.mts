/** Hand-written types for scripts/verazip-core.mjs (the vendored ISO/IEC 21320-1 validator core). */
export interface Finding {
    readonly check: string;
    readonly detail: string;
}
export interface ArchiveReport {
    readonly file: string;
    readonly entries: number;
    readonly failures: Finding[];
    readonly notes: string[];
}
export function validateArchive(bytes: Uint8Array, file: string): ArchiveReport;
export const CHECK_IDS: readonly string[];
export const REQUIRED_NEGATIVE_CHECKS: readonly string[];
