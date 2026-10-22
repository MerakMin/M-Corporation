import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CHANNELS, defaultChannelConfig, resolvedSourceUrl } from '../src/channel-presets.js';
import { openStore } from '../src/store.js';
import { browserOptions, createConnectors, validateConfig } from '../src/connectors.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';

test('요청한 17개 문의함을 9개 프로필로 등록하고 네이버 해시 경로를 보존한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-channels-'));
  const store = openStore(dir);
  try {
    assert.equal(store.channelDefinitions().length, 9);
    const channels = CHANNELS.map(c => store.channel(c.id));
    assert.equal(channels.flatMap(c => c.config.sources).length, 17);
    assert.ok(channels.every(c => c.config.enabled === false));
    const beyond = store.channel('smartstore');
    const quarter = store.channel('smartstore_quarter');
    assert.deepEqual(beyond.config.sources.map(s => s.url), quarter.config.sources.map(s => s.url));
    assert.notEqual(beyond.id, quarter.id);
    assert.equal(beyond.config.sources[3].url, 'https://sell.smartstore.naver.com/#/talktalk/chat?filter.read=unread');
    assert.equal(store.channel('coupang').config.sources.length, 2);
    assert.equal(store.channel('lookpin').config.sources.length, 2);
    for (const id of ['smartstore', 'smartstore_quarter']) store.addInquiry('live', { channel: id, source: `${id}-0`, external_id: 'same-id', title: '사이즈 문의', body: '사이즈 알려주세요', product: '' });
    const rows = store.db.prepare("SELECT channel,draft FROM inquiries WHERE mode='live'").all();
    assert.equal(rows.length, 2);
    assert.match(rows.find(r => r.channel === 'smartstore').draft, /비욘드마이셀프입니다/);
    assert.match(rows.find(r => r.channel === 'smartstore_quarter').draft, /쿼터입니다/);
    assert.throws(() => validateConfig({ ...quarter.config, enabled: true }, CHANNELS.find(c => c.id === quarter.id)), /스토어명/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('카페24·하이버 날짜는 한국 자정과 연도 경계에서 갱신되고 다른 필터는 유지된다', () => {
  for (const id of ['cafe24', 'hiver']) {
    const source = defaultChannelConfig(id).sources[0];
    const original = source.url;
    const before = new URL(resolvedSourceUrl(source, new Date('2026-10-21T14:59:59Z')));
    const after = new URL(resolvedSourceUrl(source, new Date('2026-10-21T15:00:00Z')));
    const january = new URL(resolvedSourceUrl(source, new Date('2027-01-01T00:00:00Z')));
    const { startParam, endParam } = source.dateRange;
    assert.equal(before.searchParams.get(startParam), '2026-09-21');
    assert.equal(before.searchParams.get(endParam), '2026-10-21');
    assert.equal(after.searchParams.get(startParam), '2026-09-22');
    assert.equal(after.searchParams.get(endParam), '2026-10-22');
    assert.equal(january.searchParams.get(startParam), '2026-12-02');
    assert.equal(january.searchParams.get(endParam), '2027-01-01');
    assert.equal(id === 'cafe24' ? after.searchParams.get('is_reply') : after.searchParams.get('status'), id === 'cafe24' ? 'N' : '답변대기');
    assert.equal(resolvedSourceUrl({ ...source, dateRange: null }), original);
    assert.equal(source.url, original);
  }
});

test('패션플러스 기본 이름을 CS알리미로 바로잡고 사용자 설정은 보존한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-fashionplus-label-'));
  let store = openStore(dir);
  try {
    assert.equal(store.channel('fashionplus').config.sources[0].name, 'CS알리미');
    const previous = store.channel('fashionplus').config;
    previous.sources[0].name = '고객 문의';
    previous.sources[0].selectors = { ready: '.user-selected' };
    previous.replyShopName = '직접 설정한 상호';
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), 'fashionplus');
    store.close(); store = openStore(dir);
    const expected = structuredClone(previous);
    expected.sources[0].name = 'CS알리미';
    assert.deepEqual(store.channel('fashionplus').config, expected);
    for (const source of [
      { ...previous.sources[0], name: '직접 정한 이름' },
      { ...previous.sources[0], url: 'https://example.com/custom' },
    ]) {
      const config = { ...previous, sources: [source] };
      store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(config), 'fashionplus');
      store.close(); store = openStore(dir);
      assert.deepEqual(store.channel('fashionplus').config, config);
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('기존 설정 이관 시 사용자 URL·선택자·답변을 보존하고 새 문의함은 비활성으로 추가한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-migration-'));
  let store = openStore(dir);
  try {
    store.addInquiry('live', { channel: 'smartstore', source: 'smartstore-0', external_id: 'old', title: '문의', body: '기존 문의', product: '' });
    const row = store.db.prepare("SELECT * FROM inquiries WHERE mode='live'").get();
    store.db.prepare('UPDATE inquiries SET draft=? WHERE id=?').run('직접 편집한 답변', row.id);
    const original = { enabled: true, replyShopName: '기존 상호', sources: [{ id: 'smartstore-0', name: '기존 문의함', url: 'https://example.com/custom', selectors: { ready: '.existing' } }] };
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(original), 'smartstore');
    store.close(); store = openStore(dir);
    const config = store.channel('smartstore').config;
    assert.equal(config.sources[0].url, original.sources[0].url);
    assert.deepEqual(config.sources[0].selectors, original.sources[0].selectors);
    assert.equal(config.replyShopName, '기존 상호');
    assert.ok(config.sources.slice(1).every(s => s.enabled === false));
    assert.equal(store.inquiry(row.id).draft, '직접 편집한 답변');
    // An explicit choice to clear a URL or turn off date rewriting survives restart.
    const cafe = store.channel('cafe24').config;
    cafe.sources[0].url = ''; cafe.sources[0].dateRange = null;
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(cafe), 'cafe24');
    store.close(); store = openStore(dir);
    assert.equal(store.channel('cafe24').config.sources[0].url, '');
    assert.equal(store.channel('cafe24').config.sources[0].dateRange, null);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('동일 URL에서 두 네이버 프로필의 쿠키가 분리되고 잘못된 계정으로는 전송하지 않는다', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-account-'));
  let posts = 0;
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/login') { res.setHeader('Set-Cookie', `store=${url.searchParams.get('account')}; Path=/; HttpOnly; SameSite=Lax`); res.end('Test account set'); return; }
    if (req.method === 'POST') posts++;
    const account = req.headers.cookie?.includes('store=quarter') ? '쿼터' : '비욘드마이셀프';
    res.end(`<span id="account">${account}</span><main class="list" data-id="same"><article data-id="same"><p class="body">배송 문의합니다</p><a href="/detail">상세</a></article></main><textarea></textarea><button>전송</button>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const selector = { ready: '.list', row: 'article', idAttribute: 'data-id', body: '.body', link: 'a', detailIdentity: 'main', detailIdAttribute: 'data-id', editor: 'textarea', submit: 'button', postedReply: '.posted' };
  const channels = ['smartstore', 'smartstore_quarter'].map(id => ({ id, config: { ...defaultChannelConfig(id), enabled: true, accountCheck: { selector: '#account', expectedText: id === 'smartstore' ? '비욘드마이셀프' : '쿼터' }, sources: [{ id: `${id}-0`, name: 'test', url, selectors: selector }, { id: `${id}-1`, name: 'disabled', url: 'https://example.com/not-visited', enabled: false, selectors: {} }] } }));
  async function login(id, name) {
    const browser = await chromium.launchPersistentContext(join(dir, 'profiles', id), browserOptions());
    try { const page = await browser.newPage(); await page.goto(`${url}/login?account=${name}`); } finally { await browser.close(); }
  }
  try {
    await login('smartstore', 'beyond'); await login('smartstore_quarter', 'quarter');
    const connectors = createConnectors(dir);
    const beyond = await connectors.collect(channels[0]);
    const quarter = await connectors.collect(channels[1]);
    assert.equal(beyond.length, 1); assert.equal(quarter.length, 1);
    assert.equal(beyond[0].external_id, quarter[0].external_id);
    await login('smartstore', 'quarter');
    await assert.rejects(connectors.collect(channels[0]), /스토어명이/);
    await assert.rejects(connectors.send(channels[0], { ...beyond[0], draft: '안녕하세요 고객님.' }), /스토어명이/);
    assert.equal(posts, 0);
  } finally {
    await new Promise(resolve => fixture.close(resolve)); await rm(dir, { recursive: true, force: true });
  }
});
