export const CATEGORIES = ['배송', '반품', '교환', '환불', '할인', '사이즈', '기타'];
export { CHANNELS } from './channel-presets.js';
export const DEFAULT_TEMPLATES = {
  배송: '안녕하세요 고객님, {{shop}}입니다.\n우선 기다리게 해드려 죄송합니다.\n현재 고객님 주문 상품은 [입고 예정일] 입고 예정입니다.\n입고 즉시 순차 출고되며, 출고 시 송장번호로 안내드리겠습니다.\n감사합니다.',
  반품: '안녕하세요 고객님, {{shop}}입니다.\n상품 이용에 아쉬움이 있으셨군요. 반품 절차를 안내드리겠습니다.\n반품 가능 여부 및 접수 기한: [반품 규정 확인]\n접수 방법: [반품 접수 방법]\n상품 상태와 반품 사유를 알려주시면 확인 후 도와드리겠습니다.',
  교환: '안녕하세요 고객님, {{shop}}입니다.\n상품 교환으로 번거로우셨겠습니다.\n단순변심 교환은 왕복 배송비가 발생합니다. 금액은 [교환 배송비]입니다.\n오배송·불량인 경우 배송비는 저희가 전액 부담합니다.\n사진 한 장만 보내주시면 바로 확인해 도와드리겠습니다.',
  환불: '안녕하세요 고객님, {{shop}}입니다.\n환불 진행 상황을 확인해 도와드리겠습니다.\n현재 처리 상태: [환불 처리 상태]\n환불 예정일: [결제 수단별 환불 일정 확인]\n확인 후 정확하게 안내드리겠습니다. 감사합니다.',
  할인: '안녕하세요 고객님, {{shop}}입니다.\n관심 가져주셔서 감사합니다.\n적용 가능한 할인·쿠폰: [할인 조건 확인]\n사용 방법과 기간: [쿠폰 사용 방법 및 유효기간]\n감사합니다.',
  사이즈: '안녕하세요 고객님, {{shop}}입니다.\n문의하신 상품의 실측을 안내드립니다.\n{{measurements}}\n평소 잘 맞는 옷의 실측과 비교해 주세요. 착용감은 체형과 취향에 따라 개인차가 있을 수 있습니다.\n추가로 궁금한 점이 있으시면 말씀해 주세요.',
  기타: '안녕하세요 고객님, {{shop}}입니다.\n문의해 주셔서 감사합니다.\n[문의 내용 확인 후 답변 작성]\n감사합니다.',
};
export function classify(text) {
  const rules = [
    ['교환', /교환|오배송|불량/], ['환불', /환불|결제\s*취소|입금.*언제/],
    ['반품', /반품|반송/], ['사이즈', /사이즈|실측|총장|어깨|가슴|허리|\d+\s*(cm|kg)|키가|몸무게/],
    ['할인', /할인|쿠폰|적립금|프로모션/], ['배송', /배송|출고|입고|송장|택배|언제.*(오|도착|받)/],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || '기타';
}
export function missingFields(text) {
  return [...new Set(text.match(/\[[^\]\n]+\]|\{\{[^}]+\}\}|○{2,}/g) || [])];
}
export function makeDraft(inquiry, templates, shop, products) {
  const product = products.find(p => p.name === inquiry.product);
  const measurements = product?.sizes?.length
    ? product.sizes.map(s => `${s.size}: ${[['length', '총장'], ['shoulder', '어깨'], ['chest', '가슴'], ['waist', '허리']].filter(([key]) => s[key] != null && s[key] !== '').map(([key, label]) => `${label} ${s[key]}cm`).join(' · ')}`).join('\n')
    : '[상품 실측 정보 확인]';
  return (templates[inquiry.category] || DEFAULT_TEMPLATES.기타)
    .replaceAll('{{shop}}', shop || '[상호명]')
    .replaceAll('{{customer}}', inquiry.customer || '고객')
    .replaceAll('{{product}}', inquiry.product || '[상품명]')
    .replaceAll('{{measurements}}', measurements);
}
export function normalizeText(text) { return text.replace(/\s+/g, ' ').trim(); }
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
