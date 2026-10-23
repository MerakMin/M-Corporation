import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS, defaultChannelConfig } from './channel-presets.js';

// Login only needs configuration. Opening the application store would also run
// startup recovery and could change an active reply from sending to uncertain.
export function readLoginChannel(dataDir, id) {
  if (!CHANNELS.some(channel => channel.id === id)) throw new Error('알 수 없는 채널입니다.');
  const path = join(dataDir, 'desk.sqlite');
  if (!existsSync(path)) return { id, config: defaultChannelConfig(id) };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT config FROM channels WHERE id=?').get(id);
    return { id, config: row ? JSON.parse(row.config) : defaultChannelConfig(id) };
  } finally { db.close(); }
}

export function readLoginSource(dataDir, channelId, sourceId) {
  const { config } = readLoginChannel(dataDir, channelId);
  const saved = config.sources.find(source => source.id === sourceId);
  if (saved) return saved;
  // A login/diagnostic run must not migrate SQLite just to use a new preset.
  const defaults = defaultChannelConfig(channelId);
  if ((config.presetVersion || 0) < defaults.presetVersion) return defaults.sources.find(source => source.id === sourceId);
  return undefined;
}
