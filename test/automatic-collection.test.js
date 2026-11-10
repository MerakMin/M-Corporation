import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { browserOptions, createConnectors, automaticCollectionPlan } from '../src/connectors.js';
import { CHANNELS, defaultChannelConfig } from '../src/channel-presets.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const fixture = `<main><div><span><label>답변여부</label></span><span>전체</span></div><div><p>총 1개</p><table><thead><tr>${['등록일시', '고객명', '문의내용', '문의유형(접수번호)', '주문번호', '답변여부'].map(s => `<th>${s}</th>`).join('')}</tr></thead><tbody><tr><td>2026.11.10 09:00:00</td><td>***</td><td><div><a>가상 상품</a></div><div>배송 예정일을 알려 주세요.</div></td><td>상품문의(990001)</td><td></td><td><button>답변하기</button></td></tr></tbody></table></div></main>`;

test('실제 브라우저: 자동 수집 시작 → 원문 읽기·초안 저장, 중복 방지, 재실행 즉시 수집', async () => {
  let reads = 0, writes = 0;
  const remote = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    if (req.url === '/tenants/cs/product/inquiries') reads++;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
  });
  const remoteUrl = await listen(remote), dir = await mkdtemp(join(tmpdir(), 'cs-auto-'));
  let app = createApp({ dataDir: dir, scheduler: false });
  const config = app.store.channel('coupang').config;
  config.sources[1].url = `${remoteUrl}/tenants/cs/product/inquiries`;
  app.store.db.prepare("UPDATE channels SET config=? WHERE id='coupang'").run(JSON.stringify(config));
  const base = await listen(app.server), browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.locator('#mode-select').selectOption('live');
    await page.getByRole('button', { name: '채널 연결', exact: true }).click();
    const card = page.locator('.channel-card').filter({ has: page.getByRole('heading', { name: '쿠팡', exact: true }) });
    assert.match(await card.innerText(), /자동 수집 연동 준비 중/);
    assert.equal(await page.getByRole('button', { name: '문의 직접 등록', exact: true }).count(), 0);
    const response = page.waitForResponse(r => r.url().endsWith('/api/channels/coupang/automatic'));
    await card.getByRole('button', { name: '자동 수집 시작', exact: true }).click();
    const result = await (await response).json();
    assert.equal(result.added, 1); assert.equal(result.results[0].ok, true);
    assert.equal(result.deferred[0].id, 'coupang-0');
    const saved = app.store.db.prepare("SELECT * FROM inquiries WHERE mode='live'").get();
    assert.equal(saved.body, '배송 예정일을 알려 주세요.'); assert.ok(saved.draft);
    assert.equal(saved.inquiry_kind, 'customer'); assert.equal(saved.external_id, '990001');
    assert.equal(app.store.channel('coupang').config.sources[0].enabled, false);
    assert.equal(app.store.channel('coupang').config.sources[1].enabled, true);
    await page.locator('[data-action="navigate"][data-page="inbox"]').click();
    await page.getByRole('heading', { name: '배송 예정일을 알려 주세요.', exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    assert.equal((await app.sync()).added, 0);
    assert.equal(writes, 0);
    const before = reads;
    await app.close();
    app = createApp({ dataDir: dir });
    await listen(app.server);
    // Startup enters sync synchronously on the listening event. This second
    // request must be rejected instead of racing the persistent browser.
    await assert.rejects(() => app.sync(), /이미 수집 중/);
    await app.close();
    assert.ok(reads > before, 'restart must collect without waiting ten minutes');
    assert.equal(writes, 0);
  } finally {
    await browser.close(); if (app.server.listening) await app.close();
    await new Promise(resolve => remote.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});

test('준비 상태는 로그인 성공으로 간주하지 않고, 문의함별 실패 후 다음 수집 결과를 보존한다', async () => {
  const plans = CHANNELS.map(def => automaticCollectionPlan({ config: defaultChannelConfig(def.id) }, def));
  assert.deepEqual(plans.map(p => p.filter(s => s.ready).length), [2, 1, 0, 0, 0, 0, 0, 0, 0]);
  const dir = await mkdtemp(join(tmpdir(), 'cs-auto-isolation-'));
  const collectors = createConnectors(dir);
  const item = { channel: 'coupang', source: 'coupang-1', external_id: '990002', customer: '가상', body: '배송 문의', product: '가상 상품', url: 'https://wing.coupang.com/tenants/cs/product/inquiries', remote_status: 'pending', created_at: '2026-11-10T00:00:00.000Z' };
  const calls = [];
  collectors.collect = async channel => { const source = channel.config.sources[0]; calls.push(source.id); if (source.id === 'coupang-0') throw new Error('unavailable'); return [item]; };
  const app = createApp({ dataDir: dir, scheduler: false, connectors: collectors });
  try {
    const config = app.store.channel('coupang').config; config.enabled = true;
    app.store.db.prepare("UPDATE channels SET config=? WHERE id='coupang'").run(JSON.stringify(config));
    const result = await app.sync();
    assert.deepEqual(calls, ['coupang-0', 'coupang-1']);
    assert.equal(result.added, 1); assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /고객센터 문의/);
    assert.equal(app.store.db.prepare("SELECT count(*) n FROM inquiries WHERE mode='live'").get().n, 1);
    const base = await listen(app.server);
    const response = await fetch(`${base}/api/channels/cafe24/automatic`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ mode: 'live' }) });
    assert.equal(response.status, 409); assert.equal(app.store.channel('cafe24').config.enabled, false);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
