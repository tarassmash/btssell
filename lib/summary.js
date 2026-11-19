// Дневная сводка «заработал / потерял» по всем ботам аккаунта.
// Источник — биржа: /v5/position/closed-pnl (реализованный PnL с комиссиями) + /v5/execution/list,
// чтобы по orderLinkId понять, чей это ордер: grid… = gridbot-html, vg_… = STAKAN-TRADING, bts-… = btssell.
// Закрытия по стопу (без метки) приписываются боту, который открывал эту монету последним.
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Madrid';
const DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..');
const EQ_FILE = path.join(DIR, 'equity-days.json');
const SUM_FILE = path.join(DIR, 'summaries.json');
const BOTS = [['grid', 'gridbot-html'], ['vg_', 'STAKAN-TRADING'], ['bts-', 'btssell']];
const botOf = id => { for (const [p, n] of BOTS) if ((id || '').startsWith(p)) return n; return ''; };

const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJ = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) {} };

function tzOffsetMs(at) {
  const d = new Date(at);
  return new Date(d.toLocaleString('en-US', { timeZone: TZ })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
}
function dayStr(at = Date.now()) { return new Date(at + tzOffsetMs(at)).toISOString().slice(0, 10); }
function dayStart(day) { const utc = Date.parse(day + 'T00:00:00Z'); return utc - tzOffsetMs(utc); }

async function pages(priv, p, q, max = 30) {
  const out = []; let cursor = '';
  for (let i = 0; i < max; i++) {
    const r = await priv('GET', p, cursor ? { ...q, cursor } : q);
    out.push(...(r.list || []));
    if (!r.nextPageCursor || (r.list || []).length < q.limit) break;
    cursor = r.nextPageCursor;
  }
  return out;
}

const CACHE = {};
async function summary(priv, day = dayStr()) {
  const today = dayStr();
  if (day > today) throw new Error('день в будущем');
  const c = CACHE[day];
  if (c && Date.now() - c.at < (day === today ? 60e3 : 3600e3)) return c.data;
  const start = dayStart(day), end = Math.min(dayStart(dayStr(start + 36 * 3600e3)), Date.now());
  const closed = await pages(priv, '/v5/position/closed-pnl', { category: 'linear', startTime: start, endTime: end, limit: 100 });
  // исполнения за 7 дней до конца дня — чтобы найти метки и открывающие ордера для закрытий по стопу
  const execs = await pages(priv, '/v5/execution/list', { category: 'linear', startTime: end - 7 * 86400e3 + 1000, endTime: end, limit: 100 }, 60);
  const linkOf = {}; execs.forEach(e => { if (e.orderLinkId) linkOf[e.orderId] = e.orderLinkId; });
  const bySym = {}; execs.filter(e => botOf(e.orderLinkId)).forEach(e => (bySym[e.symbol] ||= []).push(e));

  const bots = {};
  const add = name => (bots[name] ||= { name, pnl: 0, trades: 0, wins: 0, losses: 0, worst: null, best: null, stops: 0, coins: {} });
  for (const x of closed) {
    const t = +x.updatedTime, pnl = +x.closedPnl;
    let name = botOf(linkOf[x.orderId]), viaStop = false;
    if (!name) {
      const opens = (bySym[x.symbol] || []).filter(e => +e.execTime <= t).sort((a, b) => +b.execTime - +a.execTime);
      name = opens.length ? botOf(opens[0].orderLinkId) : '';
      viaStop = true;
    }
    const b = add(name || 'другое / вручную');
    b.pnl += pnl; b.trades++; pnl >= 0 ? b.wins++ : b.losses++;
    if (viaStop && pnl < 0) b.stops++;
    const sym = x.symbol.replace('USDT', '');
    b.coins[sym] = (b.coins[sym] || 0) + pnl;
    if (!b.worst || pnl < b.worst.pnl) b.worst = { symbol: sym, pnl };
    if (!b.best || pnl > b.best.pnl) b.best = { symbol: sym, pnl };
  }
  const list = Object.values(bots).map(b => ({ ...b, pnl: +b.pnl.toFixed(4),
    coins: Object.entries(b.coins).map(([s, v]) => ({ symbol: s, pnl: +v.toFixed(4) })).sort((a, z) => a.pnl - z.pnl) }))
    .sort((a, z) => z.pnl - a.pnl);
  const eq = readJ(EQ_FILE, {});
  const data = { day, total: +list.reduce((s, b) => s + b.pnl, 0).toFixed(4), trades: closed.length, bots: list,
    equityStart: eq[day] ?? null, equityEnd: eq[dayStr(end + 3600e3)] ?? null, generated: Date.now() };
  CACHE[day] = { at: Date.now(), data };
  return data;
}

// Вызывается из цикла бота: снимок депозита в начале дня + итог вчерашнего дня в лог
async function tick(priv, log) {
  const day = dayStr(), eq = readJ(EQ_FILE, {});
  let equity = null;
  try { equity = +(await priv('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' })).list[0].totalEquity; } catch (e) {}
  if (equity && !tick.said) { tick.said = true; log(`Депозит аккаунта: ${equity.toFixed(2)} USD — сводка «заработал / потерял» включена`); }
  if (eq[day] == null && equity) {
    eq[day] = +equity.toFixed(2);
    const keys = Object.keys(eq).sort(); while (keys.length > 60) delete eq[keys.shift()];
    writeJ(EQ_FILE, eq);
    const yest = dayStr(dayStart(day) - 3600e3), sums = readJ(SUM_FILE, {});
    if (!sums[yest]) {
      try {
        delete CACHE[yest];
        const s = await summary(priv, yest);
        sums[yest] = s; const k = Object.keys(sums).sort(); while (k.length > 60) delete sums[k.shift()];
        writeJ(SUM_FILE, sums);
        log(`📊 Итог ${yest}: ${s.total >= 0 ? '+' : ''}${s.total.toFixed(2)} USDT за ${s.trades} сделок · ` +
          s.bots.map(b => `${b.name} ${b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}`).join(' · ') +
          (s.equityStart != null ? ` · депозит ${s.equityStart} → ${eq[day]}` : ''));
      } catch (e) { log('Сводка за вчера: ' + e.message, 'err'); }
    }
  }
  return equity;
}

async function week(priv, n = 7) {
  const days = [], agg = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = dayStr(Date.now() - i * 86400e3);
    const s = await summary(priv, d); days.push({ day: d, total: s.total, trades: s.trades });
    for (const b of s.bots) { const a = (agg[b.name] ||= { name: b.name, pnl: 0, trades: 0, days: {} }); a.pnl += b.pnl; a.trades += b.trades; a.days[d] = +b.pnl.toFixed(2); }
  }
  const bots = Object.values(agg).map(b => ({ ...b, pnl: +b.pnl.toFixed(2) })).sort((a, z) => z.pnl - a.pnl);
  return { days, bots, total: +days.reduce((x, d) => x + d.total, 0).toFixed(2) };
}
module.exports = { summary, tick, week, dayStr, history: () => readJ(SUM_FILE, {}), equityDays: () => readJ(EQ_FILE, {}) };
