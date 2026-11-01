# Roadmap

## Phase 1 – data and estimate (this repo)

- [x] Valuation engine: Standard 9.1 area, add-on coefficients, comparables, adjustments, weighting, range and confidence
- [x] Market context: asking-price cross-check, sale-to-ask gap, days on market, prior sales
- [x] Transport today and planned, Metro densification and expropriation flags
- [x] Urban renewal: building potential score, nearby projects with stage confidence
- [x] Bilingual UI (Hebrew RTL / English LTR), buyer and realtor modes, printable report
- [x] Demo dataset (fictional town) and unit tests
- [x] Server: API around the engine (Bun + SQLite)
- [x] Tax Authority deals connector via GovMap (needs field verification from an Israeli host)
- [x] Listing ledger (first seen, price history, removal) with licensed-feed import
- [x] Advert ↔ deal matching, sale-to-ask and area calibration, calibrated adverts blended into the estimate
- [ ] Verify GovMap field mapping with `server/probe-govmap.ts` from Israel; add the live fixture to tests
- [ ] Sign listing data licences (Yad2, Madlan) or agency feeds; write their feed adapters
- [ ] Back-fill: historical adverts are needed for matching, so ask licensors for 2+ years of history
- [ ] Deploy in an Israeli region; nightly sync → import → match schedule
- [ ] Remaining live connectors: GTFS, CBS index, Urban Renewal Authority layer, plan system
- [ ] Real map base layer (GovMap / municipal GIS)
- [ ] Coefficient calibration with 3–5 partner appraisers, per city
- [ ] Accounts and roles (buyer, realtor, partner appraiser, admin); saved properties and alerts
- [ ] Appraiser review workspace and signed-appraisal tier

## Phase 2 – site-visit scan

iOS LiDAR capture (RoomPlan), Standard 9.1 area from the scan, condition and light models, surveyor validation programme.

## Phase 3 – plan comparison

Building-file connectors, plan vectoriser, alignment and diff, unpermitted-addition detection with a labelled test set.

## Phase 4 – off-plan and marketplace

Sale-plan to 3D, sun simulation, Android photogrammetry, realtor workspaces.
