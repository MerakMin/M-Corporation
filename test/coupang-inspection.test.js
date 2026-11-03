import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserOptions } from '../src/connectors.js';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { validateCoupangInspectionSource, selectCoupangDetailPage, captureCoupangStructure } from '../src/coupang-inspection.js';

const inbox = 'https://wing.coupang.com/tenants/cs/product/inquiries';

test('쿠팡 진단은 제공된 문의함과 출처만 허용한다', () => {
  const [center, product] = defaultChannelConfig('coupang').sources;
  assert.equal(validateCoupangInspectionSource(product, 'product'), inbox);
  assert.equal(validateCoupangInspectionSource(center, 'center'), center.url);
  for (const source of [center, { ...product, url: 'https://example.com/tenants/cs/product/inquiries' },
    { ...product, url: 'https://wing.coupang.com/login' }, { ...product, url: inbox.replace('https://', 'https://secret@') }]) {
    assert.throws(() => validateCoupangInspectionSource(source, 'product'), /주소 설정/);
  }
});

test('쿠팡 진단은 로그인·다른 문의함을 거부하고 고객 내용·입력값을 내보내거나 답변하지 않는다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const context = await browser.newContext();
    let writes = 0;
    await context.route('**/*', route => {
      if (route.request().method() !== 'GET') writes++;
      return route.fulfill({ contentType: 'text/html', body: '<main>fixture</main>' });
    });
    const page = await context.newPage();
    await page.goto(inbox);
    await page.setContent(`<table><thead><tr><th>문의번호</th><th>문의내용</th></tr></thead>
      <tbody><tr data-id="private-id"><td>private-customer</td><td>private-body</td></tr></tbody></table>
      <form method="post"><textarea name="private-name">private-answer</textarea><button>답변 등록</button></form>
      <iframe src="https://other.example/private-url"></iframe>`);
    const report = await captureCoupangStructure(page, inbox, true);
    assert.equal(report.locationChecked, true);
    assert.ok(!JSON.stringify(report).includes('private-'));
    assert.ok(!JSON.stringify(report).includes('coupang.com'));
    assert.ok(report.frames.some(frame => frame.skipped === 'different-origin'));
    assert.equal(await page.locator('textarea').inputValue(), 'private-answer');
    assert.equal(writes, 0);
    await page.setContent('<input type="password" value="private-password">');
    await assert.rejects(() => captureCoupangStructure(page, inbox), /로그인 화면/);
    await page.goto('https://wing.coupang.com/tenants/cs/csinquiry');
    await assert.rejects(() => captureCoupangStructure(page, inbox, true), /목록 페이지/);
    await page.goto('https://wing.coupang.com/login');
    await assert.rejects(() => captureCoupangStructure(page, inbox), /문의 화면/);
    await page.goto('https://other.example/tenants/cs/detail');
    await assert.rejects(() => captureCoupangStructure(page, inbox), /문의 화면/);
  } finally { await browser.close(); }
});

test('상세 진단은 오래된 창을 무시하고 현재 목록에서 연 팝업 또는 같은 탭을 사용한다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>fixture</main>' }));
    const list = await context.newPage();
    await list.goto(inbox);
    const stale = await context.newPage();
    await stale.goto(inbox + '/old');
    const before = new Set(context.pages());
    assert.equal(await selectCoupangDetailPage(context, list, before), list);
    const unrelated = await context.newPage();
    await unrelated.goto(inbox + '/unrelated');
    assert.equal(await selectCoupangDetailPage(context, list, before), list);
    const openPopup = async () => {
      const popupReady = list.waitForEvent('popup');
      await list.evaluate(() => window.open('/tenants/cs/product/inquiries/detail', '_blank'));
      const popup = await popupReady;
      await popup.waitForLoadState();
      return popup;
    };
    const detail = await openPopup();
    assert.equal(await selectCoupangDetailPage(context, list, before), detail);
    const second = await openPopup();
    await assert.rejects(() => selectCoupangDetailPage(context, list, before), /여러 개/);
    await second.close();
    await detail.close();
    assert.equal(await selectCoupangDetailPage(context, list, before), list);
  } finally { await browser.close(); }
});
