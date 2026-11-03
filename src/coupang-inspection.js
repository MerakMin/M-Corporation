import { inspectInboxStructure, inspectPageStructure } from './page-structure.js';

export const COUPANG_INSPECTION_TARGETS = {
  product: { sourceId: 'coupang-1', name: '고객 문의', path: '/tenants/cs/product/inquiries' },
  center: { sourceId: 'coupang-0', name: '고객센터 문의', path: '/tenants/cs/csinquiry' },
};

export function validateCoupangInspectionSource(source, kind) {
  const target = COUPANG_INSPECTION_TARGETS[kind];
  let url;
  try { url = new URL(source?.url); } catch { /* Report a fixed message below. */ }
  if (!target || source?.id !== target.sourceId || !url || url.origin !== 'https://wing.coupang.com'
      || url.username || url.password || url.pathname.replace(/\/$/, '') !== target.path) {
    throw new Error('쿠팡 문의 주소 설정을 확인하세요.');
  }
  return url.href;
}

async function checkPage(page) {
  if (!page || page.isClosed() || new URL(page.url()).origin !== 'https://wing.coupang.com'
      || !new URL(page.url()).pathname.startsWith('/tenants/cs/')) {
    throw new Error('쿠팡 문의 화면으로 돌아온 뒤 다시 실행하세요.');
  }
  for (const frame of page.frames()) {
    const passwords = frame.locator('input[type="password"]');
    for (let i = 0; i < await passwords.count(); i++) {
      if (await passwords.nth(i).isVisible()) throw new Error('로그인 화면에서는 진단 파일을 저장할 수 없습니다.');
    }
  }
}

// Ignore tabs restored from an earlier session. Only the list tab and a popup
// opened by that tab after the list capture can be used as the detail page.
export async function selectCoupangDetailPage(context, listPage, previousPages) {
  const popups = [];
  for (const page of context.pages()) {
    if (!page.isClosed() && !previousPages.has(page) && await page.opener() === listPage) popups.push(page);
  }
  if (popups.length > 1) throw new Error('새 문의 창이 여러 개입니다. 확인할 문의 창 하나만 남겨 주세요.');
  return popups[0] || listPage;
}

export async function captureCoupangStructure(page, inboxUrl, list = false) {
  await checkPage(page);
  const report = list ? await inspectInboxStructure(page, inboxUrl) : await inspectPageStructure(page);
  await checkPage(page);
  return report;
}
