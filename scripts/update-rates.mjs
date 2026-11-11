#!/usr/bin/env node
/**
 * BEpusdt 汇率 JSON 更新器
 *
 * 背景：BEpusdt 的汇率同步源是「CoinGecko 兼容基地址 + /api/v3/simple/price」。
 * 生产网关（8.137.35.64）访问不了 api.coingecko.com，所以汇率由本仓库静态托管，
 * 经 fastly.jsdelivr.net 供网关拉取（cdn.jsdelivr.net 对国内机房间歇 RST）。
 *
 * 本脚本：
 *   1. 取 6 个币的 USD 价（CoinGecko → Coinbase → Binance 逐级降级）
 *   2. 取 USD→CNY/JPY/EUR/GBP 汇率（open.er-api.com，免 key）
 *   3. 合成网关要求的 6 id × 5 fiat 结构
 *   4. 合理性闸门（防止把垃圾数据/被劫持的响应推到生产）
 *   5. 与线上文件比较，漂移超过阈值才提交（避免每 30 分钟刷无意义 commit）
 *   6. 提交后 purge jsDelivr 缓存（否则 CDN 缓存会挡住新数据）
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node update-rates.mjs          # 正式更新
 *   GITHUB_TOKEN=xxx node update-rates.mjs --dry    # 只打印，不提交
 *
 * 退出码：0 正常（含「无需更新」）／1 失败（数据源不可用或闸门拦截）
 */

const REPO = process.env.RATES_REPO || '996-dev/bepusdt-rate';
const BRANCH = process.env.RATES_BRANCH || 'main';
const FILE = 'api/v3/simple/price';
const DRY = process.argv.includes('--dry');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

/** 网关硬编码的 coin id（app/model/registry.go: supportCrypto） */
const IDS = ['tether', 'usd-coin', 'tron', 'binancecoin', 'ethereum', 'the-open-network'];
/** 网关硬编码的法币（app/model/registry.go: supportFiat）；usd 是计价基准 */
const FIATS = ['cny', 'jpy', 'eur', 'gbp'];

/** 相对漂移超过该比例才提交 */
const COMMIT_THRESHOLD = Number(process.env.RATES_THRESHOLD || 0.003); // 0.3%

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── 数据源 ────────────────────────────────────────────────────────────────

async function getJson(url, headers = {}, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'bepusdt-rate-sync/1.0', accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** CoinGecko：数据形态与网关期望完全一致，首选 */
async function fromCoingecko() {
  const qs = new URLSearchParams({ ids: IDS.join(','), vs_currencies: 'usd' });
  const headers = process.env.COINGECKO_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_KEY } : {};
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?${qs}`, headers);
  const out = {};
  for (const id of IDS) {
    const v = data?.[id]?.usd;
    if (typeof v !== 'number') throw new Error(`coingecko: missing ${id}.usd`);
    out[id] = v;
  }
  return { source: 'coingecko', prices: out };
}

/** Coinbase：一次请求拿全部资产（rates.AAA = 1 USD 换多少 AAA） */
async function fromCoinbase() {
  const data = await getJson('https://api.coinbase.com/v2/exchange-rates?currency=USD');
  const rates = data?.data?.rates;
  if (!rates) throw new Error('coinbase: no rates');
  const ticker = { tether: 'USDT', 'usd-coin': 'USDC', tron: 'TRX', binancecoin: 'BNB', ethereum: 'ETH', 'the-open-network': 'TON' };
  const out = {};
  for (const id of IDS) {
    const per = Number(rates[ticker[id]]);
    if (!Number.isFinite(per) || per <= 0) throw new Error(`coinbase: missing ${ticker[id]}`);
    out[id] = 1 / per;
  }
  return { source: 'coinbase', prices: out };
}

/** Binance：逐 symbol 兜底（都以 USDT 计价，USDT≈USD） */
async function fromBinance() {
  const symbols = ['USDCUSDT', 'TRXUSDT', 'BNBUSDT', 'ETHUSDT', 'TONUSDT'];
  const data = await getJson(`https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  const map = Object.fromEntries(data.map((r) => [r.symbol, Number(r.price)]));
  const out = { tether: 1 };
  const pairs = { 'usd-coin': 'USDCUSDT', tron: 'TRXUSDT', binancecoin: 'BNBUSDT', ethereum: 'ETHUSDT', 'the-open-network': 'TONUSDT' };
  for (const [id, sym] of Object.entries(pairs)) {
    if (!Number.isFinite(map[sym]) || map[sym] <= 0) throw new Error(`binance: missing ${sym}`);
    out[id] = map[sym];
  }
  return { source: 'binance', prices: out };
}

/** USD→法币（open.er-api.com 免 key，返回 1 USD = rates[X]） */
async function fiatRates() {
  const data = await getJson('https://open.er-api.com/v6/latest/USD');
  if (data?.result !== 'success') throw new Error(`er-api: ${data?.result ?? 'bad payload'}`);
  const out = {};
  for (const f of FIATS) {
    const v = Number(data.rates?.[f.toUpperCase()]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`er-api: missing ${f}`);
    out[f] = v;
  }
  return out;
}

// ── 合理性闸门 ────────────────────────────────────────────────────────────

const SANE = {
  tether: [0.9, 1.1],
  'usd-coin': [0.9, 1.1],
  tron: [0.02, 5],
  binancecoin: [100, 5000],
  ethereum: [200, 20000],
  'the-open-network': [0.3, 30],
};
const SANE_FIAT = { cny: [5, 9], jpy: [80, 250], eur: [0.7, 1.3], gbp: [0.6, 1.2] };

function guard(prices, fx) {
  const errs = [];
  for (const [id, [lo, hi]] of Object.entries(SANE)) {
    const v = prices[id];
    if (!Number.isFinite(v) || v <= 0) errs.push(`${id}=${v} 非正数`);
    else if (v < lo || v > hi) errs.push(`${id}=${v} 超出合理区间 [${lo},${hi}]`);
  }
  for (const [f, [lo, hi]] of Object.entries(SANE_FIAT)) {
    const v = fx[f];
    if (!Number.isFinite(v) || v < lo || v > hi) errs.push(`USD/${f}=${v} 超出合理区间 [${lo},${hi}]`);
  }
  return errs;
}

// ── 合成 ──────────────────────────────────────────────────────────────────

const round = (v, d) => Number(v.toFixed(d));

function build(prices, fx) {
  const out = {};
  for (const id of IDS) {
    const usd = prices[id];
    out[id] = { usd: round(usd, usd >= 100 ? 2 : usd >= 1 ? 4 : 6) };
    for (const f of FIATS) out[id][f] = round(usd * fx[f], 8);
  }
  return out;
}

/** 返回最大相对漂移（0 = 完全相同；无法比较返回 Infinity） */
function maxDrift(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Infinity;
  let worst = 0;
  for (const id of IDS) {
    for (const k of ['usd', ...FIATS]) {
      const x = a?.[id]?.[k];
      const y = b?.[id]?.[k];
      if (!Number.isFinite(y) || !Number.isFinite(x)) return Infinity;
      const d = y === 0 ? (x === 0 ? 0 : Infinity) : Math.abs(x - y) / Math.abs(y);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

// ── GitHub 读写 ───────────────────────────────────────────────────────────

const api = (p) => `https://api.github.com/repos/${REPO}${p}`;
const ghHeaders = () => ({
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'bepusdt-rate-sync/1.0',
});

async function gh(path, init = {}) {
  const res = await fetch(api(path), { ...init, headers: ghHeaders(), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`github ${path} → ${res.status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 200)}`);
  return body;
}

async function readRemote() {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}`, {
    headers: { 'user-agent': 'bepusdt-rate-sync/1.0', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return { sha: null, doc: null };
  if (!res.ok) throw new Error(`raw → HTTP ${res.status}`);
  const doc = await res.json();
  const meta = await gh(`/contents/${FILE}?ref=${BRANCH}`);
  return { sha: meta.sha, doc };
}

async function commit(doc, sha, source) {
  const content = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8').toString('base64');
  const body = {
    message: `rates: sync from ${source} (${new Date().toISOString()})`,
    content,
    branch: BRANCH,
    ...(sha ? { sha } : {}),
    committer: { name: 'rates-bot', email: 'rates-bot@users.noreply.github.com' },
  };
  return gh(`/contents/${FILE}`, { method: 'PUT', body: JSON.stringify(body) });
}

/** jsDelivr 默认对分支引用有较长缓存，必须主动 purge 才能让网关拿到新数据 */
async function purge() {
  try {
    const res = await fetch(`https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/${FILE}`, {
      signal: AbortSignal.timeout(20000),
    });
    const t = await res.text();
    log(res.ok ? `purge ok: ${t.replace(/\s+/g, ' ').slice(0, 160)}` : `purge failed HTTP ${res.status}: ${t.slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    log(`purge error: ${e.message}`);
    return false;
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  let picked = null;
  const errors = [];
  for (const fn of [fromCoingecko, fromCoinbase, fromBinance]) {
    try {
      const r = await fn();
      log(`prices ok via ${r.source}`);
      picked = r;
      break;
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
      log(`source failed — ${e.message}`);
    }
  }
  if (!picked) throw new Error(`全部行情源不可用:\n  ${errors.join('\n  ')}`);

  const fx = await fiatRates();
  log(`fx ok: ${JSON.stringify(fx)}`);

  const bad = guard(picked.prices, fx);
  if (bad.length) throw new Error(`合理性闸门拦截:\n  ${bad.join('\n  ')}`);

  const next = build(picked.prices, fx);
  log('payload:', JSON.stringify(next.tether), '…');

  if (!TOKEN) {
    log('no GITHUB_TOKEN — dry run only');
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  const { sha, doc } = await readRemote();
  const drift = maxDrift(next, doc);
  log(`drift vs published: ${drift === Infinity ? 'N/A (首个版本)' : (drift * 100).toFixed(3) + '%'} (阈值 ${(COMMIT_THRESHOLD * 100).toFixed(1)}%)`);

  if (drift < COMMIT_THRESHOLD) {
    log('漂移低于阈值，跳过提交');
    return;
  }
  if (DRY) {
    log('--dry 模式，不提交');
    return;
  }

  const res = await commit(next, sha, picked.source);
  log(`committed ${res.commit?.sha?.slice(0, 8)} → ${FILE}`);
  await purge();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
