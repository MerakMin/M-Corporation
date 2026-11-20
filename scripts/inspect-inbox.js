import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CHANNELS, defaultChannelConfig, resolvedSourceUrl } from '../src/channel-presets.js';
import { browserOptions, safeUrl } from '../src/connectors.js';
import { readLoginSource } from '../src/login-config.js';
import { inspectInboxStructure, inspectPageStructure, matchesInboxLocation } from '../src/page-structure.js';
import { selectCoupangDetailPage } from '../src/coupang-inspection.js';

async function main() {
  const argument = process.argv[2];
  const targets = CHANNELS.flatMap(channel => defaultChannelConfig(channel.id).sources.map(source => ({ channel, source })));
  if (!argument || argument === '--list') {
    for (const { channel, source } of targets) console.log(`${source.id.padEnd(22)} ${channel.name} / ${source.name}`);
    return;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let context;
  try {
    let id = argument;
    if (argument === '--menu') {
      console.log('서버와 기존 로그인 브라우저를 먼저 종료하세요.');
      targets.forEach(({ channel, source }, index) => console.log(`${index + 1}. ${channel.name} / ${source.name}`));
      const choice = (await terminal.question('진단할 문의함 번호를 입력하세요. 종료하려면 Enter를 누르세요.\n')).trim();
      if (!choice) return;
      if (!/^\d+$/.test(choice)) throw new Error('문의함 번호를 확인하세요.');
      id = targets[Number(choice) - 1]?.source.id;
    }
    const target = targets.find(({ source }) => source.id === id);
    if (!target) throw new Error('문의함 ID를 확인하세요.');
    const dataDir = resolve(process.env.CS_DATA_DIR || '.data');
    const source = readLoginSource(dataDir, target.channel.id, id);
    const inbox = safeUrl(resolvedSourceUrl(source || {}));
    const origin = new URL(inbox).origin;
    if (origin !== new URL(target.source.url).origin) throw new Error('등록된 플랫폼 주소를 확인하세요.');
    console.log(`${target.channel.name} / ${source.name}`);
    console.log('서버와 기존 로그인 브라우저를 먼저 종료하세요. 보고서는 화면 구조만 저장합니다.');
    context = await chromium.launchPersistentContext(join(dataDir, 'profiles', target.channel.id), browserOptions(false));
    const page = await context.newPage();
    await page.goto(inbox, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await terminal.question('브라우저에서 로그인하고 선택한 문의함을 연 뒤 Enter를 누르세요.\n');
    if (!matchesInboxLocation(page.url(), inbox)) {
      await page.goto(inbox, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await terminal.question('문의 목록이 표시되면 Enter를 누르세요.\n');
    }
    const list = await inspectInboxStructure(page, inbox);
    const previousPages = new Set(context.pages());
    const choice = await terminal.question('문의 한 건을 열고 Enter를 누르세요. 0건이면 s를 입력하세요.\n');
    let detail = null;
    if (choice.trim().toLowerCase() !== 's') {
      const detailPage = await selectCoupangDetailPage(context, page, previousPages);
      const verify = async () => {
        if (new URL(detailPage.url()).origin !== origin) throw new Error('같은 플랫폼의 문의 상세 화면이 필요합니다.');
        for (const frame of detailPage.frames()) {
          const visiblePasswords = frame.locator('input[type="password"]:visible');
          if (await visiblePasswords.count()) throw new Error('로그인 화면은 진단할 수 없습니다.');
        }
      };
      await verify();
      detail = await inspectPageStructure(detailPage);
      await verify();
    }
    const directory = resolve('diagnostics');
    await mkdir(directory, { recursive: true });
    const filename = join(directory, `${id}-structure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(filename, JSON.stringify({ format: 3, channel: target.channel.id, source: id, list, detail }, null, 2), { mode: 0o600 });
    console.log(`보고서 저장: ${filename}`);
  } finally {
    terminal.close();
    await context?.close();
  }
}

main().catch(() => {
  console.error('문의함 진단에 실패했습니다. npm run inspect:inbox -- --list로 ID를 확인하고 서버·기존 로그인 브라우저를 종료한 뒤 다시 실행하세요.');
  process.exitCode = 1;
});
