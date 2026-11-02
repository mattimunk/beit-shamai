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

Not yet in the interface: the land-registry extract (נסח טאבו, paid, user-initiated), municipal building files and permit plans (for the plan-comparison phase), and published appraisals (decisive-appraiser decisions, agreed levy appraisals) for calibration.
