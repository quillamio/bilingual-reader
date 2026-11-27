// MIT: Ax1zz/notofu @ 123ebf7d53b194f16c477e73a50a67bea0b5c0fc; local import extension adaptation.
/**
 * `glyf` handling: discovering composite glyph dependencies and renumbering
 * component references when glyphs are reordered by the subsetter.
 *
 * A composite glyph is built from other glyphs (an "e-acute" referencing "e"
 * and the accent, for example). Subsetting must pull those components in, or
 * the glyph renders as garbage.
 */

import { Reader, FontFormatError, copyOf } from './binary.ts';

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/** Byte offsets, within a glyph's data, of each component's glyphIndex field. */
export interface ComponentRef {
  /** Offset of the uint16 glyphIndex field, relative to glyph start. */
  fieldOffset: number;
  glyphIndex: number;
}

/**
 * Walks a composite glyph's component list.
 *
 * Returns an empty array for simple glyphs and for empty glyphs (space, and
 * the many blank glyphs in CJK fonts).
 */
export function readComponents(glyph: Uint8Array): ComponentRef[] {
  if (glyph.length < 10) return []; // empty glyph, e.g. space
  const r = new Reader(glyph);
  const numberOfContours = r.i16();
  if (numberOfContours >= 0) return []; // simple glyph

  r.skip(8); // xMin, yMin, xMax, yMax
  const out: ComponentRef[] = [];
  // Cap iterations: a malformed font must not spin forever here.
  for (let guard = 0; guard < 512; guard++) {
    if (r.pos + 4 > glyph.length) break;
    const flags = r.u16();
    const fieldOffset = r.pos;
    const glyphIndex = r.u16();
    out.push({ fieldOffset, glyphIndex });

    r.skip(flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
    if (flags & WE_HAVE_A_SCALE) r.skip(2);
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) r.skip(4);
    else if (flags & WE_HAVE_A_TWO_BY_TWO) r.skip(8);

    if (!(flags & MORE_COMPONENTS)) break;
  }
  return out;
}

/** True when the glyph data describes a composite glyph. */
export function isComposite(glyph: Uint8Array): boolean {
  if (glyph.length < 2) return false;
  return new Reader(glyph).i16() < 0;
}

/**
 * Expands a set of glyph ids to include every glyph they reference, directly
 * or transitively, through composite components.
 */
export function closeOverComponents(
  seed: Iterable<number>,
  getGlyph: (gid: number) => Uint8Array,
  numGlyphs: number,
): Set<number> {
  const result = new Set<number>();
  const stack: number[] = [];
  for (const g of seed) {
    if (g >= 0 && g < numGlyphs && !result.has(g)) {
      result.add(g);
      stack.push(g);
    }
  }
  while (stack.length > 0) {
    const gid = stack.pop()!;
    // A broken glyph entry must not abort the whole subset. `readComponents`
    // can throw on a truncated composite (flags promise argument bytes that
    // are not there), so it belongs inside the guard alongside `getGlyph`.
    try {
      const glyph = getGlyph(gid);
      if (glyph.length === 0) continue;
      for (const comp of readComponents(glyph)) {
        const child = comp.glyphIndex;
        if (child >= 0 && child < numGlyphs && !result.has(child)) {
          result.add(child);
          stack.push(child);
        }
      }
    } catch {
      continue;
    }
  }
  return result;
}

/**
 * Returns a copy of `glyph` with composite component glyph ids remapped.
 *
 * The rewrite is size-preserving: only the uint16 glyphIndex fields change.
 */
export function remapComponents(glyph: Uint8Array, map: Map<number, number>): Uint8Array {
  const comps = readComponents(glyph);
  if (comps.length === 0) return glyph;
  const out = copyOf(glyph);
  for (const c of comps) {
    const next = map.get(c.glyphIndex);
    if (next === undefined) {
      // The component was not retained. That should be impossible after
      // closeOverComponents, so treat it as a bug rather than corrupt silently.
      throw new FontFormatError(
        `composite glyph references glyph ${c.glyphIndex}, which was not included in the subset`,
      );
    }
    out[c.fieldOffset] = (next >> 8) & 0xff;
    out[c.fieldOffset + 1] = next & 0xff;
  }
  return out;
}
