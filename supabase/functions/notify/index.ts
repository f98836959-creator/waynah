import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, cors, json, sendPush, sendSms, SITE } from "./_shared.ts";

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
    const { data: shops } = await db.from("shops").select("*");
    for (const s of shops || []) {
      if (!stocks(s, cat)) continue;
      sent += await sendPush("shop", s.id, { title: "طلب جديد: " + r.part, body: carOf(r) + " · رد بعرضك قبل غيرك", url: "/#shop", tag: "req-" + r.id });
      if (s.phone) { const res = await sendSms(s.phone, `وينه: طلب جديد في المعبيلة\n${r.part} · ${carOf(r)}\nرد بعرضك قبل غيرك: ${SITE}/#shop`, "new_request", `${r.id}:${s.id}`); if (res.ok) sent++; }
    }
  }

  if (ev.type === "offer") {
    const { data: r } = await db.from("requests").select("*").eq("id", ev.request_id).single();
    const { data: o } = await db.from("offers").select("*").eq("request_id", ev.request_id).eq("shop_id", ev.shop_id).single();
    if (r?.phone && o) sent += await sendPush("driver", r.phone, { title: "وصلك عرض " + o.price + " ر.ع", body: o.shop_name + " · " + r.part + " · قارن واختر", url: "/#driver", tag: "offer-" + r.id + "-" + ev.shop_id });
    if (r?.phone && o && !o.demo) {
      const res = await sendSms(r.phone, `وينه: وصلك عرض ${o.price} ر.ع من ${o.shop_name} على ${r.part}.\nشوف العروض: ${SITE}/#driver`, "offer", `${r.id}:${ev.shop_id}`);
      if (res.ok) sent++;
    }
  }

  if (ev.type === "status") {
    const { data: r } = await db.from("requests").select("*").eq("id", ev.id).single();
    if (r?.chosen) {
      const { data: s } = await db.from("shops").select("*").eq("id", r.chosen).single();
      if (s) sent += await sendPush("shop", s.id, ev.status === "booked" ? { title: "حجز جديد W-" + r.code, body: r.part + " بسعر " + r.final_price + " ر.ع · جهّز القطعة", url: "/#shop", tag: "bk-" + r.id } : { title: "الزبون وصل محلك", body: r.part + " · اطلب رمز الاستلام وأكّد التسليم", url: "/#shop", tag: "ar-" + r.id });
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
    const { data: shops } = await db.from("shops").select("*");
    for (const r of reqs || []) {
      const cat = catOf(r.part);
      const reminded = { ...(r.reminded || {}) };
      let changed = false;
      for (const s of shops || []) {
        if (!stocks(s, cat) || reminded[s.id] || (r.offers_cache || {})[s.id] || (r.declined || {})[s.id]) continue;
        const { count } = await db.from("offers").select("shop_id", { count: "exact", head: true }).eq("request_id", r.id).eq("shop_id", s.id);
        if (count) continue;
        const mins = Math.round((now - Number(r.created_at)) / 60000);
        const pu = await sendPush("shop", s.id, { title: "زبون ينتظر ردك من " + mins + " دقيقة", body: r.part + " · " + carOf(r) + " · رد قبل ما يحجز عند غيرك", url: "/#shop", tag: "rem-" + r.id });
        const res = s.phone ? await sendSms(s.phone, `وينه: زبون ينتظر ردك من ${mins} دقيقة على ${r.part} · ${carOf(r)}.\nرد الحين قبل ما يحجز عند غيرك: ${SITE}/#shop`, "reminder", `${r.id}:${s.id}`) : { ok: false };
        if (res.ok || pu) { sent++; reminded[s.id] = Date.now(); changed = true; }
      }
      if (changed) await db.from("requests").update({ reminded }).eq("id", r.id);
    }
  }
  if (ev.type === "message") {
    const { data: m } = await db.from("messages").select("*").eq("id", ev.id).single();
    if (m && (m.from_role === "s" || m.from_role === "c") && m.text) {
      const { data: r } = await db.from("requests").select("*").eq("id", m.request_id).single();
      if (r) {
        if (m.from_role === "s") {
          const { data: o } = await db.from("offers").select("shop_name").eq("request_id", r.id).eq("shop_id", m.shop_id).maybeSingle();
          sent += await sendPush("driver", r.phone, { title: (o?.shop_name || "المحل") + " رد عليك", body: String(m.text).slice(0, 120), url: "/#driver", tag: "msg-" + r.id + "-" + m.shop_id });
        } else if (m.shop_id && !String(m.shop_id).startsWith("demo-")) {
          sent += await sendPush("shop", m.shop_id, { title: "رسالة من زبون · " + r.part, body: String(m.text).slice(0, 120), url: "/#shop", tag: "msg-" + r.id });
        }
      }
    }
  }
  return json({ ok: true, sent });
});
