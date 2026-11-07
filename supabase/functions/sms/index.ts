import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, cors, json, normPhone, sendSms, sha, smsConfigured } from "./_shared.ts";

const PEPPER = "waynah-otp-v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const phone = normPhone(body.phone);
  if (!phone) return json({ error: "bad_phone" }, 400);
  const db = admin();

  if (body.action === "send") {
    // rate limit: max 3 codes per phone per 10 minutes
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await db.from("otps").select("id", { count: "exact", head: true }).eq("phone", phone).gte("created_at", since);
    if ((count || 0) >= 3) return json({ error: "too_many", ok: false }, 429);
    if (!smsConfigured()) {
      // demo mode: the code is always 0000 and shown inside the page
      await db.from("otps").insert({ phone, code_hash: await sha(PEPPER + phone + "0000"), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
      return json({ ok: true, demo: true });
    }
    const code = String(Math.floor(1000 + Math.random() * 9000));
    await db.from("otps").insert({ phone, code_hash: await sha(PEPPER + phone + code), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    const r = await sendSms(phone, `رمز تأكيد وينه: ${code}\nصالح 10 دقايق. لا تعطيه لأحد.`, "otp", phone);
    if (!r.ok) return json({ ok: false, error: "sms_failed" }, 502);
    return json({ ok: true, demo: false });
  }

  if (body.action === "verify") {
    const code = String(body.code || "").replace(/[^0-9]/g, "");
    if (code.length !== 4) return json({ ok: false, error: "bad_code" }, 400);
    const { data: rows } = await db.from("otps").select("*").eq("phone", phone).eq("used", false).order("created_at", { ascending: false }).limit(1);
    const otp = rows && rows[0];
    if (!otp) return json({ ok: false, error: "no_code" }, 400);
    if (new Date(otp.expires_at).getTime() < Date.now()) return json({ ok: false, error: "expired" }, 400);
    if (otp.attempts >= 5) return json({ ok: false, error: "too_many" }, 429);
    const good = otp.code_hash === await sha(PEPPER + phone + code);
    await db.from("otps").update(good ? { used: true } : { attempts: otp.attempts + 1 }).eq("id", otp.id);
    if (!good) return json({ ok: false, error: "wrong" }, 400);
    return json({ ok: true });
  }
  return json({ error: "bad_action" }, 400);
});
