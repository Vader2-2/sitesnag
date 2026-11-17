# SiteSnag — free website & file downloader

Paste a website and get it as a ZIP that works offline, or paste a file link (even a deleted one) and SiteSnag
digs it up from the live site, the Internet Archive's Wayback Machine, or GitHub.

- Websites: HTML, CSS, JS, images and fonts, with links rewritten so the copy works offline. Each ZIP includes
  `Open site.bat` / `serve.js`, a tiny viewer for JavaScript-heavy sites that don't work when opened from disk
- Dead or changed sites: rebuilds from the newest Wayback Machine snapshot that actually loads
- Files: live link → Internet Archive → GitHub release lookup, with suggestions when the exact file is gone
- GitHub downloads are checked against GitHub's own SHA-256 checksums
- No signup, no limits, no dependencies — just Node.js

**If the website is ever down, you can run SiteSnag yourself — see option 1.**

---

## 1. Run it on your own computer (anyone can do this)

1. Install **Node.js 22 or newer** (LTS) from https://nodejs.org
2. Download this project: on GitHub click **Code → Download ZIP** (or grab `sitesnag.zip` from **Releases**), then unzip it.
3. Start it:
   - **Windows:** double-click `start-windows.bat`
   - **Mac / Linux:** run `sh start-mac-linux.sh` in a terminal
4. Open http://localhost:3000

Or from a terminal in the folder: `node server.js`

## 2. Share it from your own PC (free public link, no account)

Gives your running PC a public `https://….trycloudflare.com` address using a Cloudflare Quick Tunnel.

1. One-time setup: `winget install --id Cloudflare.cloudflared`
2. Double-click `share-from-my-pc.bat`
3. Copy the `https://….trycloudflare.com` address it prints and share it.

The link only works while that window is open and the PC is on, and you get a new random address each time.

## 3. Host it online 24/7 on Render (free)

1. Put this folder in a GitHub repository.
2. Sign in at https://render.com with GitHub.
3. Click **New → Blueprint**, choose the repository, and click **Apply**. `render.yaml` fills in all the settings.
4. Your site will be at `https://sitesnag-xxxx.onrender.com`.

Free-plan notes: the service sleeps after 15 minutes without visitors (the next visit takes ~30–60 seconds to
wake it), and has 512 MB of memory, so very large website crawls may fail there. Optionally add a
`GITHUB_TOKEN` environment variable in Render to raise GitHub lookups from 60 to 5,000 per hour.

---

## Settings

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `GITHUB_TOKEN` | none | Raises the GitHub API limit for file recovery |

Built-in limits: 500 pages per site, 25 MB per page asset, 300 MB per site ZIP, 4 GB per single file.
Private and local network addresses are blocked.

## Please use responsibly

Only download sites and files you have the right to copy, and respect copyright and each site's terms.
Files recovered from other people's copies of a repository are marked as such — only run them if you trust them.
