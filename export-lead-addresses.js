'use strict';
// Exports the addresses that actually produced leads, grouped by agent, for a manual price/beds
// fill from each agent's own Zillow account. Starting from leads rather than enumerating every
// listing means only the addresses that matter get looked up — an ad with no leads is not worth
// anyone's time.
//
//   node export-lead-addresses.js              # last 90 days
//   node export-lead-addresses.js --days 30    # narrower window
//   node export-lead-addresses.js --out /path/to/file.csv
//
// Rows are ordered by agent, then by lead count descending, with a running coverage figure so the
// fill can stop at any point and you know exactly what share of leads is covered.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const DAYS = parseInt(argVal('--days', '90'), 10);
const OUT = argVal('--out', path.join('/Volumes/Mini Drive/Claude/Output',
  `lead-addresses-for-price-fill-${new Date().toISOString().slice(0, 10)}.csv`));

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data.json'), 'utf8'));

const cutoff = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const leads = data.leads.filter(l => l.date >= cutoff && l.address && l.agent);

// One row per agent × address — matches the workflow, since you're signed into one account at a time
const groups = new Map();
for (const l of leads) {
  const key = l.agent + '||' + l.address;
  if (!groups.has(key)) {
    groups.set(key, { agent: l.agent, address: l.address, zip: l.zip, count: 0,
      names: new Set(), first: l.date, last: l.date, beds: l.beds, moveIns: new Set() });
  }
  const g = groups.get(key);
  g.count++;
  if (l.lead_name) g.names.add(l.lead_name);
  if (l.date < g.first) g.first = l.date;
  if (l.date > g.last) g.last = l.date;
  if (g.beds == null && l.beds != null) g.beds = l.beds;
  if (l.move_in) g.moveIns.add(l.move_in.slice(0, 7));
}

const rows = [...groups.values()];
const byAgent = {};
rows.forEach(r => (byAgent[r.agent] = byAgent[r.agent] || []).push(r));

const bedsLabel = b => b === null || b === undefined ? '' : (b === 0 ? 'Studio' : b + 'BR');
const esc = v => {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const HEADER = ['Agent', 'Rank', 'Address', 'Leads', '% of agent leads (running)',
  'Lead names', 'First lead', 'Last lead', 'Requested move-in',
  'FUB beds (may be wrong)', 'PRICE — fill in', 'BEDS — fill in', 'LISTING URL — fill in', 'Notes — fill in'];

const out = [HEADER.map(esc).join(',')];
let totalRows = 0;

Object.keys(byAgent).sort().forEach(agent => {
  const list = byAgent[agent].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
  const agentTotal = list.reduce((s, r) => s + r.count, 0);
  let running = 0;
  list.forEach((r, i) => {
    running += r.count;
    totalRows++;
    out.push([
      r.agent, i + 1, r.address, r.count, (running / agentTotal * 100).toFixed(0) + '%',
      [...r.names].join('; '), r.first, r.last, [...r.moveIns].sort().join('; '),
      bedsLabel(r.beds), '', '', '', '',
    ].map(esc).join(','));
  });
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n');

console.log(`Wrote ${totalRows} rows → ${OUT}`);
console.log(`Window: last ${DAYS} days (since ${cutoff})\n`);
Object.keys(byAgent).sort().forEach(a => {
  const list = byAgent[a];
  const tot = list.reduce((s, r) => s + r.count, 0);
  const top50 = list.slice().sort((x, y) => y.count - x.count).slice(0, 50).reduce((s, r) => s + r.count, 0);
  console.log(`  ${String(list.length).padStart(4)} addresses  ${String(tot).padStart(4)} leads  ` +
    `(first 50 rows cover ${(top50 / tot * 100).toFixed(0)}%)  ${a}`);
});
