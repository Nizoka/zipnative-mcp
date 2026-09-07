/**
 * Public library entry: re-exports the server factory and type surface so that
 * zipnative-mcp can be embedded in another Node process if desired.
 */
export { createServer, ensureEngineReady, callToolDirect, listToolsPayload } from './server.js';
export type { OutputMode, OutputResult } from './output.js';
export { ToolError, SecurityError, GovernanceError } from './errors.js';
