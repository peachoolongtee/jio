// Converts the frontend's mock places into data files the backend engine reads.
// Usage (from any working directory): pnpm --dir backend build:venues [venues.js] [places.js]
//   defaults: ../frontend/src/lib/mock/venues.js and ../frontend/src/lib/mock/places.js
// Writes src/db/mock/curated-venues.json (155 places in engine format) and src/db/mock/areas.json
// (the MRT stations and neighbourhoods the frontend uses as meeting-area candidates).
// Re-run whenever the frontend team edits their venue or area list, then commit both JSON files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromFrontendVenue } from '../src/planner/venue-adapter.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendPath = file => path.isAbsolute(file) ? file : path.resolve(backendDir, file);
const [venuesFile = '../frontend/src/lib/mock/venues.js', placesFile = '../frontend/src/lib/mock/places.js'] = process.argv.slice(2);
const { VENUES } = await import(pathToFileURL(backendPath(venuesFile)).href);
const { AREAS } = await import(pathToFileURL(backendPath(placesFile)).href);

const venues = VENUES.map(fromFrontendVenue);
const meta = source => ({ source, convertedBy: 'backend/scripts/build-venues.js', note: 'Do not edit by hand: edit the frontend file and re-run pnpm build:venues.' });
const venuesOutput = backendPath('src/db/mock/curated-venues.json');
const areasOutput = backendPath('src/db/mock/areas.json');
fs.writeFileSync(venuesOutput, JSON.stringify({ _meta: meta('frontend/src/lib/mock/venues.js'), venues }, null, 1) + '\n');
fs.writeFileSync(areasOutput, JSON.stringify({ _meta: meta('frontend/src/lib/mock/places.js (AREAS)'), areas: AREAS }, null, 1) + '\n');

const byCategory = venues.reduce((m, v) => ((m[v.category] = (m[v.category] || 0) + 1), m), {});
console.log(`wrote ${venues.length} curated venues`, byCategory, `and ${AREAS.length} areas`);
