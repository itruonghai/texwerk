/**
 * The Overleaf link in a real browser, against a mock Overleaf
 * (test/support/mockOverleaf.ts) and a TeXWerk server this script starts:
 *
 *   npm run build && node test/e2e-overleaf.ts      (CHROMIUM=/usr/bin/chromium by default)
 *
 * - "Overleaf…" opens the dialog; Compare lists what each side has and asks
 *   about the file that differs; Link links;
 * - the toolbar chip turns live;
 * - typing in the editor reaches Overleaf, and an Overleaf user's typing and
 *   comment reach the editor and the Comments tab;
 * - an expired cookie shows on the chip, and a new one from the dialog fixes it.
 *
 * SHOTS=<dir> saves screenshots of each step there.
 */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../src/server/server.ts';
import { MockOverleaf } from './support/mockOverleaf.ts';

const shots = process.env.SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

const mock = new MockOverleaf();
const hai = mock.addUser('hai', 'Hai');
const alice = mock.addUser('alice', 'Alice');
mock.addDoc('main.tex', '\\documentclass{article}\n\\begin{document}\nHello from Overleaf.\n\\end{document}\n', false);
mock.addDoc('refs.bib', '@misc{a, title={A}}\n', false);
await mock.start();

const root = await mkdtemp(join(tmpdir(), 'texwerk-e2e-overleaf-'));
await mkdir(join(root, 'Paper'));
await writeFile(join(root, 'Paper', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello from TeXWerk.\n\\end{document}\n');
await writeFile(join(root, 'Paper', 'notes.tex'), 'Only here.\n');
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const server = await startServer({ rootDir: root, clientDir: join(import.meta.dirname, '..', 'dist', 'client'), bridgeFile: null, port, host: '127.0.0.1', access: null });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.addInitScript(() => { localStorage.setItem('texwerk-name', 'Bob'); });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));

let failed = false;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed = true; console.log(`FAIL ${name}\n${(e as Error).message}`); }
}
const editorText = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

try {
  await page.goto(`${origin}/?project=Paper&file=main.tex`);
  await page.waitForSelector('.cm-content');

  await check('Compare shows both sides and asks about the differing file; Link links', async () => {
    assert.ok(await page.locator('.overleaf-chip').isHidden(), 'no chip before linking');
    await page.locator('.toolbar button', { hasText: 'Overleaf…' }).click();
    await page.locator('.dialog input').first().fill(mock.url);
    await page.locator('.dialog input[type="password"]').fill('hai');
    await shot(page, '1-link-form');
    await page.locator('.dialog button', { hasText: 'Compare' }).click();
    await page.locator('.dialog .ol-row', { hasText: 'main.tex' }).waitFor();
    assert.match(await page.locator('.dialog').innerText(), /1 are only on Overleaf and come here; 1 are only here and go to Overleaf/);
    await page.locator('.dialog .ol-row', { hasText: 'main.tex' }).getByLabel('Keep TeXWerk').check();
    await page.locator('.dialog .ol-row', { hasText: 'main.tex' }).getByText('Show differences').click();
    await page.locator('.dialog .ol-diff .cm-deletedChunk, .dialog .ol-diff .cm-changedLine').first().waitFor();
    assert.match(await page.locator('.dialog .ol-diff').innerText(), /Hello from TeXWerk\./);
    await shot(page, '2-compare');
    // Narrow: the file name keeps a line of its own instead of shrinking away.
    await page.setViewportSize({ width: 400, height: 900 });
    const name = await page.locator('.dialog .ol-row code', { hasText: 'main.tex' }).boundingBox();
    assert.ok(name && name.width >= 50, `file name visible at 400 px (width ${name?.width})`);
    await shot(page, '2b-compare-narrow');
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.locator('.dialog button', { hasText: /^Link$/ }).click();
    await page.locator('.dialog .ol-status', { hasText: 'live' }).waitFor({ timeout: 15_000 });
    await shot(page, '3-linked');
    await page.locator('.dialog button', { hasText: 'Close' }).click();
    await page.locator('.overleaf-chip', { hasText: 'Overleaf · live' }).waitFor();
    assert.equal(mock.text('main.tex'), '\\documentclass{article}\n\\begin{document}\nHello from TeXWerk.\n\\end{document}\n');
    assert.equal(mock.text('notes.tex'), 'Only here.\n');
  });

  await check('typing in the editor reaches Overleaf', async () => {
    await page.locator('.cm-line', { hasText: 'Hello from TeXWerk.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Typed by Bob.');
    const deadline = Date.now() + 10_000;
    while (!mock.text('main.tex')!.includes('Hello from TeXWerk. Typed by Bob.')) {
      if (Date.now() > deadline) throw new Error(`not on Overleaf: ${mock.text('main.tex')}`);
      await page.waitForTimeout(50);
    }
  });

  await check('an Overleaf user\'s typing and comment reach the editor', async () => {
    const text = mock.text('main.tex')!;
    const at = text.indexOf('Hello');
    mock.edit(alice._id, 'main.tex', [{ p: at, i: 'Alice says hi. ' }]);
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Alice says hi.'), null, { timeout: 10_000 });
    const quoteAt = mock.text('main.tex')!.indexOf('Typed by Bob');
    mock.comment(alice._id, 'main.tex', quoteAt, quoteAt + 'Typed by Bob'.length, 'Nice sentence, Bob.');
    await page.locator('.viewer-tabs .tab', { hasText: 'Comments' }).click();
    await page.locator('.thread-card', { hasText: 'Nice sentence, Bob.' }).waitFor({ timeout: 10_000 });
    assert.match(await page.locator('.thread-card', { hasText: 'Nice sentence, Bob.' }).innerText(), /Alice Test · Overleaf/);
    await shot(page, '4-live-comment');
    assert.ok((await editorText()).includes('Alice says hi. Hello from TeXWerk. Typed by Bob.'));
  });

  await check('an expired cookie shows on the chip; a new one from the dialog fixes it', async () => {
    mock.expire('hai');
    await page.locator('.overleaf-chip', { hasText: 'cookie expired' }).waitFor({ timeout: 20_000 });
    await shot(page, '5-expired');
    mock.sessions.set('hai2', hai._id);
    await page.locator('.overleaf-chip').click();
    await page.locator('.dialog input[type="password"]').fill('hai2');
    await page.locator('.dialog button', { hasText: 'Save' }).click();
    try {
      await page.locator('.dialog .ol-status', { hasText: 'live' }).waitFor({ timeout: 15_000 });
    } catch (err) {
      throw new Error(`${(err as Error).message.split('\n')[0]}\ndialog says: ${await page.locator('.dialog').innerText()}`);
    }
    await page.locator('.dialog button', { hasText: 'Close' }).click();
    await page.locator('.overleaf-chip', { hasText: 'Overleaf · live' }).waitFor();
  });

  await check('the light theme and the dark theme both show the chip and dialog', async () => {
    await page.locator('.overleaf-chip').click();
    await shot(page, '6-dialog-light');
    await page.locator('.dialog button', { hasText: 'Close' }).click();
    await page.locator('.toolbar .theme-toggle, .toolbar button[title*="theme" i]').first().click().catch(() => {});
    await page.locator('.overleaf-chip').click();
    await shot(page, '7-dialog-dark');
    await page.locator('.dialog button', { hasText: 'Close' }).click();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  await server.close();
  await mock.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
