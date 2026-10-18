/**
 * Backward-compatibility gate against the PUBLISHED 1.0.0 catalogue
 * (tests/_fixtures/tool-shape.v1.0.0.json, frozen at the 1.0.0 release commit
 * with every description string stripped). Within the 1.x line a release may
 * only ADD: every 1.0.0 tool, input property, enum value and bound must still
 * be accepted, no previously unbounded field may gain a bound, nothing may
 * become required, no annotation may flip. The parity gate
 * (catalogue-parity.test.ts) catches drift against the current fixture; this
 * one catches a refresh that silently narrowed the public contract. Ported
 * from pkinative-mcp 1.0.0 (the rule) onto the frozen zipnative-mcp 1.0.0
 * catalogue — the ROADMAP's "catalogue superset gate" for 1.1.0.
 *
 * Refresh the frozen fixture only when a new MAJOR is published
 * (docs/API_STABILITY.md §3).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { strip, type ToolShape } from '../scripts/lib/tool-shape.js';
import { listToolsPayload } from '../src/server.js';

type Schema = Record<string, unknown>;

const FROZEN = new URL('./_fixtures/tool-shape.v1.0.0.json', import.meta.url);
const baseline = JSON.parse(readFileSync(FROZEN, 'utf8')) as ToolShape[];
const live = new Map(listToolsPayload().tools.map((t) => [t.name, { inputSchema: strip(t.inputSchema) as Schema, outputSchema: strip(t.outputSchema) as Schema | undefined, annotations: t.annotations as Record<string, unknown> | undefined }]));

const GLOB_BOUND = (tool: string): string => `${tool}.in.properties.filter.properties.glob.items: maxLength introduced (1024)`;

/**
 * Deliberate, reviewed deltas that are not pure additions — every one a 1.1.0
 * SECURITY tightening, justified in docs/API_STABILITY.md §5 and in the
 * release note's compatibility ledger. Anything else is a failure.
 */
const ACCEPTED_DELTAS = new Set<string>([
    // A fields path may no longer name a prototype segment (__proto__ / constructor / prototype): the
    // projection never resolved one to data, so no working call is refused (prototype-pollution hardening).
    ...['inspect_zip', 'list_zip_entries', 'read_zip_entry', 'verify_zip', 'extract_zip', 'scan_zip_forward', 'sanitize_entry_paths', 'describe_engine'].map((t) => `${t}.in.properties.fields.items: pattern introduced`),
    // A glob is matched in linear time and bounded at 1 024 characters (CWE-1333): a longer pattern than any
    // legal entry name (maxNameBytes 4 096) is the only input refused.
    ...['list_zip_entries', 'extract_zip', 'scan_zip_forward'].map(GLOB_BOUND),
    // The free-text fields of a governance draft are bounded at 16 384 characters (the policy scan is linear,
    // the bound keeps a draft reviewable).
    ...['summary', 'expectedBehavior', 'actualBehavior'].map((p) => `draft_governance_issue.in.properties.${p}: maxLength introduced (16384)`),
    ...['command', 'result'].map((p) => `draft_governance_issue.in.properties.reproduction.properties.${p}: maxLength introduced (16384)`),
]);

const UPPER_BOUNDS = ['maxLength', 'maximum', 'maxItems', 'exclusiveMaximum', 'maxProperties'];
const LOWER_BOUNDS = ['minLength', 'minimum', 'minItems', 'exclusiveMinimum', 'minProperties'];

/** Walk the old schema and assert the new one still accepts everything it accepted. */
export function assertSuperset(oldS: Schema, newS: Schema | undefined, at: string, issues: string[]): void {
    if (newS === undefined) {
        issues.push(`${at}: removed`);
        return;
    }
    if (oldS['oneOf'] === undefined && oldS['anyOf'] === undefined && newS['type'] === undefined && Array.isArray(newS['anyOf'])) {
        const covers = (newS['anyOf'] as Schema[]).some((member) => {
            const sub: string[] = [];
            assertSuperset(oldS, member, at, sub);
            return sub.length === 0;
        });
        issues.push(covers ? `${at}: widened to anyOf` : `${at}: replaced by an anyOf with no member accepting the 1.0.0 schema`);
        return;
    }
    if (oldS['type'] !== undefined && JSON.stringify(oldS['type']) !== JSON.stringify(newS['type'])) {
        const oldT = ([] as unknown[]).concat(oldS['type'] as unknown[]);
        const newT = ([] as unknown[]).concat(newS['type'] as unknown[]);
        if (!oldT.every((t) => newT.includes(t))) issues.push(`${at}: type ${JSON.stringify(oldS['type'])} -> ${JSON.stringify(newS['type'])}`);
    }
    if (Array.isArray(oldS['enum'])) {
        const newEnum = Array.isArray(newS['enum']) ? (newS['enum'] as unknown[]) : null;
        if (newEnum === null) issues.push(`${at}: enum removed`);
        else for (const v of oldS['enum'] as unknown[]) if (!newEnum.some((n) => JSON.stringify(n) === JSON.stringify(v))) issues.push(`${at}: enum value ${JSON.stringify(v)} removed`);
    }
    if (oldS['const'] !== undefined && JSON.stringify(oldS['const']) !== JSON.stringify(newS['const'])) issues.push(`${at}: const changed`);
    if (oldS['default'] !== undefined && JSON.stringify(oldS['default']) !== JSON.stringify(newS['default'])) issues.push(`${at}: default ${JSON.stringify(oldS['default'])} -> ${JSON.stringify(newS['default'])}`);
    for (const k of UPPER_BOUNDS) {
        const o = oldS[k] as number | undefined;
        const n = newS[k] as number | undefined;
        if (o === undefined && n !== undefined) issues.push(`${at}: ${k} introduced (${n})`);
        else if (o !== undefined && n !== undefined && n < o) issues.push(`${at}: ${k} tightened ${o} -> ${n}`);
    }
    for (const k of LOWER_BOUNDS) {
        const o = oldS[k] as number | undefined;
        const n = newS[k] as number | undefined;
        if (o === undefined && n !== undefined) issues.push(`${at}: ${k} introduced (${n})`);
        else if (o !== undefined && n !== undefined && n > o) issues.push(`${at}: ${k} tightened ${o} -> ${n}`);
    }
    if (oldS['pattern'] === undefined && newS['pattern'] !== undefined) issues.push(`${at}: pattern introduced`);
    else if (oldS['pattern'] !== undefined && newS['pattern'] !== oldS['pattern']) issues.push(`${at}: pattern changed`);
    if (Array.isArray(newS['required'])) {
        const oldReq = Array.isArray(oldS['required']) ? (oldS['required'] as string[]) : [];
        for (const r of newS['required'] as string[]) if (!oldReq.includes(r)) issues.push(`${at}: '${r}' became required`);
    } else if (Array.isArray(oldS['required'])) {
        issues.push(`${at}: required removed`);
    }
    if (oldS['additionalProperties'] === false && newS['additionalProperties'] !== false) issues.push(`${at}: additionalProperties loosened`);
    const oldProps = (oldS['properties'] ?? {}) as Record<string, Schema>;
    const newProps = (newS['properties'] ?? {}) as Record<string, Schema>;
    for (const [k, v] of Object.entries(oldProps)) assertSuperset(v, newProps[k], `${at}.properties.${k}`, issues);
    if (oldS['items'] !== undefined && typeof oldS['items'] === 'object') assertSuperset(oldS['items'] as Schema, newS['items'] as Schema | undefined, `${at}.items`, issues);
    for (const comb of ['oneOf', 'anyOf'] as const) {
        if (!Array.isArray(oldS[comb])) continue;
        const newList = (newS[comb] ?? newS[comb === 'oneOf' ? 'anyOf' : 'oneOf']) as Schema[] | undefined;
        if (newS[comb] === undefined && newList !== undefined) issues.push(`${at}: ${comb} -> ${comb === 'oneOf' ? 'anyOf' : 'oneOf'}`);
        if (newList === undefined) {
            issues.push(`${at}: ${comb} removed`);
            continue;
        }
        (oldS[comb] as Schema[]).forEach((member, i) => assertSuperset(member, newList[i], `${at}.${comb}[${i}]`, issues));
    }
}

function issuesOf(old: ToolShape): string[] {
    const current = live.get(old.name);
    if (current === undefined) return [`${old.name}: removed`];
    const issues: string[] = [];
    assertSuperset(old.inputSchema as Schema, current.inputSchema, `${old.name}.in`, issues);
    if (old.outputSchema !== undefined) assertSuperset(old.outputSchema as Schema, current.outputSchema, `${old.name}.out`, issues);
    for (const [k, v] of Object.entries((old.annotations ?? {}) as Record<string, unknown>)) {
        if (current.annotations?.[k] !== v) issues.push(`${old.name}.annotations.${k}: ${String(v)} -> ${String(current.annotations?.[k])}`);
    }
    return issues;
}

describe('tools/list is a superset of the published 1.0.0 catalogue', () => {
    it('the frozen catalogue holds the 13 tools of 1.0.0 and every one still exists', () => {
        expect(baseline).toHaveLength(13);
        for (const old of baseline) expect(live.has(old.name), `${old.name} still exists`).toBe(true);
    });

    for (const old of baseline) {
        it(`${old.name}: every 1.0.0 input is still accepted, nothing narrowed, the output only grew, no annotation flipped`, () => {
            expect(issuesOf(old).filter((i) => !ACCEPTED_DELTAS.has(i))).toEqual([]);
        });
    }

    it('no accepted delta is stale (each one still occurs)', () => {
        const seen = new Set(baseline.flatMap(issuesOf));
        expect([...ACCEPTED_DELTAS].filter((d) => !seen.has(d))).toEqual([]);
    });
});

describe('the superset rule itself', () => {
    it('reports a removed enum value, a tightened bound, a new required member, a new pattern and a narrowed union', () => {
        const issues: string[] = [];
        assertSuperset({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', enum: ['x', 'y'], maxLength: 8 }, b: { type: 'integer' }, c: { type: 'string' } } }, { type: 'object', additionalProperties: false, required: ['b'], properties: { a: { type: 'string', enum: ['x'], maxLength: 4 }, b: { type: 'integer', minimum: 1 }, c: { type: 'string', pattern: '^x' } } }, 't.in', issues);
        expect(issues).toEqual(["t.in: 'b' became required", 't.in.properties.a: enum value "y" removed', 't.in.properties.a: maxLength tightened 8 -> 4', 't.in.properties.b: minimum introduced (1)', 't.in.properties.c: pattern introduced']);
        const union: string[] = [];
        assertSuperset({ type: 'string', pattern: '^[0-9a-f]+$' }, { anyOf: [{ type: 'string', pattern: '^[0-9]+$' }, { type: 'array' }] }, 'x', union);
        expect(union).toEqual(['x: replaced by an anyOf with no member accepting the 1.0.0 schema']);
    });

    it('accepts pure additions: a new optional property, a new enum value, a loosened bound', () => {
        const issues: string[] = [];
        assertSuperset({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', enum: ['x'], maxLength: 4 } } }, { type: 'object', additionalProperties: false, properties: { a: { type: 'string', enum: ['x', 'y'], maxLength: 8 }, c: { type: 'boolean' } } }, 't.in', issues);
        expect(issues).toEqual([]);
    });
});
