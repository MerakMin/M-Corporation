import bcrypt from 'bcryptjs';
import { AppError } from './domain.js';

export const NAVER_INQUIRIES = 'naver-inquiries-readonly';
export const NAVER_SEND_BLOCKED = '네이버 문의입니다. 문의 번호를 확인하고 해당 판매자센터에서 직접 답변하세요.';
const base = 'https://api.commerce.naver.com/external/v1';
const prefixes = { smartstore: 'BEYOND', smartstore_quarter: 'QUARTER', naverpay: 'PAY' };
const smartstore = 'https://sell.smartstore.naver.com/#/';
const payCenter = 'https://admin.pay.naver.com/front/m/v2/customer/inquiry';

export function validateNaverSource(source, channelId) {
  const isProduct = channelId !== 'naverpay' && source.id === `${channelId}-0`;
  const expected = channelId === 'naverpay' ? payCenter : smartstore + (isProduct ? 'comment/' : 'naverpay/qnas');
  const ids = channelId === 'naverpay' ? ['naverpay-0'] : [`${channelId}-0`, `${channelId}-1`];
  if (!Object.hasOwn(prefixes, channelId) || !ids.includes(source.id) || source.url !== expected) throw new AppError('네이버 전용 문의함 주소를 확인하세요.');
  return isProduct;
}

export function naverCredentials(channelId, env = process.env) {
  const prefix = prefixes[channelId];
  const clientId = env[`CS_NAVER_${prefix}_CLIENT_ID`]?.trim();
  const secret = env[`CS_NAVER_${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{22}(?:[./A-Za-z0-9]{31})?$/.test(secret || '')) {
    throw new AppError('이 네이버 채널의 커머스API 환경변수를 확인하세요.');
  }
  if (Object.values(prefixes).some(other => other !== prefix && env[`CS_NAVER_${other}_CLIENT_ID`]?.trim() === clientId)) {
    throw new AppError('네이버 채널마다 서로 다른 판매자 계정의 API 앱을 사용하세요.');
  }
  return { clientId, secret };
}

async function json(request, url, options, label) {
  try {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new AppError(`네이버 ${label} 실패 (HTTP ${response.status}).`);
    return await response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`네이버 ${label} 응답을 읽지 못했습니다.`);
  }
}

export function createNaverCollector(request = (...args) => fetch(...args)) {
  const tokens = new Map();
  return async function collect(channel, source, now = new Date()) {
    const isProduct = validateNaverSource(source, channel.id);
    const { clientId, secret } = naverCredentials(channel.id);
    let token = tokens.get(channel.id);
    if (!token || token.clientId !== clientId || token.secret !== secret || token.until <= Date.now()) {
      const timestamp = String(Date.now());
      let signature;
      try { signature = Buffer.from(await bcrypt.hash(`${clientId}_${timestamp}`, secret)).toString('base64'); }
      catch { throw new AppError('네이버 커머스API 시크릿 형식을 확인하세요.'); }
      const body = new URLSearchParams({ client_id: clientId, timestamp, client_secret_sign: signature, grant_type: 'client_credentials', type: 'SELF' });
      const result = await json(request, `${base}/oauth2/token`, { method: 'POST', body }, '토큰 발급');
      if (typeof result?.access_token !== 'string' || !/^\S+$/.test(result.access_token)
          || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new AppError('네이버 인증 토큰 응답을 확인하세요.');
      token = { clientId, secret, value: result.access_token, until: Date.now() + (result.expires_in - 60) * 1000 };
      tokens.set(channel.id, token);
    }
    const start = new Date(now.getTime() - 29 * 86400000);
    const koreaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
    const dates = isProduct
      ? { fromDate: new Date(`${koreaDate.format(start)}T00:00:00+09:00`).toISOString(), toDate: now.toISOString() }
      : { startSearchDate: koreaDate.format(start), endSearchDate: koreaDate.format(now) };
    const endpoint = isProduct ? '/contents/qnas' : '/pay-user/inquiries';
    const items = [], seen = new Set();
    let expected;
    for (let page = 1; page <= (source.maxPages || 20); page++) {
      const query = new URLSearchParams({ ...dates, page: String(page), size: '100', answered: 'false' });
      let result;
      try {
        result = await json(request, `${base}${endpoint}?${query}`, {
          method: 'GET', headers: { Authorization: `Bearer ${token.value}`, Accept: 'application/json' },
        }, '문의 조회');
      } catch (error) {
        tokens.delete(channel.id);
        throw error;
      }
      const rows = isProduct ? result?.contents : result?.content;
      const { totalPages, totalElements, last } = result || {};
      if (!Array.isArray(rows) || !Number.isSafeInteger(totalPages) || totalPages < 0
          || !Number.isSafeInteger(totalElements) || totalElements < 0 || last !== (page >= totalPages)
          || (expected && (totalElements !== expected.totalElements || totalPages !== expected.totalPages))) {
        throw new AppError('네이버 문의 목록의 페이지 정보를 확인하세요.');
      }
      expected = { totalPages, totalElements };
      for (const row of rows) {
        const id = isProduct ? row?.questionId : row?.inquiryNo;
        const body = isProduct ? row?.question : row?.inquiryContent;
        const date = Date.parse(isProduct ? row?.createDate : row?.inquiryRegistrationDateTime);
        if (!Number.isSafeInteger(id) || id < 1 || seen.has(id) || row.answered !== false
            || typeof body !== 'string' || !body.trim() || !Number.isFinite(date)) {
          throw new AppError('네이버 문의 번호·본문·답변 상태를 확인하세요.');
        }
        seen.add(id);
        items.push({
          channel: channel.id, source: source.id, external_id: String(id), body,
          title: !isProduct && typeof row.title === 'string' ? row.title : '상품 Q&A',
          customer: (isProduct ? row.maskedWriterId : row.customerName) || '',
          product: row.productName || '', created_at: new Date(date).toISOString(), url: source.url,
        });
      }
      if (last) {
        if (items.length !== totalElements) throw new AppError('네이버 문의 건수가 페이지 정보와 다릅니다.');
        return items;
      }
      if (!rows.length) throw new AppError('네이버 문의 조회 중 빈 페이지가 반환됐습니다.');
    }
    throw new AppError('네이버 수집 페이지 한도에 도달했습니다.');
  };
}
