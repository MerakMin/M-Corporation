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
import { FASHIONPLUS_QNA, collectFashionplusQna, readQnaList, matchesCustomer } from '../src/fashionplus-qna.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const fields = ['긴급', '문의번호', '문의유형', '실적브랜드', '주문번호', '상품코드', '제목', '고객명', '연락처', '문의일자/문의시간', '처리상태'];
// Synthetic content only. The split tables, nested labels, pager and detail
// table reflect the supplied structural report, with no customer data copied.
function listHtml(rows, total, pages, next = true) {
  return `<h1>고객문의 게시판</h1><div class="owner"><div>답변대기</div><div class="grid"><div><div><table><thead><tr>${fields.map(label => `<th><div>${label}</div><button></button></th>`).join('')}</tr></thead></table></div><div><table><tbody>${rows.map(({ id, status = '답변대기', brand = '비욘드마이셀프', customer = '가상 고객', href = `/detail?id=${id}` }) => `<tr>${['-', id, '상품', brand, '0', '999', `<p><a href="${href}"><span>테스트 배송 문의</span></a></p>`, customer, '사용하지 않는 값', '2026-10-23', status].map(v => `<td><div>${v}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div></div></div><div class="pager"><div><ol><li><a href="javascript:void(0)"><span>1</span></a></li>${next && pages > 1 ? '<li><a href="?page=2"><span>2</span></a></li>' : ''}</ol></div><div><label><input value="1"></label><button>이동</button><p>of <strong>${pages}</strong></p> <span>(${total} items)</span></div></div></div>`;
}
function detailHtml(id, { customer = '가상 고객', brand = '비욘드마이셀프', status = '미확인', body = '언제 배송되나요?\n두 번째 줄' } = {}) {
  const data = { '문의유형': '상품', '문의상태': status, '주문번호': '0', '고객명': customer, '문의번호': id, '상품명': '[1] 테스트 셔츠', '브랜드명': `[1] ${brand}`, '문의내용': body.replaceAll('\n', '<br>') };
  return `<h1>고객문의 게시판</h1><form method="post" action="/post"><table><tbody><tr style="display:none"><th>문의번호</th><td>숨긴 값</td></tr>${Object.entries(data).map(([label, value]) => `<tr><th><b>${label}</b></th><td><p>${value}</p></td></tr>`).join('')}<tr><th><b>답변</b></th><td><textarea>기본 인사말은 게시된 답변이 아닙니다.</textarea></td></tr><tr style="display:none"><td><textarea>숨긴 답변</textarea></td></tr></tbody></table><button>고객에게 답변완료</button></form>`;
}
async function fixture() {
  let scenario = 'normal'; let posts = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST') { posts++; res.end('posted'); return; }
    if (url.pathname === '/login') { res.end('<h1>로그인</h1>'); return; }
    if (scenario === 'login') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    if (url.pathname === '/detail') {
      let id = url.searchParams.get('id');
      if (scenario === 'separate-ids') id = String(Number(id) + 1000);
      if (scenario === 'invalid-id') id = 'not-an-id';
      res.end(detailHtml(scenario === 'identity' ? '9999' : id, { customer: scenario === 'wrong-customer' ? '다른 고객' : '가상 고객', brand: scenario === 'detail-brand' ? '다른 브랜드' : '비욘드마이셀프', status: scenario === 'race' ? '답변완료' : '미확인', ...(scenario === 'empty-body' ? { body: '' } : {}) })); return;
    }
    if (['popup', 'popup-wrong', 'popup-target'].includes(scenario)) {
      let html = listHtml([{ id: '1001' }, { id: '1002' }], 2, 1);
      if (scenario === 'popup-target') html = html.replaceAll('<a href="/detail', '<a target="_blank" href="/detail');
      else html += `<script>document.querySelectorAll('tbody tr').forEach(tr => {
        const id = tr.cells[1].innerText.trim();
        const a = tr.querySelector('a');
        a.href = '/detail?id=9999';
        a.onclick = event => { event.preventDefault(); window.open('/detail?id=' + (${scenario === 'popup-wrong'} ? '9999' : id), 'qna-detail'); };
      });</script>`;
      res.end(html); return;
    }
    if (scenario === 'delayed-counter') {
      res.end(listHtml([{ id: '1001' }], 1, 1).replace('class="pager"', 'class="pager" style="display:none"') + '<script>setTimeout(() => document.querySelector(".pager").style.display = "", 600)</script>'); return;
    }
    if (scenario === 'empty') { res.end(listHtml([], 0, 0)); return; }
    if (scenario === 'missing-rows') { res.end(listHtml([], 2, 1)); return; }
    if (scenario === 'layout') { res.end('<table><thead><tr><th>문의번호</th></tr></thead></table>'); return; }
    const second = url.searchParams.get('page') === '2';
    if (['pages', 'partial', 'duplicate', 'changed-total', 'limit'].includes(scenario)) {
      res.end(listHtml([{ id: second && scenario !== 'duplicate' ? '1002' : '1001' }], scenario === 'changed-total' && second ? 3 : 2, 2, scenario !== 'partial')); return;
    }
    const first = { id: '1001', customer: scenario === 'separate-ids' ? '가* 고객' : '가상 고객', brand: scenario === 'list-brand' ? '다른 브랜드' : '비욘드마이셀프', status: scenario === 'unknown-status' ? '확인중' : '답변대기', ...(scenario === 'foreign-link' ? { href: 'https://example.com/detail' } : {}) };
    res.end(listHtml([first, { id: '1002' }, { id: '1003', status: '답변완료' }], 3, 1));
  });
  const base = await listen(server);
  return { base, setScenario(value) { scenario = value; }, posts: () => posts, close: () => new Promise(resolve => server.close(resolve)) };
}
const channelAt = base => {
  const config = defaultChannelConfig('fashionplus');
  config.enabled = true; config.sources[0].enabled = false;
  config.sources[1].url = `${base}/cs-center/qna?status=1`;
  return { id: 'fashionplus', config };
};

test('패션플러스 전용 수집: 상세 본문·상품, 완료 제외, 페이지 검증, 읽기만 수행', { timeout: 120000 }, async () => {
  const site = await fixture();
  const browser = await chromium.launch(browserOptions());
  const context = await browser.newContext(); context.setDefaultTimeout(2000);
  const channel = channelAt(site.base);
  const source = channel.config.sources[1];
  const collect = () => collectFashionplusQna(context, channel, source, safeUrl);
  try {
    const items = await collect();
    assert.deepEqual(items.map(item => item.external_id), ['1001', '1002']);
    assert.equal(items[0].body, '언제 배송되나요?\n두 번째 줄');
    assert.equal(items[0].product, '테스트 셔츠');
    assert.equal(items[0].customer, '가상 고객');
    assert.equal(items[0].source, 'fashionplus-1');
    site.setScenario('pages'); assert.equal((await collect()).length, 2);
    for (const scenario of ['popup', 'popup-target']) {
      site.setScenario(scenario);
      const clicked = await collect();
      assert.deepEqual(clicked.map(row => row.external_id), ['1001', '1002']);
      assert.ok(clicked.every(row => row.url.endsWith(`id=${row.external_id}`)), '저장한 원문은 실제 열린 상세 주소다');
      assert.equal(context.pages().length, 0, '수집에 사용한 목록과 팝업을 모두 닫는다');
    }
    site.setScenario('popup-wrong');
    await assert.rejects(collect, /같은 상세 문의번호/);
    assert.equal(context.pages().length, 0);

    site.setScenario('separate-ids');
    const separate = await collect();
    assert.deepEqual(separate.map(row => [row.external_id, row.detail_external_id]), [['1001', '2001'], ['1002', '2002']]);
    site.setScenario('delayed-counter'); assert.equal((await collect()).length, 1);
    site.setScenario('empty'); assert.deepEqual(await collect(), []);
    site.setScenario('race'); assert.deepEqual(await collect(), []);
    for (const [scenario, message] of [
      ['identity', /같은 상세 문의번호/], ['invalid-id', /문의번호 형식/], ['wrong-customer', /고객명/], ['list-brand', /브랜드명/], ['detail-brand', /브랜드명/],
      ['partial', /다음 페이지/], ['duplicate', /중복/], ['changed-total', /건수가 변경/],
      ['missing-rows', /전체 건수/], ['layout', /열 제목/], ['login', /로그인 상태/],
      ['empty-body', /비어 있는/], ['unknown-status', /처리상태/], ['foreign-link', /다른 사이트/],
    ]) {
      site.setScenario(scenario);
      await assert.rejects(collect, message, scenario);
    }
    site.setScenario('limit'); source.maxPages = 1;
    await assert.rejects(collect, /페이지 한도/);
    assert.equal(site.posts(), 0);
  } finally { await context.close(); await browser.close(); await site.close(); }
});

test('전용 수집기를 CSS 없이 활성화하고 수집·중복 제거·API 전송 차단을 검증한다', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-qna-api-'));
  const site = await fixture();
  const app = createApp({ dataDir: dir, scheduler: false });
  const base = await listen(app.server);
  const api = async (path, body, method = 'POST') => {
    const response = await fetch(`${base}/api${path}`, { method: body ? method : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const channel = channelAt(site.base);
    site.setScenario('separate-ids');
    assert.equal((await api('/channels/fashionplus', { config: channel.config }, 'PUT')).status, 200);
    assert.equal((await api('/sync', { mode: 'live' })).data.added, 2);
    assert.equal((await api('/sync', { mode: 'live' })).data.added, 0);
    let row = (await api('/state?mode=live')).data.inquiries[0];
    assert.equal(row.detail_external_id, String(Number(row.external_id) + 1000));
    assert.match(row.sendBlockedReason, /원문에서 답변/);
    row = (await api(`/inquiries/${row.id}`, { mode: 'live', version: row.version, category: '배송', draft: '확인 후 안내드리겠습니다.' }, 'PATCH')).data;
    const result = await api(`/inquiries/${row.id}/send`, { mode: 'live', version: row.version, approved: true });
    assert.equal(result.status, 409);
    assert.equal(app.store.inquiry(row.id).status, 'pending');
    assert.equal(app.store.inquiry(row.id).version, row.version);
    assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM events WHERE action='send_approved'").get().n, 0);
    await assert.rejects(() => createConnectors(dir).send(channel, row), /수집·초안/);
    assert.equal(site.posts(), 0);
    site.setScenario('identity');
    const failed = await api('/sync', { mode: 'live' });
    assert.equal(failed.data.results[0].ok, false);
    assert.equal((await api('/state?mode=live')).data.inquiries.length, 2);
    assert.equal((await api('/state?mode=demo')).data.inquiries[0].sendBlockedReason, null);
  } finally { await app.close(); await site.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Q&A 설정 검증 및 이관은 사용자 매핑을 보존하고 자동 수집을 켜지 않는다', async () => {
  const config = defaultChannelConfig('fashionplus'); config.enabled = true; config.sources[0].enabled = false;
  assert.doesNotThrow(() => validateConfig(config, { id: 'fashionplus' }));
  for (const change of [{ adapter: 'unknown' }, { expectedBrand: '' }, { url: 'https://example.com/cs-center/qna' }, { url: 'https://seller.fashionplus.co.kr/cs-center/cs-notification' }]) {
    const bad = structuredClone(config); Object.assign(bad.sources[1], change);
    assert.throws(() => validateConfig(bad, { id: 'fashionplus' }));
  }
  assert.throws(() => validateConfig(config, { id: 'cafe24' }));
  const dir = await mkdtemp(join(tmpdir(), 'cs-qna-migration-'));
  let store = openStore(dir);
  try {
    for (const version of [1, 3]) for (const custom of [false, true]) {
      const old = defaultChannelConfig('fashionplus'); old.presetVersion = version;
      delete old.sources[1].adapter; delete old.sources[1].expectedBrand;
      if (custom) old.sources[1].selectors = { ready: '.custom' };
      store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(old), 'fashionplus');
      store.close(); store = openStore(dir);
      const saved = store.channel('fashionplus').config;
      assert.equal(saved.enabled, false);
      assert.deepEqual(saved.sources[0], old.sources[0]);
      if (custom) assert.deepEqual(saved.sources[1], old.sources[1]);
      else { assert.equal(saved.sources[1].adapter, FASHIONPLUS_QNA); assert.equal(saved.sources[1].enabled, false); }
      store.close(); store = openStore(dir);
      assert.deepEqual(store.channel('fashionplus').config, saved);
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('건수 표시가 문단 밖에 분리되어도 읽고 표 안의 문구·숨은 표시·충돌은 구분한다', async () => {
  const browser = await chromium.launch(browserOptions());
  const page = await browser.newPage();
  const base = listHtml([{ id: '1001' }], 1, 1);
  try {
    for (const html of [
      '<p>of <strong>1</strong></p> (1 items)',
      '<p>of <strong>1</strong></p><span>(1 items)</span>',
      '<span>of <b>1</b></span><div>(1 items)</div>',
      '<p> of&nbsp; <strong>1</strong>\n ( 1 item ) </p>',
    ]) {
      await page.setContent(base);
      await page.locator('.pager > div').last().evaluate((el, html) => { el.innerHTML = html; }, html);
      const snapshot = await page.evaluate(readQnaList);
      assert.equal(snapshot.error, undefined, html);
      assert.equal(snapshot.pages, 1); assert.equal(snapshot.total, 1);
      assert.deepEqual(snapshot.rows.map(row => row.external_id), ['1001']);
    }
    await page.setContent(base);
    await page.locator('.pager').evaluate(el => { el.insertAdjacentHTML('beforeend', '<div hidden>of 99 (999 items)</div>'); });
    assert.equal((await page.evaluate(readQnaList)).total, 1);
    await page.locator('.pager').evaluate(el => { el.insertAdjacentHTML('beforeend', '<p>of 2 (20 items)</p>'); });
    assert.match((await page.evaluate(readQnaList)).error, /전체 건수/);
    await page.setContent(base);
    await page.locator('.pager p').evaluate(el => el.remove());
    await page.locator('tbody tr td').nth(6).evaluate(el => { el.innerHTML = '<p>of 1 (1 items)</p>'; });
    assert.match((await page.evaluate(readQnaList)).error, /전체 건수/);
  } finally { await browser.close(); }
});


test('목록·상세 번호를 별도 보존하고 기존 초안·DB 이관 및 연결 변경을 검증한다', async () => {
  assert.equal(matchesCustomer('가* 고객', '가상 고객'), true);
  assert.equal(matchesCustomer('가* 고객', '다른 고객'), false);
  assert.equal(matchesCustomer('***', '가상객'), false);
  const dir = await mkdtemp(join(tmpdir(), 'cs-qna-identities-'));
  let store = openStore(dir);
  try {
    const original = store.db.prepare('SELECT id,draft FROM inquiries LIMIT 1').get();
    store.db.exec('ALTER TABLE inquiries DROP COLUMN detail_external_id');
    store.close(); store = openStore(dir);
    assert.equal(store.inquiry(original.id).draft, original.draft);
    assert.equal(store.inquiry(original.id).detail_external_id, '');
    const item = { channel: 'fashionplus', source: 'fashionplus-1', external_id: '1001', body: '문의', customer: '가상 고객' };
    assert.equal(store.addInquiry('live', item), 1);
    assert.equal(store.addInquiry('live', { ...item, detail_external_id: '2001' }), 0);
    const saved = store.db.prepare("SELECT * FROM inquiries WHERE mode='live'").get();
    assert.equal(saved.detail_external_id, '2001');
    assert.throws(() => store.addInquiry('live', { ...item, detail_external_id: '2002' }), /연결이 달라졌습니다/);
    assert.throws(() => store.addInquiry('live', { ...item, external_id: '1002', detail_external_id: '2001' }), /이미 연결된/);
    assert.equal(store.inquiry(saved.id).detail_external_id, '2001');
    store.close(); store = openStore(dir);
    assert.equal(store.inquiry(saved.id).detail_external_id, '2001');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
