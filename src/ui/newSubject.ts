import type { Subject } from "../engine/types";
import { DEMO_SUBJECT } from "../data/demo/demoSubject";

/** A new property file starts with neutral details – nothing from the demo flat that could
 * end up in a real report (no extras, no unpermitted balcony, no block/parcel). */
export function newSubject(): Subject {
  return {
    ...DEMO_SUBJECT,
    address: { city: "", street: "", number: "" },
    location: { lat: 32.0853, lng: 34.7818 },
    parcel: undefined,
    addOns: [],
    condition: "original",
    directions: [],
  };
}
