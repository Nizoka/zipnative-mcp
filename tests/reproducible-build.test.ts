/**
 * Reproducible output, proven on the BUILT server across time zones (ported
 * from pkinative-mcp A2-008 onto the ZIP timestamp problem).
 *
 * A ZIP stores MS-DOS date/time fields with no zone. zipnative 1.0.0 wrote and
 * read them in the HOST's zone, so a pinned `create_zip` call produced
 * different bytes in Paris and on a UTC runner (measured on the 1.0.0 tree:
 * four zones, four archives) while the response cache treated them as one.
 * 1.1.0 passes `dosTimeMode: 'utc'` on every engine call. Unit tests cannot
 * show the effect: vitest pins TZ=UTC for the whole run. This suite spawns
 * `dist/cli.js` under two real zones, 23 hours apart and on opposite sides of
 * the date line — Pacific/Kiritimati (UTC+14) and America/Anchorage (UTC-8 in
 * June) — drives the same pinned calls through each, and compares the bytes
 * with each other, with the in-process UTC call and with what 1.0.0 wrote
 * under UTC.
 *
 * Requires `npm run build`; skipped locally when dist/ is absent, and a hard
 * failure under CI.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { callToolDirect } from '../src/server.js';
import { expectCleanStdioExit, hasDist, inCi, openAgent, type AgentCallToolResult } from './_agent-client.js';
import { assertValidZip } from './_zip-assert.js';

const ZONES = ['Pacific/Kiritimati', 'America/Anchorage'] as const;
const INSTANT = '2024-06-01T12:34:56Z';
/** `getTimezoneOffset()` of INSTANT under each zone (minutes behind UTC): proves the child really ran under it. */
const OFFSETS: Readonly<Record<(typeof ZONES)[number], number>> = { 'Pacific/Kiritimati': -840, 'America/Anchorage': 480 };

/** Three spellings of a date: a UTC instant, an offset instant, and an offset-less wall clock. */
const CREATE = {
    entries: [
        { name: 'utc.txt', text: 'u', date: INSTANT },
        { name: 'offset.txt', text: 'o', date: '2024-06-01T14:34:56+02:00' },
        { name: 'wall.txt', text: 'w', date: '2024-06-01T12:34:56' },
    ],
};
/** The 1.0.0 baseline under TZ=UTC: create_zip { a.txt, 'a', date: INSTANT } (scratch probe of 2026-10-18 on commit 144af6d). */
const SINGLE = { entries: [{ name: 'a.txt', text: 'a', date: INSTANT }] };
const SINGLE_SHA256_PREFIX_UNDER_UTC_1_0_0 = '019548d7fb0d676a';

function blobOf(result: AgentCallToolResult): Buffer {
    expect(result.isError, (result.content[0] as { text?: string } | undefined)?.text).not.toBe(true);
    const block = result.content.find((c) => c.type === 'resource') as { resource?: { blob?: string } } | undefined;
    expect(block?.resource?.blob, 'an embedded resource blob').toBeTypeOf('string');
    return Buffer.from(block!.resource!.blob!, 'base64');
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface Produced {
    readonly archive: Buffer;
    readonly single: Buffer;
    readonly lastModified: readonly string[];
}

async function produceUnder(zone: (typeof ZONES)[number]): Promise<Produced> {
    const client = await openAgent('stdio-legacy', { env: { TZ: zone } });
    try {
        const archive = blobOf(await client.callTool('create_zip', CREATE));
        const single = blobOf(await client.callTool('create_zip', SINGLE));
        const listed = await client.callTool('list_zip_entries', { zipBase64: archive.toString('base64'), fields: ['entries.name', 'entries.lastModified'] });
        const entries = (listed.structuredContent as { entries: Array<{ name: string; lastModified: string }> }).entries;
        return { archive, single, lastModified: entries.map((e) => `${e.name}=${e.lastModified}`) };
    } finally {
        expectCleanStdioExit(await client.close());
    }
}

describe('dist/cli.js presence (reproducible-build)', () => {
    it.runIf(inCi)('is built before the test run in CI (build must precede test in every workflow)', () => {
        expect(hasDist, 'dist/cli.js is missing under CI — run `npm run build` before `npm test`').toBe(true);
    });
});

describe('the host honours TZ for a child process', () => {
    it.each(ZONES)('a Node child under TZ=%s renders the instant with that zone\'s offset', (zone) => {
        const probe = spawnSync(process.execPath, ['-p', `new Date(${JSON.stringify(INSTANT)}).getTimezoneOffset()`], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
        expect(probe.status).toBe(0);
        expect(Number(probe.stdout.trim())).toBe(OFFSETS[zone]);
    });
});

describe.skipIf(!hasDist)('the built server writes and reads the same DOS fields under every time zone', () => {
    it('pinned create_zip calls are byte-identical under Pacific/Kiritimati and America/Anchorage, equal the in-process UTC call, and equal the 1.0.0 UTC bytes', async () => {
        const [kiritimati, anchorage] = await Promise.all(ZONES.map(produceUnder));
        assertValidZip(new Uint8Array(kiritimati!.archive), 'kiritimati');
        expect(kiritimati!.archive.equals(anchorage!.archive), 'archive bytes differ between the two zones').toBe(true);
        expect(kiritimati!.single.equals(anchorage!.single)).toBe(true);

        const inProcess = blobOf((await callToolDirect('create_zip', CREATE)) as AgentCallToolResult);
        expect(inProcess.equals(kiritimati!.archive), 'the in-process UTC call differs').toBe(true);
        // 1.0.0 wrote exactly these bytes under TZ=UTC — and different ones under every other zone.
        expect(sha256(kiritimati!.single).startsWith(SINGLE_SHA256_PREFIX_UNDER_UTC_1_0_0)).toBe(true);

        // Read back as the same UTC instants: the offset instant is converted, the wall clock is taken as UTC.
        const expected = ['offset.txt=2024-06-01T12:34:56.000Z', 'utc.txt=2024-06-01T12:34:56.000Z', 'wall.txt=2024-06-01T12:34:56.000Z'];
        expect([...kiritimati!.lastModified].sort()).toEqual(expected);
        expect([...anchorage!.lastModified].sort()).toEqual(expected);
    }, 90_000);
});
