'use strict';
// Loads the manually-filled price/beds CSVs into the agent_listings table.
//
//   node load-agent-listings.js                      # dry run over every CSV in Input/
//   node load-agent-listings.js --apply
//   node load-agent-listings.js --file /path/to.csv --apply
//
// ⚠️ Keyed by ADDRESS, not agent. Leads get reassigned in FUB, so the agent on a lead is not
// necessarily the agent whose Zillow account holds the listing — Greg hit exactly this on
// Alejandro's sheet, where 2 addresses he couldn't find turned out to have leads for Peter, Ricky
// and Yuli too. Keying by address means whoever finds a listing first fills it for everyone, and a
// later sheet covering the same address simply confirms it.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argVal = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const INPUT_DIR = argVal('--dir', '/Volumes/Mini Drive/Claude/Input');
const ONE_FILE = argVal('--file', null);

// Minimal RFC4180 parser — the exports contain quoted commas in addresses and lead-name lists.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map(h => h.replace(/^﻿/, '').trim());
  return rows.slice(1).filter(r => r.some(c => c.trim()))
    .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

// Column names are matched loosely so a re-exported or hand-edited sheet still loads.
const col = (row, ...needles) => {
  const key = Object.keys(row).find(k => needles.every(n => k.toLowerCase().includes(n)));
  return key ? row[key] : '';
};

function parseBeds(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('studio')) return 0;
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function parsePrice(v) {
  const s = String(v || '').replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

(async () => {
  const files = ONE_FILE ? [ONE_FILE]
    : fs.readdirSync(INPUT_DIR)
        .filter(f => f.toLowerCase().endsWith('.csv') && !f.startsWith('._'))
        .filter(f => /zillow|ad info|price|listing/i.test(f))
        .map(f => path.join(INPUT_DIR, f));

  if (!files.length) { console.log('No matching CSVs found in ' + INPUT_DIR); return; }

  const records = new Map(); // address → record
  const skipped = [];
  let seenRows = 0;

  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    console.log(`${path.basename(file)} — ${rows.length} rows`);
    for (const r of rows) {
      seenRows++;
      const address = col(r, 'address');
      const price = parsePrice(col(r, 'price'));
      const beds = parseBeds(col(r, 'beds', 'fill'));
      const notes = col(r, 'notes');
      const agent = col(r, 'agent');
      if (!address) { skipped.push({ why: 'no address', row: JSON.stringify(r).slice(0, 80) }); continue; }
      if (price == null && beds == null) { skipped.push({ why: 'nothing filled', row: address, notes }); continue; }
      // Last non-null wins per field, so a second sheet can complete a partial row.
      const prev = records.get(address) || { address, price: null, beds: null, agent, notes: '' };
      records.set(address, {
        address,
        price: price != null ? price : prev.price,
        beds: beds != null ? beds : prev.beds,
        agent: prev.agent || agent,
        notes: [prev.notes, notes].filter(Boolean).join(' | '),
      });
    }
  }

  const list = [...records.values()];
  const both = list.filter(r => r.price != null && r.beds != null).length;
  console.log(`\n${seenRows} rows read → ${list.length} addresses with data (${both} have BOTH price and beds)`);
  if (skipped.length) {
    console.log(`${skipped.length} row(s) skipped:`);
    skipped.slice(0, 10).forEach(s => console.log(`   ${s.why}: ${s.row}${s.notes ? '  — ' + s.notes : ''}`));
  }
  const bedDist = {};
  list.forEach(r => { const k = r.beds === 0 ? 'studio' : r.beds == null ? 'none' : r.beds + 'BR'; bedDist[k] = (bedDist[k] || 0) + 1; });
  console.log('beds:', bedDist);

  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); return; }

  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_listings (
      address      TEXT PRIMARY KEY,
      price        INTEGER,
      beds         INTEGER,
      source_agent VARCHAR,
      notes        TEXT,
      updated_at   TIMESTAMP DEFAULT NOW()
    )`);

  let written = 0;
  await client.query('BEGIN');
  for (const r of list) {
    // COALESCE on the incoming value so a later partial fill can't blank an existing figure.
    await client.query(`
      INSERT INTO agent_listings (address, price, beds, source_agent, notes, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (address) DO UPDATE SET
        price        = COALESCE(EXCLUDED.price, agent_listings.price),
        beds         = COALESCE(EXCLUDED.beds,  agent_listings.beds),
        source_agent = COALESCE(agent_listings.source_agent, EXCLUDED.source_agent),
        notes        = NULLIF(TRIM(BOTH ' |' FROM COALESCE(agent_listings.notes,'') || ' | ' || COALESCE(EXCLUDED.notes,'')), ''),
        updated_at   = NOW()`,
      [r.address, r.price, r.beds, r.agent, r.notes || null]);
    written++;
  }
  await client.query('COMMIT');

  const { rows: after } = await client.query(
    `SELECT COUNT(*)::int AS n, COUNT(price)::int AS priced, COUNT(beds)::int AS bedded FROM agent_listings`);
  console.log(`\nWrote ${written} rows. Table now holds ${after[0].n} addresses — ${after[0].priced} priced, ${after[0].bedded} with beds.`);
  await client.end();
})().catch(e => { console.error('Load failed:', e.message); process.exit(1); });
