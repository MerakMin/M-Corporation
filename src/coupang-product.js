import { AppError } from './domain.js';

export const COUPANG_PRODUCT = 'coupang-product-readonly';
export const COUPANG_SEND_BLOCKED = '쿠팡 고객 문의는 읽기와 초안 작성을 지원합니다. 초안을 복사한 뒤 원문 목록에서 접수번호가 같은 문의에 직접 답변하세요. 조회 범위 안의 기존 답변은 다음 수집 때 반영합니다.';

export function validateCoupangProductSource(source, channelId) {
  let url;
  try { url = new URL(source.url); } catch { throw new AppError('쿠팡 고객 문의 URL을 확인하세요.'); }
  const fixture = process.env.CS_ALLOW_LOCAL_CONNECTORS === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (channelId !== 'coupang' || (!fixture && url.origin !== 'https://wing.coupang.com') || url.pathname !== '/tenants/cs/product/inquiries') throw new AppError('쿠팡 전용 수집기는 고객 문의 주소에서만 사용할 수 있습니다.');
}

// Browser reader based on the supplied outline and screenshot. One tbody is
// one inquiry: the six-cell header row is followed by dated seller replies.
// Never use order IDs, row position or customer name as the inquiry identity.
export function readCoupangProducts() {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const text = el => el?.innerText?.trim() || '';
  const compact = el => text(el).replace(/\s+/g, '');
  const labels = ['등록일시', '고객명', '문의내용', '문의유형(접수번호)', '주문번호', '답변여부'];
  const headers = [...document.querySelectorAll('thead tr')].filter(tr => visible(tr) && tr.cells.length === 6 && [...tr.cells].every((cell, i) => compact(cell).replace(/[?↑↓]/g, '') === labels[i]));
  if (headers.length !== 1) return { error: '쿠팡 고객 문의의 열 제목을 확인하지 못했습니다.' };
  const table = headers[0].closest('table');
  let root = table.parentElement, totals = [];
  while (root && root !== document.body) {
    totals = [...root.querySelectorAll('div,span,p')].filter(el => visible(el) && !el.closest('table') && !el.querySelector('table'))
      .map(el => text(el).match(/^총\s*(\d+(?:,\d{3})*)\s*개$/)).filter(Boolean).map(m => Number(m[1].replaceAll(',', '')));
    if (totals.length) break;
    root = root.parentElement;
  }
  if (!totals.length || new Set(totals).size !== 1 || !Number.isSafeInteger(totals[0])) return { error: '쿠팡 전체 문의 건수를 확인하지 못했습니다.' };
  const total = totals[0], items = [], ids = new Set();
  const date = raw => {
    const m = raw.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`;
    const value = new Date(iso);
    if (!Number.isFinite(value.getTime()) || new Date(value.getTime() + 9 * 3600000).toISOString().slice(0, 19) !== iso.slice(0, 19)) return null;
    return value.toISOString();
  };
  for (const tbody of table.tBodies) {
    const rows = [...tbody.rows].filter(visible);
    if (!rows.length) continue;
    const cells = [...rows[0].cells];
    if (total === 0 && rows.length === 1 && cells.length === 1 && /없습니다|없어요/.test(text(cells[0]))) continue;
    if (cells.length !== 6) return { error: '쿠팡 문의 행 구조가 변경되었습니다.' };
    const identity = compact(cells[3]).match(/^(상품문의|주문문의)\((\d{1,30})\)$/);
    if (!identity || ids.has(identity[2])) return { error: '쿠팡 접수번호가 없거나 중복되었습니다.' };
    ids.add(identity[2]);
    const blocks = [...cells[2].children].filter(visible);
    if (blocks.length !== 2 || !blocks[0].querySelector('a')) return { error: '쿠팡 상품명과 문의 본문의 위치를 확인하지 못했습니다.' };
    const product = text(blocks[0]), body = text(blocks[1]), created_at = date(text(cells[0]));
    if (!product || !body || !created_at) return { error: '쿠팡 문의 본문·상품명·등록일시를 확인하지 못했습니다.' };
    const buttons = [...cells[5].querySelectorAll('button')].filter(visible);
    const state = buttons.length === 1 ? compact(buttons[0]) : compact(cells[5]);
    const replies = [];
    for (const row of rows.slice(1)) {
      if (row.querySelector('textarea,input,[contenteditable="true"]')) return { error: '쿠팡 답변 입력창이 열려 있습니다. 닫은 뒤 다시 수집하세요.' };
      const container = row.cells[0]?.firstElementChild;
      const parts = container ? [...container.children].filter(visible) : [];
      const match = parts.length === 2 ? text(parts[0]).match(/^답변\s*\(([^)]+)\)$/) : null;
      const postedAt = match && date(match[1]), postedBody = text(parts[1]);
      if (!postedAt || !postedBody) return { error: '쿠팡 기존 답변의 본문과 등록 시각을 확인하지 못했습니다.' };
      replies.push({ body: postedBody, at: postedAt });
    }
    let remote_status;
    if (state === '추가답변' && replies.length) remote_status = 'answered';
    else if (['답변', '답변하기', '미답변'].includes(state) && !replies.length) remote_status = 'pending';
    else return { error: '쿠팡 답변 여부와 게시된 답변이 일치하지 않습니다.' };
    replies.sort((a, b) => a.at.localeCompare(b.at));
    if (new Set(replies.map(r => r.at)).size !== replies.length) return { error: '쿠팡 답변 시각이 중복되어 최신 답변을 구분하지 못했습니다.' };
    const latest = replies.at(-1);
    items.push({ external_id: identity[2], customer: text(cells[1]) || '고객', product, body, title: body.slice(0, 100), created_at, remote_status,
      ...(latest ? { remote_reply_body: latest.body, remote_reply_at: latest.at } : {}) });
  }
  // Pagination controls have not yet been observed. Do not silently import a
  // partial page, infer completion from absence, or click guessed controls.
  if (items.length !== total) return { error: '쿠팡 전체 건수와 현재 화면의 문의 수가 다릅니다. 여러 페이지 수집은 아직 지원하지 않습니다.' };
  return { items, total };
}

export async function collectCoupangProducts(context, channel, source, safeUrl) {
  validateCoupangProductSource(source, channel.id);
  const url = safeUrl(source.url), expected = new URL(url);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const checkLocation = () => {
      const current = new URL(page.url());
      if (current.origin !== expected.origin || current.pathname !== expected.pathname) throw new AppError('쿠팡 고객 문의 화면이 아닙니다. 전용 브라우저에서 쿠팡 로그인을 갱신하세요.');
    };
    checkLocation();
    await page.locator('thead').filter({ hasText: '접수번호' }).waitFor();
    // Only change the answer filter, using the observed dropdown and radio
    // labels. Never click reply/additional-reply/register/hide controls.
    const filter = page.locator('label:visible').filter({ hasText: /^답변여부$/ });
    if (await filter.count() !== 1) throw new AppError('쿠팡 답변여부 검색 조건을 찾지 못했습니다.');
    const control = filter.locator('..').locator('..');
    if (!(await control.innerText()).replace(/\s+/g, '').endsWith('전체')) {
      await control.click();
      const options = page.locator('label:visible').filter({ hasText: /^전체$/ });
      const candidates = [];
      for (let i = 0; i < await options.count(); i++) {
        const label = options.nth(i);
        if (await label.locator('..').locator('input[type="radio"]').count() !== 1) continue;
        let group = label.locator('..');
        for (let level = 0; level < 3; level++) {
          group = group.locator('..');
          if (await group.locator('input[type="radio"]').count() === 3 && /미답변/.test(await group.innerText())) { candidates.push(label); break; }
        }
      }
      if (candidates.length !== 1) throw new AppError('쿠팡 답변여부 전체 검색을 선택하지 못했습니다.');
      await candidates[0].click();
      const search = page.locator('button:visible').filter({ hasText: /^검색$/ });
      if (await search.count() > 1) throw new AppError('쿠팡 검색 버튼을 하나로 구분하지 못했습니다.');
      if (await search.count() === 1) await search.click();
      await page.waitForFunction(() => [...document.querySelectorAll('label')].some(el => el.innerText.trim() === '답변여부' && el.parentElement.parentElement.innerText.replace(/\s+/g, '') === '답변여부전체'));
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    checkLocation();
    const result = await page.evaluate(readCoupangProducts);
    if (result.error) throw new AppError(result.error);
    // Reject a changing table rather than mixing two query results.
    await page.waitForTimeout(300);
    checkLocation();
    if (JSON.stringify(await page.evaluate(readCoupangProducts)) !== JSON.stringify(result)) throw new AppError('쿠팡 문의 목록이 변경 중입니다. 잠시 후 다시 수집하세요.');
    return result.items.map(item => ({ ...item, channel: channel.id, source: source.id, url }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = new AppError('쿠팡 고객 문의를 읽지 못했습니다. 전용 브라우저 로그인과 문의 화면을 확인하세요.');
    failure.cause = error;
    throw failure;
  } finally { await page.close(); }
}
