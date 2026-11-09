import { useState, type ReactNode } from "react";
import {
  asksCapitalized, asksFloor, asksGarden, asksPlot, asksRoof, flags, isKnown, isRented, isSale,
  DEVIATIONS, RESTRICTIONS, tourLayout, type AreaSource, type Dossier, type Maybe, type PropertyType, type Purpose, type Registry, type RightsKind, type Submitter,
} from "../../dossier/schema";
import type { Direction } from "../../engine/types";
import { parcelAt, uploadDocument, type CaseDocDto } from "../../data/apiClient";
import { AddressSearch } from "../AddressSearch";
import { Block, Cards, Chips, Counter, NumberAsk, Q, TextAsk, UnsureButtons, YesNo } from "./controls";
import { MapPin } from "./MapPin";
import { useIT } from "./texts";

export type Up = (fn: (d: Dossier) => void) => void;
export interface SectionProps { d: Dossier; up: Up; caseId: string; docs: CaseDocDto[]; refreshDocs: () => void }

const DEFAULT_PIN = { lat: 32.0853, lng: 34.7818 }; // Tel Aviv, until an address is chosen

export function SectionHead({ title, sub, icon }: { title: string; sub?: string; icon?: ReactNode }) {
  return (
    <header className="sec-head">
      {icon && <div className="sec-icon" aria-hidden>{icon}</div>}
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </header>
  );
}

// ---- Setup ----------------------------------------------------------------------------------------

export function SetupSection({ d, up }: SectionProps) {
  const { T } = useIT();
  const S = T.setup;
  const purposes: Purpose[] = ["sale", "purchase", "mortgage", "refinance", "market", "inheritance", "division", "tax_legal", "other"];
  const subs: Submitter[] = ["owner", "buyer", "agent", "attorney", "mortgage_broker", "family", "other"];
  const icons: Record<Purpose, string> = { sale: "🏷️", purchase: "🔑", mortgage: "🏦", refinance: "🔄", market: "📊", inheritance: "📜", division: "⚖️", tax_legal: "🧾", other: "✳️" };
  return (
    <>
      <SectionHead title={S.title} icon="🎯" />
      <Q label={S.purpose}>
        <Cards cols={3} value={d.setup.purpose} onChange={(v) => up((x) => { x.setup.purpose = v as Purpose; })}
          options={purposes.map((k) => ({ key: k, label: S.purposes[k], icon: icons[k] }))} />
      </Q>
      <Q label={S.submitter}>
        <Cards cols={2} value={d.setup.submitter} onChange={(v) => up((x) => { x.setup.submitter = v as Submitter; })}
          options={subs.map((k) => ({ key: k, label: S.submitters[k] }))} />
      </Q>
    </>
  );
}

// ---- Location ------------------------------------------------------------------------------------

export function LocationSection({ d, up }: SectionProps) {
  const { T } = useIT();
  const L = T.location;
  const loc = d.location;
  const [looking, setLooking] = useState(false);
  const types: PropertyType[] = ["apartment", "garden_apartment", "penthouse", "duplex", "detached", "semi_detached", "cottage", "townhouse", "house_on_plot", "other"];
  const typeIcons: Partial<Record<PropertyType, string>> = { apartment: "🏢", garden_apartment: "🌿", penthouse: "🌇", duplex: "🪜", detached: "🏡", semi_detached: "🏘️", cottage: "🏠", townhouse: "🏘️", house_on_plot: "🏞️", other: "✳️" };

  const confirmPin = async () => {
    up((x) => { x.location.pinConfirmed = true; if (!x.location.pin) x.location.pin = DEFAULT_PIN; });
    if (loc.parcel && loc.parcel.source !== "suggested") return;
    setLooking(true);
    const near = await parcelAt((loc.pin ?? DEFAULT_PIN).lat, (loc.pin ?? DEFAULT_PIN).lng).catch(() => []);
    setLooking(false);
    up((x) => {
      x.location.parcel = near[0] ? { block: String(near[0].block), parcel: String(near[0].parcel), source: "suggested" } : undefined;
    });
  };

  return (
    <>
      <SectionHead title={L.title} icon="📍" />
      <Q label={L.search} hint={L.searchHint}>
        <AddressSearch onPick={(h) => up((x) => {
          x.location.city = h.city ?? x.location.city;
          x.location.street = h.street ?? x.location.street;
          x.location.number = h.number ?? x.location.number;
          x.location.pin = { lat: h.lat, lng: h.lng };
          x.location.pinConfirmed = false;
          if (x.location.parcel?.source === "suggested") x.location.parcel = undefined;
        })} />
      </Q>
      <div className="grid2">
        <Q label={L.street}><TextAsk value={loc.street} onChange={(v) => up((x) => { x.location.street = v; })} autoComplete="address-line1" /></Q>
        <Q label={L.number}><TextAsk value={loc.number} onChange={(v) => up((x) => { x.location.number = v; })} dir="ltr" /></Q>
        <Q label={L.city}><TextAsk value={loc.city} onChange={(v) => up((x) => { x.location.city = v; })} autoComplete="address-level2" /></Q>
        <Q label={L.neighbourhood}><TextAsk value={loc.neighbourhood} onChange={(v) => up((x) => { x.location.neighbourhood = v; })} /></Q>
      </div>

      <Q label={L.type}>
        <Cards cols={3} value={loc.type} onChange={(v) => up((x) => { x.location.type = v as PropertyType; })}
          options={types.map((k) => ({ key: k, label: L.types[k], icon: typeIcons[k] }))} />
      </Q>

      {asksFloor(d) && (
        <div className="grid2">
          <Q label={L.floor} hint={L.groundHint}><Counter value={loc.floor} min={-2} max={60} onChange={(v) => up((x) => { x.location.floor = v; })} /></Q>
          <Q label={L.floors}><Counter value={loc.floors} min={1} max={60} onChange={(v) => up((x) => { x.location.floors = v; })} /></Q>
          <Q label={L.entrance}><TextAsk value={loc.entrance} onChange={(v) => up((x) => { x.location.entrance = v; })} /></Q>
          <Q label={L.apartment}><TextAsk value={loc.apartment} onChange={(v) => up((x) => { x.location.apartment = v; })} dir="ltr" /></Q>
        </div>
      )}

      <Q label={L.map} hint={L.mapHint}>
        <MapPin value={loc.pin ?? DEFAULT_PIN} onChange={(p) => up((x) => { x.location.pin = p; x.location.pinConfirmed = false; })} />
        <div className="pin-row">
          {loc.pinConfirmed ? <span className="ok-text">✓ {L.pinOk}</span> : <button type="button" className="primary" onClick={confirmPin}>{L.confirmPin}</button>}
        </div>
      </Q>

      {loc.pinConfirmed && (
        <Q label={L.parcel} help={L.parcelHelp}>
          {looking ? <p className="muted small">…</p> : loc.parcel?.source === "suggested" ? (
            <p className="note">{L.parcelSuggested(`${loc.parcel.block}/${loc.parcel.parcel}`)} <span className="tag-unverified">{L.unverified}</span></p>
          ) : !loc.parcel ? <p className="muted small">{L.parcelNone}</p> : null}
          <div className="grid3">
            {(["block", "parcel", "sub"] as const).map((k) => (
              <label key={k} className="mini">
                <span>{k === "block" ? L.block : k === "parcel" ? L.parcelNo : L.sub}</span>
                <input inputMode="numeric" dir="ltr" value={loc.parcel?.[k] ?? ""} onChange={(e) => up((x) => {
                  const p = x.location.parcel ?? { block: "", parcel: "", source: "owner" as const };
                  x.location.parcel = { ...p, [k]: e.target.value.replace(/\D/g, ""), source: "owner" };
                })} />
              </label>
            ))}
          </div>
        </Q>
      )}

      <Q label={L.streetKind}>
        <Cards cols={2} unsure value={loc.street_kind} onChange={(v) => up((x) => { x.location.street_kind = v as Maybe<"main" | "quiet">; })}
          options={[{ key: "quiet", label: L.streetKinds.quiet, icon: "🌳" }, { key: "main", label: L.streetKinds.main, icon: "🚦" }]} />
      </Q>
      <Q label={L.orientation} help={L.orientationHelp}>
        <Chips options={(["N", "S", "E", "W"] as Direction[]).map((k) => ({ key: k, label: L.dirs[k] }))}
          value={Array.isArray(loc.orientation) ? loc.orientation : loc.orientation === "unknown" ? undefined : undefined}
          onChange={(v) => up((x) => { x.location.orientation = Array.isArray(v) ? (v as Direction[]) : undefined; })} />
        <UnsureButtons value={loc.orientation} onChange={(v) => up((x) => { x.location.orientation = v as Maybe<Direction[]>; })} later={false} />
      </Q>
    </>
  );
}

// ---- Property ------------------------------------------------------------------------------------

export function PropertySection({ d, up, caseId, docs, refreshDocs }: SectionProps) {
  const { T, lang } = useIT();
  const P = T.property;
  const lay = tourLayout(d);
  const [moreAreas, setMoreAreas] = useState(isKnown(d.size.registered) || isKnown(d.size.arnona) || isKnown(d.size.plan));
  const roomNames = [
    lang === "he" ? "סלון" : "Living room", lang === "he" ? "מטבח" : "Kitchen",
    ...Array.from({ length: lay.bedrooms }, (_, i) => (lang === "he" ? `חדר שינה ${i + 1}` : `Bedroom ${i + 1}`)),
    ...Array.from({ length: lay.bathrooms }, (_, i) => (lang === "he" ? `חדר רחצה${lay.bathrooms > 1 ? ` ${i + 1}` : ""}` : `Bathroom${lay.bathrooms > 1 ? ` ${i + 1}` : ""}`)),
    ...Array.from({ length: lay.toilets }, () => (lang === "he" ? "שירותי אורחים" : "Guest toilet")),
    ...d.rooms.custom.filter(Boolean),
  ];
  const nBalc = isKnown(d.balconies.count) ? d.balconies.count : 0;
  const srcOpts: AreaSource[] = ["estimate", "measured", "arnona", "registered", "plan", "other"];

  return (
    <>
      <SectionHead title={P.title} sub={P.sub} icon="🏠" />

      <Block title={P.size} icon="📐" done={isKnown(d.size.interior)}>
        <Q label={P.interior} help={P.interiorHelp}>
          <NumberAsk value={d.size.interior} unit={T.ui.sqm} min={10} max={2000} onChange={(v) => up((x) => { x.size.interior = v; })} />
        </Q>
        {isKnown(d.size.interior) && (
          <Q label={P.source}>
            <div className="chip-row">
              {srcOpts.map((k) => (
                <button key={k} type="button" className={"pick" + (d.size.interiorSource === k ? " on" : "")} aria-pressed={d.size.interiorSource === k}
                  onClick={() => up((x) => { x.size.interiorSource = k; })}>{P.sources[k]}</button>
              ))}
            </div>
          </Q>
        )}
        {asksPlot(d) && <Q label={P.plot}><NumberAsk value={d.size.plot} unit={T.ui.sqm} onChange={(v) => up((x) => { x.size.plot = v; })} /></Q>}
        {!moreAreas ? (
          <button type="button" className="link-btn" onClick={() => setMoreAreas(true)}>{P.moreAreas}</button>
        ) : (
          <div className="grid3">
            <Q label={P.registered}><NumberAsk value={d.size.registered} unit={T.ui.sqm} unsure={false} onChange={(v) => up((x) => { x.size.registered = v; })} /></Q>
            <Q label={P.arnona}><NumberAsk value={d.size.arnona} unit={T.ui.sqm} unsure={false} onChange={(v) => up((x) => { x.size.arnona = v; })} /></Q>
            <Q label={P.planArea}><NumberAsk value={d.size.plan} unit={T.ui.sqm} unsure={false} onChange={(v) => up((x) => { x.size.plan = v; })} /></Q>
          </div>
        )}
      </Block>

      <Block title={P.rooms} icon="🛏️" done={isKnown(d.rooms.rooms) && isKnown(d.rooms.bedrooms)}>
        <div className="grid2">
          <Q label={P.roomsCount} help={P.roomsHelp}><Counter value={d.rooms.rooms} step={0.5} min={1} max={15} onChange={(v) => up((x) => { x.rooms.rooms = v; })} /></Q>
          <Q label={P.bedrooms}><Counter value={d.rooms.bedrooms} max={10} onChange={(v) => up((x) => { x.rooms.bedrooms = v; })} /></Q>
          <Q label={P.bathrooms}><Counter value={d.rooms.bathrooms} max={8} onChange={(v) => up((x) => { x.rooms.bathrooms = v; })} /></Q>
          <Q label={P.toilets}><Counter value={d.rooms.toilets} max={5} onChange={(v) => up((x) => { x.rooms.toilets = v; })} /></Q>
        </div>
        <div className="room-list">
          <span className="small muted">{P.roomList}</span>
          <div className="chip-row">{roomNames.map((n, i) => <span key={i} className="room-chip">{n}</span>)}</div>
          {d.rooms.custom.map((name, i) => (
            <div key={i} className="custom-room">
              <input value={name} placeholder={P.customRoom} onChange={(e) => up((x) => { x.rooms.custom[i] = e.target.value; })} />
              <button type="button" className="ghost" aria-label="✕" onClick={() => up((x) => { x.rooms.custom.splice(i, 1); })}>✕</button>
            </div>
          ))}
          {d.rooms.custom.length < 6 && <button type="button" className="link-btn" onClick={() => up((x) => { x.rooms.custom.push(""); })}>{P.addRoom}</button>}
        </div>
      </Block>

      <Block title={P.outdoor} icon="🌤️" done={isKnown(d.balconies.count)}>
        <Q label={P.balconies}><Counter value={d.balconies.count} max={6} onChange={(v) => up((x) => {
          x.balconies.count = v;
          const n = isKnown(v) ? v : 0;
          while (x.balconies.items.length < n) x.balconies.items.push({ size: undefined, sukkah: undefined });
        })} /></Q>
        {Array.from({ length: nBalc }, (_, i) => (
          <div key={i} className="sub-card">
            <b>{P.balcony(i + 1)}</b>
            <div className="grid2">
              <Q label={P.balconySize}><NumberAsk value={d.balconies.items[i]?.size} unit={T.ui.sqm} later={false} onChange={(v) => up((x) => { x.balconies.items[i]!.size = v; })} /></Q>
              <Q label={P.sukkah} help={P.sukkahHelp}><YesNo value={d.balconies.items[i]?.sukkah} onChange={(v) => up((x) => { x.balconies.items[i]!.sukkah = v; })} /></Q>
            </div>
          </div>
        ))}
        {asksGarden(d) && (
          <>
            <Q label={P.garden}><YesNo value={d.garden.exists} unsure={false} onChange={(v) => up((x) => { x.garden.exists = v; })} /></Q>
            {d.garden.exists === "yes" && (
              <>
                <Q label={P.gardenKind} help={P.gardenKindHelp}>
                  <Cards cols={3} unsure value={d.garden.kind} onChange={(v) => up((x) => { x.garden.kind = v as Dossier["garden"]["kind"]; })}
                    options={(["private", "exclusive", "shared"] as const).map((k) => ({ key: k, label: P.gardenKinds[k] }))} />
                </Q>
                <Q label={P.gardenSize}><NumberAsk value={d.garden.size} unit={T.ui.sqm} onChange={(v) => up((x) => { x.garden.size = v; })} /></Q>
              </>
            )}
          </>
        )}
        {asksRoof(d) && (
          <>
            <Q label={P.roof}>
              <Cards cols={2} unsure value={d.roof.kind} onChange={(v) => up((x) => { x.roof.kind = v as Dossier["roof"]["kind"]; })}
                options={(["private", "exclusive", "shared", "none"] as const).map((k) => ({ key: k, label: P.roofKinds[k] }))} />
            </Q>
            {(d.roof.kind === "private" || d.roof.kind === "exclusive") && (
              <Q label={P.roofSize}><NumberAsk value={d.roof.size} unit={T.ui.sqm} onChange={(v) => up((x) => { x.roof.size = v; })} /></Q>
            )}
          </>
        )}
      </Block>

      <Block title={P.parking} icon="🚗" done={isKnown(d.parking.count) && d.storage.exists !== undefined}>
        <Q label={P.parkingCount}><Counter value={d.parking.count} max={6} onChange={(v) => up((x) => { x.parking.count = v; })} /></Q>
        {isKnown(d.parking.count) && d.parking.count > 0 && (
          <>
            <Q label={P.parkingKind} help={P.parkingKindHelp}>
              <Cards cols={2} unsure value={d.parking.kind} onChange={(v) => up((x) => { x.parking.kind = v as Dossier["parking"]["kind"]; })}
                options={(["registered", "assigned", "shared", "street"] as const).map((k) => ({ key: k, label: P.parkingKinds[k] }))} />
            </Q>
            <div className="chip-row">
              {(["covered", "underground", "tandem", "mechanical", "ev"] as const).map((k) => (
                <button key={k} type="button" className={"pick" + (d.parking.features.includes(k) ? " on" : "")} aria-pressed={d.parking.features.includes(k)}
                  onClick={() => up((x) => { x.parking.features = x.parking.features.includes(k) ? x.parking.features.filter((f) => f !== k) : [...x.parking.features, k]; })}>{P.parkingFeatures[k]}</button>
              ))}
            </div>
          </>
        )}
        <Q label={P.storage}><YesNo value={d.storage.exists} unsure={false} onChange={(v) => up((x) => { x.storage.exists = v; })} /></Q>
        {d.storage.exists === "yes" && (
          <div className="grid2">
            <Q label={P.storageSize}><NumberAsk value={d.storage.size} unit={T.ui.sqm} later={false} onChange={(v) => up((x) => { x.storage.size = v; })} /></Q>
            <Q label={P.storageReg}><YesNo value={d.storage.registered} onChange={(v) => up((x) => { x.storage.registered = v; })} /></Q>
          </div>
        )}
      </Block>

      <Block title={P.building} icon="🏢" done={d.building.yearBuilt !== undefined && d.building.mamad !== undefined}>
        <Q label={P.yearBuilt} hint={P.yearHint}>
          <NumberAsk value={d.building.yearBuilt} min={1850} max={new Date().getFullYear() + 5} placeholder="1975" onChange={(v) => up((x) => { x.building.yearBuilt = v; })} />
        </Q>
        {asksFloor(d) && (
          <>
            <Q label={P.elevator}><YesNo value={d.building.elevator} unsure={false} onChange={(v) => up((x) => { x.building.elevator = v; })} /></Q>
            {d.building.elevator === "yes" && <Q label={P.shabbat}><YesNo value={d.building.shabbatElevator} onChange={(v) => up((x) => { x.building.shabbatElevator = v; })} /></Q>}
          </>
        )}
        <Q label={P.mamad} help={P.mamadHelp}><YesNo value={d.building.mamad} onChange={(v) => up((x) => { x.building.mamad = v; })} /></Q>
        {d.building.mamad === "no" && <Q label={P.shelter}><YesNo value={d.building.shelter} onChange={(v) => up((x) => { x.building.shelter = v; })} /></Q>}
      </Block>

      <Block title={P.plan} icon="🗺️" defaultOpen={false} done={docs.some((x) => x.kind === "floor_plan")}>
        <p className="muted small">{P.planUploadHint}</p>
        <DocSlot kind="floor_plan" label={P.planUpload} d={d} up={up} caseId={caseId} docs={docs} refreshDocs={refreshDocs} />
      </Block>
    </>
  );
}

// ---- Documents -------------------------------------------------------------------------------------

export function DocSlot({ kind, label, help, d, up, caseId, docs, refreshDocs }: { kind: string; label: string; help?: string; key?: string } & SectionProps) {
  const { T } = useIT();
  const G = T.legal;
  const mine = docs.filter((x) => x.kind === kind);
  const later = d.docsLater.includes(kind);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setErr(null);
    try {
      for (const f of Array.from(files)) await uploadDocument(caseId, f, kind);
      up((x) => { x.docsLater = x.docsLater.filter((k) => k !== kind); });
      refreshDocs();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={"doc-slot" + (mine.length ? " got" : later ? " later" : "")}>
      <div className="doc-main">
        <span className="doc-state" aria-hidden>{mine.length ? "✓" : later ? "⏳" : "📄"}</span>
        <div>
          <b>{label}</b>
          {help && <div className="small muted">{help}</div>}
          {mine.length > 0 && <div className="small ok-text">{G.uploaded}: {mine.map((m) => m.fileName).join(", ")}</div>}
          {err && <div className="small warnings">{err}</div>}
        </div>
      </div>
      <div className="doc-actions">
        <label className={"button " + (mine.length ? "ghost" : "primary")}>
          {busy ? "…" : mine.length ? G.replace : G.upload}
          <input type="file" accept="application/pdf,image/*,.doc,.docx" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        </label>
        {!mine.length && (
          <button type="button" className={"unsure" + (later ? " on" : "")} aria-pressed={later}
            onClick={() => up((x) => { x.docsLater = later ? x.docsLater.filter((k) => k !== kind) : [...x.docsLater, kind]; })}>{G.laterDoc}</button>
        )}
      </div>
    </div>
  );
}

/** Which documents to ask for, from what we know so far. */
export function docKinds(d: Dossier): string[] {
  const reg = d.legal.registry;
  const out: string[] = [];
  if (reg === undefined || reg === "tabu" || reg === "unknown" || reg === "later") out.push("tabu");
  if (reg === "ila" || reg === "company" || reg === "amidar" || reg === "other") out.push("rights_confirmation");
  out.push("purchase_contract", "building_permit");
  if (isKnown(d.building.yearBuilt) && d.building.yearBuilt >= new Date().getFullYear() - 15) out.push("form4");
  out.push("arnona");
  return out;
}

// ---- Legal -------------------------------------------------------------------------------------------

export function LegalSection(props: SectionProps) {
  const { d, up } = props;
  const { T } = useIT();
  const G = T.legal;
  return (
    <>
      <SectionHead title={G.title} sub={G.sub} icon="📑" />
      <Q label={G.registry} help={G.registryHelp}>
        <Cards cols={3} unsure value={d.legal.registry} onChange={(v) => up((x) => { x.legal.registry = v as Maybe<Registry>; })}
          options={(["tabu", "ila", "amidar", "company", "other"] as Registry[]).map((k) => ({ key: k, label: G.registries[k], sub: G.registrySubs[k] || undefined }))} />
      </Q>
      <Q label={G.rights} help={G.rightsHelp}>
        <Cards cols={3} unsure value={d.legal.rights} onChange={(v) => up((x) => { x.legal.rights = v as Maybe<RightsKind>; })}
          options={(["ownership", "leasehold", "long_lease", "contractual", "other"] as RightsKind[]).map((k) => ({ key: k, label: G.rightsKinds[k] }))} />
      </Q>
      {asksCapitalized(d) && <Q label={G.capitalized} help={G.capitalizedHelp}><YesNo value={d.legal.capitalized} onChange={(v) => up((x) => { x.legal.capitalized = v; })} /></Q>}
      <Q label={G.restrictions} help={G.restrictionsHelp}>
        <Chips unsure none={G.none} value={d.legal.restrictions} onChange={(v) => up((x) => { x.legal.restrictions = v; })}
          options={RESTRICTIONS.map((k) => ({ key: k, label: G.restrictionsList[k] }))} />
      </Q>
      <Q label={G.deviations} help={G.deviationsHelp}>
        <Chips unsure none={G.noChanges} value={d.legal.deviations} onChange={(v) => up((x) => { x.legal.deviations = v; })}
          options={DEVIATIONS.map((k) => ({ key: k, label: G.deviationsList[k] }))} />
      </Q>
      <Q label={G.renewal} help={G.renewalHelp}>
        <Cards cols={2} unsure value={d.legal.renewal} onChange={(v) => up((x) => { x.legal.renewal = v as Dossier["legal"]["renewal"]; })}
          options={(["none", "talks", "signed", "developer"] as const).map((k) => ({ key: k, label: G.renewals[k] }))} />
      </Q>
      <Q label={G.enforcement}><YesNo value={d.legal.enforcement} onChange={(v) => up((x) => { x.legal.enforcement = v; })} /></Q>

      <Block title={G.docs} icon="📎">
        <p className="muted small">{G.docsSub}</p>
        {docKinds(d).map((k) => (
          <DocSlot key={k} kind={k} label={G.docKinds[k as keyof typeof G.docKinds]} help={G.docHelp[k as keyof typeof G.docHelp] || undefined} {...props} />
        ))}
        <DocSlot kind="other" label={G.docKinds.other} {...props} />
      </Block>
    </>
  );
}

// ---- Occupancy ---------------------------------------------------------------------------------------

export function OccupancySection(props: SectionProps) {
  const { d, up } = props;
  const { T } = useIT();
  const O = T.occupancy;
  return (
    <>
      <SectionHead title={O.title} icon="🗝️" />
      <Q label={O.kind}>
        <Cards cols={3} value={d.occupancy.kind} onChange={(v) => up((x) => { x.occupancy.kind = v as Dossier["occupancy"]["kind"]; })}
          options={(["owner", "tenant", "vacant", "family", "mixed", "other"] as const).map((k) => ({ key: k, label: O.kinds[k] }))} />
      </Q>
      {isRented(d) && (
        <Block title={O.kinds.tenant} icon="📃">
          <div className="grid2">
            <Q label={O.rent}><NumberAsk value={d.occupancy.rent} unit={T.ui.nis} onChange={(v) => up((x) => { x.occupancy.rent = v; })} /></Q>
            <Q label={O.leaseEnd}>
              <input type="date" className="text-ask" value={isKnown(d.occupancy.leaseEnd) ? d.occupancy.leaseEnd : ""} onChange={(e) => up((x) => { x.occupancy.leaseEnd = e.target.value || undefined; })} />
              <UnsureButtons value={d.occupancy.leaseEnd} onChange={(v) => up((x) => { x.occupancy.leaseEnd = v; })} />
            </Q>
          </div>
          <Q label={O.indexed}><YesNo value={d.occupancy.indexed} onChange={(v) => up((x) => { x.occupancy.indexed = v; })} /></Q>
          <DocSlot kind="rental_contract" label={O.rentUpload} help={O.rentUploadHint} {...props} />
        </Block>
      )}
      <Block title={O.costs} icon="💳">
        <div className="grid2">
          <Q label={O.vaad}><NumberAsk value={d.occupancy.vaad} unit={T.ui.nis} onChange={(v) => up((x) => { x.occupancy.vaad = v; })} /></Q>
          <Q label={O.arnona}>
            <div className="num-with-period">
              <NumberAsk value={d.occupancy.arnona} unit={T.ui.nis} onChange={(v) => up((x) => { x.occupancy.arnona = v; })} />
              <select value={d.occupancy.arnonaPeriod ?? "two_months"} onChange={(e) => up((x) => { x.occupancy.arnonaPeriod = e.target.value as "month"; })}>
                {(["month", "two_months", "year"] as const).map((k) => <option key={k} value={k}>{O.period[k]}</option>)}
              </select>
            </div>
          </Q>
        </div>
        <Q label={O.special}><YesNo value={d.occupancy.special} onChange={(v) => up((x) => { x.occupancy.special = v; })} /></Q>
      </Block>
      {isSale(d) && (
        <Block title={O.sale} icon="🏷️">
          <p className="muted small">{O.saleSub}</p>
          <Q label={O.asking}><NumberAsk value={d.sale.asking} unit={T.ui.nis} onChange={(v) => up((x) => { x.sale.asking = v; })} /></Q>
          <Q label={O.advertised}><YesNo value={d.sale.advertised} unsure={false} onChange={(v) => up((x) => { x.sale.advertised = v; })} /></Q>
          {d.sale.advertised === "yes" && (
            <>
              <Q label={O.since}><input type="date" className="text-ask" value={isKnown(d.sale.since) ? d.sale.since : ""} onChange={(e) => up((x) => { x.sale.since = e.target.value || undefined; })} /></Q>
              <Q label={O.reduced}><YesNo value={d.sale.reduced} unsure={false} onChange={(v) => up((x) => { x.sale.reduced = v; })} /></Q>
            </>
          )}
          <Q label={O.agent}><YesNo value={d.sale.agent} unsure={false} onChange={(v) => up((x) => { x.sale.agent = v; })} /></Q>
        </Block>
      )}
    </>
  );
}

// ---- Review ------------------------------------------------------------------------------------------

export function ReviewSection({ d, docs, shots, onEdit, onSubmit, submitted, submitting }: SectionProps & {
  shots: { done: number; total: number }; onEdit: (s: "setup" | "location" | "property" | "legal" | "occupancy" | "tour") => void;
  onSubmit: () => void; submitted: boolean; submitting: boolean;
}) {
  const { T, f } = useIT();
  const R = T.review;
  const L = T.location;
  const fl = flags(d);
  const u = (v: unknown) => (v === "unknown" ? T.ui.dontKnow : v === "later" ? T.ui.later : v === undefined || v === "" ? "—" : String(v));
  const area = (v: Maybe<number>) => (isKnown(v) ? `${v} ${T.ui.sqm}` : u(v));
  const rows: { s: "setup" | "location" | "property" | "legal" | "occupancy" | "tour"; title: string; lines: string[] }[] = [
    { s: "setup", title: T.sections.setup, lines: [d.setup.purpose ? T.setup.purposes[d.setup.purpose] : "—", d.setup.submitter ? T.setup.submitters[d.setup.submitter] : "—"] },
    { s: "location", title: T.sections.location, lines: [
      [d.location.street, d.location.number].filter(Boolean).join(" ") + (d.location.city ? `, ${d.location.city}` : ""),
      d.location.type ? L.types[d.location.type] : "—",
      asksFloor(d) ? `${L.floor} ${u(d.location.floor)} / ${u(d.location.floors)}` : "",
      d.location.parcel ? `${L.block} ${d.location.parcel.block} · ${L.parcelNo} ${d.location.parcel.parcel}${d.location.parcel.source === "suggested" ? ` (${L.unverified})` : ""}` : "",
    ].filter(Boolean) },
    { s: "property", title: T.sections.property, lines: [
      `${T.property.interior}: ${area(d.size.interior)}${d.size.interiorSource ? ` (${T.property.sources[d.size.interiorSource]})` : ""}`,
      `${T.property.roomsCount}: ${u(d.rooms.rooms)} · ${T.property.bedrooms}: ${u(d.rooms.bedrooms)}`,
      `${T.property.balconies.replace("?", "")}: ${u(d.balconies.count)} · ${T.property.parkingCount.replace("?", "")}: ${u(d.parking.count)}`,
      `${T.property.yearBuilt}: ${u(d.building.yearBuilt)} · ${T.property.mamad.replace("?", "")}: ${d.building.mamad === "yes" ? T.ui.yes : d.building.mamad === "no" ? T.ui.no : u(d.building.mamad)}`,
    ] },
    { s: "legal", title: T.sections.legal, lines: [
      `${T.legal.registry.replace("?", "")}: ${isKnown(d.legal.registry) ? T.legal.registries[d.legal.registry] : u(d.legal.registry)}`,
      `${T.legal.rights}: ${isKnown(d.legal.rights) ? T.legal.rightsKinds[d.legal.rights] : u(d.legal.rights)}`,
      `${T.legal.docs}: ${docs.length}`,
    ] },
    { s: "occupancy", title: T.sections.occupancy, lines: [d.occupancy.kind ? T.occupancy.kinds[d.occupancy.kind] : "—", ...(isRented(d) && isKnown(d.occupancy.rent) ? [`${T.occupancy.rent}: ${f.nis(d.occupancy.rent)}`] : [])] },
    { s: "tour", title: T.sections.tour, lines: [`${shots.done} / ${shots.total}`] },
  ];
  const later = d.docsLater.length;
  return (
    <>
      <SectionHead title={R.title} sub={R.sub} icon="✅" />
      {fl.length > 0 && (
        <div className="flags">
          <b>{R.flagsTitle}</b>
          <ul>
            {fl.map((x, i) => (
              <li key={i}>
                {x.kind === "area_registered" ? R.areaRegistered(x.a!, x.b!) : x.kind === "area_arnona" ? R.areaArnona(x.a!, x.b!) : x.kind === "deviation_reported" ? R.deviation : R.enforcement}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="review-list">
        {rows.map((r) => (
          <div key={r.s} className="review-row">
            <div><b>{r.title}</b>{r.lines.map((l, i) => <div key={i} className="small">{l}</div>)}</div>
            <button type="button" className="ghost" onClick={() => onEdit(r.s)}>{T.ui.edit}</button>
          </div>
        ))}
      </div>
      {(later > 0 || shots.done < shots.total) && (
        <div className="missing">
          <b>{R.missing}</b>
          {later > 0 && <div className="small">{R.missingDocs(later)}</div>}
          {shots.done < shots.total && <div className="small">{R.missingShots(shots.total - shots.done)}</div>}
        </div>
      )}
      <p className="small muted">{R.statementNote}</p>
      {submitted ? <div className="notice">{R.submitted}</div> : (
        <button type="button" className="primary big" disabled={submitting} onClick={onSubmit}>{R.submit}</button>
      )}
    </>
  );
}
