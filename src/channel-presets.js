// User-provided inboxes. URLs are configuration, never evidence of a verified login.
const naverSources = () => [
  { name: '상품 Q&A', url: 'https://sell.smartstore.naver.com/#/comment/' },
  { name: '네이버페이 Q&A', url: 'https://sell.smartstore.naver.com/#/naverpay/qnas' },
  { name: '고객센터 문의', url: 'https://sell.smartstore.naver.com/#/seller/customer-center-cs' },
  { name: '톡톡 미읽음', url: 'https://sell.smartstore.naver.com/#/talktalk/chat?filter.read=unread' },
];
const presets = [
  { id: 'fashionplus', name: '패션플러스', mark: 'F', color: '#a74e8c', sources: [
    { name: 'CS알리미', url: 'https://seller.fashionplus.co.kr/cs-center/cs-notification?status=1' },
    { name: '고객문의 게시판', url: 'https://seller.fashionplus.co.kr/cs-center/qna?status=1', adapter: 'fashionplus-qna-readonly', expectedBrand: '비욘드마이셀프' },
  ] },
  { id: 'coupang', name: '쿠팡', mark: 'C', color: '#da594b', sources: [
    { name: '고객센터 문의', url: 'https://wing.coupang.com/tenants/cs/csinquiry' },
    { name: '고객 문의', url: 'https://wing.coupang.com/tenants/cs/product/inquiries' },
  ] },
  { id: 'cafe24', name: '카페24 자사몰', mark: '24', color: '#3563e9', sources: [
    { name: '미답변 상품 문의', url: 'https://beyondmyself.cafe24.com/admin/php/shop1/b/board_admin_bulletin_l.php?start_date=2026-09-21&end_date=2026-10-21&period=30&sel_board_no=6&sel_spam_view=not&search_channel=&list_limit=10&search=subject&search_key=&is_reply=N&is_comment=&real_filename=&mem_type=&report_status=&board_category=&no_member_article=F&navi_hide=&searchSort=', dateRange: { days: 30, startParam: 'start_date', endParam: 'end_date', periodParam: 'period' } },
  ] },
  { id: 'hiver', name: '하이버', mark: 'H', color: '#323239', sources: [
    { name: '답변 대기 Q&A', url: 'https://seller-admin.hiver.co.kr/qna?page=1&status=%EB%8B%B5%EB%B3%80%EB%8C%80%EA%B8%B0&searchType=%EC%83%81%ED%92%88%EB%B2%88%ED%98%B8&from=2026-09-21&to=2026-10-21', dateRange: { days: 30, startParam: 'from', endParam: 'to' } },
  ] },
  { id: 'ably', name: '에이블리', mark: 'A', color: '#ee5a87', sources: [
    { name: '셀러 문의', url: 'https://my.a-bly.com/inquiry' },
  ] },
  { id: 'lookpin', name: '룩핀', mark: 'L', color: '#273448', sources: [
    { name: '1:1 문의', url: 'https://v3.partner.lookpin.co.kr/main/orderContact' },
    { name: '상품 Q&A', url: 'https://v3.partner.lookpin.co.kr/main/productQuestion' },
  ] },
  { id: 'smartstore', name: '네이버 비욘드', mark: 'N', color: '#03a95c', requireAccountCheck: true,
    expectedAccount: '비욘드마이셀프', sources: naverSources() },
  { id: 'smartstore_quarter', name: '네이버 쿼터', mark: 'Q', color: '#23886e', requireAccountCheck: true,
    expectedAccount: '쿼터', replyShopName: '쿼터', sources: naverSources() },
  { id: 'naverpay', name: '네이버 페이센터', mark: 'N', color: '#00a76a', sources: [
    { name: '고객 문의', url: 'https://admin.pay.naver.com/front/m/v2/customer/inquiry' },
  ] },
];
export const CHANNELS = presets.map(({ sources, expectedAccount, replyShopName, ...channel }) => ({ ...channel, sources: sources.map(s => s.name) }));
export const LEGACY_CHANNELS = [
  { id: 'talktalk', name: '기존 네이버 톡톡', mark: 'T', color: '#00a869', sources: ['파트너 문의'], legacy: true },
  { id: 'kakao', name: '기존 카카오톡채널', mark: 'K', color: '#a58a00', sources: ['채널 채팅'], legacy: true },
];
export function defaultChannelConfig(id) {
  const p = presets.find(p => p.id === id);
  return {
    presetVersion: id === 'fashionplus' ? 4 : 2,
    enabled: false,
    replyShopName: p.replyShopName || '',
    ...(p.expectedAccount ? { accountCheck: { selector: '', expectedText: p.expectedAccount } } : {}),
    sources: p.sources.map((source, i) => ({ ...structuredClone(source), id: `${id}-${i}`, enabled: true, selectors: {} })),
  };
}
export function resolvedSourceUrl(source, now = new Date()) {
  if (!source.url || !source.dateRange) return source.url;
  const { days, startParam, endParam, periodParam } = source.dateRange;
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const url = new URL(source.url);
  url.searchParams.set(startParam, start); url.searchParams.set(endParam, end);
  if (periodParam) url.searchParams.set(periodParam, String(days));
  return url.href;
}
