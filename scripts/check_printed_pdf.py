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
            if sum(max(pix.samples[j:j+3]) < 160 for j in range(0, len(pix.samples), pix.n)) < 8:
                raise AssertionError(f"Blank/clipped right marker: {marker}")
            seen.append(marker)
        elif marker in ("BRORIGINAL", "BRROTATED"):
            if not page.rect.contains(rect) or rect.x1 >= midpoint:
                raise AssertionError(f"Original marker outside left panel: {marker} {rect}")
            left_original += marker == "BRORIGINAL"
            left_rotated += marker == "BRROTATED"
    pix = page.get_pixmap(clip=fitz.Rect(0, 0, midpoint, page.rect.height), alpha=False)
    for j in range(0, len(pix.samples), pix.n):
        r, g, b = pix.samples[j:j+3]
        blue += b > 160 and r < 90 and g < 90
        red += r > 160 and g < 90 and b < 90
if set(seen) != wanted or len(seen) != len(wanted):
    raise AssertionError(f"Missing or duplicate right-panel markers: {wanted-set(seen)}")
if left_original < 2 or left_rotated != 1 or min(blue, red) < 100:
    raise AssertionError(f"Missing left artwork, rotation, or continuation: {left_original}, {left_rotated}, {blue}, {red}")
print(f"PASS: {len(paired)} paired pages, {len(seen)} right-side visible markers, repeated original={left_original}, rotated={left_rotated}.")
