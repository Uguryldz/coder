#!/usr/bin/env python3
"""
HFKB kurumsal Word şablonunu, bankanın kendi PDD örneğinden üretir.

Kaynak:  plan/Kredi ve Teminat Yönetim Süreci (1) (1).docx  (bankanın örnek analizi)
Çıktı:   deploy/banka/sablon/HFKB-Analiz-Sablonu.docx      (Studio → Word şablonu → Şablon yükle)

Ne yapar: kapak, künye, içindekiler, üstbilgi/altbilgi, stiller ve "Belge Onayı"
tablosu OLDUĞU GİBİ kalır; gövde (Özet … İş akış tablosu) yerine Maestro'nun
yer tutucuları konur — {{bolum:1}} … {{bolum:15}} ve taşan bölümler için {{govde}}.
Kişi adları ve tarih gibi örneğe özgü değerler boşaltılır; başlık {{baslik}},
ticket {{ticket}}, künye {{kunye}} olur. Word belgeyi açınca içindekileri
yenilemesi için updateFields işaretlenir.

Neden XML cerrahisi: Maestro şablonu YENİDEN ÜRETMEZ, yamalar (docx patchDocument);
kapak/stil/logo bankanın dosyasından geldiği gibi kalmalı. Bu betik de aynı
ilkeyle yalnız gövdeyi keser ve yer tutucu paragrafları ekler.

Kullanım:  python3 deploy/banka/sablon/sablon-uret.py
"""
from __future__ import annotations
import re, sys, zipfile, io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "plan" / "Kredi ve Teminat Yönetim Süreci (1) (1).docx"
OUT = Path(__file__).resolve().parent / "HFKB-Analiz-Sablonu.docx"
SECTION_SLOTS = 9  # motorun kurumsal iskeleti 9 bölüm (packages/agent-roles/data/analysis-template.tr.json); Studio şablonu bunları sırayla adlandırır

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

def text_of(seg: str) -> str:
    return "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", seg)).strip()

def top_level_children(body: str) -> list[tuple[str, int, int]]:
    """(tag, start, end) for every top-level <w:p>/<w:tbl>/<w:sdt>/<w:sectPr> in the body."""
    tag_re = re.compile(r"<(/?)(w:p|w:tbl|w:sdt|w:sectPr)(\s[^>]*?)?(/?)>")
    depth, start, out = 0, None, []
    for m in tag_re.finditer(body):
        closing, name, _attrs, selfclose = m.groups()
        if not closing and not selfclose:
            if depth == 0:
                start = (m.start(), name)
            depth += 1
        elif closing:
            depth -= 1
            if depth == 0 and start is not None:
                out.append((start[1], start[0], m.end()))
                start = None
        elif selfclose and depth == 0:
            out.append((name, m.start(), m.end()))
    return out

def para(text: str, ppr: str = "") -> str:
    """A one-run paragraph — the token must sit in ONE <w:t> for the scanner and patcher."""
    esc = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"<w:p>{ppr}<w:r><w:t xml:space=\"preserve\">{esc}</w:t></w:r></w:p>"

def set_paragraph_text(seg: str, new_text: str) -> str:
    """Rewrite a paragraph's runs to a single run with the first run's formatting."""
    m = re.search(r"<w:r\b[^>]*>.*?</w:r>", seg, re.S)
    if m is None:
        return seg
    rpr = re.search(r"<w:rPr>.*?</w:rPr>", m.group(0), re.S)
    run = f"<w:r>{rpr.group(0) if rpr else ''}<w:t xml:space=\"preserve\">{new_text}</w:t></w:r>"
    without_runs = re.sub(r"<w:r\b[^>]*>.*?</w:r>", "", seg, flags=re.S)
    return without_runs.replace("</w:p>", run + "</w:p>", 1) if "</w:p>" in without_runs else seg

def replace_cell_texts(table: str, mapping: dict[str, str]) -> str:
    """In a table, paragraphs whose visible text equals a key get the mapped text (may be empty)."""
    def fix_para(m: re.Match) -> str:
        seg = m.group(0)
        t = text_of(seg)
        for old, new in mapping.items():
            if t == old:
                return set_paragraph_text(seg, new)
        return seg
    return re.sub(r"<w:p\b[^>]*>.*?</w:p>", fix_para, table, flags=re.S)

def strip_runs_keep_ppr(seg: str) -> str:
    return re.sub(r"<w:r\b[^>]*>.*?</w:r>", "", seg, flags=re.S)

def main() -> None:
    if not SRC.exists():
        sys.exit(f"kaynak yok: {SRC}")
    z = zipfile.ZipFile(SRC)
    doc = z.read("word/document.xml").decode("utf8")
    bs, be = doc.index("<w:body>") + len("<w:body>"), doc.rindex("</w:body>")
    body = doc[bs:be]
    ch = top_level_children(body)
    segs = [body[a:b] for _, a, b in ch]
    texts = [text_of(s) for s in segs]

    def idx(prefix: str, start: int = 0) -> int:
        for i in range(start, len(texts)):
            if texts[i].startswith(prefix):
                return i
        raise SystemExit(f"bulunamadı: {prefix!r}")

    i_history = idx("Document History")
    i_history_tbl = next(i for i in range(i_history, len(ch)) if ch[i][0] == "w:tbl")
    i_abbr = idx("KISALTMA LİSTESİ")
    i_fig = idx("ŞEKİL LİSTESİ")
    i_ozet = idx("ÖZET")
    i_onay = idx("3. BELGE ONAYI")
    i_onay_tbl = next(i for i in range(i_onay, len(ch)) if ch[i][0] == "w:tbl")
    i_kisiler = idx("4. Süreçteki Kişiler")
    i_final_sect = len(ch) - 1
    assert ch[i_final_sect][0] == "w:sectPr", "gövde sonunda sectPr bekleniyordu"

    # Front-matter section break lives in the paragraph right after ÖZET's first
    # content paragraph; keep THAT paragraph (emptied) so roman page numbering ends
    # where the bank's does.
    i_front_break = next(i for i in range(i_ozet, i_onay) if "<w:sectPr" in segs[i])

    out: list[str] = []
    for i in range(0, i_ozet):
        seg = segs[i]
        if i == 0 or i == 1:  # kapak tablosu (i==1) — örneğe özgü değerler
            if ch[i][0] == "w:tbl":
                seg = replace_cell_texts(seg, {
                    "Kredi ve Teminat Yönetim Süreci": "{{baslik}}",
                    "PROCESS DEFINITION DOCUMENT": "ANALİZ DOKÜMANI",
                    "Seval Naz KARAHAN": "Maestro",
                    "14/10/2025": "{{ticket}}",
                })
        if i == i_history:
            seg = set_paragraph_text(seg, "Doküman Künyesi")
        if i == i_history_tbl:
            seg = para("{{kunye}}")
        if i_abbr < i < i_fig and (texts[i].startswith("RPA") or texts[i].startswith("PDD")):
            continue  # örneğin RPA/PDD kısaltmaları
        if i_fig <= i < i_ozet:
            continue  # şekil ve tablo listeleri: üretilen belgede şekil/tablo başlığı yok
        out.append(seg)

    # Gövde: bölüm yuvaları. Önce ön bölüm kesmesini taşıyan paragraf (metinsiz).
    out.append(strip_runs_keep_ppr(segs[i_front_break]))
    for n in range(1, SECTION_SLOTS + 1):
        out.append(para(f"{{{{bolum:{n}}}}}"))
    out.append(para("{{govde}}"))

    # Belge onayı bölümü: başlık numarasız, kişi adları/birim/tarih boş, hazırlayan Maestro.
    for i in range(i_onay, i_kisiler):
        seg = segs[i]
        if i == i_onay:
            seg = set_paragraph_text(seg, "BELGE ONAYI")
        if i == i_onay_tbl:
            seg = replace_cell_texts(seg, {
                "Seval Naz Karahan": "Maestro",
                "İlknur Özkan Hasağa": "",
                "Uğur Yılmaz": "",
                "Yazılım Geliştirme": "",
                "Consultant": "Analist (Maestro)",
                # Sürüm sütunu: belgeyi üreten analiz şablonunun sürümü (Maestro doldurur).
                "1.0": "{{sablon_surumu}}",
            })
        out.append(seg)
    # "4. Süreçteki Kişiler" artık analiz şablonunun bir bölümü; örnekteki adlar gitmez.
    out.append(segs[i_final_sect])

    new_body = "".join(out)
    new_doc = doc[:bs] + new_body + doc[be:]

    # Word açılışta İÇİNDEKİLER'i yenilesin (TOC önbelleği örneğin başlıklarını taşıyor).
    settings = z.read("word/settings.xml").decode("utf8")
    if "<w:updateFields" not in settings:
        anchor = next((t for t in ("<w:hdrShapeDefaults", "<w:footnotePr", "<w:endnotePr", "<w:compat") if t in settings), None)
        if anchor is None:
            raise SystemExit("settings.xml içinde updateFields için çapa yok")
        settings = settings.replace(anchor, '<w:updateFields w:val="true"/>' + anchor, 1)

    # Kullanılmayan görseller: gövdeyle birlikte giden çizimlerin ilişkileri ve dosyaları.
    rels = z.read("word/_rels/document.xml.rels").decode("utf8")
    used_ids = set(re.findall(r'r:(?:embed|id|link)="([^"]+)"', new_doc))
    kept_targets: set[str] = set()
    def keep_rel(m: re.Match) -> str:
        rel = m.group(0)
        rid = re.search(r'Id="([^"]+)"', rel).group(1)
        target = re.search(r'Target="([^"]+)"', rel).group(1)
        is_image = "/image" in rel
        if is_image and rid not in used_ids:
            return ""
        kept_targets.add(target)
        return rel
    rels = re.sub(r"<Relationship\b[^>]*/>", keep_rel, rels)
    # header/footer rels de medya kullanır; onları da tut
    for name in z.namelist():
        if name.startswith("word/_rels/") and name != "word/_rels/document.xml.rels":
            kept_targets.update(re.findall(r'Target="([^"]+)"', z.read(name).decode("utf8")))
    kept_media = {"word/" + t.lstrip("/") for t in kept_targets if t.startswith("media/")}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in z.infolist():
            n = item.filename
            if n.startswith("word/media/") and n not in kept_media:
                continue
            if n == "word/document.xml":
                data = new_doc.encode("utf8")
            elif n == "word/settings.xml":
                data = settings.encode("utf8")
            elif n == "word/_rels/document.xml.rels":
                data = rels.encode("utf8")
            else:
                data = z.read(n)
            zo.writestr(item, data)
    OUT.write_bytes(buf.getvalue())

    # Doğrulama: yer tutucular tek tek, birer kez; örnek kişi adları yok.
    vis = re.sub(r"<[^>]+>", "\n", new_doc)
    for tok in ["{{baslik}}", "{{ticket}}", "{{kunye}}", "{{govde}}"] + [f"{{{{bolum:{n}}}}}" for n in range(1, SECTION_SLOTS + 1)]:
        assert vis.count(tok) == 1, f"{tok} {vis.count(tok)} kez"
    assert vis.count("{{sablon_surumu}}") >= 1, "sablon_surumu yok"
    for name in ["Seval", "İlknur", "Uğur Yılmaz", "Ercan", "YILDIZ", "UiPath", "BOA"]:
        assert name not in vis, f"örneğe özgü metin kaldı: {name}"
    print(f"yazıldı: {OUT} ({OUT.stat().st_size // 1024} KB; kaynak {SRC.stat().st_size // 1024} KB)")
    print("medya:", len(kept_media), "dosya tutuldu")

if __name__ == "__main__":
    main()
