/**
 * Tool: draft_governance_issue
 *
 * Produces a LOCAL, governance-compliant GitHub issue draft plus a structured
 * compliance report — and never submits anything. This is the MCP-native
 * embodiment of the zipnative AI-governance / Human-In-The-Loop (HITL) contract
 * (`.github/ai-governance.json`, `.github/AGENT_RULES.md`): the agent is a
 * DRAFTSMAN, the human is the only gate.
 *
 * Guarantees (by construction, not by policy alone):
 *   - No outbound network call. No GitHub API. No filesystem access outside the
 *     opt-in sandbox (`ZIPNATIVE_MCP_OUTPUT_DIR`) when `outputMode='file'`.
 *   - The assembled draft is validated against the zero-dependency + reproduction
 *     policy; a violation throws `GOVERNANCE_VIOLATION` so the human must fix the
 *     draft before they submit it under their own identity.
 *   - An identity reminder and the human-gate statement are always included.
 */
import os from 'node:os';
import { z } from 'zod';

import { GovernanceError, ToolError } from '../errors.js';
import {
    HUMAN_GATE,
    IDENTITY_REMINDER,
    validateIssueMarkdown,
} from '../governance.js';
import { writeSandboxedText } from '../output.js';
import { ZIPNATIVE_MCP_VERSION } from '../version.js';

export const DRAFT_GOVERNANCE_ISSUE_NAME = 'draft_governance_issue';

const ISSUE_TYPES = ['bug', 'feature', 'security', 'docs', 'performance'] as const;
type IssueType = (typeof ISSUE_TYPES)[number];

export const DRAFT_GOVERNANCE_ISSUE_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'summary', 'issueType', 'reproduction', 'expectedBehavior', 'duplicateSearchPerformed'],
    properties: {
        title: {
            type: 'string',
            minLength: 8,
            maxLength: 160,
            description: 'Concise issue title (imperative, no trailing period).',
        },
        summary: {
            type: 'string',
            minLength: 16,
            description: 'One or two paragraphs describing the problem or proposal.',
        },
        issueType: {
            type: 'string',
            enum: [...ISSUE_TYPES],
            description: "Issue category: 'bug' | 'feature' | 'security' | 'docs' | 'performance'.",
        },
        targetRepo: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            default: 'zipnative-mcp',
            description:
                "Destination repository label for the draft (documentation only — the server never contacts it). 'zipnative-mcp' (wrapper: schemas, sandbox, transport) or 'zipnative' (engine: parser, writer, limits, codecs).",
        },
        reproduction: {
            type: 'object',
            additionalProperties: false,
            required: ['command', 'result'],
            description: 'The minimal, locally-executed reproduction that justifies this issue.',
            properties: {
                command: {
                    type: 'string',
                    minLength: 1,
                    description: 'The exact command or MCP tool call you ran.',
                },
                result: {
                    type: 'string',
                    minLength: 1,
                    description: 'The observed failure, error, or regression.',
                },
            },
        },
        expectedBehavior: {
            type: 'string',
            minLength: 4,
            description: 'What you expected to happen instead.',
        },
        actualBehavior: {
            type: 'string',
            description: "What actually happened (defaults to the reproduction result when omitted).",
        },
        affectedPackages: {
            type: 'array',
            maxItems: 16,
            default: ['zipnative-mcp'],
            items: { type: 'string', minLength: 1 },
            description: 'Packages impacted by this issue (e.g. ["zipnative-mcp"], ["zipnative"]).',
        },
        duplicateSearchPerformed: {
            type: 'boolean',
            description:
                'MUST be true: confirms you searched open AND closed issues/PRs for duplicates before drafting.',
        },
        outputMode: {
            type: 'string',
            enum: ['inline', 'file'],
            default: 'inline',
            description:
                "'inline' (default) returns the draft markdown in the response. 'file' additionally writes it to the sandbox (requires ZIPNATIVE_MCP_OUTPUT_DIR); outputPath must be a relative .md path.",
        },
        outputPath: {
            type: 'string',
            description: "Relative .md path inside the sandbox (only when outputMode='file').",
        },
    },
} as const;

export const DRAFT_GOVERNANCE_ISSUE_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'issueType', 'targetRepo', 'outputMode', 'sizeBytes', 'draftMarkdown', 'warnings', 'compliance'],
    description:
        'A local, unsubmitted issue draft plus its compliance report. The server NEVER opens the issue — a human must review and submit it.',
    properties: {
        title: { type: 'string' },
        issueType: { type: 'string', enum: [...ISSUE_TYPES] },
        targetRepo: { type: 'string' },
        outputMode: { type: 'string', enum: ['inline', 'file'] },
        filePath: { type: 'string', description: "Sandboxed absolute path (when outputMode='file')." },
        sizeBytes: { type: 'integer', minimum: 0 },
        draftMarkdown: { type: 'string', description: 'The full draft, ready for a human to review and submit.' },
        warnings: { type: 'array', items: { type: 'string' } },
        compliance: {
            type: 'object',
            additionalProperties: false,
            required: [
                'zeroDependencyConfirmed',
                'reproductionCommand',
                'reproductionResult',
                'duplicateSearchPerformed',
                'affectedPackages',
                'identityReminderShown',
                'humanGate',
                'environment',
            ],
            properties: {
                zeroDependencyConfirmed: { type: 'boolean' },
                reproductionCommand: { type: 'string' },
                reproductionResult: { type: 'string' },
                duplicateSearchPerformed: { type: 'boolean' },
                affectedPackages: { type: 'array', items: { type: 'string' } },
                identityReminderShown: { type: 'boolean' },
                humanGate: { type: 'string' },
                environment: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['node', 'os', 'zipnativeMcp'],
                    properties: {
                        node: { type: 'string' },
                        os: { type: 'string' },
                        zipnativeMcp: { type: 'string' },
                    },
                },
            },
        },
    },
} as const;

const InputSchema = z.strictObject({
    title: z.string().min(8).max(160),
    summary: z.string().min(16),
    issueType: z.enum(ISSUE_TYPES),
    targetRepo: z.string().min(1).max(100).default('zipnative-mcp'),
    reproduction: z.strictObject({
        command: z.string().min(1),
        result: z.string().min(1),
    }),
    expectedBehavior: z.string().min(4),
    actualBehavior: z.string().optional(),
    affectedPackages: z.array(z.string().min(1)).max(16).default(['zipnative-mcp']),
    duplicateSearchPerformed: z.boolean(),
    outputMode: z.enum(['inline', 'file']).default('inline'),
    outputPath: z.string().optional(),
});

export interface ComplianceReport {
    readonly zeroDependencyConfirmed: boolean;
    readonly reproductionCommand: string;
    readonly reproductionResult: string;
    readonly duplicateSearchPerformed: boolean;
    readonly affectedPackages: readonly string[];
    readonly identityReminderShown: boolean;
    readonly humanGate: string;
    readonly environment: { readonly node: string; readonly os: string; readonly zipnativeMcp: string };
}

export interface DraftGovernanceIssueResult {
    readonly title: string;
    readonly issueType: IssueType;
    readonly targetRepo: string;
    readonly outputMode: 'inline' | 'file';
    readonly filePath?: string;
    readonly sizeBytes: number;
    readonly draftMarkdown: string;
    readonly warnings: readonly string[];
    readonly compliance: ComplianceReport;
}

/** Assemble the governance-compliant issue markdown. */
function buildDraftMarkdown(
    input: z.infer<typeof InputSchema>,
    environment: ComplianceReport['environment'],
): string {
    const actual = input.actualBehavior ?? input.reproduction.result;
    const lines: string[] = [
        `# ${input.title}`,
        '',
        `> **Type:** ${input.issueType} · **Target:** ${input.targetRepo}`,
        '',
        '## Summary',
        '',
        input.summary,
        '',
        '## Minimal reproduction',
        '',
        'Command / tool call:',
        '',
        '```',
        input.reproduction.command,
        '```',
        '',
        'Result:',
        '',
        '```',
        input.reproduction.result,
        '```',
        '',
        '## Expected behavior',
        '',
        input.expectedBehavior,
        '',
        '## Actual behavior',
        '',
        actual,
        '',
        '## Environment',
        '',
        `- Node: ${environment.node}`,
        `- OS: ${environment.os}`,
        `- zipnative-mcp: ${environment.zipnativeMcp}`,
        `- Affected packages: ${input.affectedPackages.join(', ')}`,
        '',
        '## Compliance',
        '',
        '- [x] Zero new runtime dependency proposed',
        `- [${input.duplicateSearchPerformed ? 'x' : ' '}] Searched open and closed issues/PRs for duplicates`,
        '- [x] Minimal reproduction executed locally',
        '- [x] Expected vs actual documented',
        '',
        '---',
        '',
        `> ${IDENTITY_REMINDER}`,
        '',
        `> ${HUMAN_GATE}`,
        '',
    ];
    return lines.join('\n');
}

export async function draftGovernanceIssue(rawInput: unknown): Promise<DraftGovernanceIssueResult> {
    const parsed = InputSchema.safeParse(rawInput);
    if (!parsed.success) {
        throw new ToolError('VALIDATION_ERROR', `Invalid arguments: ${parsed.error.message}`);
    }
    const input = parsed.data;

    if (!input.duplicateSearchPerformed) {
        throw new GovernanceError(
            'duplicateSearchPerformed must be true — search open AND closed issues/PRs for duplicates before drafting.',
        );
    }

    if (input.outputMode === 'file' && input.outputPath === undefined) {
        throw new ToolError('MISSING_OUTPUT_PATH', "outputPath is required when outputMode='file'.");
    }

    const environment: ComplianceReport['environment'] = {
        node: process.version,
        os: `${process.platform} ${os.release()}`,
        zipnativeMcp: ZIPNATIVE_MCP_VERSION,
    };

    const draftMarkdown = buildDraftMarkdown(input, environment);

    // Validate the assembled draft against the governance policy. A dependency
    // proposal or a missing reproduction block is a hard blocker.
    const validation = validateIssueMarkdown(draftMarkdown);
    if (!validation.ok) {
        throw new GovernanceError(
            `Draft violates the AI-governance contract: ${validation.errors.join(' ')} Fix the draft before it can be reviewed for submission.`,
        );
    }

    const compliance: ComplianceReport = {
        zeroDependencyConfirmed: true,
        reproductionCommand: input.reproduction.command,
        reproductionResult: input.reproduction.result,
        duplicateSearchPerformed: input.duplicateSearchPerformed,
        affectedPackages: input.affectedPackages,
        identityReminderShown: true,
        humanGate: HUMAN_GATE,
        environment,
    };

    const sizeBytes = Buffer.byteLength(draftMarkdown, 'utf8');

    if (input.outputMode === 'file') {
        const { filePath } = await writeSandboxedText(draftMarkdown, input.outputPath as string, '.md');
        return {
            title: input.title,
            issueType: input.issueType,
            targetRepo: input.targetRepo,
            outputMode: 'file',
            filePath,
            sizeBytes,
            draftMarkdown,
            warnings: validation.warnings,
            compliance,
        };
    }

    return {
        title: input.title,
        issueType: input.issueType,
        targetRepo: input.targetRepo,
        outputMode: 'inline',
        sizeBytes,
        draftMarkdown,
        warnings: validation.warnings,
        compliance,
    };
}
