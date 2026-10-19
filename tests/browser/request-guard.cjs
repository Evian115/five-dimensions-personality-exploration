const assert = require('node:assert/strict');
const { chromium } = require(process.argv[3] || 'playwright');
const base = process.argv[2], mode = process.argv[4];
if (!base || !['rate', 'backlog'].includes(mode)) throw new Error('Pass an isolated server URL, Playwright path and rate/backlog mode. This submits one real test result.');
const key = 'bigfive-answers:shiji-ipip60-exploratory-zh-v1';
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/assessment');
    await page.locator('#skip-test').click();
    await page.locator('.results:not([inert])').waitFor();
    const resultUrl = page.url();
    await page.locator('#reset').click(); await page.locator('button[value="confirm"]').click();
    const failed = page.waitForResponse(response => response.url().endsWith('/api/results') && response.request().method() === 'POST');
    await page.locator('#skip-test').click();
    const response = await failed;
    assert.equal(response.status(), mode === 'rate' ? 429 : 503);
    assert.ok(Number(response.headers()['retry-after']) > 0);
    await page.locator('#message').filter({ hasText: mode === 'rate' ? '访问过于频繁' : '同步任务较多' }).waitFor();
    assert.equal(await page.locator('#next').isEnabled(), true);
    const draft = await page.evaluate(key => localStorage.getItem(key), key);
    assert.equal(Object.keys(JSON.parse(draft).answers).length, 60);
    await page.reload(); await page.locator('#next').waitFor();
    assert.equal(await page.locator('.page-indicator').innerText(), '60 / 60');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), draft);
    const retry = page.waitForResponse(response => response.url().endsWith('/api/results') && response.request().method() === 'POST');
    await page.locator('#next').click(); assert.equal((await retry).status(), mode === 'rate' ? 429 : 503);
    await page.waitForFunction(() => !document.querySelector('#next')?.disabled);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), draft);
    await page.goto(resultUrl); await page.locator('.results').waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), draft);
    assert.deepEqual(errors, []);
    console.log('REQUEST_GUARD_BROWSER_REPORT: ' + JSON.stringify({ mode, status: response.status(), answersRetained: 60, refreshKeptSubmissionId: true, existingResultReadable: true, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
