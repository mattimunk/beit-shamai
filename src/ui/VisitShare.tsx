import { useState } from "react";
import { visitLink } from "../data/apiClient";
import { useT } from "./context";

/** Send the property's filming link: WhatsApp, the phone's share sheet, or copy. */
export function VisitShare({ caseId, address }: { caseId: string; address: string }) {
  const { t } = useT();
  const V = t.visit;
  const [copied, setCopied] = useState(false);
  const link = visitLink(caseId);
  const text = V.shareText(address, link);
  const share = async () => {
    try { await navigator.share({ title: V.title, text, url: link }); } catch { /* cancelled or unsupported */ }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  };
  return (
    <section className="card visit-share">
      <h3>📲 {V.shareTitle}</h3>
      <p className="small muted">{V.shareHelp}</p>
      <div className="shot-actions">
        <a className="button primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">WhatsApp</a>
        {typeof navigator !== "undefined" && "share" in navigator && <button type="button" className="ghost" onClick={share}>{V.shareOther}</button>}
        <button type="button" className="ghost" onClick={copy}>{copied ? V.copied : V.copyLink}</button>
      </div>
      <p className="small link-line"><bdi>{link}</bdi></p>
    </section>
  );
}
