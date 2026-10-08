// Builds the CDC venue layer the engine reads, from the raw GoWhere snapshot.
// Usage (from backend/): pnpm build:cdc [in=data/CDC.json] [out=src/db/mock/cdc-venues.json]
// Re-run whenever you get a newer CDC snapshot. Prints a data-quality report.
// The raw CDC.json (11.5 MB) is gitignored; the output cdc-venues.json is committed.
import fs from 'node:fs';
import { cleanRecords, buildCdcVenues } from '../src/planner/cdc-adapter.js';

const mock = JSON.parse(fs.readFileSync(new URL('../src/db/mock/mock-data.json', import.meta.url), 'utf8')); // only for occasion profiles

const [inFile = 'data/CDC.json', outFile = 'src/db/mock/cdc-venues.json'] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const { records, report } = cleanRecords(raw);
const venues = buildCdcVenues({ records }, { profiles: mock.occasionProfiles, snapshot: raw.lastUpdated });
fs.writeFileSync(outFile, JSON.stringify({ _meta: { source: 'CDC vouchers merchant list (GoWhere snapshot)', snapshot: raw.lastUpdated, report: { ...report, invalidCoords: report.invalidCoords.length }, venues: venues.length }, venues }));
const kinds = venues.reduce((m, v) => (m[v.siteKind] = (m[v.siteKind] || 0) + 1, m), {});
console.log(`snapshot ${raw.lastUpdated}: ${report.total} merchants -> ${report.kept} kept (${report.invalidCoords.length} bad coordinates, ${report.duplicates} duplicates)`);
console.log(`food venues: ${venues.length}`, kinds);
console.log('halal hint at', venues.filter(v => v.diet.halal === 'likely').length, 'sites | vegetarian hint at', venues.filter(v => v.diet.vegetarian === 'likely').length, '| budget meal at', venues.filter(v => v.cdc.budgetMealStalls > 0).length);
console.log('wrote', outFile, `(${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
