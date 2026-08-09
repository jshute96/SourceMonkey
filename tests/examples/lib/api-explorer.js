// Shared "API explorer" UI for the SourceMonkey examples.
//
// Pulled into an example userscript with `@require ./api-explorer.js`
// (a symlink to this file), so everything here runs in the script's own
// world, in the script's own lexical scope. See docs/requires.md.
//
// What it gives an example page, from one declarative spec:
//
//   - a form generated from the API's argument list,
//   - a row of preset buttons that both RUN a canned call and FILL the
//     form with the arguments it used, so the next call can be a small
//     edit of a working one,
//   - Submit / Clear for the hand-edited form,
//   - one shared log showing every call, its arguments, its return
//     value, and anything its callbacks reported.
//
// Deliberately GM-free. The spec's `call` function is the only place a
// `GM_*` API is touched, which keeps each example's userscript about
// the API it demonstrates and nothing else.
//
// Several boxes can share a page (e.g. GM_setValue next to GM_getValue);
// they lay out side by side and each preset names the box it targets.

// ---------- Field value <-> form text ----------
//
// Each `kind` is a pair: how a value is written into an input, and how
// the input's text becomes a value again. Kept as data so a spec only
// ever names a kind.
//
// Empty means ABSENT everywhere. An example that wants to pass an empty
// string types `""` into a `json` / `jsonOrString` field — the whole
// point of the form is to make the difference between "omitted" and
// "empty" expressible, since managers treat them differently.
const API_EXPLORER_KINDS = {
  string: {
    input: 'text',
    toText: (v) => (v == null ? '' : String(v)),
    fromText: (t) => (t === '' ? undefined : t),
  },
  text: {
    input: 'textarea',
    toText: (v) => (v == null ? '' : String(v)),
    fromText: (t) => (t === '' ? undefined : t),
  },
  number: {
    input: 'number',
    toText: (v) => (v == null ? '' : String(v)),
    fromText: (t) => {
      if (t === '') return undefined;
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error('not a number');
      return n;
    },
  },
  bool: {
    input: 'checkbox',
    toText: (v) => (v ? 'on' : ''),
    fromText: (t) => (t === 'on' ? true : undefined),
  },
  json: {
    input: 'textarea',
    toText: (v) => (v === undefined ? '' : JSON.stringify(v)),
    fromText: (t) => {
      if (t === '') return undefined;
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new Error(`not valid JSON (${e.message})`);
      }
    },
  },
  // JSON if it parses, otherwise the raw text. The GM storage rule —
  // lets `42` and `{"a":1}` through as real values while `hello` still
  // means the string.
  jsonOrString: {
    input: 'text',
    toText: (v) => (v === undefined ? '' : (typeof v === 'string' ? v : JSON.stringify(v))),
    fromText: (t) => {
      if (t === '') return undefined;
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    },
  },
  select: {
    input: 'select',
    toText: (v) => (v == null ? '' : String(v)),
    fromText: (t) => (t === '' ? undefined : t),
  },
};

// ---------- Rendering a call for humans ----------

// One line, no newlines: this goes in a button's hover text and in the
// log, both of which are single-line surfaces.
function apiExplorerJson(value) {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

// `GM_download({"url":"…","name":"…"})` — the default rendering when a
// box doesn't supply its own. A box whose API takes positional
// arguments gives a `render(args)` instead.
function apiExplorerDefaultRender(fnName, args) {
  const keys = Object.keys(args);
  if (!keys.length) return `${fnName}()`;
  return `${fnName}(${apiExplorerJson(args)})`;
}

// ---------- One explorer box ----------

class ApiExplorerBox {
  constructor(spec, explorer) {
    this.spec = spec;
    this.explorer = explorer;
    this.fields = spec.fields || [];
    this.inputs = new Map();
    this.el = this.build();
  }

  get id() { return this.spec.id; }

  build() {
    const box = document.createElement('fieldset');
    box.className = 'explorer-box';
    box.dataset.box = this.id;

    // The function name carries the weight; the argument list next to
    // it is the thing the form below already spells out.
    const legend = document.createElement('legend');
    const openParen = this.spec.signature.indexOf('(');
    const name = document.createElement('strong');
    name.textContent = openParen === -1
      ? this.spec.signature : this.spec.signature.slice(0, openParen);
    legend.appendChild(name);
    if (openParen !== -1) {
      legend.appendChild(document.createTextNode(this.spec.signature.slice(openParen)));
    }
    box.appendChild(legend);

    if (this.spec.note) {
      const note = document.createElement('p');
      note.className = 'explorer-note';
      note.textContent = this.spec.note;
      box.appendChild(note);
    }

    const form = document.createElement('form');
    form.className = 'explorer-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    for (const field of this.fields) form.appendChild(this.buildField(field));

    const error = document.createElement('p');
    error.className = 'explorer-error';
    error.hidden = true;
    form.appendChild(error);
    this.errorEl = error;

    const actions = document.createElement('div');
    actions.className = 'buttons';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.id = `submit-${this.id}`;
    submit.textContent = 'Submit';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.id = `clear-${this.id}`;
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => this.clear());
    actions.append(submit, clear);
    form.appendChild(actions);

    box.appendChild(form);
    return box;
  }

  // The preset buttons live in their own Examples section rather than
  // inside the box: they're the page's worked examples, and reading
  // them first — before the form they fill — is the order the page
  // teaches in. `label` names the box when a page has several.
  buildPresets(label) {
    const presets = this.spec.presets || [];
    if (!presets.length) return null;

    const row = document.createElement('div');
    row.className = 'explorer-presets';
    row.dataset.box = this.id;
    if (label) {
      const caption = document.createElement('span');
      caption.className = 'explorer-presets-label';
      caption.textContent = this.spec.signature;
      row.appendChild(caption);
    }
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    for (const preset of presets) buttons.appendChild(this.buildPresetButton(preset));
    row.appendChild(buttons);
    return row;
  }

  buildPresetButton(preset) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `btn-${preset.id}`;
    btn.textContent = preset.label;
    // Hover shows the exact call the button makes. It's free: the
    // arguments the button runs with ARE the arguments shown.
    const rendered = this.render(preset.args || {});
    btn.title = preset.note ? `${rendered}\n\nExpected: ${preset.note}` : rendered;
    btn.addEventListener('click', () => {
      // Fill first, so a call that never returns still leaves the
      // arguments on screen to edit.
      this.fill(preset.args || {});
      this.run(preset.args || {}, preset);
    });
    return btn;
  }

  buildField(field) {
    const kind = API_EXPLORER_KINDS[field.kind || 'string'];
    if (!kind) throw new Error(`unknown field kind: ${field.kind}`);

    const label = document.createElement('label');
    label.className = `explorer-field explorer-field-${field.kind || 'string'}`;

    const caption = document.createElement('span');
    caption.className = 'explorer-caption';
    caption.textContent = field.label || field.name;
    if (field.required) {
      const req = document.createElement('em');
      req.textContent = ' (required)';
      caption.appendChild(req);
    }

    let input;
    if (kind.input === 'textarea') {
      input = document.createElement('textarea');
      input.rows = field.rows || 2;
    } else if (kind.input === 'select') {
      input = document.createElement('select');
      for (const opt of [''].concat(field.options || [])) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt === '' ? '(omitted)' : opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = kind.input;
    }
    input.name = field.name;
    input.id = `field-${this.id}-${field.name}`;
    if (field.placeholder && 'placeholder' in input) input.placeholder = field.placeholder;

    // Checkboxes read better with the caption beside the box.
    if (kind.input === 'checkbox') label.classList.add('explorer-field-inline');
    label.append(kind.input === 'checkbox' ? input : caption,
      kind.input === 'checkbox' ? caption : input);

    if (field.hint) {
      const hint = document.createElement('span');
      hint.className = 'explorer-hint';
      hint.textContent = field.hint;
      label.appendChild(hint);
    }

    this.inputs.set(field.name, { field, input, kind });
    return label;
  }

  // ---------- form <-> args ----------

  fill(args) {
    for (const [name, { input, kind }] of this.inputs) {
      const text = kind.toText(args[name]);
      if (input.type === 'checkbox') input.checked = text === 'on';
      else input.value = text;
    }
    this.showError(null);
  }

  clear() {
    this.fill({});
  }

  // Throws with a per-field message the form shows in place.
  collect() {
    const args = {};
    for (const [name, { field, input, kind }] of this.inputs) {
      const text = input.type === 'checkbox' ? (input.checked ? 'on' : '') : input.value;
      let value;
      try {
        value = kind.fromText(text);
      } catch (e) {
        throw new Error(`${field.label || name}: ${e.message}`);
      }
      // A blank required field is NOT refused here — it goes through as
      // an omitted argument so the API gets to reject it, which is the
      // thing worth seeing. `required` only marks the caption.
      if (value === undefined) continue;
      args[name] = value;
    }
    return args;
  }

  submit() {
    let args;
    try {
      args = this.collect();
    } catch (e) {
      this.showError(e.message);
      return;
    }
    this.showError(null);
    this.run(args, null);
  }

  showError(message) {
    this.errorEl.textContent = message || '';
    this.errorEl.hidden = !message;
  }

  render(args) {
    return this.spec.render
      ? this.spec.render(args)
      : apiExplorerDefaultRender(this.spec.fnName || this.spec.signature.replace(/\(.*$/, ''), args);
  }

  // ---------- the call ----------

  run(args, preset) {
    // `prepare` exists for arguments that can't be canned — the blob:
    // preset has to mint a URL at click time. Whatever it returns is
    // what gets logged and what the form shows, so the log never
    // claims a call was made with arguments it wasn't.
    let effective = args;
    if (this.spec.prepare) {
      try {
        effective = this.spec.prepare({ ...args }, preset) || args;
      } catch (e) {
        this.explorer.logCall(this.render(args), `threw preparing arguments: ${e.message}`, 'error');
        return;
      }
      if (effective !== args) this.fill(effective);
    }

    const entry = this.explorer.logCall(this.render(effective), preset && preset.note);
    const ctx = {
      report: (text) => entry.report(text),
      args: effective,
      preset,
    };
    try {
      const result = this.spec.call(effective, ctx);
      // `undefined` is logged like any other return value: for a getter
      // it's the answer, and "did it come back undefined or not come
      // back at all" is exactly what these pages are for. A box whose
      // return value is reported some other way (GM_download reports
      // its control object itself) opts out with `logReturn: false`.
      if (this.spec.logReturn !== false) entry.report(`returned ${apiExplorerJson(result)}`);
    } catch (e) {
      entry.report(`threw: ${(e && e.message) || e}`, 'error');
    }
  }
}

// ---------- The page-level explorer ----------

class ApiExplorer {
  // opts: { mount, examples, log, boxes }
  //   mount    — selector/element the boxes are appended to
  //   examples — selector/element the preset buttons are appended to;
  //              a separate section above the forms
  //   log      — selector/element of the <ul> every call is written into
  //   boxes    — array of box specs
  static create(opts) {
    const el = (v) => (typeof v === 'string' ? document.querySelector(v) : v);
    const mount = el(opts.mount);
    const log = el(opts.log);
    if (!mount || !log) return null;
    return new ApiExplorer(mount, el(opts.examples), log, opts.boxes || []);
  }

  constructor(mount, examples, log, boxSpecs) {
    this.logEl = log;
    this.boxes = new Map();

    const row = document.createElement('div');
    row.className = 'explorer-row';
    for (const spec of boxSpecs) {
      const box = new ApiExplorerBox(spec, this);
      this.boxes.set(box.id, box);
      row.appendChild(box.el);
      // Label the preset row only when there's more than one box to
      // tell apart — on a single-API page the heading already says it.
      const presets = box.buildPresets(boxSpecs.length > 1);
      // Without an Examples section to put them in, presets fall back
      // to the bottom of their own box rather than vanishing.
      if (presets) (examples || box.el).appendChild(presets);
    }
    mount.appendChild(row);

    // Clearing the log belongs with the log, not with the forms — so
    // it goes immediately above the list rather than under the boxes.
    const actions = document.createElement('div');
    actions.className = 'buttons';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.id = 'btn-clear-log';
    clear.textContent = 'Clear log';
    clear.addEventListener('click', () => { this.logEl.textContent = ''; });
    actions.appendChild(clear);
    this.logEl.parentNode.insertBefore(actions, this.logEl);
  }

  box(id) { return this.boxes.get(id); }

  // Newest call at the top, its reported lines beneath it in the order
  // they arrived — so a running download's progress reads downward
  // while finished calls stay put below.
  logCall(rendered, note, level) {
    const li = document.createElement('li');
    li.className = 'explorer-entry';
    if (level) li.dataset.level = level;

    const head = document.createElement('div');
    head.className = 'explorer-call';
    head.textContent = `${apiExplorerTime()} → ${rendered}`;
    li.appendChild(head);

    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'explorer-expect';
      noteEl.textContent = `   Expected: ${note}`;
      li.appendChild(noteEl);
    }

    this.logEl.prepend(li);

    return {
      report: (text, lineLevel) => {
        const line = document.createElement('div');
        line.className = 'explorer-line';
        if (lineLevel) line.dataset.level = lineLevel;
        line.textContent = `   ${text}`;
        li.appendChild(line);
        return line;
      },
    };
  }
}

function apiExplorerTime() {
  return `[${new Date().toLocaleTimeString()}]`;
}

// Flatten an arbitrary callback payload into one readable line. Every
// manager hands back a different shape here, and an example that prints
// `[object Object]` teaches nothing.
function apiExplorerDescribe(value) {
  if (value === null || typeof value !== 'object') return String(value);
  const parts = [];
  for (const key of ['error', 'filename', 'status', 'statusText', 'finalUrl', 'readyState']) {
    if (value[key] !== undefined) parts.push(`${key}=${apiExplorerJson(value[key])}`);
  }
  if (value.details && value.details.current) parts.push(`current=${value.details.current}`);
  if (value.details && value.details.message) parts.push(`message=${value.details.message}`);
  return parts.length ? parts.join(' ') : apiExplorerJson(value);
}
