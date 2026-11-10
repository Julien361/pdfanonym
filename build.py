#!/usr/bin/env python3
"""Génère le site statique pdfanonym dans dist/ à partir de templates/ et content/<lang>.yaml."""
import datetime, hashlib, json, os, shutil, subprocess, zipfile
from pathlib import Path

import markdown, yaml
from jinja2 import Environment, FileSystemLoader

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
SITE = os.environ.get("SITE", "https://pdfanonym.com")
LANGS = ["en", "fr", "de", "es", "it", "pt"]
# Registre des outils : clé de page → (valeur data-tool, gabarit d'interface). Les familles servent au menu et à l'accueil.
TOOLS = {
    "redact": ("redact", "redact"), "anonymize": ("redact", "redact"), "remove": ("redact", "redact"), "batch": ("batch", "batch"),
    "metadata": ("metadata", "report"), "flatten": ("flatten", "report"), "grayscale": ("grayscale", "report"),
    "merge": ("pages", "pages"), "delete_pages": ("pages", "pages"), "extract_pages": ("pages", "pages"),
    "rotate": ("pages", "pages"), "reorder": ("pages", "pages"),
    "edit_text": ("textedit", "textedit"), "add_text": ("annotate", "annotate"), "sign": ("annotate", "annotate"),
    "watermark": ("watermark", "process"), "page_numbers": ("page_numbers", "process"),
    "compress": ("compress", "process"), "pdf_to_jpg": ("pdf_to_jpg", "process"), "jpg_to_pdf": ("jpg_to_pdf", "images"),
    "word_to_pdf": ("word_to_pdf", "word"), "pdf_to_word": ("pdf_to_word", "pdf2word"),
    "protect": ("protect", "process"), "unlock": ("unlock", "process"),
}
GROUPS = [
    ("privacy", ["redact", "anonymize", "batch", "remove", "metadata", "flatten"]),
    ("pages", ["merge", "delete_pages", "extract_pages", "rotate", "reorder"]),
    ("edit", ["edit_text", "add_text", "sign", "watermark", "page_numbers"]),
    ("convert", ["word_to_pdf", "pdf_to_word", "compress", "grayscale", "pdf_to_jpg", "jpg_to_pdf"]),
    ("security", ["protect", "unlock"]),
]
# Parcours logiques : depuis chaque outil, les 3 outils qu'on utilise souvent ensuite (maillage contextuel).
NEXT = {
    "redact": ["metadata", "flatten", "protect"], "anonymize": ["batch", "metadata", "protect"], "batch": ["anonymize", "metadata", "compress"],
    "remove": ["edit_text", "add_text", "redact"], "metadata": ["redact", "flatten", "protect"], "flatten": ["redact", "protect", "compress"],
    "merge": ["page_numbers", "compress", "delete_pages"], "delete_pages": ["merge", "reorder", "compress"], "extract_pages": ["merge", "redact", "pdf_to_jpg"],
    "rotate": ["reorder", "merge", "compress"], "reorder": ["merge", "page_numbers", "delete_pages"],
    "edit_text": ["add_text", "flatten", "protect"], "add_text": ["edit_text", "sign", "flatten"], "sign": ["add_text", "flatten", "protect"], "watermark": ["flatten", "protect", "page_numbers"],
    "page_numbers": ["merge", "watermark", "compress"], "compress": ["grayscale", "pdf_to_jpg", "metadata"], "grayscale": ["compress", "pdf_to_jpg", "page_numbers"],
    "pdf_to_jpg": ["jpg_to_pdf", "extract_pages", "compress"], "jpg_to_pdf": ["compress", "merge", "pdf_to_jpg"],
    "word_to_pdf": ["merge", "protect", "sign"], "pdf_to_word": ["word_to_pdf", "redact", "edit_text"],
    "protect": ["unlock", "flatten", "metadata"], "unlock": ["protect", "compress", "merge"],
}
SCRIPT_OF = {"batch": "batch", "redact": "redact", "pages": "pages", "report": "clean", "process": "process", "images": "images", "annotate": "annotate", "textedit": "textedit", "word": "word", "pdf2word": "pdf2word"}
TOOL_KEYS = ["redact", "anonymize", "edit_text"]  # accès direct dans l'en-tête
PAGE_KEYS = GROUPS[1][1]
ALL_TOOLS = list(TOOLS)
LEARN_KEYS = ["guide", "anon_guide", "privacy", "terms", "source", "legal"]  # anon_guide : DE seulement pour l'instant
PRO_PAGES = ["pricing", "account"]  # pages avec script dédié (pro.js)
TOOL_OF = {k: v[0] for k, v in TOOLS.items()}
UI_OF = {k: v[1] for k, v in TOOLS.items()}
ICONS = {
    "redact": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><rect x="9" y="10" width="16" height="5" rx="1" fill="currentColor"/><rect x="9" y="19" width="10" height="3" rx="1" fill="currentColor" opacity=".35"/>',
    "remove": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M10 13h14M10 19h8" stroke="currentColor" stroke-width="2" opacity=".35"/><path d="M19 21l7 7M26 21l-7 7" stroke="#d92d20" stroke-width="2.4"/>',
    "metadata": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="14" r="4" stroke="currentColor" stroke-width="2"/><path d="M10 26c1.5-4 12.5-4 14 0" stroke="currentColor" stroke-width="2"/><path d="M6 30L28 4" stroke="#d92d20" stroke-width="2.4"/>',
    "delete_pages": '<rect x="4" y="6" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><rect x="18" y="6" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2" opacity=".35"/><path d="M19 25l9 6M28 25l-9 6" stroke="#d92d20" stroke-width="2.4"/>',
    "extract_pages": '<rect x="4" y="4" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2" opacity=".35"/><rect x="18" y="12" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 24v5h8M15 26l3 3-3 3" stroke="currentColor" stroke-width="2"/>',
    "rotate": '<rect x="9" y="8" width="16" height="20" rx="2" stroke="currentColor" stroke-width="2"/><path d="M6 10a12 12 0 0 1 18-6" stroke="currentColor" stroke-width="2"/><path d="M24 1v4h-4" stroke="currentColor" stroke-width="2"/>',
    "reorder": '<rect x="3" y="9" width="10" height="14" rx="2" stroke="currentColor" stroke-width="2"/><rect x="21" y="9" width="10" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 5c4-3 14-3 18 0M26 29c-4 3-14 3-18 0" stroke="currentColor" stroke-width="2"/>',
    "anonymize": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="14" cy="13" r="4" stroke="currentColor" stroke-width="2"/><path d="M17 16l5 5" stroke="currentColor" stroke-width="2.4"/><rect x="9" y="23" width="16" height="4" rx="1" fill="currentColor"/>',
    "merge": '<rect x="3" y="4" width="11" height="15" rx="2" stroke="currentColor" stroke-width="2"/><rect x="20" y="4" width="11" height="15" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8.5 21v4h17v-4M17 25v6M13 28l4 3 4-3" stroke="currentColor" stroke-width="2"/>',
    "edit_text": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M10 12h14" stroke="currentColor" stroke-width="2" opacity=".35"/><rect x="9" y="17" width="11" height="6" rx="1" fill="currentColor" opacity=".25"/><path d="M22 15v10M20 15h4M20 25h4" stroke="currentColor" stroke-width="1.8"/>',
    "add_text": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M11 11h12M17 11v13" stroke="currentColor" stroke-width="2.4"/>',
    "sign": '<path d="M4 25c4-1 6-9 9-9s1 8 4 8 3-5 5-5 2 3 4 3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 30h26" stroke="currentColor" stroke-width="2" opacity=".4"/><path d="M22 4l6 6-11 11h-6v-6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    "watermark": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 25L25 9" stroke="currentColor" stroke-width="4" opacity=".3"/>',
    "page_numbers": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M10 10h14M10 15h14" stroke="currentColor" stroke-width="2" opacity=".35"/><text x="17" y="27" font-size="8" font-family="Arial" font-weight="700" text-anchor="middle" fill="currentColor">12</text>',
    "compress": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M17 7v8M13 11l4 4 4-4M17 27v-8M13 23l4-4 4 4" stroke="currentColor" stroke-width="2"/>',
    "pdf_to_jpg": '<rect x="3" y="5" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><rect x="18" y="12" width="13" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M20 25l3-4 2 2 2-3 3 5" stroke="currentColor" stroke-width="1.6"/><path d="M15 26h-3M9 24l3 2-3 2" stroke="currentColor" stroke-width="1.6"/>',
    "jpg_to_pdf": '<rect x="3" y="5" width="13" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 18l3-4 2 2 2-3 3 5" stroke="currentColor" stroke-width="1.6"/><rect x="19" y="12" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M22 18h6M22 22h6" stroke="currentColor" stroke-width="1.6" opacity=".5"/>',
    "word_to_pdf": '<rect x="3" y="5" width="13" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M6 10l1.5 6 2-4.5 2 4.5L13 10" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="19" y="12" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M22 18h6M22 22h6" stroke="currentColor" stroke-width="1.6" opacity=".5"/>',
    "pdf_to_word": '<rect x="3" y="5" width="12" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M6 11h6M6 15h4" stroke="currentColor" stroke-width="1.6" opacity=".5"/><rect x="18" y="12" width="13" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M20.5 16.5l1.5 6 2-4.5 2 4.5 1.5-6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    "protect": '<rect x="7" y="15" width="20" height="15" rx="3" stroke="currentColor" stroke-width="2"/><path d="M11 15v-4a6 6 0 0 1 12 0v4" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="22" r="2" fill="currentColor"/>',
    "unlock": '<rect x="7" y="15" width="20" height="15" rx="3" stroke="currentColor" stroke-width="2"/><path d="M11 15v-4a6 6 0 0 1 11.5-2.4" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="22" r="2" fill="currentColor"/>',
    "grayscale": '<rect x="5" y="3" width="24" height="28" rx="3" stroke="currentColor" stroke-width="2"/><path d="M17 9a8 8 0 0 0 0 16z" fill="currentColor"/><circle cx="17" cy="17" r="8" stroke="currentColor" stroke-width="2"/>',
    "flatten": '<path d="M5 12l12-6 12 6-12 6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M5 18l12 6 12-6M5 24l12 6 12-6" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".45"/>',
}


def load(lang):
    with open(ROOT / "content" / f"{lang}.yaml", encoding="utf-8") as f:
        L = yaml.safe_load(f)
    L["lang"] = lang
    prefix = "" if lang == "en" else f"/{lang}"
    L["home_url"] = prefix + "/"
    L["urls"] = {}
    for key, P in L["pages"].items():
        L["urls"][key] = prefix + "/" + (P["slug"] + "/" if P.get("slug") else "")
        if P.get("body"):
            P["body_html"] = markdown.markdown(P["body"], extensions=["tables", "sane_lists"])
        else:
            P["body_html"] = ""
    return L


def jsonld_for(L, key, P, url):
    out = []
    if key in ALL_TOOLS:
        out.append({
            "@context": "https://schema.org", "@type": "WebApplication", "name": P["h1_plain"] if "h1_plain" in P else P["title"],
            "url": SITE + url, "applicationCategory": "UtilitiesApplication", "operatingSystem": "Any (web browser)",
            "browserRequirements": "Requires JavaScript and WebAssembly", "inLanguage": L["lang"],
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
            "description": P["description"], "isAccessibleForFree": True,
            "publisher": {"@type": "Organization", "name": "METIS", "url": SITE},
        })
    if key in ALL_TOOLS:
        g = next((g for g, ks in GROUPS if key in ks), None)
        out.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "pdfanonym", "item": SITE + L["home_url"]},
            {"@type": "ListItem", "position": 2, "name": L["ui"].get("g_" + g, g), "item": SITE + L["home_url"] + "#tools"},
            {"@type": "ListItem", "position": 3, "name": P.get("nav", P["title"]), "item": SITE + url}]})
    if P.get("faq"):
        out.append({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": f["q"], "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in P["faq"]]})
    if key == "home":
        out.append({"@context": "https://schema.org", "@type": "WebSite", "name": "pdfanonym", "url": SITE + url, "inLanguage": L["lang"]})
    elif key in ("guide", "anon_guide"):
        out.append({"@context": "https://schema.org", "@type": "Article", "headline": P["title"], "inLanguage": L["lang"],
                    "author": {"@type": "Organization", "name": "pdfanonym"}, "publisher": {"@type": "Organization", "name": "METIS"},
                    "dateModified": datetime.date.today().isoformat(), "mainEntityOfPage": SITE + url})
    elif key not in ALL_TOOLS:
        home = L["home_url"]
        out.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "pdfanonym", "item": SITE + home},
            {"@type": "ListItem", "position": 2, "name": P.get("nav", P["title"]), "item": SITE + url}]})
    return [json.dumps(o, ensure_ascii=False).replace("</", "<\\/") for o in out]


def asset_version():
    h = hashlib.sha1()
    h.update((ROOT / "build.py").read_bytes())  # une évolution du générateur (réécriture des imports…) change aussi la version
    for p in sorted((ROOT / "src" / "assets").rglob("*")):
        if p.is_file() and p.suffix in {".css", ".js"}:
            h.update(p.read_bytes())
    return h.hexdigest()[:10]


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(ROOT / "src", DIST)
    env = Environment(loader=FileSystemLoader(ROOT / "templates"), autoescape=True, trim_blocks=True, lstrip_blocks=True)
    langs = {l: load(l) for l in LANGS if (ROOT / "content" / f"{l}.yaml").exists()}
    # Une clé d'interface absente dans une langue reprend l'anglais (et on le signale).
    for l, L in langs.items():
        for section in ("ui", "js", "nav"):
            for k, val in langs["en"][section].items():
                if k not in L[section]:
                    print(f"  [{l}] {section}.{k} manquant : repli sur l'anglais")
                    L[section][k] = val
    v = asset_version()
    # Les imports entre modules reçoivent aussi le numéro de version : avec un cache « immutable » d'un an,
    # un import non versionné resterait figé sur l'ancienne version chez les visiteurs déjà passés.
    import re as _re
    for js in (DIST / "assets" / "js").glob("*.js"):
        src = js.read_text(encoding="utf-8")
        src = _re.sub(r'((?:from|import)\s*\(?\s*")(\.{1,2}/[^"?]+\.js)(")', lambda m: f"{m.group(1)}{m.group(2)}?v={v}{m.group(3)}", src)
        js.write_text(src, encoding="utf-8")
    year = datetime.date.today().year
    sitemap = []
    lang_menu_base = [{"lang": l, "name": langs[l]["name"]} for l in langs]

    for lang, L in langs.items():
        L["code_label"] = lang.upper()
        for key, P in L["pages"].items():
            url = L["urls"][key]
            alternates = [{"lang": l, "url": langs[l]["urls"][key]} for l in langs if key in langs[l]["pages"]]
            lang_menu = [{**m, "url": langs[m["lang"]]["urls"].get(key, langs[m["lang"]]["home_url"])} for m in lang_menu_base]
            tpl = "home.html" if key == "home" else "tool.html" if key in ALL_TOOLS else f"{key}.html" if key in PRO_PAGES else "page.html"
            html = env.get_template(tpl).render(
                L=L, P=P, page_key=key, url=url, site=SITE, alternates=alternates,
                xdefault=langs["en"]["urls"].get(key) if "en" in langs else None,
                lang_menu=lang_menu, tool=TOOL_OF.get(key), ui=UI_OF.get(key), script=SCRIPT_OF.get(UI_OF.get(key)), groups=GROUPS,
                group_of={k: g for g, ks in GROUPS for k in ks}, next_tools=NEXT.get(key, []),
                tool_keys=TOOL_KEYS, all_tools=ALL_TOOLS, page_keys=PAGE_KEYS, learn_keys=LEARN_KEYS,
                icons=ICONS, jsonld=jsonld_for(L, key, P, url), v=v, year=year)
            if key in ALL_TOOLS or key in PRO_PAGES:
                i18n = json.dumps(L["js"], ensure_ascii=False).replace("</", "<\\/")
                html = html.replace("</body>", f'<script type="application/json" id="i18n">{i18n}</script>\n</body>')
            out = DIST / url.strip("/") / "index.html"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(html, encoding="utf-8")
            if not P.get("noindex"):
                sitemap.append((url, alternates))

    # 404 (anglais, liens vers chaque langue)
    L = langs["en"]
    (DIST / "404.html").write_text(env.get_template("page.html").render(
        L=L, P={"title": "Page not found · pdfanonym", "description": "Page not found.", "h1": "Page not found",
                "lede": "This page does not exist. Try one of the tools below.", "body_html": "", "faq": None, "cta_tool": "redact", "cta": L["nav"]["redact"]},
        page_key="404", url="/404", site=SITE, alternates=[], xdefault=None,
        lang_menu=[{**m, "url": langs[m["lang"]]["home_url"]} for m in lang_menu_base], tool=None,
        tool_keys=TOOL_KEYS, all_tools=ALL_TOOLS, page_keys=PAGE_KEYS, learn_keys=LEARN_KEYS, icons=ICONS, jsonld=[],
        groups=GROUPS, group_of={}, ui=None, script=None, next_tools=[], v=v, year=year), encoding="utf-8")

    # Sitemap avec hreflang
    today = datetime.date.today().isoformat()
    rows = []
    for url, alts in sitemap:
        links = "".join(f'<xhtml:link rel="alternate" hreflang="{a["lang"]}" href="{SITE}{a["url"]}"/>' for a in alts)
        rows.append(f"<url><loc>{SITE}{url}</loc><lastmod>{today}</lastmod>{links}</url>")
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
                                      + "\n".join(rows) + "\n</urlset>\n", encoding="utf-8")
    (DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n", encoding="utf-8")
    shutil.copy(ROOT / "deploy" / "_headers", DIST / "_headers")
    shutil.copy(ROOT / "deploy" / "_redirects", DIST / "_redirects")

    # Code source complet (AGPL) : tout ce qui sert à produire le site.
    src_dir = DIST / "source"
    src_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(src_dir / "pdfanonym-source.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for base in ["src", "templates", "content", "deploy", "functions"]:
            for p in sorted((ROOT / base).rglob("*")):
                if p.is_file() and p.name != ".DS_Store":
                    z.write(p, "pdfanonym/" + str(p.relative_to(ROOT)))
        for f in ["build.py", "LICENSE", "README.md"]:
            if (ROOT / f).exists():
                z.write(ROOT / f, "pdfanonym/" + f)
    print(f"OK : {sum(len(L['pages']) for L in langs.values())} pages, langues {', '.join(langs)}, assets v={v}")


if __name__ == "__main__":
    build()
