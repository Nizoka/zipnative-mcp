/**
 * Pin the process timezone to UTC — side-effect module.
 *
 * A ZIP stores its timestamps as MS-DOS date/time fields, which carry no
 * zone: the writer and the reader each pick one. The server pins UTC
 * (`dosTimeMode: 'utc'` on every engine call), but a script that renders an
 * instant with the host calendar — or a dist/ built before that pin — would
 * still differ between Paris and a UTC CI runner, so the zone is pinned here,
 * as vitest.config.ts pins it for the test suite.
 *
 * Import this module FIRST, before anything that formats a date. ES modules
 * evaluate imports in source order, so a bare `import './helpers/tz.js';`
 * placed above the others runs before them.
 *
 * `process.env.TZ` has been honoured at runtime on every platform since
 * Node 16.2; the project's engine floor is Node 22.
 */
process.env.TZ = 'UTC';
