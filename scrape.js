#!/usr/bin/env bun
// Scrapes innroad booking engine and outputs a self-contained index.html
// Usage: bun scrape.js
// Opens Chrome — click the Cloudflare Turnstile checkbox when prompted

import { chromium } from "playwright-core";

const SEASON_START = "2026-05-11";
const SEASON_END = "2026-10-19";
const API = "https://be-booking-engine-api.innroad.com";
const GRID = "https://bobscabinsonlakesuperior.client.innroad.com/grid/";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable";

// --- Scrape ---

const browser = await chromium.launch({
  headless: false,
  executablePath: CHROME,
  args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
});
const page = await browser.newPage();
let token = null;
let authed = false;

page.on("response", (r) => {
  const h = r.headers()["vnd-innroad-booking-engine-session"];
  if (h) token = h;
  if (r.url().includes(API) && r.status() === 200 && !r.url().includes("session/status"))
    authed = true;
});

await page.goto(GRID, { waitUntil: "load", timeout: 30000 });
console.log("Click the Turnstile checkbox in the browser...");

for (let i = 0; i < 48 && !authed; i++) await page.waitForTimeout(2500);
if (!authed || !token) { console.error("Auth failed"); await browser.close(); process.exit(1); }
console.log("Authenticated");

// Build month chunks
const chunks = [];
for (let d = new Date(`${SEASON_START}T12:00:00`), last = new Date(`${SEASON_END}T12:00:00`); d <= last; ) {
  const start = d.toISOString().slice(0, 10);
  const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  chunks.push([start, monthEnd > last ? SEASON_END : monthEnd.toISOString().slice(0, 10)]);
  d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

// Fetch all months in parallel
const raw = await page.evaluate(
  async ({ t, chunks, api }) =>
    Promise.all(chunks.map(([s, e]) =>
      fetch(`${api}/availability?startDate=${s}&endDate=${e}`, {
        headers: { "Accept-Language": "en-US", "vnd-innroad-booking-engine-session": t },
      }).then(async (r) => ({ ok: r.status === 200, data: await r.text(), range: `${s} → ${e}` }))
    )),
  { t: token, chunks, api: API }
);
await browser.close();

const allData = [];
for (const r of raw) {
  if (r.ok) { allData.push(JSON.parse(r.data)); console.log(`  ${r.range} ✓`); }
  else console.error(`  ${r.range} FAILED`);
}

await Bun.write("data/raw.json", JSON.stringify(allData, null, 2));
console.log("Wrote data/raw.json — inspect for min-stay fields");

// --- Find gaps ---

const cabins = {};
const meta = {};
for (const month of allData) {
  for (const c of month) {
    cabins[c.name] ??= {};
    meta[c.name] ??= { id: c.id, picture: c.picture ?? "", maxPersons: c.maxPersons ?? 0 };
    for (const r of c.rates) {
      const minRule = r.rules?.find(x => x.ruleTypeId === 1);
      cabins[c.name][r.effectiveDate.slice(0, 10)] = {
        avail: r.isRoomAvailable,
        rate: r.baseAfterTax.value,
        cur: r.baseAfterTax.currencyCode,
        minStay: minRule?.ruleValue ?? 1,
      };
    }
  }
}

const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const dayCount = (Math.round((new Date(`${SEASON_END}T12:00:00`) - new Date(`${SEASON_START}T12:00:00`)) / 864e5)) + 1;

const gaps = [];
for (const name of Object.keys(cabins).sort()) {
  const m = meta[name];
  let run = 0, runStart = "";
  for (let i = 0; i <= dayCount; i++) {
    const date = addDays(SEASON_START, i);
    const info = cabins[name][date];
    if (info?.avail) {
      if (!run) runStart = date;
      run++;
    } else {
      if (run >= 1 && run <= 3) {
        const totalRate = Array.from({ length: run }, (_, j) => cabins[name][addDays(runStart, j)]?.rate ?? 0).reduce((a, b) => a + b, 0);
        const minStay = cabins[name][runStart]?.minStay ?? 1;
        gaps.push({
          cabin: name, cabinId: m.id, picture: m.picture, maxGuests: m.maxPersons,
          checkIn: runStart, checkOut: addDays(runStart, run), nights: run,
          minStay, bookable: run >= minStay,
          nightlyRate: cabins[name][runStart]?.rate ?? 0, totalRate, currency: "USD",
          bookingUrl: `https://bobscabinsonlakesuperior.client.innroad.com/room/${m.id}?checkIn=${runStart}&checkOut=${addDays(runStart, run)}&adults=2&children=0`,
        });
      }
      run = 0;
    }
  }
}
gaps.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

const totalNights = gaps.reduce((s, g) => s + g.nights, 0);
const totalRevenue = gaps.reduce((s, g) => s + g.totalRate, 0);
console.log(`\n${gaps.length} gaps | ${totalNights} nights | $${totalRevenue.toLocaleString()} potential revenue`);

// --- Generate self-contained HTML ---

const DATA = JSON.stringify({ generated: new Date().toISOString(), seasonStart: SEASON_START, seasonEnd: SEASON_END, totalGaps: gaps.length, gaps });

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gap Nights — Bob's Cabins on Lake Superior</title>
<link rel="manifest" href="data:application/json,${encodeURIComponent(JSON.stringify({ name: "Gap Nights", short_name: "Gaps", start_url: ".", display: "standalone", background_color: "#FFFEF8", theme_color: "#296DA8" }))}">
<meta name="theme-color" content="#296DA8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --blue: #296DA8; --blue-light: #40AADC; --burgundy: #8D2C3B;
    --cream: #FFFEF8; --sand: #F5F0E8; --text: #2C3E50;
    --text-light: #6B7C8D; --green: #2D8A56; --border: #E0D8CC;
  }
  body { font-family: 'Inter', -apple-system, sans-serif; background: var(--cream); color: var(--text); line-height: 1.5; }

  header { background: linear-gradient(135deg, var(--blue) 0%, #1E4D7B 100%); color: white; padding: 2rem 1.5rem; text-align: center; }
  header h1 { font-weight: 300; font-size: 1.6rem; letter-spacing: 0.02em; }
  header h1 strong { font-weight: 600; }
  header .subtitle { font-size: 0.85rem; opacity: 0.8; margin-top: 0.3rem; }

  .stats { display: flex; justify-content: center; gap: 2rem; padding: 1.2rem 1.5rem; background: var(--sand); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat .num { font-size: 1.8rem; font-weight: 600; color: var(--blue); }
  .stat .num.done { color: var(--green); }
  .stat .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-light); }

  .progress-bar { height: 4px; background: var(--border); }
  .progress-bar .fill { height: 100%; background: var(--green); transition: width 0.3s ease; }

  .filters { display: flex; gap: 0.5rem; padding: 1rem 1.5rem; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 0.75rem; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 0.3rem; }

  .filter-btn {
    padding: 0.3rem 0.7rem; border: 1px solid var(--border); border-radius: 1rem;
    background: white; font-size: 0.8rem; cursor: pointer; color: var(--text); transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--blue-light); }
  .filter-btn.active { background: var(--blue); color: white; border-color: var(--blue); }

  .month-group { padding: 0 1.5rem; }
  .month-header {
    font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--blue); padding: 1.2rem 0 0.5rem; border-bottom: 2px solid var(--blue);
    margin-bottom: 0.5rem; position: sticky; top: 0; background: var(--cream); z-index: 10;
  }

  .gap-item {
    display: flex; align-items: center; gap: 0.8rem; padding: 0.7rem 0.5rem;
    border-bottom: 1px solid var(--border); transition: all 0.2s;
    border-left: 3px solid transparent; border-radius: 4px; margin: 0.2rem 0;
  }
  .gap-item.blocked { background: #FFF5F5; border-left-color: #E53E3E; box-shadow: inset 0 0 12px rgba(229, 62, 62, 0.06); }
  .gap-item.bookable { border-left-color: var(--green); background: #F7FFF7; }
  .gap-item:has(.gap-check.done) { opacity: 0.4; }
  .gap-item:has(.gap-check.done) .gap-details { text-decoration: line-through; }

  .gap-check {
    width: 22px; height: 22px; border: 2px solid var(--border); border-radius: 4px;
    cursor: pointer; flex-shrink: 0; display: flex; align-items: center;
    justify-content: center; transition: all 0.15s; background: white;
  }
  .gap-check:hover { border-color: var(--green); }
  .gap-check.done { background: var(--green); border-color: var(--green); }
  .gap-check.done::after { content: '\\2713'; color: white; font-size: 14px; font-weight: 600; }

  .gap-cabin-img { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }
  .gap-details { flex: 1; min-width: 0; }
  .gap-cabin-name { font-weight: 500; font-size: 0.9rem; }
  .gap-dates { font-size: 0.8rem; color: var(--text-light); }

  .gap-badge { padding: 0.2rem 0.6rem; border-radius: 1rem; font-size: 0.7rem; font-weight: 600; flex-shrink: 0; }
  .gap-badge.n1 { background: #FFF3E0; color: #E65100; }
  .gap-badge.n2 { background: #E8F5E9; color: #2E7D32; }
  .gap-badge.n3 { background: #E3F2FD; color: #1565C0; }

  .min-badge { padding: 0.35rem 0.7rem; border-radius: 1rem; font-size: 0.75rem; font-weight: 600; flex-shrink: 0; letter-spacing: 0.02em; }
  .min-badge.blocked { background: #FFCDD2; color: #B71C1C; border: 1px solid #EF9A9A; }
  .min-badge.ok { background: #C8E6C9; color: #1B5E20; border: 1px solid #A5D6A7; }

  .gap-rate { font-size: 0.8rem; color: var(--text-light); text-align: right; flex-shrink: 0; min-width: 60px; }
  .gap-rate strong { color: var(--text); }

  footer { text-align: center; padding: 2rem 1.5rem; font-size: 0.7rem; color: var(--text-light); }
  @media (max-width: 600px) { .gap-cabin-img { width: 40px; height: 40px; } .gap-rate { display: none; } }
</style>
</head>
<body>
<header>
  <h1><strong>Gap Nights</strong> — Bob's Cabins on Lake Superior</h1>
  <div class="subtitle">2026 Season: May 11 – Oct 19</div>
</header>
<div class="stats">
  <div class="stat"><div class="num" id="total">—</div><div class="label">Total Gaps</div></div>
  <div class="stat"><div class="num done" id="done">0</div><div class="label">Handled</div></div>
  <div class="stat"><div class="num" id="remaining">—</div><div class="label">Remaining</div></div>
</div>
<div class="progress-bar"><div class="fill" id="progress" style="width:0%"></div></div>
<div class="filters">
  <label>Nights:</label>
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="1">1-Night</button>
  <button class="filter-btn" data-filter="2">2-Night</button>
  <button class="filter-btn" data-filter="3">3-Night</button>
</div>
<div id="list"></div>
<footer>
  <div>Generated <span id="generated"></span></div>
  <div>Data from innroad booking engine</div>
</footer>
<script>
const DATA = ${DATA};
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const D = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmt = iso => { const d = new Date(iso+'T12:00:00'); return M[d.getMonth()]+' '+d.getDate(); };
const dow = iso => D[new Date(iso+'T12:00:00').getDay()];
const mk = iso => { const d = new Date(iso+'T12:00:00'); return M[d.getMonth()]+' '+d.getFullYear(); };
const gid = g => g.cabin+'|'+g.checkIn;

let ck = JSON.parse(localStorage.getItem('cabin-gaps-ck') || '{}');
let filt = 'all';

function render() {
  const gaps = filt === 'all' ? DATA.gaps : DATA.gaps.filter(g => g.nights === +filt);
  let html = '', mo = null;
  for (const g of gaps) {
    const m = mk(g.checkIn);
    if (m !== mo) { if (mo) html += '</div>'; mo = m; html += '<div class="month-group"><div class="month-header">'+m+'</div>'; }
    const id = gid(g), done = ck[id] ? ' done' : '';
    html += '<div class="gap-item '+(g.bookable?'bookable':'blocked')+'"><div class="gap-check'+done+'" data-id="'+id+'"></div>'
      + '<img class="gap-cabin-img" src="'+g.picture+'" alt="" loading="lazy" onerror="this.style.display=\\'none\\'">'
      + '<div class="gap-details"><div class="gap-cabin-name">'+g.cabin.replace(/ - .*/,'')+'</div>'
      + '<div class="gap-dates">'+dow(g.checkIn)+' '+fmt(g.checkIn)+' → '+fmt(g.checkOut)+'</div></div>'
      + '<span class="gap-badge n'+g.nights+'">'+g.nights+'N</span>'
      + '<span class="min-badge '+(g.bookable?'ok':'blocked')+'">'+(g.bookable?'\\u2713':'\\u{1F512}')+' minNights:'+g.minStay+'</span>'
      + '<div class="gap-rate"><strong>$'+g.totalRate+'</strong><br>'+(g.nights>1?'$'+g.nightlyRate+'/n':'')+'</div></div>';
  }
  if (mo) html += '</div>';
  document.getElementById('list').innerHTML = html;
  const total = DATA.gaps.length, done = DATA.gaps.filter(g => ck[gid(g)]).length;
  document.getElementById('total').textContent = total;
  document.getElementById('done').textContent = done;
  document.getElementById('remaining').textContent = total - done;
  document.getElementById('progress').style.width = (total ? done/total*100 : 0)+'%';
}

document.getElementById('list').addEventListener('click', e => {
  const el = e.target.closest('.gap-check');
  if (!el) return;
  const id = el.dataset.id;
  ck[id] ? delete ck[id] : ck[id] = 1;
  localStorage.setItem('cabin-gaps-ck', JSON.stringify(ck));
  el.classList.toggle('done');
  render();
});

document.querySelector('.filters').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filt = btn.dataset.filter;
  render();
});

document.getElementById('generated').textContent = new Date(DATA.generated).toLocaleDateString();
render();
</script>
</body>
</html>`;

await Bun.write("index.html", html);
console.log("Wrote index.html");
