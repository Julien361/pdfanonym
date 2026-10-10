// Pages Tarifs et Mon compte : paiement (Stripe Checkout), récupération et gestion de la licence.
import { t } from "./common.js";
import { decode, stored, store, status as licStatus } from "./license.js";

const $ = (s, r = document) => r.querySelector(s);
const pricing = $(".pricing"), account = $(".account");
const lang = (pricing || account)?.dataset.lang || "en";
const fmtDate = (s) => new Date(s * 1000).toLocaleString(document.documentElement.lang || lang, { dateStyle: "long", timeStyle: "short" });

/* ---------- Tarifs ---------- */

if (pricing) {
  let period = "month";
  const say = (m, k = "") => { const e = $("[data-el=status]", pricing); e.textContent = m; e.className = "status " + k; };
  pricing.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    period = b.dataset.period;
    pricing.querySelectorAll("[data-period]").forEach((x) => x.classList.toggle("active", x === b));
    pricing.querySelectorAll("[data-show]").forEach((x) => (x.hidden = x.dataset.show !== period));
  }));
  pricing.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", async () => {
    if (!$("[data-el=consent]", pricing).checked) { say(t("pro.needConsent"), "err"); $(".consent").classList.add("flash"); return; }
    const plan = b.dataset.buy === "pass" ? "pass" : b.dataset.buy === "team" ? "team_month" : period === "year" ? "pro_year" : "pro_month";
    b.disabled = true;
    say(t("pro.redirecting"));
    try {
      const r = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan, lang, seats: +$("[data-el=seats]", pricing).value || 2, consent: true, business: true }) });
      const d = await r.json();
      if (!d.url) throw new Error(d.error || "checkout");
      location.href = d.url;
    } catch (e) {
      say(t("pro.checkoutError"), "err");
      b.disabled = false;
    }
  }));
}

/* ---------- Mon compte ---------- */

if (account) {
  const say = (m, k = "") => { const e = $("[data-el=status]", account); e.textContent = m; e.className = "status " + k; };
  const keyBox = $("[data-el=key]", account);

  async function show() {
    const s = await licStatus();
    keyBox.value = stored();
    const title = $("[data-el=title]", account), detail = $("[data-el=detail]", account);
    $("[data-el=actions]", account).hidden = !s.active;
    $("[data-el=portal]", account).hidden = !(s.active && s.sub);
    if (!s.token) { title.textContent = t("acc.none"); detail.innerHTML = ""; detail.append(t("acc.noneHint") + " "); const a = document.createElement("a"); a.href = account.dataset.pricing; a.textContent = t("acc.seePlans"); detail.append(a); return; }
    const p = await decode(s.token);
    title.textContent = s.active ? t("acc.active", { plan: t("plan." + p.plan) }) : t("acc.expired", { plan: t("plan." + p.plan) });
    detail.textContent = (s.active ? t(p.sid ? "acc.renews" : "acc.until", { date: fmtDate(p.exp) }) : t("acc.expiredHint")) + (p.plan === "team" ? " " + t("acc.seats", { n: p.seats }) : "");
  }

  // Retour de Stripe : ?session_id=… → récupération de la licence.
  const sid = new URLSearchParams(location.search).get("session_id");
  if (sid) {
    say(t("acc.fetching"));
    try {
      let d;
      for (let i = 0; i < 5; i++) { // le paiement peut mettre quelques secondes à être confirmé
        const r = await fetch("/api/license?session_id=" + encodeURIComponent(sid));
        d = await r.json();
        if (d.token || r.status !== 402) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (!d.token || !(await decode(d.token))) throw new Error(d.error || "license");
      store(d.token);
      history.replaceState(null, "", location.pathname);
      say(t("acc.thanks", { email: d.email || "" }), "ok");
    } catch { say(t("acc.fetchError"), "err"); }
  }
  await show();

  $("[data-el=portal]", account).addEventListener("click", async () => {
    say(t("pro.redirecting"));
    try {
      const r = await fetch("/api/portal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: stored(), lang }) });
      const d = await r.json();
      if (!d.url) throw new Error();
      location.href = d.url;
    } catch { say(t("pro.checkoutError"), "err"); }
  });
  $("[data-el=copy]", account).addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(keyBox.value); say(t("acc.copied"), "ok"); } catch { keyBox.select(); }
  });
  $("[data-el=activate]", account).addEventListener("click", async () => {
    const tok = keyBox.value.trim();
    if (!(await decode(tok))) { say(t("acc.badKey"), "err"); return; }
    store(tok);
    say(t("acc.activated"), "ok");
    show();
  });
  $("[data-el=remove]", account).addEventListener("click", () => {
    if (!confirm(t("acc.confirmRemove"))) return;
    store("");
    say(t("acc.removed"));
    show();
  });
}
