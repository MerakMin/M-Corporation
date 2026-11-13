
/**
 * 카페24 상품 문의 목록 수집기
 * 읽기 전용: 게시물 수정 및 답변 등록 없음
 */

export function classifyCafe24Status(status) {
  const value = String(status ?? '').trim();

  if (value === '답변전') return 'pending';
  if (value === '답변완료') return 'completed';

  return 'unknown';
}

export async function collectCafe24Inquiries(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));

    const table = tables.find(element => {
      const headers = Array.from(
        element.querySelectorAll('thead th')
      ).map(th => th.textContent.trim());

      return headers.includes('번호') &&
        headers.includes('제목') &&
        headers.includes('답변상태') &&
        headers.includes('작성일');
    });

    if (!table) {
      throw new Error('카페24 문의 테이블을 찾지 못했습니다.');
    }

    const headers = Array.from(
      table.querySelectorAll('thead th')
    ).map(th => th.textContent.trim());

    const getIndex = name => headers.indexOf(name);

    const inquiries = Array.from(
      table.querySelectorAll('tbody tr')
    ).map(row => {
      const cells = Array.from(row.querySelectorAll('td'));

      const getText = name => {
        const index = getIndex(name);
        return index < 0
          ? ''
          : (cells[index]?.textContent ?? '').trim();
      };

      return {
        number: getText('번호'),
        productName: getText('상품명'),
        title: getText('제목'),
        answerStatus: getText('답변상태'),
        createdAt: getText('작성일')
      };
    });

    return inquiries.filter(item => item.number && item.title);
  }).then(inquiries => inquiries.map(item => ({
    ...item,
    status: classifyCafe24Status(item.answerStatus)
  })));
}


/**
 * 카페24 상품 문의 상세 본문 수집
 * 읽기 전용: 답변 등록 및 수정 없음
 */
export async function collectCafe24Detail(popup) {
  return popup.evaluate(() => {
    const bodyElement = document.querySelector(
      '.detail .fr-view-article'
    );

    if (!bodyElement) {
      return {
        success: false,
        body: ''
      };
    }

    const body = (bodyElement.innerText ?? '').trim();

    return {
      success: body.length > 0,
      body
    };
  });
}
