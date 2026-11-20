import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { collectCoupangCenter } from '../src/coupang-center.js';

const source = defaultChannelConfig('coupang').sources[0];
const credentials = { vendorId: 'A0001', accessKey: 'fixture-key', secretKey: 'fixture-secret' };
const row = (inquiryId) => ({
  inquiryId, inquiryAt: '2026-11-20T00:15:00+09:00', csPartnerCounselingStatus: 'requestAnswer',
  itemName: '가상 상품', content: '상담이력', buyerPhone: '010-1234-0000',
  replies: [{ answerType: 'csAgent', partnerTransferStatus: 'requestAnswer', content: '배송 확인 요청' }],
});
const response = (page, pages, count, content) => Response.json({
  code: 200, data: { pagination: { currentPage: page, totalPages: pages, totalElements: count }, content },
});

test('고객센터는 한국 날짜·쿠팡 HMAC으로 읽고 페이지 전체의 상담번호를 확인한다', async () => {
  const options = { credentials, now: new Date('2026-11-19T15:15:00Z') };
  const request = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api-gateway.coupang.com');
    assert.match(url.pathname, /\/A0001\/callCenterInquiries$/);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(url.searchParams.get('inquiryStartAt'), '2026-11-14');
    assert.equal(url.searchParams.get('inquiryEndAt'), '2026-11-20');
    assert.equal(url.searchParams.get('partnerCounselingStatus'), 'NO_ANSWER');
    const signedAt = init.headers.Authorization.match(/signed-date=(\d{6}T\d{6}Z)/)[1];
    const expected = createHmac('sha256', credentials.secretKey).update(signedAt + 'GET' + url.pathname + url.search.slice(1)).digest('hex');
    assert.ok(init.headers.Authorization.endsWith('signature=' + expected));
    const page = Number(url.searchParams.get('pageNum'));
    return response(page, 2, 2, [row(page)]);
  };
  const items = await collectCoupangCenter({ id: 'coupang' }, source, { ...options, request });
  assert.deepEqual(items.map(item => item.external_id), ['1', '2']);
  assert.equal(items[0].body, '배송 확인 요청');
  assert.doesNotMatch(JSON.stringify(items), /010-1234-0000/);
  await assert.rejects(collectCoupangCenter({ id: 'coupang' }, { ...source, maxPages: 1 }, { ...options, request }), /페이지 한도/);
});

test('문서화된 빈 결과를 허용하고 중복·실패 응답은 빈 목록으로 처리하지 않는다', async () => {
  const run = request => collectCoupangCenter({ id: 'coupang' }, source, { credentials, request });
  assert.deepEqual(await run(async () => response(1, 0, 0, [])), []);
  await assert.rejects(run(async url => response(Number(new URL(url).searchParams.get('pageNum')), 2, 2, [row(1)])), /중복/);
  await assert.rejects(run(async () => new Response('fixture-secret', { status: 403 })), /HTTP 403/);
});

test('실제 운영 수집 경로에서 API 문의를 저장하고 브라우저 문의함 실패와 격리한다', async t => {
  const localFetch = fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => new URL(url).hostname === 'api-gateway.coupang.com'
    ? response(1, 1, 1, [row(920)]) : localFetch(url, init));
  const launch = t.mock.method(chromium, 'launchPersistentContext', async () => { throw new Error('browser unavailable'); });
  const env = { CS_COUPANG_VENDOR_ID: credentials.vendorId, CS_COUPANG_ACCESS_KEY: credentials.accessKey, CS_COUPANG_SECRET_KEY: credentials.secretKey };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const dir = await mkdtemp(join(tmpdir(), 'cs-center-'));
  const app = createApp({ dataDir: dir, scheduler: false });
  try {
    const config = app.store.channel('coupang').config;
    config.enabled = true;
    config.sources[0].enabled = true;
    app.store.db.prepare("UPDATE channels SET config=? WHERE id='coupang'").run(JSON.stringify(config));
    const sync = await app.sync();
    assert.equal(sync.added, 1);
    assert.equal(sync.results[0].ok, false);
    const saved = app.store.db.prepare("SELECT * FROM inquiries WHERE mode='live'").get();
    assert.equal(saved.external_id, '920');
    assert.equal(saved.source, 'coupang-0');
    assert.ok(saved.draft);
    assert.equal((await app.sync()).added, 0);
    assert.equal(launch.mock.callCount(), 2);
    config.sources[1].enabled = false;
    app.store.db.prepare("UPDATE channels SET config=? WHERE id='coupang'").run(JSON.stringify(config));
    assert.equal((await app.sync()).results[0].ok, true);
    assert.equal(launch.mock.callCount(), 2);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const state = await (await fetch(`${base}/api/state?mode=live`)).json();
    assert.match(state.inquiries[0].sendBlockedReason, /Wing/);
    const channel = state.channels.find(channel => channel.id === 'coupang');
    assert.equal(channel.automation.find(source => source.id === 'coupang-0').ready, true);
    assert.doesNotMatch(JSON.stringify(state), /fixture-key|fixture-secret/);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
