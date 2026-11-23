// Single-file downloads with recovery: live link -> Wayback Machine -> GitHub release lookup / mirrors.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { once } = require('node:events');

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const TMP = path.join(os.tmpdir(), 'sitesnag');
fs.mkdirSync(TMP, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 SiteSnag/1.0';

const FILE_EXT = /\.(exe|msi|msix|appx|zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|pkg|deb|rpm|apk|aab|ipa|appimage|iso|img|bin|jar|dll|so|dylib|pdf|epub|docx?|xlsx?|pptx?|csv|json|xml|txt|md|mp4|mkv|mov|avi|webm|mp3|wav|flac|ogg|m4a|png|jpe?g|gif|webp|svg|ttf|otf|woff2?|rbxm|rbxl|rbxmx|unitypackage|nupkg|whl|vsix|crx|xpi|sha256|sig|asc)$/i;

// Does this URL point at a single file rather than a web page?
function looksLikeFile(u) {
  const url = new URL(u);
  const h = url.hostname.toLowerCase();
  if (/(^|\.)(raw\.githubusercontent\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|codeload\.github\.com)$/.test(h)) return true;
  if (h === 'github.com' && /\/(releases\/(latest\/)?download|archive|raw)\//.test(url.pathname)) return true;
  return FILE_EXT.test(url.pathname);
}

// "https://github.com/o/r/releases/download/tag/name" -> { owner, repo, tag, name }
function parseGithubRelease(u) {
  const url = new URL(u);
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  let m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2], tag: decodeURIComponent(m[3]), name: decodeURIComponent(m[4]) };
  m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/latest\/download\/([^/]+)$/);
  if (m) return { owner: m[1], repo: m[2], tag: null, name: decodeURIComponent(m[3]) };
  return null;
}

function filenameFrom(disposition, url) {
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition || '');
  let name = m ? decodeURIComponent(m[1] || m[2]) : decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'download';
}

// Stream a URL to disk, checking every redirect hop against private addresses.
async function streamToFile(url, job, { assertPublicHost, expectBinary }) {
  let current = url;
  for (let hop = 0; hop < 8; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Unsupported protocol');
    await assertPublicHost(u.hostname);
    const res = await fetch(current, {
      redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) { res.body?.cancel(); throw new Error('HTTP ' + res.status); }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    // A web page where a file was expected is usually an error/login page, not the file.
    if (expectBinary && type.includes('text/html')) { res.body?.cancel(); throw new Error('Got a web page instead of the file'); }
    const total = Number(res.headers.get('content-length') || 0);
    if (total > MAX_FILE_BYTES) { res.body?.cancel(); throw new Error('File is larger than 4 GB'); }
    const dest = path.join(TMP, crypto.randomUUID());
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    job.bytes = 0; job.total = total;
    try {
      for await (const chunk of res.body) {
        if (job.cancelled) throw new Error('Cancelled');
        job.bytes += chunk.length;
        if (job.bytes > MAX_FILE_BYTES) throw new Error('File is larger than 4 GB');
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end(); await once(out, 'finish');
    } catch (e) {
      out.destroy(); fs.rm(dest, { force: true }, () => {});
      throw e;
    }
    if (job.bytes === 0) { fs.rm(dest, { force: true }, () => {}); throw new Error('Empty response'); }
    if (total && job.bytes < total) { fs.rm(dest, { force: true }, () => {}); throw new Error(`Incomplete (${job.bytes} of ${total} bytes)`); }
    return { path: dest, finalUrl: current, type, size: job.bytes, sha256: hash.digest('hex'),
      name: filenameFrom(res.headers.get('content-disposition'), current) };
  }
  throw new Error('Too many redirects');
}

async function ghApi(p) {
  const headers = { 'user-agent': 'SiteSnag', accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const res = await fetch('https://api.github.com' + p, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error('GitHub API rate limit reached (set GITHUB_TOKEN to raise it)');
  if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
  return res.json();
}

// How alike two file names are (0..1), ignoring version numbers.
function similarity(a, b) {
  const tok = s => new Set(s.toLowerCase().replace(/\d+/g, ' ').split(/[^a-z]+/).filter(t => t.length > 1));
  const A = tok(a), B = tok(b);
  const inter = [...A].filter(t => B.has(t)).length;
  const ext = path.extname(a).toLowerCase() === path.extname(b).toLowerCase() ? 0.3 : 0;
  return inter / Math.max(1, new Set([...A, ...B]).size) + ext;
}

const day = ts => ts.length >= 8 ? ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8) : ts;
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

// Look the file up through the GitHub API: renamed repos, other releases, similar names, and copies in other repos.
async function githubLookup(gh, log, expectSha) {
  const alts = [];
  const add = (a, reason, repoName, release, mirror) => {
    if (alts.some(x => x.url === a.browser_download_url)) return;
    // A copy whose GitHub checksum equals the one published on the original page is byte-identical to the original.
    const match = !!(expectSha && a.digest === 'sha256:' + expectSha);
    alts.push({ url: a.browser_download_url, name: a.name, size: fmtSize(a.size), repo: repoName,
      release: release.tag_name, date: (release.published_at || '').slice(0, 10), reason, mirror: !!mirror, match,
      digest: a.digest ? a.digest.replace('sha256:', '') : null });
  };
  const repo = await ghApi(`/repos/${gh.owner}/${gh.repo}`);
  if (repo) {
    const full = repo.full_name;
    if (full.toLowerCase() !== `${gh.owner}/${gh.repo}`.toLowerCase()) log(`Repo was renamed/moved to ${full}`);
    const releases = (await ghApi(`/repos/${full}/releases?per_page=100`)) || [];
    const rel = gh.tag ? releases.find(r => r.tag_name === gh.tag) : releases.find(r => !r.draft && !r.prerelease);
    const exact = rel && rel.assets.find(a => a.name === gh.name);
    if (exact) return { exact: exact.browser_download_url, alts };
    if (gh.tag && !rel) log(`Release "${gh.tag}" no longer exists in ${full}`);
    else if (rel) log(`Release ${rel.tag_name} exists but has no file named ${gh.name}`);
    // Same release, similar names (e.g. the project renamed its installer)
    if (rel) rel.assets.map(a => [similarity(gh.name, a.name), a]).filter(([s]) => s >= 0.3)
      .sort((x, y) => y[0] - x[0]).slice(0, 3)
      .forEach(([, a]) => add(a, `Similar file in the same release (${rel.tag_name})`, full, rel));
    // Other releases that still have the exact file name, newest first
    releases.filter(r => r !== rel).forEach(r => r.assets.filter(a => a.name === gh.name)
      .forEach(a => add(a, `Same file name in an older/newer release`, full, r)));
    return { exact: null, alts: alts.slice(0, 8) };
  }
  // Repo is gone: look for copies (forks/mirrors/re-uploads) that kept the same release file.
  log(`Repo ${gh.owner}/${gh.repo} is deleted or private - searching GitHub for copies`);
  const search = await ghApi(`/search/repositories?q=${encodeURIComponent(gh.repo + ' in:name fork:true')}&per_page=30`);
  const want = gh.repo.toLowerCase();
  const cands = ((search && search.items) || [])
    .filter(c => c.name.toLowerCase().includes(want) && c.full_name.toLowerCase() !== `${gh.owner}/${gh.repo}`.toLowerCase())
    .sort((a, b) => (b.name.toLowerCase() === want) - (a.name.toLowerCase() === want)) // exact name first
    .slice(0, 12);
  let checked = 0;
  for (const cand of cands) {
    if (!cand.has_downloads && cand.size === 0) continue;
    const releases = (await ghApi(`/repos/${cand.full_name}/releases?per_page=100`)) || [];
    checked++;
    for (const r of releases) for (const a of r.assets) {
      if (a.name === gh.name || (expectSha && a.digest === 'sha256:' + expectSha)) {
        add(a, (r.tag_name === gh.tag ? 'Same file and release' : 'Same file name') + ' in a copy of the repo', cand.full_name, r, true);
      }
    }
  }
  log(`Checked ${checked} possible copies of the repo; ${alts.length} had this file`);
  return { exact: null, alts: alts.slice(0, 8) };
}

// Every distinct saved copy of a file link in the Wayback Machine, newest first.
// Copies with identical contents (same digest) are tried once, with a couple of spares in case the archive errors.
const MAX_CAPTURE_GROUPS = 150;
async function listCaptures(url, gh, h, log) {
  const variants = [{ url, label: 'this link' }];
  if (gh && gh.tag) {
    variants.push({ url: `https://github.com/${gh.owner}/${gh.repo}/releases/latest/download/${encodeURIComponent(gh.name)}`,
      label: 'the repo’s "latest release" link' });
  }
  const groups = new Map();
  for (const v of variants) {
    let rows = [];
    try {
      const cdx = 'https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,statuscode,digest&limit=-5000&url=' + encodeURIComponent(v.url);
      const r = await h.fetchWithRetry(cdx);
      rows = JSON.parse(r.body.toString('utf8') || '[]').slice(1);
    } catch (e) { log(`Archive lookup failed for ${v.label} (${e.message})`); continue; }
    for (const [ts, status, digest] of rows) {
      if (/^[45]/.test(status)) continue; // saved error pages are never the file
      const key = v.url + ' ' + digest;
      if (!groups.has(key)) groups.set(key, { url: v.url, label: v.label, stamps: [] });
      groups.get(key).stamps.push(ts);
    }
  }
  const list = [...groups.values()].map(g => {
    g.stamps.sort().reverse();
    return { url: g.url, label: g.label, ts: g.stamps[0], spare: g.stamps.slice(1, 3) };
  });
  // Newest first; the exact link before the "latest release" variant on ties.
  list.sort((a, b) => (b.ts.localeCompare(a.ts)) || (a.url === url ? -1 : 1));
  if (list.length > MAX_CAPTURE_GROUPS) log(`Checking the newest ${MAX_CAPTURE_GROUPS} of ${list.length} saved versions`);
  return list.slice(0, MAX_CAPTURE_GROUPS);
}

async function grabFile(job, h) {
  const { log } = h;
  let url = job.opts.startUrl;
  let pinnedTs = null;
  const pasted = h.parseWayback(url);
  if (pasted) { url = pasted.url; pinnedTs = pasted.ts; }
  job.target = url;
  const expectBinary = !/\.(html?|php|aspx?)$/i.test(new URL(url).pathname);
  const gh = parseGithubRelease(url);
  // SHA-256 published for this file on the page it was linked from (if any).
  const expectSha = /^[a-f0-9]{64}$/i.test(job.opts.expectSha || '') ? job.opts.expectSha.toLowerCase() : null;
  const finish = async (got, source, note) => {
    Object.assign(job, { filePath: got.path, fileName: got.name, size: got.size, sha256: got.sha256, source, sourceNote: note });
    log(`Saved ${got.name} (${fmtSize(got.size)}) from ${source}`);
    if (expectSha) {
      job.verified = got.sha256 === expectSha
        ? 'Matches the SHA-256 checksum published on the original page'
        : 'Does NOT match the SHA-256 checksum published on the original page - this is not the original file';
      log('Checksum: ' + job.verified);
      return;
    }
    if (gh) {
      // Check the bytes against GitHub's own checksums, so you know exactly which release file this is.
      try {
        const repo = await ghApi(`/repos/${gh.owner}/${gh.repo}`);
        const releases = repo ? (await ghApi(`/repos/${repo.full_name}/releases?per_page=100`)) || [] : [];
        for (const r of releases) for (const a of r.assets) {
          if (a.digest === 'sha256:' + got.sha256) {
            job.verified = `Identical to ${a.name} in ${repo.full_name} release ${r.tag_name}` +
              (r.tag_name !== gh.tag || a.name !== gh.name ? ' (not the release/file the link names)' : '');
            log('Checksum: ' + job.verified);
            return;
          }
        }
        if (releases.length) { job.verified = 'No matching file in the repo’s current releases'; log('Checksum: ' + job.verified); }
      } catch (e) { log(`Checksum check skipped (${e.message})`); }
    }
  };

  // 1. The live link
  if (!pinnedTs && job.opts.source !== 'wayback') {
    job.status = 'downloading';
    log('Trying the live link ...');
    try { return await finish(await streamToFile(url, job, { ...h, expectBinary }), 'live', 'Downloaded from the original link.'); }
    catch (e) { log(`Live link failed (${e.message})`); if (e.message === 'Cancelled') throw e; }
    if (job.opts.source === 'live') throw new Error('The live link did not work.');
  }

  // 2. The Wayback Machine: try every saved copy, newest first, until one is a complete, real file.
  job.status = 'searching archive';
  log('Searching the Internet Archive for every saved copy ...');
  const captures = pinnedTs ? [{ ts: pinnedTs, url, digests: null }] : await listCaptures(url, gh, h, log);
  if (!captures.length) log('The archive has no saved copy of this link');
  else if (!pinnedTs) log(`Found ${captures.length} different saved version${captures.length === 1 ? '' : 's'} - checking each one`);
  let mismatch = null; // a complete file that failed the checksum, kept as a last resort
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i];
    if (job.cancelled) throw new Error('Cancelled');
    job.archiveProgress = { tried: i + 1, of: captures.length };
    log(`Snapshot ${i + 1}/${captures.length}: ${c.ts.length >= 8 ? day(c.ts) : 'closest to ' + c.ts}${c.url !== url ? ' (via ' + c.label + ')' : ''} ...`);
    let got = null;
    // Captures with the same contents are only re-tried when the archive itself failed (not when the file was bad).
    for (const ts of [c.ts, ...(c.spare || [])]) {
      try { got = await streamToFile('https://web.archive.org/web/' + ts + 'id_/' + c.url, job, { ...h, expectBinary }); break; }
      catch (e) {
        if (e.message === 'Cancelled') throw e;
        log(`  failed (${e.message})`);
        if (!/^(HTTP 5\d\d|HTTP 429|fetch failed|.*timeout.*|.*aborted.*|terminated)/i.test(e.message)) break;
      }
    }
    if (!got) continue;
    if (got.name === 'download' || /^\d+$/.test(got.name)) got.name = filenameFrom('', url);
    if (expectSha && got.sha256 !== expectSha) {
      log('  downloaded, but its checksum does not match the original page - trying older copies');
      if (!mismatch) mismatch = { got, ts: c.ts };
      else fs.rm(got.path, { force: true }, () => {});
      continue;
    }
    if (mismatch) fs.rm(mismatch.got.path, { force: true }, () => {});
    const real = (h.parseWayback(got.finalUrl) || {}).ts || c.ts;
    return await finish(got, 'wayback', `Recovered from the Internet Archive copy saved ${day(real)}` +
      (captures.length > 1 ? ` (snapshot ${i + 1} of ${captures.length} checked).` : '.'));
  }
  if (mismatch) {
    const real = (h.parseWayback(mismatch.got.finalUrl) || {}).ts || mismatch.ts;
    log('No saved copy matched the checksum; keeping the newest complete one');
    return await finish(mismatch.got, 'wayback', `Recovered from the Internet Archive copy saved ${day(real)}.`);
  }

  // 3. GitHub release lookup

  if (gh) {
    job.status = 'searching github';
    log('Checking GitHub for the release ...');
    const found = await githubLookup(gh, log, expectSha);
    if (found.exact && found.exact !== url) {
      log('Found it under the new location');
      return await finish(await streamToFile(found.exact, job, { ...h, expectBinary }), 'github', 'Found at the repo’s new location on GitHub.');
    }
    // A copy in someone else's repo is used automatically only when it's provably byte-identical.
    const same = found.alts.find(a => a.match);
    if (same) {
      log(`${same.repo} has a byte-identical copy (checksum matches the original page)`);
      return await finish(await streamToFile(same.url, job, { ...h, expectBinary }), 'github-copy',
        `From ${same.repo} (release ${same.release}), a copy of the deleted repo. Its checksum matches the one on the original page, so it is the original file.`);
    }
    if (found.alts.length) {
      job.alternatives = found.alts;
      throw Object.assign(new Error('That exact file is gone, but similar files were found.'), { notFound: true });
    }
  }
  throw Object.assign(new Error('Could not find this file live, in the Internet Archive, or on GitHub.'), { notFound: true });
}

// A link a person would click to download something (installers, archives, documents...), not a page asset.
const NOT_DOWNLOAD = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|woff2?|ttf|otf|webmanifest|html?|php|aspx?)$/i;
function isDownloadLink(u) {
  try { return looksLikeFile(u) && !NOT_DOWNLOAD.test(new URL(u).pathname); } catch { return false; }
}

module.exports = { grabFile, looksLikeFile, isDownloadLink, filenameFrom };
