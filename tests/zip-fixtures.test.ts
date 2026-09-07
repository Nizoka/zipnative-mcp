import { describe, it, expect } from 'vitest';
import { basicZip, richZip, ZIP_SLIP, OVERLAP, CD_MISMATCH, DECLARED_BOMB, LFH_NAME_MISMATCH, incrementalZip, streamedZip, DEVICE_NAME, DUPLICATE_PATHS, SYMLINK, SFX_PREFIXED } from './_zip-fixtures.js';
import { assertValidZip, assertIsoConformant, expectCheck } from './_zip-assert.js';
describe('fixtures', () => {
    it('benign fixtures are valid + ISO conformant', async () => {
        assertValidZip(basicZip(), 'basic');
        assertValidZip(richZip(), 'rich');
        assertValidZip(await streamedZip(), 'streamed');
        const inc = incrementalZip();
        assertValidZip(inc.appended, 'appended');
        assertValidZip(inc.compacted, 'compacted');
        assertIsoConformant(ZIP_SLIP(), 'zip-slip');
        assertIsoConformant(DEVICE_NAME(), 'device');
        assertIsoConformant(DUPLICATE_PATHS(), 'dup');
        assertIsoConformant(SYMLINK(), 'symlink');
        assertIsoConformant(SFX_PREFIXED(), 'sfx');
    });
    it('negatives fail with the declared check', () => {
        expectCheck(OVERLAP(), 'WF/ENTRY-OVERLAP');
        expectCheck(CD_MISMATCH(), 'WF/CD-COUNT');
        expectCheck(DECLARED_BOMB(), 'WF/LFH-SIZE-MISMATCH');
        expectCheck(LFH_NAME_MISMATCH(), 'WF/LFH-NAME-MISMATCH');
        expect(true).toBe(true);
    });
});
