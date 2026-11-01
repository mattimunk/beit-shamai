import type { Subject } from "../../engine/types";
import { DEMO_CITY, DEMO_ORIGIN } from "./demoProvider";

/** The default property shown in the demo (fictional). */
export const DEMO_SUBJECT: Subject = {
  address: { city: DEMO_CITY, street: "הדקל", number: "14", neighborhood: "מרכז" },
  location: DEMO_ORIGIN,
  parcel: { block: "6789", parcel: "12", subParcel: "8" },
  rights: "ownership",
  floor: 2,
  floorsInBuilding: 4,
  elevator: false,
  yearBuilt: 1975,
  rooms: 4,
  area: {
    mode: "measured",
    levels: [
      {
        name: "main",
        internalArea: 84.5,
        exteriorWallLengthM: 30,
        exteriorWallThicknessCm: 25,
        sharedWallLengthM: 12,
        sharedWallThicknessCm: 24,
        laundryNicheSqm: 1.6,
      },
    ],
  },
  addOns: [
    { type: "sun_balcony", area: 8, attachment: "attached", permitted: true },
    { type: "covered_balcony", area: 6, attachment: "attached", permitted: false },
    { type: "storage", area: 6, attachment: "assigned", permitted: true },
    { type: "parking", count: 1, parkingKind: "regular", attachment: "attached", permitted: true },
  ],
  condition: "renovated",
  view: "regular",
  directions: ["N", "W"],
  hasSafeRoom: false,
  newBuild: false,
  building: {
    unitsInBuilding: 16,
    plotSqm: 1000,
    existingBuiltSqm: 1150,
    planRightsPercent: 250,
    ownRenewalProjectStage: "none",
  },
};
