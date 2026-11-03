import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { browserOptions } from '../src/connectors.js';
import { readLoginSource } from '../src/login-config.js';
import { matchesInboxLocation } from '../src/page-structure.js';
import { COUPANG_INSPECTION_TARGETS, validateCoupangInspectionSource, selectCoupangDetailPage, captureCoupangStructure } from '../src/coupang-inspection.js';

async function main() {
  const kind = process.argv[2] || 'product';
  const target = COUPANG_INSPECTION_TARGETS[kind];
  if (!target) throw new Error('진단 대상은 product 또는 center입니다.');
  const dataDir = resolve(process.env.CS_DATA_DIR || '.data');
  const source = readLoginSource(dataDir, 'coupang', target.sourceId);
  const inboxUrl = validateCoupangInspectionSource(source, kind);
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('로그인할 Windows PC에서 실행하세요.');
  console.log(`진단 대상: 쿠팡 ${target.name}`);
  console.log('서버와 이전 로그인 브라우저를 종료한 상태에서 실행하세요.');
  console.log('이 도구는 답변을 입력하거나 전송하지 않습니다. 고객 내용·입력값·쿠키·URL은 보고서에 저장하지 않습니다.');
  const context = await chromium.launchPersistentContext(join(dataDir, 'profiles', 'coupang'), browserOptions(false));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = await context.newPage();
    await page.goto(inboxUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.bringToFront();
    await terminal.question('1. 열린 브라우저에서 로그인하고 문의 목록이 보이면 이 검은 창으로 돌아와 Enter를 누르세요.\n');
    if (!matchesInboxLocation(page.url(), inboxUrl)) {
      console.log('문의 목록 주소를 다시 엽니다.');
      await page.goto(inboxUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.bringToFront();
      await terminal.question('문의 목록이 보이면 Enter를 누르세요. 다른 화면이면 Ctrl+C로 종료하고 알려주세요.\n');
    }
    const list = await captureCoupangStructure(page, inboxUrl, true);
    const previousPages = new Set(context.pages());
    const answer = await terminal.question('2. 문의 한 건을 직접 열고 본문과 답변 입력란이 보이면 Enter를 누르세요. 열 문의가 없으면 s를 입력하세요. 답변 등록은 누르지 마세요.\n');
    const detail = answer.trim().toLowerCase() === 's' ? null
      : await captureCoupangStructure(await selectCoupangDetailPage(context, page, previousPages), inboxUrl);
    const directory = resolve('diagnostics');
    await mkdir(directory, { recursive: true });
    const filename = join(directory, `coupang-${kind}-structure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(filename, JSON.stringify({ format: 3, channel: 'coupang', source: target.sourceId, list, detail }, null, 2), { mode: 0o600 });
    console.log(`진단 파일 저장 완료: ${filename}`);
    console.log('이 JSON 파일만 채팅에 첨부하세요. 쿠팡 수집 연결은 아직 완료되지 않았습니다.');
  } finally { terminal.close(); await context.close(); }
}

main().catch(() => {
  // Browser exceptions can include customer URLs; do not print raw exceptions.
  console.error('쿠팡 진단을 완료하지 못했습니다. 서버·기존 로그인 브라우저를 종료하고 문의 목록이 열리는지 확인하세요. 문의 팝업은 하나만 열어 주세요.');
  process.exitCode = 1;
});
