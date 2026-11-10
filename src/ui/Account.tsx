import { useState } from "react";
import { requestSignInCode, saveProfile, verifySignIn, type MeDto, type UserDto, type UserRole } from "../data/apiClient";
import { useT } from "./context";
import { PhoneField, phoneLooksValid, splitPhone } from "./PhoneField";

/** Sign in or sign up: email → 6-digit code. */
export function SignIn({ onSignedIn }: { onSignedIn: (me: MeDto, isNew: boolean) => void }) {
  const { t, lang } = useT();
  const A = t.account;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(true);

  const send = async () => {
    setBusy(true); setError(null);
    try { const r = await requestSignInCode(email, lang); setEmailed(r.emailed); setStep("code"); }
    catch (e) { setError(A.errors[(e as Error).message] ?? (e as Error).message); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try { const r = await verifySignIn(email, code, lang); onSignedIn(r, r.isNew); }
    catch (e) { setError(A.errors[(e as Error).message] ?? (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="account">
      <section className="card">
        <h2>{A.title}</h2>
        <p className="muted">{A.intro}</p>
        {step === "email" ? (
          <form onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label className="field">
              <span>{A.email}</span>
              <input type="email" inputMode="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <button className="primary" disabled={busy || !email.includes("@")}>{A.sendCode}</button>
          </form>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); verify(); }}>
            <p className="small">{emailed ? A.codeSent(email) : A.codeLogged}</p>
            <label className="field">
              <span>{A.code}</span>
              <input inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="code-input" />
            </label>
            <div className="row-actions">
              <button className="primary" disabled={busy || code.trim().length < 6}>{A.enter}</button>
              <button type="button" className="ghost" onClick={() => { setStep("email"); setCode(""); }}>{A.otherEmail}</button>
            </div>
          </form>
        )}
        {error && <p className="warnings small">{error}</p>}
      </section>
    </main>
  );
}

const ROLES: UserRole[] = ["seller", "buyer", "agent", "appraiser", "attorney", "mortgage_broker", "other"];

/** Profile: shown on first sign-in, and from the user menu. */
export function Profile({ me, onSaved, onCancel }: { me: MeDto; onSaved: (me: MeDto) => void; onCancel?: () => void }) {
  const { t } = useT();
  const A = t.account;
  const [p, setP] = useState<Partial<UserDto>>({ ...me.user });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (x: Partial<UserDto>) => setP({ ...p, ...x });
  const save = async () => {
    setBusy(true); setError(null);
    try { onSaved(await saveProfile({ name: p.name, phone: p.phone, role: p.role, agency: p.agency, license: p.license, marketingConsent: !!p.marketingConsent })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <main className="account">
      <section className="card">
        <h2>{A.profileTitle}</h2>
        <p className="muted small">{me.user.email}</p>
        <label className="field"><span>{A.name}</span><input value={p.name ?? ""} onChange={(e) => set({ name: e.target.value })} autoComplete="name" /></label>
        <PhoneField label={A.phone} value={me.user.phone} onChange={(v) => setP((x) => ({ ...x, phone: v }))} />
        <div className="field">
          <span>{A.iAm}</span>
          <div className="role-pick">
            {ROLES.map((r) => (
              <button key={r} type="button" className={p.role === r ? "active" : ""} aria-pressed={p.role === r} onClick={() => set({ role: r })}>{A.roles[r]}</button>
            ))}
          </div>
        </div>
        {p.role === "agent" && <label className="field"><span>{A.agency}</span><input value={p.agency ?? ""} onChange={(e) => set({ agency: e.target.value })} /></label>}
        {p.role === "appraiser" && <label className="field"><span>{A.license}</span><input value={p.license ?? ""} onChange={(e) => set({ license: e.target.value })} inputMode="numeric" dir="ltr" /></label>}
        <label className="inline consent">
          <input type="checkbox" checked={!!p.marketingConsent} onChange={(e) => set({ marketingConsent: e.target.checked })} />
          <span className="small">{A.consent}</span>
        </label>
        <p className="small muted">{A.privacy}</p>
        <div className="row-actions">
          <button className="primary" onClick={save} disabled={busy || !p.role || !(p.name ?? "").trim() || !phoneLooksValid(splitPhone(p.phone).code, splitPhone(p.phone).number)}>{A.save}</button>
          {onCancel && <button className="ghost" onClick={onCancel}>{A.cancel}</button>}
        </div>
        {error && <p className="warnings small">{error}</p>}
      </section>
    </main>
  );
}
