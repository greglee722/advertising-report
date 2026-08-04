'use strict';
const https = require('https');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const VERSION = '0.7.2';
const DATA_FILE = path.join(__dirname, 'public', 'data.json');

// Boston metro ZIP → neighborhood (matches active-ads-combine)
const ZIP_NEIGHBORHOODS = {
  '02108': 'Beacon Hill', '02109': 'North End', '02110': 'Downtown', '02111': 'Chinatown',
  '02113': 'North End', '02114': 'Beacon Hill', '02115': 'Fenway', '02116': 'Back Bay',
  '02118': 'South End', '02119': 'Roxbury', '02120': 'Mission Hill', '02121': 'Dorchester',
  '02122': 'Dorchester', '02124': 'Dorchester', '02125': 'Dorchester', '02126': 'Mattapan',
  '02127': 'South Boston', '02128': 'East Boston', '02129': 'Charlestown',
  '02130': 'Jamaica Plain', '02131': 'Roslindale', '02132': 'West Roxbury',
  '02134': 'Allston', '02135': 'Brighton', '02136': 'Hyde Park',
  '02163': 'Allston', '02199': 'Back Bay', '02210': 'Seaport', '02215': 'Fenway/Kenmore',
  '02138': 'Cambridge (Harvard Sq)', '02139': 'Cambridge (Central Sq)',
  '02140': 'Cambridge (Porter Sq)', '02141': 'East Cambridge', '02142': 'East Cambridge',
  '02143': 'Somerville (Union Sq)', '02144': 'Somerville (Davis Sq)', '02145': 'Somerville (Winter Hill)',
  '02445': 'Brookline', '02446': 'Brookline (Coolidge Corner)', '02447': 'Brookline',
  '02459': 'Newton', '02460': 'Newton', '02461': 'Newton', '02458': 'Newton',
};

// Mon → pull Fri+Sat+Sun; Tue–Fri → pull yesterday
// Set BACKFILL_DAYS=30 env var for a one-time historical backfill
function getDateRange() {
  // All boundaries in Eastern time so fetched leads match stored lead_date
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

  const backfillDays = process.env.BACKFILL_DAYS ? parseInt(process.env.BACKFILL_DAYS, 10) : null;
  if (backfillDays) {
    const d = new Date(todayStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
    d.setUTCDate(d.getUTCDate() - backfillDays);
    return { startDate: d.toISOString().split('T')[0], endDate: todayStr };
  }

  const todayDate = new Date(todayStr + 'T12:00:00Z');
  const dayOfWeek = todayDate.getUTCDay(); // 0=Sun, 1=Mon...6=Sat

  const startDate = new Date(todayDate);
  if (dayOfWeek === 1) {
    startDate.setUTCDate(todayDate.getUTCDate() - 3); // back to Friday
  } else {
    startDate.setUTCDate(todayDate.getUTCDate() - 1); // yesterday
  }

  return { startDate: startDate.toISOString().split('T')[0], endDate: todayStr };
}

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const req = https.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'User-Agent': `fub-leads-dashboard/${VERSION}`,
        'X-System': 'fub-leads-dashboard',
        'X-System-Key': 'fub-leads-dashboard-zillow-ads',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`FUB API ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Bad JSON from FUB: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── YGL Integration ───────────────────────────────────────────────────────────

// Only fetch inventory for these target neighborhoods
const YGL_TARGET_ZIPS = {
  'Fenway':       ['02115', '02215'],
  'Back Bay':     ['02116', '02117', '02199'],
  'South End':    ['02118'],
  'North End':    ['02109', '02113'],
  'Beacon Hill':  ['02108', '02114'],
  'Mission Hill': ['02120'],
};
const YGL_TARGET_ZIP_SET = new Set(Object.values(YGL_TARGET_ZIPS).flat());

// A target ZIP is not the same as a target neighborhood: 02114 is 61% West End, 02116 is ~48%
// Midtown/Theatre District, and 14 Brighton listings on Selkirk Rd carry a typo'd 02115 ZIP.
// Folding those into Beacon Hill / Back Bay / Fenway made inventory look deeper than it is —
// a Beacon Hill renter will not take a West End unit, the same way a Kenmore renter will not take
// a West Fenway one. So we separate rather than merge. (Verified 2026-08-04: the LEAD side is
// already clean — all 305 leads in 02114 are on Beacon Hill streets, all 118 in 02116 are Back Bay.)
//
// YGL's own <Neighborhood> field is the reliable signal — it was right about Selkirk Rd and about
// the Back Bay streets inside 02115, where our ZIP map was wrong.
// Rules ratified with Greg 2026-08-04.

// Dropped entirely. Brighton = a typo'd ZIP on one building (Selkirk Rd appears 196× under 02135,
// and has never produced a lead). Allston = Commonwealth Ave 1056–1135, the BU end, well past
// Kenmore. The rest are a safety net in case another ZIP typo drags a distant neighborhood in.
const YGL_EXCLUDE = new Set([
  'brighton', 'allston', 'dorchester', 'longwood', 'seaport district', 'south boston',
  'charlestown', 'east boston', 'jamaica plain', 'roslindale', 'west roxbury', 'hyde park',
  'mattapan', 'downtown',
]);

// The small downtown-adjacent labels report as one combined row.
const DOWNTOWN_BUCKET = 'Theatre District/Midtown/Chinatown/Financial District';
const YGL_LABEL_BUCKETS = {
  'midtown': DOWNTOWN_BUCKET,
  'theatre district': DOWNTOWN_BUCKET,
  'chinatown': DOWNTOWN_BUCKET,
  'financial district': DOWNTOWN_BUCKET,
  'west end': 'West End', // its own row — 78 listings previously counted as Beacon Hill
};

function isOutOfArea(yglNeighborhood) {
  const n = String(yglNeighborhood || '').toLowerCase().trim();
  return n !== '' && YGL_EXCLUDE.has(n);
}

// Resolution order: explicit label bucket → Fenway street rulebook → ZIP map.
// Labels with no bucket (Fenway, Kenmore, Roxbury, Back Bay, blank…) fall through, which is what
// puts border Roxbury rows where Greg wanted them: Camden St 02118 → South End, Hammond St
// 02120 → Mission Hill, matching their same-street, same-ZIP siblings.
function resolveYGLNeighborhood(yglNeighborhood, streetName, houseNo, zip) {
  const label = String(yglNeighborhood || '').toLowerCase().trim();
  if (YGL_LABEL_BUCKETS[label]) return YGL_LABEL_BUCKETS[label];
  return refineFenway(streetName, houseNo, zip) || (zip ? (ZIP_NEIGHBORHOODS[zip] || null) : null);
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

// YGL BedInfo is free-ish text. Rules agreed with Greg 2026-08-04:
//   'Studio' / '0'        → 0
//   '1 split' / '2 split' → 1 / 2  (count the beds, ignore the layout)
//   '1.5' / '2.5'         → 1 / 2  (floor decimals to the whole bed)
//   'Room for Rent in X'  → null   (excluded — not a whole-unit listing)
function isRoomForRent(bedInfo) {
  return String(bedInfo || '').toLowerCase().trim().startsWith('room for rent');
}

// Not everything YGL lists is an apartment. Parking spaces carry beds=0 and land in the Studio
// column at $200–$345; rooms in shared flats carry a normal bed count and land in 1BR at $900.
// Both drag the median of a real rent figure down — a $345 parking space is what pulled
// Fenway/Kenmore studios to $2,038 (spotted by Greg 2026-08-04).
//
// ⚠️ BedInfo alone is not enough. Only 5 of the 14 room listings say "Room for Rent in X"; the
// other 9 (10 Parker Hill Ave) declare BedInfo=1 and hide it in the Unit field as "2 - Room 5".
// Check BOTH fields. Verified against the full feed: these patterns catch 19 listings and zero
// priced at or above $1,800, so no real apartment is caught.
//
// Returns null for a genuine whole unit, otherwise a short reason.
function nonUnitReason(bedInfo, unit) {
  const u = String(unit || '');
  if (/\b(parking|garage|pkg)\b/i.test(u)) return 'parking';
  if (isRoomForRent(bedInfo) || /\broom\b/i.test(u)) return 'room';
  return null;
}

function normalizeYGLBeds(bedInfo) {
  if (!bedInfo) return null;
  const s = String(bedInfo).toLowerCase().trim();
  if (isRoomForRent(s)) return null;
  if (s === 'studio' || s === '0') return 0;
  const n = parseInt(s, 10); // truncates '1.5' → 1 and reads the leading int of '1 split'
  return isNaN(n) || n < 0 ? null : n;
}

function parseYGLXml(raw) {
  const blocks = raw.match(/<Listing>[\s\S]*?<\/Listing>/g) || [];
  return blocks.map(block => {
    const zip = xmlTag(block, 'Zip').replace(/\D/g, '').slice(0, 5);
    return {
      id:             xmlTag(block, 'ID'),
      address:        `${xmlTag(block, 'StreetNumber')} ${xmlTag(block, 'StreetName')}`.trim(),
      unit:           xmlTag(block, 'Unit'),
      city:           xmlTag(block, 'City'),
      zip,
      // YGL label buckets first, then the same street rulebook the lead side uses, then the ZIP map
      neighborhood:   resolveYGLNeighborhood(xmlTag(block, 'Neighborhood'), xmlTag(block, 'StreetName'),
                        parseInt(xmlTag(block, 'StreetNumber'), 10) || null, zip),
      // YGL's own neighborhood label — kept for the out-of-area exclusion, not for display
      ygl_neighborhood: xmlTag(block, 'Neighborhood'),
      // 'room' or 'parking' when this isn't a whole apartment — kept in the data, held out of the
      // inventory table so it can't distort a rent figure. Flagged explicitly rather than inferred
      // from a null bed count, which a blank BedInfo would also produce.
      non_unit:       nonUnitReason(xmlTag(block, 'BedInfo'), xmlTag(block, 'Unit')),
      beds:           normalizeYGLBeds(xmlTag(block, 'BedInfo') || xmlTag(block, 'Beds')),
      price:          parseInt(xmlTag(block, 'Price'), 10) || null,
      available_date: xmlTag(block, 'AvailableDate'),
      fee:            xmlTag(block, 'Fee') === '1',
    };
  }).filter(l => l.id);
}

function fetchYGLPage(apiKey, pageIndex) {
  return new Promise((resolve) => {
    const body = `key=${encodeURIComponent(apiKey)}&status=ONMARKET&page_index=${pageIndex}`;
    const req = require('https').request({
      hostname: 'www.yougotlistings.com',
      path: '/api/rentals/search.php',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(raw));
    });
    req.on('error', (e) => { console.warn(`  YGL page ${pageIndex} error:`, e.message); resolve(''); });
    req.write(body);
    req.end();
  });
}

// YGL paginates via `page_index` (100/page) and reports the full count in <Total>.
// Earlier versions requested page 1 only and saw ~100 of ~2,600 listings.
// The API ignores zip[] params, so target-neighborhood filtering is done post-fetch.
async function fetchYGLListings(apiKey) {
  const MAX_PAGES = 60; // safety stop: 6,000 listings, well above the ~2,600 currently on-market
  const seen = new Set();
  const all = [];
  let total = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await fetchYGLPage(apiKey, page);
    if (!raw) break;

    if (total === null) {
      const m = raw.match(/<Total>(\d+)<\/Total>/);
      total = m ? parseInt(m[1], 10) : null;
      if (total) console.log(`  YGL reports ${total} on-market listings`);
    }

    let parsed;
    try {
      parsed = parseYGLXml(raw);
    } catch (e) {
      console.warn(`  YGL parse error on page ${page}:`, e.message);
      break;
    }
    if (!parsed.length) break;

    let fresh = 0;
    for (const l of parsed) {
      if (seen.has(l.id)) continue; // guard against a page param that silently no-ops
      seen.add(l.id);
      all.push(l);
      fresh++;
    }
    if (!fresh) break;

    if (total !== null && all.length >= total) break;
    await new Promise(r => setTimeout(r, 400));
  }

  const inTargetZips = all.filter(l => YGL_TARGET_ZIP_SET.has(l.zip));
  const listings = inTargetZips.filter(l => !isOutOfArea(l.ygl_neighborhood));

  // Never drop rows silently — log what the out-of-area filter removed and why.
  const excluded = inTargetZips.filter(l => isOutOfArea(l.ygl_neighborhood));
  if (excluded.length) {
    const byWhy = {};
    excluded.forEach(l => { byWhy[l.ygl_neighborhood] = (byWhy[l.ygl_neighborhood] || 0) + 1; });
    console.log(`  Excluded ${excluded.length} listing(s) in target ZIPs that YGL places outside the target areas:`);
    Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`    ${n}: ${c}`));
  }

  const byNbhd = {};
  for (const l of listings) {
    byNbhd[l.neighborhood] = (byNbhd[l.neighborhood] || 0) + 1;
  }
  console.log(`  Got ${listings.length}/${all.length} YGL listings (target neighborhoods)`);
  if (total !== null && all.length < total) {
    // YGL only sorts by updated_at desc (sort_name rejects other fields with a 400), and listings
    // are updated while we walk the pages, so a small shortfall is expected drift, not a fault.
    // Warn only when the gap is big enough to mean genuinely missed pages.
    const pct = all.length / total;
    const msg = `fetched ${all.length} of ${total} reported listings (${(pct * 100).toFixed(1)}%)`;
    if (pct < 0.95) console.warn(`  WARNING: ${msg} — pagination may be truncated`);
    else console.log(`  ${msg} — small gap is expected pagination drift`);
  }
  Object.entries(byNbhd).forEach(([n, c]) => console.log(`    ${n}: ${c}`));
  return listings;
}

function extractZip(address) {
  const match = (address || '').match(/\b(\d{5})\b/);
  return match ? match[1] : null;
}

function getNeighborhood(zip) {
  return zip ? (ZIP_NEIGHBORHOODS[zip] || null) : null;
}

// ── Fenway street rulebook (v0.7.0) ───────────────────────────────────────────
// ZIP alone cannot split Fenway: West Fenway (Queensberry, Peterborough, Jersey, Park Dr) and
// Kenmore (Beacon, Comm Ave, Bay State) are BOTH 02215, while Symphony is 02115. 02115 also
// contains a sliver of genuine Back Bay (Hereford, Gloucester, Marlborough) that the ZIP map was
// mislabelling as Fenway. Street name — plus a house-number cut where a street crosses a boundary —
// is the only way to separate them. Ratified with Greg 2026-08-04.

function normStreetName(s) {
  return String(s || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')     // YGL writes things like "Boylston St. (bsmt.)"
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|av)\b/g, 'ave')
    .replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(place)\b/g, 'pl')
    .replace(/\b(east)\b/g, 'e')
    .replace(/\b(west)\b/g, 'w')
    .replace(/\s+/g, ' ')
    .trim();
}

// YGL is inconsistent about the street-type suffix — "Beacon" and "Beacon St." both appear, as do
// "Aberdeen" and "Aberdeen St". Strip the suffix so both forms reach the same rule.
const STREET_SUFFIXES = /\s+(st|ave|dr|rd|pl|way|ct|ter|blvd|ln|sq)$/;
function streetBase(s) { return normStreetName(s).replace(STREET_SUFFIXES, ''); }

const FENWAY_SYMPHONY = 'Fenway/Symphony';
const WEST_FENWAY     = 'West Fenway';
const FENWAY_KENMORE  = 'Fenway/Kenmore';
const BACK_BAY        = 'Back Bay';

// Streets that sit wholly inside one bucket.
const STREET_BUCKETS = {
  // West Fenway — the Queensberry/Peterborough/Jersey block west of the Fens
  'queensberry st': WEST_FENWAY, 'peterborough st': WEST_FENWAY, 'jersey st': WEST_FENWAY,
  'park dr': WEST_FENWAY, 'kilmarnock st': WEST_FENWAY, 'van ness st': WEST_FENWAY,
  'ipswich st': WEST_FENWAY, 'lansdowne st': WEST_FENWAY, 'yawkey way': WEST_FENWAY,
  'fenway': WEST_FENWAY,

  // Fenway/Symphony — 02115 south-east, around Symphony Hall / Northeastern / Berklee
  'hemenway st': FENWAY_SYMPHONY, 'huntington ave': FENWAY_SYMPHONY, 'norway st': FENWAY_SYMPHONY,
  'clearway st': FENWAY_SYMPHONY, 'westland ave': FENWAY_SYMPHONY, 'symphony rd': FENWAY_SYMPHONY,
  'gainsborough st': FENWAY_SYMPHONY, 'saint botolph st': FENWAY_SYMPHONY,
  'saint stephen st': FENWAY_SYMPHONY, 'edgerly rd': FENWAY_SYMPHONY, 'burbank st': FENWAY_SYMPHONY,
  'albemarle st': FENWAY_SYMPHONY, 'saint germain st': FENWAY_SYMPHONY,
  'cumberland st': FENWAY_SYMPHONY, 'stoneholm st': FENWAY_SYMPHONY, 'haviland st': FENWAY_SYMPHONY,
  'forsyth st': FENWAY_SYMPHONY, 'opera pl': FENWAY_SYMPHONY, 'massachusetts ave': FENWAY_SYMPHONY,

  // Fenway/Kenmore — around Kenmore Sq and Audubon Circle
  'brookline ave': FENWAY_KENMORE, 'charlesgate e': FENWAY_KENMORE, 'charlesgate w': FENWAY_KENMORE,
  'aberdeen st': FENWAY_KENMORE, 'bay state rd': FENWAY_KENMORE, 'deerfield st': FENWAY_KENMORE,
  'keswick st': FENWAY_KENMORE, 'maitland st': FENWAY_KENMORE, 'buswell st': FENWAY_KENMORE,
  'mountfort st': FENWAY_KENMORE, 'raleigh st': FENWAY_KENMORE, 'sherborn st': FENWAY_KENMORE,
  'medfield st': FENWAY_KENMORE, 'miner st': FENWAY_KENMORE,

  // Genuine Back Bay inside 02115 — previously mislabelled Fenway by the ZIP map
  'hereford st': BACK_BAY, 'gloucester st': BACK_BAY, 'marlborough st': BACK_BAY,
  'exeter st': BACK_BAY, 'fairfield st': BACK_BAY, 'dartmouth st': BACK_BAY,
};

// Streets that cross a boundary — split by house number. Cuts confirmed by Greg 2026-08-04:
// all four are the Massachusetts Ave crossing, except Boylston which Greg set at 1000.
const STREET_CUTS = {
  'beacon st':         { cut: 500,  below: BACK_BAY, atOrAbove: FENWAY_KENMORE },
  'commonwealth ave':  { cut: 483,  below: BACK_BAY, atOrAbove: FENWAY_KENMORE },
  'newbury st':        { cut: 360,  below: BACK_BAY, atOrAbove: FENWAY_KENMORE },
  'boylston st':       { cut: 1000, below: BACK_BAY, atOrAbove: WEST_FENWAY },
};

// Only refine inside the Fenway ZIPs — everywhere else the ZIP map is already correct.
const FENWAY_ZIPS = new Set(['02115', '02215']);

// Suffix-stripped lookups, so "Beacon" resolves the same as "Beacon St."
const BUCKETS_BY_BASE = Object.fromEntries(Object.entries(STREET_BUCKETS).map(([k, v]) => [streetBase(k), v]));
const CUTS_BY_BASE    = Object.fromEntries(Object.entries(STREET_CUTS).map(([k, v]) => [streetBase(k), v]));

// street: name without the house number. houseNo: leading integer, or null if unknown.
// Returns a refined neighborhood, or null to fall back to the ZIP map.
function refineFenway(street, houseNo, zip) {
  if (!FENWAY_ZIPS.has(zip)) return null;
  const s = normStreetName(street);
  if (!s) return null;
  const base = streetBase(s);

  const cut = STREET_CUTS[s] || CUTS_BY_BASE[base];
  if (cut) {
    if (houseNo == null) return null; // no number → can't place it; keep the ZIP default
    return houseNo < cut.cut ? cut.below : cut.atOrAbove;
  }
  return STREET_BUCKETS[s] || BUCKETS_BY_BASE[base] || null;
}

// Pull "89 Park Dr" out of "89 Park Dr #23, Boston, MA, 02215"
function splitStreet(address) {
  const first = String(address || '').split(',')[0] || '';
  const bare = first.replace(/#.*$/, '').replace(/\bapt\b.*$/i, '').trim();
  const m = bare.match(/^(\d+)\s+(.*)$/);
  return m ? { houseNo: parseInt(m[1], 10), street: m[2] } : { houseNo: null, street: bare };
}

// Single entry point: ZIP map first, then street-level refinement inside the Fenway ZIPs.
function resolveNeighborhood(address, zip) {
  const base = getNeighborhood(zip);
  if (!address || !zip) return base;
  const { houseNo, street } = splitStreet(address);
  return refineFenway(street, houseNo, zip) || base;
}

function normalizeBeds(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? null : n;
}

// Parse move-in date from FUB event description (Zillow structured data).
// Format: "Move in: Aug 01, 2026 | Credit score: ..."
function parseMoveInDate(description) {
  if (!description) return null;
  const match = description.match(/Move in:\s*([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
  if (!match) return null;
  const d = new Date(match[1]);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Fetch Property Inquiry events for a person and extract the best property data.
// FUB events have a `property` object with street, city, state, code (ZIP), bedrooms, price, url.
// Also extracts move-in date from event description (Zillow structured data).
async function fetchPropertyData(apiKey, personId) {
  try {
    const data = await httpsGet(
      `https://api.followupboss.com/v1/events?personId=${personId}&limit=20`,
      apiKey
    );
    const allEvents = data.events || [];

    // Extract move-in from any event description
    let moveIn = null;
    for (const e of allEvents) {
      moveIn = parseMoveInDate(e.description);
      if (moveIn) break;
    }

    const events = allEvents.filter(e => e.property != null);
    if (!events.length) return { property: null, moveIn };
    // Prefer the event with the most data
    events.sort((a, b) => {
      const score = e => (e.property.street ? 2 : 0) + (e.property.bedrooms != null ? 1 : 0);
      return score(b) - score(a);
    });
    return { property: events[0].property, moveIn };
  } catch (err) {
    if (String(err.message || '').includes('429')) console.warn(`    Rate limited on person ${personId}`);
    return { property: null, moveIn: null };
  }
}

function propertyToAddress(prop) {
  if (!prop) return null;
  return [prop.street, prop.city, prop.state, prop.code].filter(Boolean).join(', ') || null;
}

async function fetchFubPeople(apiKey, startDate, endDate) {
  // startDate/endDate are YYYY-MM-DD strings in Eastern time
  const results = [];
  let offset = 0;
  const limit = 100;
  let page = 1;

  while (true) {
    const url = `https://api.followupboss.com/v1/people?sort=-created&limit=${limit}&offset=${offset}`;
    console.log(`  Fetching page ${page} (offset ${offset})...`);

    const data = await httpsGet(url, apiKey);
    const people = data.people || [];
    if (people.length === 0) break;

    let hitOldDate = false;
    for (const p of people) {
      const easternDate = toEasternDate(p.created);
      if (!easternDate || easternDate < startDate) { hitOldDate = true; break; }
      if (easternDate < endDate) results.push(p);
    }

    if (hitOldDate || people.length < limit) break;
    offset += limit;
    page++;
  }

  return results;
}

function toEasternDate(isoString) {
  const d = new Date(isoString);
  const parts = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' }).split('/');
  if (parts.length !== 3) return null;
  return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
}

async function processLead(person, apiKey) {
  const { property: prop, moveIn } = await fetchPropertyData(apiKey, person.id);
  const address = propertyToAddress(prop) || null;
  const zip = prop?.code || extractZip(address);

  return {
    fub_id: String(person.id),
    agent_name: person.assignedTo || null,
    lead_date: person.created ? toEasternDate(person.created) : null,
    address,
    zip,
    neighborhood: resolveNeighborhood(address, zip),
    beds: prop?.bedrooms != null ? normalizeBeds(prop.bedrooms) : null,
    price: prop?.price ? parseInt(prop.price, 10) || null : null,
    zillow_url: (prop?.url && String(prop.url).includes('zillow')) ? prop.url : null,
    lead_name: person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || null,
    source: person.source || null,
    stage: person.stage || null,
    move_in: moveIn || null,
  };
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fub_leads (
      id           SERIAL PRIMARY KEY,
      fub_id       VARCHAR UNIQUE NOT NULL,
      agent_name   VARCHAR,
      lead_date    DATE NOT NULL,
      address      TEXT,
      zip          VARCHAR(10),
      neighborhood VARCHAR,
      beds         INTEGER,
      price        INTEGER,
      zillow_url   TEXT,
      lead_name    VARCHAR,
      source       VARCHAR,
      stage        VARCHAR,
      move_in      DATE,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`ALTER TABLE fub_leads ADD COLUMN IF NOT EXISTS move_in DATE`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_date ON fub_leads(lead_date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_agent ON fub_leads(agent_name)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_fub_leads_neighborhood ON fub_leads(neighborhood)`);
}

async function ensureZillowPricesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zillow_prices (
      address    TEXT PRIMARY KEY,
      price      INTEGER,
      beds       INTEGER,
      scraped_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

const EXCLUDED_SOURCES = ['Website', 'Apartments.com'];

async function upsertLeads(client, leads) {
  for (const lead of leads) {
    if (!lead.lead_date) continue;
    if (lead.source && EXCLUDED_SOURCES.includes(lead.source)) continue;
    await client.query(`
      INSERT INTO fub_leads
        (fub_id, agent_name, lead_date, address, zip, neighborhood, beds, price, zillow_url, lead_name, source, stage, move_in)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (fub_id) DO UPDATE SET
        agent_name   = EXCLUDED.agent_name,
        lead_date    = EXCLUDED.lead_date,
        address      = COALESCE(EXCLUDED.address, fub_leads.address),
        zip          = COALESCE(EXCLUDED.zip, fub_leads.zip),
        neighborhood = COALESCE(EXCLUDED.neighborhood, fub_leads.neighborhood),
        beds         = COALESCE(EXCLUDED.beds, fub_leads.beds),
        price        = COALESCE(EXCLUDED.price, fub_leads.price),
        zillow_url   = COALESCE(EXCLUDED.zillow_url, fub_leads.zillow_url),
        lead_name    = EXCLUDED.lead_name,
        source       = EXCLUDED.source,
        stage        = EXCLUDED.stage,
        move_in      = COALESCE(EXCLUDED.move_in, fub_leads.move_in)
    `, [
      lead.fub_id, lead.agent_name, lead.lead_date, lead.address, lead.zip,
      lead.neighborhood, lead.beds, lead.price, lead.zillow_url,
      lead.lead_name, lead.source, lead.stage, lead.move_in,
    ]);
  }
  console.log(`  Upserted ${leads.length} leads`);
}

// ── Zillow Price Enrichment (Google CSE → zpid → Unofficial Zillow API) ────────

// Step 1: Serper.dev Google search → find Zillow homedetails URL → extract zpid
// Tries exact address first, then falls back to street + city (no unit/zip) for better hit rate
function serperSearch(query, serperApiKey) {
  const body = JSON.stringify({ q: query, num: 5 });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': serperApiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function extractZpidFromResults(results) {
  for (const r of (results || [])) {
    const match = (r.link || '').match(/\/(\d+)_zpid/);
    if (match) return match[1];
  }
  return null;
}

// Build address format variations for the same unit
// FUB: "127 Myrtle St #3, Boston, MA, 02114"
// Zillow may index as: "127 Myrtle St APT 3" or "127 Myrtle St 3"
function getAddressVariations(address) {
  const variations = [];
  const parts = address.split(',').map(s => s.trim());
  const street = parts[0] || '';
  const city = parts[1] || '';

  // Extract unit from "#X" pattern
  const unitMatch = street.match(/^(.+?)\s*#(\S+)$/);
  if (unitMatch) {
    const base = unitMatch[1];
    const unit = unitMatch[2];
    // Try: "Street APT Unit, City" then "Street Unit, City"
    variations.push(`${base} APT ${unit}, ${city}`);
    variations.push(`${base} ${unit}, ${city}`);
  }
  return variations;
}

async function fetchZpidFromSerper(address, serperApiKey) {
  // Try 1: exact address match
  const exact = await serperSearch(`"${address}" site:zillow.com/homedetails`, serperApiKey);
  const zpid = extractZpidFromResults(exact?.organic);
  if (zpid) return zpid;

  // Try 2-3: unit format variations (# → APT, # → bare number)
  const variations = getAddressVariations(address);
  for (const variant of variations) {
    await new Promise(r => setTimeout(r, 500));
    const result = await serperSearch(`"${variant}" site:zillow.com/homedetails`, serperApiKey);
    const found = extractZpidFromResults(result?.organic);
    if (found) return found;
  }
  return null;
}

// Step 2: Unofficial Zillow API → /property/all?zpid=xxx → extract rental price
async function fetchZpidPrice(zpid, rapidApiKey) {
  return new Promise(resolve => {
    const opts = {
      hostname: 'unofficial-zillow-api2.p.rapidapi.com',
      path: `/property/all?zpid=${zpid}`,
      method: 'GET',
      headers: {
        'x-rapidapi-host': 'unofficial-zillow-api2.p.rapidapi.com',
        'x-rapidapi-key': rapidApiKey,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          // Zillow returns bedrooms: 0 for studios. `r.bedrooms || null` coerced that 0 to null,
          // silently erasing every studio from the dataset — check for null explicitly.
          const beds = r.bedrooms == null ? null : normalizeBeds(r.bedrooms);
          const history = r.priceHistory || [];
          // Rental prices are monthly (< $20k); sale prices are much higher
          const rentalEntry = history.find(e => e.price && e.price < 20000);
          if (rentalEntry) {
            resolve({ price: parseInt(rentalEntry.price, 10), beds });
            return;
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function enrichZillowPrices(client, rapidApiKey, serperApiKey) {
  const backfillDays = process.env.ZILLOW_BACKFILL ? parseInt(process.env.ZILLOW_BACKFILL, 10) : 2;
  const { rows } = await client.query(`
    SELECT DISTINCT fl.address FROM fub_leads fl
    LEFT JOIN zillow_prices zp ON zp.address = fl.address
    WHERE fl.address IS NOT NULL
      AND fl.lead_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND zp.address IS NULL
    ORDER BY fl.address
  `, [backfillDays]);

  if (!rows.length) { console.log('  No new addresses to price'); return; }
  console.log(`  Fetching Zillow prices for ${rows.length} address(es) (last ${backfillDays} days)...`);

  let priced = 0;
  for (const { address } of rows) {
    const zpid = await fetchZpidFromSerper(address, serperApiKey);
    if (!zpid) {
      console.log(`    No zpid found: ${address}`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    const result = await fetchZpidPrice(zpid, rapidApiKey);
    if (result && result.price) {
      await client.query(`
        INSERT INTO zillow_prices (address, price, beds, scraped_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (address) DO UPDATE SET
          price = EXCLUDED.price,
          beds = EXCLUDED.beds,
          scraped_at = NOW()
      `, [address, result.price, result.beds]);
      priced++;
      console.log(`    ${address} → zpid ${zpid} → $${result.price}`);
    } else {
      console.log(`    No rental price: ${address} (zpid ${zpid})`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`  Priced ${priced}/${rows.length} address(es)`);
}

async function generateDataJson(client, yglListings = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);

  const { rows } = await client.query(`
    SELECT id, fub_id, agent_name, lead_date, address, zip, neighborhood,
           beds, price, zillow_url, lead_name, source, stage, move_in
    FROM fub_leads
    WHERE lead_date >= $1
      AND (source IS NULL OR source NOT IN ('Website', 'Apartments.com'))
    ORDER BY lead_date DESC, id DESC
  `, [cutoff.toISOString().split('T')[0]]);

  const leads = rows.map(r => ({
    id: r.id,
    fub_id: r.fub_id,
    agent: r.agent_name,
    date: r.lead_date instanceof Date
      ? r.lead_date.toISOString().split('T')[0]
      : String(r.lead_date).split('T')[0],
    address: r.address,
    zip: r.zip,
    neighborhood: r.neighborhood,
    beds: r.beds,
    price: r.price,
    zillow_url: r.zillow_url,
    lead_name: r.lead_name,
    source: r.source,
    stage: r.stage,
    move_in: r.move_in instanceof Date
      ? r.move_in.toISOString().split('T')[0]
      : r.move_in ? String(r.move_in).split('T')[0] : null,
  }));

  const agents = [...new Set(leads.map(l => l.agent).filter(Boolean))].sort();
  const neighborhoods = [...new Set(leads.map(l => l.neighborhood).filter(Boolean))].sort();

  let zillowPrices = {};
  try {
    const { rows: priceRows } = await client.query('SELECT address, price, beds FROM zillow_prices');
    for (const r of priceRows) {
      zillowPrices[r.address] = { price: r.price, beds: r.beds };
    }
    console.log(`  Loaded ${priceRows.length} Zillow prices`);
  } catch {
    // table doesn't exist yet — no prices available
  }

  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ generated: new Date().toISOString(), version: VERSION, agents, neighborhoods, leads, yglListings, zillowPrices }, null, 2));
  console.log(`  Wrote ${leads.length} leads → public/data.json`);
}

async function enrichNullAddressLeads(client, apiKey) {
  const { rows } = await client.query(`
    SELECT fub_id FROM fub_leads
    WHERE address IS NULL
      AND lead_date >= CURRENT_DATE - INTERVAL '14 days'
      AND (source IS NULL OR source NOT IN ('Website', 'Apartments.com'))
    ORDER BY lead_date DESC
  `);

  if (!rows.length) { console.log('  No null-address leads to enrich'); return; }
  console.log(`  Enriching ${rows.length} null-address lead(s) from last 14 days...`);

  let enriched = 0;
  for (const { fub_id } of rows) {
    const { property: prop, moveIn } = await fetchPropertyData(apiKey, fub_id);
    const address = prop ? (propertyToAddress(prop) || null) : null;

    if (address || moveIn) {
      const zip = prop?.code || extractZip(address);
      const neighborhood = resolveNeighborhood(address, zip);
      const beds = prop?.bedrooms != null ? normalizeBeds(prop.bedrooms) : null;
      const price = prop?.price ? parseInt(prop.price, 10) || null : null;
      const zillow_url = (prop?.url && String(prop.url).includes('zillow')) ? prop.url : null;
      await client.query(`
        UPDATE fub_leads SET
          address      = COALESCE($1, address),
          zip          = COALESCE($2, zip),
          neighborhood = COALESCE($3, neighborhood),
          beds         = COALESCE($4, beds),
          price        = COALESCE($5, price),
          zillow_url   = COALESCE($6, zillow_url),
          move_in      = COALESCE($8, move_in)
        WHERE fub_id = $7 AND address IS NULL
      `, [address, zip, neighborhood, beds, price, zillow_url, fub_id, moveIn]);
      enriched++;
    }

    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`  Enriched ${enriched}/${rows.length} lead(s)`);
}

async function enrichNullMoveInLeads(client, apiKey) {
  // Also opportunistically fill address/neighborhood/beds for leads that have move_in but no address
  const { rows } = await client.query(`
    SELECT fub_id, address FROM fub_leads
    WHERE (move_in IS NULL OR address IS NULL)
      AND lead_date >= CURRENT_DATE - INTERVAL '14 days'
      AND (source IS NULL OR source NOT IN ('Website', 'Apartments.com'))
    ORDER BY lead_date DESC
  `);

  if (!rows.length) { console.log('  No leads to enrich for move-in/address'); return; }
  console.log(`  Checking ${rows.length} lead(s) for move-in + address data (last 14 days)...`);

  let enrichedMoveIn = 0;
  let enrichedAddress = 0;
  for (let i = 0; i < rows.length; i++) {
    const { fub_id, address: existingAddress } = rows[i];
    const { property: prop, moveIn } = await fetchPropertyData(apiKey, fub_id);

    const newAddress = prop ? (propertyToAddress(prop) || null) : null;
    const hasNewMoveIn = moveIn;
    const hasNewAddress = newAddress && !existingAddress;

    if (hasNewMoveIn || hasNewAddress) {
      const zip = prop?.code || extractZip(newAddress);
      const neighborhood = resolveNeighborhood(newAddress, zip);
      const beds = prop?.bedrooms != null ? normalizeBeds(prop.bedrooms) : null;
      const price = prop?.price ? parseInt(prop.price, 10) || null : null;
      const zillow_url = (prop?.url && String(prop.url).includes('zillow')) ? prop.url : null;
      await client.query(`
        UPDATE fub_leads SET
          move_in      = COALESCE($1, move_in),
          address      = COALESCE($2, address),
          zip          = COALESCE($3, zip),
          neighborhood = COALESCE($4, neighborhood),
          beds         = COALESCE($5, beds),
          price        = COALESCE($6, price),
          zillow_url   = COALESCE($8, zillow_url)
        WHERE fub_id = $7
      `, [moveIn, newAddress, zip, neighborhood, beds, price, fub_id, zillow_url]);
      if (hasNewMoveIn) enrichedMoveIn++;
      if (hasNewAddress) enrichedAddress++;
    }

    // Progress log every 100 leads
    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      console.log(`  ${i + 1}/${rows.length} checked, ${enrichedMoveIn} move-in, ${enrichedAddress} address`);
    }

    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`  Enriched ${enrichedMoveIn} move-in + ${enrichedAddress} address out of ${rows.length} lead(s)`);
}

async function main() {
  const apiKey = process.env.FUB_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!apiKey) { console.error('FUB_API_KEY required'); process.exit(1); }
  if (!dbUrl)  { console.error('DATABASE_URL required'); process.exit(1); }

  const { startDate, endDate } = getDateRange();
  console.log(`FUB Leads Dashboard Sync v${VERSION}`);
  console.log(`Date range: ${startDate} → ${endDate} (Eastern)`);

  console.log('\nFetching leads from FUB...');
  const people = await fetchFubPeople(apiKey, startDate, endDate);
  console.log(`Found ${people.length} lead(s)`);

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await ensureTable(client);
  await ensureZillowPricesTable(client);

  if (people.length > 0) {
    console.log('\nFetching property data from events...');
    // Batch event fetches to avoid FUB rate limits (~100 req/min unregistered)
    // Backfill (large sets): 2 concurrent, 1.5s between batches (~80 req/min)
    // Daily sync (small sets): 5 concurrent, 400ms between batches (~75 req/min)
    const isBackfill = people.length > 100;
    const BATCH = isBackfill ? 2 : 5;
    const DELAY = isBackfill ? 1500 : 400;
    const leads = [];
    for (let i = 0; i < people.length; i += BATCH) {
      const batch = people.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(p => processLead(p, apiKey)));
      leads.push(...results);
      if (i + BATCH < people.length) await new Promise(r => setTimeout(r, DELAY));
      if (i > 0 && Math.round(i / people.length * 20) > Math.round((i - BATCH) / people.length * 20)) {
        const pct = Math.min(100, Math.round((i + BATCH) / people.length * 100));
        console.log(`  ${pct}% (${Math.min(i + BATCH, people.length)}/${people.length})`);
      }
    }
    const withAddress = leads.filter(l => l.address).length;
    const withBeds = leads.filter(l => l.beds !== null).length;
    const withMoveIn = leads.filter(l => l.move_in).length;
    console.log(`  ${withAddress}/${leads.length} have address | ${withBeds}/${leads.length} have beds | ${withMoveIn}/${leads.length} have move-in`);
    console.log('\nUpserting to database...');
    await upsertLeads(client, leads);
  } else {
    console.log('No new leads — regenerating data.json from existing DB records');
  }

  if (!process.env.BACKFILL_DAYS) {
    // Cooldown after processLead burst before hitting FUB API again
    console.log('\nEnriching null-address leads (30s cooldown)...');
    await new Promise(r => setTimeout(r, 30000));
    await enrichNullAddressLeads(client, apiKey);

    // Second enrichment pass: move-in + opportunistic address backfill
    console.log('\nEnriching move-in + address gaps (30s cooldown)...');
    await new Promise(r => setTimeout(r, 30000));
    await enrichNullMoveInLeads(client, apiKey);
  }

  // Zillow price enrichment is PAUSED (v0.6.0, 2026-08-04).
  // Nothing in the report reads these prices any more: the address is resolved by Google-searching
  // the lead's street address, which can land on a neighbouring unit or another brokerage's post,
  // so the result can't be called "the price our agent advertised". Re-enable with ZILLOW_PRICES=1
  // once we have a source that is genuinely the agent's own ad (YGL or Zillow Rental Manager).
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const serperApiKey = process.env.SERPER_API_KEY;
  if (!process.env.ZILLOW_PRICES) {
    console.log('\nZillow price enrichment paused (set ZILLOW_PRICES=1 to re-enable)');
  } else if (rapidApiKey && serperApiKey) {
    console.log('\nEnriching Zillow prices...');
    await enrichZillowPrices(client, rapidApiKey, serperApiKey);
  } else {
    const missing = ['RAPIDAPI_KEY', 'SERPER_API_KEY'].filter(k => !process.env[k]);
    console.log(`\nZillow price enrichment skipped (missing: ${missing.join(', ')})`);
  }

  console.log('\nFetching YGL inventory...');
  const yglApiKey = process.env.YGL_API_KEY;
  const yglListings = yglApiKey ? await fetchYGLListings(yglApiKey) : [];
  if (!yglApiKey) console.log('  YGL_API_KEY not set — skipping');

  console.log('\nGenerating data.json...');
  await generateDataJson(client, yglListings);
  await client.end();
  console.log('\nDone!');
}

main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
