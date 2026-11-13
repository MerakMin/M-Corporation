
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { browserOptions } from '../src/connectors.js';
import {
  collectCafe24Inquiries,
  collectCafe24Detail
} from '../src/cafe24-collector.js';

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
  console.log('카페24 전체 문의 본문 수집 테스트');
  console.log('고객 문의 내용은 터미널에 출력하지 않습니다.');

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

  const answer = await terminal.question(
    '상품 문의 목록이 보이면 y를 입력하세요: '
  );

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('테스트 취소');
  } else {
    const inquiries = await collectCafe24Inquiries(page);

    const tables = page.locator('table');
    let inquiryTable = null;
    let titleIndex = -1;

    for (let i = 0; i < await tables.count(); i++) {
      const candidate = tables.nth(i);
      const headers = (
        await candidate.locator('thead th').allTextContents()
      ).map(text => text.trim());

      if (
        headers.includes('번호') &&
        headers.includes('제목') &&
        headers.includes('답변상태')
      ) {
        inquiryTable = candidate;
        titleIndex = headers.indexOf('제목');
        break;
      }
    }

    if (!inquiryTable) {
      throw new Error('문의 목록 테이블을 찾지 못했습니다.');
    }

    const rows = inquiryTable.locator('tbody tr');
    const total = Math.min(inquiries.length, await rows.count());

    const results = [];

    for (let i = 0; i < total; i++) {
      let popup;

      try {
        const titleLink = rows
          .nth(i)
          .locator('td')
          .nth(titleIndex)
          .locator('a')
          .first();

        const popupPromise = context.waitForEvent('page', {
          timeout: 15000
        });

        await titleLink.click();
        popup = await popupPromise;

        await popup.waitForLoadState('domcontentloaded');

        const detail = await collectCafe24Detail(popup);

        results.push({
          row: i + 1,
          success: detail.success,
          bodyLength: detail.body.length
        });
      } catch (error) {
        results.push({
          row: i + 1,
          success: false,
          errorType: error.name
        });
      } finally {
        if (popup && !popup.isClosed()) {
          await popup.close();
        }
      }
    }

    console.log('=== 전체 문의 본문 수집 결과 ===');
    console.log(JSON.stringify({
      total,
      successCount: results.filter(item => item.success).length,
      failedCount: results.filter(item => !item.success).length,
      results
    }, null, 2));
  }
} catch (error) {
  console.error('테스트 실패:', error.message);
} finally {
  terminal.close();
  if (context) await context.close();
}
