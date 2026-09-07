/**
 * zipnative-cli — foreign ZIP integrity tools (veraZIP level 1)
 * ==============================================================
 * VENDORED from zipnative (the engine does not ship tests/ or scripts/ in
 * its npm tarball):
 *   upstream file:   tests/helpers/interop-tools.ts
 *   upstream commit: 4f1bc3619372e8543bccea65d2365bf0c048a10c (zipnative 1.0.0)
 *   upstream blob:   2fef80f17e302384a0f6a5f57f7a0f14911401f5
 *
 * Only the integrity (`test`) half of upstream's EXTRACTORS is ported —
 * the producers, the extract-direction matrix and the PowerShell
 * Expand-Archive entry (which has no `test` mode) are dropped: the CLI's
 * conformance gate asks each foreign tool one question, "do you accept
 * this archive?", and never extracts. Exit-code contracts are copied
 * verbatim from upstream (see UNZIP_OK / SEVENZIP_OK below).
 *
 * INDEPENDENT BY CONSTRUCTION: node built-ins only. This module never
 * imports `zipnative`, `src/` or spawns the built CLI bundle — a level-1
 * pass must come from a NON-zipnative implementation or it proves nothing.
 * (tests/scripts/verazip-vendor.test.ts machine-checks this.)
 *
 * Detection is runtime: a tool absent from the machine reports
 * `describe() === null` and is SKIPped by the validator — never faked.
 */

import { spawnSync } from 'node:child_process';

/** Run a foreign tool; `ok` when it exited with one of `okStatuses` (never throws). */
function run(command, args, cwd, okStatuses = [0]) {
    try {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
        return {
            ok: result.status !== null && okStatuses.includes(result.status),
            stdout: (result.stdout ?? '') + (result.stderr ?? ''),
        };
    } catch {
        return { ok: false, stdout: '' };
    }
}

// Info-ZIP unzip's documented exit codes (man unzip, DIAGNOSTICS): 0 =
// no errors or warnings; 1 = "one or more warning errors were
// encountered, but processing completed successfully anyway" (fires on
// an empty zipfile and on SFX-prefixed archives); 2+ = real format/CRC
// errors. Treating 1 as failure would reject archives unzip itself
// processed fine — so unzip alone accepts {0, 1}.
const UNZIP_OK = [0, 1];

// 7-Zip's documented exit codes (man 7z, DIAGNOSTICS): 0 = no errors or
// warnings; 1 = "Warning (Non fatal error(s))" — fires on prepended
// data (SFX stubs: "there are some data before archive"), observed on
// both CI runner images; 2 = fatal error, which is where CRC/format
// failures land. Same policy as unzip: {0, 1} passes, 2+ fails.
const SEVENZIP_OK = [0, 1];

function firstWorking(commands, args) {
    for (const command of commands) {
        if (run(command, args).ok) return command;
    }
    return null;
}

function sevenZipCmd() {
    for (const cmd of ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
        if (run(cmd, ['i']).ok) return cmd;
    }
    return null;
}

/**
 * Foreign integrity checkers: `{ id, describe(), test(archivePath) }`.
 * `describe()` returns a human-readable description (with version when
 * detectable) or null when the tool is unavailable; `test()` returns true
 * when the tool accepts the archive under its documented exit contract.
 */
export const INTEGRITY_TOOLS = [
    {
        id: 'bsdtar',
        describe: () => {
            const probe = run('tar', ['--version']);
            return probe.ok && probe.stdout.includes('bsdtar') ? probe.stdout.split('\n')[0].trim() : null;
        },
        test: (archivePath) => run('tar', ['-tf', archivePath]).ok,
    },
    {
        id: 'unzip',
        describe: () => {
            const probe = run('unzip', ['-v']);
            return probe.ok ? (probe.stdout.split('\n').find((l) => l.includes('UnZip'))?.trim() ?? 'Info-ZIP unzip') : null;
        },
        test: (archivePath) => run('unzip', ['-t', '-qq', archivePath], undefined, UNZIP_OK).ok,
    },
    {
        id: '7z',
        describe: () => {
            const cmd = sevenZipCmd();
            return cmd === null ? null : `${cmd} (7-Zip)`;
        },
        test: (archivePath) => {
            const cmd = sevenZipCmd();
            return cmd !== null && run(cmd, ['t', '-y', archivePath], undefined, SEVENZIP_OK).ok;
        },
    },
    {
        id: 'python-zipfile',
        describe: () => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python === null ? null : `${python} -m zipfile`;
        },
        test: (archivePath) => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python !== null && run(python, ['-m', 'zipfile', '-t', archivePath]).ok;
        },
    },
    {
        id: 'jar',
        describe: () => {
            const probe = run('jar', ['--version']);
            return probe.ok ? probe.stdout.split('\n')[0].trim() : null;
        },
        test: (archivePath) => run('jar', ['tf', archivePath]).ok,
    },
];
