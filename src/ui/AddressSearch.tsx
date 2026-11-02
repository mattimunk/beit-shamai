import { useEffect, useState } from "react";
import { searchAddress, type GeocodeHit } from "../data/apiClient";
import { useT } from "./context";

export function AddressSearch({ onPick }: { onPick: (h: GeocodeHit) => void }) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const id = setTimeout(async () => {
      try {
        setHits(await searchAddress(q));
        setError(false);
      } catch {
        setError(true);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div className="address-search">
      <input
        value={q}
        placeholder={t.addressPlaceholder}
        aria-label={t.addressSearch}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <div className="small muted">{t.addressError}</div>}
      {hits.length > 0 && (
        <ul className="hits" role="listbox">
          {hits.map((h, i) => (
            <li key={i} role="option" aria-selected={false}>
              <button type="button" onClick={() => { onPick(h); setQ(h.label); setHits([]); }}>
                <bdi>{h.label}</bdi>
              </button>
            </li>
          ))}
          {hits[0]?.attribution && <li className="small muted attribution">{hits[0].attribution}</li>}
        </ul>
      )}
    </div>
  );
}
