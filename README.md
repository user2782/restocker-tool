# Restock Counter

Self-hosted multi-store restock counting: phone counts, combined totals, pricing, manager adjustments, history and stats, backups, CSV export, item photos, printable catalogs. EN/中文.

Each store counts on a phone; managers combine the counts, set prices, adjust quantities and review reports. It runs on a Raspberry Pi (or any machine with Node.js) with **no database and no npm packages**: one `server.js`, one `public/index.html`, and JSON files for data.

**Live demo (runs entirely in your browser, sample data, manager PIN `1234`):**
set up GitHub Pages for this repo (Settings → Pages → *Deploy from a branch* → `main` / `/docs`)
and the demo is served from `docs/index.html`.

## What it does

**For store staff**
- Count screen per store with numbered items, search by name or number, half cases, and optional
  item photos (anyone can add one from their phone's camera)
- Printable catalog (3 columns × 50 rows per side, with a box to write each quantity) as a PDF
- English / 中文, light / dark mode, installable on a phone's home screen

**For managers (PIN-protected)**
- Combined totals, by person, and by store views with costs
- Change any store's quantity for an item from one popup, without opening each store
- Set cost per case for the whole catalog (searchable)
- Setup editor with duplicate protection, renames that carry through counts and prices,
  and a change log you can restore from
- History of every cleared cycle, with all-time and per-store statistics for any period
- One-file backup and restore (items, counts, history, photos), and a full CSV export for records

## Run it

```bash
node server.js                       # http://localhost:3000
PORT=8080 DATA_DIR=/var/restock ADMIN_PIN=4321 node server.js
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | port to listen on |
| `DATA_DIR` | `./data` | where `db.json`, saved cycles, photos and logs are kept |
| `ADMIN_PIN` | *(none)* | protects the manager area; unset means no PIN |

Requires Node.js 18 or newer. Open the page on a phone on the same network.

## Docs

- [User guide](docs/USER-GUIDE.md): every feature, screen by screen
- [Raspberry Pi setup](docs/SETUP-PI.md): hardware, install, running as a service, backups

## Notes

- Data is plain JSON files under `DATA_DIR`; back up that folder, or use the in-app backup.
- Older data folders are read as they are; newer files (setup log, photos, backups) are ignored
  by older versions.
- The Manager PIN is a simple shared PIN meant for a trusted local network, not a
  replacement for real authentication on the public internet.

## License

MIT, see [LICENSE](LICENSE).
