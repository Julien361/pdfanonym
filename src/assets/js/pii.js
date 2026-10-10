// Détection de données personnelles dans un texte. Chaque motif est vérifié (somme de contrôle quand elle existe)
// pour limiter les faux positifs. Renvoie [{ type, value }] ; la recherche des positions se fait ensuite dans le PDF.

const ibanOk = (raw) => {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let m = 0;
  for (const ch of r) {
    const v = ch >= "A" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of v) m = (m * 10 + +d) % 97;
  }
  return m === 1;
};

const luhnOk = (raw) => {
  const s = raw.replace(/\D/g, "");
  if (s.length < 13 || s.length > 19 || /^(\d)\1+$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = +s[s.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

// Numéro de sécurité sociale français (NIR) : 13 chiffres + clé = 97 - (n mod 97). Corse : 2A → 19, 2B → 18.
const nirOk = (raw) => {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  const m = /^([12][0-9]{2}(?:0[1-9]|1[0-2]|[2-9][0-9])(?:2A|2B|[0-9]{2})[0-9]{6})([0-9]{2})$/.exec(s);
  if (!m) return false;
  const num = BigInt(m[1].replace("2A", "19").replace("2B", "18"));
  return 97n - (num % 97n) === BigInt(m[2]);
};

const ipOk = (s) => s.split(".").every((p) => +p <= 255) && !/^(\d+\.)\1{3}/.test(s + ".");

import { FIRST_NAMES } from "./firstnames.js";

export const PII_TYPES = ["email", "phone", "iban", "card", "nir", "ip", "date", "name"];
// Catégories de la détection étendue (version pro).
export const PRO_TYPES = ["fullname", "address", "birth", "plate", "vat"];

const strip = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const UP = "A-ZÀ-ÖØ-Þ", LOW = "a-zà-öø-ÿ";

// Détection étendue : noms sans civilité, adresses postales, dates de naissance, plaques, numéros de TVA.
export function detectPIIPro(text) {
  const found = [];
  const add = (type, value) => { value = value.trim().replace(/[,.;:]+$/, ""); if (value.length > 2) found.push({ type, value }); };
  let m;

  // « Jean DUPONT », « Jean Dupont », « DUPONT Jean », « Jean-Pierre MARTIN » : prénom connu + nom.
  const cap = `[${UP}][${LOW}'’-]+`, caps = `[${UP}][${UP}'’-]{1,}`;
  const fn = new RegExp(`\\b(${cap}(?:-${cap})?)\\s+((?:${caps}|${cap})(?:[ -](?:${caps}|${cap}))?)`, "gu");
  while ((m = fn.exec(text))) {
    const first = strip(m[1].split("-")[0]);
    if (FIRST_NAMES.has(first) && !FIRST_NAMES.has(strip(m[2].split(/[ -]/)[0]))) add("fullname", m[0]);
    else fn.lastIndex = m.index + m[1].length; // « Herr Thomas Müller » : on retente à partir du mot suivant
  }
  const fnRev = new RegExp(`\\b(${caps})\\s+(${cap}(?:-${cap})?)\\b`, "gu");
  while ((m = fnRev.exec(text))) {
    if (FIRST_NAMES.has(strip(m[2].split("-")[0])) && m[1].length > 2) add("fullname", m[0]);
    else fnRev.lastIndex = m.index + m[1].length;
  }

  // Adresses : numéro + type de voie (FR, EN, ES, IT, PT) ; voie + numéro (DE, ES, IT, PT) ; codes postaux suivis d'une ville.
  const word = `[${UP}${LOW}0-9'’.-]+`;
  const alpha = `[${UP}${LOW}'’.-]+`;
  const fr = new RegExp(`\\b\\d{1,4}\\s?(?:bis|ter|[a-dA-D])?,?\\s+(?:rue|avenue|av\\.|boulevard|bd|chemin|place|allée|allee|impasse|route|quai|cours|square|passage|résidence|lotissement|lieu-dit)\\s+(?:${word}\\s?){1,6}`, "giu");
  const en = new RegExp(`\\b\\d{1,5}\\s+(?:[${UP}]${word}\\s){1,4}(?:Street|St\\.?|Avenue|Ave\\.?|Road|Rd\\.?|Lane|Ln\\.?|Drive|Dr\\.?|Boulevard|Blvd\\.?|Court|Ct\\.?|Way|Place|Pl\\.?)\\b`, "gu");
  const de = new RegExp(`\\b[${UP}]${word}(?:straße|strasse|str\\.|weg|gasse|platz|allee|ring|damm)\\s+\\d{1,4}\\s?[a-zA-Z]?\\b`, "gu");
  const lat = new RegExp(`\\b(?:Calle|C\\/|Avenida|Avda\\.|Plaza|Paseo|Via|Viale|Piazza|Corso|Largo|Rua|Travessa|Praça|Alameda)\\s+(?:${alpha}\\s?){1,5},?\\s*(?:n[º°o.]?\\s*)?\\d{1,4}`, "gu");
  const zip = new RegExp(`\\b(?:(?:\\d{5}|\\d{5}-\\d{3})\\s+[${UP}][${LOW}${UP}'’-]+|\\d{4}\\s+[${UP}][${LOW}][${LOW}'’-]*)(?:[ -][${UP}][${LOW}${UP}'’-]+){0,3}(?:\\s+(?:CEDEX|Cedex)(?:\\s\\d{1,2})?)?`, "gu");
  for (const re of [fr, en, de, lat, zip]) while ((m = re.exec(text))) add("address", m[0]);

  // Dates de naissance : une date précédée d'un mot du contexte de naissance.
  const birth = /(?:n[ée]e?\s+le|date\s+de\s+naissance\s*:?|born\s+(?:on\s+)?|date\s+of\s+birth\s*:?|DOB\s*:?|geboren\s+(?:am\s+)?|Geburtsdatum\s*:?|nacid[oa]\s+el|fecha\s+de\s+nacimiento\s*:?|nat[oa]\s+il|data\s+di\s+nascita\s*:?|nascid[oa]\s+em|data\s+de\s+nascimento\s*:?)\s*((?:0?[1-9]|[12]\d|3[01])[/.\-](?:0?[1-9]|1[0-2])[/.\-](?:19|20)\d{2}|(?:0?[1-9]|[12]\d|3[01])\.?\s+[A-Za-zéûèäö]+\s+(?:19|20)\d{2})/giu;
  while ((m = birth.exec(text))) add("birth", m[1]);

  // Plaques : France (AA-123-AA), Espagne (1234 ABC), Italie (AA 123 AA), Allemagne (B-AB 1234), Portugal (AA-00-AA).
  const plate = /\b(?:[A-HJ-NP-TV-Z]{2}[- ]\d{3}[- ][A-HJ-NP-TV-Z]{2}|\d{4}\s?[B-DF-HJ-NP-TV-Z]{3}|[A-Z]{1,3}-[A-Z]{1,2}\s?\d{1,4}|[A-Z]{2}-\d{2}-[A-Z]{2})\b/g;
  while ((m = plate.exec(text))) add("plate", m[0]);

  // Numéros de TVA intracommunautaire (FR12345678901, DE123456789, ESX1234567X, IT…, PT…, BE…).
  const vat = /\b(?:FR[0-9A-Z]{2}\s?\d{3}\s?\d{3}\s?\d{3}|DE\s?\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|IT\d{11}|PT\d{9}|BE0?\d{9,10}|NL\d{9}B\d{2}|ATU\d{8})\b/g;
  while ((m = vat.exec(text))) add("vat", m[0]);

  const seen = new Set();
  return found.filter((f) => { const k = f.type + "|" + f.value; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function detectPII(text) {
  const found = [];
  const add = (type, value) => { value = value.trim(); if (value) found.push({ type, value }); };
  let m;

  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = email.exec(text))) add("email", m[0]);

  const iban = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
  while ((m = iban.exec(text))) if (ibanOk(m[0])) add("iban", m[0]);

  const card = /\b(?:\d[ -]?){12,18}\d\b/g;
  // 14 chiffres = SIRET (même clé de Luhn qu'une carte) : exclu.
  while ((m = card.exec(text))) if (luhnOk(m[0]) && !ibanOk(m[0]) && m[0].replace(/\D/g, "").length !== 14) add("card", m[0]);

  const nir = /\b[12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2]|[2-9]\d)[ ]?(?:2A|2B|\d{2})[ ]?\d{3}[ ]?\d{3}[ ]?\d{2}\b/g;
  while ((m = nir.exec(text))) if (nirOk(m[0])) add("nir", m[0]);

  // Téléphones : formats internationaux (+33, +49…) et nationaux à 10 chiffres groupés (06 12 34 56 78, 06.12.34.56.78).
  const phone = /(?:\+\d{1,3}[\s.-]?(?:\(0\))?\s?\d{1,4}(?:[\s.-]?\d{2,4}){2,4}|\b0\d(?:[\s.-]?\d{2}){4}\b|\(\d{3}\)\s?\d{3}[\s.-]\d{4})/g;
  while ((m = phone.exec(text))) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15 && !found.some((f) => f.value.replace(/\D/g, "") === digits)) add("phone", m[0]);
  }

  const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  while ((m = ip.exec(text))) if (ipOk(m[0])) add("ip", m[0]);

  // Dates (jj/mm/aaaa, jj.mm.aaaa, aaaa-mm-jj) : décochées par défaut dans l'interface (dates de documents fréquentes).
  const date = /\b(?:(?:0?[1-9]|[12]\d|3[01])[/.](?:0?[1-9]|1[0-2])[/.](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;
  while ((m = date.exec(text))) add("date", m[0]);

  // Noms précédés d'une civilité (FR, EN, DE, ES, IT, PT) : « M. Jean DUPONT », « Mrs Smith », « Herr Müller ».
  const title = "(?:M\\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Me|Dr|Mr\\.?|Mrs\\.?|Ms\\.?|Miss|Herr|Frau|Sr\\.|Sra\\.|Señor|Señora|Sig\\.|Sig\\.ra|Signor|Signora|Sr|Sra)";
  const word = "[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]+";
  const name = new RegExp(`\\b${title}\\s+((?:${word})(?:\\s+${word}){0,2})`, "gu");
  while ((m = name.exec(text))) add("name", m[1]);

  // Dédoublonnage (même type + même valeur)
  const seen = new Set();
  return found.filter((f) => { const k = f.type + "|" + f.value; if (seen.has(k)) return false; seen.add(k); return true; });
}
