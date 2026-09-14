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
const DELAY_MS = 3500; // pause between items — Steam rate-limits this endpoint hard
const MAX_RETRIES = 3; // per item, covers both 429s and generic failures/blocks

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (base) => base + Math.floor(Math.random() * 800);

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

  let res;
  try {
    res = await fetch(url, {
      headers: {
        // A more browser-like header set — Steam is more likely to hard-block
        // requests that look like a bare script, which cloud/CI IPs already
        // look suspicious as-is.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://steamcommunity.com/market/",
      },
    });
  } catch (networkErr) {
    // DNS failure, connection reset, timeout, etc. — worth retrying.
    if (attempt <= MAX_RETRIES) {
      const backoff = jitter(DELAY_MS * attempt * 2);
      console.warn(`  network error on "${item.marketHashName}" (${networkErr.message}), retrying in ${backoff}ms`);
      await sleep(backoff);
      return fetchOnePrice(item, attempt + 1);
    }
    throw networkErr;
  }

  if ((res.status === 429 || res.status === 403) && attempt <= MAX_RETRIES) {
    const backoff = jitter(DELAY_MS * attempt * 3);
    console.warn(`  HTTP ${res.status} on "${item.marketHashName}" (rate limited or blocked), waiting ${backoff}ms and retrying`);
    await sleep(backoff);
    return fetchOnePrice(item, attempt + 1);
  }

  if (!res.ok) {
    // Grab a snippet of the response so a failure in the Action logs is
    // actually diagnosable (e.g. shows a Cloudflare block page vs real 500).
    const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${bodySnippet ? ` — body: ${bodySnippet}` : ""}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Response wasn't valid JSON (likely an interstitial/block page, not real data)");
  }

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
        fetchedAt: prev?.fetchedAt ?? null, // keeps the timestamp of when this price was actually true
        ok: false,
      });
    }

    if (item !== items[items.length - 1]) {
      await sleep(jitter(DELAY_MS));
    }
  }

  const successCount = results.filter((r) => r.ok).length;

  // The most recent moment ANY item was actually, successfully fetched —
  // this is what "last refreshed" on the page should show, as opposed to
  // "generatedAt" below, which is just when this script last ran (success
  // or not).
  const lastSuccessfulFetchAt = results.reduce((latest, r) => {
    if (!r.fetchedAt) return latest;
    return !latest || r.fetchedAt > latest ? r.fetchedAt : latest;
  }, null);

  const output = {
    generatedAt: new Date().toISOString(),
    lastSuccessfulFetchAt,
    runSucceeded: successCount === results.length,
    successCount,
    totalCount: results.length,
    currency: CURRENCY_LABEL,
    items: results,
  };

  await writeFile(PRICES_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(
    `\nWrote ${results.length} items to data/prices.json ` +
      `(${successCount}/${results.length} fetched successfully this run)`
  );

  // Exit non-zero if EVERYTHING failed — makes the Action show a red X in
  // that case, instead of a misleading green checkmark for a run that
  // didn't actually get any real data.
  if (successCount === 0 && results.length > 0) {
    console.error("\nEvery item failed this run — check the logs above for the actual Steam response.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
