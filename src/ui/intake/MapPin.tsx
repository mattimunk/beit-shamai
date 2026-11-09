import { useEffect, useRef, useState } from "react";
import { TILE_ATTRIBUTION, TILE_COPYRIGHT_URL, TILE_URL } from "../basemap";

/**
 * A street map with a pin fixed in the middle: drag the map (finger or mouse) until the pin
 * sits on the building. Web-mercator tiles from OpenStreetMap; zoom with the buttons.
 */
const TILE = 256;
const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z * TILE;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TILE;
};
const x2lon = (x: number, z: number) => (x / (2 ** z * TILE)) * 360 - 180;
const y2lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / (2 ** z * TILE)))) * 180) / Math.PI;

export function MapPin({ value, onChange, height = 260 }: { value: { lat: number; lng: number }; onChange: (p: { lat: number; lng: number }) => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [z, setZ] = useState(17);
  const [center, setCenter] = useState({ x: lon2x(value.lng, 17), y: lat2y(value.lat, 17) });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  // Follow outside changes (e.g. a new address picked from the search).
  useEffect(() => { setCenter({ x: lon2x(value.lng, z), y: lat2y(value.lat, z) }); }, [value.lat, value.lng]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const zoom = (dz: number) => {
    const nz = Math.max(12, Math.min(19, z + dz));
    const k = 2 ** (nz - z);
    setCenter({ x: center.x * k, y: center.y * k });
    setZ(nz);
  };
  const commit = (c: { x: number; y: number }) => onChange({ lat: y2lat(c.y, z), lng: x2lon(c.x, z) });

  const left = center.x - w / 2, top = center.y - height / 2;
  const tiles: { key: string; url: string; x: number; y: number }[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++)
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height) / TILE); ty++)
      tiles.push({ key: `${z}/${tx}/${ty}`, url: TILE_URL.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty)), x: tx * TILE - left, y: ty * TILE - top });

  return (
    <div className="map-pin" ref={box} style={{ height }}
      onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y }; }}
      onPointerMove={(e) => { const d = drag.current; if (d) setCenter({ x: d.cx - (e.clientX - d.x), y: d.cy - (e.clientY - d.y) }); }}
      onPointerUp={() => { if (drag.current) { drag.current = null; commit(center); } }}
      onPointerCancel={() => { drag.current = null; }}
      dir="ltr">
      {tiles.map((t) => <img key={t.key} src={t.url} alt="" draggable={false} style={{ left: t.x, top: t.y }} />)}
      <div className="pin" aria-hidden>
        <svg viewBox="0 0 24 36" width="30" height="45"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="#1f5f5b" /><circle cx="12" cy="12" r="4.5" fill="#fff" /></svg>
      </div>
      <div className="map-zoom">
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoom(1)} aria-label="+">+</button>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoom(-1)} aria-label="−">−</button>
      </div>
      <a className="map-attr" href={TILE_COPYRIGHT_URL} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>{TILE_ATTRIBUTION}</a>
    </div>
  );
}
