import type { ReactNode } from "react";
import type { AddOn, AddOnType, AreaLevel, Direction, ParkingKind, Subject } from "../engine/types";
import { useT } from "./context";

type Props = { subject: Subject; onChange: (s: Subject) => void };

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Num({ value, onChange, step = 1, min }: { value: number; onChange: (n: number) => void; step?: number; min?: number }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={Number.isFinite(value) ? value : ""}
      step={step}
      min={min}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
    />
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="section">
      <legend>{title}</legend>
      <div className="grid">{children}</div>
    </fieldset>
  );
}

const ADDON_TYPES: AddOnType[] = ["sun_balcony", "covered_balcony", "roof_terrace", "garden", "storage", "parking"];
const PARKING: ParkingKind[] = ["regular", "covered", "underground", "tandem", "mechanical"];
const DIRS: Direction[] = ["N", "S", "E", "W"];

export function PropertyForm({ subject: s, onChange }: Props) {
  const { t } = useT();
  const set = (patch: Partial<Subject>) => onChange({ ...s, ...patch });
  const setAddOn = (i: number, patch: Partial<AddOn>) =>
    set({ addOns: s.addOns.map((a, k) => (k === i ? { ...a, ...patch } : a)) });
  const levels = s.area.mode === "measured" ? s.area.levels : [];
  const setLevel = (i: number, patch: Partial<AreaLevel>) =>
    set({ area: { mode: "measured", levels: levels.map((l, k) => (k === i ? { ...l, ...patch } : l)) } });
  const b = s.building ?? { unitsInBuilding: 0, plotSqm: 0, existingBuiltSqm: 0 };

  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <Section title={t.secProperty}>
        <Field label={t.street}>
          <input value={s.address.street} onChange={(e) => set({ address: { ...s.address, street: e.target.value } })} />
        </Field>
        <Field label={t.number}>
          <input value={s.address.number} onChange={(e) => set({ address: { ...s.address, number: e.target.value } })} />
        </Field>
        <Field label={t.city} wide>
          <input value={s.address.city} readOnly />
        </Field>
        <Field label={t.block}>
          <input value={s.parcel?.block ?? ""} onChange={(e) => set({ parcel: { ...(s.parcel ?? { parcel: "" }), block: e.target.value } })} />
        </Field>
        <Field label={t.parcel}>
          <input value={s.parcel?.parcel ?? ""} onChange={(e) => set({ parcel: { ...(s.parcel ?? { block: "" }), parcel: e.target.value } })} />
        </Field>
        <Field label={t.subParcel}>
          <input value={s.parcel?.subParcel ?? ""} onChange={(e) => set({ parcel: { ...(s.parcel ?? { block: "", parcel: "" }), subParcel: e.target.value } })} />
        </Field>
        <Field label={t.rights}>
          <select value={s.rights} onChange={(e) => set({ rights: e.target.value as Subject["rights"] })}>
            <option value="ownership">{t.rightsOpt.ownership}</option>
            <option value="leasehold">{t.rightsOpt.leasehold}</option>
          </select>
        </Field>
      </Section>

      <Section title={t.secUnit}>
        <Field label={t.rooms}><Num value={s.rooms} step={0.5} min={1} onChange={(rooms) => set({ rooms })} /></Field>
        <Field label={t.floor}><Num value={s.floor} min={0} onChange={(floor) => set({ floor })} /></Field>
        <Field label={t.floorsInBuilding}><Num value={s.floorsInBuilding} min={1} onChange={(floorsInBuilding) => set({ floorsInBuilding })} /></Field>
        <Field label={t.yearBuilt}><Num value={s.yearBuilt} min={1900} onChange={(yearBuilt) => set({ yearBuilt })} /></Field>
        <Field label={t.condition}>
          <select value={s.condition} onChange={(e) => set({ condition: e.target.value as Subject["condition"] })}>
            {(Object.keys(t.conditionOpt) as Subject["condition"][]).map((k) => <option key={k} value={k}>{t.conditionOpt[k]}</option>)}
          </select>
        </Field>
        <Field label={t.view}>
          <select value={s.view} onChange={(e) => set({ view: e.target.value as Subject["view"] })}>
            {(Object.keys(t.viewOpt) as Subject["view"][]).map((k) => <option key={k} value={k}>{t.viewOpt[k]}</option>)}
          </select>
        </Field>
        <div className="checks wide">
          <label><input type="checkbox" checked={s.elevator} onChange={(e) => set({ elevator: e.target.checked })} /> {t.elevator}</label>
          <label><input type="checkbox" checked={s.hasSafeRoom} onChange={(e) => set({ hasSafeRoom: e.target.checked })} /> {t.safeRoom}</label>
          <label><input type="checkbox" checked={s.newBuild} onChange={(e) => set({ newBuild: e.target.checked })} /> {t.newBuild}</label>
        </div>
        <div className="checks wide" role="group" aria-label={t.directions}>
          <span className="muted">{t.directions}:</span>
          {DIRS.map((d) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={s.directions.includes(d)}
                onChange={(e) => set({ directions: e.target.checked ? [...s.directions, d] : s.directions.filter((x) => x !== d) })}
              />{" "}
              {t.dirOpt[d]}
            </label>
          ))}
        </div>
      </Section>

      <Section title={t.secArea}>
        <Field label={t.areaMode} wide>
          <select
            value={s.area.mode}
            onChange={(e) =>
              set({
                area:
                  e.target.value === "declared"
                    ? { mode: "declared", area: 90, source: "tabu" }
                    : { mode: "measured", levels: [{ name: "main", internalArea: 80, exteriorWallLengthM: 28, exteriorWallThicknessCm: 25, sharedWallLengthM: 10, sharedWallThicknessCm: 20 }] },
              })
            }
          >
            <option value="measured">{t.areaModeOpt.measured}</option>
            <option value="declared">{t.areaModeOpt.declared}</option>
          </select>
        </Field>
        {s.area.mode === "declared" ? (
          <>
            <Field label={t.declaredArea}>
              <Num value={s.area.area} step={0.1} onChange={(area) => s.area.mode === "declared" && set({ area: { ...s.area, area } })} />
            </Field>
            <Field label={t.declaredSource}>
              <select
                value={s.area.source}
                onChange={(e) => s.area.mode === "declared" && set({ area: { ...s.area, source: e.target.value as "tabu" } })}
              >
                {(Object.keys(t.declaredSourceOpt) as (keyof typeof t.declaredSourceOpt)[]).map((k) => <option key={k} value={k}>{t.declaredSourceOpt[k]}</option>)}
              </select>
            </Field>
          </>
        ) : (
          levels.map((l, i) => (
            <div className="level wide" key={i}>
              {levels.length > 1 && <div className="level-title">{t.level} {i + 1}</div>}
              <div className="grid">
                <Field label={t.internalArea}><Num value={l.internalArea} step={0.1} onChange={(v) => setLevel(i, { internalArea: v })} /></Field>
                <Field label={t.laundry}><Num value={l.laundryNicheSqm ?? 0} step={0.1} onChange={(v) => setLevel(i, { laundryNicheSqm: v })} /></Field>
                <Field label={t.extWallLen}><Num value={l.exteriorWallLengthM} step={0.1} onChange={(v) => setLevel(i, { exteriorWallLengthM: v })} /></Field>
                <Field label={t.extWallThk}><Num value={l.exteriorWallThicknessCm} onChange={(v) => setLevel(i, { exteriorWallThicknessCm: v })} /></Field>
                <Field label={t.sharedWallLen}><Num value={l.sharedWallLengthM} step={0.1} onChange={(v) => setLevel(i, { sharedWallLengthM: v })} /></Field>
                <Field label={t.sharedWallThk}><Num value={l.sharedWallThicknessCm} onChange={(v) => setLevel(i, { sharedWallThicknessCm: v })} /></Field>
                {i > 0 && <Field label={t.attic}><Num value={l.atticAreaAtLeast180 ?? 0} step={0.1} onChange={(v) => setLevel(i, { atticAreaAtLeast180: v })} /></Field>}
              </div>
            </div>
          ))
        )}
        {s.area.mode === "measured" && (
          <button
            type="button"
            className="link wide"
            onClick={() =>
              set({ area: { mode: "measured", levels: [...levels, { name: `level-${levels.length + 1}`, internalArea: 30, exteriorWallLengthM: 14, exteriorWallThicknessCm: 25, sharedWallLengthM: 4, sharedWallThicknessCm: 20 }] } })
            }
          >
            + {t.addLevel}
          </button>
        )}
      </Section>

      <Section title={t.secAddOns}>
        {s.addOns.map((a, i) => (
          <div className="addon wide" key={i}>
            <select value={a.type} onChange={(e) => setAddOn(i, { type: e.target.value as AddOnType })} aria-label="type">
              {ADDON_TYPES.map((k) => <option key={k} value={k}>{t.addOnType[k]}</option>)}
            </select>
            {a.type === "parking" ? (
              <>
                <select value={a.parkingKind ?? "regular"} onChange={(e) => setAddOn(i, { parkingKind: e.target.value as ParkingKind })} aria-label="parking kind">
                  {PARKING.map((k) => <option key={k} value={k}>{t.parkingKind[k]}</option>)}
                </select>
                <span className="unit-input"><Num value={a.count ?? 1} min={1} onChange={(count) => setAddOn(i, { count })} /></span>
              </>
            ) : (
              <span className="unit-input"><Num value={a.area ?? 0} step={0.5} onChange={(area) => setAddOn(i, { area })} /><small>{t.sqm}</small></span>
            )}
            <select value={a.attachment} onChange={(e) => setAddOn(i, { attachment: e.target.value as AddOn["attachment"] })} aria-label="attachment">
              <option value="attached">{t.attachment.attached}</option>
              <option value="assigned">{t.attachment.assigned}</option>
            </select>
            <label className="inline"><input type="checkbox" checked={a.permitted} onChange={(e) => setAddOn(i, { permitted: e.target.checked })} /> {t.permitted}</label>
            <button type="button" className="icon" title={t.remove} aria-label={t.remove} onClick={() => set({ addOns: s.addOns.filter((_, k) => k !== i) })}>×</button>
          </div>
        ))}
        <button type="button" className="link wide" onClick={() => set({ addOns: [...s.addOns, { type: "sun_balcony", area: 6, attachment: "attached", permitted: true }] })}>
          + {t.addAddOn}
        </button>
      </Section>

      <Section title={t.secBuilding}>
        <Field label={t.units}><Num value={b.unitsInBuilding} onChange={(v) => set({ building: { ...b, unitsInBuilding: v } })} /></Field>
        <Field label={t.plot}><Num value={b.plotSqm} onChange={(v) => set({ building: { ...b, plotSqm: v } })} /></Field>
        <Field label={t.built}><Num value={b.existingBuiltSqm} onChange={(v) => set({ building: { ...b, existingBuiltSqm: v } })} /></Field>
        <Field label={t.planRights}><Num value={b.planRightsPercent ?? 0} onChange={(v) => set({ building: { ...b, planRightsPercent: v } })} /></Field>
      </Section>
    </form>
  );
}
