/**
 * Engine initialisation and runtime capability probes.
 *
 * `initNodeZipCodecs()` wires zipnative's `node:zlib` tier (the ESM build
 * cannot require it synchronously); it is idempotent, so the promise is
 * memoised and awaited once by the CLI before serving and by the tools
 * defensively. Both the buffered writer and the worker subpath resolve the
 * same tier after it, which keeps `create_zip` `parallel` byte-identical to
 * the sequential path.
 */
import { initNodeZipCodecs } from 'zipnative';

let _ready: Promise<void> | null = null;

/** Initialise the engine's Node codecs exactly once. Safe to call repeatedly. */
export function ensureEngineReady(): Promise<void> {
    if (_ready === null) _ready = initNodeZipCodecs();
    return _ready;
}

export interface RuntimeCapabilities {
    readonly nodeZlib: boolean;
    readonly compressionStream: boolean;
    readonly decompressionStream: boolean;
    readonly workerThreads: boolean;
    readonly cpuCount: number;
    /** zipnative's default worker count: max(1, min(cores − 1, 8)). */
    readonly defaultWorkers: number;
}

function hasGlobal(name: string): boolean {
    try {
        return typeof (globalThis as Record<string, unknown>)[name] === 'function';
    } catch {
        return false;
    }
}

/** Probe what the current runtime offers (all synchronous, no side effects). */
export async function probeRuntime(): Promise<RuntimeCapabilities> {
    const os = await import('node:os');
    const cpuCount = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
    let workerThreads = false;
    try {
        const wt = await import('node:worker_threads');
        workerThreads = typeof wt.Worker === 'function';
    } catch {
        workerThreads = false;
    }
    return {
        nodeZlib: true,
        compressionStream: hasGlobal('CompressionStream'),
        decompressionStream: hasGlobal('DecompressionStream'),
        workerThreads,
        cpuCount,
        defaultWorkers: Math.max(1, Math.min(cpuCount - 1, 8)),
    };
}
