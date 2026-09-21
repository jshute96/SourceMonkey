import {
  renderGlyph,
  setGlyphButton,
  setGlyphButtonBusy,
} from '../glyph.js';
import { installHomeLinkHandler } from '../page-links.js';
import { formatBytes } from '../script-display.js';
import {
  deleteAllCachedIcons,
  deleteCachedIcon,
  isIconCacheKey,
  listCachedIcons,
  refreshCachedIcon,
  type CachedIconRow,
} from '../site-icon.js';

const summaryEl = document.getElementById('icons-summary') as HTMLParagraphElement;
const emptyEl = document.getElementById('icons-empty') as HTMLDivElement;
const tableEl = document.getElementById('icons-table') as HTMLTableElement;
const tbodyEl = document.getElementById('icons-tbody') as HTMLTableSectionElement;
const deleteAllBtn = document.getElementById('delete-all') as HTMLButtonElement;

const REFRESH_LABELS = {
  idle: 'Refresh cached icon',
  busy: 'Refreshing…',
};
const refreshingKeys = new Set<string>();
let renderGeneration = 0;

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatIso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function kindLabel(kind: CachedIconRow['kind']): string {
  switch (kind) {
    case 'origin':
      return 'origin';
    case 'path':
      return 'path';
    case 'url':
      return '@icon';
  }
}

function renderRow(row: CachedIconRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.storageKey = row.storageKey;

  // 1. Icon
  const iconTd = document.createElement('td');
  iconTd.className = 'col-icon';
  if (row.entry.dataUrl) {
    const img = document.createElement('img');
    img.src = row.entry.dataUrl;
    img.alt = '';
    iconTd.appendChild(img);
  } else {
    iconTd.appendChild(renderGlyph(document, '#sm-globe', 'site-icon-globe'));
  }
  tr.appendChild(iconTd);

  // 2. Site / Target
  const targetTd = document.createElement('td');
  targetTd.className = 'col-target';
  const link = document.createElement('a');
  link.href = row.target;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = row.target;
  link.title = row.storageKey;
  targetTd.appendChild(link);
  tr.appendChild(targetTd);

  // 3. Scope
  const kindTd = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `kind-chip kind-${row.kind}`;
  chip.textContent = kindLabel(row.kind);
  chip.title = row.storageKey;
  kindTd.appendChild(chip);
  tr.appendChild(kindTd);

  // 4. Details
  const detailsTd = document.createElement('td');
  const parts: string[] = [];
  if (row.entry.dataUrl) {
    const mime = row.mimeType ?? 'image';
    const size = row.byteLength !== null ? formatBytes(row.byteLength) : '';
    parts.push(size ? `${mime} (${size})` : mime);
  } else {
    parts.push('none (miss)');
  }
  if (row.entry.v !== undefined) {
    parts.push(`v${row.entry.v}`);
  }
  detailsTd.textContent = parts.join(' · ');

  const badge = document.createElement('span');
  if (!row.isFresh) {
    badge.className = 'status-badge status-stale';
    badge.textContent = 'expired';
  } else if (!row.isUsable) {
    badge.className = 'status-badge status-stale';
    badge.textContent = 'stale schema';
  } else if (row.entry.dataUrl === null) {
    badge.className = 'status-badge status-miss';
    badge.textContent = 'miss';
  } else {
    badge.className = 'status-badge status-ok';
    badge.textContent = 'ok';
  }
  detailsTd.appendChild(badge);
  tr.appendChild(detailsTd);

  // 5. Fetched timestamp
  const fetchedTd = document.createElement('td');
  fetchedTd.className = 'col-time';
  fetchedTd.textContent = formatTimestamp(row.entry.fetchedAt);
  fetchedTd.title = formatIso(row.entry.fetchedAt);
  tr.appendChild(fetchedTd);

  // 6. Expiry timestamp
  const expiresTd = document.createElement('td');
  expiresTd.className = 'col-time';
  expiresTd.textContent = formatTimestamp(row.expiresAt);
  expiresTd.title = formatIso(row.expiresAt);
  tr.appendChild(expiresTd);

  // 7. Actions (Refresh + Delete)
  const actionsTd = document.createElement('td');
  actionsTd.className = 'col-actions';
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'refresh-icon';
  setGlyphButton(refreshBtn, '#sm-refresh', REFRESH_LABELS.idle);
  if (refreshingKeys.has(row.storageKey)) {
    setGlyphButtonBusy(refreshBtn, true, REFRESH_LABELS);
  }
  refreshBtn.addEventListener('click', () => {
    refreshingKeys.add(row.storageKey);
    setGlyphButtonBusy(refreshBtn, true, REFRESH_LABELS);
    void refreshCachedIcon(row.storageKey)
      .finally(() => {
        refreshingKeys.delete(row.storageKey);
        setGlyphButtonBusy(refreshBtn, false, REFRESH_LABELS);
        void render();
      });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-icon';
  setGlyphButton(deleteBtn, '#sm-trash', 'Delete cached icon');
  deleteBtn.addEventListener('click', () => {
    deleteBtn.disabled = true;
    void deleteCachedIcon(row.storageKey).finally(() => {
      void render();
    });
  });

  wrap.append(refreshBtn, deleteBtn);
  actionsTd.appendChild(wrap);
  tr.appendChild(actionsTd);

  return tr;
}

async function render(): Promise<void> {
  const gen = ++renderGeneration;
  const rows = await listCachedIcons();
  if (gen !== renderGeneration) return;
  const count = rows.length;
  summaryEl.textContent = count === 1 ? '1 cached icon' : `${count} cached icons`;
  deleteAllBtn.disabled = count === 0;
  emptyEl.hidden = count > 0;
  tableEl.hidden = count === 0;
  tbodyEl.replaceChildren(...rows.map(renderRow));
}

installHomeLinkHandler();

deleteAllBtn.addEventListener('click', () => {
  deleteAllBtn.disabled = true;
  void deleteAllCachedIcons().finally(() => {
    void render();
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (Object.keys(changes).some(isIconCacheKey)) {
    void render();
  }
});

void render();
