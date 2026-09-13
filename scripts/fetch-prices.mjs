// Fetches current lowest-listing prices (in EUR) from the Steam Community
// Market and writes the result to data/prices.json.
//
// Runs server-side (in the GitHub Action, or on your own machine) — NOT in
// a browser. Steam's priceoverview endpoint doesn't send CORS headers, so
// calling it from a page's JavaScript gets blocked. Running it here,
// server-to-server, sidesteps that entirely.
//
// Usage:
//   node scripts/fetch-prices.mjs
//
// Requires Node 18+ (built-in fetch). No npm dependencies.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = path.join(__dirname, "..", "data", "items.json");
const PRICES_PATH = path.join(__dirname, "..", "data", "prices.json");

const CURRENCY_CODE = 3; // Steam's currency id: 1 = USD, 3 = EUR
const CURRENCY_LABEL = "EUR";
const DELAY_MS = 3000; // pause between requests — Steam rate-limits this endpoint hard
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Steam formats EUR prices like "14,77€" (comma decimal, symbol trailing)
// and USD like "$14.77" (dot decimal, symbol leading). Normalize either
// into a plain number.
function parsePrice(str) {
  if (!str) return null;
  let cleaned = String(str).replace(/[^0-9.,]/g, "");
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    cleaned = cleaned.replace(",", "."); // "14,77" -> "14.77"
  } else if (cleaned.includes(",") && cleaned.includes(".")) {
    cleaned = cleaned.replace(/\./g, "").replace(",", "."); // "1.234,56" -> "1234.56"
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function fetchOnePrice(item, attempt = 1) {
  const url =
    "https://steamcommunity.com/market/priceoverview/" +
    `?appid=${item.appid || 730}` +
    `&currency=${CURRENCY_CODE}` +
    `&market_hash_name=${encodeURIComponent(item.marketHashName)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0; +https://github.com/)",
    },
  });

  if (res.status === 429 && attempt <= MAX_RETRIES) {
    const backoff = DELAY_MS * attempt * 3;
    console.warn(`  rate limited on "${item.marketHashName}", waiting ${backoff}ms and retrying`);
    await sleep(backoff);
    return fetchOnePrice(item, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data || data.success !== true) {
    throw new Error("Steam returned success=false (item may be delisted or name is wrong)");
  }

  return data; // { success, lowest_price, volume, median_price }
}

async function main() {
  const items = JSON.parse(await readFile(ITEMS_PATH, "utf8"));

  let previous = { items: [] };
  try {
    previous = JSON.parse(await readFile(PRICES_PATH, "utf8"));
  } catch {
    // No previous file yet — fine on the very first run.
  }
  const previousById = Object.fromEntries(
    (previous.items || []).map((entry) => [entry.id, entry])
  );

  const results = [];

  for (const item of items) {
    process.stdout.write(`Fetching "${item.marketHashName}"... `);
    try {
      const data = await fetchOnePrice(item);
      const priceValue = parsePrice(data.lowest_price);
      console.log(data.lowest_price || "(no price)");
      results.push({
        ...item,
        priceValue,
        lowestPriceRaw: data.lowest_price || null,
        medianPrice: data.median_price || null,
        volume: data.volume || null,
        fetchedAt: new Date().toISOString(),
        ok: priceValue !== null,
      });
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      const prev = previousById[item.id];
      results.push({
        ...item,
        priceValue: prev?.priceValue ?? null,
        lowestPriceRaw: prev?.lowestPriceRaw ?? null,
        medianPrice: prev?.medianPrice ?? null,
        volume: prev?.volume ?? null,
        fetchedAt: prev?.fetchedAt ?? null,
        ok: false,
      });
    }

    if (item !== items[items.length - 1]) {
      await sleep(DELAY_MS);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    currency: CURRENCY_LABEL,
    items: results,
  };

  await writeFile(PRICES_PATH, JSON.stringify(output, null, 2) + "\n");

  const failures = results.filter((r) => !r.ok).length;
  console.log(
    `\nWrote ${results.length} items to data/prices.json` +
      (failures ? ` (${failures} used fallback/previous values)` : "")
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
