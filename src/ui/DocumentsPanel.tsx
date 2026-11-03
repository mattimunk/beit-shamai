import { useRef, useState } from "react";
import { DOC_FIELDS, guessKind, type DocKind, type DocumentRecord } from "../data/documents";
import { uploadAdvertPrint, uploadDocument } from "../data/apiClient";
import { useT } from "./context";

const KINDS = Object.keys(DOC_FIELDS) as DocKind[];

export function DocumentsPanel({
  docs,
  onChange,
  live,
  caseId,
  city,
}: {
  docs: DocumentRecord[];
  onChange: (d: DocumentRecord[]) => void;
  live: boolean;
  caseId: string;
  city: string;
}) {
  const { t } = useT();
  const T = t.docs;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // Latest list, so async updates from several uploads don't overwrite each other.
  const latest = useRef(docs);
  latest.current = docs;
  const patch = (id: string, p: Partial<DocumentRecord>) => {
    latest.current = latest.current.map((d) => (d.id === id ? { ...d, ...p } : d));
    onChange(latest.current);
  };

  const readAdverts = async (d: DocumentRecord, file?: File) => {
    try {
      const f = file ?? new File([await (await fetch(d.url!)).blob()], d.fileName, { type: "application/pdf" });
      patch(d.id, { adverts: { read: 0, used: 0, status: "reading" } });
      const out = await uploadAdvertPrint(caseId, f, city);
      const rows = out.adverts.map((a) => ({
        price: a.card.price, previousPrice: a.card.previousPrice, rooms: a.card.rooms, floor: a.card.floor, area: a.card.area,
        address: [a.card.street, a.card.number].filter(Boolean).join(" ") + (a.card.neighbourhood ? `, ${a.card.neighbourhood}` : ""),
        used: a.used, reason: a.reason,
      }));
      patch(d.id, { serverId: d.serverId ?? "advert", adverts: { read: rows.length, used: rows.filter((r) => r.used).length, status: "done", rows } });
    } catch (e) {
      patch(d.id, { adverts: { read: 0, used: 0, status: "error", error: (e as Error).message } });
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const added: DocumentRecord[] = Array.from(files).map((file) => ({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: guessKind(file.name),
      fileName: file.name,
      size: file.size,
      mime: file.type,
      addedAt: new Date().toISOString(),
      fields: {},
      url: URL.createObjectURL(file),
    }));
    latest.current = [...docs, ...added];
    onChange(latest.current);
    if (live) {
      // Store on the server in the background; mark each when done.
      const files2 = Array.from(files);
      for (let i = 0; i < added.length; i++) {
        if (added[i]!.kind === "advert_print" && /\.pdf$/i.test(added[i]!.fileName)) {
          await readAdverts(added[i]!, files2[i]!);
          continue;
        }
        try {
          const serverId = await uploadDocument(caseId, files2[i]!, added[i]!.kind);
          patch(added[i]!.id, { serverId });
        } catch {
          /* leave as local-only; the row shows no "stored" badge */
        }
      }
    }
  };

  const update = (id: string, patch: Partial<DocumentRecord>) => onChange(docs.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const setField = (d: DocumentRecord, key: string, v: string | number | boolean) => update(d.id, { fields: { ...d.fields, [key]: v } });

  return (
    <fieldset className="section docs">
      <legend>{T.title}</legend>
      <div
        className={"dropzone" + (over ? " over" : "")}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
      >
        {T.drop}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx,.dwg,.dwf"
          onChange={(e) => {
            const el = e.currentTarget;
            const picked = el.files ? Array.from(el.files) : [];
            if (picked.length) addFiles(picked);
            setTimeout(() => { el.value = ""; }, 0); // allow re-selecting the same file
          }}
        />
      </div>
      <p className="small muted">{live ? T.privacyLive : T.privacyDemo} {T.hint}</p>

      {docs.map((d) => (
        <div className="doc" key={d.id}>
          <div className="doc-head">
            <select value={d.kind} onChange={(e) => update(d.id, { kind: e.target.value as DocKind, fields: {} })} aria-label="kind">
              {KINDS.map((k) => <option key={k} value={k}>{T.kind[k]}</option>)}
            </select>
            <span className="doc-name" title={d.fileName}><bdi>{d.fileName}</bdi></span>
            {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="small">{T.open}</a>}
            {d.serverId && <span className="badge conf-high small">{T.uploaded}</span>}
            <button type="button" className="icon" aria-label={t.remove} title={t.remove} onClick={() => { if (d.url) URL.revokeObjectURL(d.url); onChange(docs.filter((x) => x.id !== d.id)); }}>×</button>
          </div>
          {d.kind === "advert_print" && (
            <div className="adverts">
              {!live && <p className="small muted">{T.advDemo}</p>}
              {live && !d.adverts && d.url && <button type="button" className="ghost" onClick={() => readAdverts(d)}>{T.advRead}</button>}
              {d.adverts?.status === "reading" && <p className="small muted">{T.advReading}</p>}
              {d.adverts?.status === "error" && <p className="small warnings">{d.adverts.error}</p>}
              {d.adverts?.status === "done" && (
                <>
                  <p className="small">{T.advDone(d.adverts.read, d.adverts.used)}</p>
                  <table className="adv-table small">
                    <thead><tr><th>{T.advCols.price}</th><th>{T.advCols.rooms}</th><th>{T.advCols.floor}</th><th>{T.advCols.area}</th><th>{T.advCols.address}</th><th>{T.advCols.status}</th></tr></thead>
                    <tbody>
                      {d.adverts.rows!.map((r, i) => (
                        <tr key={i} className={r.used ? "" : "muted"}>
                          <td><bdi>{r.price.toLocaleString("en")}</bdi>{r.previousPrice && <div className="small">{T.advDrop(r.previousPrice)}</div>}</td>
                          <td>{r.rooms ?? "—"}</td><td>{r.floor ?? "—"}</td><td>{r.area ?? "—"}</td>
                          <td><bdi>{r.address || "—"}</bdi></td>
                          <td title={r.reason}>{r.used ? "✓" : <span className="small">{r.reason}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
          <div className="grid">
            {DOC_FIELDS[d.kind].map((fd) => {
              const v = d.fields[fd.key];
              const label = T.field[fd.key as keyof typeof T.field] ?? fd.key;
              if (fd.type === "bool") {
                return (
                  <label key={fd.key} className="inline">
                    <input type="checkbox" checked={v === true} onChange={(e) => setField(d, fd.key, e.target.checked)} /> {label}
                  </label>
                );
              }
              if (fd.type === "rights") {
                return (
                  <label key={fd.key} className="field"><span>{label}</span>
                    <select value={String(v ?? "")} onChange={(e) => setField(d, fd.key, e.target.value)}>
                      <option value="">—</option>
                      <option value="ownership">{t.rightsOpt.ownership}</option>
                      <option value="leasehold">{t.rightsOpt.leasehold}</option>
                    </select>
                  </label>
                );
              }
              if (fd.type === "planType") {
                return (
                  <label key={fd.key} className="field"><span>{label}</span>
                    <select value={String(v ?? "")} onChange={(e) => setField(d, fd.key, e.target.value)}>
                      <option value="">—</option>
                      {(Object.keys(T.planType) as (keyof typeof T.planType)[]).map((k) => <option key={k} value={k}>{T.planType[k]}</option>)}
                    </select>
                  </label>
                );
              }
              return (
                <label key={fd.key} className={"field" + (fd.type === "text" && fd.key === "notes" ? " wide" : "")}><span>{label}</span>
                  <input
                    type={fd.type === "date" ? "date" : fd.type === "text" ? "text" : "number"}
                    value={v === undefined ? "" : String(v)}
                    onChange={(e) => setField(d, fd.key, fd.type === "money" || fd.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
