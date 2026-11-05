import { useEffect, useState } from "react";
import { knownCases, listCaseFiles, type CaseSummaryDto } from "../data/apiClient";
import { useT } from "./context";

/** Current property file, a list to switch between files, and "new property". */
export function PropertyBar({ caseId, address, onOpen, onNew, refreshKey }: {
  caseId: string; address: string; onOpen: (id: string) => void; onNew: () => void; refreshKey: number;
}) {
  const { t } = useT();
  const P = t.files;
  const [list, setList] = useState<CaseSummaryDto[]>([]);
  useEffect(() => { listCaseFiles(knownCases()).then(setList).catch(() => setList([])); }, [refreshKey]);
  const inList = list.some((c) => c.id === caseId);
  return (
    <div className="property-bar no-print">
      <span className="small muted">{P.current}</span>
      <select value={caseId} onChange={(e) => onOpen(e.target.value)} aria-label={P.current}>
        {!inList && <option value={caseId}>{address || P.untitled}</option>}
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {(c.address.trim() || P.untitled) + (c.shots ? ` · ${P.shots(c.shots)}` : "")}
          </option>
        ))}
      </select>
      <button type="button" className="ghost" onClick={onNew}>＋ {P.new}</button>
    </div>
  );
}
