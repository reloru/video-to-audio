import { describe, expect, it } from "vitest";
import { createReadAhead, MAX_BLOCK, MIN_BLOCK, READ_THROUGH } from "../../src/engine/readahead";

function source(size: number) {
  const data = new Uint8Array(size).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
  const calls: [number, number][] = [];
  const read = createReadAhead(size, (start, end) => {
    calls.push([start, end]);
    return data.slice(start, end).buffer;
  });
  return { data, calls, read };
}

describe("createReadAhead", () => {
  it("returns exactly the requested bytes for arbitrary reads", () => {
    const { data, read } = source(3_000_000);
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 2000; i++) {
      const position = rand(data.length);
      const length = 1 + rand(70_000);
      const out = new Uint8Array(length + 3);
      const n = read(out, 3, length, position);
      expect(n).toBe(Math.min(length, data.length - position));
      expect(Buffer.compare(out.subarray(3, 3 + n), data.subarray(position, position + n))).toBe(0);
    }
  });

  it("turns a sequential 32 KB scan into a few large reads", () => {
    const size = 100 * 1024 * 1024;
    const { calls, read } = source(size);
    const buffer = new Uint8Array(32768);
    for (let p = 0; p < size; p += 32768) read(buffer, 0, 32768, p);
    expect(calls.length).toBeLessThan(25);
    expect(Math.max(...calls.map(([s, e]) => e - s))).toBe(MAX_BLOCK);
  });

  it("streams through short gaps, as when hopping over interleaved video frames", () => {
    const size = 100 * 1024 * 1024;
    const { calls, read } = source(size);
    const buffer = new Uint8Array(16384);
    for (let p = 0; p < size - 16384; p += 200_000) read(buffer, 0, 16384, p);
    expect(calls.length).toBeLessThan(25);
  });

  it("keeps widely scattered reads small", () => {
    const { calls, read } = source(200_000_000);
    const buffer = new Uint8Array(16384);
    for (let p = 0; p < 190_000_000; p += 2 * READ_THROUGH) read(buffer, 0, 16384, p);
    expect(calls.every(([s, e]) => e - s === MIN_BLOCK)).toBe(true);
  });

  it("reports end of file", () => {
    const { read } = source(1000);
    expect(read(new Uint8Array(10), 0, 10, 1000)).toBe(0);
    expect(read(new Uint8Array(10), 0, 10, 995)).toBe(5);
  });
});
