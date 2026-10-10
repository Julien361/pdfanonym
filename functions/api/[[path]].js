// Service de licences pdfanonym (Cloudflare Pages Functions). Aucun fichier PDF ne transite ici :
// on ne manipule que des sessions de paiement Stripe et des licences signées.
// Secrets : STRIPE_SECRET_KEY, LICENSE_PRIVATE_JWK.

const STRIPE_VERSION = "2024-06-20";
const PRICES = {
  pass: { lookup: "pdfanonym_pass_24h", mode: "payment" },
  pro_month: { lookup: "pdfanonym_pro_month", mode: "subscription" },
  pro_year: { lookup: "pdfanonym_pro_year", mode: "subscription" },
  team_month: { lookup: "pdfanonym_team_month", mode: "subscription", seats: true },
};
const PORTAL_CONFIG = "bpc_1UOk33KOVV55VSuxA1n9llsx";
const LANGS = ["en", "fr", "de", "es", "it", "pt"];
const ACCOUNT_PATH = { en: "/account/", fr: "/fr/compte/", de: "/de/konto/", es: "/es/cuenta/", it: "/it/account/", pt: "/pt/conta/" };
const PRICING_PATH = { en: "/pricing/", fr: "/fr/tarifs/", de: "/de/preise/", es: "/es/precios/", it: "/it/prezzi/", pt: "/pt/precos/" };
const GRACE = 3 * 86400; // tolérance après la fin de période (paiement en retard, hors ligne)

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, x)));
    else if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, body) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? form(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || "stripe"), { status: 502 });
  return data;
}

/* ---------- Licences signées (ECDSA P-256) ---------- */

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function keys(env) {
  const jwk = JSON.parse(env.LICENSE_PRIVATE_JWK);
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return { priv, pub };
}

async function sign(env, payload) {
  const { priv } = await keys(env);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(body));
  return body + "." + b64u(sig);
}

async function verify(env, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const { pub } = await keys(env);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig), new TextEncoder().encode(body));
  return ok ? JSON.parse(new TextDecoder().decode(unb64u(body))) : null;
}

function periodEnd(sub) {
  return sub.current_period_end || sub.items?.data?.[0]?.current_period_end || 0;
}

async function licenseFromSubscription(env, sub, base = {}) {
  const item = sub.items?.data?.[0];
  const plan = item?.price?.lookup_key?.startsWith("pdfanonym_team") ? "team" : "pro";
  const active = ["active", "trialing", "past_due"].includes(sub.status);
  if (!active) return { status: sub.status };
  const payload = { v: 1, plan, seats: item?.quantity || 1, exp: periodEnd(sub) + GRACE, cid: sub.customer, sid: sub.id, iat: Math.floor(Date.now() / 1000), ...base };
  return { token: await sign(env, payload), plan, exp: payload.exp, seats: payload.seats, renews: !sub.cancel_at_period_end };
}

/* ---------- Routes ---------- */

async function checkout(env, req) {
  const { plan, lang = "en", seats = 1, consent, business } = await req.json();
  const p = PRICES[plan];
  if (!p) return json({ error: "plan" }, 400);
  if (!consent || !business) return json({ error: "consent" }, 400); // ventes réservées aux professionnels
  const l = LANGS.includes(lang) ? lang : "en";
  const prices = await stripe(env, "GET", `/prices?lookup_keys[]=${p.lookup}&active=true`);
  const price = prices.data?.[0];
  if (!price) return json({ error: "price" }, 500);
  const origin = new URL(req.url).origin;
  const meta = { product: "pdfanonym", plan, lang: l, consent: new Date().toISOString(), customer_type: "business" };
  const qty = p.seats ? Math.max(2, Math.min(100, Math.floor(+seats) || 2)) : 1;
  const body = {
    mode: p.mode,
    line_items: [{ price: price.id, quantity: qty, ...(p.seats ? { adjustable_quantity: { enabled: true, minimum: 2, maximum: 100 } } : {}) }],
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    name_collection: { business: { enabled: true, optional: false } },
    billing_address_collection: "required",
    allow_promotion_codes: true,
    locale: l === "pt" ? "pt-BR" : l,
    success_url: `${origin}${ACCOUNT_PATH[l]}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${PRICING_PATH[l]}`,
    metadata: meta,
  };
  if (p.mode === "payment") Object.assign(body, { customer_creation: "always", invoice_creation: { enabled: true, invoice_data: { metadata: meta } }, payment_intent_data: { metadata: meta } });
  else Object.assign(body, { subscription_data: { metadata: meta }, payment_method_collection: "if_required" });
  const s = await stripe(env, "POST", "/checkout/sessions", body);
  return json({ url: s.url });
}

async function license(env, url) {
  const id = url.searchParams.get("session_id") || "";
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return json({ error: "session" }, 400);
  const s = await stripe(env, "GET", `/checkout/sessions/${id}?expand[]=subscription`);
  if (s.metadata?.product !== "pdfanonym") return json({ error: "session" }, 404);
  if (s.status !== "complete" || !["paid", "no_payment_required"].includes(s.payment_status)) return json({ error: "unpaid" }, 402);
  const email = s.customer_details?.email || "";
  if (s.mode === "subscription") return json({ ...(await licenseFromSubscription(env, s.subscription)), email });
  const payload = { v: 1, plan: "pass", seats: 1, exp: s.created + 86400, cid: s.customer, sid: null, sess: s.id, iat: Math.floor(Date.now() / 1000) };
  return json({ token: await sign(env, payload), plan: "pass", exp: payload.exp, email });
}

async function refresh(env, req) {
  const { token } = await req.json();
  const p = await verify(env, token);
  if (!p) return json({ error: "token" }, 400);
  if (!p.sid) return json({ status: p.exp > Date.now() / 1000 ? "active" : "expired", token, plan: p.plan, exp: p.exp });
  const sub = await stripe(env, "GET", `/subscriptions/${p.sid}`);
  return json(await licenseFromSubscription(env, sub));
}

async function portal(env, req) {
  const { token, lang = "en" } = await req.json();
  const p = await verify(env, token);
  if (!p?.cid) return json({ error: "token" }, 400);
  const l = LANGS.includes(lang) ? lang : "en";
  const s = await stripe(env, "POST", "/billing_portal/sessions", { customer: p.cid, configuration: PORTAL_CONFIG, return_url: new URL(req.url).origin + ACCOUNT_PATH[l], locale: l === "pt" ? "pt-BR" : l });
  return json({ url: s.url });
}

export async function onRequest({ request, env, params }) {
  const route = (params.path || []).join("/");
  const url = new URL(request.url);
  try {
    if (route === "checkout" && request.method === "POST") return await checkout(env, request);
    if (route === "license" && request.method === "GET") return await license(env, url);
    if (route === "refresh" && request.method === "POST") return await refresh(env, request);
    if (route === "portal" && request.method === "POST") return await portal(env, request);
    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: e.message || "error" }, e.status || 500);
  }
}
