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

export interface ImportChoicesInput {
  existing?: 'leave' | 'newer' | 'always';
  values?: boolean;
  enabled?: boolean;
  follow?: boolean;
  // The `Into` option's label, or its start.
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
  if (choices.values !== undefined) await page.locator(`${d} #import-values`).setChecked(choices.values);
  if (choices.enabled !== undefined) await page.locator(`${d} #import-enabled`).setChecked(choices.enabled);
  if (choices.follow !== undefined) await page.locator(`${d} #import-follow`).setChecked(choices.follow);
  if (choices.into) {
    const label = await page.locator(`${d} #import-into option`).filter({ hasText: choices.into }).first().innerText();
    await page.locator(`${d} #import-into`).selectOption({ label });
  }
}

// Each table row's Name, Here and Result.
export async function importRows(page: Page): Promise<{ name: string; here: string; result: string }[]> {
  await expect(page.locator(`${IMPORT_DIALOG} #import-table`)).toBeVisible();
  return await page.locator(`${IMPORT_DIALOG} #import-table tbody tr`).evaluateAll((rows) => rows.map((r) => ({
    name: r.querySelector('.import-name')?.textContent ?? '',
    here: r.querySelector('.import-here')?.textContent ?? '',
    result: r.querySelector('.import-result')?.textContent ?? '',
  })));
}

// Import with the choices given, and return the result line.
export async function confirmImport(page: Page): Promise<string> {
  await page.locator(`${IMPORT_DIALOG} #import-confirm-btn`).click();
  await expect(page.locator(IMPORT_RESULT)).toBeVisible();
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
  await expect(page.locator(`${IMPORT_DIALOG} #import-table`)).toBeVisible();
  await chooseImport(page, choices);
  const result = await confirmImport(page);
  await closeImport(page);
  return result;
}
