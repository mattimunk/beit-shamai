/**
 * Outgoing email. Google Cloud blocks direct SMTP from servers, so mail goes through an email
 * service's HTTP API: Resend (RESEND_API_KEY) or Brevo (BREVO_API_KEY), from MAIL_FROM.
 * With neither configured, messages are written to the server log (development / before
 * the domain is ready): `sudo docker compose logs app | grep "\[mail\]"`.
 */
export interface Mail { to: string; subject: string; text: string; html?: string }
export type Mailer = (m: Mail) => Promise<{ sent: boolean; via: string }>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Plain text as simple right-to-left HTML (Hebrew-first). */
export const textToHtml = (t: string) =>
  `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${esc(t).replace(/\n/g, "<br>")}</div>`;

export function mailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY);
}

export const sendMail: Mailer = async (m) => {
  const from = process.env.MAIL_FROM ?? "Beit Shamai <no-reply@beitsham.ai>";
  const html = m.html ?? textToHtml(m.text);
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { sent: true, via: "resend" };
  }
  if (process.env.BREVO_API_KEY) {
    const match = from.match(/^(.*)<(.+)>$/);
    const sender = match ? { name: match[1]!.trim(), email: match[2]!.trim() } : { email: from };
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ sender, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: html }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { sent: true, via: "brevo" };
  }
  console.log(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}\n[/mail]`);
  return { sent: false, via: "log" };
};
