/**
 * The per-call context a `tools/call` request carries into a tool: the MCP
 * cancellation signal and, when the client asked for it, a progress sink.
 *
 * zipnative 1.1.0 takes `signal` and `onProgress` on the engine calls that
 * accept `ZipCommonOptions` (not `verifyZip`, which is synchronous), so the
 * tools hand both to the engine through their diagnostic sink
 * (src/diagnostics.ts), and the wrapper's own loops (compute_crc32,
 * inflate_raw, merge_zip, the verify_zip start) check the signal themselves: an aborted request stops the engine between chunks and releases what
 * it held (stream locks, worker pools, partial output files), and the
 * progress snapshots become `notifications/progress` — only when the request
 * carries a `_meta.progressToken`, never otherwise. A cancelled call is the
 * wrapper code `CANCELLED`; nothing about it is ever cached.
 */
import type { ZipProgress } from 'zipnative';

import { ToolError } from './errors.js';

export interface CallContext {
    /** Aborted when the client cancels the request (or the HTTP client goes away). */
    readonly signal?: AbortSignal;
    /** Receives the engine's monotonic progress snapshots. */
    readonly onProgress?: (progress: ZipProgress) => void;
}

/** The context of a call made outside a request (tests, the corpus generator, library use). */
export const NO_CONTEXT: CallContext = Object.freeze({});

/** The wrapper error for a cancelled call. */
export function cancelledError(signal: AbortSignal): ToolError {
    const reason: unknown = signal.reason;
    const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'the client cancelled the request';
    return new ToolError('CANCELLED', `The request was cancelled before it completed (${detail}); nothing was cached and any partial output file was removed.`, { remedy: 'retry' });
}

/** Throw {@link cancelledError} when the call has been cancelled. Wrapper loops call it between their own steps. */
export function throwIfCancelled(context: CallContext): void {
    if (context.signal?.aborted === true) throw cancelledError(context.signal);
}

/** Minimum interval between two progress notifications of one call (the last one of an entry set always goes out). */
export const PROGRESS_INTERVAL_MS = 200;

export interface ProgressNotification {
    readonly progressToken: string | number;
    readonly progress: number;
    readonly message: string;
}

/**
 * Turn the engine's snapshots into MCP progress notifications: `progress` is
 * strictly increasing across the whole call (a tool that runs several engine
 * operations, such as merge_zip reading several sources, never goes
 * backwards — the counter of a finished operation is carried forward), and
 * at most one notification per {@link PROGRESS_INTERVAL_MS} is sent, plus the
 * one that completes a known entry count.
 */
export function progressReporter(
    progressToken: string | number,
    send: (notification: ProgressNotification) => void,
    now: () => number = Date.now,
): (progress: ZipProgress) => void {
    let carried = 0;
    let lastRaw = 0;
    let lastSent = 0;
    let lastAt = Number.NEGATIVE_INFINITY;
    return (p) => {
        const raw = p.bytesIn + p.bytesOut + p.entriesDone;
        if (raw < lastRaw) carried += lastRaw;
        lastRaw = raw;
        const value = carried + raw;
        const complete = p.entriesTotal !== null && p.entriesDone >= p.entriesTotal;
        if (value <= lastSent) return;
        if (!complete && now() - lastAt < PROGRESS_INTERVAL_MS) return;
        lastSent = value;
        lastAt = now();
        send({ progressToken, progress: value, message: `${p.entriesDone}${p.entriesTotal !== null ? ` / ${p.entriesTotal}` : ''} entries, ${p.bytesIn} bytes in, ${p.bytesOut} bytes out` });
    };
}
