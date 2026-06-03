import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('hyzertech.db');

export function initDb() {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS throws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      speed_mph REAL NOT NULL,
      spin_rpm REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function saveThrow(speedMph: number, spinRpm: number) {
  const now = new Date().toISOString();
  db.runSync(
    'INSERT INTO throws (speed_mph, spin_rpm, created_at) VALUES (?, ?, ?)',
    speedMph,
    spinRpm,
    now
  );
}

export function getThrows(): ThrowRecord[] {
  return db.getAllSync<ThrowRecord>(
    'SELECT * FROM throws ORDER BY created_at DESC'
  );
}

export function deleteThrow(id: number) {
  db.runSync('DELETE FROM throws WHERE id = ?', id);
}

export function clearAllThrows() {
  db.runSync('DELETE FROM throws');
}

export interface ThrowRecord {
  id: number;
  speed_mph: number;
  spin_rpm: number;
  created_at: string;
}
