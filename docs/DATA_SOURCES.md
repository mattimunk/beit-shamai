# Data sources and connector plan

Every source is tagged with an evidence class. **Completed deals** set value. **Asking prices** are a cross-check only. **Professional opinions** (published appraisals and rulings) are used for calibration.

| Connector (`DataProvider` method) | Source | Class | Access | Notes |
| --- | --- | --- | --- | --- |
| `getDeals`, `getUnitHistory` | Israel Tax Authority deals (מידע נדל"ן / nadlan.gov.il) | Completed deal | **Live check (Nov 2026): GovMap's deals API requires a reCAPTCHA token, so automated access is not permitted.** Needs a data arrangement with the Tax Authority, or a licensed vendor. Meanwhile, deals are loaded from files via `POST /api/deals/import` (CSV, Hebrew or English headers) | Deals appear weeks after signing. The State Comptroller (Oct 2025) flagged completeness and accuracy issues, so outlier filtering is required |
| `getListings` | Yad2, Madlan, agency feeds | Asking price | **Commercial licence required**: scraping breaches their terms of use | Feeds the listing ledger: first seen, price changes, removal |
| `getMatchedPairs` | Server nightly job: ledger adverts ↔ Tax Authority deals | Derived | Internal | Calibrates asking prices: sale/ask factor, area ratio, days on market. Historical adverts (2+ years) are needed for good coverage |
| `getPriceIndex` | CBS dwelling price index by district | Index | Public | Monthly, with a lag |
| `getTransitStops` | National Public Transport Authority GTFS (`gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip`) | Transport | Public, daily | Optional SIRI real-time feed for reliability |
| `getFutureLines` | Statutory plans: Metro NIPs, light rail, TAMA 70 influence area (Planning Administration, GovMap, NTA) | Planning | Public layers | Replace the approximate 800 m Metro influence radius with the official TAMA 70 boundary |
| `getRenewalSignals` | Urban Renewal Authority declarations and map; plan system; section-149 permit notices; local committee agendas and minutes; news monitoring | Planning / news | Public; per-municipality connectors | News never sets a stage on its own |
| `getCityPolicy` | Municipal renewal policies, TAMA 38 replacement plans, renewal levy rate | Policy | Maintained by the methodology team | Amendment 139 default levy is 25% unless the city sets another rate |
| `getCityConfig` | Calibrated coefficients | Config | Maintained with partner appraisers | Every override is logged with its reason |

Address search: OpenStreetMap Nominatim by default (free; 1 request/second, attribution shown), or Google Geocoding with `GOOGLE_MAPS_API_KEY`. GovMap's own search is reCAPTCHA-protected. Its official JavaScript API needs a domain-bound token from the Survey of Israel.

## Tax Authority deals: request workflow (manual export)

The Tax Authority's "מערכת מידע נדל"ן" (nadlan.taxes.gov.il) needs a personal login and caps
each search at **150 results**, so deals reach the library through a person with access.
The system never stores or uses that login.

1. **Request.** "Order the final report" (live mode, report tab) opens a request. The report is
   labelled *preliminary* until the request is complete.
2. **Search plan.** The server writes the searches: the subject's city, "דירת מגורים", the last
   12 months in 3-month periods (newest first), area band −25% … +35% around the subject.
   Periods already covered by earlier complete uploads are skipped, so each city gets cheaper.
3. **Inbox.** The "Data requests" tab (realtor/appraiser roles, admin code) lists the searches
   with a copy button. Run each search on the Tax Authority site, download the .xls, upload it.
4. **Checks on upload.** The file's own header is read back: city, dates and area band must
   match the search, or the search stays open (rows are kept). An export at the 150 limit is
   marked *cut off* and split in two: by period while longer than a month, then by area.
5. **Rows → deals.** Each row has block/parcel but no address. It is placed from the Survey
   of Israel's national parcel layer (open licence, data.gov.il dataset
   `dff8a168-af6c-4e0f-bbe3-c4bd3646084c`, ~640 MB Shapefile, monthly), imported into
   `parcel_points` / `block_points` by the monthly `parcels` job or by hand with
   `bun run server/importParcels.ts`. An unknown parcel falls back to its block's centre
   (flagged). An ArcGIS layer (`layers.parcels`) can be configured as a further fallback. Rows
   that cannot be placed wait in `unlocated_deals`, and are placed after the next import. Partial sales (חלק נמכר < 1) are
   excluded as comparables; sales in buildings completed after the sale date are treated as
   off-plan and weighted at 0.4 for second-hand subjects. The floor is not in the export, so it
   is assumed equal to the subject's and flagged.
6. **Final.** When every search is done or covered, the request and report become *final*.

`server/probe.ts` reports whether the parcel layer is loaded.

## Madlan / Yad2 adverts: printed pages per case

The client (or realtor) opens the site's search for the property's area, prints the results
page to PDF and uploads it in the documents section (kind "Printed adverts"). The server reads
it with OCR and uses the adverts as asking-price evidence **for that case only**. Nothing is
pooled into a shared listings database, which would need a licence from the sites.

- Printed pages usually have no usable text (Windows print drivers turn web fonts into Type 3
  glyphs without a character map), so every page is rendered (`pdftoppm`) and read with
  `tesseract` (Hebrew + English) plus a digits-only pass for prices.
- Layouts: Madlan prints price then details below; Yad2 prints street, type/neighbourhood/city,
  rooms·floor·m², feature tags, and the price at the bottom. Both are handled.
- Price drops: a crossed-out old price beside the current one is re-read at double resolution
  with the strike line erased (ImageMagick) and stored as price history.
- Yad2's font draws a flat-topped 3 that OCR reads as 5; each "5" is checked against the image
  (a real 5 has a stroke on the upper left).
- Excluded automatically: whole buildings, plots and shops; new-project "starting from" prices;
  cards with rooms, area or address unread; implausible price per m². Each card is placed on the
  map by address before use.
- Accuracy on the first two samples (Nov 2026): Madlan 32 cards / 19 pages, Yad2 39 / 12 pages,
  about 40–60 s per file. Around a quarter of cards miss a field (and are left out); occasional
  digit slips (80 → 88 m²) are not caught automatically, so the table is shown for review.

Server needs `poppler-utils tesseract-ocr tesseract-ocr-heb imagemagick` (in the Docker image);
the source check reports whether they are present.

Not yet in the interface: the land-registry extract (נסח טאבו, paid, user-initiated), municipal building files and permit plans (for the plan-comparison phase), and published appraisals (decisive-appraiser decisions, agreed levy appraisals) for calibration.
