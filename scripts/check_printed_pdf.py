"""Audit the actual PDF emitted by Zotero's Gecko print pipeline, not HTML."""
import re
import sys
from pathlib import Path
import fitz

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(f"Missing actual Zotero print fixture: {path}")
doc = fitz.open(path)
expected = {f"BRLINE{i:04d}" for i in range(144)}
found = []
figure_red = 0
figure_blue = 0
for i, page in enumerate(doc):
    # Both extractable text and rendered ink must survive print clipping.
    for word in page.get_text("words"):
        marker = word[4]
        if not re.fullmatch(r"BRLINE\d{4}", marker):
            continue
        rect = fitz.Rect(word[:4])
        if not page.rect.contains(rect):
            raise AssertionError(f"{marker} is outside page {i + 1}: {rect}")
        raster = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False)
        if raster.width <= 0 or raster.height <= 0:
            raise AssertionError(f"{marker} has empty rendered bounding box")
        samples = raster.samples
        dark = sum(
            1 for j in range(0, len(samples), raster.n)
            if max(samples[j:j+3]) < 160
        )
        if dark < 8:
            raise AssertionError(f"{marker} is extractable but covered/blank on page {i + 1}")
        found.append(marker)
    pix = page.get_pixmap(alpha=False)
    buf = pix.samples
    for j in range(0, len(buf), pix.n):
        r, g, b = buf[j:j+3]
        figure_red += r > 160 and g < 90 and b < 90
        figure_blue += b > 160 and r < 90 and g < 100

if set(found) != expected or len(found) != len(expected):
    raise AssertionError(f"Missing/duplicated text markers: missing={sorted(expected-set(found))}, count={len(found)}")
if found != sorted(found):
    raise AssertionError("Numbered lines are out of order")
if min(figure_red, figure_blue) < 100:
    raise AssertionError(f"Embedded red-blue figure not visibly rendered: {figure_red}, {figure_blue}")
print(f"PASS: {len(doc)} real printed pages; {len(found)} visible text markers; red={figure_red}, blue={figure_blue} pixels.")


# Check paired output independently: physical left/right geometry, rotation,
# continuation completeness, and actual visible text/figure pixels.
paired_path = path.with_name("side-by-side.pdf")
if not paired_path.is_file():
    raise SystemExit(f"Missing paired Zotero print fixture: {paired_path}")
paired = fitz.open(paired_path)
wanted = {f"BRRIGHT0{i:03d}" for i in range(96)} | {"BRRIGHT1000"}
seen = []
left_original = left_rotated = blue = red = 0
for page in paired:
    if not 1200 < page.rect.width < 1210:
        raise AssertionError(f"Not a wide paired sheet: {page.rect}")
    midpoint = page.rect.width / 2
    for word in page.get_text("words"):
        marker = word[4]
        rect = fitz.Rect(word[:4])
        if marker.startswith("BRRIGHT"):
            if not page.rect.contains(rect) or rect.x0 <= midpoint:
                raise AssertionError(f"Right-panel text misplaced: {marker} {rect}")
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False)
            samples = pix.samples
            if sum(max(samples[j:j+3]) < 160 for j in range(0, len(samples), pix.n)) < 8:
                raise AssertionError(f"Blank/clipped right marker: {marker}")
            seen.append(marker)
        elif marker in ("BRORIGINAL", "BRROTATED"):
            if not page.rect.contains(rect) or rect.x1 >= midpoint:
                raise AssertionError(f"Original marker outside left panel: {marker} {rect}")
            left_original += marker == "BRORIGINAL"
            left_rotated += marker == "BRROTATED"
    pix = page.get_pixmap(clip=fitz.Rect(0, 0, midpoint, page.rect.height), alpha=False)
    samples = pix.samples
    for j in range(0, len(samples), pix.n):
        r, g, b = samples[j:j+3]
        blue += b > 160 and r < 90 and g < 90
        red += r > 160 and g < 90 and b < 90
if set(seen) != wanted or len(seen) != len(wanted):
    raise AssertionError(f"Missing or duplicate right-panel markers: {wanted-set(seen)}")
if left_original != 1 or left_rotated != 1 or min(blue, red) < 100:
    raise AssertionError(f"Missing left artwork, rotation, or continuation: {left_original}, {left_rotated}, {blue}, {red}")
print(f"PASS: {len(paired)} paired pages, {len(seen)} right-side visible markers, original={left_original}, rotated={left_rotated}.")

# The toolbar fixture replaces both columns on a single original page.
with fitz.open(path.with_name("side-by-side-export.pdf")) as positioned:
    assert len(positioned) == 1
    sheet = positioned[0]
    midpoint = sheet.rect.width / 2
    right_width = sheet.rect.width - midpoint
    for original, translated in [
        ("Synthetic reader layout test.", "LEFTANCHOR"),
        ("Independent right column text.", "RIGHTANCHOR"),
    ]:
        source = sheet.search_for(original)
        target = sheet.search_for(translated)
        assert len(source) == len(target) == 1
        assert source[0].x1 < midpoint < target[0].x0
        assert abs(target[0].x0 - source[0].x0 - (midpoint + 8)) < 3
        assert abs(target[0].y0 - source[0].y0) < 8
    rgb = sheet.get_pixmap(clip=fitz.Rect(midpoint, 0, midpoint + right_width, sheet.rect.height), alpha=False)
    samples = rgb.samples
    assert sum(r > 160 and g < 90 and b < 90 for r, g, b in zip(
        samples[0::3], samples[1::3], samples[2::3],
    )) > 100
    assert sum(b > 160 and g < 90 and r < 90 for r, g, b in zip(
        samples[0::3], samples[1::3], samples[2::3],
    )) > 100
print("PASS: original bilingual-sheet text remains left; both replacements and figures remain in position on the right.")

# Strict direct-renderer toolbar fixture above must contain searchable Chinese, not just images.
with fitz.open(path.with_name("side-by-side-export.pdf")) as direct:
    right = fitz.Rect(direct[0].rect.width / 2, 0, direct[0].rect.width, direct[0].rect.height)
    text = direct[0].get_text(clip=right)
    for marker in ("左栏原位译文", "右栏原位译文"):
        assert marker in text, f"Missing searchable Chinese text: {marker}"
print("PASS: direct PDF contains searchable Chinese in both columns.")

# Verify actual font programs, Unicode mapping, and physical ink, not merely
# successful PDF parsing. Search coordinates and rendered pixels are independent.
with fitz.open(path.with_name("side-by-side-export.pdf")) as direct:
    sheet = direct[0]
    fonts = [font for font in sheet.get_fonts(full=True) if "BilingualReaderCJK" in font[3]]
    assert fonts, "Missing embedded Noto CJK font"
    assert any(direct.extract_font(font[0])[3] for font in fonts), "Missing font program"
    for marker in ("左栏原位译文", "右栏原位译文"):
        rects = sheet.search_for(marker)
        assert len(rects) == 1 and rects[0].x0 > sheet.rect.width / 2
        pix = sheet.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rects[0], alpha=False)
        assert sum(max(pixel) < 160 for pixel in zip(pix.samples[0::pix.n], pix.samples[1::pix.n], pix.samples[2::pix.n])) > 8
print("PASS: embedded CJK font program and visible searchable Chinese glyphs.")

with fitz.open(path.with_name("direct-continuation.pdf")) as continuation:
    seen = []
    left_count = 0
    chinese_count = 0
    for sheet in continuation:
        mid = sheet.rect.width / 2
        left = fitz.Rect(0, 0, mid, sheet.rect.height)
        right = fitz.Rect(mid, 0, sheet.rect.width, sheet.rect.height)
        left_count += sheet.get_text(clip=left).count("Synthetic reader layout test.")
        chinese_count += sheet.get_text(clip=right).count("中文续页完整性")
        for word in sheet.get_text("words"):
            if not re.fullmatch(r"BRDIRECT\d{4}", word[4]):
                continue
            rect = fitz.Rect(word[:4])
            assert right.contains(rect), (word[4], rect)
            pix = sheet.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False)
            assert sum(max(pixel) < 160 for pixel in zip(pix.samples[0::pix.n], pix.samples[1::pix.n], pix.samples[2::pix.n])) > 8
            seen.append(word[4])
    assert len(continuation) >= 3 and left_count == 1
    assert seen == [f"BRDIRECT{i:04d}" for i in range(112)], seen
    assert chinese_count == 112, chinese_count
print(f"PASS: 112 ordered and visible direct continuation markers with Chinese; original appears once.")

for name, anchor, chinese in [
    ("direct-fallback.pdf", "BRFALLBACK", "兼容打印验证"),
    ("direct-legacy.pdf", "BRLEGACY", "旧版打印验证"),
]:
    with fitz.open(path.with_name(name)) as fallback:
        assert len(fallback) == 1
        sheet = fallback[0]
        right = fitz.Rect(sheet.rect.width / 2, 0, sheet.rect.width, sheet.rect.height)
        assert anchor in sheet.get_text(clip=right)
        assert chinese in sheet.get_text(clip=right), f"Missing Chinese in {name}"
        for rect in sheet.search_for(chinese):
            pix = sheet.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False)
            assert sum(max(pixel) < 160 for pixel in zip(pix.samples[0::pix.n], pix.samples[1::pix.n], pix.samples[2::pix.n])) > 8
        rects = sheet.search_for(anchor)
        assert len(rects) == 1 and right.contains(rects[0])
        pix = sheet.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rects[0], alpha=False)
        assert sum(max(pixel) < 160 for pixel in zip(pix.samples[0::pix.n], pix.samples[1::pix.n], pix.samples[2::pix.n])) > 8
print("PASS: automatic missing-glyph fallback and explicitly selected legacy printing produce visible searchable text.")
