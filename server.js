// SiteSnag — free website downloader. Zero dependencies (Node 22+).
// Run: node server.js   then open http://localhost:3000
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const zlib = require('node:zlib');
const { grabFile, looksLikeFile, isDownloadLink, filenameFrom } = require('./filegrab');
const VIEWER_JS = fs.readFileSync(path.join(__dirname, 'serve-template.js'));

const PORT = Number(process.env.PORT) || 3000;
const LIMITS = {
  maxPagesCap: 500,
  maxFiles: 3000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024,
  timeoutMs: 20000,
  concurrency: 6,
  jobTtlMs: 30 * 60 * 1000,
  maxBundleFiles: 25,                    // linked downloads put into a site ZIP
  maxBundleBytes: 1024 * 1024 * 1024,    // 1 GB of linked downloads per site ZIP
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 SiteSnag/1.0';

// ---------------------------------------------------------------- SSRF guard
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
const hostCache = new Map();
async function assertPublicHost(hostname) {
  if (hostCache.has(hostname)) { if (!hostCache.get(hostname)) throw new Error('Blocked private address'); return; }
  const h = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  const ok = addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  hostCache.set(hostname, ok);
  if (!ok) throw new Error('Blocked private address');
}

async function safeFetch(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Unsupported protocol');
    await assertPublicHost(u.hostname);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(LIMITS.timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > LIMITS.maxFileBytes) throw new Error('File too large');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > LIMITS.maxFileBytes) throw new Error('File too large');
    return { finalUrl: current, type: (res.headers.get('content-type') || '').toLowerCase(), body };
  }
  throw new Error('Too many redirects');
}

// ---------------------------------------------------------------- link parsing
const SKIP = /^(?:#|mailto:|tel:|javascript:|data:|about:|blob:|sms:)/i;
function resolve(ref, base) {
  ref = (ref || '').trim().replace(/&amp;/g, '&');
  if (!ref || SKIP.test(ref)) return null;
  try {
    const u = new URL(ref, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
const ASSET_REL = /\b(stylesheet|icon|shortcut|apple-touch-icon|preload|modulepreload|manifest|mask-icon|prefetch)\b/i;
const ATTR_RE = /(\s(?:href|src|poster|data-src|data-original|data-bg)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const SRCSET_RE = /(\s(?:srcset|data-srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;

// Walk an HTML document. `onRef(rawUrl, kind)` returns replacement string or undefined.
// kind: 'page' | 'asset'
function walkHtml(html, onRef) {
  // <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + walkCss(css, onRef) + c);
  // Tags
  return html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (t === 'base') return '';
    let kindFor;
    if (t === 'a' || t === 'area' || t === 'iframe' || t === 'frame') kindFor = 'page';
    else if (t === 'link') {
      const rel = (attrs.match(/\srel\s*=\s*["']?([^"'>]*)/i) || [])[1] || '';
      kindFor = ASSET_REL.test(rel) ? 'asset' : null;
    } else kindFor = 'asset';
    let out = attrs;
    if (kindFor) {
      out = out.replace(ATTR_RE, (m2, pre, d, s, u) => {
        const raw = d ?? s ?? u;
        const attrName = pre.trim().split(/\s|=/)[0].toLowerCase();
        if (attrName === 'href' && !(t === 'a' || t === 'area' || t === 'link')) return m2;
        const rep = onRef(raw, kindFor, t);
        return rep === undefined ? m2 : `${pre}"${rep}"`;
      });
    }
    out = out.replace(SRCSET_RE, (m2, pre, d, s) => {
      const parts = (d ?? s).split(',').map(p => {
        const [u, ...rest] = p.trim().split(/\s+/);
        if (!u) return p;
        const rep = onRef(u, 'asset');
        return [rep === undefined ? u : rep, ...rest].join(' ');
      });
      return `${pre}"${parts.join(', ')}"`;
    });
    out = out.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m2, pre, d, s) => {
      const q = d !== undefined ? '"' : "'";
      return pre + q + walkCss(d ?? s, onRef) + q;
    });
    // Saved copies are opened from disk (file://), where browsers block any resource marked
    // crossorigin/integrity (e.g. GitHub's stylesheets), so drop those attributes.
    if (t === 'link' || t === 'script' || t === 'img' || t === 'source' || t === 'video' || t === 'audio') {
      out = out.replace(/\s(?:crossorigin|integrity)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?(?=[\s/>]|$)/gi, '');
    }
    return `<${tag}${out}>`;
  });
}
function walkCss(css, onRef) {
  css = css.replace(CSS_IMPORT_RE, (m, d, s) => {
    const rep = onRef(d ?? s, 'asset');
    return rep === undefined ? m : `@import "${rep}"`;
  });
  return css.replace(CSS_URL_RE, (m, d, s, u) => {
    const raw = d ?? s ?? u;
    const rep = onRef(raw, 'asset');
    return rep === undefined ? m : `url("${rep}")`;
  });
}

// ---------------------------------------------------------------- local paths
const EXT_BY_TYPE = {
  'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff2': '.woff2', 'application/font-woff': '.woff', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
  'application/pdf': '.pdf', 'application/manifest+json': '.webmanifest', 'text/plain': '.txt', 'application/xml': '.xml',
};
const isHtmlType = t => t.includes('text/html') || t.includes('application/xhtml');
const isCssType = t => t.includes('text/css');

function makePathAssigner(isInternal) {
  const used = new Set();
  const assign = function (rec) {
    const u = new URL(rec.finalUrl);
    const html = isHtmlType(rec.type);
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
    p = p.split('/').filter(s => s && s !== '.' && s !== '..')
      .map(s => s.replace(/[<>:"|?*\\\x00-\x1f]/g, '_').slice(0, 120)).join('/');
    const trailing = u.pathname.endsWith('/') || p === '';
    let ext = path.posix.extname(p).toLowerCase();
    if (html) {
      if (trailing) p = (p ? p + '/' : '') + 'index.html';
      else if (ext !== '.html' && ext !== '.htm') p += '/index.html';
    } else {
      const guess = EXT_BY_TYPE[rec.type.split(';')[0].trim()] || '';
      if (trailing) p = (p ? p + '/' : '') + 'index' + guess;
      else if (!ext && guess) p += guess;
    }
    if (u.search) {
      const h = crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8);
      const e = path.posix.extname(p);
      p = p.slice(0, p.length - e.length) + '_' + h + e;
    }
    if (!isInternal(u)) p = `_external/${u.host.replace(/:/g, '_')}/${p}`;
    let candidate = p, n = 1;
    while (used.has(candidate.toLowerCase())) {
      const e = path.posix.extname(p);
      candidate = `${p.slice(0, p.length - e.length)}-${n++}${e}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  };
  assign.reserve = p => used.add(p.toLowerCase());
  return assign;
}

// ---------------------------------------------------------------- zip writer
function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data) >>> 0;
    const comp = zlib.deflateRawSync(f.data, { level: 6 });
    const useComp = comp.length < f.data.length;
    const data = useComp ? comp : f.data;
    const method = useComp ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

// ---------------------------------------------------------------- Wayback Machine
const siteKey = host => host.toLowerCase().replace(/^www\./, '');
const WB_RE = /^https?:\/\/web\.archive\.org\/web\/(\d{1,14}|\*)(?:[a-z]{2}_)?\/(.+)$/i;

// "https://web.archive.org/web/20200101id_/http://x.com/a" -> { ts, url: "http://x.com/a" }
function parseWayback(u) {
  const m = String(u).match(WB_RE);
  if (!m) return null;
  let orig = m[2];
  if (!/^https?:\/\//i.test(orig)) orig = 'http://' + orig.replace(/^https?:\/+/i, '');
  try {
    const p = new URL(orig);
    if ((p.protocol === 'http:' && p.port === '80') || (p.protocol === 'https:' && p.port === '443')) p.port = '';
    return { ts: m[1] === '*' ? null : m[1], url: p.href };
  } catch { return null; }
}
const waybackRaw = (ts, url) => 'https://web.archive.org/web/' + ts + 'id_/' + url;
const fmtTs = ts => ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchWithRetry(url, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await safeFetch(url); }
    catch (e) {
      // The archive rate-limits and has hiccups; back off and retry those.
      if (i >= tries - 1 || !/HTTP (429|50\d)|timeout|aborted|fetch failed/i.test(e.message)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

// Find the newest archived capture of this page that actually loads.
async function findLatestWorkingSnapshot(pageUrl, log) {
  const u = new URL(pageUrl);
  const key = siteKey(u.hostname) + u.pathname + u.search;
  const cdx = 'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original' +
    '&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&limit=-25' +
    '&url=' + encodeURIComponent(key);
  let rows;
  try {
    const r = await fetchWithRetry(cdx);
    rows = JSON.parse(r.body.toString('utf8') || '[]').slice(1);
  } catch (e) { throw new Error('Could not reach the Internet Archive (' + e.message + ')'); }
  if (!rows.length) throw new Error('The Internet Archive has no saved copies of this page.');
  rows.reverse(); // newest first
  for (const [ts, original] of rows.slice(0, 8)) {
    log('try   snapshot ' + fmtTs(ts) + ' (' + ts + ')');
    try {
      const rec = await fetchWithRetry(waybackRaw(ts, original), 2);
      const text = rec.body.toString('utf8');
      // "Works" = real HTML with some content, not an empty shell or an error page.
      if (isHtmlType(rec.type) && text.length > 400 && /<(body|div|p|a|img)\b/i.test(text)) {
        const back = parseWayback(rec.finalUrl);
        return { ts: (back && back.ts) || ts, url: original, rec };
      }
      log('      snapshot ' + ts + ' looks broken, trying an older one');
    } catch (e) { log('      snapshot ' + ts + ' failed (' + e.message + ')'); }
  }
  throw new Error('Found archived copies, but none of the recent ones load.');
}

// ---------------------------------------------------------------- crawler
async function crawl(job) {
  const { startUrl, maxPages, maxDepth, external, source, scanOnly, bundleFiles } = job.opts;
  const log = msg => { job.log.push(msg); if (job.log.length > 300) job.log.shift(); };
  let root = new URL(startUrl);
  let wb = null;          // { ts } when rebuilding from the Wayback Machine
  let firstRec = null;    // start page already fetched while picking a source

  const useSnapshot = async () => {
    job.status = 'finding snapshot';
    log('Looking up the latest working snapshot of ' + root.href + ' ...');
    const snap = await findLatestWorkingSnapshot(root.href, log);
    wb = { ts: snap.ts }; firstRec = snap.rec; root = new URL(snap.url);
  };

  const pasted = parseWayback(startUrl);
  if (pasted) {
    root = new URL(pasted.url);
    if (pasted.ts) {
      log('Using the Wayback snapshot from the link (' + pasted.ts + ')');
      job.status = 'finding snapshot';
      try {
        // The archive redirects partial dates (e.g. "2010") to the closest real capture.
        firstRec = await fetchWithRetry(waybackRaw(pasted.ts, root.href));
        const back = parseWayback(firstRec.finalUrl);
        wb = { ts: (back && back.ts && back.ts.length === 14) ? back.ts : pasted.ts.padEnd(14, '0') };
      } catch (e) {
        log('That snapshot did not load (' + e.message + ') - looking for the latest working one');
        firstRec = null;
        await useSnapshot();
      }
    } else await useSnapshot();
  } else if (source === 'wayback') {
    await useSnapshot();
  } else if (source === 'auto') {
    try {
      firstRec = await safeFetch(root.href);
    } catch (e) {
      log('Live site failed (' + e.message + ') - switching to the Internet Archive');
      await useSnapshot();
    }
  }
  if (wb) {
    job.snapshot = { ts: wb.ts, date: fmtTs(wb.ts), url: root.href, view: 'https://web.archive.org/web/' + wb.ts + '/' + root.href };
    log('Rebuilding from the Wayback snapshot of ' + job.snapshot.date);
  }
  job.status = 'crawling';
  const concurrency = wb ? 3 : LIMITS.concurrency; // be polite to archive.org
  const rootKey = siteKey(root.hostname);
  const isInternal = u => siteKey(u.hostname) === rootKey;

  // Resolve a reference to an absolute "logical" URL (always the original site's URL, never archive.org).
  const res = (raw, base) => {
    let abs = resolve(raw, base);
    if (!abs) return null;
    const w = parseWayback(abs);
    if (w) abs = w.url;
    if (wb) {
      // Archive captures mix http/https and www/no-www; fold internal URLs onto the root's form.
      const u = new URL(abs);
      if (isInternal(u)) { u.protocol = root.protocol; u.hostname = root.hostname; u.port = root.port; abs = u.href; }
    }
    return abs;
  };
  const fetchLogical = url => wb ? fetchWithRetry(waybackRaw(wb.ts, url)) : safeFetch(url);

  const records = new Map();   // logical url -> record
  const seen = new Set();
  const pageHashes = new Map(); // sha1(html) -> record
  const queue = [{ url: root.href, kind: 'page', depth: 0 }];
  seen.add(root.href);
  let pageCount = 0, pagesScheduled = 1, totalBytes = 0, active = 0;

  // Download links (installers, zips...) found on pages, and SHA-256 checksums the pages publish for them.
  const foundFiles = new Map();
  const checksums = new Map();
  const collectChecksums = html => {
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
    for (const m of text.matchAll(/\b([a-f0-9]{64})\b[\s*:]+([A-Za-z0-9][\w.+-]*\.[A-Za-z0-9]{1,10})\b/g)) checksums.set(m[2], m[1].toLowerCase());
  };

  const enqueue = (raw, base, kind, depth, tag) => {
    const abs = res(raw, base);
    if (!abs) return;
    if (kind === 'page' && isDownloadLink(abs)) {
      // Don't crawl it as a page; list it as a file the user can download.
      if (!foundFiles.has(abs)) foundFiles.set(abs, { url: abs, name: filenameFrom('', abs), page: base });
      return;
    }
    if (seen.has(abs)) return;
    // "Find files" mode only needs the page itself plus the bits that load into it (like GitHub's asset list).
    if (scanOnly && kind === 'asset' && tag !== 'include-fragment') return;
    const internal = isInternal(new URL(abs));
    if (kind === 'page') {
      if (!internal || depth > maxDepth || pagesScheduled >= maxPages) return;
      pagesScheduled++;
    } else if (!internal && !external) return;
    if (seen.size >= LIMITS.maxFiles) return;
    seen.add(abs);
    queue.push({ url: abs, kind, depth });
  };

  async function processItem(item) {
    try {
      let rec;
      if (item.url === root.href && firstRec) { rec = firstRec; firstRec = null; }
      else rec = await fetchLogical(item.url);
      if (job.cancelled) return;
      if (wb) rec.finalUrl = res(rec.finalUrl, rec.finalUrl) || item.url;
      totalBytes += rec.body.length;
      if (totalBytes > LIMITS.maxTotalBytes) { job.truncated = true; return; }
      rec.url = item.url;
      // Same final URL, or an identical HTML page (e.g. "/" vs "/index.html"): reuse the existing copy.
      const dupe = records.get(rec.finalUrl) ||
        (isHtmlType(rec.type) && pageHashes.get(crypto.createHash('sha1').update(rec.body).digest('hex')));
      if (dupe) { records.set(item.url, dupe); return; }
      if (isHtmlType(rec.type)) pageHashes.set(crypto.createHash('sha1').update(rec.body).digest('hex'), rec);
      records.set(item.url, rec);
      if (rec.finalUrl !== item.url) { records.set(rec.finalUrl, rec); seen.add(rec.finalUrl); }
      if (isHtmlType(rec.type)) {
        pageCount++;
        job.pages = pageCount;
        log('page  ' + rec.finalUrl);
        const text = rec.body.toString('utf8');
        collectChecksums(text);
        walkHtml(text, (raw, kind, tag) => { enqueue(raw, rec.finalUrl, kind, item.depth + 1, tag); });
      } else {
        log('file  ' + rec.finalUrl);
        if (isCssType(rec.type)) walkCss(rec.body.toString('utf8'), raw => { enqueue(raw, rec.finalUrl, 'asset', item.depth); });
      }
      job.files = new Set(records.values()).size;
      job.bytes = totalBytes;
    } catch (e) {
      job.failed++;
      log('skip  ' + item.url + '  (' + e.message + ')');
    }
  }

  await new Promise(done => {
    const pump = () => {
      if (job.cancelled) { if (active === 0) done(); return; }
      while (active < concurrency && queue.length) {
        // pages first so the page budget is spent breadth-first
        const idx = queue.findIndex(q => q.kind === 'page');
        const item = queue.splice(idx >= 0 ? idx : 0, 1)[0];
        active++;
        processItem(item).finally(() => { active--; pump(); });
      }
      if (active === 0 && queue.length === 0) done();
    };
    pump();
  });
  if (job.cancelled) throw new Error('Cancelled');

  // Downloadable files the pages link to, with any checksum the pages publish for them.
  job.foundFiles = [...foundFiles.values()].map(f => ({ ...f, sha256: checksums.get(f.name) || null }));
  log(`Found ${job.foundFiles.length} downloadable file(s) linked on the page(s)`);
  if (scanOnly) return;

  // Optionally download those files too (using the full recovery: live -> archive -> GitHub copies).
  const bundled = new Map();   // file url -> local path in the ZIP
  const bundledFiles = [];
  if (bundleFiles && job.foundFiles.length) {
    job.status = 'downloading files';
    let bundledBytes = 0;
    const usedNames = new Set();
    for (const f of job.foundFiles.slice(0, LIMITS.maxBundleFiles)) {
      if (job.cancelled) break;
      log('get   ' + f.name + ' ...');
      const sub = { opts: { startUrl: f.url, source: 'auto', expectSha: f.sha256 }, bytes: 0, get cancelled() { return job.cancelled; } };
      try {
        await grabFile(sub, { log: m => log('      ' + m), assertPublicHost, parseWayback, fetchWithRetry });
        if (bundledBytes + sub.size > LIMITS.maxBundleBytes) {
          log(`      left out: the ZIP would pass ${LIMITS.maxBundleBytes / 1048576} MB of bundled files`);
          f.status = 'too big to bundle';
        } else {
          let name = 'downloads/' + sub.fileName, n = 1;
          while (usedNames.has(name.toLowerCase())) name = `downloads/${n++}-${sub.fileName}`;
          usedNames.add(name.toLowerCase());
          bundledFiles.push({ name, data: fs.readFileSync(sub.filePath) });
          bundled.set(f.url, name);
          bundledBytes += sub.size;
          Object.assign(f, { status: 'included', local: name, note: sub.sourceNote, verified: sub.verified || null });
        }
      } catch (e) {
        log('      could not get it: ' + e.message);
        Object.assign(f, { status: 'not found', error: e.message, alternatives: sub.alternatives || [] });
      } finally {
        if (sub.filePath) fs.rm(sub.filePath, { force: true }, () => {});
      }
    }
  }

  // Assign local paths
  job.status = 'packaging';
  const assign = makePathAssigner(isInternal);
  for (const name of bundled.values()) assign.reserve(name);
  const unique = [...new Set(records.values())];
  // The page you pasted is always the top-level index.html, even when it's deep in the site
  // (otherwise the site's homepage would take that spot).
  const startPage = records.get(root.href);
  if (startPage && isHtmlType(startPage.type)) { assign.reserve('index.html'); startPage.local = 'index.html'; }
  for (const rec of unique) if (!rec.local) rec.local = assign(rec);
  const lookup = abs => { const r = abs && records.get(abs); return r ? r.local : (bundled.get(abs) || null); };

  // Rewrite references to local paths, relative to `fromLocal` (the file the reference will live in).
  const makeRewrite = (baseUrl, fromLocal) => raw => {
    const hashIdx = raw.indexOf('#');
    const hash = hashIdx >= 0 ? raw.slice(hashIdx) : '';
    const abs = res(raw, baseUrl);
    if (!abs) return undefined;
    const local = lookup(abs);
    if (local) {
      const rel = path.posix.relative(path.posix.dirname(fromLocal), local);
      return encodeURI(rel || path.posix.basename(local)) + hash;
    }
    // Not downloaded: point at the live site, or at the archive when rebuilding a snapshot.
    return (wb ? 'https://web.archive.org/web/' + wb.ts + '/' + abs : abs) + hash;
  };
  // Parts some sites load with JavaScript after the page opens (e.g. GitHub's release "Assets" list,
  // an <include-fragment>). Put them straight into the page so they show without JavaScript.
  const inlineFragments = (html, rec) => {
    const parts = [];
    html = html.replace(/<include-fragment\b([^>]*)>[\s\S]*?<\/include-fragment>/gi, (m, attrs) => {
      const src = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const abs = src && res(src[1] ?? src[2], rec.finalUrl);
      const frag = abs && records.get(abs);
      if (!frag || !isHtmlType(frag.type) || frag === rec) return m;
      let body = frag.body.toString('utf8');
      const inBody = body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
      if (inBody) body = inBody[1];
      parts.push(walkHtml(body, makeRewrite(frag.finalUrl, rec.local)));
      return `<!--sitesnag-fragment-${parts.length - 1}-->`;
    });
    return { html, parts };
  };

  const files = [];
  for (const rec of unique) {
    let data = rec.body;
    if (isHtmlType(rec.type)) {
      const { html, parts } = inlineFragments(rec.body.toString('utf8'), rec);
      const out = walkHtml(html, makeRewrite(rec.finalUrl, rec.local))
        .replace(/<!--sitesnag-fragment-(\d+)-->/g, (m, i) => parts[Number(i)]);
      data = Buffer.from(out, 'utf8');
    } else if (isCssType(rec.type)) data = Buffer.from(walkCss(rec.body.toString('utf8'), makeRewrite(rec.finalUrl, rec.local)), 'utf8');
    files.push({ name: rec.local, data });
  }
  files.push(...bundledFiles);
  if (!files.length) throw new Error('Nothing could be downloaded from that URL');
  // If the start page redirected somewhere else (e.g. "/" -> "/ui/"), add a top-level index.html that forwards to it.
  const startRec = records.get(root.href);
  if (startRec && !files.some(f => f.name.toLowerCase() === 'index.html')) {
    const target = encodeURI(startRec.local);
    files.unshift({ name: 'index.html', data: Buffer.from(
      `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><a href="${target}">Open the site</a>`) });
  }
  // Include a tiny viewer: some sites only fully work when served over http, not opened from disk.
  const taken = new Set(files.map(f => f.name.toLowerCase()));
  const extras = [
    ['serve.js', VIEWER_JS],
    ['Open site.bat', Buffer.from('@echo off\r\ncd /d "%~dp0"\r\nnode serve.js\r\nif errorlevel 1 (\r\n  echo This needs Node.js from https://nodejs.org  - or just open index.html directly.\r\n  pause\r\n)\r\n')],
    ['HOW-TO-OPEN.txt', Buffer.from(
      'Quick look: open index.html in your browser.\r\n\r\n' +
      'If the page looks broken or parts are missing (common with big sites like GitHub), open it through the\r\n' +
      'included viewer instead, which makes the site\'s JavaScript work:\r\n' +
      '  Windows: double-click "Open site.bat"\r\n' +
      '  Mac/Linux: run  node serve.js  in this folder\r\n' +
      'The viewer needs Node.js (https://nodejs.org). It only serves files from this folder, on your own computer.\r\n')],
  ];
  for (const [name, data] of extras) if (!taken.has(name.toLowerCase())) files.push({ name, data });
  job.zip = buildZip(files);
  // e.g. "github.com-rakanki911-DLSS5-Swapper-releases-tag-v2.2.3-wayback-20261011081354.zip"
  const slug = root.pathname.split('/').filter(Boolean).join('-').replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  job.zipName = (root.hostname + (slug ? '-' + slug : '')).replace(/[^a-z0-9._-]/gi, '_') + (wb ? '-wayback-' + wb.ts : '') + '.zip';
  job.files = files.length;
}

// ---------------------------------------------------------------- HTTP server
const jobs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.created > LIMITS.jobTtlMs) {
    if (j.filePath) fs.rm(j.filePath, { force: true }, () => {});
    jobs.delete(id);
  }
}, 60000).unref();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}

const PUBLIC = path.join(__dirname, 'public');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = JSON.parse(await readBody(req) || '{}');
      let target = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
      let parsed;
      try { parsed = new URL(target); } catch { return sendJson(res, 400, { error: 'That doesn’t look like a valid URL.' }); }
      const opts = {
        startUrl: parsed.href,
        maxPages: Math.min(Math.max(parseInt(body.maxPages) || 1, 1), LIMITS.maxPagesCap),
        maxDepth: Math.min(Math.max(parseInt(body.maxDepth) || 0, 0), 10),
        external: body.external !== false,
        source: ['auto', 'live', 'wayback'].includes(body.source) ? body.source : 'auto',
        bundleFiles: body.bundle === true,
        expectSha: /^[a-f0-9]{64}$/i.test(body.expectSha || '') ? body.expectSha : null,
      };
      const kind = body.kind === 'scan' ? 'scan'
        : body.kind === 'file' || (body.kind !== 'site' && looksLikeFile(parseWayback(parsed.href)?.url || parsed.href)) ? 'file' : 'site';
      // "Find files on this page": just the page itself (plus parts it loads in), list its download links.
      if (kind === 'scan') Object.assign(opts, { scanOnly: true, maxPages: 1, maxDepth: 0, bundleFiles: false });
      const id = crypto.randomUUID();
      const job = { id, kind, opts, status: 'crawling', pages: 0, files: 0, bytes: 0, failed: 0, log: [], created: Date.now() };
      jobs.set(id, job);
      const log = msg => { job.log.push(msg); if (job.log.length > 300) job.log.shift(); };
      const run = kind === 'file'
        ? grabFile(job, { log, assertPublicHost, parseWayback, fetchWithRetry })
        : crawl(job);
      run.then(() => { job.status = 'done'; },
        e => { job.status = e.notFound ? 'not_found' : 'error'; job.error = e.message; });
      return sendJson(res, 200, { id, kind });
    }
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)(\/zip|\/download|\/cancel)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found or expired' });
      if ((m[2] === '/download' || m[2] === '/zip') && job.filePath) {
        if (job.status !== 'done') return sendJson(res, 409, { error: 'Not ready' });
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': job.size,
          'content-disposition': `attachment; filename="${job.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(job.fileName)}`,
        });
        return fs.createReadStream(job.filePath).pipe(res);
      }
      if (m[2] === '/download' || m[2] === '/zip') {
        if (job.status !== 'done') return sendJson(res, 409, { error: 'Not ready' });
        if (!job.zip) return sendJson(res, 404, { error: 'This job has nothing to download' });
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': job.zip.length,
          'content-disposition': `attachment; filename="${job.zipName}"`,
        });
        return res.end(job.zip);
      }
      if (m[2] === '/cancel' && req.method === 'POST') { job.cancelled = true; return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 200, {
        status: job.status, pages: job.pages, files: job.files, bytes: job.bytes, failed: job.failed,
        kind: job.kind, total: job.total || 0, fileName: job.fileName, size: job.size, sha256: job.sha256,
        source: job.source, sourceNote: job.sourceNote, verified: job.verified, alternatives: job.alternatives || [], target: job.target,
        foundFiles: job.foundFiles || [], expectSha: job.opts.expectSha || null,
        snapshot: job.snapshot || null, error: job.error, truncated: !!job.truncated, zipSize: job.zip ? job.zip.length : 0, log: job.log.slice(-40),
      });
    }
    // static files
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Not found');
    }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`SiteSnag running at http://localhost:${PORT}`));
