// MIT: Ax1zz/notofu @ 123ebf7d53b194f16c477e73a50a67bea0b5c0fc; local import extension adaptation.
/**
 * `cmap` reading and writing.
 *
 * Reading supports the subtable formats that occur in practice: 0, 4, 6, 12
 * and 13. Writing emits format 4 (BMP) and, when any codepoint sits above
 * U+FFFF, an additional format 12 subtable.
 */

import { Reader, Writer, FontFormatError } from './binary.ts';

export interface CmapSubtableRef {
  platformID: number;
  encodingID: number;
  offset: number;
  format: number;
}

/** Ranks candidate subtables; higher is better. */
function scoreSubtable(platformID: number, encodingID: number, format: number): number {
  // Windows full-repertoire UCS-4 is the richest source available.
  if (platformID === 3 && encodingID === 10) return 100;
  if (platformID === 0 && (encodingID === 4 || encodingID === 6)) return 95;
  if (platformID === 3 && encodingID === 1) return 90;
  if (platformID === 0) return 85;
  // Windows symbol fonts map into the U+F000 private use block.
  if (platformID === 3 && encodingID === 0) return 40;
  if (platformID === 1 && encodingID === 0) return 20;
  return format === 12 ? 30 : 10;
}

export function listSubtables(cmap: Uint8Array): CmapSubtableRef[] {
  if (cmap.length < 4) throw new FontFormatError('cmap table is truncated');
  const r = new Reader(cmap);
  r.u16(); // version
  const numTables = r.u16();
  const refs: CmapSubtableRef[] = [];
  for (let i = 0; i < numTables; i++) {
    if (r.pos + 8 > cmap.length) break;
    const platformID = r.u16();
    const encodingID = r.u16();
    const offset = r.u32();
    if (offset + 2 > cmap.length) continue;
    const format = r.peekU16(offset);
    refs.push({ platformID, encodingID, offset, format });
  }
  return refs;
}

/**
 * Ceiling on how many codepoint mappings any cmap may produce.
 *
 * Unicode defines 0x110000 scalar values, so no honest font can exceed this.
 * Without the cap, a tiny malicious cmap declaring many full-range groups
 * makes the parser allocate for hours — a cheap denial of service against any
 * server that subsets user-supplied fonts.
 */
const MAX_CMAP_MAPPINGS = 0x120000;

function readFormat0(r: Reader, out: Map<number, number>): void {
  // length, language already consumed by caller convention; here we re-read.
  r.u16(); // length
  r.u16(); // language
  for (let c = 0; c < 256; c++) {
    const g = r.u8();
    if (g !== 0) out.set(c, g);
  }
}

function readFormat4(subtable: Uint8Array, out: Map<number, number>): void {
  // Clamp to the declared subtable length before doing anything else.
  // idRangeOffset arithmetic can otherwise reach into a neighbouring
  // subtable's bytes and silently produce wrong glyph ids.
  const declared = subtable.length >= 4 ? (subtable[2]! << 8) | subtable[3]! : 0;
  const sub = declared >= 16 ? subtable.subarray(0, Math.min(declared, subtable.length)) : subtable;

  const r = new Reader(sub);
  r.u16(); // format
  const length = Math.min(r.u16(), sub.length);
  r.u16(); // language
  const segCountX2 = r.u16();
  const segCount = segCountX2 >> 1;
  if (segCount === 0) return;
  r.skip(6); // searchRange, entrySelector, rangeShift

  const endCode = new Array<number>(segCount);
  for (let i = 0; i < segCount; i++) endCode[i] = r.u16();
  r.u16(); // reservedPad
  const startCode = new Array<number>(segCount);
  for (let i = 0; i < segCount; i++) startCode[i] = r.u16();
  const idDelta = new Array<number>(segCount);
  for (let i = 0; i < segCount; i++) idDelta[i] = r.i16();
  const idRangeOffsetPos = r.pos;
  const idRangeOffset = new Array<number>(segCount);
  for (let i = 0; i < segCount; i++) idRangeOffset[i] = r.u16();

  let total = 0;
  for (let i = 0; i < segCount; i++) {
    const start = startCode[i]!;
    const end = endCode[i]!;
    if (start > end || start === 0xffff) continue;
    total += Math.min(end, 0xffff) - start + 1;
    if (total > MAX_CMAP_MAPPINGS) {
      throw new FontFormatError('cmap format 4 declares implausibly many mappings');
    }
    for (let c = start; c <= end && c <= 0xffff; c++) {
      let gid: number;
      const iro = idRangeOffset[i]!;
      if (iro === 0) {
        gid = (c + idDelta[i]!) & 0xffff;
      } else {
        // Spec-defined pointer arithmetic relative to this idRangeOffset slot.
        const addr = idRangeOffsetPos + i * 2 + iro + (c - start) * 2;
        if (addr + 2 > length) continue;
        const raw = (sub[addr]! << 8) | sub[addr + 1]!;
        if (raw === 0) continue;
        gid = (raw + idDelta[i]!) & 0xffff;
      }
      if (gid !== 0) out.set(c, gid);
    }
  }
}

function readFormat6(r: Reader, out: Map<number, number>): void {
  r.u16(); // length
  r.u16(); // language
  const first = r.u16();
  const count = r.u16();
  for (let i = 0; i < count; i++) {
    const g = r.u16();
    if (g !== 0) out.set(first + i, g);
  }
}

function readFormat12or13(r: Reader, out: Map<number, number>, format: number): void {
  r.u16(); // reserved
  r.u32(); // length
  r.u32(); // language
  const nGroups = r.u32();
  if (nGroups > 0x100000) throw new FontFormatError(`cmap format ${format}: implausible group count`);

  let total = 0;
  for (let i = 0; i < nGroups; i++) {
    const startChar = r.u32();
    const endChar = r.u32();
    const startGlyph = r.u32();
    if (endChar < startChar || startChar > 0x10ffff) continue;

    const span = Math.min(endChar, 0x10ffff) - startChar;
    total += span + 1;
    if (total > MAX_CMAP_MAPPINGS) {
      throw new FontFormatError(
        `cmap format ${format} declares more than ${MAX_CMAP_MAPPINGS} mappings; refusing to expand it`,
      );
    }
    for (let k = 0; k <= span; k++) {
      // Format 13 maps a whole range to one glyph; format 12 increments.
      const gid = format === 13 ? startGlyph : startGlyph + k;
      if (gid !== 0) out.set(startChar + k, gid);
    }
  }
}

/**
 * Decodes the best available Unicode subtable into a codepoint -> glyph map.
 */
export function readCmap(cmap: Uint8Array): Map<number, number> {
  const refs = listSubtables(cmap);
  if (refs.length === 0) throw new FontFormatError('cmap contains no subtables');

  const usable = refs.filter((s) => [0, 4, 6, 12, 13].includes(s.format));
  if (usable.length === 0) {
    const seen = [...new Set(refs.map((s) => s.format))].join(', ');
    throw new FontFormatError(`cmap has no supported subtable (found format(s): ${seen})`);
  }
  usable.sort(
    (a, b) =>
      scoreSubtable(b.platformID, b.encodingID, b.format) -
      scoreSubtable(a.platformID, a.encodingID, a.format),
  );

  const out = new Map<number, number>();
  const best = usable[0]!;
  const sub = cmap.subarray(best.offset);
  const r = new Reader(sub);
  const format = r.u16();
  switch (format) {
    case 0:
      readFormat0(r, out);
      break;
    case 4:
      readFormat4(sub, out);
      break;
    case 6:
      readFormat6(r, out);
      break;
    case 12:
    case 13:
      readFormat12or13(r, out, format);
      break;
    default:
      throw new FontFormatError(`unsupported cmap format ${format}`);
  }

  // Windows symbol fonts (3,0) address glyphs through U+F000..U+F0FF.
  // Expose the low ASCII aliases too so plain text still resolves.
  if (best.platformID === 3 && best.encodingID === 0) {
    for (const [cp, gid] of [...out]) {
      if (cp >= 0xf000 && cp <= 0xf0ff && !out.has(cp - 0xf000)) {
        out.set(cp - 0xf000, gid);
      }
    }
  }
  return out;
}

interface Segment {
  start: number;
  end: number;
  gids: number[];
}

function toSegments(pairs: Array<[number, number]>): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const [cp, gid] of pairs) {
    if (cur && cp === cur.end + 1) {
      cur.end = cp;
      cur.gids.push(gid);
    } else {
      cur = { start: cp, end: cp, gids: [gid] };
      segs.push(cur);
    }
  }
  return segs;
}

function buildFormat4(pairs: Array<[number, number]>): Uint8Array {
  const bmp = pairs.filter(([cp]) => cp <= 0xffff);
  const segs = toSegments(bmp);

  // Format 4 requires a terminating segment ending at 0xFFFF.
  const entries: Array<{ start: number; end: number; delta: number; gids: number[] | null }> = [];
  for (const s of segs) {
    let contiguous = true;
    for (let i = 1; i < s.gids.length; i++) {
      if (s.gids[i]! !== s.gids[i - 1]! + 1) {
        contiguous = false;
        break;
      }
    }
    if (contiguous) {
      entries.push({
        start: s.start,
        end: s.end,
        delta: (s.gids[0]! - s.start) & 0xffff,
        gids: null,
      });
    } else {
      entries.push({ start: s.start, end: s.end, delta: 0, gids: s.gids });
    }
  }
  entries.push({ start: 0xffff, end: 0xffff, delta: 1, gids: null });

  const segCount = entries.length;
  const glyphIdArray: number[] = [];
  const idRangeOffset = new Array<number>(segCount).fill(0);
  for (let i = 0; i < segCount; i++) {
    const e = entries[i]!;
    if (e.gids) {
      // Offset is measured in bytes from this slot to the glyph id data.
      idRangeOffset[i] = (segCount - i) * 2 + glyphIdArray.length * 2;
      glyphIdArray.push(...e.gids);
    }
  }

  const length = 16 + segCount * 8 + glyphIdArray.length * 2;
  const w = new Writer(length);
  w.u16(4);
  w.u16(length);
  w.u16(0); // language
  w.u16(segCount * 2);
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(segCount * 2 - searchRange);
  for (const e of entries) w.u16(e.end);
  w.u16(0); // reservedPad
  for (const e of entries) w.u16(e.start);
  for (const e of entries) w.i16(e.delta > 0x7fff ? e.delta - 0x10000 : e.delta);
  for (const o of idRangeOffset) w.u16(o);
  for (const g of glyphIdArray) w.u16(g);
  return w.finish();
}

function buildFormat12(pairs: Array<[number, number]>): Uint8Array {
  // Groups need codepoints AND glyph ids to be contiguous.
  const groups: Array<{ start: number; end: number; gid: number }> = [];
  for (const [cp, gid] of pairs) {
    const last = groups[groups.length - 1];
    if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) {
      last.end = cp;
    } else {
      groups.push({ start: cp, end: cp, gid });
    }
  }
  const length = 16 + groups.length * 12;
  const w = new Writer(length);
  w.u16(12);
  w.u16(0); // reserved
  w.u32(length);
  w.u32(0); // language
  w.u32(groups.length);
  for (const g of groups) {
    w.u32(g.start);
    w.u32(g.end);
    w.u32(g.gid);
  }
  return w.finish();
}

/**
 * Builds a `cmap` table from a codepoint -> glyph mapping.
 *
 * Emits a (3,1) format 4 subtable always, plus a (3,10) format 12 subtable
 * when the mapping includes astral codepoints. Unicode platform records
 * point at the same subtable data so both lookup conventions work.
 */
export function buildCmap(mapping: Map<number, number>): Uint8Array {
  const pairs = [...mapping.entries()]
    .filter(([cp, gid]) => cp >= 0 && cp <= 0x10ffff && gid > 0)
    .sort((a, b) => a[0] - b[0]);
  if (pairs.length === 0) {
    throw new FontFormatError('refusing to build an empty cmap');
  }
  const hasAstral = pairs.some(([cp]) => cp > 0xffff);

  const fmt4 = buildFormat4(pairs);
  const fmt12 = hasAstral ? buildFormat12(pairs) : undefined;

  const records: Array<{ platformID: number; encodingID: number; sub: 0 | 1 }> = [
    { platformID: 0, encodingID: 3, sub: 0 },
    { platformID: 3, encodingID: 1, sub: 0 },
  ];
  if (fmt12) {
    records.push({ platformID: 0, encodingID: 4, sub: 1 });
    records.push({ platformID: 3, encodingID: 10, sub: 1 });
  }
  // Encoding records must be sorted by platform then encoding.
  records.sort((a, b) => a.platformID - b.platformID || a.encodingID - b.encodingID);

  const headerSize = 4 + records.length * 8;
  const off0 = headerSize;
  const off1 = headerSize + fmt4.length;

  const w = new Writer(headerSize + fmt4.length + (fmt12?.length ?? 0));
  w.u16(0); // version
  w.u16(records.length);
  for (const rec of records) {
    w.u16(rec.platformID);
    w.u16(rec.encodingID);
    w.u32(rec.sub === 0 ? off0 : off1);
  }
  w.raw(fmt4);
  if (fmt12) w.raw(fmt12);
  return w.finish();
}
