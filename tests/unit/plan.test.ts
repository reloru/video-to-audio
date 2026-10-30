import { describe, expect, it } from "vitest";
import { codecLabel, defaultAudioStream, mp3SampleRate, planConversion, sourceDepth } from "../../src/lib/plan";
import { DEFAULT_SETTINGS, type AudioStream, type ProbeInfo } from "../../src/lib/types";

function audio(overrides: Partial<AudioStream>): AudioStream {
  return {
    index: 1,
    type: "audio",
    codec: "aac",
    codecTag: "mp4a",
    profile: "LC",
    decodable: true,
    bitRate: 128000,
    duration: 10,
    default: true,
    language: null,
    sampleRate: 44100,
    channels: 2,
    channelLayout: "stereo",
    bitsPerRawSample: 0,
    bitsPerCodedSample: 16,
    durationSamples: 441000,
    ...overrides,
  };
}

function info(streams: AudioStream[], format = "mov,mp4,m4a,3gp,3g2,mj2"): ProbeInfo {
  return { format, duration: 10, startTime: 0, bitRate: 0, streams };
}

describe("mp3SampleRate", () => {
  it.each([
    [44100, 44100],
    [48000, 48000],
    [32000, 32000],
    [8000, 48000],
    [16000, 48000],
    [24000, 48000],
    [12000, 48000],
    [11025, 44100],
    [22050, 44100],
    [88200, 44100],
    [96000, 48000],
    [192000, 48000],
  ])("%i Hz -> %i Hz", (input, expected) => expect(mp3SampleRate(input)).toBe(expected));
});

describe("sourceDepth", () => {
  it.each([
    ["pcm_s16le", 0, 16],
    ["pcm_s16be", 0, 16],
    ["pcm_s24le", 0, 24],
    ["pcm_s32le", 0, 32],
    ["pcm_f32le", 0, "f32"],
    ["pcm_u8", 0, 16],
    ["pcm_mulaw", 0, 16],
    ["alac", 24, 24],
    ["flac", 16, 16],
    ["alac", 0, 24],
    ["aac", 0, null],
    ["opus", 0, null],
  ] as const)("%s (raw bits %i) -> %s", (codec, bits, expected) => {
    expect(sourceDepth(audio({ codec, bitsPerRawSample: bits }))).toBe(expected);
  });
});

describe("planConversion", () => {
  const aac = audio({});

  it("copies AAC into M4A", () => {
    const plan = planConversion(info([aac]), aac, "m4a", DEFAULT_SETTINGS);
    expect(plan.kind).toBe("copy");
    expect(plan.args).toContain("copy");
    expect(plan.args).not.toContain("-af");
  });

  it("trims decode paths to the container's declared length only for QuickTime/MP4 inputs", () => {
    expect(planConversion(info([aac]), aac, "wav", DEFAULT_SETTINGS).args).toContain("atrim=end_sample=441000");
    expect(planConversion(info([aac], "matroska,webm"), aac, "wav", DEFAULT_SETTINGS).args).not.toContain("-af");
  });

  it("defaults WAV to 24-bit for lossy sources and native depth for lossless ones", () => {
    expect(planConversion(info([aac]), aac, "wav", DEFAULT_SETTINGS).args).toContain("pcm_s24le");
    const pcm16 = audio({ codec: "pcm_s16be" });
    const plan = planConversion(info([pcm16]), pcm16, "wav", DEFAULT_SETTINGS);
    expect(plan.args).toContain("pcm_s16le");
    expect(plan.kind).toBe("lossless");
  });

  it("dithers only when reducing to 16-bit", () => {
    const sixteen = { ...DEFAULT_SETTINGS, wavDepth: "16" as const };
    expect(planConversion(info([aac]), aac, "wav", sixteen).args.join(" ")).toContain("dither_method=triangular");
    const pcm16 = audio({ codec: "pcm_s16le" });
    expect(planConversion(info([pcm16]), pcm16, "wav", sixteen).args.join(" ")).not.toContain("dither");
  });

  it("marks a lossless source reduced in depth as not lossless", () => {
    const pcm24 = audio({ codec: "pcm_s24le" });
    const plan = planConversion(info([pcm24]), pcm24, "wav", { ...DEFAULT_SETTINGS, wavDepth: "16" });
    expect(plan.kind).toBe("decode");
  });

  it("copies MP3 audio into MP3 and encodes everything else", () => {
    const mp3 = audio({ codec: "mp3" });
    expect(planConversion(info([mp3]), mp3, "mp3", DEFAULT_SETTINGS).kind).toBe("copy");
    const plan = planConversion(info([aac]), aac, "mp3", DEFAULT_SETTINGS);
    expect(plan.kind).toBe("encode");
    expect(plan.args).toEqual(expect.arrayContaining(["libmp3lame", "-b:a", "320k", "-id3v2_version", "0"]));
  });

  it("downmixes more than two channels for MP3", () => {
    const surround = audio({ channels: 6, channelLayout: "5.1" });
    const plan = planConversion(info([surround]), surround, "mp3", DEFAULT_SETTINGS);
    expect(plan.args).toEqual(expect.arrayContaining(["-ac", "2"]));
    expect(plan.notes.join(" ")).toContain("5.1 → stereo");
  });
});

describe("defaultAudioStream", () => {
  it("prefers the default-flagged track and skips ones that cannot be decoded", () => {
    const a = audio({ index: 1, default: false });
    const b = audio({ index: 2, default: true, decodable: false, codec: "apac" });
    const c = audio({ index: 3, default: false });
    expect(defaultAudioStream(info([a, b, c]))?.index).toBe(1);
    expect(defaultAudioStream(info([a, { ...c, default: true }]))?.index).toBe(3);
  });
});

describe("codecLabel", () => {
  it("names common codecs the way people know them", () => {
    expect(codecLabel({ codec: "aac", profile: "LC", codecTag: "mp4a" })).toBe("AAC");
    expect(codecLabel({ codec: "aac", profile: "HE-AAC", codecTag: "mp4a" })).toBe("HE-AAC");
    expect(codecLabel({ codec: "pcm_s24le", profile: null, codecTag: "in24" })).toBe("PCM 24-bit");
    expect(codecLabel({ codec: null, profile: null, codecTag: "apac" })).toBe("“apac”");
  });
});
