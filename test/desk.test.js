import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { AppError, classify, makeDraft, DEFAULT_TEMPLATES, missingFields } from '../src/domain.js';
import { openStore } from '../src/store.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => server.close(resolve));
async function setup(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-desk-test-'));
  const app = createApp({ dataDir, scheduler: false, ...options });
  const base = await listen(app.server);
  const api = async (path, body, method = 'POST', extra = {}) => {
    const res = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { app, dataDir, api, base, async close() { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('문의를 7가지 유형으로 분류하고 모르는 정보는 빈칸으로 유지한다', () => {
  for (const [text, expected] of [['배송 언제 와요', '배송'], ['반품 접수', '반품'], ['불량 교환 배송비', '교환'], ['카드 환불', '환불'], ['쿠폰 할인', '할인'], ['178cm 72kg 사이즈', '사이즈'], ['세탁 방법', '기타']]) assert.equal(classify(text), expected);
  const draft = makeDraft({ category: '배송' }, DEFAULT_TEMPLATES, '테스트몰', []);
  assert.match(draft, /테스트몰/); assert.deepEqual(missingFields(draft), ['[입고 예정일]']);
  assert.match(makeDraft({ category: '사이즈', product: '없는 상품' }, DEFAULT_TEMPLATES, '테스트몰', []), /\[상품 실측 정보 확인\]/);
});

test('예시/실제 데이터 분리, 미검토·빈칸·오래된 버전 전송 차단, 초안 영속 저장', async () => {
  const ctx = await setup();
  try {
    const demo = (await ctx.api('/state?mode=demo')).data;
    assert.equal(demo.inquiries.length, 10);
    assert.equal((await ctx.api('/state?mode=live')).data.inquiries.length, 0);
    const row = demo.inquiries[0];
    const send = body => ctx.api(`/inquiries/${row.id}/send`, { mode: 'demo', version: row.version, ...body });
    assert.equal((await send({})).status, 400);
    assert.equal((await send({ approved: true })).status, 400);
    assert.equal((await send({ approved: true, version: 0 })).status, 409);
    assert.equal((await send({ approved: true, mode: 'live' })).status, 404);
    const saved = await ctx.api(`/inquiries/${row.id}`, { mode: 'demo', version: row.version, draft: '고객님, 주문 확인 후 내일 출고 예정입니다.', category: '배송' }, 'PATCH');
    assert.equal(saved.status, 200);
    const results = await Promise.all([1, 2].map(() => send({ approved: true, version: saved.data.version })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const result = (await ctx.api('/state?mode=demo')).data;
    const sent = result.inquiries.find(i => i.id === row.id);
    assert.equal(sent.status, 'sent');
    assert.equal(result.events.filter(e => e.action === 'sent').length, 1);
    assert.equal((await ctx.api('/state?mode=live')).data.inquiries.length, 0);
    const reopened = openStore(ctx.dataDir);
    assert.equal(reopened.inquiry(row.id).sent_body, saved.data.draft);
    reopened.close();
  } finally { await ctx.close(); }
});

test('상품 실측 검증, 중복 상품 갱신 및 사이즈 초안 반영', async () => {
  const ctx = await setup();
  try {
    const bad = await ctx.api('/products', { mode: 'live', products: [{ name: '셔츠', sizes: [{ size: 'M', chest: -1 }] }] });
    assert.equal(bad.status, 400);
    for (const chest of [50, 52]) assert.equal((await ctx.api('/products', { mode: 'live', products: [{ name: '셔츠', sizes: [{ size: 'M', chest }] }] })).status, 200);
    const { data } = await ctx.api('/state?mode=live');
    assert.equal(data.products.length, 1); assert.equal(data.products[0].sizes[0].chest, 52);
    ctx.app.store.addInquiry('live', { channel: 'cafe24', source: 'cafe24-0', external_id: 'size-test', body: '사이즈 문의합니다', title: '사이즈', product: '셔츠' });
    const row = (await ctx.api('/state?mode=live')).data.inquiries[0];
    assert.match(row.draft, /M: 가슴 52cm/); assert.match(row.draft, /개인차/); assert.equal(row.missing.length, 0);
    assert.equal((await ctx.api('/state?mode=demo')).data.products.length, 1);
  } finally { await ctx.close(); }
});

test('다른 출처의 변경 요청, 잘못된 설정과 요청 형식 차단', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.api('/sync', { mode: 'demo' }, 'POST', { Origin: 'https://other.example' })).status, 403);
    const source = { id: 'cafe24-0', name: '테스트', url: 'javascript:alert(1)', selectors: {} };
    assert.equal((await ctx.api('/channels/cafe24', { config: { enabled: false, sources: [source] } }, 'PUT')).status, 400);
    assert.equal((await ctx.api('/channels/cafe24', { config: { enabled: true, sources: [{ ...source, url: 'https://example.com' }] } }, 'PUT')).status, 400);
    assert.equal((await ctx.api('/sync', { mode: 'other' })).status, 400);
    assert.equal((await fetch(`${ctx.base}/api/sync`, { method: 'POST', body: 'mode=live' })).status, 415);
  } finally { await ctx.close(); }
});

test('한 채널 실패 후에도 나머지 채널 수집, 불명확한 전송 자동 재시도 금지', async () => {
  let sends = 0;
  const ctx = await setup({ connectors: {
    async collect(c) { if (c.id === 'cafe24') throw new AppError('로그인이 필요합니다.'); return [{ channel: c.id, source: `${c.id}-0`, external_id: 'safe-1', title: '기타', body: '문의', product: '' }]; },
    async send() { sends++; const error = new AppError('게시 결과 확인 불가'); error.uncertain = true; throw error; },
  } });
  try {
    for (const id of ['cafe24', 'smartstore']) ctx.app.store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify({ enabled: true, sources: [{ id: `${id}-0` }] }), id);
    const first = await ctx.api('/sync', { mode: 'live' });
    assert.equal(first.status, 200); assert.equal(first.data.results[0].ok, false); assert.equal(first.data.results[1].added, 1);
    assert.equal((await ctx.api('/sync', { mode: 'live' })).data.added, 0);
    let row = (await ctx.api('/state?mode=live')).data.inquiries[0];
    row = (await ctx.api(`/inquiries/${row.id}`, { mode: 'live', version: row.version, draft: '확인해 주셔서 감사합니다.', category: '기타' }, 'PATCH')).data;
    const result = await ctx.api(`/inquiries/${row.id}/send`, { mode: 'live', version: row.version, approved: true });
    assert.equal(result.status, 409);
    row = (await ctx.api('/state?mode=live')).data.inquiries[0]; assert.equal(row.status, 'uncertain');
    assert.equal((await ctx.api(`/inquiries/${row.id}/send`, { mode: 'live', version: row.version, approved: true })).status, 409);
    assert.equal(sends, 1);
    assert.equal((await ctx.api(`/inquiries/${row.id}/resolve`, { mode: 'live', version: row.version, confirmed: true, outcome: 'sent' })).data.status, 'sent');
  } finally { await ctx.close(); }
});

test('재시작 시 전송 중이던 문의는 확인 필요로 복구한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-recovery-'));
  try {
    let store = openStore(dir);
    const id = store.db.prepare('SELECT id FROM inquiries LIMIT 1').get().id;
    store.db.prepare("UPDATE inquiries SET status='sending' WHERE id=?").run(id); store.close();
    store = openStore(dir); assert.equal(store.inquiry(id).status, 'uncertain'); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('실제 Chromium으로 페이지네이션 수집·중복 제거·게시·상품 실측 추출', { timeout: 120000 }, async () => {
  const replies = new Map(); let posted = 0;
  const fixture = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/post' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw); replies.set(params.get('id'), params.get('reply')); posted++;
      res.writeHead(303, { Location: `/detail/${params.get('id')}` }); res.end(); return;
    }
    if (url.pathname === '/product') { res.end('<h1>테스트 셔츠</h1><table><tbody><tr><td class="size">L</td><td class="chest">61cm</td><td class="length">76</td></tr></tbody></table>'); return; }
    if (url.pathname.startsWith('/detail/')) {
      const id = url.pathname.split('/').at(-1);
      res.end(`<main data-id="${id}"><h1>배송 문의</h1><form method="post" action="/post"><input type="hidden" name="id" value="${id}"><textarea name="reply"></textarea><button type="submit">전송</button></form>${replies.has(id) ? `<p class="posted">${replies.get(id)}</p>` : ''}</main>`); return;
    }
    const second = url.searchParams.get('page') === '2'; const id = second ? 'two' : 'one';
    res.end(`<main class="list"><article data-id="${id}"><span class="customer">테스트 고객</span><h2>배송 문의</h2><p class="body">주문한 상품 언제 배송되나요?</p><span class="product">테스트 셔츠</span><a class="detail" href="/detail/${id}">상세</a></article></main>${second ? '' : '<a class="next" href="/?page=2">다음</a>'}`);
  });
  const fixtureUrl = await listen(fixture);
  const ctx = await setup();
  try {
    const config = { enabled: true, sources: [{ id: 'cafe24-0', name: '테스트 게시판', url: fixtureUrl, maxPages: 3, selectors: { ready: '.list', row: 'article', idAttribute: 'data-id', title: 'h2', body: '.body', customer: '.customer', product: '.product', link: '.detail', next: '.next', detailIdentity: 'main', detailIdAttribute: 'data-id', editor: 'textarea', submit: 'button[type=submit]', postedReply: '.posted' } }] };
    assert.equal((await ctx.api('/channels/cafe24', { config }, 'PUT')).status, 200);
    const collected = await ctx.api('/sync', { mode: 'live' });
    assert.equal(collected.data.added, 2, JSON.stringify(collected.data));
    assert.equal((await ctx.api('/sync', { mode: 'live' })).data.added, 0);
    assert.equal(posted, 0, '수집은 절대 전송하지 않는다');
    let row = (await ctx.api('/state?mode=live')).data.inquiries[0];
    assert.equal(row.category, '배송');
    row = (await ctx.api(`/inquiries/${row.id}`, { mode: 'live', version: row.version, category: '배송', draft: '안녕하세요. 내일 출고 예정입니다. 감사합니다.' }, 'PATCH')).data;
    const sent = await ctx.api(`/inquiries/${row.id}/send`, { mode: 'live', version: row.version, approved: true });
    assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.status, 'sent');
    assert.equal(posted, 1); assert.equal(replies.get(row.external_id), row.draft);
    assert.equal((await ctx.api(`/inquiries/${row.id}/send`, { mode: 'live', version: sent.data.version, approved: true })).status, 409);
    assert.equal(posted, 1);
    const measured = await ctx.api('/products/collect', { mode: 'live', config: { urls: [`${fixtureUrl}/product`], selectors: { name: 'h1', row: 'tbody tr', size: '.size', chest: '.chest', length: '.length' } } });
    assert.equal(measured.status, 200, JSON.stringify(measured.data));
    assert.equal((await ctx.api('/state?mode=live')).data.products[0].sizes[0].chest, 61);
  } finally { await ctx.close(); await stop(fixture); }
});
