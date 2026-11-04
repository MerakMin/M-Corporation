import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';
import { browserOptions, safeUrl, validateConfig, createConnectors } from '../src/connectors.js';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { collectCoupangProducts, readCoupangProducts, COUPANG_PRODUCT } from '../src/coupang-product.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
// Synthetic data. Reflects the report's one-tbody-per-inquiry layout, visible
// reply rows, hidden editor and unrelated footer form. No customer data copied.
const row = ({ id = '70001', state = '추가답변', body = '테스트 문의입니다.', replies = ['확인했습니다.'], type = '상품문의' } = {}) => `<tbody><tr>
  <td>2026.11.02<br>15:30:00</td><td>***</td><td><div><a><span>테스트 상품</span></a></div><div><span>${body}</span></div></td>
  <td>${type}<br>(${id})</td><td>999999</td><td><button onclick="window.badClicks++">${state}</button></td></tr>
  ${replies.map((reply, i) => `<tr><td colspan="5"><div><div>답변(2026.11.03 09:0${i}:00)</div><div><p>${reply}</p></div></div></td><td><button onclick="window.badClicks++">비노출</button></td></tr>`).join('')}
  <tr style="display:none"><td><div><textarea>게시되지 않은 초안</textarea><button onclick="window.badClicks++">등록</button></div></td></tr></tbody>`;
const table = (rows = [row()], total = rows.length) => `<div class="grid"><div>총 ${total}개</div><div><table><thead><tr>${['등록일시', '고객명', '문의내용', '문의유형<br>(접수번호)', '주문번호', '답변여부'].map(s => `<th><div>${s}</div></th>`).join('')}</tr></thead>${rows.join('')}</table></div></div>`;
const html = (rows, total, filter = '전체') => `<main><div id="filter" onclick="document.getElementById('options').hidden=false"><span><label>답변여부</label></span><span id="filter-value">${filter}</span></div>
  <ul id="options" hidden>${['전체', '답변', '미답변'].map((v, i) => `<li><span><input id="r${i}" type="radio" name="status"><label for="r${i}" onclick="document.getElementById('filter-value').textContent='${v}';document.getElementById('options').hidden=true">${v}</label></span></li>`).join('')}</ul>
  ${table(rows, total)}<footer><textarea>의견 보내기</textarea><button onclick="window.badClicks++">등록</button></footer></main><script>window.badClicks=0</script>`;

test('쿠팡 목록은 접수번호·문의 본문·최신 원문 답변과 한국 시각을 구분한다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(html([row(), row({ id: '70002', replies: ['이전 답변', '최신 답변'] }), row({ id: '70003', state: '답변하기', replies: [] })]));
    const result = await page.evaluate(readCoupangProducts);
    assert.equal(result.error, undefined);
    assert.equal(result.total, 3);
    assert.deepEqual(result.items.map(i => i.external_id), ['70001', '70002', '70003']);
    assert.equal(result.items[1].remote_reply_body, '최신 답변');
    assert.equal(result.items[1].remote_reply_at, '2026-11-03T00:01:00.000Z');
    assert.equal(result.items[2].remote_status, 'pending');
    assert.equal(result.items[0].body, '테스트 문의입니다.');
    assert.equal(result.items[0].created_at, '2026-11-02T06:30:00.000Z');
    assert.ok(!JSON.stringify(result).includes('999999'));
    assert.equal(await page.evaluate(() => window.badClicks), 0);
    for (const [markup, error] of [
      [html([row(), row()]), /중복/],
      [html([row()], 2), /여러 페이지/],
      [html([row({ id: 'invalid' })]), /접수번호/],
      [html([row({ replies: [] })]), /답변 여부/],
      [html([row({ state: '알 수 없음' })]), /답변 여부/],
      [html([row()]).replace('2026.11.02', '2026.02.31'), /등록일시/],
      [html([row()]).replace('style="display:none"', ''), /입력창/],
      [html([row()]).replace('총 1개', '불명'), /전체 문의/],
    ]) {
      await page.setContent(markup);
      assert.match((await page.evaluate(readCoupangProducts)).error, error);
    }
    await page.setContent(html(['<tbody><tr><td colspan="6">조회된 문의가 없습니다.</td></tr></tbody>'], 0));
    assert.deepEqual((await page.evaluate(readCoupangProducts)).items, []);
  } finally { await browser.close(); }
});

test('실제 Chromium 수집은 전체 필터만 선택하고 답변·등록 버튼을 누르지 않는다', async () => {
  let content = html([row()], 1, '미답변'), writes = 0, redirected = false;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    if (redirected && req.url.startsWith('/tenants/')) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(content);
  });
  const base = await listen(server), browser = await chromium.launch(browserOptions());
  const source = { ...defaultChannelConfig('coupang').sources[1], url: `${base}/tenants/cs/product/inquiries` };
  try {
    const context = await browser.newContext();
    let clicks = 0;
    await context.exposeBinding('reportClick', () => clicks++);
    await context.addInitScript(() => Object.defineProperty(window, 'badClicks', { get: () => 0, set: v => { if (v) window.reportClick(); } }));
    const items = await collectCoupangProducts(context, { id: 'coupang' }, source, safeUrl);
    assert.equal(items[0].external_id, '70001');
    assert.equal(items[0].url, source.url);
    assert.equal(writes, 0); assert.equal(clicks, 0);
    redirected = true;
    await assert.rejects(() => collectCoupangProducts(context, { id: 'coupang' }, source, safeUrl), /로그인/);
    assert.equal(context.pages().length, 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('쿠팡 수집 API는 완료 답변을 보존하고 중복·임의 전송·혼합 저장을 막는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cs-coupang-'));
  const item = { channel: 'coupang', source: 'coupang-1', external_id: '70001', customer: '***', product: '테스트 상품', body: '테스트 문의', title: '테스트 문의', created_at: '2026-11-02T06:30:00.000Z', url: 'https://wing.coupang.com/tenants/cs/product/inquiries', remote_status: 'pending' };
  let items = [item], sends = 0;
  const app = createApp({ dataDir: directory, scheduler: false, connectors: { collect: async () => items, send: async () => sends++ } });
  const base = await listen(app.server);
  const api = async (path, method = 'POST', body = { mode: 'live' }) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const config = defaultChannelConfig('coupang'); config.enabled = true; config.sources[0].enabled = false;
    assert.equal((await api('/api/channels/coupang', 'PUT', { config })).status, 200);
    assert.equal((await api('/api/sync')).data.added, 1);
    const first = app.store.db.prepare("SELECT * FROM inquiries WHERE mode='live'").get();
    app.store.db.prepare('UPDATE inquiries SET draft=? WHERE id=?').run('사용자가 편집한 초안', first.id);
    const blocked = await api(`/api/inquiries/${first.id}/send`, 'POST', { mode: 'live', version: first.version, approved: true });
    assert.equal(blocked.status, 409); assert.equal(sends, 0);
    items = [{ ...item, remote_status: 'answered', remote_reply_body: '실제 게시된 답변', remote_reply_at: '2026-11-03T00:00:00.000Z' }];
    assert.equal((await api('/api/sync')).data.completed, 1);
    const completed = app.store.inquiry(first.id);
    assert.equal(completed.status, 'sent'); assert.equal(completed.completion_origin, 'remote_reply');
    assert.equal(completed.sent_body, '실제 게시된 답변'); assert.equal(completed.draft, '사용자가 편집한 초안');
    assert.equal((await api('/api/sync')).data.completed, 0);
    assert.equal(app.store.inquiry(first.id).version, completed.version);
    items = [{ ...items[0], remote_reply_body: '새 추가 답변', remote_reply_at: '2026-11-04T00:00:00.000Z' }];
    await api('/api/sync'); assert.equal(app.store.inquiry(first.id).sent_body, '새 추가 답변');
    // One inconsistent ID must roll back other additions in the same batch.
    items = [{ ...item, external_id: '70002' }, { ...items[0], body: '다른 문의' }];
    assert.equal((await api('/api/sync')).data.results[0].ok, false);
    assert.equal(app.store.db.prepare("SELECT count(*) n FROM inquiries WHERE mode='live'").get().n, 1);
    items = []; await api('/api/sync'); assert.equal(app.store.inquiry(first.id).status, 'sent');
    assert.equal((await api('/api/state?mode=live', 'GET')).data.inquiries[0].sent_body, '새 추가 답변');
    await assert.rejects(() => createConnectors(directory).send({ id: 'coupang', config }, item), /초안을 복사/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('쿠팡 전용 설정 이관은 사용자 매핑과 활성화 상태를 보존한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cs-coupang-migrate-'));
  try {
    for (const custom of [false, true]) {
      let store = openStore(directory);
      const config = defaultChannelConfig('coupang'); config.presetVersion = 2; config.enabled = false;
      delete config.sources[1].adapter;
      if (custom) config.sources[1].selectors = { row: '.custom-row' };
      store.db.prepare("UPDATE channels SET config=? WHERE id='coupang'").run(JSON.stringify(config)); store.close();
      store = openStore(directory);
      const migrated = store.channel('coupang').config;
      assert.equal(migrated.enabled, false);
      if (custom) { assert.equal(migrated.sources[1].adapter, undefined); assert.equal(migrated.sources[1].selectors.row, '.custom-row'); }
      else { assert.equal(migrated.sources[1].adapter, COUPANG_PRODUCT); assert.equal(migrated.sources[1].enabled, false); }
      store.close();
    }
    const config = defaultChannelConfig('coupang'); config.enabled = true; config.sources[0].enabled = false;
    assert.doesNotThrow(() => validateConfig(config, { id: 'coupang' }));
    assert.throws(() => validateConfig(config, { id: 'fashionplus' }), /쿠팡/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
