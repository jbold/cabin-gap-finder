#!/usr/bin/env node
// Scrapes innroad booking engine for Bob's Cabins availability
// Requires: npm install playwright-core
// Usage: node scrape.js
// Note: Opens Chrome — you must click the Cloudflare Turnstile checkbox

const pw = require('playwright-core');
const fs = require('fs');
const path = require('path');

const SEASON_START = '2026-05-11';
const SEASON_END = '2026-10-19';
const BOOKING_API = 'https://be-booking-engine-api.innroad.com';
const BOOKING_URL = 'https://bobscabinsonlakesuperior.client.innroad.com/grid/';

// Split season into monthly chunks for the API
function monthChunks(start, end) {
  const chunks = [];
  let d = new Date(start + 'T12:00:00');
  const last = new Date(end + 'T12:00:00');
  while (d <= last) {
    const y = d.getFullYear(), m = d.getMonth();
    const chunkStart = d.toISOString().slice(0, 10);
    const monthEnd = new Date(y, m + 1, 0);
    const chunkEnd = monthEnd > last ? end : monthEnd.toISOString().slice(0, 10);
    chunks.push([chunkStart, chunkEnd]);
    d = new Date(y, m + 1, 1);
  }
  return chunks;
}

// Find 1-3 night gaps in a cabin's availability
function findGaps(name, meta, avail) {
  const gaps = [];
  const start = new Date(SEASON_START + 'T12:00:00');
  const end = new Date(SEASON_END + 'T12:00:00');
  const dates = [];

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    dates.push({ date: ds, ...(avail[ds] || { available: false, rate: 0, currency: 'USD' }) });
  }

  let i = 0;
  while (i < dates.length) {
    if (dates[i].available) {
      const s = i;
      while (i < dates.length && dates[i].available) i++;
      const len = i - s;
      if (len >= 1 && len <= 3) {
        const checkIn = dates[s].date;
        const co = new Date(dates[s].date + 'T12:00:00');
        co.setDate(co.getDate() + len);
        const checkOut = co.toISOString().slice(0, 10);
        const totalRate = dates.slice(s, s + len).reduce((sum, d) => sum + d.rate, 0);
        gaps.push({
          cabin: name,
          cabinId: meta.id,
          picture: meta.picture,
          maxGuests: meta.maxPersons,
          checkIn, checkOut,
          nights: len,
          nightlyRate: dates[s].rate,
          totalRate,
          currency: dates[s].currency,
          bookingUrl: `https://bobscabinsonlakesuperior.client.innroad.com/room/${meta.id}?checkIn=${checkIn}&checkOut=${checkOut}&adults=2&children=0`
        });
      }
    } else { i++; }
  }
  return gaps;
}

(async () => {
  const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
  console.log('Launching Chrome...');

  const browser = await pw.chromium.launch({
    headless: false,
    executablePath: chromePath,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const page = await browser.newPage();
  let token = null;
  let authed = false;

  page.on('response', r => {
    const h = r.headers()['vnd-innroad-booking-engine-session'];
    if (h) token = h;
    if (r.url().includes(BOOKING_API) && r.status() === 200 && !r.url().includes('session/status'))
      authed = true;
  });

  await page.goto(BOOKING_URL, { waitUntil: 'load', timeout: 30000 });
  console.log('Page loaded — click the Turnstile checkbox in the browser');

  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(2500);
    if (authed) break;
  }

  if (!authed || !token) {
    console.error('Failed to authenticate. Did you click the Turnstile checkbox?');
    await browser.close();
    process.exit(1);
  }
  console.log('Authenticated. Fetching availability...');

  const chunks = monthChunks(SEASON_START, SEASON_END);
  const allData = [];

  for (const [start, end] of chunks) {
    const r = await page.evaluate(async ({ t, s, e, api }) => {
      const res = await fetch(`${api}/availability?startDate=${s}&endDate=${e}`, {
        headers: { 'Accept-Language': 'en-US', 'vnd-innroad-booking-engine-session': t }
      });
      const newTk = res.headers.get('vnd-innroad-booking-engine-session');
      return { s: res.status, d: await res.text(), tk: newTk };
    }, { t: token, s: start, e: end, api: BOOKING_API });

    if (r.tk) token = r.tk;
    if (r.s === 200) {
      allData.push(JSON.parse(r.d));
      console.log(`  ${start} → ${end} ✓`);
    } else {
      console.error(`  ${start} → ${end} FAILED (${r.s})`);
    }
  }

  await browser.close();

  // Process into gaps
  const cabins = {};
  const cabinMeta = {};
  for (const month of allData) {
    for (const cabin of month) {
      const name = cabin.name;
      if (!cabins[name]) { cabins[name] = {}; cabinMeta[name] = { id: cabin.id, picture: cabin.picture || '', maxPersons: cabin.maxPersons || 0 }; }
      for (const r of cabin.rates) {
        cabins[name][r.effectiveDate.slice(0, 10)] = {
          available: r.isRoomAvailable,
          rate: r.baseAfterTax.value,
          currency: r.baseAfterTax.currencyCode
        };
      }
    }
  }

  let allGaps = [];
  for (const name of Object.keys(cabins).sort()) {
    allGaps = allGaps.concat(findGaps(name, cabinMeta[name], cabins[name]));
  }
  allGaps.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

  const output = {
    generated: new Date().toISOString(),
    seasonStart: SEASON_START,
    seasonEnd: SEASON_END,
    totalGaps: allGaps.length,
    gaps: allGaps
  };

  const outPath = path.join(__dirname, 'gaps.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone! ${allGaps.length} gaps written to gaps.json`);
})().catch(e => { console.error(e.message); process.exit(1); });
