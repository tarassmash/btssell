// Автобот 24/7: сканирует слабые монеты при росте BTC и шортит их на Bybit
// лимитками с догоном, ставит аварийный стоп и TP, закрывает по времени.
// Свои ордера бот помечает orderLinkId "bts-<время>-..." — так он узнаёт свои позиции даже после рестарта.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./lib/analysis');

const BASE = { mainnet: 'https://api.bybit.com', testnet: 'https://api-testnet.bybit.com', demo: 'https://api-demo.bybit.com' };
const KEY = process.env.BYBIT_API_KEY || '';
const SEC = process.env.BYBIT_API_SECRET || '';
const ENVN = BASE[process.env.BYBIT_ENV] ? process.env.BYBIT_ENV : 'mainnet';
const CFG_FILE = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'bot-config.json');
const n = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

const CFG = {
  enabled: process.env.BOT_ENABLED === 'true',
  tf: process.env.BOT_TF || '60',
  win: n(process.env.BOT_WINDOW, 48),
  top: n(process.env.BOT_TOP, 80),
  minVolM: n(process.env.BOT_MIN_VOL_M, 10),
  minScore: n(process.env.BOT_MIN_SCORE, 60),
  maxPos: n(process.env.BOT_MAX_POS, 5),
  usd: n(process.env.BOT_USD, 50),
  lev: n(process.env.BOT_LEV, 3),
  slPct: n(process.env.BOT_SL_PCT, 25),
  maxHoldH: n(process.env.BOT_MAX_HOLD_H, 24),
  scanMin: n(process.env.BOT_SCAN_MIN, 5),
  cooldownH: n(process.env.BOT_COOLDOWN_H, 6),
  chaseMs: 1500, entryTimeout: 60, maxDevPct: 1, exitTimeout: 30,
  requireBtcUp: process.env.BOT_REQUIRE_BTC_UP !== 'false',
  hedge: process.env.BOT_HEDGE === 'true',
};
const EDITABLE = { enabled: 'bool', requireBtcUp: 'bool', minScore: [0, 100], maxPos: [0, 20], usd: [5, 100000], lev: [1, 3], slPct: [1, 90], maxHoldH: [1, 720], scanMin: [1, 60], cooldownH: [0, 168] };
try { Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch (e) {}

const state = { logs: [], lastScan: null, busy: false, cooldown: {}, nextRun: 0, offset: 0, botPositions: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m, lvl = 'info') {
  const line = { t: Date.now(), lvl, m };
  state.logs.unshift(line); state.logs.length = Math.min(state.logs.length, 400);
  console.log(`[bot] ${lvl === 'err' ? 'ERR ' : ''}${m}`);
}

/* ---------- Bybit ---------- */
async function pub(p, q = {}) {
  const r = await fetch(BASE[ENVN] + p + '?' + new URLSearchParams(q));
  const j = await r.json(); if (j.retCode !== 0) throw new Error(p + ': ' + j.retMsg); return j.result;
}
async function priv(method, p, params = {}) {
  if (!KEY || !SEC) throw new Error('нет BYBIT_API_KEY / BYBIT_API_SECRET');
  const ts = String(Date.now() + state.offset), rw = '10000';
  const qs = method === 'GET' ? new URLSearchParams(params).toString() : '';
  const body = method === 'GET' ? undefined : JSON.stringify(params);
  const sign = crypto.createHmac('sha256', SEC).update(ts + KEY + rw + (method === 'GET' ? qs : body)).digest('hex');
  const r = await fetch(BASE[ENVN] + p + (qs ? '?' + qs : ''), { method, body,
    headers: { 'X-BAPI-API-KEY': KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'Content-Type': 'application/json' } });
  const j = await r.json();
  if (j.retCode !== 0) { const e = new Error(`${p}: ${j.retCode} ${j.retMsg}`); e.code = j.retCode; throw e; }
  return j.result;
}
async function syncTime() { const t0 = Date.now(); const r = await pub('/v5/market/time'); state.offset = Math.round(+r.timeNano / 1e6 - (t0 + Date.now()) / 2); }

const decs = x => { const s = String(x); if (s.includes('e-')) return +s.split('e-')[1]; return (s.split('.')[1] || '').length; };
const toTick = (p, t, mode) => { const k = mode === 'floor' ? Math.floor(p / t + 1e-9) : mode === 'ceil' ? Math.ceil(p / t - 1e-9) : Math.round(p / t); return +(k * t).toFixed(decs(t)); };
const fx = (v, t) => (+v).toFixed(decs(t));
const INSTR = {};
async function instr(sym) {
  if (INSTR[sym]) return INSTR[sym];
  const i = (await pub('/v5/market/instruments-info', { category: 'linear', symbol: sym })).list[0];
  if (!i) throw new Error('нет инструмента ' + sym);
  return INSTR[sym] = { tick: +i.priceFilter.tickSize, step: +i.lotSizeFilter.qtyStep, min: +i.lotSizeFilter.minOrderQty, maxLev: +i.leverageFilter.maxLeverage };
}
async function book(sym) { const r = await pub('/v5/market/orderbook', { category: 'linear', symbol: sym, limit: 1 }); return { bid: +r.b[0][0], ask: +r.a[0][0] }; }
const pIdx = () => (CFG.hedge ? 2 : 0);
const tag = (kind) => `bts-${Date.now().toString(36)}-${kind}-${Math.random().toString(36).slice(2, 6)}`;
const tagTime = (id) => { const m = /^bts-([0-9a-z]+)-/.exec(id || ''); return m ? parseInt(m[1], 36) : 0; };

async function getOrder(sym, id) {
  let r = await priv('GET', '/v5/order/realtime', { category: 'linear', symbol: sym, orderId: id });
  if (!r.list.length) r = await priv('GET', '/v5/order/history', { category: 'linear', symbol: sym, orderId: id });
  return r.list[0];
}
async function cancelOrd(sym, id) { try { await priv('POST', '/v5/order/cancel', { category: 'linear', symbol: sym, orderId: id }); } catch (e) { if (![110001, 170213].includes(e.code)) throw e; } }
async function allPositions() { return (await priv('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 200 })).list.filter(p => +p.size > 0); }
async function allOrders() {
  const out = []; let cursor = '';
  for (let i = 0; i < 10; i++) {
    const q = { category: 'linear', settleCoin: 'USDT', openOnly: 0, limit: 50 }; if (cursor) q.cursor = cursor;
    const r = await priv('GET', '/v5/order/realtime', q); out.push(...r.list);
    if (!r.nextPageCursor || r.list.length < 50) break; cursor = r.nextPageCursor;
  }
  return out;
}

async function setSL(sym, avg) {
  const I = await instr(sym), sl = toTick(avg * (1 + CFG.slPct / 100), I.tick, 'ceil');
  try {
    await priv('POST', '/v5/position/trading-stop', { category: 'linear', symbol: sym, positionIdx: pIdx(), tpslMode: 'Full', stopLoss: fx(sl, I.tick), slTriggerBy: 'MarkPrice' });
    log(`${sym}: аварийный стоп ${fx(sl, I.tick)} (+${CFG.slPct}% от ${avg})`);
  } catch (e) { if (e.code !== 34040) throw e; }
}

/* ---------- лимитка с догоном (PostOnly) ---------- */
async function chase(t) {
  const I = await instr(t.sym), sell = t.side === 'Sell';
  let done = 0, ord = null, ref = null, slDone = false; const t0 = Date.now();
  const tgt = (b, cur) => sell
    ? (cur && cur <= b.ask + 1e-12 ? cur : Math.max(toTick(b.ask - I.tick, I.tick), toTick(b.bid + I.tick, I.tick)))
    : (cur && cur >= b.bid - 1e-12 ? cur : Math.min(toTick(b.bid + I.tick, I.tick), toTick(b.ask - I.tick, I.tick)));
  const filled = () => done + (ord ? ord.cum : 0);
  while (true) {
    const rem = +(t.qty - filled()).toFixed(decs(I.step));
    if (rem < I.step / 2 || (!ord && rem < I.min && filled() > 0)) break;
    const b = await book(t.sym); if (ref === null) ref = sell ? b.ask : b.bid;
    const dev = sell ? (ref - b.ask) / ref : (b.bid - ref) / ref;
    const out = t.maxDev && dev > t.maxDev ? `цена ушла на ${(dev * 100).toFixed(2)}%` : (Date.now() - t0 > t.timeout * 1000 ? 'таймаут' : null);
    if (out) {
      if (ord) { await cancelOrd(t.sym, ord.id); const st = await getOrder(t.sym, ord.id); done += +(st?.cumExecQty ?? ord.cum); ord = null; }
      const left = +(t.qty - done).toFixed(decs(I.step));
      if (t.finalMarket && left >= I.min) {
        await priv('POST', '/v5/order/create', { category: 'linear', symbol: t.sym, side: t.side, orderType: 'Market', qty: fx(left, I.step), reduceOnly: t.reduceOnly, positionIdx: pIdx(), orderLinkId: tag('m') });
        done += left; log(`${t.sym}: ${out} → добил маркетом ${fx(left, I.step)}`);
      } else log(`${t.sym}: ${out} → догон остановлен, исполнено ${fx(done, I.step)} из ${fx(t.qty, I.step)}`);
      break;
    }
    if (!ord) {
      const p = tgt(b, null);
      const o = { category: 'linear', symbol: t.sym, side: t.side, orderType: 'Limit', qty: fx(rem, I.step), price: fx(p, I.tick), timeInForce: 'PostOnly', reduceOnly: t.reduceOnly, positionIdx: pIdx(), orderLinkId: tag(sell ? 'e' : 'x') };
      if (t.sl) { o.stopLoss = fx(toTick(p * (1 + CFG.slPct / 100), I.tick, 'ceil'), I.tick); o.slTriggerBy = 'MarkPrice'; o.tpslMode = 'Full'; }
      try { const r = await priv('POST', '/v5/order/create', o); ord = { id: r.orderId, price: p, cum: 0 }; }
      catch (e) { if (![170193, 170218, 110017].includes(e.code) && !/post.?only/i.test(e.message)) throw e; }
    } else {
      const st = await getOrder(t.sym, ord.id);
      if (st) {
        ord.cum = +st.cumExecQty;
        if (['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled'].includes(st.orderStatus)) { done += ord.cum; ord = null; }
        else {
          const p = tgt(b, ord.price);
          if (p !== ord.price) {
            try { await priv('POST', '/v5/order/amend', { category: 'linear', symbol: t.sym, orderId: ord.id, price: fx(p, I.tick) }); ord.price = p; }
            catch (e) { if (![110001, 10001, 110079].includes(e.code)) log(`${t.sym}: amend — ${e.message}`, 'err'); }
          }
        }
      }
    }
    if (t.sl && !slDone && filled() > 0) { slDone = true; try { const p = (await allPositions()).find(x => x.symbol === t.sym && x.side === 'Sell'); if (p) await setSL(t.sym, +p.avgPrice); } catch (e) { log(t.sym + ': стоп — ' + e.message, 'err'); } }
    await sleep(CFG.chaseMs);
  }
  return filled();
}

/* ---------- скан ---------- */
async function runScan() {
  const tick = (await pub('/v5/market/tickers', { category: 'linear' })).list.filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({ symbol: t.symbol, vol: +t.turnover24h, funding: +t.fundingRate * 100 }));
  const lim = Math.min(CFG.win + 80, 1000);
  const kl = async s => (await pub('/v5/market/kline', { category: 'linear', symbol: s, interval: CFG.tf, limit: lim })).list
    .map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  const btcK = await kl('BTCUSDT'), bc = btcK.map(x => x.c), N = bc.length;
  const { ema } = require('./lib/analysis'); const e50 = ema(bc, 50);
  const bret = (bc[N - 1] / bc[N - 1 - CFG.win] - 1) * 100;
  const btc = { price: bc[N - 1], ret: bret, up: bret > 0 && bc[N - 1] > e50[N - 1] };
  const cands = tick.filter(x => x.symbol !== 'BTCUSDT' && x.vol >= CFG.minVolM * 1e6 && !/^(USDC|FDUSD|TUSD|DAI|USDE)/.test(x.symbol))
    .sort((a, b) => b.vol - a.vol).slice(0, CFG.top);
  const rows = [], q = cands.slice();
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (q.length) { const t = q.shift(); try { const a = analyze(t, await kl(t.symbol), btcK, CFG.win); if (a) rows.push(a); } catch (e) {} }
  }));
  rows.sort((a, b) => b.score - a.score);
  return { time: Date.now(), btc, rows };
}

/* ---------- торговые действия ---------- */
async function openShort(r) {
  const sym = r.symbol, I = await instr(sym), b = await book(sym);
  const lev = Math.min(CFG.lev, I.maxLev), qty = toTick(CFG.usd / b.ask, I.step, 'floor');
  if (qty < I.min) { log(`${sym}: размер ${qty} меньше минимума ${I.min}, пропуск`); return; }
  try { await priv('POST', '/v5/position/set-leverage', { category: 'linear', symbol: sym, buyLeverage: String(lev), sellLeverage: String(lev) }); }
  catch (e) { if (e.code !== 110043) throw e; }
  log(`${sym}: ШОРТ score ${r.score}, ${fx(qty, I.step)} (~${(qty * b.ask).toFixed(1)} USDT, ${lev}x), догон от ${b.ask}`);
  const got = await chase({ sym, side: 'Sell', qty, reduceOnly: false, maxDev: CFG.maxDevPct / 100, timeout: CFG.entryTimeout, finalMarket: false, sl: true });
  state.cooldown[sym] = Date.now();
  if (!(got > 0)) { log(`${sym}: вход не исполнился`); return; }
  const p = (await allPositions()).find(x => x.symbol === sym && x.side === 'Sell');
  if (!p) return;
  const avg = +p.avgPrice, sz = +p.size;
  await setSL(sym, avg);
  // TP-лимитки reduceOnly, помечены bts — по ним бот узнаёт свою позицию
  let legs = [[r.lv.tp1], [r.lv.tp2]].map(([px]) => px).filter(px => px > 0 && px < avg * 0.998);
  if (!legs.length) legs = [avg * 0.97];
  const q1 = legs.length > 1 ? toTick(sz / 2, I.step, 'floor') : sz;
  const parts = legs.length > 1 && q1 >= I.min && sz - q1 >= I.min ? [[q1, legs[0]], [+(sz - q1).toFixed(decs(I.step)), legs[1]]] : [[sz, legs[0]]];
  for (const [q, px] of parts) {
    await priv('POST', '/v5/order/create', { category: 'linear', symbol: sym, side: 'Buy', orderType: 'Limit', qty: fx(q, I.step), price: fx(toTick(px, I.tick, 'floor'), I.tick), timeInForce: 'GTC', reduceOnly: true, positionIdx: pIdx(), orderLinkId: tag('tp') });
    log(`${sym}: TP Buy ${fx(q, I.step)} @ ${fx(toTick(px, I.tick, 'floor'), I.tick)}`);
  }
  log(`${sym}: в позиции ${p.size} @ ${avg}`);
}
async function closeChase(sym, why) {
  const p = (await allPositions()).find(x => x.symbol === sym && x.side === 'Sell');
  await priv('POST', '/v5/order/cancel-all', { category: 'linear', symbol: sym });
  if (!p) return;
  log(`${sym}: выход (${why}) — откуп ${p.size} лимиткой с догоном`);
  await chase({ sym, side: 'Buy', qty: +p.size, reduceOnly: true, maxDev: null, timeout: CFG.exitTimeout, finalMarket: true, sl: false });
  state.cooldown[sym] = Date.now();
  log(`${sym}: позиция закрыта`);
}

/* ---------- главный цикл ---------- */
async function cycle(force) {
  if (state.busy) return; state.busy = true;
  try {
    await syncTime();
    state.lastScan = await runScan();
    const sc = state.lastScan;
    if (!KEY || !SEC) { state.botPositions = []; return; }
    const [pos, ords] = await Promise.all([allPositions(), allOrders()]);
    const tagged = ords.filter(o => (o.orderLinkId || '').startsWith('bts-'));
    const botSyms = [...new Set(tagged.map(o => o.symbol))];
    state.botPositions = [];
    for (const sym of botSyms) {
      const p = pos.find(x => x.symbol === sym && x.side === 'Sell');
      const myOrds = tagged.filter(o => o.symbol === sym);
      if (!p) { // позиция закрылась (TP/стоп) — убираем хвосты
        for (const o of myOrds) await cancelOrd(sym, o.orderId);
        state.cooldown[sym] = Date.now(); log(`${sym}: позиция закрыта биржей (TP/стоп), ордера убраны`); continue;
      }
      const opened = Math.min(...myOrds.map(o => tagTime(o.orderLinkId)).filter(Boolean));
      const heldH = (Date.now() - opened) / 3600e3;
      state.botPositions.push({ symbol: sym, size: p.size, avg: p.avgPrice, mark: p.markPrice, pnl: +p.unrealisedPnl, sl: p.stopLoss, heldH: +heldH.toFixed(1) });
      if (!+p.stopLoss) { log(`${sym}: нет стопа — ставлю`, 'err'); await setSL(sym, +p.avgPrice); }
      if (heldH > CFG.maxHoldH) await closeChase(sym, `держим ${heldH.toFixed(1)}ч > ${CFG.maxHoldH}ч`);
    }
    if (!CFG.enabled) return;
    if (CFG.requireBtcUp && !sc.btc.up) { log(`BTC не растёт (${sc.btc.ret.toFixed(2)}% за окно) — новые шорты не открываю`); return; }
    let free = CFG.maxPos - state.botPositions.length;
    const busySyms = new Set([...pos.map(p => p.symbol), ...ords.map(o => o.symbol)]);
    const picks = sc.rows.filter(r => r.status === 2 && r.score >= CFG.minScore && !busySyms.has(r.symbol)
      && !(state.cooldown[r.symbol] && Date.now() - state.cooldown[r.symbol] < CFG.cooldownH * 3600e3));
    if (!picks.length && free > 0) log(`Скан: подходящих сигналов нет (BTC ${sc.btc.ret.toFixed(2)}%)`);
    for (const r of picks) {
      if (free <= 0) break;
      try { await openShort(r); free--; } catch (e) { log(`${r.symbol}: ошибка входа — ${e.message}`, 'err'); }
    }
  } catch (e) { log('Цикл: ' + e.message, 'err'); }
  finally { state.busy = false; }
}
function loop() {
  cycle().finally(() => { state.nextRun = Date.now() + CFG.scanMin * 60e3; setTimeout(loop, CFG.scanMin * 60e3); });
}

/* ---------- API для страницы ---------- */
function status() {
  const sc = state.lastScan;
  return {
    cfg: CFG, env: ENVN, hasKeys: !!(KEY && SEC), busy: state.busy, nextRun: state.nextRun,
    scan: sc && { time: sc.time, btc: sc.btc, rows: sc.rows.slice(0, 25).map(r => ({ symbol: r.symbol, score: r.score, stxt: r.stxt, status: r.status, rel: r.rel, upCap: r.upCap, rsi: r.rsi })) },
    positions: state.botPositions, logs: state.logs.slice(0, 150),
  };
}
function setConfig(o) {
  for (const [k, v] of Object.entries(o || {})) {
    const rule = EDITABLE[k]; if (!rule) continue;
    if (rule === 'bool') CFG[k] = v === true || v === 'true';
    else { const x = +v; if (!isNaN(x)) CFG[k] = Math.max(rule[0], Math.min(rule[1], x)); }
  }
  const save = {}; Object.keys(EDITABLE).forEach(k => save[k] = CFG[k]);
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(save)); } catch (e) {}
  log('Настройки: ' + Object.keys(o || {}).filter(k => EDITABLE[k]).map(k => `${k}=${CFG[k]}`).join(', '));
}

function start() {
  log(`Бот запущен: ${ENVN}, ключи ${KEY && SEC ? 'есть' : 'НЕ заданы'}, автоторговля ${CFG.enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
  setTimeout(loop, 3000);
}
async function closeManual(sym, why) {
  if (state.busy) throw new Error('busy'); state.busy = true;
  try { await syncTime(); await closeChase(sym, why); } catch (e) { log(`${sym}: выход — ${e.message}`, 'err'); } finally { state.busy = false; }
}
module.exports = { start, status, setConfig, cycle: () => cycle(true), closeChase: closeManual, _test: { chase, CFG, state, openShort, cycle } };
