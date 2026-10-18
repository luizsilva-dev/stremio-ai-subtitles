// AI Subtitles — Stremio subtitles addon that translates English subtitles into the chosen
// language, using each user's own AI (and key). No dependencies: plain Node.
// Each user's config travels encrypted inside their own install link.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 7311);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, '');
// path prefix when the addon lives in a subdirectory (e.g. https://example.com/ai-subtitles)
const BASE_PATH = new URL(PUBLIC_URL).pathname.replace(/\/$/, '');
const SECRET = process.env.CONFIG_SECRET || '';
const REAL_IP_HEADER = (process.env.REAL_IP_HEADER || '').toLowerCase(); // e.g. cf-connecting-ip, x-real-ip
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_MAX_MB = Number(process.env.CACHE_MAX_MB || 2000);
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 24); // a translation is deleted this long after its last use
const JOBS_PER_IP_HOUR = Number(process.env.JOBS_PER_IP_HOUR || 30);
const MAX_JOBS = Number(process.env.MAX_JOBS || 10);
const REQS_PER_IP_MIN = Number(process.env.REQS_PER_IP_MIN || 60); // per IP per minute: lists and /api, and separately .srt files
const UPSTREAM_PER_MIN = Number(process.env.UPSTREAM_PER_MIN || 300); // calls to OpenSubtitles + Cinemeta per minute, all users together
const UPSTREAM_PER_IP_MIN = 10;          // of those, per IP (IPv6: per /64, and 3× that per /48)
// proxies allowed to set REAL_IP_HEADER, besides private and loopback addresses (IPs or CIDRs, comma-separated)
const TRUSTED_PROXIES = new net.BlockList();
for (const t of (process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const [a, n] = t.split('/');
  const fam = net.isIPv6(a) ? 'ipv6' : 'ipv4';
  if (n) TRUSTED_PROXIES.addSubnet(a, Number(n), fam); else TRUSTED_PROXIES.addAddress(a, fam);
}
const ALLOW_CUSTOM = process.env.ALLOW_CUSTOM_PROVIDER !== 'false';
const JOBS_PER_USER = 2;                 // concurrent translations per IP and per key
const JOB_DEADLINE = 10 * 60000;         // a translation still running after this is dropped
const CUSTOM_DEADLINE = 5 * 60000;       // same, on a custom endpoint
const REAL_IP_HOPS = Math.max(1, Number(process.env.REAL_IP_HOPS || 1)); // proxies that append to REAL_IP_HEADER
const MAX_ANSWER = 2 * 1048576;          // largest AI / metadata answer read
const MAX_SOURCE = 4 * 1048576;          // largest source subtitle read (a feature film is ~100 KB)
const MAX_CUES = 10000;                  // lines kept from one subtitle
const CUSTOM_JOBS = 4;                   // of the MAX_JOBS slots, how many custom endpoints may hold
const CUSTOM_TIMEOUT = 60000;            // per request to a custom endpoint
const API_PER_IP = 2, API_TOTAL = 6;     // /api/models and /api/test running at once
const MAP_CAP = 50000;                   // most entries kept in any per-IP table
const SRT_MEMORY = 64 * 1048576;         // finished subtitles kept ready in memory
const OPENSUBS = 'https://opensubtitles-v3.strem.io';
const CINEMETA = 'https://v3-cinemeta.strem.io'; // title name/genre/plot, to give the AI context
const BATCH_SIZE = 50;         // lines per AI request
const PARALLEL = 4;            // concurrent AI requests per subtitle

// Stremio languages (generated from github.com/Stremio/nodejs-langs, field "2"); English is left out as the source
const LANGS = require('./languages.json');
const LANG = Object.fromEntries(LANGS.map(l => [l.code, l]));

// default models checked against the official docs on 2026-10-12
// OpenAI-compatible providers use /chat/completions and /models on the base URL; Anthropic has its own API
const PROVIDERS = {
  openai:     { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
  anthropic:  { name: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', native: 'anthropic' },
  gemini:     { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite' },
  groq:       { name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash-lite' },
  deepseek:   { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  mistral:    { name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-2603' },
  xai:        { name: 'xAI (Grok)', base: 'https://api.x.ai/v1', model: 'grok-4.3' },
  custom:     { name: 'Custom (OpenAI-compatible)', base: '', model: '' },
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

const manifestBase = {
  id: 'dev.luizsilva.ai-subtitles',
  version: '2.1.0', // x-release-please-version
  name: 'AI Subtitles',
  description: 'Translates English subtitles into your language with your own AI (OpenAI, Claude, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Grok or any OpenAI-compatible endpoint).',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ---------- utilities ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Stremio apps load the addon routes cross-origin, so those allow any origin; the /api routes pass NO_CORS
const NO_CORS = { 'Access-Control-Allow-Origin': undefined, 'Access-Control-Allow-Headers': undefined };
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const headers = {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  res.writeHead(status, headers);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// an error whose message is safe to show to the user
const userError = msg => Object.assign(new Error(msg), { expose: true });

// every outbound request: https only, redirects refused, body capped (opts.maxBytes, MAX_ANSWER by default). With
// guard (custom endpoints) the address is checked by the same lookup the socket connects with, so DNS rebinding
// can't swap it afterwards. opts.signal (AbortSignal) cancels the request and closes its socket.
const abortedError = () => Object.assign(new Error('cancelled'), { aborted: true });
function fetchText(url, opts = {}, timeoutMs = 30000, guard = false) {
  const maxBytes = opts.maxBytes || MAX_ANSWER;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(userError('invalid address')); }
    if (u.protocol !== 'https:') return reject(userError('only https:// addresses are allowed'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (guard && net.isIP(host) && !publicIp(host)) return reject(privateError());
    if (opts.signal && opts.signal.aborted) return reject(abortedError());
    let settled = false;
    const onAbort = () => finish(abortedError());
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (err) { req.destroy(); reject(err); } else resolve(val);
    };
    const headers = { ...(opts.headers || {}) };
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request(u, { method: opts.method || 'GET', headers, agent: guard ? guardedAgent : undefined }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) return finish(userError('the answer was too large'));
        chunks.push(c);
      });
      res.on('error', finish);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.retryAfter = Number(res.headers['retry-after']) || 0;
          return finish(err);
        }
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
    });
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { name: 'AbortError' })), Math.max(1, timeoutMs));
    req.on('error', finish);
    req.on('close', () => finish(new Error('connection closed')));
    if (opts.signal) opts.signal.addEventListener('abort', onAbort);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// IPv6 users get a whole /64, so limits count the /64, not the address
function ipBucket(ip) {
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map(x => x.padStart(4, '0')).join(':')}::/64`;
}

// a proxy appends the address it saw to the right end of the header; values to its left come from the client.
// The header only counts when the connection comes from the proxy itself (private/loopback or TRUSTED_PROXIES):
// a client reaching the app port directly can't pick its own IP.
let warnedMulti = false, warnedUntrusted = false;
function clientIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const h = REAL_IP_HEADER && req.headers[REAL_IP_HEADER];
  let ip = '';
  if (h) {
    const trusted = !publicIp(peer) || TRUSTED_PROXIES.check(peer, net.isIPv6(peer) ? 'ipv6' : 'ipv4');
    if (!trusted) {
      if (!warnedUntrusted) {
        warnedUntrusted = true;
        log(`warning: ${REAL_IP_HEADER} came from ${peer}, which is not a trusted proxy; ignored. Add it to TRUSTED_PROXIES if it is your proxy.`);
      }
    } else {
      const list = String(h).split(',').map(s => s.trim()).filter(Boolean);
      if (list.length > 1 && REAL_IP_HOPS === 1 && !warnedMulti) {
        warnedMulti = true;
        log(`warning: ${REAL_IP_HEADER} has several values; using the last one. Set REAL_IP_HOPS if more than one proxy appends to it.`);
      }
      const cand = (list[list.length - REAL_IP_HOPS] || '').replace(/^::ffff:/, '');
      if (net.isIP(cand)) ip = cand;
    }
  }
  return ipBucket(ip || peer || '?');
}

// the /48 around an IPv6 /64 bucket (tunnel brokers hand out whole /48s); IPv4 stays as it is
const wideBucket = b => (b.endsWith('::/64') ? `${b.split(':').slice(0, 3).join(':')}::/48` : b);

// keeps per-IP tables bounded even if someone sprays addresses between the regular cleanups: expired entries go
// first, then the least recently active (entries move to the end on every hit), never the whole table at once
function capMap(map, alive) {
  if (map.size < MAP_CAP) return;
  for (const [k, v] of map) if (!alive(v)) map.delete(k);
  while (map.size >= MAP_CAP) map.delete(map.keys().next().value);
}

// sliding one-minute window per IP: lists and /api in ipHits, subtitle files in srtHits
const ipHits = new Map(); // ip → [timestamps]
const srtHits = new Map();
function tooManyRequests(ip, table = ipHits, limit = REQS_PER_IP_MIN) {
  const now = Date.now();
  const list = (table.get(ip) || []).filter(t => now - t < 60000);
  if (table.has(ip)) table.delete(ip); else capMap(table, l => l.some(t => now - t < 60000));
  table.set(ip, list);
  // refused requests aren't recorded, so a list never holds more than `limit` entries
  if (list.length >= limit) return true;
  list.push(now);
  return false;
}

// calls to OpenSubtitles and Cinemeta (lists, title info and source subtitle downloads): a small share per IP
// inside one cap for all users, so neither one client nor many addresses can turn the server into a source of
// traffic against them. Identical calls made at the same moment share one request and cost nothing extra.
const inflight = new Map(); // url → promise
const upHits = new Map();   // ip bucket (and its /48) → [timestamps]; '*' counts everyone
const busyError = () => Object.assign(userError('server busy, try again in a minute'), { busy: true });
function fetchUpstream(url, timeoutMs, ip, opts = {}) {
  if (inflight.has(url)) return inflight.get(url);
  const wide = wideBucket(ip);
  if (tooManyRequests(ip, upHits, UPSTREAM_PER_IP_MIN) ||
      (wide !== ip && tooManyRequests(wide, upHits, UPSTREAM_PER_IP_MIN * 3))) return Promise.reject(busyError());
  if (tooManyRequests('*', upHits, UPSTREAM_PER_MIN)) return Promise.reject(busyError());
  const p = fetchText(url, opts, timeoutMs).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

// ---------- config in the link (AES-256-GCM) ----------
// fields: p provider, k key, m model, u custom endpoint URL, l language, n number of options

const aesKey = crypto.createHash('sha256').update(SECRET).digest();

function sealConfig(cfg) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(cfg)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}

function openConfig(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return validConfig(JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString()));
  } catch {
    return null;
  }
}

// returns the clean config or null; throws an Error with a friendly message when called with strict
function validConfig(c, strict = false) {
  const fail = msg => { if (strict) throw new Error(msg); return null; };
  if (!c || typeof c !== 'object') return fail('Invalid configuration.');
  const p = String(c.p || '');
  if (!PROVIDERS[p]) return fail('Choose an AI provider.');
  if (p === 'custom' && !ALLOW_CUSTOM) return fail('The custom provider is turned off on this server.');
  const ctrl = /[\x00-\x1f\x7f-\x9f]/; // control characters would break headers and forge log lines
  const k = String(c.k || '').trim();
  if (!k || k.length > 400 || ctrl.test(k)) return fail('Enter your API key.');
  const m = String(c.m || PROVIDERS[p].model).trim();
  if (!m || m.length > 120 || ctrl.test(m)) return fail('Enter a model name.');
  let u = '';
  if (p === 'custom') {
    u = String(c.u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(u) || u.length > 300 || ctrl.test(u)) return fail('The custom endpoint must be an https:// URL.');
  }
  const l = String(c.l || '');
  if (!LANG[l]) return fail('Choose a language.');
  const n = Number(c.n || 1);
  if (!(n >= 1 && n <= 5)) return fail('Invalid number of options.');
  return { p, k, m, u, l, n };
}

// ---------- custom endpoint guard (never point at the internal network) ----------

// IPv4: every special-purpose range (IANA registry). IPv6: only global unicast (2000::/3) minus the ranges that
// can tunnel or embed another address, so ::ffff:…, NAT64 and friends never count as public.
const BLOCKED_V4 = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED_V4.addSubnet(a, n, 'ipv4');
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new net.BlockList();
for (const [a, n] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) BLOCKED_V6.addSubnet(a, n, 'ipv6');

function publicIp(ip) {
  if (net.isIPv4(ip)) return !BLOCKED_V4.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return GLOBAL_V6.check(ip, 'ipv6') && !BLOCKED_V6.check(ip, 'ipv6');
  return false;
}

// the same message whether the name doesn't exist or points inside, so internal names can't be probed
const privateError = () => userError('the custom endpoint must be a reachable public address');

// used by the socket itself to resolve custom endpoints: refuses the connection if any address isn't public.
// Asks DNS directly (with its own timeout) instead of the system resolver, which runs on Node's small thread pool:
// a nameserver that never answers can't stall file reads and other lookups for everyone.
const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
function guardedLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (typeof opts === 'number') opts = { family: opts };
  const ask = (family, q) => q.then(list => list.map(address => ({ address, family })), () => []);
  Promise.all([ask(4, resolver.resolve4(host)), ask(6, resolver.resolve6(host))]).then(([v4, v6]) => {
    const found = [...v4, ...v6];
    const addrs = opts.family ? found.filter(a => a.family === opts.family) : found;
    if (!addrs.length || found.some(a => !publicIp(a.address))) return cb(privateError());
    if (opts.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}
// no keep-alive: a socket to a custom host closes with its request, so idle connections can't pile up
const guardedAgent = new https.Agent({ keepAlive: false, maxTotalSockets: 50, lookup: guardedLookup });

// ---------- AI ----------

const baseUrl = cfg => (cfg.p === 'custom' ? cfg.u : PROVIDERS[cfg.p].base);

// parses an AI answer; a parse error never reaches the user (its message quotes the answer)
function parseAnswer(raw) {
  try { return JSON.parse(raw); } catch { throw Object.assign(userError('the AI answer could not be read'), { retry: true }); }
}

// deadline (optional) cuts the request when the whole translation runs out of time
async function chat(cfg, system, user, timeoutMs = 120000, deadline = Infinity, signal) {
  const base = baseUrl(cfg);
  const guard = cfg.p === 'custom';
  timeoutMs = Math.min(timeoutMs, guard ? CUSTOM_TIMEOUT : timeoutMs, deadline - Date.now());
  if (PROVIDERS[cfg.p].native === 'anthropic') {
    const raw = await fetchText(`${base}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': cfg.k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.m, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] }),
      signal,
    }, timeoutMs, guard);
    const content = parseAnswer(raw).content;
    return (Array.isArray(content) ? content : []).filter(b => b && b.type === 'text').map(b => String(b.text)).join('');
  }
  const raw = await fetchText(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.m,
      stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal,
  }, timeoutMs, guard);
  const msg = (((parseAnswer(raw) || {}).choices || [])[0] || {}).message;
  return msg && typeof msg.content === 'string' ? msg.content : '';
}

async function listModels(cfg, signal) {
  const base = baseUrl(cfg);
  const headers = PROVIDERS[cfg.p].native === 'anthropic'
    ? { 'x-api-key': cfg.k, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': `Bearer ${cfg.k}` };
  const data = parseAnswer(await fetchText(`${base}/models${cfg.p === 'anthropic' ? '?limit=100' : ''}`, { headers, signal }, 15000, cfg.p === 'custom'));
  const list = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
  const ids = (Array.isArray(list) ? list : []).map(m => String((m && (m.id || m.name)) || '').replace(/^models\//, ''))
    .filter(id => id && id.length <= 120);
  return [...new Set(ids)].sort().slice(0, 500);
}

// AI error in plain words (shown inside the subtitle and on the page)
function friendlyError(e) {
  if (e.expose) return e.message;
  if (e.status === 401 || e.status === 403) return 'invalid API key or no access to this model';
  if (e.status === 404) return 'model or endpoint not found';
  if (e.status === 429) return 'rate limit or no credits left on your AI account';
  if (e.status === 402) return 'no credits left on your AI account';
  if (e.status >= 300 && e.status < 400) return 'the endpoint tried to redirect, which is not allowed';
  if (e.name === 'AbortError') return 'the AI took too long to answer';
  // the provider's error body is never passed on: some echo part of the key
  if (e.status) return `the AI answered with HTTP ${e.status}`;
  return 'could not reach the AI';
}

const JARGON_PT = `
- Examples for Brazilian Portuguese: "engine" (fire truck) → "caminhão", "ladder" (truck/company) →
  "escada" or "caminhão-escada", "battalion chief" → "comandante", "EMT/paramedic" → "socorrista",
  "ER" → "pronto-socorro", "DOA" → "chegou sem vida", "perp" → "suspeito", "DA" → "promotor",
  "APB/BOLO" → "alerta geral", "10-4" → "entendido", "copy" (radio) → "na escuta"/"entendido",
  "code 3" → "com sirene", "stat" → "agora", "v-fib" → "parada cardíaca".`;

function systemPrompt(lang, ctx) {
  const L = LANG[lang];
  const target = `${L.name} (${L.local})`;
  return `You translate movie/TV subtitles from English to ${target}.

The audience is an ordinary viewer with no background in the show's field. Every line must be
understood at first read, in the 2-3 seconds it stays on screen.

- Natural, colloquial ${L.name}, as heard in good professional dubbing. Translate the meaning, never word by word.
- Professional jargon (firefighting, police, medical, military, legal, technical): use the term a native
  speaker would actually hear in that situation. If there is no common equivalent, say plainly what it
  means, in short words.${lang === 'pob' || lang === 'por' ? JARGON_PT : ''}
- Never leave unexplained English acronyms or codes. Never add notes, parentheses or explanations.
- Keep it short; prefer shorter wording when the meaning is the same.
- Keep the speakers' tone: slang, swearing and humor stay, adapted to natural equivalents.
- Keep names of people and places. Keep line breaks (\\n) and tags like <i></i> where they are.

You receive a JSON object mapping ids to subtitle lines. Reply ONLY with a JSON object with exactly
the same ids, each value being the translation. Do not merge or skip ids.` +
    (ctx ? `\n\nWhat is being watched (use it to pick the right vocabulary):\n${ctx}` : '');
}

// title context (name, genre, plot) from Cinemeta; null if not found
const metaCache = new Map();
async function titleContext(type, id, ip) {
  const imdb = id.split(':')[0];
  if (!/^tt\d{1,12}$/.test(imdb)) return null;
  if (metaCache.has(imdb)) return metaCache.get(imdb);
  let ctx = null;
  try {
    const { meta } = JSON.parse(await fetchUpstream(`${CINEMETA}/meta/${type}/${imdb}.json`, 8000, ip));
    if (meta && meta.name) {
      ctx = `Title: ${meta.name}${meta.year ? ` (${meta.year})` : ''}` +
        (meta.genre && meta.genre.length ? `\nGenre: ${meta.genre.join(', ')}` : '') +
        (meta.description ? `\nPlot: ${meta.description}` : '');
    }
  } catch (e) {
    if (e.busy) return null; // not remembered: try again on the next request
    log(`no context for ${imdb}:`, e.message);
  }
  if (metaCache.size > 5000) metaCache.clear();
  metaCache.set(imdb, ctx);
  return ctx;
}

// a translated line much longer than its source is not a translation: keep the English instead
const fits = (out, src) => typeof out === 'string' && out.trim() !== '' && out.length <= src.length * 4 + 40;

async function translateBatch(cfg, system, batch, deadline, signal) {
  const input = {};
  batch.forEach(c => { input[c.idx] = c.text; });
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal && signal.aborted) throw abortedError();
    if (Date.now() > deadline) throw userError('the translation took too long');
    try {
      const content = await chat(cfg, system, JSON.stringify(input), 120000, deadline, signal);
      const json = parseAnswer(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) || {};
      return batch.map(c => (fits(json[c.idx], c.text) ? json[c.idx] : c.text));
    } catch (e) {
      last = e;
      if (e.aborted) throw e;
      // retrying won't help (an unreadable answer is the only exposed error worth another try)
      if ([401, 402, 403, 404].includes(e.status) || (e.status >= 300 && e.status < 400) || (e.expose && !e.retry)) throw e;
      // a custom endpoint that sat on a request for a full minute, or failed on its side, doesn't get another one
      if (cfg.p === 'custom' && (e.name === 'AbortError' || e.status >= 500)) throw e;
      if (e.name === 'AbortError' && Date.now() >= deadline) throw e;
      await sleep(e.status === 429 ? Math.min(30, e.retryAfter || 5 * attempt) * 1000 : 1000 * attempt);
    }
  }
  if (last && last.status === 429) throw last;
  return batch.map(c => c.text); // give up: keep the English for this batch
}

// ---------- SRT ----------

function parseSrt(text) {
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    if (cues.length >= MAX_CUES) break;
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    // a cue whose time line doesn't parse is left out (the info cue does arithmetic on these)
    const t = lines[i].match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!t) continue;
    const ts = (h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s},${ms.padEnd(3, '0')}`;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ time: `${ts(t[1], t[2], t[3], t[4])} --> ${ts(t[5], t[6], t[7], t[8])}`, text: body });
  }
  return cues;
}

const buildSrt = cues => cues.map((c, i) => `${i + 1}\n${c.time}\n${c.text}\n`).join('\n');
const srtMs = t => { const [h, m, x] = t.split(':'); const [sec, ms] = x.split(','); return ((+h * 60 + +m) * 60 + +sec) * 1000 + +ms; };
const msSrt = ms => new Date(ms).toISOString().slice(11, 23).replace('.', ',');

// ---------- texts shown inside the subtitle ----------

const UI = {
  en: { working: p => `Translating with AI… ${p}%`, reopen: 'Open the subtitle again in a moment.', option: (i, n) => `Option ${i} of ${n}`, matched: 'made for this video file', sdh: 'with sound descriptions', error: 'AI error', fix: 'Check the AI Subtitles configuration.', busy: 'Server busy, try again in a minute.', limit: 'Too many new translations, try again later.' },
  pt: { working: p => `Traduzindo com IA… ${p}%`, reopen: 'Abra a legenda de novo em instantes.', option: (i, n) => `Opção ${i} de ${n}`, matched: 'feita para este arquivo de vídeo', sdh: 'com descrição de sons', error: 'Erro da IA', fix: 'Confira a configuração do AI Subtitles.', busy: 'Servidor ocupado, tente de novo em um minuto.', limit: 'Muitas traduções novas, tente mais tarde.' },
  es: { working: p => `Traduciendo con IA… ${p}%`, reopen: 'Vuelve a abrir el subtítulo en un momento.', option: (i, n) => `Opción ${i} de ${n}`, matched: 'hecho para este archivo de video', sdh: 'con descripción de sonidos', error: 'Error de la IA', fix: 'Revisa la configuración de AI Subtitles.', busy: 'Servidor ocupado, inténtalo en un minuto.', limit: 'Demasiadas traducciones nuevas, inténtalo más tarde.' },
  fr: { working: p => `Traduction par IA… ${p}%`, reopen: 'Rouvrez le sous-titre dans un instant.', option: (i, n) => `Option ${i} sur ${n}`, matched: 'fait pour ce fichier vidéo', sdh: 'avec description des sons', error: "Erreur de l'IA", fix: 'Vérifiez la configuration de AI Subtitles.', busy: 'Serveur occupé, réessayez dans une minute.', limit: 'Trop de nouvelles traductions, réessayez plus tard.' },
  de: { working: p => `Übersetzung mit KI… ${p}%`, reopen: 'Öffne den Untertitel gleich noch einmal.', option: (i, n) => `Option ${i} von ${n}`, matched: 'passend zu dieser Videodatei', sdh: 'mit Geräuschbeschreibungen', error: 'KI-Fehler', fix: 'Prüfe die Konfiguration von AI Subtitles.', busy: 'Server ausgelastet, versuche es in einer Minute.', limit: 'Zu viele neue Übersetzungen, versuche es später.' },
  it: { working: p => `Traduzione con IA… ${p}%`, reopen: 'Riapri il sottotitolo tra poco.', option: (i, n) => `Opzione ${i} di ${n}`, matched: 'fatto per questo file video', sdh: 'con descrizione dei suoni', error: "Errore dell'IA", fix: 'Controlla la configurazione di AI Subtitles.', busy: 'Server occupato, riprova tra un minuto.', limit: 'Troppe nuove traduzioni, riprova più tardi.' },
};
const UI_BY_LANG = { pob: 'pt', por: 'pt', spa: 'es', spl: 'es', fre: 'fr', ger: 'de', ita: 'it' };
const ui = lang => UI[UI_BY_LANG[lang] || 'en'];

// OpenSubtitles metadata goes inside the subtitle: one short line, no breaks or control characters
const oneLine = v => String(v || '').replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim().slice(0, 60);

function describeSource(s, i, n, lang) {
  const t = ui(lang);
  const group = oneLine(s.releaseGroup).replace(/\.(srt|txt|sub)$/i, '');
  const first = [t.option(i + 1, n), oneLine(s.releaseFormat), group].filter(Boolean).join(' · ');
  const extras = [];
  if (s.m === 'h') extras.push(t.matched);
  if (/[-._ ](HI|SDH)[-._ ]/i.test(s.subtitleFileName || '')) extras.push(t.sdh);
  return extras.length ? `${first}\n${extras.join(' · ')}` : first;
}

// the TV app shows no per-subtitle label, so the file info goes inside the subtitle itself:
// in the first 2 s+ silence within the first 30 s, or attached to the first line
function withInfo(cues, info) {
  if (!info) return cues;
  const span = c => c.time.split(' --> ').map(srtMs);
  let prevEnd = 0;
  for (let i = 0; i <= cues.length; i++) {
    const start = i < cues.length ? span(cues[i])[0] : prevEnd + 5100;
    if (prevEnd > 30000) break;
    if (start - prevEnd >= 2000) {
      const cue = { time: `${msSrt(prevEnd + 100)} --> ${msSrt(Math.min(start - 100, prevEnd + 5100))}`, text: info };
      return [...cues.slice(0, i), cue, ...cues.slice(i)];
    }
    if (i < cues.length) prevEnd = span(cues[i])[1];
  }
  return cues.length ? [{ ...cues[0], text: `${cues[0].text}\n[${info.replace(/\n/g, ' · ')}]` }, ...cues.slice(1)] : cues;
}

const noteSrt = (lines, extra = []) => buildSrt([{ time: '00:00:00,000 --> 00:00:10,000', text: lines.filter(Boolean).join('\n') }, ...extra]);

// ---------- cache and jobs ----------
// cache/{user}/{lang}/{key}.srt — each user only ever sees their own translations; mtime marks the last use and
// a file is deleted CACHE_TTL_HOURS after it. {user} is an HMAC of provider + endpoint + key, so it can't be guessed.

const userTag = cfg => crypto.createHmac('sha256', SECRET).update(`${cfg.p}|${cfg.u}|${cfg.k}`).digest('hex').slice(0, 32);
const cachePath = (cfg, key) => path.join(CACHE_DIR, userTag(cfg), cfg.l, `${key}.srt`);
const jobId = (cfg, key) => `${userTag(cfg)}/${cfg.l}/${key}`;
const jobs = new Map();     // jobId → { cues, done, total, ip, user }
const failures = new Map(); // jobId → { msg, at } (the error shows for a couple of minutes)
const ipJobs = new Map();   // ip → [timestamps of started translations]
let cacheBytes = 0;         // approximate size of the cache folder, checked against CACHE_MAX_MB on every write

function canStart(ip, user, custom) {
  const now = Date.now();
  const list = (ipJobs.get(ip) || []).filter(t => now - t < 3600000);
  if (!ipJobs.has(ip)) capMap(ipJobs, l => l.some(t => now - t < 3600000));
  ipJobs.set(ip, list);
  if (list.length >= JOBS_PER_IP_HOUR) return 'limit';
  let byIp = 0, byUser = 0, byCustom = 0;
  for (const j of jobs.values()) { if (j.ip === ip) byIp++; if (j.user === user) byUser++; if (j.custom) byCustom++; }
  if (jobs.size >= MAX_JOBS || byIp >= JOBS_PER_USER || byUser >= JOBS_PER_USER || (custom && byCustom >= CUSTOM_JOBS)) return 'busy';
  list.push(now);
  return '';
}

function startTranslation(cfg, key, sourceUrl, ctx, ip) {
  const id = jobId(cfg, key);
  const file = cachePath(cfg, key);
  if (fs.existsSync(file) || jobs.has(id)) return '';
  const f = failures.get(id);
  if (f && Date.now() - f.at < 120000) return '';
  const user = userTag(cfg);
  const custom = cfg.p === 'custom';
  const blocked = canStart(ip, user, custom);
  if (blocked) return blocked;
  failures.delete(id);
  const job = { cues: null, done: 0, total: 0, ip, user, custom };
  jobs.set(id, job);
  const deadline = Date.now() + (custom ? CUSTOM_DEADLINE : JOB_DEADLINE);
  // the first failure cancels the other requests of this job, so none keeps running unaccounted for
  const stop = new AbortController();
  (async () => {
    try {
      const cues = parseSrt(await fetchUpstream(sourceUrl, 30000, ip, { maxBytes: MAX_SOURCE }));
      if (!cues.length) throw userError('empty source subtitle');
      job.cues = cues.map(c => ({ ...c }));
      const batches = [];
      for (let i = 0; i < cues.length; i += BATCH_SIZE) {
        batches.push(cues.slice(i, i + BATCH_SIZE).map((c, j) => ({ idx: i + j, text: c.text })));
      }
      job.total = batches.length;
      const system = systemPrompt(cfg.l, ctx);
      log(`translating ${cfg.l}/${key} (${cfg.p}/${cfg.m}): ${cues.length} lines, ${batches.length} batches`);
      let next = 0, failed = null;
      const worker = async () => {
        try {
          while (next < batches.length && !stop.signal.aborted) {
            const b = batches[next++];
            const out = await translateBatch(cfg, system, b, deadline, stop.signal);
            b.forEach((c, j) => { job.cues[c.idx].text = out[j]; job.cues[c.idx].ok = true; });
            job.done++;
          }
        } catch (e) {
          if (!failed) failed = e;
          stop.abort();
        }
      };
      // the job stays counted until every worker has finished
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (failed) throw failed;
      const srt = buildSrt(job.cues);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, srt);
      cacheBytes += Buffer.byteLength(srt);
      if (cacheBytes > CACHE_MAX_MB * 1048576) cleanCache();
      log(`done ${cfg.l}/${key}`);
    } catch (e) {
      log(`failed ${cfg.l}/${key} (${cfg.p}/${cfg.m}):`, e.status || '', friendlyError(e));
      if (failures.size > 5000) failures.clear();
      failures.set(id, { msg: friendlyError(e), at: Date.now() });
    } finally {
      jobs.delete(id);
    }
  })();
  return '';
}

function progressSrt(cfg, key, info, blocked) {
  const t = ui(cfg.l);
  const id = jobId(cfg, key);
  if (blocked) return noteSrt([t[blocked]]);
  const f = failures.get(id);
  if (f && Date.now() - f.at < 120000) return noteSrt([`${t.error}: ${f.msg}`, t.fix]);
  const job = jobs.get(id);
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  const lines = [t.working(pct), t.reopen, info && info.split('\n')[0]];
  // what is already translated shows up; the rest is left out until ready
  return noteSrt(lines, job && job.cues ? job.cues.filter(c => c.ok) : []);
}

// cleanup: deletes what hasn't been used for CACHE_TTL_HOURS and, above CACHE_MAX_MB, the least recently used.
// A filesystem error is logged, never fatal.
function cleanCache() {
  try { cleanCacheNow(); } catch (e) { log('cache cleanup failed:', e.message); }
}
function cleanCacheNow() {
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const st = fs.statSync(p); files.push({ p, size: st.size, used: st.mtimeMs }); }
    }
  };
  walk(CACHE_DIR);
  const old = Date.now() - CACHE_TTL_HOURS * 3600000;
  let total = 0, removed = 0;
  files.sort((a, b) => b.used - a.used);
  for (const f of files) {
    if (f.used < old || total + f.size > CACHE_MAX_MB * 1048576 * 0.9) { fs.unlinkSync(f.p); removed++; } else total += f.size;
  }
  // drop folders left empty
  const prune = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      prune(p);
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    }
  };
  prune(CACHE_DIR);
  cacheBytes = total;
  ready.clear();
  readyBytes = 0;
  touched.clear();
  if (removed) log(`cache cleanup: removed ${removed} files`);
}

// ---------- Stremio routes ----------

// key = hash of the source subtitle URL, which is encoded in the link; nothing else in the link names the file
const encodeSrc = url => Buffer.from(url).toString('base64url');
const decodeSrc = s => Buffer.from(s, 'base64url').toString();
const keyFor = url => crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);

// stored when Stremio asks for the list (before asking for the .srt): title context and option info. Also the
// record of which sources this server handed out: a translation only starts for a source that came from a list,
// so nobody can make the server download arbitrary files. Oldest entries go first.
const subMeta = new Map(); // `${lang}/${key}` → { ctx, info }
function issue(k, v) {
  subMeta.delete(k);
  subMeta.set(k, v);
  while (subMeta.size > 20000) subMeta.delete(subMeta.keys().next().value);
}

// OpenSubtitles answers are reused for 10 minutes, so repeated requests don't hit them again
const listCache = new Map(); // url → { at, subs }
async function englishSubs(type, id, extra, ip) {
  const url = `${OPENSUBS}/subtitles/${type}/${encodeURIComponent(id)}${extra ? `/${extra}` : ''}.json`;
  const hit = listCache.get(url);
  if (hit && Date.now() - hit.at < 600000) return hit.subs;
  let data;
  try {
    data = JSON.parse(await fetchUpstream(url, 20000, ip));
  } catch (e) {
    if (e.busy) return []; // over the cap: an empty list now, a fresh try on the next request
    throw e;
  }
  const subs = (Array.isArray(data.subtitles) ? data.subtitles : [])
    .filter(s => s && s.lang === 'eng' && typeof s.url === 'string' && /^https:\/\/[\w.-]+\.strem\.io\//.test(s.url));
  if (listCache.size > 5000) listCache.clear();
  listCache.set(url, { at: Date.now(), subs });
  return subs;
}

async function handleSubtitles(cfg, token, type, id, extra, ip) {
  const english = (await englishSubs(type, id, extra, ip)).slice(0, cfg.n);
  if (!english.length) return [];
  const ctx = await titleContext(type, id, ip);
  return english.map((s, i) => {
    const key = keyFor(s.url);
    issue(`${cfg.l}/${key}`, { ctx, info: describeSource(s, i, english.length, cfg.l) });
    if (i === 0) startTranslation(cfg, key, s.url, ctx, ip); // start translating the best option right away
    return {
      id: `ai-${cfg.l}-${key}`,
      lang: cfg.l,
      url: `${PUBLIC_URL}/${token}/sub/${key}/${encodeSrc(s.url)}.srt`,
    };
  });
}

// finished subtitles ready to send: a file is read and rebuilt once, not on every request (least recently used go first)
const ready = new Map(); // `${file}\n${info}` → { body (bytes), size }
let readyBytes = 0;
function remember(k, body) {
  const size = body.length;
  if (size > SRT_MEMORY / 4) return;
  // two concurrent reads of the same file can both store it; count it once
  const prev = ready.get(k);
  if (prev) { ready.delete(k); readyBytes -= prev.size; }
  while (readyBytes + size > SRT_MEMORY && ready.size) {
    const [old, v] = ready.entries().next().value;
    ready.delete(old);
    readyBytes -= v.size;
  }
  ready.set(k, { body, size });
  readyBytes += size;
}

// mtime marks the last use; refreshed at most every 10 minutes, off the request path
const touched = new Map(); // file → last refresh
function touch(file) {
  const now = Date.now();
  if (now - (touched.get(file) || 0) < 600000) return;
  if (touched.size > 20000) touched.clear();
  touched.set(file, now);
  fs.promises.utimes(file, new Date(now), new Date(now)).catch(() => {});
}

async function serveSub(res, cfg, key, src, ip) {
  const srt = 'application/x-subrip; charset=utf-8';
  if (tooManyRequests(ip, srtHits)) return send(res, 200, noteSrt([ui(cfg.l).busy]), srt);
  const srcUrl = decodeSrc(src);
  // the key must belong to this source, so a translation can never be saved under another file's name
  if (!/^https:\/\/[\w.-]+\.strem\.io\//.test(srcUrl) || keyFor(srcUrl) !== key) {
    return send(res, 400, { error: 'invalid source' });
  }
  const meta = subMeta.get(`${cfg.l}/${key}`);
  const file = cachePath(cfg, key);
  const info = meta ? meta.info : '';
  const k = `${file}\n${info}`;
  let hit = ready.get(k);
  if (hit) {
    ready.delete(k);
    ready.set(k, hit);
  } else {
    let text = null;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch {}
    if (text !== null) {
      hit = { body: Buffer.from(buildSrt(withInfo(parseSrt(text), info))) };
      remember(k, hit.body);
    }
  }
  if (hit) {
    touch(file);
    return send(res, 200, hit.body, srt);
  }
  // not translated yet: only for a source this server listed (after a restart the app asks for the list again)
  if (!meta) return send(res, 200, noteSrt([ui(cfg.l).reopen]), srt);
  const blocked = startTranslation(cfg, key, srcUrl, meta.ctx || null, ip);
  return send(res, 200, progressSrt(cfg, key, info, blocked), srt);
}

// ---------- configuration page ----------

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function configurePage(cfg, token) {
  const cur = cfg || { p: 'openai', m: '', u: '', l: 'pob', n: 1 };
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  const providers = Object.entries(PROVIDERS).filter(([id]) => id !== 'custom' || ALLOW_CUSTOM)
    .map(([id, p]) => opt(id, p.name, id === cur.p)).join('');
  const langs = LANGS.map(l => opt(l.code, l.local && l.local !== l.name ? `${l.name} — ${l.local}` : l.name, l.code === cur.l)).join('');
  const defaults = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.model]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Subtitles</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f9e74'/%3E%3Crect x='7' y='18' width='18' height='3' rx='1.5' fill='white'/%3E%3Crect x='10' y='23' width='12' height='3' rx='1.5' fill='white'/%3E%3C/svg%3E">
<meta name="description" content="Stremio addon that translates subtitles into your language with your own AI key.">
<style>
:root{--bg:#121316;--card:#1b1c21;--txt:#ececf0;--mut:#a0a1ab;--acc:#2f9e74;--accd:#257d5c;--line:#2c2d34;--err:#e5484d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}p.sub{color:var(--mut);margin:0 0 24px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
h2{font-size:13px;margin:0 0 14px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
label{display:block;margin:0 0 6px;font-weight:500}small{display:block;color:var(--mut);margin:-8px 0 14px;font-size:13px}
select,input{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--txt);font-size:16px;margin-bottom:14px}
select:focus,input:focus{outline:2px solid var(--acc);outline-offset:1px}
.row{display:grid;grid-template-columns:1fr auto;gap:8px}.row button{margin-bottom:14px;width:auto;padding:0 14px}
button,.btn{display:block;width:100%;text-align:center;padding:14px;border-radius:10px;border:0;background:var(--acc);color:#fff;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}
button:active,.btn:active{transform:translateY(1px)}button:hover,.btn:hover{background:var(--accd)}
button.sec{background:transparent;border:1px solid var(--line);color:var(--txt)}button.sec:hover{background:var(--line)}
.out{display:none;margin-top:14px}.out.on{display:block}.msg{padding:12px;border-radius:10px;margin-top:12px;font-size:15px;display:none}
.msg.ok{display:block;background:#17301f;border:1px solid #2b5a3b;color:#b8efc9}.msg.bad{display:block;background:#3a1719;border:1px solid #6b2a2e;color:#ffc9cb}
code{display:block;word-break:break-all;color:var(--mut);font-size:13px;margin-top:10px}
ol,ul{margin:0;padding-left:20px;color:var(--mut)}li{margin-bottom:6px}
.hide{display:none}
</style></head><body><main>
<h1>AI Subtitles</h1><p class="sub">Stremio addon · translates English subtitles into your language with your own AI · v${esc(manifestBase.version)}</p>

<section><h2>Your AI</h2>
<label for="p">Provider</label><select id="p">${providers}</select>
<div id="uwrap" class="${cur.p === 'custom' ? '' : 'hide'}"><label for="u">Endpoint URL</label>
<input id="u" type="url" placeholder="https://example.com/v1" value="${esc(cur.u)}"><small>OpenAI-compatible base URL (the addon calls /chat/completions on it).</small></div>
<label for="k">API key</label><input id="k" type="password" autocomplete="off" placeholder="${cfg ? 'Saved — leave empty to keep it' : 'Paste your key'}">
<small>Stored only inside your install link, encrypted. Translations use your account. Don't share your install link: it carries your key.</small>
<label for="m">Model</label><div class="row"><input id="m" list="models" value="${esc(cur.m)}" placeholder=""><button class="sec" id="load" type="button">Load list</button></div>
<datalist id="models"></datalist>
<button class="sec" id="test" type="button">Test</button><div class="msg" id="testmsg"></div>
</section>

<section><h2>Subtitles</h2>
<label for="l">Translate into</label><select id="l">${langs}</select>
<small>This is also the language that shows up in Stremio's subtitle menu.</small>
<label for="n">Options in the menu</label><select id="n">${[1, 2, 3, 4, 5].map(n => opt(n, n, n === cur.n)).join('')}</select>
<small>Each option is a different English subtitle file (different video releases). Use more than 1 if the timing is off.</small>
</section>

<section><h2>Install</h2>
<button id="save" type="button">Install in Stremio</button><div class="msg" id="savemsg"></div>
<div class="out" id="out"><a class="btn" id="open" href="#">Open in Stremio</a>
<p style="margin:12px 0 0;color:var(--mut);font-size:14px">Or copy this link into Stremio → Addons → search box:</p><code id="link"></code></div>
</section>

<section><h2>How it works</h2><ol>
<li>When you open a movie or episode, the addon picks the best English subtitles from OpenSubtitles.</li>
<li>Your AI translates them in about 30 seconds. The first option starts right away.</li>
<li>If it is still translating, the subtitle says so. Open it again in a moment.</li>
<li>Translations are kept only for you, and deleted ${esc(CACHE_TTL_HOURS)} hours after you last open them.</li>
</ol></section>

<section><h2>Notice</h2><ul>
<li>This addon only translates subtitle text. It does not host, link or stream any video.</li>
<li>Source subtitles come from OpenSubtitles. Translations are made by the AI you choose, on your account.</li>
<li>Machine translation can be wrong. No warranty.</li>
</ul></section>
</main>
<script>
const $ = id => document.getElementById(id);
const DEFAULTS = ${JSON.stringify(defaults)};
const PREV = ${JSON.stringify(token || '')};
let lastDefault = $('m').value ? null : DEFAULTS[$('p').value];
if (!$('m').value) $('m').value = DEFAULTS[$('p').value] || '';
$('p').onchange = () => {
  $('uwrap').classList.toggle('hide', $('p').value !== 'custom');
  if (!$('m').value || $('m').value === lastDefault) $('m').value = lastDefault = DEFAULTS[$('p').value] || '';
  $('models').innerHTML = '';
};
const body = () => JSON.stringify({ p: $('p').value, k: $('k').value, m: $('m').value, u: $('u').value, l: $('l').value, n: Number($('n').value), prev: PREV });
const show = (el, ok, text) => { el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = text; };
async function call(path, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() }); return await r.json(); }
  catch (e) { return { error: 'Network error. Try again.' }; }
  finally { btn.disabled = false; btn.textContent = label; }
}
$('load').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/models', $('load'));
  if (r.error) return show($('testmsg'), false, r.error);
  $('models').replaceChildren(...r.models.map(m => { const o = document.createElement('option'); o.value = m; return o; }));
  show($('testmsg'), true, r.models.length + ' models found. Tap the model field to pick one.');
};
$('test').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/test', $('test'));
  show($('testmsg'), !r.error, r.error || ('It works: "' + r.sample + '"'));
};
$('save').onclick = async () => {
  const r = await call('${esc(PUBLIC_URL)}/api/config', $('save'));
  if (r.error) { $('out').classList.remove('on'); return show($('savemsg'), false, r.error); }
  $('savemsg').className = 'msg';
  $('open').href = r.stremio; $('link').textContent = r.manifest; $('out').classList.add('on');
  location.href = r.stremio;
};
</script></body></html>`;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new Error('too large'); }
  const v = JSON.parse(body || '{}');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v;
}

// builds the config from the form; an empty key reuses the one from the previous install, but only for the same
// provider and endpoint, so a leaked install link can't send the key somewhere else
function configFromForm(f) {
  if (String(f.k || '').trim()) return validConfig(f, true);
  const prev = f.prev ? openConfig(String(f.prev)) : null;
  if (!prev) return validConfig(f, true);
  const cfg = validConfig({ ...f, k: prev.k }, true);
  if (cfg.p !== prev.p || cfg.u !== prev.u) throw new Error('Enter your API key again when you change the provider or endpoint.');
  return cfg;
}

async function handleApi(req, res, name, ip) {
  const reply = (status, body) => send(res, status, body, undefined, NO_CORS); // same-origin page only
  let f;
  try { f = await readJson(req); } catch { return reply(400, { error: 'Invalid request.' }); }
  let cfg;
  try { cfg = configFromForm({ ...f, l: f.l || 'pob' }); } catch (e) { return reply(200, { error: e.message }); }
  try {
    if (name === 'config') {
      const token = sealConfig(cfg);
      const manifest = `${PUBLIC_URL}/${token}/manifest.json`;
      log(`install ${cfg.p}/${cfg.m} → ${cfg.l} x${cfg.n}`);
      return reply(200, { manifest, stremio: manifest.replace(/^https?:\/\//, 'stremio://') });
    }
    if (name !== 'models' && name !== 'test') return reply(404, { error: 'not found' });
    // these call the user's AI right away, so only a few may run at once
    if (apiRunning.size >= API_TOTAL || (apiByIp.get(ip) || 0) >= API_PER_IP) {
      return reply(429, { error: 'Too many checks running. Wait a moment and try again.' });
    }
    const run = Symbol(ip);
    apiRunning.add(run);
    apiByIp.set(ip, (apiByIp.get(ip) || 0) + 1);
    // a check whose page went away is cancelled, so it doesn't keep holding a slot
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    try {
      if (name === 'models') return reply(200, { models: await listModels(cfg, gone.signal) });
      const out = await chat(cfg, systemPrompt(cfg.l, null), JSON.stringify({ 0: 'Hey, are you okay? The ambulance is on its way.' }), 45000, Infinity, gone.signal);
      const json = parseAnswer(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) || {};
      if (typeof json[0] !== 'string') throw userError('the model did not answer in the expected format');
      return reply(200, { sample: json[0] });
    } finally {
      apiRunning.delete(run);
      const left = (apiByIp.get(ip) || 1) - 1;
      if (left > 0) apiByIp.set(ip, left); else apiByIp.delete(ip);
    }
  } catch (e) {
    return reply(200, { error: `Failed: ${friendlyError(e)}.` });
  }
}
const apiRunning = new Set();
const apiByIp = new Map(); // ip → calls running

// ---------- server ----------

// without REAL_IP_HEADER, traffic from a private address usually means a proxy in front and one shared rate limit
let warnedProxy = false;
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  if (!REAL_IP_HEADER && !warnedProxy) {
    const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (net.isIP(peer) && !publicIp(peer)) {
      warnedProxy = true;
      log(`warning: requests arrive from ${peer} and REAL_IP_HEADER is not set. If a reverse proxy is in front, every user shares that address and one rate limit.`);
    }
  }
  try {
    const url = new URL(req.url, 'http://x');
    // accept with or without the prefix (the proxy may pass the full path)
    let p = url.pathname;
    if (BASE_PATH && (p === BASE_PATH || p.startsWith(`${BASE_PATH}/`))) p = p.slice(BASE_PATH.length) || '/';
    let m = p.match(/^\/api\/(config|models|test)$/);
    // the API is only for the configure page itself: no CORS, and other sites' pages can't call it
    if (m) {
      const origin = req.headers.origin;
      if (req.method !== 'POST' || (origin && origin !== PUBLIC_ORIGIN)) return send(res, 403, { error: 'forbidden' }, undefined, NO_CORS);
      if (tooManyRequests(ip)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' }, undefined, NO_CORS);
      return handleApi(req, res, m[1], ip);
    }
    if (req.method === 'OPTIONS') return send(res, 204, '');
    // the configure page can't be framed by another site
    const html = 'text/html; charset=utf-8';
    const page = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };

    if (p === '/health') return send(res, 200, { ok: true, jobs: jobs.size });
    if (p === '/' ) return send(res, 302, '', 'text/plain', { Location: `${PUBLIC_URL}/configure` });
    if (p === '/configure') return send(res, 200, configurePage(null, ''), html, page);
    if (p === '/manifest.json') {
      return send(res, 200, { ...manifestBase, behaviorHints: { configurable: true, configurationRequired: true } });
    }

    // from here on: /{config}/...
    m = p.match(/^\/([A-Za-z0-9_-]{40,})(\/.*)$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, token, rest] = m;
    const cfg = openConfig(token);
    if (!cfg) {
      if (rest === '/configure') return send(res, 302, '', 'text/plain', { Location: `${PUBLIC_URL}/configure` });
      return send(res, 404, { error: 'invalid configuration, reinstall the addon' });
    }

    if (rest === '/manifest.json') {
      const L = LANG[cfg.l];
      return send(res, 200, { ...manifestBase, description: `${manifestBase.description} Translating into ${L.name}.`, behaviorHints: { configurable: true } });
    }
    if (rest === '/configure') return send(res, 200, configurePage(cfg, token), html, page);

    // /subtitles/{type}/{id}.json  or  /subtitles/{type}/{id}/{extra}.json
    m = rest.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/(.+))?\.json$/);
    if (m) {
      if (tooManyRequests(ip)) return send(res, 200, { subtitles: [], cacheMaxAge: 0 });
      const subtitles = await handleSubtitles(cfg, token, m[1], decodeURIComponent(m[2]), m[3], ip);
      return send(res, 200, { subtitles, cacheMaxAge: 0 });
    }

    m = rest.match(/^\/sub\/([\w-]+)\/([\w-]+)\.srt$/);
    if (m) return await serveSub(res, cfg, m[1], m[2], ip);

    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error:', e.message);
    send(res, 500, { error: 'internal error' });
  }
});

if (SECRET.length < 32) { console.error('CONFIG_SECRET missing or too short (min 32 chars)'); process.exit(1); }
if (!REAL_IP_HEADER) log('warning: REAL_IP_HEADER is not set. Behind a reverse proxy every user shares one IP and one rate limit.');
cleanCache();
setInterval(cleanCache, 3600000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [ip, l] of ipJobs) if (!l.some(t => now - t < 3600000)) ipJobs.delete(ip);
  for (const t of [ipHits, srtHits, upHits]) for (const [ip, l] of t) if (!l.some(x => now - x < 60000)) t.delete(ip);
}, 600000).unref();
server.listen(PORT, HOST, () => log(`AI Subtitles on ${PUBLIC_URL}/configure`));
