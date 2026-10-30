import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { audioStreams, defaultAudioStream } from "../../src/lib/plan";
import {
  allBoxTypes,
  asFloat32,
  asInt32,
  containsText,
  decode,
  editList,
  ffprobe,
  findBox,
  maxAbsDiff,
  parseBoxes,
  parseMp3,
  parseWav,
  requireNativeFFmpeg,
  snrDb,
  writeTemp,
} from "../helpers/inspect";
import { convertFixture, FIXTURES, probeFixture } from "../helpers/wasm";

const fixture = (name: string) => resolve(FIXTURES, name);
/** Strings planted in fixture metadata, or stamped by encoders, that must never reach an output. */
const FORBIDDEN_TEXT = ["Secret title", "Someone", "Core Media Audio", "2026-10-30", "+29.9500", "Lavf", "Lavc"];

/**
 * Everything in an M4A except the audio payload. A copied AAC stream legitimately keeps whatever
 * its encoder wrote inside the frames (FFmpeg's AAC encoder embeds "Lavc"), so only the
 * container is checked for leaked metadata.
 */
function containerBytes(m4a: Uint8Array): Uint8Array {
  const kept = parseBoxes(m4a).filter((b) => b.type !== "mdat");
  return Buffer.concat(kept.map((b) => m4a.subarray(b.offset, b.offset + b.size)));
}

const AAC_FIXTURES = [
  "hevc-aac.mov",
  "hevc-hdr10-aac.mp4",
  "h264-aac.m4v",
  "h264-aac-8k-mono.mp4",
  "h264-aac-51.mp4",
  "h264-aac.ts",
  "h264-two-audio.mp4",
];

/** Native decode of a fixture's audio, trimmed the same way the plan trims decode paths. */
function referenceDecode(name: string, streamIndex: number, endSample: number | null | undefined, format: "s32le" | "f32le") {
  return decode(fixture(name), {
    stream: `0:${streamIndex}`,
    format,
    filter: endSample && !name.endsWith(".ts") && !name.endsWith(".mkv") ? `atrim=end_sample=${endSample}` : undefined,
  });
}

beforeAll(() => requireNativeFFmpeg());

describe("probe", () => {
  it("describes an iPhone-style HEVC screen recording", async () => {
    const info = await probeFixture("hevc-aac.mov");
    expect(info.format).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    const video = info.streams.find((s) => s.type === "video");
    expect(video).toMatchObject({ codec: "hevc", codecTag: "hvc1", width: 64, height: 128 });
    const audio = defaultAudioStream(info);
    expect(audio).toMatchObject({ codec: "aac", profile: "LC", sampleRate: 44100, channels: 2, durationSamples: 88200 });
  });

  it("reports HDR10 signalling on the video track", async () => {
    const info = await probeFixture("hevc-hdr10-aac.mp4");
    const video = info.streams.find((s) => s.type === "video");
    expect(video).toMatchObject({ codec: "hevc", colorTransfer: "smpte2084", colorPrimaries: "bt2020" });
    expect(defaultAudioStream(info)?.index).toBe(0);
  });

  it.each(["h264-noaudio.mp4", "hevc-noaudio.mov"])("finds no audio in %s", async (name) => {
    const info = await probeFixture(name);
    expect(audioStreams(info)).toEqual([]);
    expect(defaultAudioStream(info)).toBeNull();
  });

  it("picks the default-flagged track when there are several", async () => {
    const info = await probeFixture("h264-two-audio.mp4");
    expect(audioStreams(info).map((s) => s.index)).toEqual([1, 2]);
    expect(defaultAudioStream(info)).toMatchObject({ index: 2, language: "eng", sampleRate: 48000 });
  });

  it("ignores timecode/data tracks", async () => {
    const info = await probeFixture("h264-pcm24.mov");
    expect(info.streams.map((s) => s.type)).toEqual(["video", "audio", "data"]);
    expect(defaultAudioStream(info)).toMatchObject({ codec: "pcm_s24le", sampleRate: 48000 });
  });
});

describe("M4A", () => {
  it.each(AAC_FIXTURES)("copies the AAC audio of %s without re-encoding", async (name) => {
    const out = await convertFixture(name, "m4a");
    expect(out.plan.kind).toBe("copy");
    const path = writeTemp(out.output, "m4a");

    // Decoding the output yields exactly the samples the source decodes to. This covers
    // the packets themselves and the edit list that removes encoder priming.
    const src = decode(fixture(name), { stream: `0:${out.stream.index}`, format: "f32le" });
    const dst = decode(path, { format: "f32le" });
    expect(dst.equals(src)).toBe(true);

    const probed = ffprobe(path);
    expect(probed.streams).toHaveLength(1);
    expect(probed.streams[0]).toMatchObject({ codec_name: "aac", channels: out.stream.channels });
    expect(Number(probed.streams[0].sample_rate)).toBe(out.stream.sampleRate);
    expect(probed.format.tags?.major_brand).toBe("M4A ");
  });

  it("writes a minimal M4A: no udta/meta/ilst, moov before mdat, edit list kept", async () => {
    const out = await convertFixture("hevc-aac.mov", "m4a");
    const boxes = parseBoxes(out.output);
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "moov", "free", "mdat"]);
    const types = allBoxTypes(boxes);
    for (const t of ["udta", "meta", "ilst", "keys", "©too", "uuid"]) expect(types).not.toContain(t);
    expect(boxes.find((b) => b.type === "moov")?.children.filter((b) => b.type === "trak")).toHaveLength(1);
    const elst = findBox(boxes, "moov/trak/edts/elst");
    expect(elst).toBeDefined();
    // 2 s at the 1 kHz movie timescale, starting after 1024 samples of encoder priming.
    expect(editList(elst!)).toEqual([[2000, 1024]]);
    for (const text of FORBIDDEN_TEXT) expect(containsText(containerBytes(out.output), text)).toBe(false);
  });

  it("drops udta/auth-style metadata from mp42 sources with audio as track 1", async () => {
    const out = await convertFixture("hevc-hdr10-aac.mp4", "m4a");
    const types = allBoxTypes(parseBoxes(out.output));
    expect(types).not.toContain("udta");
    for (const text of FORBIDDEN_TEXT) expect(containsText(containerBytes(out.output), text)).toBe(false);
  });

  it("converts the ADTS AAC of an MPEG-TS file into a playable M4A", async () => {
    const out = await convertFixture("h264-aac.ts", "m4a");
    const stsd = findBox(parseBoxes(out.output), "moov/trak/mdia/minf/stbl/stsd");
    expect(containsText(stsd!.payload, "esds")).toBe(true);
  });

  it.each([
    ["h264-pcm24.mov", 24],
    ["h264-pcm16be.mov", 16],
  ])("stores PCM from %s as Apple Lossless at %i-bit, sample-exact", async (name, bits) => {
    const out = await convertFixture(name, "m4a");
    expect(out.plan.kind).toBe("lossless");
    const path = writeTemp(out.output, "m4a");
    const probed = ffprobe(path).streams[0];
    expect(probed.codec_name).toBe("alac");
    expect(Number(probed.bits_per_raw_sample)).toBe(bits);
    const src = referenceDecode(name, out.stream.index, out.stream.durationSamples, "s32le");
    expect(decode(path).equals(src)).toBe(true);
  });

  it("stores Opus as 24-bit Apple Lossless, matching a native decode", async () => {
    const out = await convertFixture("h264-opus.mkv", "m4a");
    expect(out.plan.kind).toBe("decode");
    const path = writeTemp(out.output, "m4a");
    expect(ffprobe(path).streams[0].codec_name).toBe("alac");
    const src = asInt32(referenceDecode("h264-opus.mkv", out.stream.index, null, "s32le"));
    const dst = asInt32(decode(path));
    // Float rounding between FFmpeg builds stays within a few 24-bit steps (~-130 dBFS).
    expect(maxAbsDiff(src.map((x) => x >> 8), dst.map((x) => x >> 8))).toBeLessThanOrEqual(4);
  });
});

describe("WAV", () => {
  it.each(AAC_FIXTURES.filter((n) => !n.endsWith(".ts")))("decodes %s to 24-bit PCM with only fmt and data chunks", async (name) => {
    const out = await convertFixture(name, "wav");
    expect(out.plan.kind).toBe("decode");
    const wav = parseWav(out.output);
    expect(wav.chunks).toEqual(["fmt ", "data"]);
    expect(wav.riffSizeOk).toBe(true);
    expect(wav.bitsPerSample).toBe(24);
    expect(wav.sampleRate).toBe(out.stream.sampleRate);
    expect(wav.channels).toBe(out.stream.channels);
    // Exactly the length the container declares: priming and trailing encoder padding removed.
    expect(wav.dataBytes / (3 * wav.channels)).toBe(out.stream.durationSamples);

    const src = asInt32(referenceDecode(name, out.stream.index, out.stream.durationSamples, "s32le"));
    const dst = asInt32(decode(writeTemp(out.output, "wav")));
    expect(maxAbsDiff(src.map((x) => x >> 8), dst.map((x) => x >> 8))).toBeLessThanOrEqual(4);
    for (const text of FORBIDDEN_TEXT) expect(containsText(out.output, text)).toBe(false);
  });

  it("keeps the 5.1 channel layout", async () => {
    const out = await convertFixture("h264-aac-51.mp4", "wav");
    const wav = parseWav(out.output);
    expect(wav.formatTag).toBe(0xfffe);
    expect(wav.channels).toBe(6);
    expect(wav.channelMask).toBe(0x3f);
  });

  it.each([
    ["h264-pcm24.mov", 24],
    ["h264-pcm16be.mov", 16],
  ])("rewraps PCM from %s losslessly at its native %i-bit", async (name, bits) => {
    const out = await convertFixture(name, "wav");
    expect(out.plan.kind).toBe("lossless");
    expect(parseWav(out.output).bitsPerSample).toBe(bits);
    const src = referenceDecode(name, out.stream.index, out.stream.durationSamples, "s32le");
    expect(decode(writeTemp(out.output, "wav")).equals(src)).toBe(true);
  });

  it("writes plain 16-bit PCM with TPDF dither when asked", async () => {
    const out = await convertFixture("hevc-aac.mov", "wav", { wavDepth: "16" });
    const wav = parseWav(out.output);
    expect(wav).toMatchObject({ formatTag: 1, bitsPerSample: 16, chunks: ["fmt ", "data"] });
    expect(out.plan.args.join(" ")).toContain("dither_method=triangular");
    // AAC decoding overshoots full scale on this fixture's abrupt start; integer PCM clips there.
    const src = asFloat32(referenceDecode("hevc-aac.mov", 1, 88200, "f32le")).map((x) => Math.max(-1, Math.min(32767 / 32768, x)));
    const dst = asFloat32(decode(writeTemp(out.output, "wav"), { format: "f32le" }));
    // Rounding plus +/-1 LSB of triangular dither.
    expect(maxAbsDiff(src, dst) * 32768).toBeLessThanOrEqual(2.5);
  });

  it("writes 32-bit float that matches the decoder output, peaks above 0 dBFS included", async () => {
    const out = await convertFixture("hevc-aac.mov", "wav", { wavDepth: "32f" });
    const wav = parseWav(out.output);
    expect(wav.bitsPerSample).toBe(32);
    expect(wav.formatTag === 3 || wav.subFormatTag === 3).toBe(true);
    const src = asFloat32(referenceDecode("hevc-aac.mov", 1, 88200, "f32le"));
    const dst = asFloat32(decode(writeTemp(out.output, "wav"), { format: "f32le" }));
    expect(dst.reduce((m, x) => Math.max(m, Math.abs(x)), 0)).toBeGreaterThan(1);
    expect(maxAbsDiff(src, dst)).toBeLessThan(1e-5);
  });
});

describe("MP3", () => {
  it("encodes 320 kbps CBR with no ID3 tags and a LAME Info header for gapless playback", async () => {
    const out = await convertFixture("hevc-aac.mov", "mp3");
    expect(out.plan.kind).toBe("encode");
    const mp3 = parseMp3(out.output);
    expect(mp3).toMatchObject({ hasId3v2: false, hasId3v1: false, infoTag: "Info", lameVersion: "LAME3.100" });
    expect(mp3.encoderDelay).toBeGreaterThan(0);
    const path = writeTemp(out.output, "mp3");
    const probed = ffprobe(path);
    expect(probed.streams[0]).toMatchObject({ codec_name: "mp3", sample_rate: "44100", channels: 2, bit_rate: "320000" });
    expect(probed.format.tags ?? {}).toEqual({});

    // With the LAME header's delay/padding applied, the MP3 lines up sample-for-sample.
    const src = asFloat32(referenceDecode("hevc-aac.mov", 1, 88200, "f32le"));
    const dst = asFloat32(decode(path, { format: "f32le" }));
    expect(dst.length).toBe(src.length);
    expect(snrDb(src, dst)).toBeGreaterThan(30);
    for (const text of FORBIDDEN_TEXT) expect(containsText(out.output, text)).toBe(false);
  });

  it("uses VBR V0 when chosen", async () => {
    const out = await convertFixture("hevc-aac.mov", "mp3", { mp3Mode: "v0" });
    expect(parseMp3(out.output).infoTag).toBe("Xing");
  });

  it("resamples 8 kHz audio to 48 kHz and keeps it mono", async () => {
    const out = await convertFixture("h264-aac-8k-mono.mp4", "mp3");
    const probed = ffprobe(writeTemp(out.output, "mp3")).streams[0];
    expect(probed).toMatchObject({ sample_rate: "48000", channels: 1 });
    expect(out.plan.notes.join(" ")).toContain("8 kHz → 48 kHz");
  });

  it("downmixes 5.1 to stereo", async () => {
    const out = await convertFixture("h264-aac-51.mp4", "mp3");
    expect(ffprobe(writeTemp(out.output, "mp3")).streams[0]).toMatchObject({ channels: 2, sample_rate: "48000" });
  });

  it("converts a chosen non-default track", async () => {
    const out = await convertFixture("h264-two-audio.mp4", "mp3", {}, 1);
    expect(ffprobe(writeTemp(out.output, "mp3")).streams[0]).toMatchObject({ channels: 1, sample_rate: "44100" });
  });

  it("reports progress up to completion", async () => {
    const out = await convertFixture("hevc-aac.mov", "mp3");
    expect(out.progress.at(-1)).toBeCloseTo(1, 1);
  });
});
