# Beit Shamai – בית שמאי

Digital value estimates for mainstream Israeli homes, for buyers and realtors, in Hebrew and English.

This repository is **Phase 1** of the product spec ([Beit Shamai – product specification](https://claude.ai/artifact/M6EFAPM2UZcS65pnpH7Mdn)): the valuation engine, the add-on coefficients, the location and urban-renewal layers and the bilingual estimate report. The video site-visit scan, plan comparison and off-plan 3D modules come in later phases.

> **Status: prototype on demo data.** The app runs on a fictional town ("קריית הדגמה" / Demo Town). No deal, listing, stop or renewal project in it is real. Live data connectors are stubbed in `src/data/liveProviders.ts`.

## Two-tier output

| Tier | User | Title | Legal status |
| --- | --- | --- | --- |
| Estimate | Buyer | אומדן שווי ממוחשב / Automated value estimate | Not an appraisal (Standard 20 disclaimer) |
| Estimate | Realtor | סקר מחירים / Price survey | Realtors may not give valuations |
| Signed | Buyer, on request | שומת מקרקעין | Issued and signed by a partner licensed appraiser (not built yet) |

## Run it

Requirements: [Bun](https://bun.sh) 1.1+ (or Node 20+ with `npm install` for type-checking).

```bash
bun install        # or: npm install
bun test           # engine unit tests
bun run build      # writes a single self-contained dist/index.html
bun run dev        # http://localhost:5173 (rebuilds on each reload)
```

`dist/index.html` has no external dependencies: open it straight from disk or host it anywhere.

## How the estimate is calculated

1. **Area per Standard 9.1** (`src/engine/area.ts`): internal area + exterior walls at full thickness + shared walls at half thickness capped at 10 cm; laundry niches excluded; attic counted only from 1.80 m; each level reported separately. A declared area (land registry, contract, arnona) can be used instead and is flagged.
2. **Equivalent area** (`src/engine/coefficients.ts`): each add-on × its coefficient (declining scales for gardens and roof terraces); parking as a fixed NIS value; assigned and unpermitted areas discounted.
3. **Comparables** (`src/engine/comparables.ts`): completed deals only. The radius widens 300 → 600 → 1,000 → 1,500 m until at least 5 qualify (last 24 months). Each deal is indexed to today and adjusted for floor/elevator, age, condition, view, new build and rights. Over-adjusted deals and outliers are dropped. The rest are weighted by distance, recency, size similarity and adjustment size. The value is the weighted median price per equivalent sqm × equivalent area + fixed items, with the 25th–75th percentile as the range.
4. **Market context** (`src/engine/market.ts`): asking prices as a cross-check only, sale-to-ask gap and days on market from the listing ledger, and prior sales of the unit.
5. **Transport** (`src/engine/location.ts`): nearest stop per mode and a frequency-based access score (GTFS); future lines tagged by maturity, where only firm stages count; Metro densification area and expropriation flags.
6. **Urban renewal** (`src/engine/renewal.ts`): the building's own potential score with reasons; nearby projects within 500 m, with stage set only by reliable signals. News or marketing alone shows as "reported (unconfirmed)".

Every number in the report shows where it came from: each comparable, each adjustment and each coefficient.

> ⚠️ **All coefficients and adjustment rates are uncalibrated placeholders** written from general practice, not sourced figures. They must be calibrated per city with partner licensed appraisers before any real use (`DEFAULT_CONFIG` in `src/engine/coefficients.ts`; per-city overrides via `DataProvider.getCityConfig`).

## Project layout

```
src/
  engine/        pure valuation logic (no UI, no I/O) – unit-tested
  data/
    provider.ts        DataProvider interface – every external source sits behind it
    liveProviders.ts   production connector skeletons (not connected)
    demo/              fictional-town dataset and default subject
  i18n/strings.ts      Hebrew + English strings, number/date formatting (incl. Hebrew calendar)
  ui/                  React UI: form, results dashboard, schematic map, printable report
tests/                 bun test suites
scripts/               single-file build and dev server
docs/                  data sources and next steps
```

## Next steps

See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
