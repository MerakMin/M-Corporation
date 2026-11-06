import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, CHANNELS, DEFAULT_TEMPLATES, classify, makeDraft } from './domain.js';
import { defaultChannelConfig, LEGACY_CHANNELS } from './channel-presets.js';
import { notificationState, NOTICE_SEND_BLOCKED } from './fashionplus-notifications.js';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'desk.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, config TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unconfigured', last_sync TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS inquiries (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, channel TEXT NOT NULL, source TEXT NOT NULL,
      external_id TEXT NOT NULL, customer TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      product TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL, draft TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, collected_at TEXT NOT NULL,
      sent_at TEXT, sent_body TEXT, error TEXT, version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(mode, channel, source, external_id)
    );
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, mode TEXT NOT NULL, name TEXT NOT NULL, sizes TEXT NOT NULL, UNIQUE(mode, name));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, inquiry_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(inquiries)').all().some(column => column.name === 'detail_external_id')) db.exec("ALTER TABLE inquiries ADD COLUMN detail_external_id TEXT NOT NULL DEFAULT ''");
  for (const [name, type] of [['completion_origin', "TEXT NOT NULL DEFAULT ''"], ['remote_status_checked_at', 'TEXT']]) {
    if (!db.prepare('PRAGMA table_info(inquiries)').all().some(column => column.name === name)) db.exec(`ALTER TABLE inquiries ADD COLUMN ${name} ${type}`);
  }
  for (const name of ['inquiry_kind', 'order_reference', 'remote_status', 'remote_closed', 'response_due']) {
    if (!db.prepare('PRAGMA table_info(inquiries)').all().some(column => column.name === name)) db.exec(`ALTER TABLE inquiries ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${name === 'inquiry_kind' ? 'customer' : ''}'`);
  }
  const getSetting = key => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  if (!getSetting('shop')) setSetting('shop', '비욘드마이셀프');
  if (!getSetting('templates')) setSetting('templates', DEFAULT_TEMPLATES);
  // Preserve user configuration while filling previously empty URLs and adding inboxes.
  for (const channel of CHANNELS) {
    const defaults = defaultChannelConfig(channel.id);
    const row = db.prepare('SELECT config FROM channels WHERE id=?').get(channel.id);
    if (!row) {
      db.prepare('INSERT INTO channels (id, config) VALUES (?,?)').run(channel.id, JSON.stringify(defaults));
      continue;
    }
    const previous = JSON.parse(row.config);
    // Correct the original preset label without replacing custom sources,
    // selectors, filters, or names supplied by the user.
    if (channel.id === 'fashionplus') {
      const original = previous.sources.find(source => source.id === 'fashionplus-0'
        && source.name === '고객 문의' && source.url === defaults.sources[0].url);
      if (original) {
        original.name = 'CS알리미';
        db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), channel.id);
      }
      if (previous.presetVersion >= 2 && previous.presetVersion < 3) {
        const qna = defaults.sources.find(source => source.id === 'fashionplus-1');
        if (!previous.sources.some(source => source.id === qna.id)) {
          previous.sources.push({ ...qna, enabled: false });
        }
        previous.presetVersion = 3;
        db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), channel.id);
      }
      if (previous.presetVersion >= 2 && previous.presetVersion < 4) {
        const preset = defaults.sources.find(source => source.id === 'fashionplus-1');
        const qna = previous.sources.find(source => source.id === preset.id);
        if (qna && qna.url === preset.url && !qna.adapter && !Object.values(qna.selectors || {}).some(value => value?.trim())) {
          qna.adapter = preset.adapter;
          qna.expectedBrand = preset.expectedBrand;
          // Installing an adapter must not start a previously unmapped inbox.
          qna.enabled = false;
        }
        previous.presetVersion = 4;
        db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), channel.id);
      }
      if (previous.presetVersion >= 2 && previous.presetVersion < 5) {
        const preset = defaults.sources[0], source = previous.sources.find(s => s.id === preset.id);
        if (source && source.url === preset.url && !source.adapter && !Object.values(source.selectors || {}).some(value => value?.trim())) {
          source.adapter = preset.adapter; source.expectedBrand = preset.expectedBrand;
          source.enabled = false;
        }
        previous.presetVersion = 5;
        db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), channel.id);
      }
    }
    if (channel.id === 'coupang' && previous.presetVersion >= 2 && previous.presetVersion < 3) {
      const preset = defaults.sources.find(s => s.id === 'coupang-1');
      const source = previous.sources.find(s => s.id === preset.id);
      if (source && source.url === preset.url && !source.adapter && !Object.values(source.selectors || {}).some(value => value?.trim())) {
        source.adapter = preset.adapter;
        source.enabled = false;
      }
      previous.presetVersion = 3;
      db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify(previous), channel.id);
    }
    if (previous.presetVersion >= 2) continue;
    const sources = previous.sources.map(source => {
      const preset = defaults.sources.find(s => s.id === source.id);
      if (!preset) return source;
      const merged = { ...preset, ...source };
      if (preset.adapter && !source.adapter) {
        if ((source.url && source.url !== preset.url) || Object.values(source.selectors || {}).some(value => value?.trim())) {
          delete merged.adapter; delete merged.expectedBrand;
        } else merged.enabled = false;
      }
      if (!source.url) { merged.url = preset.url; merged.name = preset.name; }
      if (source.url && source.url !== preset.url && !Object.hasOwn(source, 'dateRange')) delete merged.dateRange;
      return merged;
    });
    for (const source of defaults.sources) if (!sources.some(s => s.id === source.id)) sources.push({ ...source, enabled: !previous.enabled });
    db.prepare('UPDATE channels SET config=? WHERE id=?').run(JSON.stringify({ ...defaults, ...previous, sources }), channel.id);
  }
  // A process may have died after the remote side accepted a reply. Never retry blindly.
  db.prepare("UPDATE inquiries SET status='uncertain', error='전송 중 서버가 종료되었습니다. 원문에서 게시 여부를 확인하세요.', version=version+1 WHERE status='sending'").run();
  const products = mode => db.prepare('SELECT * FROM products WHERE mode=? ORDER BY name').all(mode).map(p => ({ ...p, sizes: JSON.parse(p.sizes) }));
  const channel = id => { const row = db.prepare('SELECT * FROM channels WHERE id=?').get(id); return row ? { ...row, config: JSON.parse(row.config) } : null; };
  const replyShop = id => channel(id)?.config.replyShopName || getSetting('shop');
  const channelDefinitions = () => [...CHANNELS, ...LEGACY_CHANNELS.filter(def => {
    const saved = channel(def.id);
    return saved && (saved.config.enabled || saved.config.sources.some(s => s.url) || db.prepare("SELECT 1 FROM inquiries WHERE mode='live' AND channel=? LIMIT 1").get(def.id));
  })];
  const event = (mode, inquiryId, action, detail) => db.prepare('INSERT INTO events (mode,inquiry_id,action,detail,created_at) VALUES (?,?,?,?,?)').run(mode, inquiryId, action, detail, new Date().toISOString());
  const recordRemoteStatus = (snapshot, remoteStatus) => {
    if (!/^\d{1,30}$/.test(snapshot.detail_external_id || '')) throw new AppError('완료 확인에 필요한 상세 문의번호가 없습니다.');
    if (!['답변완료', '답변대기', '미확인'].includes(remoteStatus)) throw new AppError('확인되지 않은 원문 상태입니다.');
    const now = new Date().toISOString();
    const where = "WHERE id=? AND mode='live' AND channel=? AND source=? AND detail_external_id=? AND url=? AND customer=? AND status IN ('pending','failed')";
    const identity = [snapshot.id, snapshot.channel, snapshot.source, snapshot.detail_external_id, snapshot.url, snapshot.customer];
    if (remoteStatus !== '답변완료') {
      db.prepare(`UPDATE inquiries SET remote_status_checked_at=? ${where}`).run(now, ...identity);
      return 0;
    }
    // Preserve the latest edited draft. The actual posted body/time were not
    // collected, so neither may be filled from the draft or the check time.
    const changed = db.prepare(`UPDATE inquiries SET status='sent',completion_origin='remote_status',remote_status_checked_at=?,sent_at=NULL,sent_body=NULL,error=NULL,version=version+1 ${where}`).run(now, ...identity).changes;
    if (changed) event('live', snapshot.id, 'remote_completed', '패션플러스 원문의 답변완료 상태를 확인했습니다. 게시된 답변 본문·등록 시각은 수집하지 않았습니다.');
    return changed;
  };
  const addInquiry = (mode, data) => {
    if (data.inquiry_kind === 'notification') {
      if (mode !== 'live' || data.channel !== 'fashionplus' || !/^\d{1,30}$/.test(data.external_id) || !data.order_reference || !data.body || !data.product || !data.customer) throw new AppError('CS알리미 식별 정보가 올바르지 않습니다.');
      notificationState(data.remote_status, data.remote_closed);
      const now = new Date().toISOString();
      // No customer-facing draft is generated for an operational notice.
      return db.prepare(`INSERT OR IGNORE INTO inquiries (id,mode,channel,source,external_id,customer,title,body,product,url,category,draft,created_at,collected_at,inquiry_kind,order_reference) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), mode, data.channel, data.source, data.external_id, data.customer, data.title || 'CS알리미', data.body, data.product, data.url, '기타', '', now, now, 'notification', data.order_reference).changes;
    }
    const previous = db.prepare('SELECT id,detail_external_id FROM inquiries WHERE mode=? AND channel=? AND source=? AND external_id=?').get(mode, data.channel, data.source, data.external_id);
    if (data.detail_external_id && db.prepare('SELECT 1 FROM inquiries WHERE mode=? AND channel=? AND source=? AND detail_external_id=? AND external_id<>?').get(mode, data.channel, data.source, data.detail_external_id, data.external_id)) throw new AppError('다른 목록 번호에 이미 연결된 상세 문의번호입니다. 원문을 확인하세요.');
    if (previous && data.detail_external_id) {
      if (previous.detail_external_id && previous.detail_external_id !== data.detail_external_id) throw new AppError('저장된 목록 문의와 새로 열린 상세 문의번호의 연결이 달라졌습니다. 원문을 확인하세요.');
      if (!previous.detail_external_id) db.prepare('UPDATE inquiries SET detail_external_id=?,version=version+1 WHERE id=?').run(data.detail_external_id, previous.id);
    }
    const category = classify(`${data.title} ${data.body}`);
    const draft = makeDraft({ ...data, category }, getSetting('templates'), replyShop(data.channel), products(mode));
    const now = new Date().toISOString();
    return db.prepare(`INSERT OR IGNORE INTO inquiries (id,mode,channel,source,external_id,customer,title,body,product,url,category,draft,created_at,collected_at,detail_external_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), mode, data.channel, data.source, data.external_id, data.customer || '고객', data.title || '새 문의', data.body, data.product || '', data.url || '', category, draft, data.created_at || now, now, data.detail_external_id || '').changes;
  };
  const recordNotificationStatus = (snapshot, observed) => {
    const status = notificationState(observed.remote_status, observed.remote_closed);
    const row = db.prepare("SELECT * FROM inquiries WHERE mode='live' AND channel=? AND source=? AND external_id=?").get(snapshot.channel, snapshot.source, snapshot.external_id);
    if (!row || row.inquiry_kind !== 'notification' || ['body', 'product', 'customer', 'order_reference', 'url'].some(key => row[key] !== snapshot[key])) throw new AppError('저장된 CS알리미와 원문 식별 정보가 다릅니다.');
    if (!['pending', 'failed', 'sent'].includes(row.status)) throw new AppError(NOTICE_SEND_BLOCKED);
    const now = new Date().toISOString();
    const changed = row.status !== status || row.remote_status !== observed.remote_status || row.remote_closed !== observed.remote_closed || row.response_due !== observed.response_due;
    if (!changed) { db.prepare('UPDATE inquiries SET remote_status_checked_at=? WHERE id=?').run(now, row.id); return 0; }
    db.prepare("UPDATE inquiries SET status=?,remote_status=?,remote_closed=?,response_due=?,completion_origin='remote_notice',remote_status_checked_at=?,error=NULL,version=version+1 WHERE id=?").run(status, observed.remote_status, observed.remote_closed, observed.response_due || '', now, row.id);
    event('live', row.id, 'notification_status', `CS알리미 원문 상태 확인: ${observed.remote_status} · ${observed.remote_closed}. 주문 처리나 답변 등록을 실행한 것은 아닙니다.`);
    return status === 'sent' && row.status !== 'sent' ? 1 : 0;
  };
  const recordCoupangReply = data => {
    if (data.channel !== 'coupang' || !/^\d{1,30}$/.test(data.external_id) || !['pending', 'answered'].includes(data.remote_status)) throw new AppError('쿠팡 원문 확인 결과가 올바르지 않습니다.');
    const row = db.prepare("SELECT * FROM inquiries WHERE mode='live' AND channel=? AND source=? AND external_id=?").get(data.channel, data.source, data.external_id);
    if (!row || ['body', 'product', 'customer', 'created_at'].some(key => row[key] !== data[key])) throw new AppError('저장된 쿠팡 접수번호의 문의 내용이 달라졌습니다. 원문을 확인하세요.');
    if (data.remote_status === 'pending') return 0;
    if (typeof data.remote_reply_body !== 'string' || !data.remote_reply_body.trim() || !Number.isFinite(Date.parse(data.remote_reply_at))) throw new AppError('쿠팡 게시된 답변 본문·등록 시각을 확인하지 못했습니다.');
    if (!['pending', 'failed'].includes(row.status) && !(row.status === 'sent' && row.completion_origin === 'remote_reply')) return 0;
    const now = new Date().toISOString();
    if (row.status === 'sent' && row.sent_body === data.remote_reply_body && row.sent_at === data.remote_reply_at) {
      db.prepare('UPDATE inquiries SET remote_status_checked_at=? WHERE id=?').run(now, row.id);
      return 0;
    }
    db.prepare("UPDATE inquiries SET status='sent',completion_origin='remote_reply',sent_body=?,sent_at=?,remote_status_checked_at=?,error=NULL,version=version+1 WHERE id=?").run(data.remote_reply_body, data.remote_reply_at, now, row.id);
    event('live', row.id, 'remote_reply', '쿠팡 원문의 최신 답변 본문과 등록 시각을 확인했습니다. 저장된 초안은 보존했습니다.');
    return row.status === 'sent' ? 0 : 1;
  };
  if (!getSetting('demo_seeded')) {
    db.prepare('INSERT INTO products VALUES (?,?,?,?)').run('demo-product-1', 'demo', '에센셜 오버핏 셔츠', JSON.stringify([
      { size: 'M', length: 74, shoulder: 52, chest: 59, waist: 58 },
      { size: 'L', length: 76, shoulder: 54, chest: 61, waist: 60 },
      { size: 'XL', length: 78, shoulder: 56, chest: 63, waist: 62 },
    ]));
    const examples = [
      ['smartstore', '김민지', '주문한 상품은 언제 배송되나요?', '안녕하세요. 어제 주문한 셔츠가 아직 배송 준비 중이라 문의드려요. 이번 주 금요일까지 받아볼 수 있을까요?', '에센셜 오버핏 셔츠'],
      ['kakao', '박지훈', '셔츠 사이즈 추천 부탁드려요', '키 178cm, 몸무게 72kg입니다. 여유 있게 입고 싶은데 M과 L 중 어떤 사이즈가 좋을까요?', '에센셜 오버핏 셔츠'],
      ['ably', '이서연', '반품 접수하고 싶어요', '생각했던 색상과 조금 달라서 반품하고 싶습니다. 택은 그대로 붙어 있어요. 어떻게 접수하면 될까요?', '소프트 코튼 가디건'],
      ['cafe24', '최현우', '교환 배송비 문의드립니다', '받은 바지에 작은 얼룩이 있어서 교환하고 싶은데 배송비를 제가 부담해야 하나요?', '와이드 코튼 팬츠'],
      ['naverpay', '정유진', '환불은 언제 완료되나요?', '지난주에 반품 도착했다고 안내받았어요. 카드 환불 처리 일정을 알고 싶습니다.', '데일리 니트'],
      ['talktalk', '한수빈', '첫 구매 쿠폰 사용이 안 돼요', '회원가입하고 받은 쿠폰을 사용하려는데 적용이 안 됩니다. 사용 조건이 따로 있나요?', '에센셜 오버핏 셔츠'],
      ['lookpin', '윤도현', '다른 색상도 재입고되나요?', '블랙 컬러도 다시 구매할 수 있을까요? 입고 예정일이 궁금합니다.', '와이드 코튼 팬츠'],
      ['hiver', '오지우', '세탁 방법이 궁금해요', '니트를 세탁기에 넣어도 될까요? 관리 방법을 안내 부탁드려요.', '데일리 니트'],
      ['smartstore', '임하늘', '배송지 변경 가능한가요?', '오늘 주문했는데 주소를 잘못 입력했어요. 아직 출고 전이면 주소 변경이 가능할까요?', '소프트 코튼 가디건'],
      ['kakao', '송시우', '바지 허리 실측 알려주세요', '상세페이지에서 허리 사이즈를 못 찾겠어요. L 사이즈 허리 실측을 알려주세요.', '와이드 코튼 팬츠'],
    ];
    examples.forEach(([channel, customer, title, body, product], i) => addInquiry('demo', { channel, customer, title, body, product, source: `${channel}-0`, external_id: `sample-${i}`, created_at: new Date(Date.now() - (i * 43 + 8) * 60000).toISOString() }));
    setSetting('demo_seeded', true);
  }
  if (!getSetting('demo_channel_layout_v2')) {
    for (const [oldId, newId] of [['kakao', 'smartstore_quarter'], ['talktalk', 'fashionplus']]) {
      for (const row of db.prepare("SELECT * FROM inquiries WHERE mode='demo' AND channel=?").all(oldId)) {
        const original = makeDraft(row, getSetting('templates'), getSetting('shop'), products('demo'));
        const draft = row.status === 'pending' && row.draft === original ? makeDraft(row, getSetting('templates'), replyShop(newId), products('demo')) : row.draft;
        db.prepare('UPDATE inquiries SET channel=?,source=?,draft=?,version=version+1 WHERE id=?').run(newId, `${newId}-0`, draft, row.id);
      }
    }
    setSetting('demo_channel_layout_v2', true);
  }
  return { db, getSetting, setSetting, products, event, addInquiry, recordRemoteStatus, recordCoupangReply, recordNotificationStatus, channel, channelDefinitions, replyShop,
    inquiry: id => db.prepare('SELECT * FROM inquiries WHERE id=?').get(id),
    close: () => db.close(),
  };
}
