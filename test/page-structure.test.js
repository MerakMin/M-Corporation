import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserOptions } from '../src/connectors.js';
import { inspectPageStructure } from '../src/page-structure.js';

test('문의 구조 보고서는 고객 내용·속성값·입력값·URL을 내보내지 않고 폼을 변경하지 않는다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(`<main id="secret-id" class="secret-class" data-id="secret-row">
      <table><thead><tr><th>문의번호</th><th>문의 내용</th></tr></thead><tbody>
      <tr data-row-key="secret-order"><td>secret-customer</td><td>secret-body</td></tr></tbody></table>
      <a href="https://example.com/secret-path?token=secret-token#secret-fragment">secret-link-text</a>
      <form><label>답변</label><textarea name="secret-name">secret-draft</textarea>
      <input type="password" value="secret-password"><input type="hidden" value="secret-hidden">
      <button type="submit">등록</button></form><div role="secret-role">secret-text</div>
      <script>window.submitCount=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitCount++}</script>
    </main>`);
    const report = await inspectPageStructure(page);
    const json = JSON.stringify(report);
    assert.ok(!json.includes('secret-'));
    assert.ok(!json.includes('example.com'));
    const nodes = report.frames[0].nodes;
    assert.ok(nodes.some(node => node.uiLabel === '문의번호'));
    assert.ok(nodes.some(node => node.tag === 'tr' && node.attributes.includes('data-row-key')));
    assert.ok(nodes.some(node => node.inputType === 'password'));
    assert.ok(nodes.some(node => node.tag === 'a' && node.link.hasQuery));
    assert.equal(await page.locator('textarea').inputValue(), 'secret-draft');
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  } finally { await browser.close(); }
});

test('구조가 큰 문서는 한도를 표시하고 출력 크기를 제한한다', async () => {
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage();
    await page.setContent('<div></div>'.repeat(4100));
    const report = await inspectPageStructure(page);
    assert.equal(report.frames[0].truncated, true);
    assert.equal(report.frames[0].nodes.length, 4000);
  } finally { await browser.close(); }
});
