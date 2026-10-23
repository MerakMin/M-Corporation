import { AppError, normalizeText } from './domain.js';

export const FASHIONPLUS_QNA = 'fashionplus-qna-readonly';
export const QNA_SEND_BLOCKED = '패션플러스 고객문의는 수집·초안 작성까지 지원합니다. 초안을 복사해 원문에서 답변을 등록하세요. 원문에서 등록한 답변의 완료 상태는 아직 자동 반영되지 않습니다.';

export function validateQnaSource(source, channelId) {
  let url;
  try { url = new URL(source.url); } catch { throw new AppError('패션플러스 고객문의 URL을 확인하세요.'); }
  const fixture = process.env.CS_ALLOW_LOCAL_CONNECTORS === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (channelId !== 'fashionplus' || (!fixture && url.origin !== 'https://seller.fashionplus.co.kr') || url.pathname !== '/cs-center/qna') throw new AppError('전용 수집기는 패션플러스 고객문의 게시판 주소에서만 사용할 수 있습니다.');
  if (typeof source.expectedBrand !== 'string' || !source.expectedBrand.trim() || source.expectedBrand.length > 100) throw new AppError('수집할 정확한 브랜드명을 입력하세요.');
}

// Browser-side readers use the labels and split header/body tables observed in
// the supplied structure report. Never read phone fields, cookies, or form values.
export function readQnaList(pageNumber = 1) {
  const text = el => el?.innerText?.replace(/\s+/g, ' ').trim() || '';
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const required = ['문의번호', '제목', '고객명', '실적브랜드', '처리상태'];
  const candidates = [...document.querySelectorAll('thead tr')].filter(tr => visible(tr) && required.every(label => [...tr.cells].some(th => text(th.querySelector('div') || th) === label)));
  if (candidates.length !== 1) return { error: '고객문의 목록의 열 제목을 확인하지 못했습니다.' };
  const header = candidates[0];
  const labels = [...header.cells].map(th => text(th.querySelector('div') || th));
  if (new Set(labels).size !== labels.length) return { error: '고객문의 목록의 열 제목이 중복되었습니다.' };
  const table = header.closest('table');
  const tbody = table.tBodies[0] || table.parentElement.nextElementSibling?.querySelector('table > tbody');
  if (!tbody) return { error: '고객문의 목록 본문을 찾지 못했습니다.' };
  let root = table.parentElement;
  let counters = [];
  const countPattern = /\bof\s*(\d+(?:,\d{3})*)\s*\(\s*(\d+(?:,\d{3})*)\s*items?\s*\)/gi;
  while (root && root !== document.body) {
    // Page count and item count can be separate text nodes/elements in the
    // same pager. Read the containing region, outside data tables.
    const matches = [...root.querySelectorAll('p, div, span')].filter(el =>
      visible(el) && !el.closest('table') && !el.querySelector('table')
    ).flatMap(el => {
      const values = [...text(el).matchAll(countPattern)];
      return values.length ? [{ el, values }] : [];
    });
    // Count each outside-table region once, including every display in it.
    // This preserves conflicting counters when one is split across siblings.
    const regions = matches.filter(candidate => !matches.some(other => candidate !== other && other.el.contains(candidate.el)));
    counters = regions.flatMap(region => region.values.map(value => ({
      pages: Number(value[1].replaceAll(',', '')),
      total: Number(value[2].replaceAll(',', '')),
    })));
    if (root.contains(tbody) && counters.length) break;
    root = root.parentElement;
  }
  if (!root || root === document.body || counters.length !== 1) return { error: '고객문의 전체 건수와 페이지 수를 확인하지 못했습니다.', retryable: counters.length === 0 };
  const { pages, total } = counters[0];
  if (!Number.isSafeInteger(pages) || !Number.isSafeInteger(total)) return { error: '고객문의 전체 건수와 페이지 수가 올바르지 않습니다.' };
  const rows = [];
  for (const tr of tbody.rows) {
    if (!visible(tr)) continue;
    const cells = [...tr.cells];
    if (cells.length === 1 && /^(조회된|검색된|등록된)?\s*(문의|데이터|내역|결과)가?\s*없습니다\.?$|^검색 결과가 없습니다\.?$/.test(text(tr))) continue;
    if (cells.length !== labels.length) return { error: '고객문의 목록의 행 구조가 변경되었습니다.' };
    const cell = label => cells[labels.indexOf(label)];
    const links = [...cell('제목').querySelectorAll('a[href]')].filter(visible);
    if (links.length !== 1) return { error: '고객문의 상세 링크를 확인하지 못했습니다.' };
    rows.push({ external_id: text(cell('문의번호')), title: text(cell('제목')), customer: text(cell('고객명')), brand: text(cell('실적브랜드')), status: text(cell('처리상태')), href: links[0].href });
  }
  // Zero is accepted only with the explicit, scoped total counter.
  if ((!rows.length && total !== 0) || (rows.length && (!total || !pages))) return { error: '문의 목록과 전체 건수가 일치하지 않습니다.' };
  document.querySelectorAll('[data-cs-qna-body], [data-cs-qna-next]').forEach(el => { el.removeAttribute('data-cs-qna-body'); el.removeAttribute('data-cs-qna-next'); });
  tbody.setAttribute('data-cs-qna-body', '');
  const next = [...root.querySelectorAll('ol a')].filter(el => visible(el) && text(el) === String(pageNumber + 1));
  if (next.length === 1) next[0].setAttribute('data-cs-qna-next', '');
  return { rows, total, pages, hasNext: next.length === 1, signature: rows.map(row => row.external_id).join('|'), idColumn: labels.indexOf('문의번호') };
}

export function readQnaDetail() {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const fields = {};
  for (const label of ['문의번호', '문의상태', '고객명', '상품명', '브랜드명', '문의내용']) {
    const headers = [...document.querySelectorAll('th')].filter(th => visible(th) && th.innerText.replace(/\s+/g, '').trim() === label);
    if (headers.length !== 1 || headers[0].nextElementSibling?.tagName !== 'TD') return { error: '고객문의 상세 항목을 확인하지 못했습니다.' };
    fields[label] = headers[0].nextElementSibling.innerText.trim();
  }
  return fields;
}

// The heading may render before the asynchronously loaded pager. Keep the
// original error on timeout; never substitute the number of visible rows.
async function waitForQnaList(page, number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = await page.evaluate(readQnaList, number);
    if (!snapshot.retryable || Date.now() >= deadline) return snapshot;
    await page.waitForTimeout(200);
  }
}

const pending = status => ['답변대기', '미확인'].includes(normalizeText(status));
const complete = status => ['답변완료', '처리완료'].includes(normalizeText(status));
const unnumber = value => value.replace(/^\[1\]\s*/, '').trim();

export async function collectFashionplusQna(context, channel, source, safeUrl) {
  validateQnaSource(source, channel.id);
  const listUrl = safeUrl(source.url);
  const origin = new URL(listUrl).origin;
  const page = await context.newPage();
  const detail = await context.newPage();
  const items = [];
  const seen = new Set();
  const brand = normalizeText(source.expectedBrand);
  const checkLocation = (p, list = false) => {
    const url = new URL(p.url());
    if (url.origin !== origin || (list && url.pathname !== '/cs-center/qna')) throw new AppError('패션플러스 고객문의 화면이 아닙니다. 전용 브라우저의 로그인 상태를 확인하세요.');
  };
  let expectedTotal;
  let expectedPages;
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    checkLocation(page, true);
    await page.locator('thead th:visible').filter({ hasText: /^\s*문의번호\s*$/ }).waitFor();
    for (let number = 1; number <= (source.maxPages || 20); number++) {
      checkLocation(page, true);
      const snapshot = await waitForQnaList(page, number);
      if (snapshot.error) throw new AppError(snapshot.error);
      const { rows, total, pages } = snapshot;
      expectedTotal ??= total; expectedPages ??= pages;
      if (total !== expectedTotal || pages !== expectedPages) throw new AppError('수집 중 문의 건수가 변경되었습니다. 다시 수집해 주세요.');
      for (const row of rows) {
        if (!/^\d+$/.test(row.external_id) || seen.has(row.external_id)) throw new AppError('문의번호가 없거나 페이지 간 중복되었습니다. 이번 수집은 저장하지 않았습니다.');
        seen.add(row.external_id);
        if (normalizeText(row.brand) !== brand) throw new AppError('목록의 브랜드명이 설정과 다릅니다. 브랜드 필터와 연결 설정을 확인하세요.');
        if (complete(row.status)) continue;
        if (!pending(row.status)) throw new AppError('확인되지 않은 문의 처리상태입니다. 원문을 확인하세요.');
        const url = safeUrl(row.href);
        if (new URL(url).origin !== origin) throw new AppError('문의 상세 링크가 다른 사이트를 가리킵니다.');
        await detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        checkLocation(detail);
        await detail.locator('th:visible').filter({ hasText: /^\s*문의번호\s*$/ }).waitFor();
        const fields = await detail.evaluate(readQnaDetail);
        if (fields.error) throw new AppError(fields.error);
        if (fields['문의번호'] !== row.external_id) throw new AppError('목록과 상세 화면의 문의번호가 다릅니다. 이번 수집은 저장하지 않았습니다.');
        if (normalizeText(unnumber(fields['브랜드명'])) !== brand) throw new AppError('상세 화면의 브랜드명이 설정과 다릅니다.');
        if (complete(fields['문의상태'])) continue;
        if (!pending(fields['문의상태'])) throw new AppError('상세 화면의 문의 처리상태를 확인하지 못했습니다.');
        if (!row.title || !fields['고객명'] || !fields['문의내용']) throw new AppError('문의 제목·고객명·본문 중 비어 있는 항목이 있습니다.');
        items.push({ channel: channel.id, source: source.id, external_id: row.external_id, title: row.title, customer: fields['고객명'], body: fields['문의내용'], product: unnumber(fields['상품명']), url });
      }
      if (number >= pages) {
        if (seen.size !== total) throw new AppError('전체 건수와 읽은 문의 수가 다릅니다. 이번 수집은 저장하지 않았습니다.');
        return items;
      }
      if (!snapshot.hasNext) throw new AppError('다음 페이지 번호를 찾지 못했습니다. 이번 수집은 저장하지 않았습니다.');
      await page.locator('[data-cs-qna-next]').click();
      await page.waitForFunction(({ before, column }) => {
        const body = document.querySelector('[data-cs-qna-body]');
        return !body || [...body.rows].map(tr => tr.cells[column]?.innerText.replace(/\s+/g, ' ').trim() || '').join('|') !== before;
      }, { before: snapshot.signature, column: snapshot.idColumn });
      await page.locator('thead th:visible').filter({ hasText: /^\s*문의번호\s*$/ }).waitFor();
    }
    throw new AppError('수집 페이지 한도에 도달했습니다. 최대 수집 페이지 수를 늘려 주세요. 이번 수집은 저장하지 않았습니다.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = new AppError('패션플러스 고객문의 화면을 읽지 못했습니다. 전용 브라우저의 로그인 상태와 고객문의 게시판을 확인하세요.');
    failure.cause = error;
    throw failure;
  } finally { await page.close(); await detail.close(); }
}
