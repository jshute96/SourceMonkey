// Selectors into the userscript viewer that more than one spec needs.
//
// Only for the ones where the right element is not obvious: a spec that
// wants `#install-btn` should just say so.

// Which script (and which COPY of it) the viewer is showing.
//
// Not the `<h1>`: the heading carries the script's `@name`, and two
// installed copies of one script share that. The details panel's
// Location row is what tells them apart. Scoped to the panel because
// the versions table has location cells of its own.
export const LOCATION_ROW = '#header-summary .filename-text';
