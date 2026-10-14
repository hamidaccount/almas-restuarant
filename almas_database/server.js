const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use(express.static(path.join(__dirname, 'public')));

function nowISO() {
  return new Date().toISOString();
}
function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function calcDays(checkIn, checkOut) {
  try {
    const inDate = new Date(checkIn);
    const outDate = checkOut ? new Date(checkOut) : new Date();
    const diffMs = outDate - inDate;
    if (isNaN(diffMs) || diffMs <= 0) return 1;
    return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  } catch (e) {
    return 1;
  }
}

function dateFilter(column, from, to) {
  const conds = [];
  const params = [];
  if (from) {
    conds.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    let toVal = to;
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      toVal = to + 'T23:59:59.999Z';
    }
    conds.push(`${column} <= ?`);
    params.push(toVal);
  }
  const where = conds.length ? ' AND ' + conds.join(' AND ') : '';
  return { where, params };
}

// ================= 1. MENU /api/menu =================
app.get('/api/menu', (req, res) => {
  try {
    const { active } = req.query;
    let rows;
    if (active === '1' || active === '0') {
      rows = db.prepare('SELECT * FROM menu_items WHERE is_active = ? ORDER BY id').all(Number(active));
    } else {
      rows = db.prepare('SELECT * FROM menu_items ORDER BY id').all();
    }
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/menu', (req, res) => {
  try {
    const { name, category, price, is_active } = req.body;
    if (!name || price === undefined || price === null) {
      return res.status(400).json({ ok: false, error: 'name and price are required' });
    }
    const info = db
      .prepare('INSERT INTO menu_items (name, category, price, is_active) VALUES (?, ?, ?, ?)')
      .run(name, category || 'غذا', Number(price), is_active === undefined ? 1 : Number(is_active) ? 1 : 0);
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/menu/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'menu item not found' });
    const { name, category, price, is_active } = req.body;
    const newName = name !== undefined ? name : existing.name;
    const newCat = category !== undefined ? category : existing.category;
    const newPrice = price !== undefined ? Number(price) : existing.price;
    const newActive = is_active !== undefined ? (Number(is_active) ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE menu_items SET name = ?, category = ?, price = ?, is_active = ? WHERE id = ?')
      .run(newName, newCat, newPrice, newActive, id);
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/menu/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const info = db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'menu item not found' });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 2. ORDERS /api/orders =================
app.get('/api/orders', (req, res) => {
  try {
    const { from, to, stay_id, status } = req.query;
    let sql = 'SELECT * FROM orders WHERE 1=1';
    const params = [];
    if (stay_id !== undefined && stay_id !== '') {
      sql += ' AND stay_id = ?';
      params.push(Number(stay_id));
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    const { where, params: dp } = dateFilter('created_at', from, to);
    sql += where;
    params.push(...dp);
    sql += ' ORDER BY id DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'order not found' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/orders', (req, res) => {
  try {
    const { stay_id, items_json, items, total_amount, created_at, status, notes } = req.body;
    let itemsArr = null;
    if (items_json !== undefined) {
      if (typeof items_json === 'string') {
        try {
          itemsArr = JSON.parse(items_json);
        } catch (e) {
          return res.status(400).json({ ok: false, error: 'items_json is not valid JSON' });
        }
      } else if (Array.isArray(items_json)) {
        itemsArr = items_json;
      }
    } else if (Array.isArray(items)) {
      itemsArr = items;
    }
    if (!itemsArr || !Array.isArray(itemsArr) || itemsArr.length === 0) {
      return res.status(400).json({ ok: false, error: 'items array is required (items or items_json)' });
    }
    let total = total_amount;
    if (total === undefined || total === null || total === '') {
      total = itemsArr.reduce((s, it) => {
        const q = Number(it.qty ?? it.quantity ?? it.count ?? 1);
        const p = Number(it.price ?? it.unit_price ?? 0);
        return s + q * p;
      }, 0);
    }
    total = Number(total);
    let stayIdVal = null;
    if (stay_id !== undefined && stay_id !== null && stay_id !== '') {
      stayIdVal = Number(stay_id);
      const stay = db.prepare('SELECT id FROM stays WHERE id = ?').get(stayIdVal);
      if (!stay) return res.status(400).json({ ok: false, error: 'stay_id not found' });
    }
    const createdAt = created_at || nowISO();
    const info = db
      .prepare('INSERT INTO orders (stay_id, items_json, total_amount, created_at, status, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(stayIdVal, JSON.stringify(itemsArr), total, createdAt, status || 'completed', notes || null);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/orders/:id/cancel', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'order not found' });
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 3. ROOMS & STAYS =================
app.get('/api/rooms', (req, res) => {
  try {
    const { floor, status } = req.query;
    let sql = 'SELECT * FROM rooms WHERE 1=1';
    const params = [];
    if (floor) {
      sql += ' AND floor_number = ?';
      params.push(Number(floor));
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY floor_number, room_number';
    const rooms = db.prepare(sql).all(...params);
    const by_floor = {};
    for (let f = 1; f <= 9; f++) by_floor[String(f)] = [];
    for (const r of rooms) {
      const k = String(r.floor_number);
      if (!by_floor[k]) by_floor[k] = [];
      by_floor[k].push(r);
    }
    res.json({ ok: true, data: rooms, by_floor });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/rooms', (req, res) => {
  try {
    const { floor_number, room_number, daily_rate, status } = req.body;
    if (!floor_number || !room_number) {
      return res.status(400).json({ ok: false, error: 'floor_number and room_number are required' });
    }
    const info = db
      .prepare('INSERT INTO rooms (floor_number, room_number, daily_rate, status) VALUES (?, ?, ?, ?)')
      .run(Number(floor_number), String(room_number), daily_rate !== undefined ? Number(daily_rate) : 500, status || 'free');
    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ ok: false, error: 'room_number must be unique' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/rooms/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'room not found' });
    const { floor_number, room_number, daily_rate, status } = req.body;
    db.prepare('UPDATE rooms SET floor_number = ?, room_number = ?, daily_rate = ?, status = ? WHERE id = ?').run(
      floor_number !== undefined ? Number(floor_number) : existing.floor_number,
      room_number !== undefined ? String(room_number) : existing.room_number,
      daily_rate !== undefined ? Number(daily_rate) : existing.daily_rate,
      status !== undefined ? status : existing.status,
      id
    );
    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    res.json({ ok: true, data: row });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ ok: false, error: 'room_number must be unique' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Stays ----
app.get('/api/stays', (req, res) => {
  try {
    const { status, room_id } = req.query;
    let sql = 'SELECT * FROM stays WHERE 1=1';
    const params = [];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (room_id) {
      sql += ' AND room_id = ?';
      params.push(Number(room_id));
    }
    sql += ' ORDER BY id DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stays/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM stays WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'stay not found' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/stays', (req, res) => {
  try {
    const {
      guest_name, father_name, province, address, tazkira_number, phone,
      photo_base64, stay_type, guest_count, room_id, daily_rate,
      check_in, paid_amount, notes,
    } = req.body;
    if (!guest_name) return res.status(400).json({ ok: false, error: 'guest_name is required' });
    if (!room_id) return res.status(400).json({ ok: false, error: 'room_id is required' });
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(room_id));
    if (!room) return res.status(404).json({ ok: false, error: 'room not found' });
    if (room.status === 'occupied') return res.status(400).json({ ok: false, error: 'room is already occupied' });
    const rate = daily_rate !== undefined && daily_rate !== null && daily_rate !== '' ? Number(daily_rate) : Number(room.daily_rate);
    const checkIn = check_in || nowISO();
    const paid = paid_amount !== undefined && paid_amount !== null && paid_amount !== '' ? Number(paid_amount) : 0;
    const insertStay = db.prepare(`
      INSERT INTO stays (guest_name, father_name, province, address, tazkira_number, phone, photo_base64,
        stay_type, guest_count, room_id, floor_number, room_number, daily_rate, check_in, days_count, paid_amount, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active')
    `);
    const txn = db.transaction(() => {
      const info = insertStay.run(
        guest_name, father_name || null, province || null, address || null,
        tazkira_number || null, phone || null, photo_base64 || null,
        stay_type || 'مردها', guest_count !== undefined ? Number(guest_count) : 1,
        Number(room_id), room.floor_number, room.room_number, rate, checkIn, paid, notes || null
      );
      const stayId = info.lastInsertRowid;
      db.prepare("UPDATE rooms SET status = 'occupied' WHERE id = ?").run(Number(room_id));
      if (paid > 0) {
        db.prepare('INSERT INTO stay_payments (stay_id, amount, payment_date, notes) VALUES (?, ?, ?, ?)')
          .run(stayId, paid, checkIn, 'پیش‌پرداخت اولیه');
      }
      return stayId;
    });
    const stayId = txn();
    const row = db.prepare('SELECT * FROM stays WHERE id = ?').get(stayId);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/stays/:id/account', (req, res) => {
  try {
    const id = Number(req.params.id);
    const stay = db.prepare('SELECT * FROM stays WHERE id = ?').get(id);
    if (!stay) return res.status(404).json({ ok: false, error: 'stay not found' });
    const days = calcDays(stay.check_in, stay.check_out);
    const room_total = days * Number(stay.daily_rate);
    const orders = db.prepare("SELECT * FROM orders WHERE stay_id = ? AND status = 'completed' ORDER BY id").all(id);
    const food_total = orders.reduce((s, o) => s + Number(o.total_amount), 0);
    const payments = db.prepare('SELECT * FROM stay_payments WHERE stay_id = ? ORDER BY id').all(id);
    const paid_amount = payments.reduce((s, p) => s + Number(p.amount), 0);
    const grand_total = room_total + food_total;
    const remaining_amount = grand_total - paid_amount;
    db.prepare('UPDATE stays SET days_count = ?, paid_amount = ? WHERE id = ?').run(days, paid_amount, id);
    const updatedStay = db.prepare('SELECT * FROM stays WHERE id = ?').get(id);
    res.json({
      ok: true,
      data: {
        stay: updatedStay, days_count: days, daily_rate: Number(stay.daily_rate),
        room_total, food_total, grand_total, paid_amount, remaining_amount, orders, payments,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/stays/:id/pay', (req, res) => {
  try {
    const id = Number(req.params.id);
    const stay = db.prepare('SELECT * FROM stays WHERE id = ?').get(id);
    if (!stay) return res.status(404).json({ ok: false, error: 'stay not found' });
    const { amount, payment_date, notes } = req.body;
    if (amount === undefined || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'valid amount is required' });
    }
    const pdate = payment_date || nowISO();
    const info = db
      .prepare('INSERT INTO stay_payments (stay_id, amount, payment_date, notes) VALUES (?, ?, ?, ?)')
      .run(id, Number(amount), pdate, notes || null);
    const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM stay_payments WHERE stay_id = ?').get(id).s;
    db.prepare('UPDATE stays SET paid_amount = ? WHERE id = ?').run(Number(totalPaid), id);
    const row = db.prepare('SELECT * FROM stay_payments WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row, total_paid: Number(totalPaid) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/stays/:id/checkout', (req, res) => {
  try {
    const id = Number(req.params.id);
    const stay = db.prepare('SELECT * FROM stays WHERE id = ?').get(id);
    if (!stay) return res.status(404).json({ ok: false, error: 'stay not found' });
    if (stay.status === 'checked_out') return res.status(400).json({ ok: false, error: 'already checked out' });
    const { check_out, final_payment } = req.body || {};
    const checkOut = check_out || nowISO();
    const days = calcDays(stay.check_in, checkOut);
    const txn = db.transaction(() => {
      if (final_payment !== undefined && Number(final_payment) > 0) {
        db.prepare('INSERT INTO stay_payments (stay_id, amount, payment_date, notes) VALUES (?, ?, ?, ?)')
          .run(id, Number(final_payment), checkOut, 'تصفیه نهایی هنگام خروج');
      }
      const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM stay_payments WHERE stay_id = ?').get(id).s;
      db.prepare("UPDATE stays SET check_out = ?, days_count = ?, paid_amount = ?, status = 'checked_out' WHERE id = ?")
        .run(checkOut, days, Number(totalPaid), id);
      db.prepare("UPDATE rooms SET status = 'free' WHERE id = ?").run(stay.room_id);
      return Number(totalPaid);
    });
    const totalPaid = txn();
    const row = db.prepare('SELECT * FROM stays WHERE id = ?').get(id);
    res.json({ ok: true, data: row, total_paid: totalPaid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 4. FINANCES /api/finances =================
const FINANCE_TYPES = ['raw_purchase', 'misc_expense', 'parallel_transfer', 'other_branch_collection'];

app.get('/api/finances', (req, res) => {
  try {
    const { type, from, to } = req.query;
    let sql = 'SELECT * FROM finances WHERE 1=1';
    const params = [];
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    const { where, params: dp } = dateFilter('created_at', from, to);
    sql += where;
    params.push(...dp);
    sql += ' ORDER BY id DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/finances', (req, res) => {
  try {
    const { type, title, quantity, amount, created_at, notes } = req.body;
    if (!type || !FINANCE_TYPES.includes(type)) {
      return res.status(400).json({ ok: false, error: 'valid type is required: ' + FINANCE_TYPES.join(', ') });
    }
    if (!title) return res.status(400).json({ ok: false, error: 'title is required' });
    if (amount === undefined || amount === null || amount === '') {
      return res.status(400).json({ ok: false, error: 'amount is required' });
    }
    const info = db
      .prepare('INSERT INTO finances (type, title, quantity, amount, created_at, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(type, title, quantity || null, Number(amount), created_at || nowISO(), notes || null);
    const row = db.prepare('SELECT * FROM finances WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/finances/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM finances WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'finance record not found' });
    res.json({ ok: true, deleted: Number(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 5. EMPLOYEES & SALARIES =================
function employeeWithCalc(emp) {
  const advances = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM salary_records WHERE employee_id = ? AND is_settled = 0 AND record_type = 'advance'")
    .get(emp.id).s;
  const food = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM salary_records WHERE employee_id = ? AND is_settled = 0 AND record_type = 'food_deduction'")
    .get(emp.id).s;
  const total_advances = Number(advances);
  const total_food_deductions = Number(food);
  const period_salary_1m = Number(emp.monthly_salary);
  const period_salary_3m = Number(emp.monthly_salary) * 3;
  const remaining_1m = period_salary_1m - total_advances - total_food_deductions;
  const remaining_3m = period_salary_3m - total_advances - total_food_deductions;
  return { ...emp, period_salary_1m, period_salary_3m, total_advances, total_food_deductions, remaining_1m, remaining_3m };
}

app.get('/api/employees', (req, res) => {
  try {
    const { active } = req.query;
    let rows;
    if (active === '1' || active === '0') {
      rows = db.prepare('SELECT * FROM employees WHERE is_active = ? ORDER BY id').all(Number(active));
    } else {
      rows = db.prepare('SELECT * FROM employees ORDER BY id').all();
    }
    res.json({ ok: true, data: rows.map(employeeWithCalc) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/employees/:id', (req, res) => {
  try {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ ok: false, error: 'employee not found' });
    const records = db.prepare('SELECT * FROM salary_records WHERE employee_id = ? ORDER BY id DESC').all(emp.id);
    res.json({ ok: true, data: employeeWithCalc(emp), records });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { name, role, monthly_salary, includes_food, period_start_date, is_active } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const info = db
      .prepare('INSERT INTO employees (name, role, monthly_salary, includes_food, period_start_date, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        name, role || null,
        monthly_salary !== undefined ? Number(monthly_salary) : 10000,
        includes_food === undefined ? 1 : Number(includes_food) ? 1 : 0,
        period_start_date || todayISODate(),
        is_active === undefined ? 1 : Number(is_active) ? 1 : 0
      );
    const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: employeeWithCalc(row) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/employees/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'employee not found' });
    const { name, role, monthly_salary, includes_food, period_start_date, is_active } = req.body;
    db.prepare('UPDATE employees SET name=?, role=?, monthly_salary=?, includes_food=?, period_start_date=?, is_active=? WHERE id=?').run(
      name !== undefined ? name : existing.name,
      role !== undefined ? role : existing.role,
      monthly_salary !== undefined ? Number(monthly_salary) : existing.monthly_salary,
      includes_food !== undefined ? (Number(includes_food) ? 1 : 0) : existing.includes_food,
      period_start_date !== undefined ? period_start_date : existing.period_start_date,
      is_active !== undefined ? (Number(is_active) ? 1 : 0) : existing.is_active,
      id
    );
    const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    res.json({ ok: true, data: employeeWithCalc(row) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/salaries', (req, res) => {
  try {
    const { employee_id, from, to, unsettled } = req.query;
    let sql = 'SELECT * FROM salary_records WHERE 1=1';
    const params = [];
    if (employee_id) {
      sql += ' AND employee_id = ?';
      params.push(Number(employee_id));
    }
    if (unsettled === '1') {
      sql += ' AND is_settled = 0';
    }
    const { where, params: dp } = dateFilter('created_at', from, to);
    sql += where;
    params.push(...dp);
    sql += ' ORDER BY id DESC';
    const rows = db.prepare(sql).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/salaries/advance', (req, res) => {
  try {
    const { employee_id, amount, created_at, notes, record_type } = req.body;
    if (!employee_id) return res.status(400).json({ ok: false, error: 'employee_id is required' });
    if (amount === undefined || Number(amount) <= 0) return res.status(400).json({ ok: false, error: 'valid amount is required' });
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(employee_id));
    if (!emp) return res.status(404).json({ ok: false, error: 'employee not found' });
    const info = db
      .prepare('INSERT INTO salary_records (employee_id, record_type, amount, created_at, notes, is_settled) VALUES (?, ?, ?, ?, ?, 0)')
      .run(Number(employee_id), record_type || 'advance', Number(amount), created_at || nowISO(), notes || null);
    const row = db.prepare('SELECT * FROM salary_records WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/salaries/:employee_id/settle', (req, res) => {
  try {
    const employee_id = Number(req.params.employee_id);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
    if (!emp) return res.status(404).json({ ok: false, error: 'employee not found' });
    const { amount, created_at, notes } = req.body || {};
    const unsettledAdv = db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM salary_records WHERE employee_id = ? AND is_settled = 0 AND record_type = 'advance'")
      .get(employee_id).s;
    const unsettledFood = db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM salary_records WHERE employee_id = ? AND is_settled = 0 AND record_type = 'food_deduction'")
      .get(employee_id).s;
    const settleAmount =
      amount !== undefined && amount !== null && amount !== ''
        ? Number(amount)
        : Number(emp.monthly_salary) - Number(unsettledAdv) - Number(unsettledFood);
    const txn = db.transaction(() => {
      const info = db
        .prepare("INSERT INTO salary_records (employee_id, record_type, amount, created_at, notes, is_settled) VALUES (?, 'settlement', ?, ?, ?, 1)")
        .run(employee_id, settleAmount, created_at || nowISO(), notes || 'تصفیه نهایی و بستن دوره');
      db.prepare('UPDATE salary_records SET is_settled = 1 WHERE employee_id = ? AND is_settled = 0 AND id != ?')
        .run(employee_id, info.lastInsertRowid);
      db.prepare('UPDATE employees SET period_start_date = ? WHERE id = ?').run(todayISODate(), employee_id);
      return info.lastInsertRowid;
    });
    const sid = txn();
    const row = db.prepare('SELECT * FROM salary_records WHERE id = ?').get(sid);
    const updatedEmp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
    res.json({ ok: true, data: row, employee: employeeWithCalc(updatedEmp) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 6. INVENTORY /api/inventory =================
app.get('/api/inventory', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM inventory ORDER BY id').all();
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/inventory', (req, res) => {
  try {
    const { item_name, unit, quantity } = req.body;
    if (!item_name) return res.status(400).json({ ok: false, error: 'item_name is required' });
    const info = db
      .prepare('INSERT INTO inventory (item_name, unit, quantity, updated_at) VALUES (?, ?, ?, ?)')
      .run(item_name, unit || 'عدد', quantity !== undefined ? Number(quantity) : 0, nowISO());
    const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/inventory/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'item not found' });
    const { item_name, unit, quantity } = req.body;
    db.prepare('UPDATE inventory SET item_name=?, unit=?, quantity=?, updated_at=? WHERE id=?').run(
      item_name !== undefined ? item_name : existing.item_name,
      unit !== undefined ? unit : existing.unit,
      quantity !== undefined ? Number(quantity) : existing.quantity,
      nowISO(), id
    );
    const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/inventory/:id/adjust', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'item not found' });
    const { delta, change, quantity } = req.body || {};
    const d = delta !== undefined ? Number(delta) : change !== undefined ? Number(change) : quantity !== undefined ? Number(quantity) : NaN;
    if (isNaN(d)) return res.status(400).json({ ok: false, error: 'delta (number, + or -) is required' });
    const newQty = Number(existing.quantity) + d;
    db.prepare('UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?').run(newQty, nowISO(), id);
    const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/inventory/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM inventory WHERE id = ?').run(Number(req.params.id));
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'item not found' });
    res.json({ ok: true, deleted: Number(req.params.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 7. REPORTS /api/reports/summary =================
app.get('/api/reports/summary', (req, res) => {
  try {
    const { from, to } = req.query;
    const of = dateFilter('created_at', from, to);
    const pf = dateFilter('payment_date', from, to);
    const cf = dateFilter('created_at', from, to);
    const sf = dateFilter('created_at', from, to);
    const orders_revenue =
      db.prepare(`SELECT COALESCE(SUM(total_amount),0) AS s FROM orders WHERE status='completed'${of.where}`).get(...of.params).s;
    const guesthouse_revenue =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM stay_payments WHERE 1=1${pf.where}`).get(...pf.params).s;
    const total_gross_revenue = Number(orders_revenue) + Number(guesthouse_revenue);
    const raw_purchases =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finances WHERE type='raw_purchase'${cf.where}`).get(...cf.params).s;
    const misc_expenses =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finances WHERE type='misc_expense'${cf.where}`).get(...cf.params).s;
    const parallel_transfers =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finances WHERE type='parallel_transfer'${cf.where}`).get(...cf.params).s;
    const other_branch_total =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finances WHERE type='other_branch_collection'${cf.where}`).get(...cf.params).s;
    const salary_payments =
      db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM salary_records WHERE record_type IN ('advance','settlement')${sf.where}`).get(...sf.params).s;
    const net_balance =
      total_gross_revenue - Number(raw_purchases) - Number(misc_expenses) - Number(parallel_transfers) - Number(salary_payments);
    res.json({
      ok: true,
      data: {
        from: from || null, to: to || null,
        orders_revenue: Number(orders_revenue),
        guesthouse_revenue: Number(guesthouse_revenue),
        total_gross_revenue,
        raw_purchases: Number(raw_purchases),
        misc_expenses: Number(misc_expenses),
        parallel_transfers: Number(parallel_transfers),
        salary_payments: Number(salary_payments),
        net_balance,
        other_branch_total: Number(other_branch_total),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================= 8. BACKUP /api/backup =================
app.get('/api/backup', (req, res) => {
  try {
    const dbFile = path.join(__dirname, 'data', 'almas.db');
    if (!fs.existsSync(dbFile)) return res.status(404).json({ ok: false, error: 'database file not found' });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) { /* ignore */ }
    const fname = `almas-backup-${todayISODate()}.db`;
    res.download(dbFile, fname);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Settings helper ----
app.get('/api/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all();
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    res.json({ ok: true, data: obj });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ ok: true, data: { key, value: String(value) } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Almas backend running', time: nowISO() });
});

app.listen(PORT, () => {
  console.log(`Almas backend listening on http://localhost:${PORT}`);
  console.log(`Database: ${path.join(__dirname, 'data', 'almas.db')}`);
});

module.exports = app;
