# Bob's Cabins Gap Night Finder

Finds short (1–3 night) availability gaps in the [Bob's Cabins on Lake Superior](https://bobscabinsonlakesuperior.client.innroad.com/grid/) booking calendar and outputs a self-contained HTML report.

Gap nights are open nights wedged between longer bookings — easy to miss but bookable. This tool surfaces them all in one place so they can be filled.

## How it works

1. **Scrape** — `scrape.js` launches Chrome via Playwright, navigates to the innroad booking engine, and waits for you to pass the Cloudflare Turnstile captcha manually.
2. **Fetch** — Once authenticated, it pulls the `/availability` endpoint for each month of the season (May–Oct) in parallel.
3. **Find gaps** — Walks each cabin's calendar looking for runs of 1–3 consecutive available nights.
4. **Output** — Writes `index.html` with all gap data embedded as JSON. No server needed — just open the file.

## Requirements

- [Bun](https://bun.sh/)
- Google Chrome (or set `CHROME_PATH` to your Chromium binary)
- Playwright (`bun install` pulls it in)

## Usage

```bash
bun install
bun scrape.js
```

A Chrome window will open. Click the Turnstile checkbox when prompted, then wait for the scrape to finish. Output goes to `index.html`.

## The report

`index.html` is a self-contained dashboard:

- Gaps grouped by month with cabin photos and direct booking links
- Filter by 1, 2, or 3 night gaps
- Checkbox each gap as "handled" (saved in localStorage)
- Progress bar tracking how many gaps have been addressed

## Configuration

Season dates are hardcoded at the top of `scrape.js`:

```js
const SEASON_START = "2026-05-11";
const SEASON_END = "2026-10-19";
```

Change these for a different date range.

## Files

| File | Purpose |
|---|---|
| `scrape.js` | Main script — scrape, find gaps, generate HTML |
| `fetch-availability.js` | Earlier prototype (single-month, verbose) |
| `index.html` | Generated report (not checked in as source) |
| `innroad-api-reference.md` | Notes on the innroad booking engine API |
