import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createConnectors } from '../src/connectors.js';
import { openStore } from '../src/store.js';

test('9개 채널 수동 업무 흐름: 등록·중복 방지·초안·완료·복구·영속화, 외부 전송 없음', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-manual-'));
  let calls = 0;
  const app = createApp({ dataDir: dir, scheduler: false, connectors: {
    collect: async () => [], checkCompletions: async () => { calls++; return []; }, send: async () => { calls++; },
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, data, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  let savedId;
  try {
    for (const channel of app.store.channelDefinitions()) {
      const source = app.store.channel(channel.id).config.sources.find(s => !(channel.id === 'fashionplus' && s.id === 'fashionplus-0'));
      const input = { mode: 'live', requestId: randomUUID(), channel: channel.id, source: source.id, body: '상품 배송일을 알려 주세요.' };
      const first = await api('/api/inquiries/manual', input);
      assert.equal(first.status, 200); assert.equal(first.data.inquiry_kind, 'manual');
      assert.ok(first.data.draft); assert.ok(first.data.sendBlockedReason);
      assert.equal((await api('/api/inquiries/manual', input)).data.id, first.data.id);
      assert.equal((await api('/api/inquiries/manual', { ...input, body: '다른 문의' })).status, 409);
      assert.equal((await api(`/api/inquiries/${first.data.id}/send`, { mode: 'live', version: first.data.version, approved: true })).status, 409);
      await assert.rejects(() => createConnectors(dir).send(app.store.channel(channel.id), first.data), /직접 답변/);
      const edited = await api(`/api/inquiries/${first.data.id}`, { mode: 'live', version: first.data.version, draft: '확인 후 안내드리겠습니다.', category: '배송' }, 'PATCH');
      assert.equal(edited.status, 200);
      const done = await api(`/api/inquiries/${first.data.id}/manual-state`, { mode: 'live', version: edited.data.version, outcome: 'sent', confirmed: true });
      assert.equal(done.data.status, 'sent'); assert.equal(done.data.completion_origin, 'manual_confirmation');
      assert.equal(done.data.sent_at, null); assert.equal(done.data.sent_body, null); assert.equal(done.data.draft, '확인 후 안내드리겠습니다.');
      assert.equal((await api(`/api/inquiries/${first.data.id}/manual-state`, { mode: 'live', version: edited.data.version, outcome: 'pending', confirmed: true })).status, 409);
      const pending = await api(`/api/inquiries/${first.data.id}/manual-state`, { mode: 'live', version: done.data.version, outcome: 'pending', confirmed: true });
      assert.equal(pending.data.status, 'pending'); assert.equal(pending.data.completion_origin, '');
      savedId = first.data.id;
    }
    assert.equal(app.store.db.prepare("SELECT count(*) n FROM inquiries WHERE mode='live'").get().n, 9);
    const config = app.store.channel('fashionplus').config; config.enabled = true; config.sources[0].enabled = false;
    assert.equal((await api('/api/channels/fashionplus', { config }, 'PUT')).status, 200);
    await api('/api/sync', { mode: 'live' });
    assert.equal(calls, 0, 'manual inquiries must never trigger completion verification or sends');
    const input = { mode: 'live', requestId: randomUUID(), channel: 'coupang', source: 'coupang-0', body: '테스트' };
    for (const change of [{ mode: 'demo' }, { url: 'https://other.example/' }, { url: 'javascript:alert(1)' }, { body: '' }, { source: 'missing' }, { url: {} }]) assert.equal((await api('/api/inquiries/manual', { ...input, ...change })).status, 400);
    assert.equal((await api('/api/inquiries/manual', { ...input, channel: 'fashionplus', source: 'fashionplus-0' })).status, 400);
    await app.close();
    const reopened = openStore(dir);
    try { assert.equal(reopened.inquiry(savedId).inquiry_kind, 'manual'); assert.equal(reopened.inquiry(savedId).draft, '확인 후 안내드리겠습니다.'); }
    finally { reopened.close(); }
  } finally { if (app.server.listening) await app.close(); await rm(dir, { recursive: true, force: true }); }
});
