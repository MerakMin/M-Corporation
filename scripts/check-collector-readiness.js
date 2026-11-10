// Read-only preflight for the seven channels awaiting live collector setup.
// Does not open a browser, log in, or enable any collection.
import { CHANNELS, defaultChannelConfig } from '../src/channel-presets.js';

const targets = ['cafe24', 'hiver', 'ably', 'lookpin', 'smartstore', 'smartstore_quarter', 'naverpay'];
const required = ['ready', 'row', 'idAttribute', 'link', 'body'];
let incomplete = 0;

for (const id of targets) {
  const channel = CHANNELS.find(item => item.id === id);
  if (!channel) throw new Error(`Missing channel preset: ${id}`);
  const config = defaultChannelConfig(id);
  console.log(`\n${channel.name} (${id})`);
  for (const source of config.sources) {
    const missing = required.filter(key => !String(source.selectors?.[key] ?? '').trim());
    if (missing.length) incomplete++;
    console.log(`  - ${source.name}: ${missing.length ? '설정 필요 (' + missing.join(', ') + ')' : '기본 필수 선택자 있음'}`);
  }
}
console.log(`\n총 ${targets.length}개 채널 / 설정이 필요한 문의함 ${incomplete}개`);
console.log('이 점검은 실제 수집 성공 여부를 확인하지 않습니다.');
