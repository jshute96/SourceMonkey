// ==UserScript==
// @name        SourceMonkey example: gm-menu: GM_registerMenuCommand
// @namespace   https://github.com/jshute96/SourceMonkey
// @version     1.0.3
// @description Register and unregister entries in the toolbar action's right-click menu.
// @match       *://*/*gm-menu/gm-menu.html
// @match       file:///*/gm-menu/gm-menu.html
// @run-at      document-end
// @grant       GM_registerMenuCommand
// @grant       GM_unregisterMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const status = document.getElementById('runStatus');
  const log = document.getElementById('log');
  const list = document.getElementById('registered');
  if (!status || !log || !list) return;

  // Local id → name mirror so the page can render what's currently
  // registered. GM_registerMenuCommand doesn't expose a listing API,
  // so we keep our own view in sync with every register / unregister.
  const registered = new Map();

  // Fixed id used by the "by id" buttons. Re-registering with the
  // same id updates the existing entry in place (TM/VM convention).
  const BAR_ID = 'bar-settings';
  const BAR_NAME = 'Open Bar settings';
  const FOO_NAME = 'Toggle Foo';

  function append(msg) {
    const li = document.createElement('li');
    li.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    log.prepend(li);
  }

  function render() {
    list.textContent = '';
    if (registered.size === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '(no commands registered)';
      list.appendChild(li);
      return;
    }
    for (const [id, name] of registered) {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.textContent = name + '  (id: ' + id + ')';
      list.appendChild(li);
    }
  }
  render();

  function register(name, opts) {
    const id = opts != null
      ? GM_registerMenuCommand(name, () => {
          append('callback fired for "' + name + '" (id=' + id + ')');
        }, opts)
      : GM_registerMenuCommand(name, () => {
          append('callback fired for "' + name + '" (id=' + id + ')');
        });
    registered.set(id, name);
    append('registered "' + name + '" -> id=' + id);
    render();
    return id;
  }

  function unregister(id) {
    const name = registered.get(id);
    GM_unregisterMenuCommand(id);
    if (name != null) {
      registered.delete(id);
      append('unregistered "' + name + '" (id=' + id + ')');
    } else {
      // Unknown id — exercising the silent-no-op contract. TM, VM,
      // and SM all accept unknown ids without throwing.
      append('GM_unregisterMenuCommand(' + id + ') returned without throwing (no matching entry)');
    }
    render();
  }

  // ---- "By name" pair ----------------------------------------------
  // Each Register click creates a registration with a fresh id; the
  // manager's menu shows the caption once, and picking it runs them
  // all (TM and SourceMonkey). Unregister
  // removes the most-recently-registered "Toggle Foo" (LIFO) so
  // repeated clicks peel them off in reverse order.

  document.getElementById('btn-register-by-name').addEventListener('click', () => {
    register(FOO_NAME);
  });
  document.getElementById('btn-unregister-by-name').addEventListener('click', () => {
    let latestId = null;
    for (const [id, name] of registered) {
      if (name === FOO_NAME) latestId = id;  // overwrite → end up with the most recent
    }
    if (latestId != null) {
      unregister(latestId);
    } else {
      append('no entries named "' + FOO_NAME + '" to remove');
    }
  });

  // ---- "By fixed id" pair ------------------------------------------
  // Register always uses options.id = BAR_ID, so the second and later
  // clicks update the existing entry in place rather than adding more.
  // Unregister removes that one entry; a second click is a silent no-op
  // (the GM_unregisterMenuCommand contract).

  document.getElementById('btn-register-by-id').addEventListener('click', () => {
    register(BAR_NAME, { id: BAR_ID });
  });
  document.getElementById('btn-unregister-by-id').addEventListener('click', () => {
    unregister(BAR_ID);
  });

  status.classList.add('ran');
  status.textContent =
    'Userscript ran. Use the buttons below to register / unregister, then right-click the toolbar icon to see the menu.';
})();
