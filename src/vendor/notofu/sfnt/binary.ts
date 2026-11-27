// MIT: Ax1zz/notofu @ 123ebf7d53b194f16c477e73a50a67bea0b5c0fc; local import extension adaptation.
/**
 * Minimal big-endian binary reader/writer for SFNT (TrueType/OpenType) data.
 *
 * Everything in a font file is big-endian. These helpers exist so the table
 * code can stay readable and so bounds violations produce useful errors
 * instead of silently returning NaN.
 */

/** Thrown when font data is malformed or truncated. */
export class FontFormatError extends Error {
  override readonly name = 'FontFormatError';
  constructor(message: string) {
    super(message);
  }
}

export class Reader {
  readonly data: Uint8Array;
  private readonly view: DataView;
  /** Current cursor position, in bytes from the start of `data`. */
  pos: number;

  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.data.length;
  }

  private need(n: number): number {
    const at = this.pos;
    if (at < 0 || at + n > this.data.length) {
      throw new FontFormatError(
        `read out of bounds: wanted ${n} byte(s) at offset ${at}, buffer is ${this.data.length} bytes`,
      );
    }
    this.pos = at + n;
    return at;
  }

  seek(pos: number): this {
    if (pos < 0 || pos > this.data.length) {
      throw new FontFormatError(`seek out of bounds: ${pos} (buffer is ${this.data.length} bytes)`);
    }
    this.pos = pos;
    return this;
  }

  skip(n: number): this {
    return this.seek(this.pos + n);
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  i8(): number {
    return this.view.getInt8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), false);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), false);
  }
  u32(): number {
    return this.view.getUint32(this.need(4), false);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), false);
  }

  /** Reads a 4-byte ASCII table tag such as `glyf`. */
  tag(): string {
    const at = this.need(4);
    return String.fromCharCode(
      this.data[at]!,
      this.data[at + 1]!,
      this.data[at + 2]!,
      this.data[at + 3]!,
    );
  }

  /** Returns a view (not a copy) of `n` bytes at the cursor. */
  bytes(n: number): Uint8Array {
    const at = this.need(n);
    return this.data.subarray(at, at + n);
  }

  /** Peeks a uint16 without moving the cursor. */
  peekU16(at: number): number {
    if (at < 0 || at + 2 > this.data.length) {
      throw new FontFormatError(`peek out of bounds at ${at}`);
    }
    return this.view.getUint16(at, false);
  }
}

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.len, v & 0xff);
    this.len += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.len, v & 0xffff, false);
    this.len += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    // Clamp into int16 range the same way the spec expects wrapped values.
    this.view.setInt16(this.len, ((v << 16) >> 16), false);
    this.len += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, false);
    this.len += 4;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, v | 0, false);
    this.len += 4;
    return this;
  }

  tag(t: string): this {
    if (t.length !== 4) throw new FontFormatError(`table tag must be 4 chars, got "${t}"`);
    for (let i = 0; i < 4; i++) this.u8(t.charCodeAt(i));
    return this;
  }

  raw(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Zero-pads until the length is a multiple of `align`. */
  pad(align = 4): this {
    while (this.len % align !== 0) this.u8(0);
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Returns an independent copy of `src`.
 *
 * Deliberately does not use `.slice()`: Node's Buffer overrides that method
 * to return a *view* rather than a copy, which would let table patches leak
 * back into the caller's font data.
 */
export function copyOf(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

/**
 * SFNT table checksum: sum of big-endian uint32 words, with the table
 * zero-padded to a 4-byte boundary, truncated to 32 bits.
 */
export function checksum(data: Uint8Array): number {
  let sum = 0;
  const full = data.length & ~3;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < full; i += 4) {
    sum = (sum + view.getUint32(i, false)) >>> 0;
  }
  // Trailing 1-3 bytes behave as if padded with zeros.
  if (full !== data.length) {
    let tail = 0;
    for (let i = full; i < data.length; i++) {
      tail = (tail | (data[i]! << (8 * (3 - (i - full))))) >>> 0;
    }
    sum = (sum + tail) >>> 0;
  }
  return sum >>> 0;
}
