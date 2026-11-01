# Roadmap

## Phase 1 – data and estimate (this repo)

- [x] Valuation engine: Standard 9.1 area, add-on coefficients, comparables, adjustments, weighting, range and confidence
- [x] Market context: asking-price cross-check, sale-to-ask gap, days on market, prior sales
- [x] Transport today and planned, Metro densification and expropriation flags
- [x] Urban renewal: building potential score, nearby projects with stage confidence
- [x] Bilingual UI (Hebrew RTL / English LTR), buyer and realtor modes, printable report
- [x] Demo dataset (fictional town) and unit tests
- [ ] Server: API around the engine, Israeli-region hosting for the Tax Authority connector
- [ ] Live connectors: Tax Authority deals, GTFS, CBS index, Urban Renewal Authority layer, plan system
- [ ] Listing ledger and licensed listing feeds
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
