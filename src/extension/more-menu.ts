// The ⋯ button and the menu it opens, shared by the toolbar popup and
// the collections page. One menu is open at a time; a click elsewhere
// or Escape closes it. Each page styles its own `button.more-menu`; the
// menu's look is `.menu` in styles.css.

export interface MenuItem {
  label?: string;
  // Shown but not clickable, with `title` saying why.
  disabled?: boolean;
  title?: string;
  // Run on click, after the menu closes.
  run?: () => unknown;
  // Wires the item's button itself, instead of `run`: for an item with
  // more than one way to activate it (the popup's open-a-page items).
  // `close` closes the menu.
  wire?: (button: HTMLButtonElement, close: () => void) => void;
  separator?: boolean;
  hidden?: boolean;
  // Shown as a warning sign after the label, with this as its tooltip.
  warning?: string;
}

let openMenuEl: HTMLElement | null = null;
let openMenuBtn: HTMLButtonElement | null = null;
let listening = false;

export function moreMenuButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'more-menu';
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.textContent = '⋯';
  return b;
}

// Open `items` under `btn`, or close the menu when it is already open
// there.
export function openMenu(btn: HTMLButtonElement, items: readonly MenuItem[]): void {
  listen();
  const wasOpen = openMenuBtn === btn;
  closeMenu();
  if (wasOpen) return;
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.hidden) continue;
    if (item.separator) {
      menu.append(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label ?? '';
    b.disabled = item.disabled === true;
    if (item.title) b.title = item.title;
    if (item.warning) {
      const sign = document.createElement('span');
      sign.className = 'warn-icon';
      sign.setAttribute('aria-label', 'Warning');
      sign.textContent = '⚠';
      b.append(sign);
      b.title = item.warning;
    }
    if (item.wire) {
      item.wire(b, closeMenu);
    } else {
      b.addEventListener('click', () => {
        closeMenu();
        if (!item.run) return;
        // Called inside the click, so the action keeps its user gesture.
        try {
          Promise.resolve(item.run()).catch(menuActionFailed);
        } catch (err) {
          menuActionFailed(err);
        }
      });
    }
    menu.append(b);
  }
  document.body.append(menu);
  // Under the button, right-aligned to it; above it when there's no
  // room below.
  const r = btn.getBoundingClientRect();
  const below = r.bottom + 2;
  const top = below + menu.offsetHeight > document.documentElement.clientHeight
    ? Math.max(0, r.top - menu.offsetHeight - 2) : below;
  menu.style.top = `${top}px`;
  menu.style.right = `${document.documentElement.clientWidth - r.right}px`;
  btn.setAttribute('aria-expanded', 'true');
  openMenuEl = menu;
  openMenuBtn = btn;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

// Close the menu when the button it hangs from has left the page (a
// repaint replaced it), rather than leave it floating where it was.
export function closeDetachedMenu(): void {
  if (openMenuBtn && !openMenuBtn.isConnected) closeMenu();
}

export function closeMenu(): void {
  openMenuEl?.remove();
  openMenuBtn?.setAttribute('aria-expanded', 'false');
  openMenuEl = null;
  openMenuBtn = null;
}

function menuActionFailed(err: unknown): void {
  console.info('[SourceMonkey] menu action failed:', err);
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('click', (ev) => {
    const t = ev.target as Element | null;
    if (!openMenuEl || t?.closest('.menu') || t?.closest('button.more-menu') === openMenuBtn) return;
    closeMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && openMenuEl) {
      const btn = openMenuBtn;
      closeMenu();
      btn?.focus();
      ev.preventDefault();
    }
  });
}
