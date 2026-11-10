
export function getCollectionHistory(db, limit = 50) {
  const rows = db.prepare(`
    SELECT
      id,
      action,
      detail,
      created_at
    FROM events
    WHERE mode = 'live'
      AND action IN ('sync', 'sync_failed')
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);

  return rows.map((row) => ({
    id: row.id,
    status: row.action === 'sync' ? 'success' : 'failed',
    detail: row.detail,
    collectedAt: row.created_at,
  }));
}
