const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require(process.argv[3] || 'playwright');
const base = process.argv[2];
const key = 'bigfive-answers:shiji-ipip60-exploratory-zh-v1';
const answers = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [i + 1, 3]));
if (!base) throw new Error('Pass an isolated test server URL. This script submits five independent results.');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
  try {
    const fixtureContext = await browser.newContext();
    const response = await fixtureContext.request.post(base + '/api/results', { data: { submissionId: randomUUID(), answers } });
    assert.equal(response.status(), 201); const fixture = await response.json();
    await fixtureContext.close();
    const report = {};
    for (const mode of ['failure', 'success', 'new-draft', 'timeout']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + fixture.relativePath); await page.locator('.results').waitFor();
      await page.locator('#reset').click(); await page.locator('button[value="confirm"]').click();
      await page.locator('#next').waitFor();
      await page.evaluate(({ key, answers, id }) => localStorage.setItem(key, JSON.stringify({ submissionId: id, answers })), { key, answers, id: randomUUID() });
      await page.reload(); await page.locator('#next').waitFor();
      const draft = await page.evaluate(key => localStorage.getItem(key), key);
      let release, ready, committed;
      const held = new Promise(resolve => { release = resolve; });
      const intercepted = new Promise(resolve => { ready = resolve; });
      await page.route('**/api/results', async route => {
        const saved = mode === 'failure' ? undefined : await route.fetch();
        if (saved) committed = await saved.json();
        ready(); await held;
        try { if (saved) await route.fulfill({ response: saved }); else await route.abort('failed'); }
        catch { /* The browser has already aborted a timed-out request. */ }
      });
      await page.locator('#next').click(); await intercepted;
      if (mode === 'timeout') {
        const start = Date.now();
        await page.locator('#message').filter({ hasText: '提交等待超过 30 秒' }).waitFor({ timeout: 40000 });
        assert.ok(Date.now() - start >= 28000, 'exercise the real application timeout');
        assert.equal(await page.locator('#next').isEnabled(), true);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), draft);
        release(); await page.unroute('**/api/results');
        await page.locator('#next').click(); await page.locator('.results:not([inert])').waitFor();
        assert.equal(new URL(page.url()).hash, '#' + committed.id);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
        report.timeout = { passed: true, realTimeoutSeconds: 30, fullDraftAndIdPreserved: true, retryReturnedCommittedLink: true };
      } else {
        await page.evaluate(() => history.back()); await page.locator('.results').waitFor();
        assert.equal(new URL(page.url()).hash, '#' + fixture.id);
        let newerDraft;
        if (mode === 'new-draft') {
          await page.locator('#reset').click(); await page.locator('button[value="confirm"]').click();
          await page.locator('#next').waitFor();
          const other = await context.newPage(); await other.goto(base + '/assessment');
          await other.locator('.option').nth(3).click();
          newerDraft = await other.evaluate(key => localStorage.getItem(key), key);
          await other.close();
        }
        release();
        if (mode === 'failure') {
          await page.waitForTimeout(300);
          await page.unroute('**/api/results');
          await page.evaluate(() => history.forward()); await page.locator('#next').waitFor();
          await page.waitForFunction(() => !document.querySelector('#next')?.disabled);
          assert.equal(await page.evaluate(key => localStorage.getItem(key), key), draft);
          await page.locator('#next').click(); await page.locator('.results:not([inert])').waitFor();
          report.failure = { passed: true, noNullElementError: true, canRetryAfterNavigation: true };
        } else if (mode === 'success') {
          await page.waitForFunction(key => localStorage.getItem(key) === null, key);
          assert.equal(new URL(page.url()).hash, '#' + fixture.id);
          await page.evaluate(() => history.forward()); await page.locator('#next').waitFor();
          await page.waitForFunction(() => !document.querySelector('#next')?.disabled);
          assert.equal(await page.locator('.page-indicator').innerText(), '1 / 60');
          report.success = { passed: true, didNotOverrideNavigation: true, submittedDraftCleared: true };
        } else {
          await page.waitForFunction(() => !document.querySelector('#next')?.disabled);
          assert.equal(new URL(page.url()).pathname, '/assessment');
          assert.equal(await page.evaluate(key => localStorage.getItem(key), key), newerDraft);
          report.newDraft = { passed: true, newerDraftPreserved: true, didNotOverrideNavigation: true };
        }
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('SUBMISSION_LIFECYCLE_REPORT: ' + JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
