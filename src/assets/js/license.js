// Licence pro : jeton signé (ECDSA P-256) vérifié dans le navigateur, sans appel réseau.
// Les abonnements sont renouvelés automatiquement auprès de /api/refresh quand l'échéance approche.
const PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"RosoKA7qJ_77T_m9XLcGUsxFOkg3nFiG_3huMZZxMjg","y":"0xl9Z8n-hAeJLmCycbhoPaCaj1FOvItsjm3899ZtjBo"};
const KEY = "pdfanonym.license";

const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let pubKey = null;
async function key() {
  pubKey ||= await crypto.subtle.importKey("jwk", PUBLIC_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return pubKey;
}

export async function decode(token) {
  try {
    const [body, sig] = String(token || "").trim().split(".");
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await key(), unb64u(sig), new TextEncoder().encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(unb64u(body))) : null;
  } catch { return null; }
}

export function stored() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function store(token) {
  try { token ? localStorage.setItem(KEY, token) : localStorage.removeItem(KEY); } catch { /* stockage indisponible */ }
}

// État de la licence : { active, plan, exp, seats, token } ; tente un renouvellement si l'abonnement arrive à échéance.
export async function status({ refresh = true } = {}) {
  const token = stored();
  const p = await decode(token);
  if (!p) return { active: false };
  const now = Date.now() / 1000;
  if (refresh && p.sid && p.exp - now < 5 * 86400 && navigator.onLine) {
    try {
      const r = await fetch("/api/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const d = await r.json();
      if (d.token && (await decode(d.token))) { store(d.token); return status({ refresh: false }); }
    } catch { /* hors ligne : on garde la licence en cours */ }
  }
  return { active: p.exp > now, plan: p.plan, exp: p.exp, seats: p.seats || 1, sub: !!p.sid, token };
}

export async function isPro() {
  return (await status()).active;
}

// Badge « Pro » dans l'en-tête quand une licence est active.
status().then((s) => {
  if (!s.active) return;
  document.documentElement.dataset.pro = "1";
});
