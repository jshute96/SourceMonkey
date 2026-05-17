// Type declarations for the runtime module that the build emits
// directly into dist/generated-wrappers.js from src/wrapper-*.js.
//
// No corresponding .ts file exists — keeping this as a .d.ts means
// tsc doesn't try to compile it, and the build owns the .js output
// without a stale source-tree copy.

export const WRAPPER_HEAD: string;
export const WRAPPER_TAIL: string;
export const WRAPPER_MATCHER: string;
