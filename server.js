// Short Scanner server: отдаёт страницу сканера и проксирует запросы к Bybit v5 с того же домена (без CORS).
// Секрет API сюда не попадает — ордера подписываются в браузере, сервер только пересылает запрос.
// Доступ закрыт Basic Auth: переменные AUTH_USER и AUTH_PASS (если не заданы — сайт открыт, в логе будет предупреждение).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const USER = process.env.AUTH_USER || '';
const PASS = process.env.AUTH_PASS || '';
const UP = { mainnet: 'https://api.bybit.com', testnet: 'https://api-testnet.bybit.com', demo: 'https://api-demo.bybit.com' };
const FWD = ['x-bapi-api-key', 'x-bapi-sign', 'x-bapi-timestamp', 'x-bapi-recv-window', 'content-type'];
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

function authed(req) {
  if (!USER || !PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === USER && p.join(':') === PASS;
}

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
  if (!USER || !PASS) console.warn('⚠️  AUTH_USER/AUTH_PASS не заданы — сайт открыт всем!');
});
