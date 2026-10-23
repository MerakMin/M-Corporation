import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLoginChannel, readLoginSource } from '../src/login-config.js';
import { openStore } from '../src/store.js';

test('로그인 설정 조회가 실행 중인 답변 상태와 사용자 설정을 변경하지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-login-'));
  const store = openStore(dir);
  try {
    store.addInquiry('live', { channel: 'fashionplus', source: 'fashionplus-0', external_id: 'active-send', body: '배송 문의' });
    store.db.prepare("UPDATE inquiries SET status='sending', version=7 WHERE external_id='active-send'").run();
    const config = store.channel('fashionplus').config;
    config.sources[0].url = 'https://example.com/custom-inbox';
    config.sources[0].selectors = { row: '.custom' };
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(config), 'fashionplus');
    const before = store.db.prepare("SELECT * FROM inquiries WHERE external_id='active-send'").get();
    assert.deepEqual(readLoginChannel(dir, 'fashionplus').config, config);
    assert.deepEqual(store.db.prepare("SELECT * FROM inquiries WHERE external_id='active-send'").get(), before);
    assert.deepEqual(store.channel('fashionplus').config, config);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('첫 로그인 설정 조회와 잘못된 채널 입력은 DB나 예시 데이터를 만들지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-first-login-'));
  const dataDir = join(dir, 'not-created');
  try {
    const channel = readLoginChannel(dataDir, 'smartstore_quarter');
    assert.equal(channel.config.accountCheck.expectedText, '쿼터');
    assert.equal(channel.config.sources.length, 4);
    assert.throws(() => readLoginChannel(dataDir, '../../other'), /알 수 없는 채널/);
    assert.equal(existsSync(dataDir), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('서버 재실행 전에도 새 고객문의 주소를 진단하며 DB를 변경하지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-login-upgrade-'));
  const store = openStore(dir);
  try {
    const old = store.channel('fashionplus').config;
    old.presetVersion = 2;
    old.sources = old.sources.slice(0, 1);
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(old), 'fashionplus');
    const source = readLoginSource(dir, 'fashionplus', 'fashionplus-1');
    assert.equal(source.url, 'https://seller.fashionplus.co.kr/cs-center/qna?status=1');
    assert.deepEqual(store.channel('fashionplus').config, old);
    old.sources.push({ ...source, url: '' });
    store.db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(old), 'fashionplus');
    assert.equal(readLoginSource(dir, 'fashionplus', 'fashionplus-1').url, '');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
