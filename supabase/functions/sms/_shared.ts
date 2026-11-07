import { createClient } from "jsr:@supabase/supabase-js@2";

export const SITE = "https://waynah-app.vercel.app";
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-waynah-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

export const normPhone = (p: string) => {
  let d = String(p || "").replace(/[^0-9+]/g, "");
  if (!d.startsWith("+")) d = "+" + d;
  return /^\+[1-9][0-9]{6,14}$/.test(d) ? d : null;
};

export function smsConfigured() {
  return !!(Deno.env.get("TWILIO_SID") && Deno.env.get("TWILIO_TOKEN") && Deno.env.get("TWILIO_FROM"));
}

/** Sends one SMS through Twilio. Returns {demo:true} when Twilio isn't configured yet, so the app keeps working in demo mode. */
export async function sendSms(to: string, body: string, kind: string, ref: string | null) {
  const db = admin();
  if (!smsConfigured()) {
    await db.from("sms_log").insert({ to_phone: to, kind, ref, body, demo: true });
    return { ok: true, demo: true };
  }
  const sid = Deno.env.get("TWILIO_SID")!, token = Deno.env.get("TWILIO_TOKEN")!, from = Deno.env.get("TWILIO_FROM")!;
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("twilio error", res.status, data?.message);
    await db.from("sms_log").insert({ to_phone: to, kind: kind + ":failed", ref, body: String(data?.message || res.status).slice(0, 300), demo: false });
    return { ok: false, error: data?.message || "sms_failed" };
  }
  await db.from("sms_log").insert({ to_phone: to, kind, ref, body, provider_sid: data?.sid || null, demo: false });
  return { ok: true, demo: false };
}

export async function sha(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
