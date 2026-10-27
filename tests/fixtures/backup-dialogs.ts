// Drives the collections page's export and import dialogs
// (src/extension/export-dialog.ts, src/extension/import-dialog.ts), for
// the export, import and cross-manager specs.

import { expect, type Page } from '@playwright/test';

export const EXPORT_DIALOG = 'dialog.export-dialog';
export const EXPORT_RESULT = `${EXPORT_DIALOG} #export-result`;
export const IMPORT_DIALOG = 'dialog.import-dialog';
export const IMPORT_RESULT = `${IMPORT_DIALOG} #import-result`;

// Export through `menuButton`'s ⋯ menu, on an open collections page.
// Returns where the zip was saved, with the dialog still open on its
// result.
export async function exportVia(
  page: Page, menuButton: string, options: { files?: boolean; values?: boolean } = {},
): Promise<string> {
  // Headless Chrome can't show a Save As (see `saveFile`).
  await page.evaluate(() => { (globalThis as { smExportSkipSaveAs?: boolean }).smExportSkipSaveAs = true; });
  await page.locator(menuButton).click();
  await page.locator('.menu button', { hasText: /^Export/ }).click();
  await expect(page.locator(EXPORT_DIALOG)).toBeVisible();
  if (options.files) await page.locator(`${EXPORT_DIALOG} #export-files`).check();
  if (options.values === false) await page.locator(`${EXPORT_DIALOG} #export-values`).uncheck();
  await page.locator(`${EXPORT_DIALOG} #export-confirm-btn`).click();
  await expect(page.locator(EXPORT_RESULT)).toBeVisible();
  return await page.locator(`${EXPORT_RESULT} #export-saved-path`).innerText();
}

// Close the export dialog after `exportVia`.
export async function closeExport(page: Page): Promise<void> {
  await page.locator(`${EXPORT_DIALOG} #export-confirm-btn`).click();
  await expect(page.locator(EXPORT_DIALOG)).toBeHidden();
}

// Each section's options, by the section: restored collections, new
// scripts and existing ones.
export interface ImportChoicesInput {
  restoreValues?: boolean;
  restoreEnabled?: boolean;
  newValues?: boolean;
  newEnabled?: boolean;
  // Which existing scripts' text the backup's replaces.
  existing?: 'leave' | 'newer' | 'always';
  existingValues?: boolean;
  existingEnabled?: boolean;
  // Check (or clear) all the backup's collections the import can
  // restore or add to.
  restore?: boolean;
  // The Add to collection option's label, or part of it.
  into?: string;
}

// Open the import dialog from `menuButton`'s ⋯ menu and choose `file`,
// leaving the preview open.
export async function openImport(page: Page, menuButton: string, file: string): Promise<void> {
  await page.locator(menuButton).click();
  await page.locator('.menu button', { hasText: /^Import/ }).click();
  await expect(page.locator(IMPORT_DIALOG)).toBeVisible();
  await page.locator(`${IMPORT_DIALOG} #import-file`).setInputFiles(file);
}

// Set the dialog's choices.
export async function chooseImport(page: Page, choices: ImportChoicesInput): Promise<void> {
  const d = IMPORT_DIALOG;
  if (choices.existing) await page.locator(`${d} #import-existing-${choices.existing}`).check();
  const boxes: [boolean | undefined, string][] = [
    [choices.restoreValues, 'restore-values'], [choices.restoreEnabled, 'restore-enabled'],
    [choices.newValues, 'new-values'], [choices.newEnabled, 'new-enabled'],
    [choices.existingValues, 'existing-values'], [choices.existingEnabled, 'existing-enabled'],
  ];
  for (const [on, id] of boxes) if (on !== undefined) await page.locator(`${d} #import-${id}`).setChecked(on);
  if (choices.restore !== undefined) {
    for (const box of await page.locator(`${d} #import-collections-table tbody input:enabled`).all()) await box.setChecked(choices.restore);
  }
  if (choices.into) {
    const label = await page.locator(`${d} #import-into option`).filter({ hasText: choices.into }).first().innerText();
    await page.locator(`${d} #import-into`).selectOption({ label });
  }
}

// Waits for the preview of a chosen file: its sections show with it.
export async function previewShown(page: Page): Promise<void> {
  await expect(page.locator(`${IMPORT_DIALOG} #import-sections`)).toBeVisible();
}

// The New scripts table's rows: Name, Version, and the Type chip with
// the location it links to ('' for none).
export async function newRows(page: Page): Promise<{ name: string; version: string; type: string; href: string }[]> {
  await previewShown(page);
  return await page.locator(`${IMPORT_DIALOG} #import-new-table tbody tr`).evaluateAll((rows) => rows.map((r) => ({
    name: r.querySelector('.import-name')?.textContent ?? '',
    version: r.querySelector('.import-version')?.textContent ?? '',
    type: r.querySelector('.import-type')?.textContent ?? '',
    href: r.querySelector('.import-type a')?.getAttribute('href') ?? '',
  })));
}

// The New scripts table's Collection column, when the backup gives
// each one's collection: its name, "(New)" when it isn't here, and
// whether it's greyed (new scripts go to a picked collection instead).
export async function newCollections(page: Page): Promise<{ name: string; off: boolean }[]> {
  await previewShown(page);
  return await page.locator(`${IMPORT_DIALOG} #import-new-table tbody td[data-col="collection"]`).evaluateAll((cells) => cells.map((c) => ({
    name: c.textContent ?? '', off: c.classList.contains('import-off'),
  })));
}

// The Collections table's rows: Name, Kind, Location (as shown),
// Scripts, Status, and whether it is checked to be restored.
export async function collectionRows(page: Page): Promise<{
  name: string; kind: string; location: string; scripts: string; enabled: string; status: string; restore: boolean;
}[]> {
  await previewShown(page);
  return await page.locator(`${IMPORT_DIALOG} #import-collections-table tbody tr`).evaluateAll((rows) => rows.map((r) => {
    const cells = [...r.querySelectorAll('td')].map((td) => td.textContent ?? '');
    return {
      name: cells[1], kind: cells[2], location: cells[3], scripts: cells[4], enabled: cells[5], status: cells[6],
      restore: (r.querySelector('input') as HTMLInputElement).checked,
    };
  }));
}

// The Existing scripts table's rows: Name, Version, Content, Enabled,
// the installed copy's Type, Values, and whether the current choices
// change the script (its row isn't greyed).
export async function existingRows(page: Page): Promise<{
  name: string; version: string; content: string; enabled: string; type: string; values: string; affected: boolean;
}[]> {
  await previewShown(page);
  return await page.locator(`${IMPORT_DIALOG} #import-existing-table tbody tr`).evaluateAll((rows) => rows.map((r) => ({
    name: r.querySelector('.import-name')?.textContent ?? '',
    version: r.querySelector('.import-version')?.textContent ?? '',
    content: r.querySelector('.import-here')?.textContent ?? '',
    enabled: r.querySelector('.import-enabled')?.textContent ?? '',
    values: r.querySelector('.import-values')?.textContent ?? '',
    type: r.querySelector('.import-type')?.textContent ?? '',
    affected: !r.classList.contains('import-skip'),
  })));
}

// The names in the Existing scripts with no changes table, shown or not.
export async function unchangedNames(page: Page): Promise<string[]> {
  await previewShown(page);
  return await page.locator(`${IMPORT_DIALOG} #import-unchanged-table tbody .import-name`)
    .evaluateAll((cells) => cells.map((c) => c.textContent ?? ''));
}

// Import with the choices given, and return the result line.
export async function confirmImport(page: Page): Promise<string> {
  await page.locator(`${IMPORT_DIALOG} #import-confirm-btn`).click();
  await expect(page.locator(IMPORT_RESULT)).toBeVisible();
  // The results replace the choices.
  await expect(page.locator(`${IMPORT_DIALOG} .dlg-title`)).toHaveText('Import finished');
  await expect(page.locator(`${IMPORT_DIALOG} :is(.dlg-intro, .dlg-file, .import-section)`).filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(`${IMPORT_DIALOG} #import-confirm-btn`)).toHaveText('Close');
  return await page.locator(IMPORT_RESULT).innerText();
}

export async function closeImport(page: Page): Promise<void> {
  await page.locator(`${IMPORT_DIALOG} #import-confirm-btn`).click();
  await expect(page.locator(IMPORT_DIALOG)).toBeHidden();
}

// The whole round: open, choose, import, close. Returns the result line.
export async function importVia(
  page: Page, menuButton: string, file: string, choices: ImportChoicesInput = {},
): Promise<string> {
  await openImport(page, menuButton, file);
  await previewShown(page);
  await chooseImport(page, choices);
  const result = await confirmImport(page);
  await closeImport(page);
  return result;
}
