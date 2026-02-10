const pw = require('playwright');
(async () => {
  const b = await pw.chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
  const p = await ctx.newPage();
  let tk = null;

  p.on('response', r => {
    const h = r.headers()['vnd-innroad-booking-engine-session'];
    if (h) tk = h;
  });

  await p.goto('https://bobscabinsonlakesuperior.client.innroad.com/grid/', { waitUntil: 'load', timeout: 30000 });

  // Poll for turnstile auth
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(5000);
    if (!tk) continue;
    const s = await p.evaluate(async t => {
      const r = await fetch('https://be-booking-engine-api.innroad.com/session/status', { headers: { 'vnd-innroad-booking-engine-session': t } });
      return r.json();
    }, tk);
    if (s.isAuthenticatedWithTurnstile) { console.error('TURNSTILE_OK'); break; }
    console.error('WAIT_' + ((i+1)*5) + 's');
  }

  // Fetch June availability
  const r = await p.evaluate(async t => {
    const res = await fetch('https://be-booking-engine-api.innroad.com/availability?startDate=2026-06-01&endDate=2026-06-30', {
      headers: { 'Accept-Language': 'en-US', 'vnd-innroad-booking-engine-session': t }
    });
    return { s: res.status, d: await res.text() };
  }, tk);

  if (r.s === 200) console.log(r.d);
  else console.error('FAIL_' + r.s);

  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
