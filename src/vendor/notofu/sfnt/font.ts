// MIT: Ax1zz/notofu @ 123ebf7d53b194f16c477e73a50a67bea0b5c0fc; local import extension adaptation.
/**
 * SFNT container parsing: the table directory, plus the handful of small
 * tables the subsetter needs to read wholesale (head/hhea/maxp/hmtx/loca).
 */

import { Reader, Writer, FontFormatError, checksum } from './binary.ts';

export interface TableRecord {
  tag: string;
  checkSum: number;
  offset: number;
  length: number;
}

export interface HeadTable {
  unitsPerEm: number;
  indexToLocFormat: number;
  /** Byte offset of `checkSumAdjustment` within the head table. */
  checkSumAdjustmentOffset: number;
}

export interface HheaTable {
  numberOfHMetrics: number;
}

export interface LongHorMetric {
  advanceWidth: number;
  lsb: number;
}

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_TAG_TRUE = 'true';
const SFNT_TAG_OTTO = 'OTTO';
const SFNT_TAG_TTCF = 'ttcf';

/**
 * A parsed SFNT font. Table contents are exposed as zero-copy subarrays of
 * the original buffer; nothing is decoded until asked for.
 */
export class SfntFont {
  readonly data: Uint8Array;
  readonly sfntVersion: number;
  readonly tables: Map<string, TableRecord>;

  private _head?: HeadTable;
  private _hhea?: HheaTable;
  private _numGlyphs?: number;
  private _loca?: number[];

  private constructor(data: Uint8Array, sfntVersion: number, tables: Map<string, TableRecord>) {
    this.data = data;
    this.sfntVersion = sfntVersion;
    this.tables = tables;
  }

  static parse(input: Uint8Array | ArrayBuffer): SfntFont {
    // Normalise to a *plain* Uint8Array view over the same memory.
    //
    // This matters more than it looks: Node's Buffer overrides `slice()` to
    // return a view rather than a copy (unlike Uint8Array). Without this,
    // every `table(...).slice()` below would alias the caller's buffer and
    // our table patches would corrupt their font in place. Re-wrapping costs
    // nothing (no bytes are copied) and restores standard semantics.
    const data =
      input instanceof Uint8Array
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
    if (data.length < 12) {
      throw new FontFormatError(`not a font: only ${data.length} bytes`);
    }
    const r = new Reader(data);
    const version = r.u32();
    const versionTag = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);

    if (versionTag === SFNT_TAG_TTCF) {
      throw new FontFormatError(
        'TrueType Collection (.ttc) files are not supported. Extract a single font first.',
      );
    }
    if (versionTag === SFNT_TAG_OTTO) {
      throw new FontFormatError(
        'This font uses CFF (PostScript) outlines, which notofu cannot subset yet. ' +
          'Use the TrueType-flavoured build of the font (a .ttf with `glyf` outlines) — ' +
          'for Noto CJK, that is the "Noto Sans SC/JP/KR" family on Google Fonts rather than the .otf release.',
      );
    }
    if (versionTag === 'wOFF' || versionTag === 'wOF2') {
      throw new FontFormatError(
        'WOFF/WOFF2 files are compressed web fonts. Decompress to .ttf before subsetting.',
      );
    }
    if (version !== SFNT_VERSION_TRUETYPE && versionTag !== SFNT_TAG_TRUE) {
      throw new FontFormatError(
        `unrecognised sfnt version 0x${version.toString(16).padStart(8, '0')}`,
      );
    }

    const numTables = r.u16();
    r.skip(6); // searchRange, entrySelector, rangeShift are derived; ignore them.
    if (numTables === 0 || numTables > 512) {
      throw new FontFormatError(`implausible table count: ${numTables}`);
    }

    const tables = new Map<string, TableRecord>();
    for (let i = 0; i < numTables; i++) {
      const tag = r.tag();
      const checkSum = r.u32();
      const offset = r.u32();
      const length = r.u32();
      if (offset > data.length) {
        throw new FontFormatError(`table "${tag}" starts past end of file (${offset})`);
      }
      // Some real-world fonts overstate the final table length by a byte or
      // three. Clamp rather than reject; the data we need is still there.
      const clamped = Math.min(length, data.length - offset);
      tables.set(tag, { tag, checkSum, offset, length: clamped });
    }
    return new SfntFont(data, version, tables);
  }

  has(tag: string): boolean {
    return this.tables.has(tag);
  }

  /** Returns a zero-copy view of a table, or undefined if absent. */
  table(tag: string): Uint8Array | undefined {
    const rec = this.tables.get(tag);
    if (!rec) return undefined;
    return this.data.subarray(rec.offset, rec.offset + rec.length);
  }

  /** Like {@link table} but throws a helpful error when the table is missing. */
  requireTable(tag: string): Uint8Array {
    const t = this.table(tag);
    if (!t) {
      throw new FontFormatError(`font is missing the required "${tag}" table`);
    }
    return t;
  }

  get head(): HeadTable {
    if (this._head) return this._head;
    const t = this.requireTable('head');
    if (t.length < 54) throw new FontFormatError('head table is truncated');
    const r = new Reader(t);
    r.seek(18);
    const unitsPerEm = r.u16();
    r.seek(50);
    const indexToLocFormat = r.i16();
    if (indexToLocFormat !== 0 && indexToLocFormat !== 1) {
      throw new FontFormatError(`invalid indexToLocFormat: ${indexToLocFormat}`);
    }
    if (unitsPerEm === 0) throw new FontFormatError('head.unitsPerEm is zero');
    this._head = { unitsPerEm, indexToLocFormat, checkSumAdjustmentOffset: 8 };
    return this._head;
  }

  get hhea(): HheaTable {
    if (this._hhea) return this._hhea;
    const t = this.requireTable('hhea');
    if (t.length < 36) throw new FontFormatError('hhea table is truncated');
    const r = new Reader(t);
    r.seek(34);
    this._hhea = { numberOfHMetrics: r.u16() };
    return this._hhea;
  }

  get numGlyphs(): number {
    if (this._numGlyphs !== undefined) return this._numGlyphs;
    const t = this.requireTable('maxp');
    if (t.length < 6) throw new FontFormatError('maxp table is truncated');
    this._numGlyphs = new Reader(t).seek(4).u16();
    return this._numGlyphs;
  }

  /**
   * Glyph offsets from `loca`, length numGlyphs+1. Offsets are absolute
   * positions within the `glyf` table.
   */
  get loca(): number[] {
    if (this._loca) return this._loca;
    const t = this.requireTable('loca');
    const n = this.numGlyphs;
    const short = this.head.indexToLocFormat === 0;
    const entrySize = short ? 2 : 4;
    const available = Math.floor(t.length / entrySize);
    if (available < n + 1) {
      throw new FontFormatError(
        `loca table holds ${available} offsets but the font declares ${n} glyphs`,
      );
    }
    const r = new Reader(t);
    const out = new Array<number>(n + 1);
    for (let i = 0; i <= n; i++) {
      out[i] = short ? r.u16() * 2 : r.u32();
    }
    this._loca = out;
    return out;
  }

  /**
   * Variation axes from `fvar`, if this is a variable font.
   *
   * Matters because subsetting keeps the *default instance* outlines: the
   * `glyf` table holds the default, and the `gvar` deltas that produce other
   * weights are dropped. Google's `NotoSansSC[wght].ttf`, for example,
   * defaults to wght=100 (Thin), so a naive subset silently produces Thin
   * text where the caller expected Regular.
   */
  variationAxes(): Array<{ tag: string; min: number; default: number; max: number }> | undefined {
    const fvar = this.table('fvar');
    if (!fvar || fvar.length < 16) return undefined;
    const r = new Reader(fvar);
    r.skip(4); // version
    const axesOffset = r.u16();
    r.u16(); // axisCountReserved
    const axisCount = r.u16();
    const axisSize = r.u16();
    // Every defined version uses axisSize 20; anything smaller than the 16
    // bytes we read would make us walk into the next record.
    if (axisCount === 0 || axisCount > 64 || axisSize < 16) return undefined;

    const out: Array<{ tag: string; min: number; default: number; max: number }> = [];
    for (let i = 0; i < axisCount; i++) {
      const at = axesOffset + i * axisSize;
      if (at + 16 > fvar.length) break;
      const a = new Reader(fvar, at);
      const tag = a.tag();
      // Axis values are Fixed 16.16.
      const min = a.i32() / 65536;
      const def = a.i32() / 65536;
      const max = a.i32() / 65536;
      out.push({ tag, min, default: def, max });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Horizontal metrics for every glyph, expanded from the compressed hmtx form. */
  horizontalMetrics(): LongHorMetric[] {
    const t = this.requireTable('hmtx');
    const n = this.numGlyphs;
    const numH = Math.max(1, Math.min(this.hhea.numberOfHMetrics, n));
    const r = new Reader(t);
    const out = new Array<LongHorMetric>(n);
    let lastAdvance = 0;
    for (let i = 0; i < numH; i++) {
      if (r.pos + 4 > t.length) break;
      const advanceWidth = r.u16();
      const lsb = r.i16();
      lastAdvance = advanceWidth;
      out[i] = { advanceWidth, lsb };
    }
    // Monospaced tails: remaining glyphs reuse the final advance width and
    // carry only their own left side bearing.
    for (let i = numH; i < n; i++) {
      let lsb = 0;
      if (r.pos + 2 <= t.length) lsb = r.i16();
      out[i] = { advanceWidth: lastAdvance, lsb };
    }
    for (let i = 0; i < n; i++) {
      if (!out[i]) out[i] = { advanceWidth: lastAdvance, lsb: 0 };
    }
    return out;
  }
}

/**
 * Assembles a complete SFNT file from a set of tables, computing the table
 * directory, per-table checksums and `head.checkSumAdjustment`.
 */
export function buildSfnt(sfntVersion: number, tables: Map<string, Uint8Array>): Uint8Array {
  // The spec requires directory entries sorted by tag.
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;
  if (numTables === 0) throw new FontFormatError('cannot build a font with zero tables');

  const headerSize = 12 + numTables * 16;
  let offset = headerSize;
  const layout: Array<{ tag: string; data: Uint8Array; offset: number; length: number }> = [];
  for (const tag of tags) {
    const data = tables.get(tag)!;
    layout.push({ tag, data, offset, length: data.length });
    offset += data.length;
    // Tables must start on 4-byte boundaries.
    offset += (4 - (offset % 4)) % 4;
  }
  const total = offset;

  const out = new Uint8Array(total);
  const w = new Writer(headerSize);

  // searchRange / entrySelector / rangeShift are formally derived values.
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  w.u32(sfntVersion);
  w.u16(numTables);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(numTables * 16 - searchRange);

  for (const t of layout) {
    w.tag(t.tag);
    w.u32(checksum(t.data));
    w.u32(t.offset);
    w.u32(t.length);
  }
  out.set(w.finish(), 0);
  for (const t of layout) out.set(t.data, t.offset);

  // head.checkSumAdjustment must be zero while the whole-file sum is taken,
  // then set so the file sums to the magic constant.
  const headEntry = layout.find((t) => t.tag === 'head');
  if (headEntry) {
    const adjPos = headEntry.offset + 8;
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(adjPos, 0, false);
    const fileSum = checksum(out);
    view.setUint32(adjPos, (0xb1b0afba - fileSum) >>> 0, false);
  }
  return out;
}
