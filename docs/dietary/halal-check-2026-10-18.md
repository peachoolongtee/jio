# Halal check of the curated food and drink places, 18 October 2026

What the MUIS halal directory showed for each of the 34 curated food and drink places in `frontend/src/lib/mock/venues.js`
(ticket #107). It is the record the six marks in `venues.js` were taken from; a test holds those marks to it.

## How it was checked

- Source: the MUIS e-service "Halal Establishments", https://halal.muis.gov.sg/halal/establishments, searched on 18 October 2026.
- Each place was searched by its **postal code**, which lists every certified establishment at that address. The directory's
  name search matches names only ("McDonald's Junction 8" finds nothing; "McDonald" finds every outlet), so the chains were also
  searched by name: Zam Zam, Ya Kun, Starbucks, Sushi Tei, Kopitiam, Food Republic.
- Three places have no postal code in our data; the building's code was used and is marked with *: Chinatown Complex (050335),
  Parkview Square for Atlas (188778), NEX for Sushi Tei and Food Republic (556083). The results for 050335 and 556083 carried
  those addresses, which confirms the codes; 188778 returned nothing, so it is not confirmed.
- "Not listed" means MUIS shows no certificate at that address or under that name on that day. It does **not** mean the food is
  not halal: a Muslim-owned shop without a certificate (Zam Zam, for one) is not listed. Certificates also expire, so this is true
  as of the date above only.
- MUIS certifies a stall or a shop, never a whole food centre. A centre can only be said to have certified stalls.

## Results

| Place (id) | Kind | Searched | MUIS shows |
|---|---|---|---|
| Tiong Bahru Bakery (`tiong-bahru-bakery`) | cafe | 160056 | Not listed |
| Tiong Bahru Market and Food Centre (`tiong-bahru-market`) | hawker centre | 168898 | 2 certified stalls: Homemade Italian (S58) EEHK20250000394; Super Shiok Nasi Lemak (#02-38) EEHK26060000050 |
| Loo's Hainanese Curry Rice (`loos-curry-rice`) | stall | 160071 | Not listed |
| Plain Vanilla Tiong Bahru (`plain-vanilla`) | dessert | 168641 | Not listed |
| Forty Hands (`forty-hands`) | cafe | 163078 | Not listed |
| Merci Marcel Tiong Bahru (`merci-marcel`) | cafe | 160056 | Not listed |
| Jian Bo Shui Kueh (`jian-bo-shui-kueh`) | stall in Tiong Bahru Market | 168898 | Not listed (the market's two certified stalls are others) |
| Nylon Coffee Roasters (`nylon-coffee`) | cafe | 080004 | Not listed |
| Maxwell Food Centre (`maxwell-food-centre`) | hawker centre | 069184 | 1 certified stall: Fortune Popiah (Stall 101) EEHK20250000279 |
| Chinatown Complex Food Centre (`chinatown-complex`) | hawker centre | 050335* | 1 certified stall: Heritage Yong Tau Foo (#02-004) EEHK26050000070 |
| Potato Head Singapore (`potato-head`) | bar | 089143 | Not listed |
| Zam Zam Singapore (`zam-zam`) | restaurant | 198675, and by name | Not listed |
| Atlas (`atlas`) | bar | 188778* | Not listed |
| Chye Seng Huat Hardware (`chye-seng-huat`) | cafe | 207563 | Not listed |
| Boon Tong Kee Balestier (`boon-tong-kee`) | restaurant | 329803 | Not listed |
| Founder Bak Kut Teh (`founder-bak-kut-teh`) | restaurant | 329777 | Not listed |
| Wheeler's Yard (`wheelers-yard`) | cafe | 328781 | Not listed |
| Whampoa Makan Place (`whampoa-makan-place`) | hawker centre | 320091 | Not listed (the centre spans blocks 90 and 91; only 91's code was searched) |
| Newton Food Centre (`newton-food-centre`) | hawker centre | 229495 | 9 certified stalls: Goh Chew Kee Seafood (#01-19) EEHN21050012321; Guan Kee Seafood (S53) EEHK20230001334; Hai Kee Seafood (#01-78) EEHK25120000080; Jian Fa Seafood BBQ (#01-43) EEHN22010013058; Lucky Newton Seafood 82 (#01-82) EEHK20250000754; Modern Grill Seafood (S36) EEHN21030012194; Pirate's Seafood (#01-56) EEHN22030013220; Takara Grilled Seafood (#01-74) EEHN21080012618 and (#01-23) EEHN21080012619 |
| Toa Payoh Lorong 8 Market and Food Centre (`lorong-8-toa-payoh`) | hawker centre | 310210 | Not listed |
| Creamier Toa Payoh (`creamier-toa-payoh`) | dessert | 310128 | Not listed (a Subway in the same block is certified, EERT20230000893) |
| Kopitiam Junction 8 (`kopitiam-junction-8`) | food court | 579837, and "Kopitiam" by name | Not listed: 128 certified Kopitiam stalls island-wide, none at Junction 8. The one food-court stall certified at Junction 8 is Pepper Lunch Express in Food Junction (#04) EEHK26010000025 |
| Ya Kun Kaya Toast Junction 8 (`ya-kun-junction-8`) | cafe | 579837, and "Ya Kun" by name | Not listed, at any outlet |
| Starbucks Junction 8 (`starbucks-junction-8`) | cafe | 579837, and "Starbucks" by name | Not listed, at any outlet |
| Ming Kee Chicken Rice (`ming-kee-chicken-rice`) | stall | 570511 | Not listed (the same food centre, Kim San Leng, has one certified stall: Soldier Chicken EEHK25120000056) |
| Sin Ming Roti Prata (`sin-ming-roti-prata`) | stall | 570024 | Not listed |
| Roti Prata House (`roti-prata-house`) | restaurant | 574370 | Not listed |
| Udders Upper Thomson (`udders-thomson`) | dessert | 574370 | Not listed |
| Sushi Tei NEX (`sushi-tei-nex`) | restaurant | 556083*, and "Sushi Tei" by name | Not listed, at any outlet (NEX has about 42 certified outlets, none of them Sushi Tei) |
| Food Republic NEX (`food-republic-nex`) | food court | 556083*, and "Food Republic" by name | Not listed: 12 certified Food Republic stalls island-wide, none at NEX |
| Chomp Chomp Food Centre (`chomp-chomp`) | hawker centre | 557269 | Not listed |
| Serangoon Garden Market (`serangoon-garden-market`) | hawker centre | 555945 | 3 certified stalls: Ah Tas Muffins (S28) EEHK20230001302; Gardens You Tiao (#01-33) EEHK26010000052; Julia BBQ (Stall 23) EEHK20250000789 |
| Lola's Café (`lolas-cafe`) | cafe | 545893 | Not listed |
| Kovan 209 Market and Food Centre (`kovan-209-market`) | hawker centre | 530209 | 1 certified stall: Fortune Popiah (S52) EEHN22020013177 |

## In short

- **No curated restaurant, café, bar, stall or food court is MUIS certified** as of today.
- **Six hawker centres have certified stalls:** Newton (9), Serangoon Garden Market (3), Tiong Bahru Market (2), Maxwell (1),
  Chinatown Complex (1) and Kovan 209 (1).
- Vegetarian and vegan were not checked: no authority certifies them, so they need each place's own menu.

## Spot-check, and what the app now says

Spot-checked by darryl5942 on 18 October 2026: all six centres below were confirmed.

| Centre | Marked in `frontend/src/lib/mock/venues.js` |
|---|---|
| Newton Food Centre | `halal: { muisStalls: 9, checked: '2026-10-18' }` |
| Serangoon Garden Market | `halal: { muisStalls: 3, checked: '2026-10-18' }` |
| Tiong Bahru Market and Food Centre | `halal: { muisStalls: 2, checked: '2026-10-18' }` |
| Maxwell Food Centre | `halal: { muisStalls: 1, checked: '2026-10-18' }` |
| Chinatown Complex Food Centre | `halal: { muisStalls: 1, checked: '2026-10-18' }` |
| Kovan 209 Market and Food Centre | `halal: { muisStalls: 1, checked: '2026-10-18' }` |

The planner reads these as halal `likely` (`dataQuality.halalSource: 'muis'`, `halalScope: 'stalls'`), not verified: MUIS
certifies a stall, never a whole centre, so one certified stall does not make the centre halal. A halal group sees the centre
with a brown tag giving the count ("1 MUIS halal stall", "9 MUIS halal stalls", the date on hover) and "Halal likely, check the
stall". A single certified shop or restaurant would be `options` (verified, `halalScope: 'venue'`, tag "MUIS halal"); none of the
curated ones is certified. Every other place stays `unknown`. To change a mark, edit `venues.js` and run
`pnpm --filter jio-backend build:venues`; `backend/tests/venues.test.js` fails if the curated file differs from what that makes.

Certificates expire: search the directory again before the final, and update the counts and the date.
