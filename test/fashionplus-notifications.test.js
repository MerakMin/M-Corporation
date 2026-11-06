import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserOptions, safeUrl, createConnectors, validateConfig } from '../src/connectors.js';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { collectFashionplusNotifications, checkNotificationCompletion, notificationState } from '../src/fashionplus-notifications.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const headers = ['문의번호', '처리상태', '실적브랜드', '주문번호', '고객명', '문의유형', '문의일자', '회신기한'];
// Synthetic rows reflecting the previously documented split tables and status
// link, plus the supplied detail screenshot. No real customer data is copied.
function listHtml(number = 1, { mismatch = false, empty = false } = {}) {
  const id = number === 1 ? '9001' : '9002';
  return `<main><div class="grid"><div><table><thead><tr>${headers.map(h => `<th><div>${h}</div></th>`).join('')}</tr></thead></table></div><div><table><tbody>${empty ? '' : `<tr>${[number === 1 ? `[긴급]${id}` : id, `<a href="/notice?id=${id}" target="_blank">${number === 1 ? '답변대기' : '답변완료'}</a>`, '비욘드마이셀프', '80001-1', '가*고객', '배송문의', '2026-11-06', '-'].map(v => `<td>${v}</td>`).join('')}</tr>`}</tbody></table></div><div><ol><li><a href="?page=2">2</a></li></ol><p>of ${empty ? 0 : 2}</p><span>(${empty ? 0 : mismatch ? 3 : 2} items)</span></div></div></main>`;
}
function detailHtml({ status = '답변대기', closed = '진행', customer = '가상고객', order = '80001-1', brand = '비욘드마이셀프', body = '출고 예정일을 확인해 주세요.' } = {}) {
  const fields = { '주문번호-순번': order, '주문자': customer, '브랜드명': brand, '상품명': '테스트 상품', '문의상태': status, '문의종료여부': closed, '회신기한': '20261110', '알림내용': body };
  return `<h1>CS알리미</h1><table>${Object.entries(fields).map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('')}</table><form method="post"><button>출고 처리</button><button>취소</button><textarea>입력 금지</textarea></form>`;
}

test('CS알리미 실제 브라우저: 두 페이지·긴급 번호·원문 확인, 완료 건 포함, 주문 처리 없음', async () => {
  let bad = false, mismatch = false, redirect = false, writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (redirect && url.pathname.startsWith('/cs-center')) { res.writeHead(302, { Location: '/login' }); res.end('login'); return; }
    res.end(url.pathname === '/notice' ? detailHtml({ ...(url.searchParams.get('id') === '9002' ? { status: '답변완료', closed: '종료' } : {}), ...(bad ? { order: '999-1' } : {}) }) : listHtml(Number(url.searchParams.get('page')) || 1, { mismatch }));
  });
  const base = await listen(server), browser = await chromium.launch(browserOptions());
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(3000);
    const source = { ...defaultChannelConfig('fashionplus').sources[0], url: `${base}/cs-center/cs-notification`, maxPages: 3 };
    const channel = { id: 'fashionplus' };
    const items = await collectFashionplusNotifications(context, channel, source, safeUrl);
    assert.deepEqual(items.map(i => i.external_id), ['9001', '9002']);
    assert.ok(items.every(i => i.inquiry_kind === 'notification'));
    assert.equal(items[0].order_reference, '80001-1'); assert.equal(items[0].customer, '가상고객');
    assert.equal(items[1].remote_closed, '종료'); assert.equal(writes, 0);
    const complete = await checkNotificationCompletion(context, channel, source, items[1], safeUrl);
    assert.equal(notificationState(complete.remote_status, complete.remote_closed), 'sent');
    bad = true;
    await assert.rejects(() => collectFashionplusNotifications(context, channel, source, safeUrl), /주문번호/);
    await assert.rejects(() => checkNotificationCompletion(context, channel, source, items[1], safeUrl), /주문번호/);
    bad = false; mismatch = true;
    await assert.rejects(() => collectFashionplusNotifications(context, channel, source, safeUrl), /전체 건수/);
    mismatch = false; redirect = true;
    await assert.rejects(() => collectFashionplusNotifications(context, channel, source, safeUrl), /로그인/);
    assert.equal(writes, 0); assert.equal(context.pages().length, 0);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('CS알리미 빈 목록은 명시적인 0건으로 확인하며 완료는 종료와 상태를 함께 대조한다', async () => {
  const { readQnaList } = await import('../src/fashionplus-qna.js');
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(listHtml(1, { empty: true }));
    const result = await page.evaluate(readQnaList, { kind: 'notification', pageNumber: 1 });
    assert.equal(result.total, 0); assert.equal(result.rows.length, 0);
    await page.setContent(listHtml(1, { empty: true }).replace('(0 items)', ''));
    assert.ok((await page.evaluate(readQnaList, { kind: 'notification', pageNumber: 1 })).error);
    assert.equal(notificationState('답변완료', '종료'), 'sent');
    assert.equal(notificationState('답변완료', '진행'), 'pending');
    assert.equal(notificationState('재답변요청', '종료'), 'pending');
    assert.throws(() => notificationState('unknown', '종료'), /확인하지/);
  } finally { await browser.close(); }
});

const notice = { channel: 'fashionplus', source: 'fashionplus-0', external_id: '9001', inquiry_kind: 'notification', order_reference: '80001-1', title: '배송문의', customer: '가상고객', product: '테스트 상품', body: '출고 예정일을 확인해 주세요.', url: 'https://seller.fashionplus.co.kr/notice?id=9001', remote_status: '답변대기', remote_closed: '진행', response_due: '20261110' };
test('두 문의함 수집·저장 실패 격리, 운영 알림 초안/전송 차단, 목록 밖 종료 확인', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-notices-'));
  let batches = [{ source: 'fashionplus-0', items: [notice] }, { source: 'fashionplus-1', items: [{ channel: 'fashionplus', source: 'fashionplus-1', external_id: '9001', detail_external_id: '9001', body: '고객 문의입니다.' }] }];
  let observed = { remote_status: '답변대기', remote_closed: '진행', response_due: '20261110' };
  const app = createApp({ dataDir: dir, scheduler: false, connectors: {
    collectSources: async () => batches,
    checkCompletions: async (channel, rows) => rows.map(row => row.inquiry_kind === 'notification' ? { id: row.id, notification: observed } : { id: row.id, status: '답변대기' }),
  } });
  const base = await listen(app.server);
  const api = async (path, method = 'POST', data = { mode: 'live' }) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const config = defaultChannelConfig('fashionplus'); config.enabled = true;
    assert.equal((await api('/api/channels/fashionplus', 'PUT', { config })).status, 200);
    assert.equal((await api('/api/sync')).data.added, 2);
    const row = app.store.db.prepare("SELECT * FROM inquiries WHERE mode='live' AND inquiry_kind='notification'").get();
    assert.equal(row.draft, ''); assert.equal(row.sent_body, null);
    for (const action of ['send', 'regenerate', '']) {
      assert.equal((await api(`/api/inquiries/${row.id}${action ? '/' + action : ''}`, action ? 'POST' : 'PATCH', { mode: 'live', version: row.version, approved: true, draft: '送信', category: '기타' })).status, 409);
    }
    await assert.rejects(() => createConnectors(dir).send({ id: 'fashionplus', config }, row), /운영 알림/);
    // Source failure leaves the successful customer inbox intact.
    batches = [{ source: 'fashionplus-0', error: 'CS알리미: 화면 확인 필요' }, { source: 'fashionplus-1', items: [{ channel: 'fashionplus', source: 'fashionplus-1', external_id: '9002', detail_external_id: '9002', body: '두 번째 고객 문의' }] }];
    const partial = (await api('/api/sync')).data;
    assert.equal(partial.added, 1); assert.equal(partial.results[0].ok, false);
    observed = { ...observed, remote_status: '답변완료', remote_closed: '종료' };
    batches = [{ source: 'fashionplus-0', items: [] }, { source: 'fashionplus-1', items: [] }];
    assert.equal((await api('/api/sync')).data.completed, 1);
    const done = app.store.inquiry(row.id);
    assert.equal(done.status, 'sent'); assert.equal(done.sent_body, null); assert.equal(done.sent_at, null);
    assert.equal((await api('/api/sync')).data.completed, 0);
    assert.equal(app.store.inquiry(row.id).version, done.version);
    // A changed source identity rolls back only that source's batch.
    batches = [{ source: 'fashionplus-0', items: [{ ...notice, body: '다른 알림' }] }, { source: 'fashionplus-1', items: [{ channel: 'fashionplus', source: 'fashionplus-1', external_id: '9003', detail_external_id: '9003', body: '세 번째 고객 문의' }] }];
    const changed = (await api('/api/sync')).data;
    assert.equal(changed.added, 1); assert.equal(changed.results[0].ok, false);
    assert.equal(app.store.inquiry(row.id).body, notice.body);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CS알리미 이관은 기존 고객문의 설정·데이터·사용자 매핑을 보존한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-notice-migrate-'));
  let store = openStore(dir);
  try {
    const config = store.channel('fashionplus').config;
    config.presetVersion = 4; config.enabled = true; delete config.sources[0].adapter; delete config.sources[0].expectedBrand;
    store.db.prepare("UPDATE channels SET config=? WHERE id='fashionplus'").run(JSON.stringify(config));
    store.addInquiry('live', { channel: 'fashionplus', source: 'fashionplus-1', external_id: 'old', body: '기존 문의' });
    store.close(); store = openStore(dir);
    const migrated = store.channel('fashionplus').config;
    assert.equal(migrated.enabled, true); assert.equal(migrated.sources[0].enabled, false);
    assert.deepEqual(migrated.sources[1], config.sources[1]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM inquiries WHERE mode='live'").get().n, 1);
    migrated.presetVersion = 4; delete migrated.sources[0].adapter; migrated.sources[0].selectors = { ready: '.custom' };
    store.db.prepare("UPDATE channels SET config=? WHERE id='fashionplus'").run(JSON.stringify(migrated));
    store.close(); store = openStore(dir);
    assert.equal(store.channel('fashionplus').config.sources[0].adapter, undefined);
    const both = defaultChannelConfig('fashionplus'); both.enabled = true;
    assert.doesNotThrow(() => validateConfig(both, { id: 'fashionplus' }));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
