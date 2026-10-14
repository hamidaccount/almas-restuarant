const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'almas.db');
const db = new Database(dbPath);

// Prevent corruption on power loss
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'غذا',
  price REAL NOT NULL DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_number INTEGER NOT NULL,
  room_number TEXT NOT NULL UNIQUE,
  daily_rate REAL NOT NULL DEFAULT 500,
  status TEXT DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_name TEXT NOT NULL,
  father_name TEXT,
  province TEXT,
  address TEXT,
  tazkira_number TEXT,
  phone TEXT,
  photo_base64 TEXT,
  stay_type TEXT DEFAULT 'مردها',
  guest_count INTEGER DEFAULT 1,
  room_id INTEGER NOT NULL,
  floor_number INTEGER,
  room_number TEXT,
  daily_rate REAL NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT,
  days_count INTEGER DEFAULT 1,
  paid_amount REAL DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NULL,
  items_json TEXT NOT NULL,
  total_amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS stay_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS finances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity TEXT,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT,
  monthly_salary REAL NOT NULL DEFAULT 10000,
  includes_food INTEGER DEFAULT 1,
  period_start_date TEXT NOT NULL,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS salary_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL,
  notes TEXT,
  is_settled INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  unit TEXT DEFAULT 'عدد',
  quantity REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`);

// ---- Seed settings ----
(function seedSettings() {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  set.run('admin_pin', '1234');
  set.run('install_date', todayISODate());
  set.run('license_active', '0');
  if (!get.get('admin_pin')) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_pin','1234')").run();
  if (!get.get('install_date')) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('install_date', todayISODate());
  if (!get.get('license_active')) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('license_active','0')").run();
})();

// ---- Seed menu_items (12 items) ----
(function seedMenu() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c;
  if (count === 0) {
    const items = [
      ['مایچه', 'غذا', 350],
      ['مولانگ', 'غذا', 300],
      ['قابلی', 'غذا', 200],
      ['روش', 'غذا', 400],
      ['چینکی', 'غذا', 250],
      ['کباب', 'غذا', 180],
      ['کباب مرغ', 'غذا', 150],
      ['کرایی مرغ', 'غذا', 500],
      ['لوبیا', 'غذا', 80],
      ['سبزی', 'غذا', 70],
      ['چای', 'نوشیدنی', 30],
      ['نوشابه', 'نوشیدنی', 40],
    ];
    const ins = db.prepare('INSERT INTO menu_items (name, category, price, is_active) VALUES (?, ?, ?, 1)');
    const txn = db.transaction((rows) => {
      for (const r of rows) ins.run(r[0], r[1], r[2]);
    });
    txn(items);
    console.log('Seeded menu_items with 12 items');
  }
})();

// ---- Seed rooms: 9 floors x 3 rooms ----
(function seedRooms() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  if (count === 0) {
    const pricePool = [200, 300, 500, 600, 700, 800, 1000];
    const ins = db.prepare('INSERT INTO rooms (floor_number, room_number, daily_rate, status) VALUES (?, ?, ?, ?)');
    const txn = db.transaction(() => {
      let k = 0;
      for (let floor = 1; floor <= 9; floor++) {
        for (let j = 1; j <= 3; j++) {
          const room_number = String(floor) + '0' + String(j);
          const price = pricePool[k % pricePool.length];
          k++;
          ins.run(floor, room_number, price, 'free');
        }
      }
    });
    txn();
    console.log('Seeded rooms: 27 rooms (9 floors x 3)');
  }
})();

module.exports = db;
