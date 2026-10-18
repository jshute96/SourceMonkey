// Types for fflate (the zip library), which the build copies from
// node_modules/fflate/esm/browser.js to dist/vendor/fflate.js, the way
// it vendors Prism. Extension modules import `../vendor/fflate.js`.
// No .ts beside this, so tsc compiles nothing here.

export * from 'fflate';
