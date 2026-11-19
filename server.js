// Short Scanner server: отдаёт страницу сканера и проксирует запросы к Bybit v5 с того же домена (без CORS).
// Секрет API сюда не попадает — ордера подписываются в браузере, сервер только пересылает запрос.
// Доступ закрыт Basic Auth: переменные AUTH_USER и AUTH_PASS (если не заданы — сайт открыт, в логе будет предупреждение).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const USER = process.env.AUTH_USER || '';
const PASS = process.env.AUTH_PASS || '';
const UP = { mainnet: 'https://api.bybit.com', testnet: 'https://api-testnet.bybit.com', demo: 'https://api-demo.bybit.com' };
const FWD = ['x-bapi-api-key', 'x-bapi-sign', 'x-bapi-timestamp', 'x-bapi-recv-window', 'content-type'];
// Ключи Bybit из переменных Railway: подпись делает сервер, секрет в браузер не уходит.
const KEY = process.env.BYBIT_API_KEY || '';
const SEC = process.env.BYBIT_API_SECRET || '';
const KEY_ENV = process.env.BYBIT_ENV || 'mainnet'; // для какой среды эти ключи
// Разрешённые приватные эндпоинты — только торговля, позиции и баланс (никаких выводов/переводов).
const SIGNED_OK = /^\/v5\/(order\/(create|amend|cancel|cancel-all|realtime|history)|position\/(list|set-leverage|trading-stop)|account\/wallet-balance)$/;
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function authed(req) {
  if (!USER || !PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === USER && p.join(':') === PASS;
}

function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }

http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Short Scanner"' });
    return res.end('auth required');
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(INDEX);
  }
  if (req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ serverKeys: !!(KEY && SEC), env: KEY_ENV }));
  }
  const sg = req.url.match(/^\/signed\/(mainnet|testnet|demo)(\/v5\/[\w\-\/]+)(\?.*)?$/);
  if (sg) {
    if (!KEY || !SEC) return json(res, 400, { retCode: -1, retMsg: 'На Railway не заданы BYBIT_API_KEY / BYBIT_API_SECRET' });
    if (sg[1] !== KEY_ENV) return json(res, 400, { retCode: -1, retMsg: `Ключи на сервере для ${KEY_ENV}, а выбрана среда ${sg[1]}` });
    if (!SIGNED_OK.test(sg[2]) || !['GET', 'POST'].includes(req.method)) return json(res, 403, { retCode: -1, retMsg: 'эндпоинт запрещён' });
    let body = ''; for await (const c of req) body += c;
    const qs = sg[3] ? sg[3].slice(1) : '';
    const ts = String(Date.now()), rw = '10000';
    const sign = crypto.createHmac('sha256', SEC).update(ts + KEY + rw + (req.method === 'GET' ? qs : body)).digest('hex');
    try {
      const r = await fetch(UP[sg[1]] + sg[2] + (qs ? '?' + qs : ''), { method: req.method, body: req.method === 'GET' ? undefined : body,
        headers: { 'X-BAPI-API-KEY': KEY, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': rw, 'Content-Type': 'application/json' } });
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(await r.text());
    } catch (e) { return json(res, 502, { retCode: -1, retMsg: 'proxy: ' + e.message }); }
  }
  const m = req.url.match(/^\/(mainnet|testnet|demo)(\/v5\/[\w\-\/]+(\?.*)?)$/);
  if (!m || !['GET', 'POST'].includes(req.method)) { res.writeHead(404); return res.end('{"retCode":-1,"retMsg":"not found"}'); }
  let body = ''; for await (const c of req) body += c;
  const headers = {}; for (const k of FWD) if (req.headers[k]) headers[k] = req.headers[k];
  try {
    const r = await fetch(UP[m[1]] + m[2], { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(await r.text());
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ retCode: -1, retMsg: 'proxy: ' + e.message }));
  }
}).listen(PORT, () => {
  console.log('Short Scanner on :' + PORT);
  console.log(KEY && SEC ? `Ключи Bybit из переменных (${KEY_ENV}) загружены` : 'Ключи Bybit на сервере не заданы');
  if (!USER || !PASS) console.warn('⚠️  AUTH_USER/AUTH_PASS не заданы — сайт открыт всем!');
});
