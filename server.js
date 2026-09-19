'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============ IN-MEMORY DATABASE ============ */
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASS = process.env.ADMIN_PASS || 'gans777admin';

let state = {
  users: {},         // phone -> user
  tokens: {},        // token -> phone
  adminTokens: {},   // token -> true
  pendingDeposits: [],   // {id, phone, name, amount, method, code, status, time}
  pendingWithdraws: [],  // {id, phone, name, amount, dest, owner, status, time}
  history: [],       // semua transaksi global untuk admin log
  lastBackup: 0
};

/* Load backup */
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state.users = parsed.users || {};
    state.pendingDeposits = parsed.pendingDeposits || [];
    state.pendingWithdraws = parsed.pendingWithdraws || [];
    state.history = parsed.history || [];
  }
} catch (e) { console.warn('Gagal load data:', e.message); }

/* Auto backup tiap 15 detik */
setInterval(() => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: state.users,
      pendingDeposits: state.pendingDeposits,
      pendingWithdraws: state.pendingWithdraws,
      history: state.history
    }, null, 2));
    state.lastBackup = Date.now();
  } catch (e) { console.warn('Backup gagal:', e.message); }
}, 15000);

/* ============ HELPERS ============ */
const fmt = n => Math.floor(Number(n) || 0);
const now = () => Date.now();
const uid = () => crypto.randomBytes(8).toString('hex');
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const VIP_LEVELS = [
  { lv: 0, min: 0 }, { lv: 1, min: 20000 }, { lv: 2, min: 50000 },
  { lv: 3, min: 80000 }, { lv: 4, min: 110000 }, { lv: 5, min: 150000 },
  { lv: 6, min: 200000 }, { lv: 7, min: 250000 }, { lv: 8, min: 300000 }
];
function calcVip(total) {
  let v = 0;
  for (const l of VIP_LEVELS) if (total >= l.min) v = l.lv;
  return v;
}

function sanitizeUser(u) {
  if (!u) return null;
  return {
    phone: u.phone, name: u.name, avatar: u.avatar,
    saldo: u.saldo, bonus: u.bonus, saving: u.saving,
    cashDeposit: u.cashDeposit, bonusDeposit: u.bonusDeposit,
    coinBalance: u.coinBalance,
    vip: calcVip(u.totalDeposit),
    totalDeposit: u.totalDeposit, totalWithdraw: u.totalWithdraw,
    turnover: u.turnover, totalWin: u.totalWin,
    turnoverSinceDep: u.turnoverSinceDep, toRequired: u.toRequired,
    withdrawCount: u.withdrawCount, withdrawToday: u.withdrawToday,
    dailyDay: u.dailyDay, lastDaily: u.lastDaily,
    streakDay: u.streakDay, streakLastDate: u.streakLastDate,
    spinDate: u.spinDate, spinUsed: u.spinUsed, spinRetryUsed: u.spinRetryUsed,
    notifs: (u.notifs || []).slice(0, 30),
    depositHistory: (u.depositHistory || []).slice(0, 30),
    withdrawHistory: (u.withdrawHistory || []).slice(0, 30),
    gameHistory: (u.gameHistory || []).slice(0, 30),
    bonusHistory: (u.bonusHistory || []).slice(0, 30),
    bonusDepHistory: (u.bonusDepHistory || []).slice(0, 30),
    coinHistory: (u.coinHistory || []).slice(0, 30),
    savingHistory: (u.savingHistory || []).slice(0, 30),
    cashHistory: (u.cashHistory || []).slice(0, 30),
    redeemHistory: (u.redeemHistory || []).slice(0, 30),
    usedCodes: u.usedCodes || [],
    eventStorToday: u.eventStorToday || 0,
    eventDate: u.eventDate,
    created: u.created
  };
}

function newUser(phone, name, pass) {
  return {
    phone, name, pass, avatar: '',
    saldo: 2000, bonus: 0, saving: 0, savingLastTick: now(),
    cashDeposit: 0, bonusDeposit: 0, coinBalance: 0, eventStorToday: 0,
    vip: 0, totalDeposit: 0, totalWithdraw: 0, turnover: 0, totalWin: 0,
    depositHistory: [], withdrawHistory: [], gameHistory: [], bonusHistory: [],
    bonusDepHistory: [], coinHistory: [], savingHistory: [], cashHistory: [],
    redeemHistory: [], notifs: [], usedCodes: [],
    lastDaily: '', dailyDay: 0, nameChangedAt: 0,
    withdrawToday: '', withdrawCount: 0,
    streakDay: 0, streakLastDate: '',
    spinDate: '', spinUsed: 0, spinRetryUsed: 0,
    eventDate: '', created: now(),
    toRequired: 0, turnoverSinceDep: 0,
    blocked: false
  };
}

function pushNotif(u, title, text) {
  if (!u.notifs) u.notifs = [];
  u.notifs.unshift({ id: uid(), title, text, time: now(), read: false });
  if (u.notifs.length > 50) u.notifs.length = 50;
}

function authUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const phone = state.tokens[token];
  if (!phone) return null;
  return state.users[phone];
}

function authAdmin(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return !!state.adminTokens[token];
}

/* ============ VALIDATION ============ */
function vPhone(p) { return /^08\d{8,13}$/.test(p); }
function vName(n) { return /^[a-zA-Z\s]{5,}$/.test((n || '').trim()); }
function vPass(p) { return /[a-zA-Z]/.test(p) && /[0-9]/.test(p) && p.includes('#'); }

/* ============ USER ENDPOINTS ============ */
app.post('/api/register', (req, res) => {
  const { phone, name, pass } = req.body || {};
  if (!vPhone(phone)) return res.json({ ok: false, err: 'Nomor tidak valid (08, 10-15 angka)' });
  if (state.users[phone]) return res.json({ ok: false, err: 'Nomor sudah terdaftar' });
  if (!vName(name)) return res.json({ ok: false, err: 'Nama minimal 5 huruf' });
  if (!vPass(pass)) return res.json({ ok: false, err: 'Kata sandi wajib huruf, angka, dan #' });

  state.users[phone] = newUser(phone, name, pass);
  const token = uid();
  state.tokens[token] = phone;
  pushNotif(state.users[phone], '✦ Selamat Datang', 'Akun Anda dibuat. Bonus Rp 2.000 masuk.');
  res.json({ ok: true, token, user: sanitizeUser(state.users[phone]) });
});

app.post('/api/login', (req, res) => {
  const { phone, pass } = req.body || {};
  const u = state.users[phone];
  if (!u) return res.json({ ok: false, err: 'Nomor belum terdaftar' });
  if (u.blocked) return res.json({ ok: false, err: 'Akun diblokir' });
  if (u.pass !== pass) return res.json({ ok: false, err: 'Kata sandi salah' });
  const token = uid();
  state.tokens[token] = phone;
  res.json({ ok: true, token, user: sanitizeUser(u) });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  delete state.tokens[token];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false, err: 'Unauthorized' });
  res.json({ ok: true, user: sanitizeUser(u) });
});

/* Ganti nama */
app.post('/api/account/name', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const { name } = req.body || {};
  if (!vName(name)) return res.json({ ok: false, err: 'Nama minimal 5 huruf' });
  const cd = 12 * 86400000 - (now() - (u.nameChangedAt || 0));
  if (cd > 0) return res.json({ ok: false, err: 'Nama hanya bisa diubah setiap 12 hari' });
  u.name = name.trim(); u.nameChangedAt = now();
  pushNotif(u, '◉ Nama Diubah', 'Nama Anda: ' + u.name);
  res.json({ ok: true, user: sanitizeUser(u) });
});

/* Ganti password */
app.post('/api/account/pass', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const { oldPass, newPass } = req.body || {};
  if (oldPass !== u.pass) return res.json({ ok: false, err: 'Kata sandi lama salah' });
  if (!vPass(newPass)) return res.json({ ok: false, err: 'Sandi wajib huruf+angka+#' });
  u.pass = newPass;
  pushNotif(u, '▤ Kata Sandi', 'Kata sandi berhasil diubah.');
  res.json({ ok: true });
});

/* Ganti avatar */
app.post('/api/account/avatar', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const { avatar } = req.body || {};
  if (!avatar || avatar.length > 2000000) return res.json({ ok: false, err: 'Avatar terlalu besar' });
  u.avatar = avatar;
  res.json({ ok: true, user: sanitizeUser(u) });
});

/* Deposit request → masuk ke admin */
app.post('/api/deposit/request', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const { amount, method, code } = req.body || {};
  const amt = fmt(amount);
  if (![5000, 10000, 20000, 30000, 40000, 50000, 100000].includes(amt))
    return res.json({ ok: false, err: 'Nominal tidak valid' });
  if (!code || code.length < 6) return res.json({ ok: false, err: 'Kode tidak valid' });

  const item = {
    id: uid(), phone: u.phone, name: u.name,
    amount: amt, method: method || 'QRIS Server 1', code,
    status: 'pending', time: now()
  };
  state.pendingDeposits.unshift(item);
  state.history.unshift({ ...item, type: 'deposit' });
  if (state.history.length > 500) state.history.length = 500;
  pushNotif(u, '◈ Deposit Menunggu', 'Deposit ' + amt.toLocaleString('id-ID') + ' menunggu verifikasi admin.');
  res.json({ ok: true, id: item.id });
});

/* Withdraw request → masuk ke admin */
app.post('/api/withdraw/request', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const vip = calcVip(u.totalDeposit);
  if (vip < 2) return res.json({ ok: false, err: 'Hanya VIP 2+' });
  const { amount, dest, owner } = req.body || {};
  const amt = fmt(amount);
  if (amt < 5000) return res.json({ ok: false, err: 'Min Rp 5.000' });
  if (amt > 100000) return res.json({ ok: false, err: 'Maks Rp 100.000' });
  if (amt > u.saldo) return res.json({ ok: false, err: 'Saldo kurang' });
  if (!/^08\d{8,13}$/.test(dest || '')) return res.json({ ok: false, err: 'Nomor tujuan tidak valid' });
  if (!owner || owner.length < 3) return res.json({ ok: false, err: 'Nama pemilik tidak valid' });
  if ((u.withdrawCount || 0) >= 3) return res.json({ ok: false, err: 'Limit 3x/hari' });
  if ((u.toRequired || 0) > (u.turnoverSinceDep || 0)) return res.json({ ok: false, err: 'Turnover belum terpenuhi' });

  /* Kurangi saldo langsung (hold) */
  u.saldo -= amt;
  u.totalWithdraw += amt;
  u.withdrawCount = (u.withdrawCount || 0) + 1;

  const item = {
    id: uid(), phone: u.phone, name: u.name,
    amount: amt, dest, owner,
    status: 'pending', time: now()
  };
  state.pendingWithdraws.unshift(item);
  state.history.unshift({ ...item, type: 'withdraw' });
  if (state.history.length > 500) state.history.length = 500;
  pushNotif(u, '⇄ Penarikan Menunggu', 'Penarikan ' + amt.toLocaleString('id-ID') + ' menunggu approve admin.');
  res.json({ ok: true, id: item.id, user: sanitizeUser(u) });
});

/* Server spin (anti-cheat) */
app.post('/api/game/spin', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const { bet, gameId } = req.body || {};
  const b = fmt(bet);
  if (b < 200 || b > 1600) return res.json({ ok: false, err: 'Bet tidak valid' });
  if (u.saldo < b) return res.json({ ok: false, err: 'Saldo tidak cukup' });

  u.saldo -= b;
  u.turnover += b; u.turnoverSinceDep += b;

  const winChance = 0.35;
  const isWin = Math.random() < winChance;
  let win = 0, mult = 0;
  if (isWin) {
    mult = rnd(1, 5);
    win = fmt(b * mult * rnd(2, 6) / 4);
    if (win < b) win = b;
    if (mult >= 4 && Math.random() < 0.3) win = fmt(win * 1.8);
    u.saldo += win;
    u.totalWin += win;
    u.gameHistory.unshift({ time: now(), amount: win, title: gameId || 'Game' });
    if (u.gameHistory.length > 100) u.gameHistory.length = 100;
  } else {
    const cd = rnd(1, 10) / 10;
    u.cashDeposit = (u.cashDeposit || 0) + cd;
  }

  res.json({ ok: true, win, mult, user: sanitizeUser(u) });
});

/* Klaim hadiah harian */
app.post('/api/daily/claim', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const vip = calcVip(u.totalDeposit);
  if (vip < 1) return res.json({ ok: false, err: 'Perlu VIP 1' });
  if ((u.depositTodayAmt || 0) < 5000) return res.json({ ok: false, err: 'Deposit 5.000 dulu hari ini' });
  const today = new Date().toISOString().slice(0, 10);
  if (u.lastDaily === today) return res.json({ ok: false, err: 'Sudah klaim hari ini' });

  const table = {
    1: [200, 200, 200, 200, 200, 200, 500],
    2: [500, 500, 500, 500, 500, 500, 1000],
    3: [1000, 1000, 1000, 1000, 1000, 1000, 1500],
    4: [1500, 1500, 1500, 1500, 1500, 1500, 2000],
    5: [2000, 2000, 2000, 2000, 2000, 2000, 2500],
    6: [2500, 2500, 2500, 2500, 2500, 2500, 3000],
    7: [3000, 3000, 3000, 3000, 3000, 3000, 4000],
    8: [5000, 5000, 5000, 5000, 5000, 5000, 10000]
  };
  const dayIdx = Math.min(6, u.dailyDay || 0);
  const amt = (table[vip] || table[1])[dayIdx];
  u.saldo += amt;
  u.dailyDay = (u.dailyDay + 1) % 7;
  u.lastDaily = today;
  u.bonusHistory.unshift({ time: now(), amount: amt, type: 'Hadiah Harian' });
  pushNotif(u, '✧ Hadiah Harian', 'Anda dapat ' + amt.toLocaleString('id-ID'));
  res.json({ ok: true, amount: amt, user: sanitizeUser(u) });
});

/* Klaim cash deposit */
app.post('/api/cash/claim', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const cd = u.cashDeposit || 0;
  if (cd <= 0) return res.json({ ok: false, err: 'Belum ada cash deposit' });
  const amt = Math.floor(cd * 1000);
  u.saldo += amt;
  u.cashHistory.unshift({ coin: cd, time: now() });
  u.cashDeposit = 0;
  pushNotif(u, '▦ Cash Deposit', 'Diklaim ' + amt.toLocaleString('id-ID'));
  res.json({ ok: true, amount: amt, user: sanitizeUser(u) });
});

/* Tukar coin */
app.post('/api/coin/exchange', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const v = parseFloat(req.body?.amount) || 0;
  if (v < 1) return res.json({ ok: false, err: 'Minimal 1.0 Coin' });
  if (v > (u.coinBalance || 0)) return res.json({ ok: false, err: 'Coin tidak cukup' });
  const rp = Math.floor(v * 10);
  u.coinBalance = Math.round((u.coinBalance - v) * 10) / 10;
  u.saldo += rp;
  u.coinHistory.unshift({ time: now(), type: 'exchange', coin: v });
  pushNotif(u, '◉ Coin Ditukar', v + ' Coin → Rp ' + rp.toLocaleString('id-ID'));
  res.json({ ok: true, amount: rp, user: sanitizeUser(u) });
});

/* Pindah bonus deposit ke saldo utama */
app.post('/api/bonusdep/transfer', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const amt = u.bonusDeposit || 0;
  if (amt <= 0) return res.json({ ok: false, err: 'Belum ada bonus deposit' });
  u.saldo += amt; u.bonusDeposit = 0;
  u.bonusHistory.unshift({ time: now(), amount: amt, type: 'Pindah Bonus Deposit' });
  pushNotif(u, '✓ Bonus Dipindah', 'Rp ' + amt.toLocaleString('id-ID'));
  res.json({ ok: true, amount: amt, user: sanitizeUser(u) });
});

/* Redeem */
const REDEEM_CODES = { 'GANS777': 2500, 'OF2KG9N': 3000, 'KLDO3NS': 3500, 'BWFOA6D': 4000 };
app.post('/api/redeem', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  const code = (req.body?.code || '').trim().toUpperCase();
  if (!REDEEM_CODES[code]) return res.json({ ok: false, err: 'Kode tidak valid' });
  if (u.totalDeposit < 5000) return res.json({ ok: false, err: 'Perlu deposit 5.000' });
  if ((u.usedCodes || []).includes(code)) return res.json({ ok: false, err: 'Sudah pernah dipakai' });
  const amt = REDEEM_CODES[code];
  u.saldo += amt;
  u.usedCodes.push(code);
  u.redeemHistory.unshift({ code, amount: amt, time: now() });
  pushNotif(u, '◇ Redeem Berhasil', 'Kode ' + code + ' → Rp ' + amt.toLocaleString('id-ID'));
  res.json({ ok: true, amount: amt, user: sanitizeUser(u) });
});

/* Tabungan */
app.post('/api/saving/deposit', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  if (calcVip(u.totalDeposit) < 1) return res.json({ ok: false, err: 'Perlu VIP 1' });
  const amt = fmt(req.body?.amount);
  if (amt < 10000) return res.json({ ok: false, err: 'Min 10.000' });
  if (amt > u.saldo) return res.json({ ok: false, err: 'Saldo kurang' });
  u.saldo -= amt; u.saving += amt;
  u.savingHistory.unshift({ type: 'deposit', amount: amt, time: now() });
  res.json({ ok: true, user: sanitizeUser(u) });
});
app.post('/api/saving/withdraw', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  if (calcVip(u.totalDeposit) < 1) return res.json({ ok: false, err: 'Perlu VIP 1' });
  const amt = fmt(req.body?.amount);
  if (amt < 10000) return res.json({ ok: false, err: 'Min 10.000' });
  if (amt > u.saving) return res.json({ ok: false, err: 'Saldo tabungan kurang' });
  u.saving -= amt; u.saldo += amt;
  u.savingHistory.unshift({ type: 'withdraw', amount: amt, time: now() });
  res.json({ ok: true, user: sanitizeUser(u) });
});

/* Baca notif */
app.post('/api/notif/read', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  (u.notifs || []).forEach(n => n.read = true);
  res.json({ ok: true });
});

/* ============ ADMIN ENDPOINTS ============ */
app.post('/api/admin/login', (req, res) => {
  const { pass } = req.body || {};
  if (pass !== ADMIN_PASS) return res.json({ ok: false, err: 'Password salah' });
  const token = uid();
  state.adminTokens[token] = true;
  res.json({ ok: true, token });
});

app.get('/api/admin/pending', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  res.json({
    ok: true,
    deposits: state.pendingDeposits.filter(p => p.status === 'pending'),
    withdraws: state.pendingWithdraws.filter(p => p.status === 'pending'),
    stats: {
      totalUsers: Object.keys(state.users).length,
      totalPendingDep: state.pendingDeposits.filter(p => p.status === 'pending').length,
      totalPendingWd: state.pendingWithdraws.filter(p => p.status === 'pending').length,
      totalSaldo: Object.values(state.users).reduce((a, u) => a + (u.saldo || 0), 0)
    }
  });
});

/* Approve deposit */
app.post('/api/admin/approve/deposit', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const { id } = req.body || {};
  const item = state.pendingDeposits.find(p => p.id === id && p.status === 'pending');
  if (!item) return res.json({ ok: false, err: 'Tidak ditemukan' });
  const u = state.users[item.phone];
  if (!u) return res.json({ ok: false, err: 'User hilang' });

  item.status = 'success';
  item.doneAt = now();

  /* Tambah saldo + bonus deposit 10% + coin */
  u.saldo += item.amount;
  u.totalDeposit += item.amount;
  u.depositTodayAmt = (u.depositTodayAmt || 0) + item.amount;
  u.toRequired = item.amount;
  u.turnoverSinceDep = 0;

  const bdAmount = rnd(500, 1000);
  u.bonusDeposit = (u.bonusDeposit || 0) + bdAmount;
  u.bonusDepHistory.unshift({ time: now(), amount: bdAmount, deposit: item.amount });

  const coinGain = rnd(10, 100) / 10;
  u.coinBalance = Math.round(((u.coinBalance || 0) + coinGain) * 10) / 10;
  u.coinHistory.unshift({ time: now(), type: 'deposit', coin: coinGain });

  u.depositHistory.unshift({ time: now(), amount: item.amount, method: item.method, status: 'success' });

  pushNotif(u, '✓ Deposit Berhasil',
    'Deposit Rp ' + item.amount.toLocaleString('id-ID') +
    ' masuk. Bonus: Rp ' + bdAmount.toLocaleString('id-ID') +
    ' + ' + coinGain.toFixed(1) + ' Coin.');

  res.json({ ok: true });
});

/* Reject deposit */
app.post('/api/admin/reject/deposit', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const { id } = req.body || {};
  const item = state.pendingDeposits.find(p => p.id === id && p.status === 'pending');
  if (!item) return res.json({ ok: false, err: 'Tidak ditemukan' });
  item.status = 'failed';
  item.doneAt = now();
  const u = state.users[item.phone];
  if (u) pushNotif(u, '✕ Deposit Gagal', 'Deposit Rp ' + item.amount.toLocaleString('id-ID') + ' ditolak admin.');
  res.json({ ok: true });
});

/* Approve withdraw */
app.post('/api/admin/approve/withdraw', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const { id } = req.body || {};
  const item = state.pendingWithdraws.find(p => p.id === id && p.status === 'pending');
  if (!item) return res.json({ ok: false, err: 'Tidak ditemukan' });
  item.status = 'success';
  item.doneAt = now();
  const u = state.users[item.phone];
  if (u) {
    /* Coin dari penarikan */
    const coinGain = rnd(10, 100) / 10;
    u.coinBalance = Math.round(((u.coinBalance || 0) + coinGain) * 10) / 10;
    u.coinHistory.unshift({ time: now(), type: 'withdraw', coin: coinGain });

    u.withdrawHistory.unshift({ time: now(), amount: item.amount, dest: item.dest, owner: item.owner, status: 'success' });
    pushNotif(u, '✓ Penarikan Sukses',
      'Penarikan Rp ' + item.amount.toLocaleString('id-ID') + ' berhasil. +' + coinGain.toFixed(1) + ' Coin.');
  }
  res.json({ ok: true });
});

/* Reject withdraw (kembalikan saldo) */
app.post('/api/admin/reject/withdraw', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const { id } = req.body || {};
  const item = state.pendingWithdraws.find(p => p.id === id && p.status === 'pending');
  if (!item) return res.json({ ok: false, err: 'Tidak ditemukan' });
  item.status = 'failed';
  item.doneAt = now();
  const u = state.users[item.phone];
  if (u) {
    /* Kembalikan saldo yang di-hold */
    u.saldo += item.amount;
    u.totalWithdraw = Math.max(0, u.totalWithdraw - item.amount);
    u.withdrawCount = Math.max(0, (u.withdrawCount || 1) - 1);
    u.withdrawHistory.unshift({ time: now(), amount: item.amount, dest: item.dest, owner: item.owner, status: 'failed' });
    pushNotif(u, '✕ Penarikan Ditolak', 'Saldo Rp ' + item.amount.toLocaleString('id-ID') + ' dikembalikan.');
  }
  res.json({ ok: true });
});

app.get('/api/admin/users', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const users = Object.values(state.users).map(u => ({
    phone: u.phone, name: u.name, avatar: u.avatar,
    saldo: u.saldo, vip: calcVip(u.totalDeposit),
    totalDeposit: u.totalDeposit, totalWithdraw: u.totalWithdraw,
    blocked: u.blocked, created: u.created
  }));
  res.json({ ok: true, users });
});

app.post('/api/admin/users/block', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  const { phone, blocked } = req.body || {};
  const u = state.users[phone];
  if (!u) return res.json({ ok: false });
  u.blocked = !!blocked;
  res.json({ ok: true });
});

app.get('/api/admin/history', (req, res) => {
  if (!authAdmin(req)) return res.status(401).json({ ok: false });
  res.json({ ok: true, history: state.history.slice(0, 200) });
});

/* ============ START ============ */
app.listen(PORT, () => {
  console.log(`✅ GANS777 Server berjalan di port ${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`   User app:    http://localhost:${PORT}/index.html`);
});
