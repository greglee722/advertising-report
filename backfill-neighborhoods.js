'use strict';
// One-time backfill: recompute fub_leads.neighborhood with the Fenway street rulebook (sync.js
// v0.7.0). Existing rows were assigned by ZIP alone, which cannot separate West Fenway from Kenmore
// (both 02215) and mislabelled the Back Bay sliver inside 02115 as Fenway.
//
//   node backfill-neighborhoods.js              # dry run — prints the diff, writes nothing
//   node backfill-neighborhoods.js --apply      # writes
//
// Safe to re-run: it only updates rows whose recomputed value differs from what is stored.

const { Client } = require('pg');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Load sync.js's resolver rather than duplicating the rulebook — one definition, no drift.
const SYNC = path.join(__dirname, 'sync.js');
let src = fs.readFileSync(SYNC, 'utf8');
const INVOCATION = "main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });";
if (!src.includes(INVOCATION)) {
  console.error('ABORT: could not find main() invocation in sync.js — this loader is out of date.');
  process.exit(1);
}
src = src.replace(INVOCATION, 'module.exports = { resolveNeighborhood };');
const m = new Module(SYNC, null);
m.filename = SYNC;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(src, SYNC);
const { resolveNeighborhood } = m.exports;

const APPLY = process.argv.includes('--apply');

(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1); }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows } = await client.query(
    `SELECT fub_id, address, zip, neighborhood FROM fub_leads WHERE address IS NOT NULL AND zip IS NOT NULL`
  );
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — examining ${rows.length} addressed leads\n`);

  const changes = [];
  for (const r of rows) {
    const next = resolveNeighborhood(r.address, r.zip);
    if (next && next !== r.neighborhood) changes.push({ ...r, next });
  }

  if (!changes.length) { console.log('Nothing to change.'); await client.end(); return; }

  const moves = {};
  changes.forEach(c => {
    const k = `${c.neighborhood || '(none)'} → ${c.next}`;
    moves[k] = (moves[k] || 0) + 1;
  });
  console.log('Reassignments:');
  Object.entries(moves).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));

  console.log('\nSample (up to 12):');
  changes.slice(0, 12).forEach(c =>
    console.log(`  ${String(c.address).slice(0, 46).padEnd(46)} ${String(c.neighborhood).padEnd(16)} → ${c.next}`));

  console.log(`\n${changes.length} of ${rows.length} rows would change.`);

  if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply to write.'); await client.end(); return; }

  // Re-read each row immediately before writing and skip it if the stored value moved since the
  // scan — a concurrent sync may have rewritten it.
  let written = 0, skipped = 0;
  await client.query('BEGIN');
  for (const c of changes) {
    const res = await client.query(
      `UPDATE fub_leads SET neighborhood = $1 WHERE fub_id = $2 AND neighborhood IS NOT DISTINCT FROM $3`,
      [c.next, c.fub_id, c.neighborhood]
    );
    if (res.rowCount === 1) written++; else skipped++;
  }
  await client.query('COMMIT');

  console.log(`\nWrote ${written} rows.` + (skipped ? ` Skipped ${skipped} changed by a concurrent write.` : ''));

  const { rows: after } = await client.query(
    `SELECT neighborhood, COUNT(*)::int AS n FROM fub_leads
     WHERE neighborhood IN ('Fenway','West Fenway','Fenway/Symphony','Fenway/Kenmore','Back Bay')
     GROUP BY neighborhood ORDER BY n DESC`
  );
  console.log('\nVerified from the database:');
  after.forEach(r => console.log(`  ${String(r.n).padStart(5)}  ${r.neighborhood}`));

  await client.end();
})().catch(e => { console.error('Backfill failed:', e.message); process.exit(1); });
