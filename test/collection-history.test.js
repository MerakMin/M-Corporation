
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  getCollectionHistory,
} from '../src/collectors/collection-history.js';

test('실제 운영 수집 기록만 최신순으로 조회한다', () => {
  const db = new DatabaseSync(':memory:');

  try {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const insert = db.prepare(`
      INSERT INTO events (mode, action, detail, created_at)
      VALUES (?, ?, ?, ?)
    `);

    insert.run('live', 'sync', '패션플러스: 2건 추가', '2026-11-10T10:00:00');
    insert.run('demo', 'sync', '예시 데이터', '2026-11-10T10:01:00');
    insert.run('live', 'sync_failed', '쿠팡: 로그인 오류', '2026-11-10T10:02:00');

    const history = getCollectionHistory(db);

    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'failed');
    assert.equal(history[1].status, 'success');
    assert.equal(history[0].detail, '쿠팡: 로그인 오류');
  } finally {
    db.close();
  }
});
