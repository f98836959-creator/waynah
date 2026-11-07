import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, cors, json, sendSms, SITE } from "./_shared.ts";

// Arabic category labels used by the shop registration form → category ids used by requests
const CAT_BY_LABEL: Record<string, string> = { "إطارات": "tyre", "بطاريات": "battery", "زيوت": "oil", "فلاتر": "filter", "فحمات": "pads", "قطع محرك": "engine", "قطع بودي": "body", "كهرباء": "engine", "مكيف": "ac", "إنارة": "light" };
const CATS: [string, RegExp][] = [
  ["tyre", /إطار|كفر|تاير|اطار/], ["battery", /بطاري/], ["oil", /زيت/], ["pads", /فحم|بريك|فرامل/], ["filter", /فلتر/],
  ["light", /شمع|ليت|ضوء|كشاف|سطب|إنار|انار/], ["ac", /كمبروسر|مكيف|كندس|ثلاج/], ["engine", /محرك|مكينة|ماكينة|دينمو|سلف|طرمبة|بواجي|بوجي|قير|جير/], ["body", /بودي|صدام|مراي|باب|كبوت|شنطة|رفرف/],
];
const catOf = (part: string) => (CATS.find(([, re]) => re.test(part || "")) || [null])[0];
const shopCats = (s: any) => ((s.cats || []) as string[]).map((c) => CAT_BY_LABEL[c] || c);
const carOf = (r: any) => [r.car?.brandAr, r.car?.model, r.car?.year].filter(Boolean).join(" ");
const stocks = (shop: any, cat: string | null) => !cat || !shopCats(shop).length || shopCats(shop).includes(cat);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  const { data: k } = await db.from("app_secrets").select("value").eq("key", "notify_key").single();
  if (!k || req.headers.get("x-waynah-key") !== k.value) return json({ error: "forbidden" }, 403);
  let ev: any = {};
  try { ev = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  let sent = 0;

  if (ev.type === "new_request") {
    const { data: r } = await db.from("requests").select("*").eq("id", ev.id).single();
    if (!r) return json({ ok: true, sent });
    const cat = catOf(r.part);
    const { data: shops } = await db.from("shops").select("*").not("phone", "is", null);
    for (const s of shops || []) {
      if (!stocks(s, cat)) continue;
      const res = await sendSms(s.phone, `وينه: طلب جديد في المعبيلة\n${r.part} · ${carOf(r)}\nرد بعرضك قبل غيرك: ${SITE}/#shop`, "new_request", `${r.id}:${s.id}`);
      if (res.ok) sent++;
    }
  }

  if (ev.type === "offer") {
    const { data: r } = await db.from("requests").select("*").eq("id", ev.request_id).single();
    const { data: o } = await db.from("offers").select("*").eq("request_id", ev.request_id).eq("shop_id", ev.shop_id).single();
    if (r?.phone && o && !o.demo) {
      const res = await sendSms(r.phone, `وينه: وصلك عرض ${o.price} ر.ع من ${o.shop_name} على ${r.part}.\nشوف العروض: ${SITE}/#driver`, "offer", `${r.id}:${ev.shop_id}`);
      if (res.ok) sent++;
    }
  }

  if (ev.type === "status") {
    const { data: r } = await db.from("requests").select("*").eq("id", ev.id).single();
    if (r?.chosen) {
      const { data: s } = await db.from("shops").select("*").eq("id", r.chosen).single();
      if (s?.phone) {
        const text = ev.status === "booked"
          ? `وينه: زبون حجز ${r.part} بسعر ${r.final_price} ر.ع. رقم الحجز W-${r.code}.\nجهّز القطعة: ${SITE}/#shop`
          : `وينه: الزبون وصل محلك لاستلام ${r.part} (W-${r.code}). اطلب منه رمز الاستلام وأكّد التسليم: ${SITE}/#shop`;
        const res = await sendSms(s.phone, text, "status:" + ev.status, r.id);
        if (res.ok) sent++;
      }
    }
  }

  if (ev.type === "reminders") {
    // open requests 10–120 minutes old: nudge matching shops that still haven't answered (once per request)
    const now = Date.now();
    const { data: reqs } = await db.from("requests").select("*").eq("status", "open").gte("created_at", now - 120 * 60 * 1000).lte("created_at", now - 10 * 60 * 1000);
    const { data: shops } = await db.from("shops").select("*").not("phone", "is", null);
    for (const r of reqs || []) {
      const cat = catOf(r.part);
      const reminded = { ...(r.reminded || {}) };
      let changed = false;
      for (const s of shops || []) {
        if (!stocks(s, cat) || reminded[s.id] || (r.offers_cache || {})[s.id] || (r.declined || {})[s.id]) continue;
        const { count } = await db.from("offers").select("shop_id", { count: "exact", head: true }).eq("request_id", r.id).eq("shop_id", s.id);
        if (count) continue;
        const mins = Math.round((now - Number(r.created_at)) / 60000);
        const res = await sendSms(s.phone, `وينه: زبون ينتظر ردك من ${mins} دقيقة على ${r.part} · ${carOf(r)}.\nرد الحين قبل ما يحجز عند غيرك: ${SITE}/#shop`, "reminder", `${r.id}:${s.id}`);
        if (res.ok) { sent++; reminded[s.id] = Date.now(); changed = true; }
      }
      if (changed) await db.from("requests").update({ reminded }).eq("id", r.id);
    }
  }
  return json({ ok: true, sent });
});
