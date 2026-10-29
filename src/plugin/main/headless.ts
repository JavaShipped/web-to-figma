import { importCapture } from './import';

// Test harness entry: exposes the import pipeline without a UI, for running in a scripted
// Plugin API context (e.g. the Figma MCP use_figma tool).

(globalThis as unknown as { __w2fImport: typeof importCapture }).__w2fImport = importCapture;
