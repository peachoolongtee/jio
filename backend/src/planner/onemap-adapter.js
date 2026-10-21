// onemap-adapter.js: turns places from OneMap's themes into engine venues.
//
// OneMap (Singapore Land Authority) publishes government place lists as "themes": SportSG sport centres,
// tourist attractions, museums, libraries, theatres, parks and hawker centres. They say WHERE a place is, and
// sometimes its photo, opening hours and description, but never its price, rating or diet. Anything a theme
// does not say is a DEFAULT for that kind of place or UNKNOWN, and dataQuality says which, the same way the
// frontend's places are converted (venue-adapter.js).
//
// Data: OneMap themes, Singapore Land Authority, used under the Singapore Open Data Licence.
// Fetched by backend/scripts/build-onemap-places.js; this file only converts.

import { approxRegion, titleCase, withinSingapore } from './cdc-adapter.js';
import { haversineKm } from './geo.js';
import { KIND_DEFAULTS } from './venue-adapter.js';

/**
 * The OneMap themes Jio uses, and what each becomes. Monuments and community clubs are left out on purpose:
 * most monuments are buildings to look at, not places to spend an afternoon, and community clubs are mostly classes.
 *   hours    used when the theme gives none (labelled hoursAssumed)
 *   price    typical SGD per person (labelled priceAssumed)
 */
const THEMES = {
  sportsg_sport_facilities: { category: 'activity', kind: 'sports', hours: [['07:00', '22:00']], price: 5, setting: 'mixed', exposure: 3 },
  tourism: { category: 'activity', kind: 'attraction', hours: [['09:00', '18:00']], price: 15, setting: 'mixed', exposure: 2 },
  museum: { category: 'activity', kind: 'museum', hours: [['10:00', '19:00']], price: 10, setting: 'indoor', exposure: 1 },
  libraries: { category: 'activity', kind: 'library', hours: [['10:00', '21:00']], price: 0, setting: 'indoor', exposure: 1 },
  theatre: { category: 'activity', kind: 'theatre', hours: [['10:00', '23:00']], price: 40, setting: 'indoor', exposure: 1 },
  nationalparks: { category: 'activity', kind: 'park', hours: [['07:00', '22:00']], price: 0, setting: 'outdoor', exposure: 5 },
  ssot_hawkercentres: { category: 'eat', kind: 'hawker', hours: [['07:00', '21:00']], price: 6, setting: 'mixed', exposure: 1 },
};
const THEME_NAMES = Object.keys(THEMES);

// A theatre is like a cinema for the planner (quiet, seated, evening). Added here so venue-adapter's table stays the frontend's.
const DEFAULTS = { ...KIND_DEFAULTS, theatre: KIND_DEFAULTS.cinema };
const ATTRIBUTE_KEYS = ['quiet', 'romantic', 'cozy', 'lively', 'privacy', 'workFriendly', 'celebration'];

// ---------------------------------------------------------------- repairing copied text
// OneMap's text is sometimes UTF-8 that was read as Windows-1252 ("â€“" for "–", "Â®" for "®", "â„¢" for "™"). The
// repair is a real re-decode, not a list of patterns: find each run of characters that could be the bytes of one
// UTF-8 character, turn the characters back into bytes, and decode them. A list covers the dashes and quotes someone
// has already met; the re-decode covers every symbol and accent, and it fails safe, because a run that is not valid
// UTF-8 is left exactly as it was.
const CP1252_BYTE = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91],
  [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98],
  [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);
// A continuation byte (0x80-0xBF) as Windows-1252 shows it: U+0080-U+00BF as they are, the rest through the table.
const CONTINUATION = `[\\u0080-\\u00BF${[...CP1252_BYTE].filter(([, b]) => b <= 0xBF).map(([c]) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`;
const MOJIBAKE_RUN = new RegExp(`[\\u00C2-\\u00DF]${CONTINUATION}|[\\u00E0-\\u00EF]${CONTINUATION}{2}|[\\u00F0-\\u00F4]${CONTINUATION}{3}`, 'g');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * One run of mojibake -> the character it was, or the run itself when the bytes are not valid UTF-8.
 *
 * How to call:
 *   redecodeRun('Â®') // '®'
 */
function redecodeRun(run) {
  const bytes = Uint8Array.from([...run], ch => { const c = ch.codePointAt(0); return c <= 0xFF ? c : CP1252_BYTE.get(c); });
  try { return UTF8.decode(bytes); } catch { return run; }
}

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&apos;': "'", '&reg;': '®', '&trade;': '™', '&copy;': '©' };
// Tags that end a line or a block become a space; the rest (<sup>, <b>) are taken out without leaving a gap.
const BLOCK_TAG = /<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td)\b(?:\s[^<>]*)?\/?>?/gi;
const INLINE_TAG = /<\/?(?:sup|sub|b|i|u|em|strong|span|a|font|small)\b(?:\s[^<>]*)?\/?>?/gi;

/**
 * Copied text made clean: UTF-8 read as Windows-1252 put back, a lost apostrophe ("nation�s") restored, HTML tags
 * and entities taken out, blanks collapsed. A tag that lost its closing bracket ("SkyPark<sup" then a symbol) is removed too.
 *
 * How to call:
 *   fixText('Marina Bay SandsÂ®')              // 'Marina Bay Sands®'
 *   fixText('Daily, 9am â€“ 6pm')              // 'Daily, 9am – 6pm'
 *   fixText('Sands<sup>®</sup> SkyPark')       // 'Sands® SkyPark'
 */
function fixText(s) {
  return String(s ?? '')
    .replace(MOJIBAKE_RUN, redecodeRun)
    .replace(/â€\u009d|â€/g, '"') // A cut-off quote: the last byte was lost, so the re-decode cannot read it.
    .replace(/(?<=\p{L})�(?=(?:s|t|re|ll|ve|d|m)(?![\p{L}]))/gu, '’') // "nation�s": the apostrophe was replaced when copied
    .replace(BLOCK_TAG, ' ')
    .replace(INLINE_TAG, '')
    .replace(/&(?:amp|nbsp|quot|apos|reg|trade|copy);/g, e => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
}

// Contact details are not ours to republish: an email address or a phone number in a place's free text is removed.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?:\(?\+\s?65\)?[\s-]?)?(?<![\d.])[3689]\d{3}[\s-]?\d{4}(?!\d)(?:\s*\(\s*ext\.?\s*\d+\s*\))?/gi;
const CONTACT_CUE = /\b(?:e-?mail|call|tel|telephone|phone|contact|whatsapp|enquir\w*|inquir\w*|reach)\b/i;
const MARK = '\u0001';

/**
 * Free text without email addresses or phone numbers. A sentence that gives a contact ("For more information, email
 * x@y.sg or call +65 6337 2189 (ext. 103)") goes whole, because what is left of it is no sentence; a bare number or
 * address elsewhere is just taken out.
 *
 * How to call:
 *   stripContacts('By appointment. For more information, email a@b.sg or call 6337 2189.') // 'By appointment.'
 */
function stripContacts(text) {
  const marked = String(text ?? '').replace(EMAIL, MARK).replace(PHONE, MARK);
  if (!marked.includes(MARK)) return marked.trim();
  return marked.split(/(?<=[.!?])\s+/)
    .filter(sentence => !(sentence.includes(MARK) && CONTACT_CUE.test(sentence)))
    .join(' ').replaceAll(MARK, '').replace(/\s+/g, ' ').trim();
}

/** Copied free text (a description, a credit, opening hours): fixText, then no contact details. */
const freeText = s => stripContacts(fixText(s));

// OneMap's short park words, written out: "TRAS LINK PK" -> "Tras Link Park".
const ABBREVIATIONS = [[/\bPK\b/g, 'PARK'], [/\bGDN\b/g, 'GARDEN'], [/\bRD\b/g, 'ROAD'], [/\bAVE\b/g, 'AVENUE'], [/\bST\b/g, 'STREET'], [/\bDR\b/g, 'DRIVE']];

/**
 * A display name: mojibake fixed, ALL-CAPS names title-cased, park abbreviations written out, and project notes
 * like "(FCP)" or "(Phase 1)" dropped.
 *
 * How to call:
 *   cleanName('FARQUHAR GARDEN (FCP)') // 'Farquhar Garden'
 *   cleanName('TRAS LINK PK')          // 'Tras Link Park'
 */
function cleanName(name) {
  let s = fixText(name).replace(/\s*\((FCP|PHASE \d+|PLOT \d+)\)/gi, '');
  if (s === s.toUpperCase()) {
    for (const [re, word] of ABBREVIATIONS) s = s.replace(re, word);
    s = titleCase(s);
  }
  return plainName(s);
}

/**
 * Parks: keep real parks, gardens and nature areas; drop playgrounds (PG), fitness corners (FC), open spaces (OS)
 * and neighbourhood pocket parks written "PK", which would flood every activity list.
 *
 * How to call:
 *   isRealPark('BISHAN-ANG MO KIO PARK') // true
 *   isRealPark('GROVE LANE PG')          // false
 */
function isRealPark(name) {
  const n = name.toUpperCase();
  if (/\b(PG|FC|OS|PLAYGROUND|FITNESS|PK|WORKSITE)\b|CAR ?PARK|INTERIM BOUNDARY/.test(n)) return false;
  return /\b(PARK|GARDENS?|RESERVE|NATURE|BEACH|RESERVOIR|WETLANDS?|CREEK|PULAU|HILL|TRAIL|ISLAND)\b/.test(n);
}

/** Hawker centres: only the ones open now. */
const isOpenHawkerCentre = row => /^existing/i.test(row.STATUS ?? '');

/**
 * "9.30am", "12pm", "7 pm", "24:00" -> "09:30", "12:00", "19:00". null when it is not a time.
 *
 * How to call:
 *   toClock('9.30am') // '09:30'
 *   toClock('hello')  // null
 */
function toClock(text) {
  const m = /^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm|noon)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = (m[3] ?? '').toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (ampm === '' && !m[2]) return null; // a bare number is not a time
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Reads OneMap's free-text opening hours into the engine's ranges, or null when it cannot.
 * "Daily from 7am – 12pm, and 6pm – 9pm" -> [['07:00','12:00'], ['18:00','21:00']]. "Daily, 24 hours" -> all day.
 * Different days' hours are combined into one set of ranges (the engine's `openingHours` has no weekdays), keeping the
 * SHORTER closing time for the same opening time: it may hide a late opening, but never suggests a place that is
 * closed at that hour. What this does NOT know: which weekday has which hours. A plain "Closed on Monday" is read
 * separately (closedWeekdaysOf); "Friday to Saturday till 10pm" or "closed on public holidays" are not, so on those
 * days a place can be suggested that is shut.
 *
 * How to call:
 *   parseOpeningHoursText('Monday to Saturday, 9am – 5pm') // [['09:00', '17:00']]
 */
function parseOpeningHoursText(text) {
  const s = fixText(text);
  if (!s) return null;
  if (/24\s*hours|24\s*\/\s*7/i.test(s)) return [['00:00', '24:00']];
  const ranges = [];
  const re = /(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm|noon))\s*(?:–|-|to)\s*(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm|noon))/gi;
  for (const m of s.matchAll(re)) {
    const open = toClock(m[1]), close = toClock(m[2]);
    if (open && close && open !== close) ranges.push([open, close]);
  }
  if (ranges.length === 0) return null;
  const byOpen = new Map();
  for (const [open, close] of ranges) if (!byOpen.has(open) || close < byOpen.get(open)) byOpen.set(open, close);
  return [...byOpen].sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------- days of the week a place is shut
const DAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?';
const CLOSED_ON = new RegExp(`\\bclose[ds]?\\s+(?:on\\s+|every\\s+|each\\s+)?(${DAY}(?:\\s*(?:,|and|&|or|/|to|-|–)\\s*${DAY})*)\\b`, 'gi');
const DAY_NUMBER = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * The weekdays a place's opening-hours text says it is closed on, as numbers (0 = Sunday ... 6 = Saturday), sorted.
 * Reads plain statements only: "Closed on Monday", "Galleries closed on Monday and public holidays", "Closed every Sunday
 * and Monday", "closed on Mon to Tue". It does NOT read public holidays, or which days a place is open ("Tuesday to
 * Sunday" with nothing said about Monday). A text that also says "Daily" is skipped: it lists several parts with
 * their own hours (Singapore Botanic Gardens: "Daily, 5am - 12am ... Jacob Ballas Children's Garden: closed every
 * Monday"), so a closed day belongs to one part, not the whole place. "Closed on Monday (except on public holidays)" counts
 * as closed on Monday: a place that might be open that one day is not suggested.
 *
 * How to call:
 *   closedWeekdaysOf('Tuesday to Sunday, 9am – 6pm, Closed on Monday') // [1]
 *   closedWeekdaysOf('Daily, 9am – 8pm')                               // []
 */
function closedWeekdaysOf(text) {
  const s = fixText(text);
  if (!s || /\bdaily\b/i.test(s)) return [];
  const days = new Set();
  for (const m of s.matchAll(CLOSED_ON)) {
    const parts = [...m[1].matchAll(new RegExp(`(${DAY})|(to|-|–)`, 'gi'))];
    let previous = null, range = false;
    for (const [, day, joiner] of parts) {
      if (joiner) { range = true; continue; }
      const n = DAY_NUMBER[day.slice(0, 3).toLowerCase()];
      if (range && previous !== null) for (let d = previous; d !== n; d = (d + 1) % 7) days.add(d);
      days.add(n);
      previous = n; range = false;
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Does the opening-hours text say visits are only by appointment (so a group cannot just walk in)?
 *
 * How to call:
 *   isByAppointmentOnly('Visits are by appointment only.') // true
 */
const isByAppointmentOnly = text => /\b(?:by|only by|on)\s+(?:prior\s+)?appointment\b|\bappointment only\b/i.test(fixText(text));

// ---------------------------------------------------------------- places, addresses and links
/**
 * "1.30690013235842,103.800367271426" -> { lat, lng }, or the tourism theme's LATITUDE / LONGTITUDE (sic).
 * null when there is no location or it is outside Singapore (a swapped or zero coordinate).
 *
 * How to call:
 *   pointOf({ LatLng: '1.3069,103.8004' }) // { lat: 1.3069, lng: 103.8004 }
 */
function pointOf(row) {
  const text = String(row.LatLng ?? '').trim();
  const [lat, lng] = text === '' ? [NaN, NaN] : text.split(',').map(x => (x.trim() === '' ? NaN : Number(x)));
  if (withinSingapore({ lat, lng })) return { lat, lng };
  const field = x => (x === undefined || x === null || String(x).trim() === '' ? NaN : Number(x));
  const point = { lat: field(row.LATITUDE), lng: field(row.LONGTITUDE ?? row.LONGITUDE) };
  return withinSingapore(point) ? point : null;
}

/**
 * Old government image links are http://, and some have no scheme at all ("www.yoursingapore.com/..."), which a browser
 * would read as a path on Jio's own address. Returns an https:// link, or null when the value is not a link to a host:
 * a root-relative path ("/content/dam/x.jpg"), a word like "NIL", or a scheme that is not http(s).
 *
 * How to call:
 *   https('http://www.nea.gov.sg/x.jpg')    // 'https://www.nea.gov.sg/x.jpg'
 *   https('www.yoursingapore.com/x.jpg')    // 'https://www.yoursingapore.com/x.jpg'
 *   https('/content/dam/x.jpg')             // null
 */
function https(url) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  let candidate;
  if (/^https:\/\//i.test(text)) candidate = text;
  else if (/^http:\/\//i.test(text)) candidate = text.replace(/^http:\/\//i, 'https://');
  else if (/^\/\//.test(text)) candidate = `https:${text}`;
  else if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text)) candidate = `https://${text}`;
  else return null;
  try {
    const u = new URL(candidate);
    // "a.jpg" has the shape of a host name, but it is a file name.
    return u.hostname.includes('.') && !/\.(?:jpe?g|png|gif|webp|svg|bmp|pdf|html?|php|aspx?|txt)$/i.test(u.hostname) ? candidate : null;
  } catch { return null; }
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * A postal code as six digits, or null. OneMap writes "0" when it has none, and drops the leading zero of codes that
 * start with one ("88995" is 088995).
 *
 * How to call:
 *   postalCodeOf('88995') // '088995'
 *   postalCodeOf('0')     // null
 */
function postalCodeOf(raw) {
  const digits = String(raw ?? '').trim();
  if (!/^\d{1,6}$/.test(digits)) return null;
  const code = digits.padStart(6, '0');
  return code === '000000' ? null : code;
}

// A tourist-board name carries a tagline: "Sri Mariamman Temple: Hindu Temple in Singapore", "Gillman Barracks – YourSingapore".
// What follows the colon or dash is cut only when it is plainly a tagline (it names Singapore, or is a stock phrase), so a
// name that really has a dash or a colon in it stays whole.
const TAGLINE_TAIL = /singapore|attractions?\b|things to do|history (?:&|and) culture|\blandmark\b|theme park|leisure/i;

/**
 * A place's name without the tourist board's tagline.
 *
 * How to call:
 *   plainName('Sri Mariamman Temple: Hindu Temple in Singapore')   // 'Sri Mariamman Temple'
 *   plainName('Gillman Barracks – YourSingapore')                  // 'Gillman Barracks'
 *   plainName('Peranakan Museum Singapore: History & Culture')     // 'Peranakan Museum'
 *   plainName('National Museum of Singapore')                      // unchanged: Singapore is part of the name
 *   plainName('Indian National Army (INA) Monument in Singapore')  // 'Indian National Army (INA) Monument'
 *   plainName('Raffles Statue – Sir Stamford Raffles Landing Site') // unchanged: nothing there is a tagline
 */
function plainName(name) {
  let s = String(name ?? '').trim();
  const cut = /^(.*?)\s*(?::|\s[-–—]\s|[-–—]\s)\s*(.+)$/.exec(s);
  const tagline = cut && cut[1].length >= 3 && TAGLINE_TAIL.test(cut[2]);
  if (tagline) s = cut[1].replace(/(?<!\bof),?\s+Singapore$/i, ''); // "Peranakan Museum Singapore: History & Culture"
  // Without a tagline, only ", Singapore" and " in Singapore" go: "National Gallery Singapore" and "National Museum of
  // Singapore" are the places' own names.
  s = s.replace(/,?\s+in Singapore$/i, '').replace(/,\s*Singapore$/i, '');
  return s.trim() || String(name ?? '').trim();
}

/**
 * The theatre theme gives only the block number in its address ("3615, Singapore 159461") and puts the street, and often
 * the building, in the description ("Jalan Bukit Merah Gateway Theatre"). An address with only a block number gets that text
 * as its street, like any other address: "3615 Jalan Bukit Merah Gateway Theatre, Singapore 159461". Only a theatre
 * (`kind` is 'theatre') gets one: in other themes a short description is not a street. An address that already has a
 * street, or a description that is a sentence or a link, is left alone.
 *
 * How to call:
 *   withStreet('3615, Singapore 159461', 'Jalan Bukit Merah Gateway Theatre', 'theatre') // '3615 Jalan Bukit Merah Gateway Theatre, Singapore 159461'
 *   withStreet('3615, Singapore 159461', 'Jalan Bukit Merah Gateway Theatre', 'museum')  // unchanged
 *   withStreet('21 Canberra Link, Singapore 756973', 'anything', 'theatre')              // unchanged
 */
function withStreet(address, description, kind) {
  if (kind !== 'theatre') return address;
  const m = /^(\d+[A-Za-z]?(?:-\d+)?),\s*(Singapore \d{6})$/.exec(String(address ?? ''));
  const text = String(description ?? '').trim();
  if (!m || text === '' || text.length > 70 || /[.!?]|https?:/i.test(text)) return address;
  return `${m[1]} ${text}, ${m[2]}`;
}

/**
 * The address text and postal code of a theme row: "21 Canberra Link, Singapore 756973".
 *
 * How to call:
 *   addressOf({ ADDRESSBLOCKHOUSENUMBER: '21', ADDRESSSTREETNAME: 'Canberra Link', ADDRESSPOSTALCODE: '756973' }, 'theatre')
 *   // { address: '21 Canberra Link, Singapore 756973', postalCode: '756973' }
 */
function addressOf(row, kind) {
  const parts = [row.ADDRESSBLOCKHOUSENUMBER, row.ADDRESSSTREETNAME, row.ADDRESSBUILDINGNAME].filter(x => x && x !== 'NIL').map(fixText);
  const postal = postalCodeOf(row.ADDRESSPOSTALCODE);
  const text = parts.join(' ') || fixText(row.ADDRESS_MYENV) || null;
  const address = text ? (postal ? `${text}, Singapore ${postal}` : text) : null;
  return { address: withStreet(address, descriptionOf(row.DESCRIPTION), kind), postalCode: postal };
}

/**
 * A saved address made right: "..., Singapore 0" loses its "0", "..., Singapore 88995" gets its leading zero.
 *
 * How to call:
 *   repairAddress('Esplanade Park, Singapore 0') // 'Esplanade Park'
 *   repairAddress('1, Singapore 38981')          // '1, Singapore 038981'
 */
function repairAddress(address) {
  const text = fixText(address);
  if (!text) return null;
  const m = /^(.*?),?\s*Singapore\s+(\d+)$/i.exec(text);
  if (!m) return text;
  const postal = postalCodeOf(m[2]);
  return m[1] ? (postal ? `${m[1]}, Singapore ${postal}` : m[1]) : null;
}

// A description that is only a code is not a description: the libraries' branch codes ("CCK", "NAS") and the hawker
// centres' upgrading programme ("HUP Rebuilding", "New Centre"). The theatre rows' street names are left as they are.
const PROGRAMME_CODE = /^(?:[A-Z]{1,6}|HUP\b.*|Opted out of HUP|Not eligible for HUP|Upgraded prior to HUP|New (?:Replacement )?Centre)$/;

/**
 * A theme row's description as text, or null: a bare link is not a description, and neither is a programme code.
 *
 * How to call:
 *   descriptionOf('Singapore’s oldest Hindu temple.') // 'Singapore’s oldest Hindu temple.'
 *   descriptionOf('HUP Rebuilding')                   // null
 */
function descriptionOf(raw) {
  if (/^https?:\/\//.test(String(raw ?? ''))) return null;
  const text = freeText(raw);
  return text && !PROGRAMME_CODE.test(text) ? text : null;
}

// ---------------------------------------------------------------- one row, one venue
/**
 * One OneMap theme row -> one engine venue, or null when the row should be left out (a playground, a hawker centre
 * under construction, a row with no location).
 *
 * How to call:
 *   const venue = fromOneMapRow('sportsg_sport_facilities', row)
 */
function fromOneMapRow(themeName, row) {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`onemap-adapter: unknown theme "${themeName}"`);
  const point = pointOf(row);
  const name = cleanName(row.NAME);
  if (!point || !name) return null;
  if (themeName === 'nationalparks' && !isRealPark(row.NAME)) return null;
  if (themeName === 'ssot_hawkercentres' && !isOpenHawkerCentre(row)) return null;

  const d = DEFAULTS[theme.kind];
  const parsedHours = parseOpeningHoursText(row.OPENING_HOURS);
  const { address, postalCode } = addressOf(row, theme.kind);
  const food = theme.category === 'eat';
  const photoUrl = https(row.PHOTOURL);
  return {
    id: `onemap_${themeName}_${slug(name)}`, name, area: address ?? name, nearestMrt: null,
    lat: point.lat, lng: point.lng, forecastArea: approxRegion(point),
    category: theme.category, kind: theme.kind, cuisine: theme.kind,
    avgPricePerPerson: theme.price, priceBand: theme.price <= 8 ? 1 : theme.price <= 20 ? 2 : theme.price <= 40 ? 3 : 4,
    rating: null, ratingCount: null,
    diet: food ? { halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown', healthy: d.healthy ?? 2 } : null,
    setting: theme.setting, exposure: theme.exposure, aircon: theme.setting === 'indoor',
    stepFree: null, sockets: null, wifi: null, cdcAccepted: false,
    maxGroupSize: d.maxGroupSize, hasPrivateRoom: false, cakeFriendly: false, longStayOk: d.longStayOk,
    noise: d.noise, queueMinutesPeak: null,
    openingHours: parsedHours ?? theme.hours,
    mealPeriods: food ? ['breakfast', 'lunch', 'tea', 'dinner'] : [],
    attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, d.attributes[i]])),
    address, postalCode,
    description: descriptionOf(row.DESCRIPTION),
    website: https(row.HYPERLINK ?? (/^https?:\/\//.test(row.DESCRIPTION ?? '') ? row.DESCRIPTION : null)),
    photoUrl,
    photoCredit: photoUrl ? freeText(row.PHOTOCREDITS) || 'OneMap / Singapore government' : null,
    openingHoursText: freeText(row.OPENING_HOURS) || null,
    foodStalls: Number(row.NUMBER_OF_COOKED_FOOD_STALLS) || null,
    source: 'onemap', oneMapTheme: themeName,
    dataQuality: {
      hoursAssumed: !parsedHours, priceAssumed: true, ratingUnknown: true, attributesAreDefaults: true,
      dietUnknown: food, accessUnknown: true, forecastAreaApprox: true,
    },
  };
}

/**
 * A whole theme -> venues: converts every row, drops the ones left out, and makes ids unique
 * (OneMap lists "Tras Link PK" twice).
 *
 * How to call:
 *   const venues = fromOneMapTheme('nationalparks', rows)
 */
function fromOneMapTheme(themeName, rows) {
  const seen = new Map();
  const out = [];
  for (const row of rows) {
    const v = fromOneMapRow(themeName, row);
    if (!v) continue;
    const n = seen.get(v.id) ?? 0;
    seen.set(v.id, n + 1);
    if (n > 0) {
      // A second row with the same name: keep it only if it is somewhere else (300 m apart), as its own venue.
      const first = out.find(x => x.id === v.id);
      if (Math.hypot(first.lat - v.lat, first.lng - v.lng) * 111 < 0.3) continue;
      v.id = `${v.id}-${n + 1}`;
    }
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- repairing a saved file, with no network
/**
 * A saved venue with the text, links and addresses of a fixed build: the same functions the adapter now applies to a
 * fresh row, applied to the saved values. Nothing else changes (the id, the order of the fields, the numbers). What
 * cannot be repaired: a raw value the build already dropped (a description that was only a link is gone; an address
 * with no street cannot get one back, except a theatre's, whose street is in its description), and a character replaced
 * by U+FFFD that is not an apostrophe.
 *
 * How to call:
 *   const repaired = repairSavedVenue(savedVenue)
 */
function repairSavedVenue(v) {
  const name = plainName(fixText(v.name));
  const address = withStreet(repairAddress(v.address), descriptionOf(v.description), v.kind);
  const photoUrl = https(v.photoUrl);
  const repaired = {
    ...v,
    name,
    area: address ?? name,
    address,
    postalCode: postalCodeOf(v.postalCode) ?? postalCodeOf(/Singapore\s+(\d+)$/i.exec(String(v.address ?? ''))?.[1]),
    description: descriptionOf(v.description),
    website: https(v.website),
    photoUrl,
    photoCredit: photoUrl ? freeText(v.photoCredit) || 'OneMap / Singapore government' : null,
    openingHoursText: freeText(v.openingHoursText) || null,
  };
  return repaired;
}

// ---------------------------------------------------------------- which saved places reach the planner
// Theatre rows that a group cannot walk into and buy a ticket for. The first rule that matches decides. Everything
// else in the theatre theme stays (the public theatres and arts centres).
const NOT_WALK_IN_THEATRES = [
  ['community club or centre hall', /\b(?:community (?:club|centre|center)|CC)\b/i],
  ['mini theatre room', /\bmini[- ]?theatre\b/i],
  ['school, college or polytechnic hall', /\b(?:polytechnic|illuminite|ITE|UCC|ACSB)\b/i],
  ['auditorium', /\bauditorium\b/i],
  ['amphitheatre', /\bamphitheatre\b/i],
  ['studio room', /\bstudio theatre\b/i],
];
// Islets with nothing to visit: OneMap lists them as parks.
const UNINHABITED_ISLETS = /^pulau (?:sekudu|unum)$/i;

/**
 * Why a saved OneMap place is not a place a group can go to, or null when it stays in the planner's pool.
 * The place stays in the saved file; only the pool leaves it out.
 *   - a theatre that is a community club, school or polytechnic hall, auditorium, amphitheatre, mini theatre or studio room
 *   - a park named "Interim Park" (land held for later building) and the islets Pulau Sekudu and Pulau Unum
 *   - a place whose hours text says visits are by appointment only
 *
 * How to call:
 *   notInPoolBecause({ oneMapTheme: 'theatre', name: 'Boon Lay Community Club Mini Theatre' }) // 'community club or centre hall'
 */
function notInPoolBecause(v) {
  if (v.oneMapTheme === 'theatre') for (const [reason, re] of NOT_WALK_IN_THEATRES) if (re.test(v.name)) return reason;
  if (v.oneMapTheme === 'nationalparks') {
    if (/\binterim park\b/i.test(v.name)) return 'interim park';
    if (UNINHABITED_ISLETS.test(v.name)) return 'uninhabited islet';
  }
  if (isByAppointmentOnly(v.openingHoursText)) return 'by appointment only';
  return null;
}

/**
 * A hawker centre's name for people. NEA writes "Redhill Lane Blk 79 (Redhill Market)": a street and block, then the
 * name everyone uses. When what comes before the bracket is a street and block, the name in the bracket is shown.
 * "Maxwell Food Centre (Kim Hua Market)" and "Amoy Street Food Centre (Telok Ayer Food Centre)" are left alone: there
 * the name before the bracket is the known one.
 *
 * How to call:
 *   hawkerDisplayName('Redhill Lane Blk 79 (Redhill Market)') // 'Redhill Market'
 */
function hawkerDisplayName(name) {
  const m = /^(.*\bBlk\b.*?)\s*\(([^()]+)\)\s*$/i.exec(name);
  return m ? m[2].trim() : name;
}

/**
 * Saved OneMap places made ready for the planner: the ones a group cannot go to are set aside, a hawker centre named
 * by street and block gets the name in its bracket (the NEA name is kept as officialName, which the closure dates
 * are matched by), and each place gets the weekdays its hours text says it is closed (closedWeekdays).
 *
 * How to call:
 *   const { pool, excluded } = preparePool(savedVenues) // excluded: [{ id, name, reason }]
 */
function preparePool(venues) {
  const pool = [], excluded = [];
  for (const v of venues) {
    const reason = notInPoolBecause(v);
    if (reason) { excluded.push({ id: v.id, name: v.name, reason }); continue; }
    const display = v.kind === 'hawker' ? hawkerDisplayName(v.name) : v.name;
    pool.push({
      ...v,
      ...(display !== v.name ? { name: display, officialName: v.name } : {}),
      closedWeekdays: closedWeekdaysOf(v.openingHoursText),
    });
  }
  return { pool, excluded };
}

// ---------------------------------------------------------------- the same place listed twice
const NOISE_WORDS = new Set(['the', 'of', 'and', 'on', 'in', 'at', 'a', 'an', 'singapore', 'sg']);
// "Peranakan Museum Singapore: History & Culture" is the place before the colon; the rest is the tourist board's tagline.
const placeWords = name => new Set(
  fixText(name).split(':')[0].toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length > 1 && !NOISE_WORDS.has(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
);
/**
 * How alike two sets of words are, 0 to 1 (shared words over all words).
 *
 * How to call:
 *   wordOverlap(new Set(['esplanade', 'theatre']), new Set(['esplanade', 'theatre', 'bay'])) // 0.67
 */
function wordOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Are two OneMap places one place listed under two themes? Same category, and:
 *   - listed in different themes: within 100 m and half their words alike, or within 250 m and three quarters alike;
 *   - listed in the same theme: within 250 m and three quarters alike (OneMap itself lists "Central Library" and
 *     "Central Arts Library" as two libraries, and two parks a few doors apart as two parks).
 * Hawker centres are never merged with each other: NEA lists each block as its own centre, even 60 m apart.
 *
 * How to call:
 *   isSamePlace(tourismEsplanadeTheatre, theatreEsplanadeTheatre) // true
 */
function isSamePlace(a, b, { nearMeters = 100, farMeters = 250, nearOverlap = 0.5, farOverlap = 0.75 } = {}) {
  if (a.category !== b.category || a.kind === 'hawker' || b.kind === 'hawker') return false;
  const meters = haversineKm(a, b) * 1000;
  const overlap = wordOverlap(placeWords(a.name), placeWords(b.name));
  if (meters <= farMeters && overlap >= farOverlap) return true;
  return a.oneMapTheme !== b.oneMapTheme && meters <= nearMeters && overlap >= nearOverlap;
}

/**
 * One venue per place: places that are the same place (isSamePlace, joined end to end, so "Esplanade Theatre" in two
 * themes and "Esplanade Theatres on the Bay" become one) keep one row. The kept row is the one with real opening hours,
 * then one with a photo, then the earlier in the list; it keeps its own id. `clusters` lists each group, kept id first.
 *
 * How to call:
 *   const { venues: unique, clusters } = dedupeOneMapVenues(pool)
 */
function dedupeOneMapVenues(venues) {
  const parent = venues.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) if (isSamePlace(venues[i], venues[j])) parent[find(j)] = find(i);
  }
  const groups = new Map();
  venues.forEach((v, i) => { const root = find(i); groups.set(root, [...(groups.get(root) ?? []), i]); });
  const rank = v => [v.dataQuality?.hoursAssumed ? 1 : 0, v.photoUrl ? 0 : 1];
  const keepers = new Set(), clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) { keepers.add(members[0]); continue; }
    const sorted = [...members].sort((a, b) => { const ra = rank(venues[a]), rb = rank(venues[b]); return ra[0] - rb[0] || ra[1] - rb[1] || a - b; });
    keepers.add(sorted[0]);
    clusters.push(sorted.map(i => venues[i].id));
  }
  return { venues: venues.filter((_, i) => keepers.has(i)), clusters };
}

export {
  THEMES, THEME_NAMES, fromOneMapRow, fromOneMapTheme, parseOpeningHoursText, cleanName, isRealPark, fixText,
  https, stripContacts, freeText, postalCodeOf, repairAddress, descriptionOf, repairSavedVenue, plainName, withStreet,
  closedWeekdaysOf, isByAppointmentOnly, notInPoolBecause, hawkerDisplayName, preparePool, isSamePlace, dedupeOneMapVenues,
};
