import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
        // Worker-pool tests spawn real worker_threads and the pure-TS deterministic
        // encoder is slow under v8 coverage instrumentation: allow generous headroom.
        testTimeout: 30_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                'src/cli.ts',
                'src/index.ts',
            ],
            thresholds: {
                // v1.0.0 measured on the release tree: 98.22 / 94.84 / 99.0 / 98.77 (statements /
                // branches / functions / lines). Thresholds sit ~4 points below the measured values so a
                // regression fails CI while ordinary churn does not. Never lower these; raise
                // them when a release lifts coverage.
                statements: 94,
                branches: 90,
                functions: 95,
                lines: 94,
            },
        },
    },
});
