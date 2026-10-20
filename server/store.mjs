import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function createStore(directory) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'console.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const saved = db.prepare('SELECT value FROM state WHERE id = 1').get();
  const state = saved ? JSON.parse(saved.value) : { wallets: [], drafts: [], monitors: [], alerts: [], launches: [] };
  state.queue ??= [];
  state.vault ??= { initialized: false, salt: null, verifier: null, wallets: [] };
  state.autoLauncher ??= { enabled: false, intervalMinutes: 5, defaultWalletId: '', status: 'idle', nextRunAt: null, lastRunAt: null, lastError: null, lastSuccess: null };
  state.settings ??= { pointValueMode: 'auto', customPointValueUsd: 0.02622, rewardVaultUsd: 1141245.2 };
  const statement = db.prepare('INSERT INTO state (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value = excluded.value');
  const save = () => statement.run(JSON.stringify(state));
  // Gaps in observation do not count toward a sustained trigger.
  for (const m of state.monitors) m.conditionSince = null;
  save();
  return { state, save, close: () => db.close() };
}
