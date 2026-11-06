import { AppError, normalizeText } from './domain.js';
import { waitForQnaList, matchesCustomer } from './fashionplus-qna.js';

export const FASHIONPLUS_NOTIFICATIONS = 'fashionplus-notifications-readonly';
export const NOTICE_SEND_BLOCKED = 'CS알리미는 운영 알림입니다. 내용을 확인하고 원문에서 직접 처리하세요. 출고·취소·답변 등록은 자동 실행하지 않습니다.';
export function validateNotificationSource(source, channelId) {
  let url;
  try { url = new URL(source.url); } catch { throw new AppError('CS알리미 URL을 확인하세요.'); }
  const fixture = process.env.CS_ALLOW_LOCAL_CONNECTORS === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (channelId !== 'fashionplus' || (!fixture && url.origin !== 'https://seller.fashionplus.co.kr') || url.pathname !== '/cs-center/cs-notification') throw new AppError('CS알리미 전용 수집기는 패션플러스 CS알리미 주소에서만 사용할 수 있습니다.');
  if (typeof source.expectedBrand !== 'string' || !source.expectedBrand.trim() || source.expectedBrand.length > 100) throw new AppError('CS알리미에서 수집할 브랜드명을 입력하세요.');
}

export function readNotificationDetail() {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const fields = {};
  for (const label of ['주문번호-순번', '주문자', '브랜드명', '상품명', '문의상태', '문의종료여부', '회신기한', '알림내용']) {
    const headers = [...document.querySelectorAll('th,td')].filter(el => visible(el) && el.innerText.replace(/\s+/g, '') === label);
    if (headers.length !== 1 || headers[0].nextElementSibling?.tagName !== 'TD') return { error: 'CS알리미 상세 항목을 확인하지 못했습니다.' };
    fields[label] = headers[0].nextElementSibling.innerText.trim();
  }
  return fields;
}

export function notificationState(status, closed) {
  if (!['미확인', '답변대기', '재답변요청', '답변완료', '처리완료'].includes(normalizeText(status)) || !normalizeText(closed)) throw new AppError('CS알리미의 처리 상태와 종료 여부를 확인하지 못했습니다.');
  return ['답변완료', '처리완료'].includes(normalizeText(status)) && normalizeText(closed) === '종료' ? 'sent' : 'pending';
}
const clean = value => normalizeText(value).replace(/^\[1\]\s*/, '');
const order = value => normalizeText(value).replace(/\s/g, '');
function verifyFields(fields, source, identity) {
  if (fields.error) throw new AppError(fields.error);
  if (clean(fields['브랜드명']) !== normalizeText(source.expectedBrand)) throw new AppError('CS알리미 상세 브랜드가 설정과 다릅니다.');
  if (!identity.order_reference || order(fields['주문번호-순번']) !== order(identity.order_reference) || !matchesCustomer(identity.customer, fields['주문자'])) throw new AppError('CS알리미 목록과 상세의 주문번호·주문자가 다릅니다.');
  if (!fields['알림내용'] || !fields['상품명']) throw new AppError('CS알리미 알림 내용이나 상품명이 비어 있습니다.');
  notificationState(fields['문의상태'], fields['문의종료여부']);
}
const metadata = fields => ({ remote_status: normalizeText(fields['문의상태']), remote_closed: normalizeText(fields['문의종료여부']), response_due: fields['회신기한'] });
async function readDetail(page, origin) {
  await page.waitForURL(url => ['http:', 'https:'].includes(url.protocol), { waitUntil: 'domcontentloaded', timeout: 12000 });
  if (new URL(page.url()).origin !== origin) throw new AppError('CS알리미 상세가 다른 사이트로 이동했습니다. 로그인을 확인하세요.');
  await page.locator('th:visible,td:visible').filter({ hasText: /^\s*알림내용\s*$/ }).waitFor();
  return page.evaluate(readNotificationDetail);
}

export async function collectFashionplusNotifications(context, channel, source, safeUrl) {
  validateNotificationSource(source, channel.id);
  const listUrl = safeUrl(source.url), origin = new URL(listUrl).origin;
  const page = await context.newPage(), items = [], seen = new Set(), detailUrls = new Set();
  const listCheck = () => {
    const current = new URL(page.url());
    if (current.origin !== origin || current.pathname !== '/cs-center/cs-notification') throw new AppError('CS알리미 화면이 아닙니다. 전용 브라우저의 패션플러스 로그인을 확인하세요.');
  };
  let expectedTotal, expectedPages;
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    listCheck();
    await page.locator('thead th:visible').filter({ hasText: /^\s*문의번호\s*$/ }).waitFor();
    for (let number = 1; number <= (source.maxPages || 20); number++) {
      listCheck();
      const input = { kind: 'notification', pageNumber: number };
      const snapshot = await waitForQnaList(page, input);
      if (snapshot.error) throw new AppError(snapshot.error.replaceAll('고객문의', 'CS알리미'));
      expectedTotal ??= snapshot.total; expectedPages ??= snapshot.pages;
      if (snapshot.total !== expectedTotal || snapshot.pages !== expectedPages) throw new AppError('CS알리미 수집 중 전체 건수가 변경되었습니다.');
      for (const row of snapshot.rows) {
        if (!/^\d{1,30}$/.test(row.external_id) || seen.has(row.external_id)) throw new AppError('CS알리미 문의번호가 없거나 중복되었습니다.');
        seen.add(row.external_id);
        if (normalizeText(row.brand) !== normalizeText(source.expectedBrand)) throw new AppError('CS알리미 목록 브랜드가 설정과 다릅니다.');
        notificationState(row.status, '확인 중');
        const link = page.locator(`a[data-cs-qna-link="${row.external_id}"]`);
        if (await link.count() !== 1) throw new AppError('CS알리미 상세 링크를 구분하지 못했습니다.');
        const href = safeUrl(await link.evaluate(el => el.href));
        if (new URL(href).origin !== origin || href !== safeUrl(row.href)) throw new AppError('CS알리미 상세 링크가 다른 사이트이거나 변경되었습니다.');
        const popups = [], remember = popup => popups.push(popup);
        page.on('popup', remember);
        try {
          const before = page.url();
          await link.click();
          let detail;
          const deadline = Date.now() + 12000;
          while (!detail && Date.now() < deadline) {
            if (popups.length > 1) throw new AppError('CS알리미 상세 창이 여러 개 열렸습니다.');
            if (popups.length) detail = popups[0];
            else if (page.url() !== before || await page.locator('th:visible,td:visible').filter({ hasText: /^\s*알림내용\s*$/ }).count()) detail = page;
            else await page.waitForTimeout(100);
          }
          if (!detail) throw new AppError('CS알리미 상세 화면이 열리지 않았습니다.');
          const fields = await readDetail(detail, origin);
          verifyFields(fields, source, row);
          const url = safeUrl(detail.url());
          if (detailUrls.has(url) || url === listUrl) throw new AppError('서로 다른 CS알리미를 구분할 상세 주소가 없습니다.');
          detailUrls.add(url);
          items.push({ channel: channel.id, source: source.id, external_id: row.external_id, inquiry_kind: 'notification', title: row.title || 'CS알리미', customer: fields['주문자'], product: fields['상품명'], body: fields['알림내용'], order_reference: row.order_reference, ...metadata(fields), url });
          if (detail === page) {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 45000 });
            const restored = await waitForQnaList(page, input);
            if (restored.error || restored.signature !== snapshot.signature || restored.total !== snapshot.total || restored.pages !== snapshot.pages) throw new AppError('상세 확인 후 CS알리미 목록이 변경되었습니다. 다시 수집하세요.');
          }
        } finally { page.off('popup', remember); await Promise.all(popups.map(p => p.close().catch(() => {}))); }
      }
      if (number >= snapshot.pages) {
        if (seen.size !== snapshot.total) throw new AppError('CS알리미 전체 건수와 읽은 건수가 다릅니다.');
        return items;
      }
      if (!snapshot.hasNext) throw new AppError('CS알리미 다음 페이지를 확인하지 못했습니다.');
      await page.locator('[data-cs-qna-next]').click();
      await page.waitForFunction(({ before, column }) => {
        const body = document.querySelector('[data-cs-qna-body]');
        return !body || [...body.rows].map(tr => tr.cells[column]?.innerText.trim().replace(/^\[긴급\]\s*/, '') || '').join('|') !== before;
      }, { before: snapshot.signature, column: snapshot.idColumn });
    }
    throw new AppError('CS알리미 수집 페이지 한도에 도달했습니다.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CS알리미 화면을 읽지 못했습니다. 로그인과 목록·상세 화면을 확인하세요.');
  } finally { await page.close(); }
}

export async function checkNotificationCompletion(context, channel, source, inquiry, safeUrl) {
  validateNotificationSource(source, channel.id);
  if (inquiry.inquiry_kind !== 'notification' || inquiry.channel !== channel.id || inquiry.source !== source.id) throw new AppError('CS알리미 완료 확인 대상이 다릅니다.');
  const origin = new URL(safeUrl(source.url)).origin, url = safeUrl(inquiry.url);
  if (new URL(url).origin !== origin) throw new AppError('CS알리미 원문 주소가 다른 사이트입니다.');
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const fields = await readDetail(page, origin);
    verifyFields(fields, source, inquiry);
    if (normalizeText(fields['주문자']) !== normalizeText(inquiry.customer) || clean(fields['상품명']) !== clean(inquiry.product) || normalizeText(fields['알림내용']) !== normalizeText(inquiry.body)) throw new AppError('저장된 CS알리미와 원문 내용이 달라 완료 상태를 갱신하지 않았습니다.');
    return metadata(fields);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CS알리미 종료 상태를 읽지 못했습니다. 로그인과 원문을 확인하세요.');
  } finally { await page.close(); }
}
