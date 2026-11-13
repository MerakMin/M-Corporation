
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { browserOptions } from '../src/connectors.js';
import { collectCafe24Inquiries } from '../src/cafe24-collector.js';

const dataDir = resolve('.data');

const dashboardUrl =
  'https://beyondmyself.cafe24.com/disp/admin/shop1/main/dashboard';

const inboxUrl =
  'https://beyondmyself.cafe24.com/admin/php/shop1/b/board_admin_bulletin_l.php?sel_board_no=6';

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout
});

let context;

try {
  console.log('카페24 문의 수집기 테스트');
  console.log('읽기 전용 테스트입니다.');

  context = await chromium.launchPersistentContext(
    join(dataDir, 'profiles', 'cafe24'),
    browserOptions(false)
  );

  const page = await context.newPage();

  await page.goto(dashboardUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForURL(
    url => url.pathname.includes('/disp/admin/shop1/main/dashboard'),
    { timeout: 60000 }
  );

  await page.goto(inboxUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.bringToFront();

  const answer = await terminal.question(
    '상품 문의 목록이 정상적으로 보이면 y를 입력하세요: '
  );

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('테스트를 취소했습니다.');
  } else {
    // 1. 실제 문의 목록 테이블 찾기
    const tables = page.locator('table');

    let inquiryTable = null;
    let titleIndex = -1;

    for (let i = 0; i < await tables.count(); i++) {
      const candidate = tables.nth(i);

      const headers = (
        await candidate.locator('thead th').allTextContents()
      ).map(text => text.trim());

      if (
        headers.includes('제목') &&
        headers.includes('답변상태')
      ) {
        inquiryTable = candidate;
        titleIndex = headers.indexOf('제목');
        break;
      }
    }

    if (!inquiryTable || titleIndex < 0) {
      throw new Error('카페24 문의 목록 테이블을 찾지 못했습니다.');
    }

    console.log('카페24 문의 테이블 선택 성공');

    // 2. 문의 제목 링크 찾기
    const firstTitle = inquiryTable
      .locator('tbody tr')
      .first()
      .locator('td')
      .nth(titleIndex)
      .locator('a')
      .first();

    console.log('카페24 문의 상세 창 열기 테스트 시작');

    // 3. 새 창 감지 준비 후 제목 클릭
    const popupPromise = context.waitForEvent('page', {
      timeout: 15000
    });

    await firstTitle.click();

    const popup = await popupPromise;

    await popup.waitForLoadState('domcontentloaded');

    // 4. 개인정보를 출력하지 않고 구조만 확인
    const detailCheck = await popup.evaluate(() => ({
      hasBody: Boolean(document.body?.innerText.trim()),
      hasTitle: Boolean(document.title.trim()),
      hasContentArea: Boolean(
        document.querySelector(
          '.detail, .board_view, .view, #content'
        )
      )
    }));

    console.log('=== 카페24 상세 창 감지 결과 ===');
    console.log(JSON.stringify(detailCheck, null, 2));

const structureCheck = await popup.evaluate(() => {
  const selectors = [
    '#content',
    '.detail',
    '.board_view',
    '.view',
    'article',
    'iframe'
  ];

  return selectors.map(selector => {
    const elements = Array.from(
      document.querySelectorAll(selector)
    );

    return {
      selector,
      count: elements.length,
      elements: elements.slice(0, 3).map(element => ({
        tag: element.tagName,
        id: element.id,
        className:
          typeof element.className === 'string'
            ? element.className
            : ''
      }))
    };
  });
});

console.log('=== 카페24 상세페이지 구조 ===');
console.log(JSON.stringify(structureCheck, null, 2));

const bodyStructure = await popup.evaluate(() => {
  const selectors = [
    '.detail',
    '.view'
  ];

  return selectors.map(selector => {
    const elements = Array.from(
      document.querySelectorAll(selector)
    );

    return {
      selector,
      elements: elements.map((element, index) => ({
        index,
        textLength: (element.innerText ?? '').trim().length,
        htmlLength: element.innerHTML.length,
        children: Array.from(element.children)
          .slice(0, 10)
          .map(child => ({
            tag: child.tagName,
            className:
              typeof child.className === 'string'
                ? child.className
                : '',
            textLength: (child.innerText ?? '').trim().length
          }))
      }))
    };
  });
});

console.log('=== 카페24 본문 영역 분석 ===');
console.log(JSON.stringify(bodyStructure, null, 2));

const bodyCheck = await popup.evaluate(() => {
  const bodyElement = document.querySelector(
    '.detail .fr-view-article'
  );

  if (!bodyElement) {
    return {
      found: false,
      hasText: false,
      textLength: 0
    };
  }

  const body = (bodyElement.innerText ?? '').trim();

  return {
    found: true,
    hasText: body.length > 0,
    textLength: body.length
  };
});

console.log('=== 카페24 문의 본문 추출 테스트 ===');
console.log(JSON.stringify(bodyCheck, null, 2));

    await popup.close();

    // 5. 기존 문의 수집 기능도 다시 확인
    const inquiries = await collectCafe24Inquiries(page);

    const statusCounts = {
      pending: 0,
      completed: 0,
      unknown: 0
    };

    for (const inquiry of inquiries) {
      statusCounts[inquiry.status] =
        (statusCounts[inquiry.status] ?? 0) + 1;
    }

    console.log('=== 카페24 수집기 테스트 결과 ===');
    console.log(JSON.stringify({
      totalCollected: inquiries.length,
      statusCounts,
      requiredFieldsPresent: inquiries.every(
        item => item.number && item.title && item.createdAt
      )
    }, null, 2));
  }
} catch (error) {
  console.error('테스트 실패:', error.message);
} finally {
  terminal.close();
  if (context) await context.close();
}

export async function collectCafe24Detail(popup) {
  const result = await popup.evaluate(() => {
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

  return result;
}
