import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Native ffmpeg is the independent reference the wasm output is checked against. */
export function requireNativeFFmpeg(): void {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-hide_banner", "-version"], { stdio: "ignore" });
  } catch {
    throw new Error("These tests need native ffmpeg and ffprobe on PATH (apt-get install ffmpeg).");
  }
}

const scratch = mkdtempSync(join(tmpdir(), "vta-test-"));
let counter = 0;

export function writeTemp(data: Uint8Array, ext: string): string {
  const path = join(scratch, `out-${counter++}.${ext}`);
  writeFileSync(path, data);
  return path;
}

export function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 1 << 30 });
}

/** Decodes one audio stream with native ffmpeg to raw interleaved samples. */
export function decode(path: string, opts: { stream?: string; format?: "s16le" | "s32le" | "f32le"; filter?: string } = {}): Buffer {
  return ffmpeg([
    "-i",
    path,
    "-map",
    opts.stream ?? "0:a:0",
    ...(opts.filter ? ["-af", opts.filter] : []),
    "-f",
    opts.format ?? "s32le",
    "-",
  ]);
}

export interface ProbedStream {
  codec_name: string;
  codec_type: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bits_per_sample?: number;
  bits_per_raw_sample?: string;
  sample_fmt?: string;
  bit_rate?: string;
  duration_ts?: number;
  tags?: Record<string, string>;
}

export function ffprobe(path: string): { streams: ProbedStream[]; format: { tags?: Record<string, string>; duration?: string } } {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  return JSON.parse(out.toString());
}

export function maxAbsDiff(a: Int32Array | Float32Array, b: Int32Array | Float32Array): number {
  if (a.length !== b.length) throw new Error(`length mismatch: ${a.length} vs ${b.length}`);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

export const asInt32 = (b: Buffer) => new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4);
export const asFloat32 = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

/** Signal-to-noise ratio of `test` against `ref`, in dB. */
export function snrDb(ref: Float32Array, test: Float32Array): number {
  const n = Math.min(ref.length, test.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < n; i++) {
    signal += ref[i] * ref[i];
    noise += (ref[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(signal / noise);
}

// --- ISO BMFF (MP4/M4A) -----------------------------------------------------

export interface Box {
  type: string;
  size: number;
  offset: number;
  children: Box[];
  payload: Uint8Array;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "dinf", "meta", "ilst"]);

export function parseBoxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = String.fromCharCode(...data.subarray(off + 4, off + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    const payload = data.subarray(off + header, off + size);
    const childStart = off + header + (type === "meta" ? 4 : 0);
    const children = CONTAINERS.has(type) ? parseBoxes(data, childStart, off + size) : [];
    boxes.push({ type, size, offset: off, children, payload });
    off += size;
  }
  return boxes;
}

export function allBoxTypes(boxes: Box[]): string[] {
  return boxes.flatMap((b) => [b.type, ...allBoxTypes(b.children)]);
}

export function findBox(boxes: Box[], path: string): Box | undefined {
  const [head, ...rest] = path.split("/");
  const box = boxes.find((b) => b.type === head);
  return box && rest.length ? findBox(box.children, rest.join("/")) : box;
}

/** Edit list entries as [segmentDuration, mediaTime]. */
export function editList(box: Box): [number, number][] {
  const v = new DataView(box.payload.buffer, box.payload.byteOffset, box.payload.byteLength);
  const version = v.getUint8(0);
  const count = v.getUint32(4);
  const entries: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      const o = 8 + i * 20;
      entries.push([Number(v.getBigUint64(o)), Number(v.getBigInt64(o + 8))]);
    } else {
      const o = 8 + i * 12;
      entries.push([v.getUint32(o), v.getInt32(o + 4)]);
    }
  }
  return entries;
}

// --- WAV ----------------------------------------------------------------------

export interface WavInfo {
  chunks: string[];
  formatTag: number;
  subFormatTag: number | null;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  channelMask: number | null;
  dataBytes: number;
  riffSizeOk: boolean;
}

export function parseWav(data: Uint8Array): WavInfo {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number) => String.fromCharCode(...data.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  const chunks: string[] = [];
  let fmt: DataView | null = null;
  let dataBytes = 0;
  let off = 12;
  while (off + 8 <= data.length) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    chunks.push(id);
    if (id === "fmt ") fmt = new DataView(data.buffer, data.byteOffset + off + 8, size);
    if (id === "data") dataBytes = size;
    off += 8 + size + (size & 1);
  }
  if (!fmt) throw new Error("no fmt chunk");
  const formatTag = fmt.getUint16(0, true);
  const extensible = formatTag === 0xfffe;
  return {
    chunks,
    formatTag,
    subFormatTag: extensible ? fmt.getUint16(24, true) : null,
    channels: fmt.getUint16(2, true),
    sampleRate: fmt.getUint32(4, true),
    bitsPerSample: fmt.getUint16(14, true),
    channelMask: extensible ? fmt.getUint32(20, true) : null,
    dataBytes,
    riffSizeOk: v.getUint32(4, true) === data.length - 8,
  };
}

// --- MP3 ----------------------------------------------------------------------

export interface Mp3Info {
  hasId3v2: boolean;
  hasId3v1: boolean;
  infoTag: "Info" | "Xing" | null;
  lameVersion: string | null;
  encoderDelay: number | null;
  encoderPadding: number | null;
}

export function parseMp3(data: Uint8Array): Mp3Info {
  const text = (o: number, n: number) => String.fromCharCode(...data.subarray(o, o + n));
  const hasId3v2 = text(0, 3) === "ID3";
  const hasId3v1 = data.length > 128 && text(data.length - 128, 3) === "TAG";
  // The Info/Xing header sits inside the first frame, after the side information.
  let infoTag: Mp3Info["infoTag"] = null;
  let at = -1;
  for (let o = 4; o < 64; o++) {
    const t = text(o, 4);
    if (t === "Info" || t === "Xing") {
      infoTag = t;
      at = o;
      break;
    }
  }
  let lameVersion: string | null = null;
  let encoderDelay: number | null = null;
  let encoderPadding: number | null = null;
  if (at >= 0) {
    const flags = data[at + 7];
    let o = at + 8;
    if (flags & 1) o += 4; // frames
    if (flags & 2) o += 4; // bytes
    if (flags & 4) o += 100; // TOC
    if (flags & 8) o += 4; // quality
    lameVersion = text(o, 9).replace(/\0+$/, "");
    const d = (data[o + 21] << 16) | (data[o + 22] << 8) | data[o + 23];
    encoderDelay = d >> 12;
    encoderPadding = d & 0xfff;
  }
  return { hasId3v2, hasId3v1, infoTag, lameVersion, encoderDelay, encoderPadding };
}

/** Finds an ASCII string anywhere in the bytes (used to prove metadata was not carried over). */
export function containsText(data: Uint8Array, needle: string): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(Buffer.from(needle, "latin1"));
}
