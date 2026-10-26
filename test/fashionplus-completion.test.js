import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { AppError } from '../src/domain.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const list = '<div><div><div><table><thead><tr><th>문의번호</th><th>제목</th><th>고객명</th><th>실적브랜드</th><th>처리상태</th></tr></thead></table></div><div><table><tbody></tbody></table></div></div><div><ol><li><a>1</a></li></ol><p>of 0 (0 items)</p></div></div>';
async function setup(connectors) {
  const dir = await mkdtemp(join(tmpdir(), 'cs-completions-'));
  const app = createApp({ dataDir: dir, scheduler: false, ...(connectors ? { connectors } : {}) });
  const base = await listen(app.server);
  const api = async (path, body, method = 'POST') => {
    const res = await fetch(`${base}/api${path}`, { method: body ? method : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const enable = async origin => {
    const config = defaultChannelConfig('fashionplus'); config.enabled = true;
    config.sources[0].enabled = false; config.sources[1].url = `${origin}/cs-center/qna`;
    assert.equal((await api('/channels/fashionplus', { config }, 'PUT')).status, 200);
  };
  const add = (origin, id = '2001', mode = 'live', source = 'fashionplus-1') => {
    app.store.addInquiry(mode, { channel: 'fashionplus', source, external_id: `list-${id}`, detail_external_id: id, title: '배송 문의', body: '배송 문의합니다', customer: '가상 고객', product: '테스트 셔츠', url: `${origin}/detail?id=${id}` });
    return app.store.db.prepare('SELECT * FROM inquiries WHERE mode=? AND detail_external_id=? AND source=?').get(mode, id, source);
  };
  return { app, dir, api, enable, add, async close() { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('Chromium 원문 완료 확인: 빈 목록에서도 갱신, 불일치·로그인·처리완료 차단, 전송 없음', { timeout: 120000 }, async () => {
  const states = new Map([
    ['2001', { status: '답변완료' }], ['2002', { status: '미확인' }],
    ['2003', { customer: '다른 고객' }], ['2004', { id: '9999' }],
    ['2005', { brand: '다른 브랜드' }], ['2006', { status: '처리완료' }],
    ['2007', { login: true }],
  ]);
  let posts = 0; let failList = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method !== 'GET') { posts++; res.end('unexpected mutation'); return; }
    if (url.pathname === '/login') { res.end('<h1>로그인</h1>'); return; }
    if (url.pathname === '/cs-center/qna') {
      if (failList) { res.writeHead(302, { Location: '/login' }); res.end(); } else res.end(list);
      return;
    }
    const id = url.searchParams.get('id'); const state = states.get(id) || {};
    if (state.login) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
    const fields = { 문의번호: state.id || id, 문의상태: state.status || '답변완료', 고객명: state.customer || '가상 고객', 브랜드명: `[1] ${state.brand || '비욘드마이셀프'}`, 상품명: '[1] 테스트 셔츠', 문의내용: '배송 문의합니다' };
    res.end(`<form method="post"><table>${Object.entries(fields).map(([label, value]) => `<tr><th><b>${label}</b></th><td><p>${value}</p></td></tr>`).join('')}<tr><th>답변</th><td><textarea>기본 인사말입니다. 실제 게시된 답변으로 사용하면 안 됩니다.</textarea></td></tr></table><button>고객에게 답변완료</button></form>`);
  });
  const origin = await listen(server); const ctx = await setup();
  try {
    await ctx.enable(origin);
    const rows = [...states.keys()].map(id => ctx.add(origin, id));
    const demo = ctx.add(origin, '2999', 'demo');
    const inactive = ctx.add(origin, '2998', 'live', 'fashionplus-0');
    const result = (await ctx.api('/sync', { mode: 'live' })).data;
    assert.equal(result.completed, 1, JSON.stringify(result)); assert.equal(result.added, 0);
    assert.equal(result.results[0].ok, false, '완료 확인 오류를 숨기지 않는다');
    const done = ctx.app.store.inquiry(rows[0].id);
    assert.equal(done.status, 'sent'); assert.equal(done.completion_origin, 'remote_status');
    assert.equal(done.draft, rows[0].draft); assert.equal(done.sent_body, null); assert.equal(done.sent_at, null);
    assert.ok(done.remote_status_checked_at); assert.equal(done.version, rows[0].version + 1);
    assert.ok(ctx.app.store.inquiry(rows[1].id).remote_status_checked_at);
    for (const row of [...rows.slice(1), demo, inactive]) assert.equal(ctx.app.store.inquiry(row.id).status, 'pending');
    for (const row of rows.slice(2)) assert.equal(ctx.app.store.inquiry(row.id).remote_status_checked_at, null);
    assert.equal((await ctx.api(`/inquiries/${done.id}`, { mode: 'live', version: rows[0].version, draft: '늦은 수정', category: '배송' }, 'PATCH')).status, 409);
    // A successful status check persists even if the pending list then fails.
    for (const id of states.keys()) states.set(id, { status: '답변완료' });
    failList = true;
    const second = (await ctx.api('/sync', { mode: 'live' })).data;
    assert.equal(second.completed, 6, JSON.stringify(second)); assert.equal(second.results[0].ok, false);
    assert.equal((await ctx.api('/sync', { mode: 'live' })).data.completed, 0);
    assert.equal(ctx.app.store.db.prepare("SELECT count(*) AS n FROM events WHERE action='remote_completed'").get().n, 7);
    const reopened = openStore(ctx.dir);
    assert.equal(reopened.inquiry(done.id).completion_origin, 'remote_status'); reopened.close();
    assert.equal(posts, 0);
  } finally { await ctx.close(); await new Promise(resolve => server.close(resolve)); }
});

test('완료 확인 중 수정한 최신 초안을 보존하고 변경된 문의에는 결과를 적용하지 않는다', async () => {
  let finish;
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  const ctx = await setup({
    async checkCompletions(channel, rows) { started(rows); return new Promise(resolve => { finish = () => resolve(rows.map(row => ({ id: row.id, status: '답변완료' }))); }); },
    async collect() { return []; },
  });
  try {
    await ctx.enable('http://127.0.0.1:9999');
    const first = ctx.add('http://127.0.0.1:9999');
    const changed = ctx.add('http://127.0.0.1:9999', '2002');
    const sync = ctx.api('/sync', { mode: 'live' }); await checking;
    const edited = await ctx.api(`/inquiries/${first.id}`, { mode: 'live', version: first.version, draft: '확인 도중 수정한 답변', category: '배송' }, 'PATCH');
    assert.equal(edited.status, 200);
    ctx.app.store.db.prepare('UPDATE inquiries SET detail_external_id=? WHERE id=?').run('8888', changed.id);
    finish();
    assert.equal((await sync).data.completed, 1);
    const done = ctx.app.store.inquiry(first.id);
    assert.equal(done.draft, '확인 도중 수정한 답변'); assert.equal(done.version, edited.data.version + 1);
    assert.equal(done.sent_body, null); assert.equal(ctx.app.store.inquiry(changed.id).status, 'pending');
  } finally { finish?.(); await ctx.close(); }
});

test('완료 확인 실패와 무관한 새 문의 수집, 전체 비활성 채널·예시 모드 제외', async () => {
  let checks = 0;
  const origin = 'http://127.0.0.1:9999';
  const ctx = await setup({
    async checkCompletions() { checks++; throw new AppError('완료 확인 브라우저 실패'); },
    async collect() { return [{ channel: 'fashionplus', source: 'fashionplus-1', external_id: 'new', detail_external_id: '3001', title: '새 문의', body: '내용', customer: '가상 고객', url: `${origin}/detail?id=3001` }]; },
  });
  try {
    const row = ctx.add(origin);
    assert.equal((await ctx.api('/sync', { mode: 'live' })).data.completed, 0); assert.equal(checks, 0);
    await ctx.enable(origin);
    await ctx.api('/sync', { mode: 'demo' }); assert.equal(checks, 0);
    const sync = (await ctx.api('/sync', { mode: 'live' })).data;
    assert.equal(sync.added, 1); assert.equal(sync.completed, 0); assert.equal(sync.results[0].ok, false);
    assert.equal(ctx.app.store.inquiry(row.id).status, 'pending');
  } finally { await ctx.close(); }
});

test('확인 대상이 다른 결과 및 잘못된 상태 묶음은 완료 반영을 남기지 않는다', async () => {
  let malformed = true;
  const ctx = await setup({
    async checkCompletions(channel, rows) {
      return rows.map((row, i) => ({ id: malformed ? `wrong-${i}` : row.id, status: i ? '알 수 없음' : '답변완료' }));
    },
    async collect() { return []; },
  });
  try {
    const origin = 'http://127.0.0.1:9999'; await ctx.enable(origin);
    const rows = [ctx.add(origin), ctx.add(origin, '2002')];
    for (const invalidIds of [true, false]) {
      malformed = invalidIds;
      const result = (await ctx.api('/sync', { mode: 'live' })).data;
      assert.equal(result.completed, 0); assert.equal(result.results[0].ok, false);
      for (const row of rows) assert.equal(ctx.app.store.inquiry(row.id).status, 'pending');
      assert.equal(ctx.app.store.db.prepare("SELECT count(*) AS n FROM events WHERE action='remote_completed'").get().n, 0);
    }
  } finally { await ctx.close(); }
});

test('기존 DB에 완료 확인 필드를 추가해도 초안·전송 기록과 버전은 유지한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-completion-migration-'));
  let store = openStore(dir);
  try {
    const rows = store.db.prepare('SELECT * FROM inquiries LIMIT 2').all();
    store.db.prepare("UPDATE inquiries SET draft=?,status='sent',sent_body=?,sent_at=? WHERE id=?").run('보존할 초안', '기존 게시 본문', '2026-10-23T00:00:00Z', rows[0].id);
    store.db.exec('ALTER TABLE inquiries DROP COLUMN completion_origin; ALTER TABLE inquiries DROP COLUMN remote_status_checked_at');
    const before = rows.map(row => store.inquiry(row.id));
    store.close(); store = openStore(dir);
    for (const old of before) {
      const { completion_origin, remote_status_checked_at, ...remaining } = store.inquiry(old.id);
      assert.equal(completion_origin, ''); assert.equal(remote_status_checked_at, null);
      assert.deepEqual(remaining, { ...old });
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
