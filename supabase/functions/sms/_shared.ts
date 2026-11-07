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

/** Web push to every device a driver (by phone) or shop (by id) registered. Free, works with the app closed. */
let vapidReady: Promise<any> | null = null;
async function webpushLib() {
  if (!vapidReady) vapidReady = (async () => {
    const mod: any = await import("npm:web-push@3.6.7");
    const wp = mod.default || mod;
    const { data } = await admin().from("app_secrets").select("key,value").in("key", ["vapid_public", "vapid_private"]);
    const m: Record<string, string> = {}; (data || []).forEach((r: any) => m[r.key] = r.value);
    wp.setVapidDetails("https://waynah-app.vercel.app", m.vapid_public, m.vapid_private);
    return wp;
  })();
  return vapidReady;
}
export async function sendPush(role: "driver" | "shop", ref: string | null, payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!ref) return 0;
  const db = admin();
  const { data: subs } = await db.from("push_devices").select("*").eq("role", role).eq("ref", ref);
  if (!subs || !subs.length) return 0;
  let ok = 0;
  const wp = await webpushLib();
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      ok++;
    } catch (e: any) {
      const code = e?.statusCode;
      console.error("push error", code, String(e?.body || e?.message || "").slice(0, 160));
      if (code === 404 || code === 410) await db.from("push_devices").delete().eq("endpoint", s.endpoint).eq("role", role).eq("ref", ref);
    }
  }
  await db.from("sms_log").insert({ to_phone: role + ":" + ref, kind: "push:" + (payload.tag || "msg"), ref, body: payload.title + " — " + payload.body, demo: false });
  return ok;
}
