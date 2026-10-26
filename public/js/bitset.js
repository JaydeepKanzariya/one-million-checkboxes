// 1,000,000-bit client bitset using Redis MSB-first bit layout:
// get(i) = (bits[i >> 3] >> (7 - (i & 7))) & 1

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let n = i;
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  POPCOUNT[i] = c;
}

export class BitSet {
  constructor(size = 1_000_000) {
    this.size = size;
    this.bytes = new Uint8Array(Math.ceil(size / 8));
    this.checkedCount = 0;
  }

  loadSnapshot(buffer) {
    const incoming = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.bytes.fill(0);
    this.bytes.set(incoming.subarray(0, this.bytes.length));
    this.checkedCount = this.recount();
    return this.checkedCount;
  }

  get(index) {
    if (index < 0 || index >= this.size) return 0;
    return (this.bytes[index >> 3] >> (7 - (index & 7))) & 1;
  }

  set(index, value) {
    if (index < 0 || index >= this.size) return false;
    const byteIdx = index >> 3;
    const mask = 1 << (7 - (index & 7));
    const current = (this.bytes[byteIdx] & mask) !== 0 ? 1 : 0;
    const bit = value ? 1 : 0;
    if (current === bit) return false;

    if (bit === 1) {
      this.bytes[byteIdx] |= mask;
      this.checkedCount++;
    } else {
      this.bytes[byteIdx] &= ~mask;
      if (this.checkedCount > 0) this.checkedCount--;
    }
    return true;
  }

  recount() {
    let total = 0;
    const arr = this.bytes;
    for (let i = 0; i < arr.length; i++) {
      total += POPCOUNT[arr[i]];
    }
    return total;
  }
}

