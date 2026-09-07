/**
 * Tests for `draft_governance_issue` — the MCP-native Human-In-The-Loop
 * embodiment of the zipnative AI-governance contract. These tests assert the
 * server acts strictly as a DRAFTSMAN: it produces a compliant local draft plus
 * a compliance report and NEVER submits anything.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { draftGovernanceIssue } from '../src/tools/draft-governance-issue.js';
import { ToolError } from '../src/errors.js';
import { callToolDirect } from '../src/server.js';
import { ZIPNATIVE_MCP_VERSION } from '../src/version.js';

const ENV_KEY = 'ZIPNATIVE_MCP_OUTPUT_DIR';

const validInput = {
    title: 'iterateZipEntries mis-detects the descriptor of a stored entry',
    summary: 'A stored entry followed by a signed data descriptor is reported as truncated by the forward reader.',
    issueType: 'bug' as const,
    targetRepo: 'zipnative',
    reproduction: { command: "scan_zip_forward on an archive written with compression.method:'store' and stream:true", result: 'ZIP_STREAM_TRUNCATED' },
    expectedBehavior: 'The entry is read and its CRC verified.',
    affectedPackages: ['zipnative', 'zipnative-mcp'],
    duplicateSearchPerformed: true,
};

describe('draft_governance_issue', () => {
    beforeAll(() => {
        delete process.env[ENV_KEY];
    });
    afterEach(() => {
        delete process.env[ENV_KEY];
        vi.restoreAllMocks();
    });

    it('produces a compliant draft with a reproduction block and identity reminder', async () => {
        const result = await draftGovernanceIssue(validInput);
        expect(result.outputMode).toBe('inline');
        expect(result.draftMarkdown).toContain('# iterateZipEntries mis-detects the descriptor of a stored entry');
        expect(result.draftMarkdown).toContain('**Target:** zipnative');
        // Reproduction fenced block present.
        expect(/```[\s\S]*?```/.test(result.draftMarkdown)).toBe(true);
        // Identity + human gate surfaced.
        expect(result.draftMarkdown).toMatch(/GitHub identity/i);
        expect(result.draftMarkdown).toMatch(/DRAFT ONLY/i);
        expect(result.sizeBytes).toBe(Buffer.byteLength(result.draftMarkdown, 'utf8'));
        expect(result.targetRepo).toBe('zipnative');
    });

    it('defaults targetRepo to zipnative-mcp and affectedPackages to [zipnative-mcp]; actualBehavior defaults to the reproduction result', async () => {
        const { targetRepo: _t, affectedPackages: _a, ...rest } = validInput;
        void _t;
        void _a;
        const result = await draftGovernanceIssue(rest);
        expect(result.targetRepo).toBe('zipnative-mcp');
        expect(result.compliance.affectedPackages).toEqual(['zipnative-mcp']);
        expect(result.draftMarkdown).toContain('## Actual behavior\n\nZIP_STREAM_TRUNCATED');
        const explicit = await draftGovernanceIssue({ ...rest, actualBehavior: 'The scan stops at the descriptor.' });
        expect(explicit.draftMarkdown).toContain('## Actual behavior\n\nThe scan stops at the descriptor.');
    });

    it('returns a complete, honest compliance report', async () => {
        const { compliance } = await draftGovernanceIssue(validInput);
        expect(compliance.zeroDependencyConfirmed).toBe(true);
        expect(compliance.duplicateSearchPerformed).toBe(true);
        expect(compliance.identityReminderShown).toBe(true);
        expect(compliance.reproductionCommand).toBe(validInput.reproduction.command);
        expect(compliance.reproductionResult).toBe(validInput.reproduction.result);
        expect(compliance.affectedPackages).toEqual(['zipnative', 'zipnative-mcp']);
        expect(compliance.humanGate).toMatch(/never opens/i);
        expect(compliance.environment.node).toBe(process.version);
        expect(compliance.environment.zipnativeMcp).toBe(ZIPNATIVE_MCP_VERSION);
        expect(typeof compliance.environment.os).toBe('string');
    });

    it('makes NO outbound network call (fetch is never invoked)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await draftGovernanceIssue(validInput);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a draft that proposes a runtime dependency with GOVERNANCE_VIOLATION', async () => {
        await expect(
            draftGovernanceIssue({
                ...validInput,
                summary: 'We should run npm install fflate to fix this quickly.',
            }),
        ).rejects.toMatchObject({ code: 'GOVERNANCE_VIOLATION' });
    });

    it('rejects duplicateSearchPerformed=false with GOVERNANCE_VIOLATION', async () => {
        await expect(
            draftGovernanceIssue({ ...validInput, duplicateSearchPerformed: false }),
        ).rejects.toMatchObject({ code: 'GOVERNANCE_VIOLATION' });
    });

    it('rejects invalid input with VALIDATION_ERROR', async () => {
        await expect(draftGovernanceIssue({ title: 'too short' })).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
        });
        await expect(draftGovernanceIssue({ ...validInput, issueType: 'wish' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('A-017: an unknown key is refused through parseInput with the uniform "Invalid arguments:" wording', async () => {
        const err = await draftGovernanceIssue({ ...validInput, submit: true }).catch((e: unknown) => e as ToolError);
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe('VALIDATION_ERROR');
        expect((err as ToolError).message).toMatch(/^Invalid arguments: /);
        expect((err as ToolError).message).toContain('submit');
        // Same wording on the wire, and `undefined` input is treated as {} like every other tool.
        const r = await callToolDirect('draft_governance_issue', { ...validInput, githubToken: 'ghp_never' });
        expect(r.isError).toBe(true);
        expect((r.content[0] as { text: string }).text).toMatch(/^draft_governance_issue failed \[VALIDATION_ERROR\]: Invalid arguments: /);
        expect((r.content[0] as { text: string }).text).not.toContain('ghp_never');
        await expect(draftGovernanceIssue(undefined)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/^Invalid arguments: /) });
    });

    it("requires outputPath when outputMode='file' (MISSING_OUTPUT_PATH)", async () => {
        await expect(draftGovernanceIssue({ ...validInput, outputMode: 'file' })).rejects.toThrow(ToolError);
        await expect(draftGovernanceIssue({ ...validInput, outputMode: 'file' })).rejects.toMatchObject({ code: 'MISSING_OUTPUT_PATH' });
    });

    it('writes a .md draft to the sandbox when outputMode=file', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-gov-'));
        process.env[ENV_KEY] = dir;
        const result = await draftGovernanceIssue({
            ...validInput,
            outputMode: 'file',
            outputPath: 'drafts/issue.md',
        });
        expect(result.outputMode).toBe('file');
        expect(result.filePath).toBe(path.join(dir, 'drafts', 'issue.md'));
        const written = await fs.readFile(result.filePath as string, 'utf8');
        expect(written).toBe(result.draftMarkdown);
    });

    it('rejects a non-.md sandbox path with INVALID_EXTENSION', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-gov-'));
        process.env[ENV_KEY] = dir;
        await expect(
            draftGovernanceIssue({ ...validInput, outputMode: 'file', outputPath: 'issue.txt' }),
        ).rejects.toMatchObject({ code: 'INVALID_EXTENSION' });
    });

    it('rejects a path-traversal sandbox path with SECURITY_VIOLATION', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zipnative-gov-'));
        process.env[ENV_KEY] = dir;
        await expect(
            draftGovernanceIssue({ ...validInput, outputMode: 'file', outputPath: '../escape.md' }),
        ).rejects.toMatchObject({ code: 'SECURITY_VIOLATION' });
    });

    it('through the server: the result says DRAFT ONLY, carries the markdown twice (text + structured) and no resource', async () => {
        const r = await callToolDirect('draft_governance_issue', validInput);
        expect(r.isError).not.toBe(true);
        const texts = r.content.map((c) => (c as { type: string; text?: string }).text ?? '');
        expect(r.content.every((c) => c.type === 'text')).toBe(true);
        expect(texts[0]).toContain('DRAFT ONLY — not submitted');
        expect(texts[0]).toContain('under their own GitHub identity');
        expect(texts[1]).toBe((r.structuredContent as { draftMarkdown: string }).draftMarkdown);
        expect(r.structuredContent).toMatchObject({ title: validInput.title, issueType: 'bug', targetRepo: 'zipnative', outputMode: 'inline' });
        const violation = await callToolDirect('draft_governance_issue', { ...validInput, duplicateSearchPerformed: false });
        expect(violation.isError).toBe(true);
        expect((violation._meta as { error: { code: string } }).error.code).toBe('GOVERNANCE_VIOLATION');
    });
});
