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
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}project=Paper&name=Bob`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return r.json() as Promise<Record<string, unknown>>;
};
const waitFor = async (what: string, check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await page.waitForTimeout(50);
  }
};

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

  await check('the Authors view attributes Overleaf text to "Alice Test · Overleaf"', async () => {
    await page.getByRole('button', { name: 'Authors', exact: true }).click();
    await page.locator('.authors-legend', { hasText: 'Alice Test · Overleaf' }).waitFor({ timeout: 5000 });
    await shot(page, '4b-authors');
    await page.getByRole('button', { name: 'Authors', exact: true }).click();
  });

  // Bob linked the project, so his messages are filed under the linked
  // account and go without the "[Name]" prefix other people's get.
  await check('comments from the UI: reply, resolve, reopen there, and a new thread here', async () => {
    const tid = [...mock.threads.keys()][0];
    const card = page.locator('.thread-card', { hasText: 'Nice sentence, Bob.' });
    await card.locator('textarea.reply-box').fill('Thanks, Alice.');
    await card.locator('textarea.reply-box').press('Control+Enter');
    try {
      await waitFor('reply on Overleaf', () => mock.threads.get(tid)!.messages.some((m) => m.content === 'Thanks, Alice.'));
    } catch (err) {
      throw new Error(`${(err as Error).message}; TeXWerk has ${JSON.stringify((await api('GET', '/api/comments')).threads)}; Overleaf has ${JSON.stringify(mock.threads.get(tid))}; box: ${await card.locator('textarea.reply-box').inputValue().catch(() => '?')}`);
    }
    mock.message(alice._id, tid, 'You are welcome.');
    try {
      await waitFor('Alice\'s reply in TeXWerk', async () => JSON.stringify((await api('GET', '/api/comments')).threads).includes('You are welcome.'));
    } catch (err) {
      throw new Error(`${(err as Error).message}; TeXWerk has ${JSON.stringify((await api('GET', '/api/comments')).threads)}`);
    }
    await card.getByText('You are welcome.').waitFor({ timeout: 10_000 });
    await card.getByRole('button', { name: '✓ Resolve' }).click();
    await waitFor('resolved on Overleaf', () => mock.threads.get(tid)!.resolved);
    mock.resolve(tid, false);
    await waitFor('reopened here', async () => {
      const r = await api('GET', '/api/comments') as { threads?: Array<{ resolved: boolean; messages: Array<{ text: string }> }> };
      return (r.threads ?? []).some((t) => !t.resolved && t.messages.some((m) => m.text === 'Nice sentence, Bob.'));
    });
    // A new thread made here, on the word "documentclass".
    await page.locator('.cm-line', { hasText: 'documentclass' }).getByText('documentclass').dblclick();
    await page.keyboard.press('Control+Alt+m');
    await page.locator('textarea[placeholder="Add a comment…"]').fill('Is article right?');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await waitFor('thread and range on Overleaf', () => [...mock.ranges().values()].some((r) => r.c === 'documentclass')
      && [...mock.threads.values()].some((t) => t.messages[0]?.content === 'Is article right?'));
    await shot(page, '4c-comments');
  });

  await check('files: new doc there is live here; rename there follows the open editor; create/rename/delete here reach Overleaf', async () => {
    mock.addDoc('appendix.tex', 'Appendix.\n');
    await page.locator('.tree', { hasText: 'appendix.tex' }).waitFor({ timeout: 10_000 }).catch(() => {});
    await waitFor('appendix in the tree', async () => (await page.locator('body').innerText()).includes('appendix.tex'));
    await page.goto(`${origin}/?project=Paper&file=appendix.tex`);
    await page.waitForSelector('.cm-content');
    await page.locator('.cm-line', { hasText: 'Appendix.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' More.');
    await waitFor('appendix edit on Overleaf', () => mock.text('appendix.tex') === 'Appendix. More.\n');
    mock.rename('appendix.tex', 'supplement.tex');
    await waitFor('editor follows the rename', async () => (await page.locator('body').innerText()).includes('supplement.tex') && !(await page.locator('body').innerText()).includes('appendix.tex'));
    await page.locator('.cm-line', { hasText: 'Appendix. More.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' After rename.');
    await waitFor('typing after the rename reaches Overleaf', () => mock.text('supplement.tex') === 'Appendix. More. After rename.\n');
    await api('POST', '/api/fs', { op: 'newfile', path: 'extra.tex' });
    await waitFor('new file on Overleaf', () => mock.text('extra.tex') === '');
    await api('POST', '/api/fs', { op: 'move', path: 'extra.tex', to: 'chapters/extra.tex' });
    const id = () => mock.find('chapters/extra.tex')?.id;
    await waitFor('rename on Overleaf', () => !!id() && !mock.find('extra.tex'));
    await api('POST', '/api/fs', { op: 'delete', path: 'chapters/extra.tex' });
    await waitFor('delete on Overleaf', () => !mock.find('chapters/extra.tex'));
    mock.remove('refs.bib');
    await waitFor('refs.bib gone here', async () => !(await page.locator('body').innerText()).includes('refs.bib'));
  });

  await check('typing through a dropped connection: chip reconnects, nothing lost or doubled', async () => {
    await page.goto(`${origin}/?project=Paper&file=main.tex`);
    await page.waitForSelector('.cm-content');
    await page.locator('.cm-line', { hasText: 'Typed by Bob' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' one');
    mock.dropAll();
    await page.keyboard.type(' two');
    await page.locator('.overleaf-chip', { hasText: 'reconnecting' }).waitFor({ timeout: 5000 });
    await page.keyboard.type(' three');
    await page.locator('.overleaf-chip', { hasText: 'Overleaf · live' }).waitFor({ timeout: 20_000 });
    await waitFor('both sides equal', async () => {
      const r = await fetch(`${origin}/raw/Paper/main.tex?name=Bob`).then((x) => x.text()).catch(() => '');
      return mock.text('main.tex') === r && r.includes('Typed by Bob. one two three');
    }, 15_000);
    assert.equal(mock.text('main.tex')!.split(' one two three').length - 1, 1);
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

  await check('light and dark theme, desktop and 400 px: the dialog fits (no sideways overflow)', async () => {
    const fits = async () => page.locator('.dialog').evaluate((d) => d.scrollWidth <= d.clientWidth + 1);
    await page.locator('.overleaf-chip').click();
    assert.ok(await fits(), 'fits at desktop width');
    await shot(page, '6-dialog-light');
    await page.locator('.dialog button', { hasText: 'Close' }).click();
    const theme = page.locator('.toolbar button[title*="theme" i], .toolbar .theme-toggle').first();
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await theme.click();
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.theme), before, 'theme switched');
    await page.locator('.overleaf-chip').click();
    await shot(page, '7-dialog-dark');
    await page.setViewportSize({ width: 400, height: 900 });
    assert.ok(await fits(), 'fits at 400 px');
    await shot(page, '8-dialog-narrow-dark');
    await page.locator('.dialog button', { hasText: 'Close' }).click();
    await page.setViewportSize({ width: 1500, height: 950 });
    await theme.click();
  });

  await check('unlink: the chip goes and typing no longer reaches Overleaf', async () => {
    await page.locator('.overleaf-chip').click();
    await page.locator('.dialog button', { hasText: 'Unlink' }).click();
    await page.locator('.dialog button.danger', { hasText: 'Unlink' }).last().click();
    await page.locator('.overleaf-chip').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.keyboard.press('Escape');
    const before = mock.text('main.tex');
    await page.locator('.cm-line', { hasText: 'Typed by Bob' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' after unlink');
    await page.waitForTimeout(1500);
    assert.equal(mock.text('main.tex'), before);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  await server.close();
  await mock.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
