import { createHmac } from 'node:crypto';
import { AppError } from './domain.js';

export const COUPANG_CENTER = 'coupang-center-readonly';
export const CENTER_SEND_BLOCKED = '쿠팡 고객센터 문의입니다. 상담번호를 확인하고 쿠팡 Wing에서 직접 처리하세요.';
const inbox = 'https://wing.coupang.com/tenants/cs/csinquiry';

export function validateCoupangCenterSource(source, channel) {
  if (channel !== 'coupang' || source.id !== 'coupang-0' || source.url !== inbox) {
    throw new AppError('쿠팡 고객센터 전용 문의함 주소를 확인하세요.');
  }
}

export function centerCredentials(env = process.env) {
  const { CS_COUPANG_VENDOR_ID: vendorId, CS_COUPANG_ACCESS_KEY: accessKey, CS_COUPANG_SECRET_KEY: secretKey } = env;
  if (!/^[A-Za-z0-9]+$/.test(vendorId || '') || !/^[A-Za-z0-9_-]+$/.test(accessKey || '') || !secretKey?.trim()) {
    throw new AppError('쿠팡 고객센터 Open API 환경변수를 확인하세요.');
  }
  return { vendorId, accessKey, secretKey };
}

export async function collectCoupangCenter(channel, source, { request = fetch, now = new Date(), credentials = centerCredentials() } = {}) {
  validateCoupangCenterSource(source, channel.id);
  const { vendorId, accessKey, secretKey } = credentials;
  const path = `/v2/providers/openapi/apis/api/v5/vendors/${vendorId}/callCenterInquiries`;
  const koreaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const inquiryEndAt = koreaDate.format(now);
  const inquiryStartAt = koreaDate.format(new Date(now.getTime() - 6 * 86400000));
  const items = [];
  const seen = new Set();
  let expected;
  for (let pageNum = 1; pageNum <= (source.maxPages || 20); pageNum++) {
    const query = new URLSearchParams({ inquiryStartAt, inquiryEndAt, vendorId, partnerCounselingStatus: 'NO_ANSWER', pageSize: '30', pageNum: String(pageNum) }).toString();
    const signedAt = new Date().toISOString().slice(2, 19).replace(/[-:]/g, '') + 'Z';
    const signature = createHmac('sha256', secretKey).update(signedAt + 'GET' + path + query).digest('hex');
    let result;
    try {
      const response = await request(`https://api-gateway.coupang.com${path}?${query}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedAt}, signature=${signature}` },
      });
      if (!response.ok) throw new AppError(`쿠팡 고객센터 조회 실패 (HTTP ${response.status}).`);
      result = await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('쿠팡 고객센터 API 응답을 읽지 못했습니다.');
    }
    const { content, pagination } = result?.data || {};
    const { currentPage, totalPages, totalElements } = pagination || {};
    if (result?.code !== 200 || !Array.isArray(content) || currentPage !== pageNum
        || !Number.isSafeInteger(totalPages) || totalPages < 0 || !Number.isSafeInteger(totalElements) || totalElements < 0
        || (expected && (expected.pages !== totalPages || expected.count !== totalElements))) {
      throw new AppError('쿠팡 고객센터 목록 또는 페이지 정보가 올바르지 않습니다.');
    }
    expected = { pages: totalPages, count: totalElements };
    for (const row of content) {
      const id = row?.inquiryId;
      const inquiryAt = typeof row?.inquiryAt === 'string' ? Date.parse(row.inquiryAt) : NaN;
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || !Number.isFinite(inquiryAt)
          || row.csPartnerCounselingStatus !== 'requestAnswer') {
        throw new AppError('쿠팡 고객센터 문의 번호·상태·시각 또는 페이지 중복을 확인하세요.');
      }
      const transfer = Array.isArray(row.replies) ? row.replies
        .filter(reply => reply?.answerType === 'csAgent' && reply.partnerTransferStatus === 'requestAnswer')
        .map(reply => typeof reply.content === 'string' ? reply.content.trim() : '').filter(Boolean) : [];
      const body = transfer.join('\n\n') || (typeof row.content === 'string' ? row.content.trim() : '');
      if (!body || body === '상담이력') throw new AppError('쿠팡 고객센터 문의 본문을 확인할 수 없습니다.');
      seen.add(id);
      items.push({
        channel: channel.id, source: source.id, external_id: String(id), title: '쿠팡 고객센터 문의',
        body, product: typeof row.itemName === 'string' ? row.itemName : '', url: inbox,
        created_at: new Date(inquiryAt).toISOString(),
      });
    }
    if (pageNum >= totalPages) {
      if (items.length !== totalElements) throw new AppError('쿠팡 고객센터 문의 건수가 페이지 정보와 다릅니다.');
      return items;
    }
    if (!content.length) throw new AppError('쿠팡 고객센터 조회 중 빈 페이지가 반환됐습니다.');
  }
  throw new AppError('쿠팡 고객센터 수집 페이지 한도에 도달했습니다.');
}
