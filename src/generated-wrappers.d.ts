// Type declarations for the runtime module that the build emits
// directly into dist/generated-wrappers.js from src/wrapper-*.js and
// src/userscript-prelude.js.
//
// No corresponding .ts file exists — keeping this as a .d.ts means
// tsc doesn't try to compile it, and the build owns the .js output
// without a stale source-tree copy.

export const WRAPPER_PRELUDE: string;
export const WRAPPER_BRIDGE: string;
export const WRAPPER_GM_RUNTIME: string;
