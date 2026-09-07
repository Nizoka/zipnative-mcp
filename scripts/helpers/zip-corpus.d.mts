/** Hand-written types for scripts/helpers/zip-corpus.mjs (the veraZIP corpus definition). */

/** The minimal CallToolResult shape the corpus reads (mirrors the MCP SDK type). */
export interface CorpusToolResult {
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly uri?: string; readonly resource?: { readonly blob?: string } }>;
    readonly structuredContent?: Record<string, unknown>;
    readonly isError?: boolean;
    readonly _meta?: Record<string, unknown>;
}

export type CorpusCall = (tool: string, args: unknown) => Promise<CorpusToolResult>;

export interface CorpusRefusal {
    readonly tool: string;
    readonly code: string;
    readonly arguments?: Record<string, unknown>;
}

export interface CorpusContext {
    readonly call: CorpusCall;
    readonly sandboxDir: string | null;
    get(file: string): Uint8Array;
    set(file: string, bytes: Uint8Array, result?: CorpusToolResult): void;
    resultOf(file: string): CorpusToolResult;
    sandboxFile(relative: string, data: Uint8Array): Promise<string>;
}

export interface CorpusEntry {
    readonly file: string;
    readonly producedBy: 'tool' | 'crafted' | 'tool+crafted';
    readonly tool: string | null;
    readonly arguments: Record<string, unknown> | null;
    readonly expectConformant: boolean;
    readonly expectedCheck: string | null;
    readonly refusedBy: CorpusRefusal | null;
    readonly integrityExclude: readonly string[];
    readonly prefixed: boolean;
    readonly note: string;
    readonly scriptOnly: boolean;
    readonly verifyArguments: Record<string, unknown>;
    produce(ctx: CorpusContext, entry: CorpusEntry): Promise<Uint8Array | { bytes: Uint8Array; result: CorpusToolResult }> | Uint8Array;
    after?(bytes: Uint8Array, ctx: CorpusContext): Promise<void> | void;
}

export interface CorpusCounts {
    readonly conformant: number;
    readonly nonConformant: number;
    readonly hostileConformant: number;
}

export function buildCorpus(options: { call: CorpusCall; sandboxDir: string | null }): CorpusEntry[];
export function corpusCounts(entries: readonly CorpusEntry[]): CorpusCounts;
export function createContext(options: { call: CorpusCall; sandboxDir: string | null }): CorpusContext;
export function produceEntry(entry: CorpusEntry, ctx: CorpusContext): Promise<Uint8Array>;
export function assertVerified(entry: CorpusEntry, bytes: Uint8Array, ctx: CorpusContext): Promise<Record<string, unknown>>;
export function assertRefused(entry: CorpusEntry, bytes: Uint8Array, ctx: CorpusContext): Promise<{ tool: string; code: string; text: string }>;
