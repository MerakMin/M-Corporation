
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { browserOptions } from '../src/connectors.js';
import { readLoginSource } from '../src/login-config.js';
import { resolvedSourceUrl } from '../src/channel-presets.js';
import { inspectInboxStructure } from '../src/page-structure.js';

const dataDir = resolve('.data');
const source = readLoginSource(dataDir, 'cafe24', 'cafe24-0');

if (!source?.url) {
  console.error('카페24 문의함 설정을 찾을 수 없습니다.');
  process.exit(1);
}

const inboxUrl = resolvedSourceUrl(source);
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout
});

let context;

try {
  console.log('카페24 미답변 상품 문의 구조 분석');
  console.log('서버가 종료된 상태에서 실행하세요.');
  console.log('새 로그인이 필요하면 즉시 중단하세요.');
  console.log('고객 문의 내용과 입력값은 저장하지 않습니다.');

  context = await chromium.launchPersistentContext(
    join(dataDir, 'profiles', 'cafe24'),
    browserOptions(false)
  );

  const page = await context.newPage();

await page.goto(
  'https://beyondmyself.cafe24.com/disp/admin/shop1/main/dashboard',
  {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  }
);

await page.goto(inboxUrl, {
  waitUntil: 'domcontentloaded',
  timeout: 45000
});

  await page.bringToFront();

  const answer = await terminal.question(
    '카페24 문의 목록이 정상적으로 보이면 y를 입력하세요. ' +
    '로그인이나 인증 화면이면 n을 입력하세요: '
  );

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('분석을 취소했습니다.');
  } else {
    const structure = await inspectInboxStructure(page, inboxUrl);

    const directory = resolve('diagnostics');
    await mkdir(directory, { recursive: true });

    const filename = join(
      directory,
      'cafe24-structure.json'
    );

    await writeFile(
      filename,
      JSON.stringify({
        format: 1,
        channel: 'cafe24',
        source: 'cafe24-0',
        structure
      }, null, 2),
      { mode: 0o600 }
    );

    console.log('구조 분석 파일 저장 완료');
    console.log('파일 위치: diagnostics/cafe24-structure.json');
  }
} catch {
  console.error(
    '분석에 실패했습니다. 로그인 상태와 문의 목록 화면을 확인하세요.'
  );
} finally {
  terminal.close();
  if (context) await context.close();
}
