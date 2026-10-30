'use strict';
// The web app in a real browser (see run.sh): each check is what a person would do, and any error
// the page throws along the way fails it too. BASE: the server; FILMS: its folder of two films.

const { chromium } = require('playwright');

const BASE = process.env.BASE;
let failed = 0;
const errors = [];

async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); } catch (err) { failed++; console.log(`not ok - ${name}\n  ${String(err.message).split('\n')[0]}`); }
}
const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 250));
  }
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const api = ctx.request; // (shares the browser's sign-in)
  // Wait for the server, then an admin and a film library.
  await until(() => api.get(`${BASE}/api/health`).then((r) => r.ok()).catch(() => false), 60_000);
  await api.post(`${BASE}/api/auth/setup`, { data: { username: 'admin', password: 'password1' } });
  const lib = await (await api.post(`${BASE}/api/libraries`, { data: { name: 'Films', type: 'movie', paths: [process.env.FILMS] } })).json();
  const items = await until(async () => {
    const r = await (await api.get(`${BASE}/api/libraries/${lib.id}/items`)).json();
    return r.items?.length === 2 && r.items;
  }, 60_000);
  const film = items.find((x) => x.title === 'Test Clip');

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(m.text()); });
  const open = async (hash) => { await page.goto(`${BASE}/?nointro${hash}`); await page.waitForLoadState('networkidle'); };

  await check('Home shows the films', async () => {
    await open('#/');
    await page.locator('.card').first().waitFor();
  });

  await check('a library lists its films, and its ⋯ menu changes the card size', async () => {
    await open(`#/library/${lib.id}`);
    await until(async () => (await page.locator('#lib-grid .card').count()) === 2);
    await page.click('#lib-more');
    await page.locator('.popmenu').waitFor();
    await page.locator('.popmenu button', { hasText: 'Large cards' }).click();
    const w = await page.locator('#lib-grid').evaluate((el) => el.style.getPropertyValue('--card-w'));
    if (w !== '340px') throw new Error(`card size is ${w}`);
  });

  await check('filtering a library to nothing says so', async () => {
    await page.fill('#lib-text', 'zzzz');
    await page.getByText('Nothing matches').waitFor();
  });

  await check('search: an empty search explains itself, and a search finds a film', async () => {
    await open('#/search');
    await page.getByText('Search Marquee').waitFor();
    await open('#/search?q=Second');
    await page.locator('.card', { hasText: 'Second Clip' }).first().waitFor();
  });

  await check('a page that doesn’t exist says so', async () => {
    await open('#/nowhere');
    await page.getByText('Page not found').waitFor();
  });

  await check('a film’s page opens with a Play button', async () => {
    await open(`#/item/${film.id}`);
    await page.locator('#detail-layer [data-play]').first().waitFor();
  });

  await check('the film plays', async () => {
    await open(`#/play/${film.id}?t=0`);
    await until(() => page.evaluate(() => (document.querySelector('video')?.currentTime || 0) > 1), 30_000);
  });

  await check('pressing Back while a film is still opening leaves no player behind', async () => {
    await open('#/');
    // (A slow answer, as from a busy server or a TV remote pressed quickly.)
    await page.route(`**/api/items/${film.id}`, async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    await page.evaluate((id) => { location.hash = `#/play/${id}`; }, film.id);
    await page.waitForTimeout(200);
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForTimeout(2500);
    await page.unroute(`**/api/items/${film.id}`);
    const players = await page.locator('.player').count();
    if (players) throw new Error(`${players} player(s) still open on Home`);
  });

  await check('a film in Continue Watching can be removed from its own page (as on a TV)', async () => {
    await api.post(`${BASE}/api/items/${film.id}/progress`, { data: { position: 16, stopped: true } });
    await open('#/');
    await page.locator('.hub .card').first().waitFor();
    await page.evaluate((id) => { location.hash = `#/item/${id}`; }, film.id); // (from Home, as on a TV)
    await page.locator('#detail-layer .dlg-top [data-menu]').click();
    await page.locator('.popmenu button', { hasText: 'Remove from Continue Watching' }).click();
    await until(async () => {
      const home = await (await api.get(`${BASE}/api/home`)).json();
      return !home.hubs.find((h) => h.key === 'continue')?.items.some((x) => x.id === film.id);
    });
  });

  await check('marking a film watched from its ⋯ menu can be undone', async () => {
    const before = (await (await api.get(`${BASE}/api/items/${film.id}`)).json()).progress;
    await open(`#/item/${film.id}`);
    await page.locator('#detail-layer .dlg-top [data-menu]').click();
    await page.locator('.popmenu button', { hasText: 'Mark as watched' }).click();
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await page.getByText('Put back as it was').waitFor();
    const after = (await (await api.get(`${BASE}/api/items/${film.id}`)).json()).progress;
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`progress is ${JSON.stringify(after)}, was ${JSON.stringify(before)}`);
  });

  await check('on a phone, the player’s buttons all stay on the screen', async () => {
    const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const p = await phone.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/?nointro#/play/${film.id}?t=0`);
    await p.locator('.player .p-row').waitFor();
    const off = await p.evaluate(() => [...document.querySelectorAll('.player .p-row > *')]
      .filter((el) => el.offsetParent && el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.dataset.a || el.className));
    await phone.close();
    if (off.length) throw new Error(`off the edge: ${off.join(', ')}`);
  });

  await check('phones get the bar along the bottom', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const p = await phone.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/?nointro#/`);
    await p.locator('#tabbar').waitFor({ state: 'visible' });
    await phone.close();
  });

  await check('no errors on any page', async () => { if (errors.length) throw new Error(errors.join(' | ')); });

  await browser.close();
  console.log(failed ? `# fail ${failed}` : '# fail 0');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
