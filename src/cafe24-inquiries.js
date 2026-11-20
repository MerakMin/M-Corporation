import { AppError, normalizeText } from './domain.js';
import { resolvedSourceUrl } from './channel-presets.js';
import { matchesInboxLocation } from './page-structure.js';

export const CAFE24_INQUIRIES = 'cafe24-inquiries-readonly';
export const CAFE24_SEND_BLOCKED = '카페24 문의입니다. 게시물 번호를 확인하고 카페24 관리자에서 직접 답변하세요.';
const path = '/admin/php/shop1/b/board_admin_bulletin_l.php';
const headers = ['번호', '제목', '답변상태', '미리보기', '작성자'];
const emptyText = '검색 결과가 없습니다.';

export function validateCafe24Source(source, channelId) {
  let url;
  try { url = new URL(source.url); } catch { /* Use the same message for all invalid URLs. */ }
  const originAllowed = url?.origin === 'https://beyondmyself.cafe24.com'
    || (process.env.CS_ALLOW_LOCAL_CONNECTORS === '1' && url?.hostname === '127.0.0.1');
  if (channelId !== 'cafe24' || source.id !== 'cafe24-0' || !originAllowed || url.username || url.password
      || url.pathname !== path || url.searchParams.get('is_reply') !== 'N' || url.searchParams.get('sel_board_no') !== '6') {
    throw new AppError('카페24 미답변 상품 문의 게시판 주소를 확인하세요.');
  }
}

function text(value) { return normalizeText(value || ''); }

async function readList(page, url) {
  const actual = new URL(page.url());
  const expected = new URL(url);
  if (!matchesInboxLocation(actual.href, url)
      || ['is_reply', 'sel_board_no'].some(key => actual.searchParams.get(key) !== expected.searchParams.get(key))
      || await page.locator('input[type="password"]:visible').count()) {
    throw new AppError('카페24 로그인과 미답변 상품 문의 화면을 확인하세요.');
  }
  const table = page.locator('table:visible').filter({ has: page.getByRole('columnheader', { name: '미리보기', exact: true }) })
    .filter({ has: page.getByRole('columnheader', { name: '답변상태', exact: true }) });
  await table.first().waitFor({ state: 'visible' });
  if (await table.count() !== 1) throw new AppError('카페24 게시물 목록을 하나로 식별할 수 없습니다.');
  const filter = page.getByRole('radio', { name: '답변 전', exact: true });
  const fallback = page.locator('input[type="radio"][name="is_reply"][value="N"]:checked:visible');
  if (await filter.count() === 1 ? !await filter.isChecked() : await fallback.count() !== 1) {
    throw new AppError('카페24 답변 전 필터를 확인하세요.');
  }
  const resultText = /검색\s*결과\s*([\d,]+)\s*건/;
  const counter = page.getByText(resultText).filter({ visible: true });
  if (await counter.count() !== 1) throw new AppError('카페24 검색결과 건수를 확인할 수 없습니다.');
  const total = Number((await counter.innerText()).match(resultText)?.[1].replaceAll(',', ''));
  const structure = await table.evaluate((element, required) => {
    const clean = value => value.replace(/\s+/g, ' ').trim();
    const headerRows = [...element.rows].filter(row => required.every(label =>
      [...row.cells].some(cell => clean(cell.innerText) === label)));
    if (headerRows.length !== 1) return null;
    const header = headerRows[0];
    const indexes = {};
    for (const label of required) {
      const matches = [...header.cells].filter(cell => clean(cell.innerText) === label);
      if (matches.length !== 1) return null;
      indexes[label] = matches[0].cellIndex;
    }
    const rows = [...element.rows].slice(header.rowIndex + 1).filter(row => row.getClientRects().length);
    return rows.map(row => ({
      index: row.rowIndex,
      empty: row.cells.length === 1 && clean(row.cells[0].innerText) === '검색 결과가 없습니다.',
      fields: Object.fromEntries(required.map(label => [label, clean(row.cells[indexes[label]]?.innerText || '')])),
    }));
  }, headers);
  if (!Number.isSafeInteger(total) || total < 0 || !structure) throw new AppError('카페24 게시물 목록 구조를 확인하세요.');
  if (total === 0 && structure.length === 1 && structure[0].empty
      && await table.getByText(emptyText, { exact: true }).filter({ visible: true }).count() === 1) return { table, rows: [] };
  if (total === 0 || structure.length !== total || structure.some(row => row.empty)) {
    throw new AppError('카페24 검색 건수와 현재 페이지가 다릅니다. 한 페이지에 모든 결과를 표시해 주세요.');
  }
  const ids = new Set();
  const rows = [];
  for (const { index, fields } of structure) {
    const id = fields['번호'], title = fields['제목'], customer = fields['작성자'];
    const status = fields['답변상태'].replaceAll(' ', '');
    if (!/^\d+$/.test(id) || ids.has(id) || !title) throw new AppError('카페24 게시물 번호 또는 제목을 확인하세요.');
    ids.add(id);
    if (title.startsWith('[답변]') || ['답변완료', '처리중'].includes(status)) continue;
    if (!customer || !['답변전', '미답변', '', '-'].includes(status) || fields['미리보기'] !== '미리보기') {
      throw new AppError('카페24 게시물의 답변상태 또는 미리보기를 확인하세요.');
    }
    rows.push({ index, id, title, customer });
  }
  return { table, rows };
}

async function readPreview(page, row, table, url) {
  const preview = page.locator('table:visible').filter({ has: page.getByText('원글', { exact: true }) });
  if (await preview.count()) throw new AppError('이전 카페24 미리보기가 닫히지 않았습니다.');
  const button = table.locator(':scope > :is(thead, tbody, tfoot) > tr, :scope > tr').nth(row.index).getByText('미리보기', { exact: true }).filter({ visible: true });
  if (await button.count() !== 1) throw new AppError('대상 게시물의 미리보기 버튼을 확인하세요.');
  await button.click();
  await preview.first().waitFor({ state: 'visible' });
  if (!matchesInboxLocation(page.url(), url) || await preview.count() !== 1
      || !await page.getByText('게시글 내용 미리보기', { exact: true }).filter({ visible: true }).isVisible()) {
    throw new AppError('카페24 게시글 미리보기를 확인하세요.');
  }
  const read = async label => {
    const field = preview.locator(':scope > :is(thead, tbody, tfoot) > tr, :scope > tr').filter({ has: page.getByText(label, { exact: true }) });
    if (await field.count() !== 1) throw new AppError('카페24 미리보기 항목을 확인할 수 없습니다.');
    const value = field.locator(':scope > :is(th, td)').nth(1);
    if (label === '답변상태') {
      return value.evaluate(cell => {
        const copy = cell.cloneNode(true);
        for (const control of copy.querySelectorAll('button, a, input, [role="button"]')) control.remove();
        return copy.textContent.trim();
      });
    }
    return (await value.innerText()).trim();
  };
  const title = text(await read('제목')), author = text(await read('작성자'));
  const status = text(await read('답변상태')).replaceAll(' ', '');
  const body = await read('원글');
  if (title !== row.title || !(author === row.customer || (author && row.customer.startsWith(author + ' (')))
      || !body || !['[답변전]', '[미답변]', '답변전', '미답변', '', '-'].includes(status)) {
    throw new AppError('카페24 목록과 미리보기의 제목·작성자·답변상태를 확인하세요.');
  }
  return body;
}

export async function collectCafe24Inquiries(context, channel, source, safeUrl) {
  validateCafe24Source(source, channel.id);
  const url = safeUrl(resolvedSourceUrl(source));
  const page = await context.newPage();
  try {
    const open = () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await open();
    const list = await readList(page, url);
    const items = [];
    for (const [index, row] of list.rows.entries()) {
      let table = list.table;
      let current = row;
      if (index) {
        await open();
        const refreshed = await readList(page, url);
        table = refreshed.table;
        current = refreshed.rows.find(item => item.id === row.id && item.title === row.title && item.customer === row.customer);
        if (!current) throw new AppError('카페24 목록이 수집 중 변경됐습니다. 다시 수집해 주세요.');
      }
      const body = await readPreview(page, current, table, url);
      items.push({ channel: channel.id, source: source.id, external_id: row.id, title: row.title, customer: row.customer, body, url });
    }
    return items;
  } finally {
    await page.close();
  }
}
