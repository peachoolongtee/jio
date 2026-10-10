// The saved OneMap snapshot (src/db/mock/onemap-places.json) and what the planner makes of it. These tests read the real
// file, so they catch a bad snapshot, not just bad code: broken photo links, garbled text, contact details, a place listed
// twice, a hawker centre given a neighbour's closure dates, a place that is shut on the day asked.
// Nothing here touches the network.
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlanData, dataAttribution } from '../src/db/venues.js';
import { withinSingapore, nameSimilarity } from '../src/planner/cdc-adapter.js';
import { haversineKm } from '../src/planner/geo.js';
import { filterByConstraints, weekdayOf } from '../src/planner/filters.js';
import { isClosedOn, closureCoverage } from '../src/planner/hawker-closures.js';
import { notInPoolBecause } from '../src/planner/onemap-adapter.js';

const FILE = new URL('../src/db/mock/onemap-places.json', import.meta.url);
const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const data = loadPlanData();
const pool = data.venues.filter((v) => v.source === 'onemap');
const byName = (name) => data.venues.find((v) => v.name === name);

// Names are text too, but a name may hold an "@" ("Heartbeat@Bedok", "Hawker Centre @ Our Tampines Hub"): the copied
// free text is the credit, the description, the opening hours and the address.
const NAME_FIELDS = ['name', 'area'];
const FREE_TEXT_FIELDS = ['photoCredit', 'description', 'openingHoursText'];
const textsOf = (venues, fields = [...NAME_FIELDS, ...FREE_TEXT_FIELDS]) => venues.flatMap((v) => fields.filter((k) => typeof v[k] === 'string').map((k) => ({ id: v.id, field: k, text: v[k] })));

// ---------------------------------------------------------------- the saved file
describe('the saved file', () => {
  test('every photo link is a full https:// address', () => {
    const withPhoto = saved.venues.filter((v) => v.photoUrl !== null);
    expect(withPhoto.length).toBeGreaterThan(100);
    for (const v of withPhoto) expect(v.photoUrl, v.id).toMatch(/^https:\/\/[^/]+\./);
    for (const v of saved.venues.filter((x) => x.website !== null)) expect(v.website, v.id).toMatch(/^https:\/\//);
  });

  test('no name, credit or description is garbled or carries an HTML tag', () => {
    for (const { id, field, text } of textsOf(saved.venues)) {
      expect(text, `${id} ${field}`).not.toMatch(/Â|â„¢|â€|�/);
      expect(text, `${id} ${field}`).not.toMatch(/<\/?[a-z]/i);
      expect(text, `${id} ${field}`).not.toMatch(/&(?:amp|nbsp|reg|trade|copy);/);
    }
  });

  test('no address ends "Singapore 0", and every postal code is six digits', () => {
    for (const v of saved.venues) {
      expect(v.address ?? '', v.id).not.toMatch(/Singapore 0$/);
      if (v.postalCode !== null) expect(v.postalCode, v.id).toMatch(/^\d{6}$/);
      const inAddress = /Singapore (\d+)$/.exec(v.address ?? '');
      if (inAddress) expect(inAddress[1], v.id).toMatch(/^\d{6}$/);
    }
  });

  test('no address holds an email address (a building may be called "Heartbeat@Bedok")', () => {
    for (const { id, text } of textsOf(saved.venues, ['address'])) expect(text, id).not.toMatch(/\S+@\S+\.\S+/);
  });

  test('no free text holds an email address or a phone number', () => {
    for (const { id, field, text } of textsOf(saved.venues, FREE_TEXT_FIELDS)) {
      expect(text, `${id} ${field}`).not.toContain('@');
      expect(text, `${id} ${field}`).not.toMatch(/(?:\+65|\b)[3689]\d{3}[\s-]?\d{4}\b/);
    }
  });

  test('no description is only a programme code', () => {
    for (const v of saved.venues) expect(v.description ?? 'ok', v.id).not.toMatch(/^(?:[A-Z]{1,6}|HUP\b.*|New (?:Replacement )?Centre|Opted out of HUP|Not eligible for HUP|Upgraded prior to HUP)$/);
  });

  test('every place and every closure row is inside Singapore', () => {
    for (const v of saved.venues) expect(withinSingapore(v), v.id).toBe(true);
    for (const c of saved.hawkerClosures) expect(withinSingapore(c), c.name).toBe(true);
  });

  test('the attribution names both sources, the licence and the day the snapshot was taken', () => {
    const text = data._meta.onemap.attribution;
    expect(text).toContain('OneMap');
    expect(text).toContain('National Environment Agency');
    expect(text).toContain('Singapore Open Data Licence');
    expect(text).toContain(saved._meta.fetchedAt.slice(0, 10));
    expect(dataAttribution(undefined)).toContain('accessed unknown date');
  });
});

// ---------------------------------------------------------------- what reaches the planner
describe('the planner\'s pool of OneMap places', () => {
  // Genuinely different places that sit close together and have alike names. Each stays as its own venue.
  const DIFFERENT_NEIGHBOURS = [
    // Same name, different kind of place: a sport centre and a hawker centre built together, a park and a hawker centre.
    ['onemap_sportsg_sport_facilities_bukit-canberra-sport-centre', 'onemap_ssot_hawkercentres_bukit-canberra-hawker-centre'],
    ['onemap_nationalparks_market-street-park', 'onemap_ssot_hawkercentres_market-street-hawker-centre'],
    ['onemap_nationalparks_pek-kio-park', 'onemap_ssot_hawkercentres_cambridge-road-blk-41a-pek-kio-market-and-food-centre'],
    ['onemap_theatre_festive-arts-theatre-our-tampines-hub', 'onemap_ssot_hawkercentres_hawker-centre-our-tampines-hub'],
    // NEA lists each hawker block as its own centre.
    ['onemap_ssot_hawkercentres_redhill-lane-blk-79-redhill-market', 'onemap_ssot_hawkercentres_redhill-lane-blk-85-redhill-food-centre'],
    ['onemap_ssot_hawkercentres_telok-blangah-drive-blk-79-telok-blangah-food-centre', 'onemap_ssot_hawkercentres_telok-blangah-drive-blk-82-telok-blangah-market'],
    ['onemap_ssot_hawkercentres_west-coast-drive-blk-502-ayer-rajah-market', 'onemap_ssot_hawkercentres_west-coast-drive-blk-503-ayer-rajah-food-centre'],
    // Separate listings in one theme: three libraries at the National Library Building, two parks a few doors apart.
    ['onemap_libraries_central-library', 'onemap_libraries_central-arts-library'],
    ['onemap_nationalparks_lorong-marican-park', 'onemap_nationalparks_lorong-marzuki-park'],
    // A square, a gallery and a theatre round Kreta Ayer; a cable car station and the park it climbs; two Art Museum sites.
    ['onemap_tourism_kreta-ayer-square', 'onemap_museum_kreta-ayer-heritage-gallery'],
    ['onemap_tourism_kreta-ayer-square', 'onemap_theatre_kreta-ayer-people-s-theatre'],
    ['onemap_tourism_cable-car-singapore-mount-faber', 'onemap_nationalparks_mount-faber-park'],
    ['onemap_tourism_sam-at-8q-singapore-art-museum', 'onemap_tourism_singapore-art-museum'],
  ].map((pair) => pair.sort().join('|'));

  test('no two OneMap places within 100 m have alike names, apart from the listed neighbours', () => {
    const found = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (haversineKm(pool[i], pool[j]) * 1000 <= 100 && nameSimilarity(pool[i].name, pool[j].name) >= 0.4) found.push([pool[i].id, pool[j].id].sort().join('|'));
      }
    }
    expect(found.filter((pair) => !DIFFERENT_NEIGHBOURS.includes(pair))).toEqual([]);
    // The list holds only pairs that are really there, so it cannot hide a later duplicate by being too long.
    expect(DIFFERENT_NEIGHBOURS.filter((pair) => !found.includes(pair))).toEqual([]);
  });

  test('the places listed twice are one place now, and the one kept has the opening hours or the photo', () => {
    for (const needle of ['Esplanade Theatre', 'Peranakan Museum', 'Asian Civilisations Museum', 'Malay Heritage Centre', 'Victoria Theatre', 'Labrador Nature Reserve']) {
      expect(pool.filter((v) => v.name.includes(needle)), needle).toHaveLength(1);
    }
    // These are in the hand-made lists too: one venue in all, and it is not the OneMap row.
    for (const needle of ['National Museum of Singapore', 'Fort Canning Park']) {
      const all = data.venues.filter((v) => v.name === needle);
      expect(all, needle).toHaveLength(1);
      expect(all[0].source, needle).not.toBe('onemap');
    }
    // Marina Bay Sands was three rows.
    expect(pool.filter((v) => /^Marina Bay Sands/.test(v.name) && v.kind === 'attraction')).toHaveLength(1);
    const esplanade = pool.find((v) => /esplanade/i.test(v.name));
    expect(esplanade.dataQuality.hoursAssumed).toBe(false);
    expect(esplanade.photoUrl).not.toBeNull();
    expect(esplanade.id).toBe('onemap_tourism_esplanade-theatres-on-the-bay');
  });

  test('a curated hawker centre and its OneMap twin are one venue (Chinatown Complex, Kovan 209)', () => {
    expect(data.venues.filter((v) => /chinatown complex/i.test(v.name))).toHaveLength(1);
    expect(data.venues.filter((v) => /kovan/i.test(v.name) && v.category === 'eat')).toHaveLength(1);
    expect(data.venues.filter((v) => /kovan/i.test(v.name) && v.category === 'eat')[0].source).toBe('curated');
  });

  test('a hawker centre shows the name in its bracket; the official name is kept for the closure dates', () => {
    const redhill = pool.find((v) => v.officialName === 'Redhill Lane Blk 79 (Redhill Market)');
    expect(redhill.name).toBe('Redhill Market');
    expect(redhill.id).toBe('onemap_ssot_hawkercentres_redhill-lane-blk-79-redhill-market'); // the id does not change
    // A well-known name before the bracket stays (the name in the bracket is only an alias there).
    expect(pool.some((v) => v.name === 'Amoy Street Food Centre (Telok Ayer Food Centre)')).toBe(true);
    expect(pool.some((v) => v.name === 'Sembawang Hills Food Centre (Jalan Leban Food Centre)')).toBe(true);
  });

  test('places a group cannot go to stay in the file but not in the pool', () => {
    const ids = new Set(pool.map((v) => v.id));
    const left = saved.venues.filter((v) => notInPoolBecause(v));
    expect(left.length).toBe(data._meta.sources.onemapExcluded);
    for (const v of left) { expect(ids.has(v.id), v.id).toBe(false); expect(saved.venues.some((s) => s.id === v.id)).toBe(true); }
    expect(pool.some((v) => /interim park/i.test(v.name))).toBe(false);
    expect(pool.some((v) => /^Pulau (Sekudu|Unum)$/.test(v.name))).toBe(false);
    for (const name of ['Maghain Aboth Synagogue', 'NUS Baba House - Singapore Peranakan Architecture']) {
      expect(saved.venues.some((v) => v.name === name), name).toBe(true);
      expect(data.venues.some((v) => v.name === name), name).toBe(false);
    }
  });

  test('theatres: the public ones stay; community club, school and polytechnic halls, auditoriums, amphitheatres, mini theatres and studios go', () => {
    const kept = pool.filter((v) => v.oneMapTheme === 'theatre').map((v) => v.name).sort();
    expect(kept).toEqual([
      'Alliance Francaise Theatre', 'Capitol Theatre', 'China Cultural Centre Theatre', 'Drama Centre Theatre', 'Festive Arts Theatre @ Our Tampines Hub',
      'Gateway Theatre', 'KC Arts Centre (SRT)', 'Kallang Theatre', "Kreta Ayer People's Theatre", 'LASALLE Singapore Airlines Theatre',
      'MBS Sands Theatre', 'Marina Bay Sands (MBS) Grand Theatre', 'NAFA Lee Foundation Theatre', 'SCAPE Ground Theatre', 'SOTA Drama Theatre',
      'The Ngee Ann Kongsi Theatre (Wild Rice @ Funan)', 'The Theatre at Mediacorp', '72-13 Theatre',
    ].sort());
    const dropped = saved.venues.filter((v) => v.oneMapTheme === 'theatre' && !kept.includes(v.name)).map((v) => v.name);
    // 16 are set aside by rule, and the two Esplanade / Victoria rows are the same places as attractions.
    expect(dropped).toHaveLength(18);
    expect(dropped.filter((n) => notInPoolBecause({ oneMapTheme: 'theatre', name: n }))).toHaveLength(16);
  });

  test('every CDC site a OneMap hawker centre replaced is gone, and the centre keeps what it knew', () => {
    const centres = pool.filter((v) => v.kind === 'hawker');
    expect(centres.length).toBeGreaterThan(100);
    for (const v of centres) {
      expect(v.cdcAccepted, v.name).toBe(true);
      expect(data.venues.some((x) => x.id === v.cdc.siteId), `${v.name}: CDC copy ${v.cdc.siteId} still there`).toBe(false);
      expect(v.stalls.length, v.name).toBeGreaterThan(0);
    }
    expect(data._meta.sources.cdcMergedIntoOnemap).toBe(centres.length);
    // A name that says neither "market" nor "food centre" is still a centre.
    const block = pool.find((v) => v.officialName === undefined && v.name === 'Toa Payoh Lorong 4 Blk 93');
    expect(block.cdcAccepted).toBe(true);
    expect(data.venues.filter((v) => v.id === 'cdc_310093')).toHaveLength(0);
    // The example from the audit: the OneMap copy keeps the CDC site's name-derived halal and vegetarian.
    const northBridge = byName('North Bridge Road Market');
    expect([northBridge.diet.halal, northBridge.diet.vegetarian]).toEqual(['likely', 'likely']);
    const strict = filterByConstraints([northBridge], { members: [{ id: 'a', dietary: ['halal', 'vegetarian'] }], dateTime: '2026-10-13T12:30', categories: ['eat'] });
    expect(strict.passed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- opening hours: days of the week
describe('days a place is closed', () => {
  const ask = (venue, dateTime) => filterByConstraints([venue], { members: [{ id: 'a' }], dateTime, categories: ['activity'], unknownPolicy: 'lenient' });
  const heritage = pool.find((v) => /^Eurasian Heritage Centre/.test(v.name));

  test('Eurasian Heritage Centre ("Closed on Monday") is unfit on a Monday and fits on a Tuesday', () => {
    expect(ask(heritage, '2026-10-12T10:00').rejected[0].reasons).toEqual(['closed']);
    expect(ask(heritage, '2026-10-13T10:00').passed).toHaveLength(1);
  });

  test('the other places that say "Closed on Monday" are left out on a Monday too', () => {
    const names = ['Reflections at Bukit Chandu', 'Gillman Barracks', 'Institute of Contemporary Arts', 'Sun Yat Sen Memorial Hall', 'Malay Heritage Centre', 'Contemporary Arts Center'];
    for (const prefix of names) {
      const v = pool.find((x) => x.name.startsWith(prefix));
      expect(v, prefix).toBeDefined();
      expect(ask(v, '2026-10-12T13:00').passed, `${prefix} on Monday`).toHaveLength(0);
      expect(ask(v, '2026-10-14T13:00').passed, `${prefix} on Wednesday`).toHaveLength(1);
    }
  });

  test('a place that is not said to be closed on a day is not left out on it (Singapore Botanic Gardens)', () => {
    const botanic = pool.find((v) => v.name === 'Singapore Botanic Gardens');
    expect(botanic.closedWeekdays).toEqual([]);
    expect(ask(botanic, '2026-10-12T10:00').passed).toHaveLength(1);
  });

  describe('the weekday is the calendar date asked for, in whatever time zone the machine is', () => {
    const original = process.env.TZ;
    afterEach(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });
    // The zone's offset from UTC in minutes (west is positive) on that day, to prove the zone really changed.
    test.each([['Pacific/Kiritimati', -840], ['America/Los_Angeles', 420], ['Asia/Singapore', -480], ['UTC', 0]])('in %s', (zone, offset) => {
      process.env.TZ = zone;
      expect(new Date(2026, 9, 12, 12).getTimezoneOffset()).toBe(offset);
      expect(weekdayOf('2026-10-12T00:30')).toBe(1);
      expect(weekdayOf('2026-10-12T23:30')).toBe(1);
      expect(weekdayOf('2026-10-11')).toBe(0);
      expect(ask(heritage, '2026-10-12T00:30').passed).toHaveLength(0);
      expect(ask(heritage, '2026-10-13T23:30').passed).toHaveLength(0); // open 9am to 6pm: shut by the hour, not by the day
      expect(ask(heritage, '2026-10-13T10:00').passed).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------- hawker closure dates
describe('hawker closure dates', () => {
  const rowsByName = new Map(saved.hawkerClosures.map((c) => [c.name, c]));
  const eat = (venue, date) => filterByConstraints([venue], { members: [{ id: 'a' }], dateTime: `${date}T12:30`, categories: ['eat'], unknownPolicy: 'lenient' });

  test('each OneMap hawker centre has the closures of one NEA row: its own', () => {
    const centres = pool.filter((v) => v.kind === 'hawker');
    for (const v of centres) {
      const row = rowsByName.get(v.closuresFrom);
      expect(row, v.name).toBeDefined();
      expect(v.closures, v.name).toEqual(row.periods);
    }
    // No two centres took the same row.
    expect(new Set(centres.map((v) => v.closuresFrom)).size).toBe(centres.length);
  });

  test('the audit\'s neighbours: Toa Payoh Lorong 4 Blk 93, and the Ang Mo Kio blocks, get only their own dates', () => {
    const block93 = byName('Toa Payoh Lorong 4 Blk 93');
    expect(block93.closuresFrom).toBe('Toa Payoh Lorong 4 Blk 93');
    expect(block93.closures).toHaveLength(rowsByName.get('Toa Payoh Lorong 4 Blk 93').periods.length);
    // Before, Blk 93 also took the dates of its neighbours: 7 to 9 November, and Blk 210's 12 to 14 October.
    expect(eat(block93, '2026-11-08').passed).toHaveLength(1);
    expect(eat(block93, '2026-10-13').passed).toHaveLength(1);
    // Blk 210's own dates (12 to 14 October) go to its CDC site, the large one, and to nobody else.
    const lorong8 = data.venues.find((v) => v.id === 'cdc_310210');
    expect(lorong8.closuresFrom).toBe('Toa Payoh Lorong 8 Blk 210');
    expect(eat(lorong8, '2026-10-13').rejected[0].reasons).toEqual(['closed_for_cleaning']);
    expect(eat(lorong8, '2026-11-08').passed).toHaveLength(1);
    for (const name of ['Mayflower Market', 'Ang Mo Kio 628 Market', 'Blk 724 Ang Mo Kio Market']) {
      const v = byName(name);
      expect(v.closures, name).toEqual(rowsByName.get(v.officialName).periods);
    }
  });

  test('East Coast Lagoon Food Village is closed 12 to 14 October 2026 and open on the 11th and 15th', () => {
    const lagoon = byName('East Coast Lagoon Food Village');
    for (const date of ['2026-10-12', '2026-10-13', '2026-10-14']) expect(eat(lagoon, date).rejected[0].reasons, date).toEqual(['closed_for_cleaning']);
    for (const date of ['2026-10-11', '2026-10-15']) expect(eat(lagoon, date).passed, date).toHaveLength(1);
    expect(isClosedOn(lagoon, '2026-10-12')).toBe(true);
  });

  test('a curated centre takes the one nearest row (Whampoa Makan Place, Chinatown Complex, Kovan 209)', () => {
    for (const [name, row] of [['Whampoa Makan Place', 'Whampoa Drive Blk 91/92 (Whampoa Drive Makan Place/Whampoa Market)'], ['Chinatown Complex Food Centre', 'Smith Street Blk 335 (Chinatown Complex Market)'], ['Kovan 209 Market and Food Centre', 'Hougang Street 21 Blk 209 (Kovan Hougang Market and Food Centre)']]) {
      const v = byName(name);
      expect(v.closuresFrom, name).toBe(row);
      expect(v.closures, name).toEqual(rowsByName.get(row).periods);
    }
  });

  test('the one row that matches no venue is Bukit Timah Market, whose coordinates are 2.9 km from any hawker centre OneMap lists', () => {
    expect(data._meta.closures.rowsWithoutVenue).toEqual(['Bukit Timah Market']);
  });

  test('the range the dates cover is reported', () => {
    const own = closureCoverage(saved.hawkerClosures);
    expect(data._meta.closures).toMatchObject({ from: own.from, to: own.to, lastCleaning: own.lastCleaning, rows: saved.hawkerClosures.length, periods: own.periods });
    expect(data._meta.closures.lastCleaning < '2027-01-01').toBe(true);
    expect(data._meta.closures.stale).toBe(false);
  });

  describe('the warning that the dates are running out', () => {
    let warn;
    const load = (today) => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fresh = loadPlanData({ fresh: true, today });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      return { fresh, lines };
    };
    test('is logged once, naming the rebuild command, when today is past the last cleaning date', () => {
      const { fresh, lines } = load('2027-01-05');
      const stale = lines.filter((l) => /closure dates/i.test(l));
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain('pnpm build:onemap-places');
      expect(stale[0]).toMatch(/ended 2026-12-30, 6 days ago/);
      expect(fresh._meta.closures.stale).toBe(true);
    });
    test('is logged within 30 days of the last cleaning date', () => {
      const { lines } = load('2026-12-01');
      expect(lines.filter((l) => /closure dates end 2026-12-30, in 29 days/i.test(l))).toHaveLength(1);
    });
    test('is not logged on 2026-10-11, or 31 days before the end', () => {
      expect(load('2026-10-11').lines.filter((l) => /closure dates/i.test(l))).toEqual([]);
      expect(load('2026-11-29').lines.filter((l) => /closure dates/i.test(l))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------- a missing snapshot
describe('a missing snapshot file', () => {
  test('loads without OneMap places, with one warning that names the rebuild command', () => {
    const real = fs.existsSync;
    const exists = vi.spyOn(fs, 'existsSync').mockImplementation((path) => (String(path).endsWith('onemap-places.json') ? false : real(path)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const without = loadPlanData({ fresh: true });
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => /onemap-places\.json is missing/.test(l))).toHaveLength(1);
      expect(lines.join('\n')).toContain('pnpm build:onemap-places');
      expect(without.venues.some((v) => v.source === 'onemap')).toBe(false);
      expect(without._meta.onemap).toBeNull();
      expect(without._meta.sources.hawkerClosures).toBe(0);
    } finally {
      exists.mockRestore();
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- the repair mode of the build script
describe('build-onemap-places --repair', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/build-onemap-places.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'jio-onemap-'));
  const copy = join(dir, 'places.json');
  const garbled = JSON.parse(JSON.stringify(saved));
  Object.assign(garbled.venues[0], { name: 'Marina Bay SandsÂ®', photoUrl: 'www.example.com/a.jpg', photoCredit: 'Â©Someone', address: '1 Road, Singapore 38981', postalCode: '38981', description: 'HUP Rebuilding', openingHoursText: 'Daily. Email a@b.sg' });
  garbled.venues[1].photoUrl = '/content/dam/x.jpg';
  const run = () => execFileSync(process.execPath, [SCRIPT, '--repair', '--file', copy], { encoding: 'utf8' });

  test('fixes the saved values, changes nothing else, and a second run changes no byte', () => {
    writeFileSync(copy, JSON.stringify(garbled, null, 1) + '\n');
    run();
    const once = readFileSync(copy, 'utf8');
    const repaired = JSON.parse(once);
    expect(repaired.venues[0]).toMatchObject({ name: 'Marina Bay Sands®', photoUrl: 'https://www.example.com/a.jpg', photoCredit: '©Someone', address: '1 Road, Singapore 038981', postalCode: '038981', description: null, openingHoursText: 'Daily.' });
    expect(repaired.venues[1].photoUrl).toBeNull();
    expect(repaired.venues[1].photoCredit).toBeNull();
    // Everything else: the metadata (fetchedAt), the closure dates, the ids and the order.
    expect(repaired._meta).toEqual(garbled._meta);
    expect(repaired.hawkerClosures).toEqual(garbled.hawkerClosures);
    expect(repaired.venues.map((v) => v.id)).toEqual(garbled.venues.map((v) => v.id));
    expect(repaired.venues[5]).toEqual(garbled.venues[5]);
    run();
    expect(readFileSync(copy, 'utf8')).toBe(once);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the real saved file is already repaired: another run changes no byte', () => {
    const real = join(mkdtempSync(join(tmpdir(), 'jio-onemap-real-')), 'places.json');
    fs.copyFileSync(FILE, real);
    execFileSync(process.execPath, [SCRIPT, '--repair', '--file', real]);
    expect(readFileSync(real, 'utf8')).toBe(readFileSync(FILE, 'utf8'));
    rmSync(join(real, '..'), { recursive: true, force: true });
  });
});
