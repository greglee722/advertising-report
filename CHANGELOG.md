# Changelog

## index.html v1.3 · sync.js v0.7.1 — 2026-08-04

### Added
- **Median asking rent per cell** in the inventory table, under each listing count. Median rather
  than mean so one outlier penthouse cannot move a neighborhood's headline rent. Cells resting on
  fewer than 3 listings are greyed and italicised with a hover stating the sample size — two
  listings is not a market rate.

### Fixed
- **Rooms-for-rent were showing up as apartment inventory.** `normalizeYGLBeds` returned `null` for
  "Room for Rent in X", which excluded them from a *bed bucket* but landed them straight in the
  Unknown column — putting a $1,245 median beside whole-unit rents, where it reads as cheap stock.
  All 9 were rooms in shared flats (units literally named "Room 4", "ROOM"). Now flagged explicitly
  in `sync.js` as `room_for_rent` rather than inferred from `beds === null`, which a blank
  `BedInfo` would also produce, and held out of the table. Their count is stated in the subtitle
  rather than silently dropped, and every remaining whole unit has a real bed count (0 nulls).

### Verified
- Every one of the 50 neighborhood × beds cells checked against an independent recomputation from
  `data.json` — counts and medians both. Median tested for odd, even (averages the middle pair),
  unsorted input, empty, and outlier resistance.

## index.html v1.2 — 2026-08-04

Single-page layout and filter cleanup.

### Changed
- **Removed the Dashboard / YGL Inventory view toggle.** Inventory now lives on the same page as
  everything else, between Lead Volume and Move-In Demand — leads above, supply below, which is the
  comparison the report exists to support.
- **Date presets and Custom are one control.** Custom joins Yesterday / 7 Days / 30 Days / All Time
  in the same button group; the start and end inputs only appear once Custom is selected, and are
  seeded with the last 30 days so the range never silently means "all time".
- **Beds is a dropdown** instead of a button group, matching Agent and Neighborhood. Adds an
  **Unknown** option so the leads with no captured bed count can be isolated — the same population
  the new Unknown column surfaces.
- **Fixed neighborhood row order** across all three tables and both dropdowns: Beacon Hill ·
  West End · Back Bay · Fenway/Symphony · Fenway/Kenmore · West Fenway · Mission Hill · North End ·
  South End · Theatre District/Midtown/Chinatown/Financial District. Row N is the same neighborhood
  in every table, so the lead and inventory halves can be read side by side. Anything unlisted sorts
  after, alphabetically — never dropped.

### Removed
- Orphaned by the above: `setView`, the `currentView` state, and the `.view-toggle` CSS.

## sync.js v0.7.0 — 2026-08-04

Neighborhood accuracy. ZIP codes do not align with the neighborhoods this report reports on, and
both halves were wrong in ways that cancelled out on the surface and compounded underneath.

### Added
- **Fenway street rulebook.** ZIP cannot split Fenway — West Fenway (Queensberry, Peterborough,
  Jersey, Park Dr) and Kenmore (Beacon, Comm Ave, Bay State) are both 02215, Symphony is 02115.
  Street name plus a house-number cut where a street crosses a boundary. Cuts ratified with Greg:
  Beacon 500, Comm Ave 483, Newbury 360 (each the Mass Ave crossing), Boylston 1000.
  Applied identically to leads and YGL so the two halves of the report stay comparable.
- **Correct neighborhood labelling for YGL inventory** (`YGL_EXCLUDE` / `YGL_LABEL_BUCKETS` /
  `resolveYGLNeighborhood`). A target ZIP is not a target neighborhood: 02114 is 61% West End and
  02116 ~48% Midtown/Theatre District. Mislabelled inventory now gets its own row rather than being
  folded into its neighbour — a Beacon Hill renter will not take a West End unit. West End is its
  own row (78); Midtown, Theatre District, Chinatown and Financial District report as one combined
  row (61); Roxbury border rows fall through to the ZIP map (Camden St → South End, Hammond St →
  Mission Hill). Only genuine data errors are dropped: Brighton (14 — a typo'd ZIP on Selkirk Rd,
  which appears 196× under 02135 and has never produced a lead) and Allston (7 — Commonwealth Ave
  1056–1135, past Kenmore). Every exclusion is logged with counts, never silent.
- `backfill-neighborhoods.js` — recomputes `fub_leads.neighborhood` under the new rulebook. Dry-run
  by default; `--apply` writes inside a transaction, re-reading each row and skipping any a
  concurrent sync has touched.

### Fixed
- **02115 Back Bay leakage.** Hereford, Gloucester and Marlborough are Back Bay streets that the ZIP
  map filed under Fenway.
- Street-name matching is now suffix- and parenthetical-tolerant — YGL writes `Beacon`,
  `Beacon St.` and `Boylston St. (bsmt.)` for the same streets, and 8 listings were falling through.

### Impact
- **374 of 985 addressed leads (38%) reassigned.**
- YGL inventory resolves to 10 correctly-labelled rows: Mission Hill 205 · West Fenway 157 ·
  Fenway/Symphony 142 · Back Bay 107 · West End 82 · North End 70 ·
  Theatre District/Midtown/Chinatown/Financial District 61 · Fenway/Kenmore 58 · Beacon Hill 55 ·
  South End 47 = 984 listings, all priced, 213 studios. 21 dropped as data errors.
- **Beacon Hill's inventory shortage was being materially understated** — 305 leads over 120 days
  against 55 real listings, not the 137 the ZIP map implied. Verified the lead side is already
  clean (all 305 are on Beacon Hill streets, none in the West End), so this corrects the inventory
  side only and does not introduce a false gap.

### Note
- YGL's `<Neighborhood>` field is more reliable than previously documented. An earlier note called
  it "agent-entered and dirty" on the basis of 02115 rows tagged Brighton and Back Bay — both tags
  were correct and the ZIP map was wrong.

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
