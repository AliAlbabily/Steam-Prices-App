# My Inventory — live-updating, in EUR

A single page listing your 5 CS2 items with their current lowest price on
the Steam Community Market (in EUR), kept fresh by a scheduled GitHub
Action instead of by calling Steam from the browser — which CORS would
block, no matter which API you point it at.

## How it works

```
GitHub Action (runs every 6h, server-side — no CORS applies here)
  -> calls steamcommunity.com/market/priceoverview/ for each item (currency=3 = EUR)
  -> writes data/prices.json
  -> commits it to the repo

GitHub Pages (serves static files only)
  -> index.html loads ./data/prices.json  (same origin — no CORS)
  -> renders the cards
```

Your browser never talks to Steam directly, so there's no CORS problem to
work around, and no proxy or API key needed.

## What to do next

1. **Create a GitHub repo** and push everything in this folder, keeping
   the structure as-is (`data/`, `scripts/`, `.github/workflows/` all
   matter — GitHub only picks up workflows placed exactly at
   `.github/workflows/`).

2. **Turn on GitHub Pages.** Repo → **Settings → Pages** → Source →
   "Deploy from a branch" → branch `main`, folder `/ (root)` → Save.
   You'll get a URL like `https://yourname.github.io/your-repo/`.

3. **Allow the workflow to write back to the repo.** Repo →
   **Settings → Actions → General → Workflow permissions** → select
   **"Read and write permissions"**. Without this, the Action will fetch
   prices successfully but fail to commit them (403 error).

4. **Run the workflow once by hand.** Repo → **Actions** tab →
   "Update Steam Market prices" → **Run workflow**. This replaces the
   placeholder seed prices in `data/prices.json` with real EUR prices
   straight from Steam. Takes well under a minute for 5 items.

5. **Open your Pages URL** and check the 5 items show real numbers and
   the "last refreshed" time looks right.

6. **(Optional) Bookmark it.** From here it re-checks prices every 6
   hours on its own — nothing else to do unless you want to change the
   item list or the schedule (see below).

## Changing your items later

Edit `data/items.json`. Each entry needs: a unique `id`, `name`, `wear`
(or `null` for items without wear), `category`, `rarity` / `rarityKey`
(one of `milspec`, `restricted`, `classified`, `covert`, `knife`,
`container` — controls the colored accent bar), and the exact
`marketHashName` Steam uses (easiest way to get it exactly right: copy it
from the item's own URL on `steamcommunity.com/market/listings/730/...`).
Commit the change — the next workflow run (scheduled or manual) picks it
up automatically.

## Changing the schedule

Edit the `cron` line in `.github/workflows/update-prices.yml`. It's
currently `"23 */6 * * *"` (every 6 hours). GitHub Actions cron syntax is
UTC-based; you can generate one at crontab.guru if you want a different
cadence. Checking more often than every couple of hours isn't recommended
— see the rate-limit note below.

## A note on rate limits

Steam's `priceoverview` endpoint isn't an official public API — it
rate-limits aggressively if hit too fast or too often. `fetch-prices.mjs`
waits a few seconds between items and retries once on a 429. If a fetch
still fails for an item, the page keeps showing that item's last known
price (marked as such) rather than going blank.

## Currency

Prices are fetched with `currency=3`, which is Steam's code for EUR. If
you ever want a different currency, change `CURRENCY_CODE` and
`CURRENCY_LABEL` in `scripts/fetch-prices.mjs` — common codes: `1` = USD,
`2` = GBP, `3` = EUR, `9` = NOK, `6` = PLN. Full list in
[Valve's currency docs](https://partner.steamgames.com/doc/store/pricing/currencies).
