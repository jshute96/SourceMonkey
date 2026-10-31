// Second library for relative-require.user.js, loaded by
// `@require ./second.js`. It reads first.js's `const` at its own top
// level, so it only works when first.js comes before it.
const RELATIVE_SECOND = `${RELATIVE_FIRST}, then second.js`;
