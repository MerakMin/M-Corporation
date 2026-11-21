import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { readLoginChannel, readLoginSource } from '../src/login-config.js';
import { openStore } from '../src/store.js';
import { browserExecutable } from '../src/connectors.js';
import { launchChannelBrowser } from '../src/persistent-browser.js';
import { chromium } from 'playwright';

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

test('Windows 로그인과 수집은 설치된 웨일을 선택하고 지정 경로를 우선한다', () => {
  const env = { LOCALAPPDATA: 'C:/Users/Fixture/AppData/Local', ProgramFiles: 'C:/Program Files' };
  const whale = win32.join(env.ProgramFiles, 'Naver', 'Naver Whale', 'Application', 'whale.exe');
  const options = { platform: 'win32', env, fileExists: path => path === whale };
  assert.equal(browserExecutable(options), whale);
  assert.equal(browserExecutable({ ...options, fileExists: () => false }), undefined);
  assert.equal(browserExecutable({ ...options, env: { ...env, CS_CHROMIUM_PATH: 'D:/Whale/whale.exe' } }), 'D:/Whale/whale.exe');
  assert.equal(browserExecutable({ platform: 'linux', env: {}, fileExists: path => path === '/usr/bin/chromium' }), '/usr/bin/chromium');
});

test('웨일 연결 실패 후 로그인에서만 대체 브라우저를 선택하고 이후 수집이 같은 프로필을 사용한다', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-fallback-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const profile = join(dir, 'profiles-chromium', 'cafe24');
  const launch = t.mock.method(chromium, 'launchPersistentContext', async (folder, options) => {
    assert.equal(folder, profile);
    assert.equal(options.executablePath, undefined);
    await mkdir(folder, { recursive: true });
    return { close: async () => {} };
  });
  const options = { executablePath: join(dir, 'whale.exe'), headless: false, locale: 'ko-KR' };
  try {
    await assert.rejects(launchChannelBrowser(dir, 'cafe24', options), /03-login/);
    assert.equal(launch.mock.callCount(), 0);
    const login = await launchChannelBrowser(dir, 'cafe24', options, { login: true });
    assert.equal(login.name, 'Playwright Chromium');
    await login.context.close();
    const collection = await launchChannelBrowser(dir, 'cafe24', { ...options, headless: true });
    assert.equal(collection.name, 'Playwright Chromium');
    await collection.context.close();
    const withoutWhale = await launchChannelBrowser(dir, 'cafe24', { ...options, executablePath: undefined });
    assert.equal(withoutWhale.name, 'Playwright Chromium');
    await withoutWhale.context.close();
    assert.equal(launch.mock.callCount(), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
