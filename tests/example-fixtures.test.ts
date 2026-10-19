/**
 * The frozen inputs of the published examples (tests/fixtures/examples/) and
 * the foreign-tool archives (tests/fixtures/interop/) are pinned by
 * tests/fixtures/SHA256SUMS, and the example inputs are the bytes the
 * builders of tests/_zip-fixtures.ts produce — the two resolutions of the
 * placeholder vocabulary (scripts/helpers/io.ts for the sample generator,
 * tests/examples.test.ts for the suite) can therefore never drift apart.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_FIXTURES, SANDBOX_FILES, fixtureBytes } from '../scripts/helpers/io.js';
import { basicZip, richZip, truncated, ZIP_SLIP } from './_zip-fixtures.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function sums(): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of readFileSync(path.join(FIXTURES, 'SHA256SUMS'), 'utf8').split('\n')) {
        const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
        if (m !== null) out.set(m[2]!, m[1]!);
    }
    return out;
}

describe('tests/fixtures/SHA256SUMS', () => {
    it('pins every committed fixture file, and only those', () => {
        const listed = sums();
        const onDisk = ['examples', 'interop'].flatMap((dir) => readdirSync(path.join(FIXTURES, dir)).map((f) => `${dir}/${f}`)).sort();
        expect([...listed.keys()].sort()).toEqual(onDisk);
        for (const [rel, hash] of listed) {
            expect(createHash('sha256').update(readFileSync(path.join(FIXTURES, ...rel.split('/')))).digest('hex'), rel).toBe(hash);
        }
    });

    it('every placeholder and every sandbox file names a pinned example fixture', () => {
        const listed = sums();
        for (const name of [...Object.values(PLACEHOLDER_FIXTURES), ...Object.values(SANDBOX_FILES)]) {
            expect(listed.has(`examples/${name}`), name).toBe(true);
        }
    });
});

describe('the example fixtures are the builders\' bytes', () => {
    const builders: Readonly<Record<string, () => Uint8Array>> = {
        'zip-base64': () => basicZip(),
        'rich-zip-base64': () => richZip(),
        'truncated-zip-base64': () => truncated(basicZip(), 60),
        'hostile-zip-slip-base64': () => ZIP_SLIP(),
        'raw-deflate-base64': () => deflateRawSync(Buffer.from('hello hello hello')),
    };

    it('covers the whole placeholder vocabulary', () => {
        expect(Object.keys(builders).sort()).toEqual(Object.keys(PLACEHOLDER_FIXTURES).sort());
    });

    for (const [token, build] of Object.entries(builders)) {
        it(`<${token}>`, () => {
            expect(Buffer.from(build()).equals(fixtureBytes(PLACEHOLDER_FIXTURES[token]!))).toBe(true);
        });
    }
});
