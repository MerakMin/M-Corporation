import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChannelConfig } from '../src/channel-presets.js';
import { createApp } from '../src/server.js';

process.env.CS_ALLOW_LOCAL_CONNECTORS = '1';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const renderRow = (id, title, status, author) => `<tr><td>${id}</td><td>${title}</td><td>${status}</td><td><button type="button" onclick="showPreview(this)">미리보기</button></td><td><button type="button" onclick="fetch('/submit', {method:'POST'})">답변하기</button></td><td>${author}</td></tr>`;

test('카페24 자동 수집은 실제 Chromium에서 0건·여러 페이지·중복 페이지를 구분하고 미리보기 원글만 저장한다', async () => {
  let state = 'empty';
  let writes = 0;
  const remote = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    if (state === 'bad-address' || state === 'login') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(state === 'login' ? '<input type="password">' : '<h1>다시 한번 확인해주세요!</h1>');
      return;
    }
    const number = new URL(req.url, 'http://localhost').searchParams.get('page');
    const fullRows = [renderRow(3, '배송 문의', '답변 전', '가상 고객'), renderRow(2, '완료 글', '답변완료', '가상 고객'), renderRow(1, '[답변] 안내', '-', '운영자')];
    const full = state === 'multiple'
      ? (number === '2' ? renderRow(4, '교환 문의', '답변 전', '가상 고객') : fullRows.slice(0, 2).join(''))
      : fullRows.join('');
    const empty = state === 'empty' || state === 'wrong-filter';
    const count = empty ? 0 : state === 'partial' ? 4 : 3;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<label><input type="radio" ${state !== 'wrong-filter' ? 'checked' : ''}>답변 전</label>
      <p>[오늘 등록된 새 글 <b>0</b>건] 검색결과 <b>${count}</b>건</p>
      <table><thead><tr><th>번호</th><th>제목</th><th>답변상태</th><th>미리보기</th><th>답변하기</th><th>작성자</th></tr></thead>
      <tbody><tr><td colspan="6">&nbsp;</td></tr>${empty ? '<tr><td></td><td colspan="5">검색 결과가 없습니다.</td></tr>' : full}</tbody></table>
      <aside hidden><h2>게시글 내용 미리보기</h2><table><tbody>
      <tr><td>제목</td><td id="title"></td></tr><tr><td>작성자</td><td>가상 고객</td></tr>
      <tr><td>답변상태</td><td>[답변 전] <button type="button" onclick="fetch('/submit', {method:'POST'})">답변</button></td></tr><tr><td>원글</td><td>배송 일정을 알려 주세요.</td></tr>
      </tbody></table></aside>
      <script>function showPreview(button) {
        document.querySelector('#title').textContent = ${state === 'mismatch' ? "'다른 글'" : 'button.closest("tr").cells[1].textContent'};
        document.querySelector('aside').hidden = false;
      }</script>`);
  });
  const host = await listen(remote);
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-cafe24-'));
  const app = createApp({ dataDir, scheduler: false });
  try {
    const config = defaultChannelConfig('cafe24');
    config.sources[0].url = config.sources[0].url.replace('https://beyondmyself.cafe24.com', host);
    app.store.db.prepare("UPDATE channels SET config=? WHERE id='cafe24'").run(JSON.stringify(config));
    const base = await listen(app.server);
    const automatic = await fetch(`${base}/api/channels/cafe24/automatic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ mode: 'live' }),
    });
    assert.equal(automatic.status, 200);
    assert.equal((await automatic.json()).results[0].ok, true);
    state = 'login';
    assert.match((await app.sync()).results[0].error, /관리자 로그인이 필요/);
    state = 'bad-address';
    assert.match((await app.sync()).results[0].error, /문의 주소를 열 수 없습니다/);
    state = 'wrong-filter';
    assert.match((await app.sync()).results[0].error, /필터/);
    state = 'partial';
    assert.match((await app.sync()).results[0].error, /검색 건수/);
    assert.equal(app.store.db.prepare("SELECT count(*) as count FROM inquiries WHERE mode='live'").get().count, 0);
    state = 'mismatch';
    assert.match((await app.sync()).results[0].error, /제목/);
    state = 'full';
    assert.equal((await app.sync()).added, 1);
    assert.equal((await app.sync()).added, 0);
    const stateResponse = await (await fetch(`${base}/api/state?mode=live`)).json();
    assert.equal(stateResponse.inquiries.length, 1);
    const [item] = stateResponse.inquiries;
    assert.equal(item.external_id, '3');
    assert.equal(item.body, '배송 일정을 알려 주세요.');
    assert.match(item.sendBlockedReason, /카페24 관리자/);
    state = 'multiple';
    const multi = await app.sync();
    assert.equal(multi.results[0].ok, true);
    assert.equal(multi.added, 1);
    const saved = app.store.db.prepare("SELECT external_id FROM inquiries WHERE mode='live' ORDER BY external_id").all();
    assert.deepEqual(saved.map(row => row.external_id), ['3', '4']);
    assert.equal(writes, 0);
  } finally {
    await app.close();
    await new Promise(resolve => remote.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
