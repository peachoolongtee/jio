'use strict';
// Usage: node build-cdc.js CDC.json cdc-venues.json
// Re-run whenever you get a newer CDC snapshot. Prints a data-quality report.
const fs = require('fs');
const { cleanRecords, buildCdcVenues } = require('./cdc-adapter');
const mock = require('./mock-data.json'); // only for occasion profiles

const [inFile = 'CDC.json', outFile = 'cdc-venues.json'] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const { records, report } = cleanRecords(raw);
const venues = buildCdcVenues({ records }, { profiles: mock.occasionProfiles, snapshot: raw.lastUpdated });
fs.writeFileSync(outFile, JSON.stringify({ _meta: { source: 'CDC vouchers merchant list (GoWhere snapshot)', snapshot: raw.lastUpdated, report: { ...report, invalidCoords: report.invalidCoords.length }, venues: venues.length }, venues }));
const kinds = venues.reduce((m, v) => (m[v.siteKind] = (m[v.siteKind] || 0) + 1, m), {});
console.log(`snapshot ${raw.lastUpdated}: ${report.total} merchants -> ${report.kept} kept (${report.invalidCoords.length} bad coordinates, ${report.duplicates} duplicates)`);
console.log(`food venues: ${venues.length}`, kinds);
console.log('halal hint at', venues.filter(v => v.diet.halal === 'likely').length, 'sites | vegetarian hint at', venues.filter(v => v.diet.vegetarian === 'likely').length, '| budget meal at', venues.filter(v => v.cdc.budgetMealStalls > 0).length);
console.log('wrote', outFile, `(${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
