import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { browserOptions } from '../src/connectors.js';
import { readQnaList, waitForQnaList } from '../src/fashionplus-qna.js';
import { saveFashionplusPaginationDiagnostic } from '../src/fashionplus-diagnostics.js';

const labels = kind => kind === 'notification'
  ? ['문의번호', '주문번호', '고객명', '실적브랜드', '처리상태', '문의유형', '회신기한']
  : ['문의번호', '제목', '고객명', '실적브랜드', '처리상태'];
const grid = (kind = 'qna', rows = '', message = 'No data') => `<main><div class="grid"><div><table><thead><tr>${labels(kind).map(label => `<th><div>${label}</div></th>`).join('')}</tr></thead></table></div><div><table><tbody>${rows}</tbody></table><div class="empty">${message}</div></div></div></main>`;
const dataRow = '<tr><td>1001</td><td><a href="/detail">테스트 제목</a></td><td>가상 고객</td><td>비욘드마이셀프</td><td>답변대기</td></tr>';

test('두 문의함의 명시적 빈 목록은 페이지 숫자가 없어도 0건, 공백·상태 요약·숨은 문구는 근거로 쓰지 않는다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    for (const kind of ['qna', 'notification']) {
      const input = { kind, pageNumber: 1 };
      for (const message of ['No data', 'No data to display', 'No records found.', 'No items to display', '데이터가 없습니다.', '조회된 데이터가 없습니다.', '조회 결과가 없습니다.', '검색 결과가 없습니다.']) {
        await page.setContent(grid(kind, '', message));
        const result = await page.evaluate(readQnaList, input);
        assert.equal(result.error, undefined, message);
        assert.equal(result.total, 0); assert.equal(result.pages, 0); assert.deepEqual(result.rows, []);
      }
      await page.setContent(grid(kind, '<tr><td colspan="8">조회된 데이터가 없습니다.</td></tr>', ''));
      assert.equal((await page.evaluate(readQnaList, input)).total, 0);
      for (const markup of [
        grid(kind, '', ''),
        grid(kind, '', '답변대기 0건'),
        grid(kind, '', '<span hidden>No data</span>'),
        grid(kind, '', '') + '<aside>No data</aside>',
        grid(kind, '', '') + '<table><tr><td>No data</td></tr></table>',
      ]) {
        await page.setContent(markup);
        assert.match((await page.evaluate(readQnaList, input)).error, /전체 건수/);
      }
      await page.setContent(grid(kind) + '<div class="dx-loadpanel">Loading</div>');
      assert.match((await page.evaluate(readQnaList, input)).error, /로딩/);
      await page.setContent(grid(kind).replace('</main>', '<p>of 1 (2 items)</p></main>'));
      assert.match((await page.evaluate(readQnaList, input)).error, /일치하지/);
    }
    await page.setContent(grid('qna', dataRow));
    assert.match((await page.evaluate(readQnaList)).error, /전체 건수/);
  } finally { await browser.close(); }
});

test('초기 빈 화면 뒤 조회 응답이 도착하면 0건으로 확정하지 않고 실제 목록을 읽는다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.route('https://fixture.example/**', async route => {
      if (new URL(route.request().url()).pathname === '/data') {
        await new Promise(resolve => setTimeout(resolve, 300));
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: grid() });
    });
    await page.goto('https://fixture.example/list');
    await page.evaluate(row => {
      fetch('/data').then(() => {
        document.querySelector('tbody').innerHTML = row;
        document.querySelector('.empty').remove();
        document.querySelector('.grid').insertAdjacentHTML('beforeend', '<p>of 1 (1 items)</p>');
      });
    }, dataRow);
    const result = await waitForQnaList(page, 1);
    assert.equal(result.total, 1); assert.equal(result.rows[0].external_id, '1001');
    await page.setContent(grid('notification'));
    const empty = await waitForQnaList(page, { kind: 'notification', pageNumber: 1 });
    assert.equal(empty.total, 0); assert.equal(empty.error, undefined);
  } finally { await browser.close(); }
});

test('자동 건수 진단에는 원문·고객·URL·입력값 없이 구조와 정해진 수치만 기록한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-counter-diagnostic-'));
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(grid('qna', '<tr data-id="private-row"><td>private-customer</td></tr>', '') + '<textarea>private-draft</textarea><a href="https://private.example/secret">private-body</a>');
    const snapshot = { error: 'private-error', rows: [{ customer: 'private-customer' }], paginationDiagnostics: { visibleRows: 1, explicitEmpty: false, loading: false, counterCandidates: 0, counters: [{ pages: 0, total: 0, private: 'private-data' }] } };
    const name = await saveFashionplusPaginationDiagnostic(page, 1, snapshot, dir);
    assert.equal(name, 'diagnostics/fashionplus-qna-pagination.json');
    const json = await readFile(join(dir, 'fashionplus-qna-pagination.json'), 'utf8');
    assert.ok(!json.includes('private')); assert.ok(!json.includes('secret'));
    assert.equal(JSON.parse(json).pagination.visibleRows, 1);
    assert.equal(await page.locator('textarea').inputValue(), 'private-draft');
    assert.equal(await saveFashionplusPaginationDiagnostic(page, { kind: 'notification' }, snapshot, dir), 'diagnostics/fashionplus-notifications-pagination.json');
  } finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
});
