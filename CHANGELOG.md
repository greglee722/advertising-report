# Changelog

## sync.js v0.6.0 · index.html v0.9 — 2026-08-04

Renamed to **Lead & Listing Report** (header only — the repo, Pages URL and Supabase OAuth
redirects are unchanged).

### Fixed
- **YGL pagination.** The API paginates via `page_index` and reports the full count in `<Total>`;
  the sync had only ever requested page 1, so it saw 100 of ~2,600 listings and kept 48. Now walks
  every page. Target-neighborhood inventory went **48 → 992 listings, including 193 studios**
  (previously 3). Earlier notes claiming YGL's pagination was broken were wrong.
- **Falsy-zero erased every studio in the Zillow path.** `const beds = r.bedrooms || null` coerced a
  legitimate `0` to `null`. Now an explicit null check. Note this column fed `zillow_prices.beds`
  only — see the known issue below for why it does not fix the lead-side studio count.
- **Zero-count bed columns were hidden**, so a real `0` was indistinguishable from a column that
  simply wasn't rendered. All bed columns now always render.

### Added
- Explicit **Unknown** column for beds and **Unknown** bucket for move-in month, so counts add up to
  the full lead total instead of silently dropping leads with no data.
- **Custom start–end date filter** alongside the presets. Either bound may be left empty; reversed
  dates are swapped rather than returning nothing.
- Mission Hill (02120) added to the YGL target neighborhoods.
- Hover explainers: why YGL inventory has no history and can't follow the date filter, and the
  studio/1BR caveat on lead bed counts.

### Changed
- Sync cron 1×/day → **every 3 hours on weekdays** (12/15/18/21 UTC). Public repo, so Actions
  minutes are free.
- YGL bed rules made explicit: `1 split`/`2 split` → 1/2, decimals floored (`1.5` → 1),
  `Room for Rent in X` excluded.
- **Zillow price enrichment paused.** Nothing reads it now, and it was at its 250/month RapidAPI
  cap. Set `ZILLOW_PRICES=1` to re-enable.

### Removed
- **Avg. Rent Price by Neighborhood & Beds** section, plus the price line on the recommendation
  cards and the Top Ad Recommendation tile. The price was resolved by Google-searching the lead's
  address, which can match a neighbouring unit or another brokerage's listing, so it could not
  honestly be called the price our agents advertised.
- Orphaned by the above: `renderPriceTable`, `getLeadAvgPrice`, the `zillowPrices` global, and the
  `.price-*` CSS.

### Known issue
- **Studios reach FUB labelled as 1 bedroom.** Verified on `2 Joy St #10`, `104 Queensberry St #4`
  and `#5`, where Zillow's own API reports `bedrooms: 0` but the FUB lead carries `"1"`
  (`289 Newbury St #9` returns 1 from both, so this is specific, not a blanket offset). Studios are
  not absent from the leads — they are counted inside the 1BR column, which is therefore inflated.
  Not fixable from FUB data alone; a tooltip states the caveat pending a decision.

## v0.1.0 — 2026-05-20

- Initial build: FUB → Postgres → data.json → GitHub Pages dashboard
- Mon–Fri cron via GitHub Actions (12:00 UTC = 7am EST / 8am EDT)
- Monday pulls Fri–Sun; Tue–Fri pulls yesterday
- ZIP → neighborhood mapping (Boston metro, same table as active-ads-combine)
- Phase 1 diagnostic: logs raw FUB API fields to determine if beds/price come through
- Lead cards with Zillow URL (if available) or Google search fallback
- Top-3 daily ad recommendations based on lead volume
- Heat table: neighborhood × beds volume grid
