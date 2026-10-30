import type { AudioStream, OutputFormat, ProbeInfo, ProbeStream, Settings } from "./types";

/** How the audio gets from the video into the output file. */
export type PlanKind =
  /** Compressed audio packets copied unchanged: bit-for-bit identical audio. */
  | "copy"
  /** Decoded and stored without any loss (lossless source, or PCM rewrapped). */
  | "lossless"
  /** Lossy source decoded to PCM: no further loss beyond the source's own. */
  | "decode"
  /** Re-encoded to a lossy format (MP3). */
  | "encode";

export interface Plan {
  format: OutputFormat;
  extension: string;
  mimeType: string;
  kind: PlanKind;
  /** One line for the UI describing what happens to the audio. */
  summary: string;
  /** Extra facts worth surfacing (bit depth, resampling, downmix). */
  notes: string[];
  /** ffmpeg output options, placed between the input and the output path. */
  args: string[];
}

/** Demuxer name ffmpeg reports for QuickTime / MP4 / M4V / 3GP files. */
const MOV_FAMILY = "mov,mp4,m4a,3gp,3g2,mj2";

const LOSSLESS_CODECS = new Set(["alac", "flac", "truehd", "mlp", "wmalossless", "ape", "tta", "wavpack"]);
const MPEG1_RATES = new Set([32000, 44100, 48000]);

/** Options that keep only the audio itself: no container tags, chapters or encoder stamps. */
const STRIP_METADATA = ["-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"];

type Depth = 16 | 24 | 32 | "f32";

export function isAudioStream(s: ProbeStream): s is AudioStream {
  return s.type === "audio" && s.codec !== null && !!s.sampleRate && !!s.channels;
}

export function isLossless(codec: string): boolean {
  return codec.startsWith("pcm_") || LOSSLESS_CODECS.has(codec);
}

export function audioStreams(info: ProbeInfo): AudioStream[] {
  return info.streams.filter(isAudioStream);
}

/** The track a player would pick: the default-flagged decodable one, else the first decodable one. */
export function defaultAudioStream(info: ProbeInfo): AudioStream | null {
  const usable = audioStreams(info).filter((s) => s.decodable);
  return usable.find((s) => s.default) ?? usable[0] ?? null;
}

/** Bit depth a lossless source actually carries, used to keep WAV/ALAC output lossless. */
export function sourceDepth(s: AudioStream): Depth | null {
  const c = s.codec;
  if (c.startsWith("pcm_f")) return "f32";
  if (/^pcm_[su]8/.test(c) || c === "pcm_alaw" || c === "pcm_mulaw" || c === "pcm_vidc") return 16;
  const named = /^pcm_[su](16|24|32|64)/.exec(c);
  if (named) return named[1] === "16" ? 16 : named[1] === "24" ? 24 : 32;
  if (!isLossless(c)) return null;
  // For compressed lossless codecs the container's coded sample size is unreliable; only the
  // decoder-reported depth counts. 24 is the safe fallback because it holds anything up to 24-bit.
  const bits = c.startsWith("pcm_") ? s.bitsPerRawSample || s.bitsPerCodedSample || 0 : s.bitsPerRawSample || 0;
  if (!bits) return 24;
  return bits <= 16 ? 16 : bits <= 24 ? 24 : 32;
}

/**
 * MP3 is only universally playable at the MPEG-1 rates (32/44.1/48 kHz). Other rates are
 * resampled to the MPEG-1 rate of the same family, which is an integer multiple for the
 * common low rates (8/12/16/24 kHz -> 48 kHz, 11.025/22.05 kHz -> 44.1 kHz).
 */
export function mp3SampleRate(rate: number): number {
  if (MPEG1_RATES.has(rate)) return rate;
  return rate % 11025 === 0 ? 44100 : 48000;
}

export function codecLabel(s: Pick<ProbeStream, "codec" | "profile" | "codecTag">): string {
  const c = s.codec;
  if (!c) return s.codecTag ? `“${s.codecTag}”` : "unknown";
  if (c === "aac") {
    if (s.profile === "LC" || !s.profile) return "AAC";
    return s.profile === "HE-AAC" ? "HE-AAC" : s.profile === "HE-AACv2" ? "HE-AAC v2" : `AAC ${s.profile}`;
  }
  const names: Record<string, string> = {
    alac: "Apple Lossless",
    mp3: "MP3",
    mp2: "MP2",
    opus: "Opus",
    vorbis: "Vorbis",
    flac: "FLAC",
    ac3: "Dolby Digital",
    eac3: "Dolby Digital Plus",
    truehd: "Dolby TrueHD",
    dts: "DTS",
    wmav1: "WMA",
    wmav2: "WMA",
    wmapro: "WMA Pro",
    amr_nb: "AMR",
    amr_wb: "AMR-WB",
  };
  if (names[c]) return names[c];
  if (c.startsWith("pcm_")) {
    const depth = /(\d+)/.exec(c);
    return c.startsWith("pcm_f") ? "PCM (float)" : depth ? `PCM ${depth[1]}-bit` : "PCM";
  }
  if (c.startsWith("adpcm")) return "ADPCM";
  return c.toUpperCase();
}

function khz(rate: number): string {
  return `${(rate / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} kHz`;
}

function depthLabel(d: Depth): string {
  return d === "f32" ? "32-bit float" : `${d}-bit`;
}

/** Trims the encoder padding left after the last real sample, matching the container's declared length. */
function endTrim(info: ProbeInfo, s: AudioStream): string | null {
  if (info.format !== MOV_FAMILY || !s.durationSamples || s.durationSamples <= 0) return null;
  return `atrim=end_sample=${s.durationSamples}`;
}

function withFilters(filters: (string | null)[]): string[] {
  const chain = filters.filter((f): f is string => !!f);
  return chain.length ? ["-af", chain.join(",")] : [];
}

/** Whether every sample of a `native`-depth source survives storage at `target` depth unchanged. */
function holdsExactly(target: Depth, native: Depth): boolean {
  if (native === "f32") return target === "f32";
  if (target === "f32") return native <= 24;
  return target >= native;
}

function planWav(info: ProbeInfo, s: AudioStream, settings: Settings): Plan {
  const native = sourceDepth(s);
  let depth: Depth;
  if (settings.wavDepth === "auto") depth = native ?? 24;
  else depth = settings.wavDepth === "32f" ? "f32" : settings.wavDepth === "16" ? 16 : 24;

  const codec = { 16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_s32le", f32: "pcm_f32le" }[depth];
  const reducesTo16 = depth === 16 && native !== 16;
  const dither = reducesTo16 ? "aresample=dither_method=triangular" : null;
  const notes = [`${depthLabel(depth)} PCM`, khz(s.sampleRate)];
  if (reducesTo16) notes.push("TPDF-dithered to 16-bit");

  let kind: PlanKind;
  let summary: string;
  if (native !== null && holdsExactly(depth, native)) {
    kind = "lossless";
    summary = s.codec.startsWith("pcm_")
      ? "Same PCM samples, rewrapped as WAV"
      : `Decoded from ${codecLabel(s)} without loss`;
  } else if (native !== null) {
    kind = "decode";
    summary = `Decoded from ${codecLabel(s)} and reduced to ${depthLabel(depth)}`;
  } else {
    kind = "decode";
    summary = `Decoded from ${codecLabel(s)}, nothing else changed`;
  }

  return {
    format: "wav",
    extension: "wav",
    mimeType: "audio/wav",
    kind,
    summary,
    notes,
    args: [...withFilters([endTrim(info, s), dither]), "-c:a", codec, ...STRIP_METADATA, "-f", "wav"],
  };
}

function planM4a(info: ProbeInfo, s: AudioStream): Plan {
  const container = ["-f", "ipod", "-movflags", "+faststart"];
  if (s.codec === "aac" || s.codec === "alac") {
    return {
      format: "m4a",
      extension: "m4a",
      mimeType: "audio/mp4",
      kind: "copy",
      summary: `Exact copy of the original ${codecLabel(s)} audio, not re-encoded`,
      notes: [khz(s.sampleRate)],
      args: ["-c:a", "copy", ...STRIP_METADATA, ...container],
    };
  }
  // M4A players expect AAC or ALAC. Anything else is decoded once and stored losslessly.
  const native = sourceDepth(s);
  const depth = native === 16 ? 16 : 24;
  return {
    format: "m4a",
    extension: "m4a",
    mimeType: "audio/mp4",
    kind: native === null ? "decode" : "lossless",
    summary:
      native === null
        ? `Apple Lossless: ${codecLabel(s)} can't go into M4A as-is, so it's decoded once with no further loss`
        : `Apple Lossless, decoded from ${codecLabel(s)} without loss`,
    notes: [`${depth}-bit ALAC`, khz(s.sampleRate)],
    args: [
      ...withFilters([endTrim(info, s)]),
      "-c:a",
      "alac",
      "-sample_fmt",
      depth === 16 ? "s16p" : "s32p",
      ...STRIP_METADATA,
      ...container,
    ],
  };
}

function planMp3(info: ProbeInfo, s: AudioStream, settings: Settings): Plan {
  const container = ["-f", "mp3", "-id3v2_version", "0", "-write_id3v1", "0"];
  if (s.codec === "mp3") {
    return {
      format: "mp3",
      extension: "mp3",
      mimeType: "audio/mpeg",
      kind: "copy",
      summary: "Exact copy of the original MP3 audio, not re-encoded",
      notes: [khz(s.sampleRate)],
      args: ["-c:a", "copy", ...STRIP_METADATA, ...container],
    };
  }
  const rate = mp3SampleRate(s.sampleRate);
  const notes = [settings.mp3Mode === "v0" ? "VBR V0" : "320 kbps CBR"];
  const extra: string[] = [];
  if (rate !== s.sampleRate) {
    extra.push("-ar", String(rate));
    notes.push(`resampled ${khz(s.sampleRate)} → ${khz(rate)} for MP3 compatibility`);
  } else {
    notes.push(khz(rate));
  }
  if (s.channels > 2) {
    extra.push("-ac", "2");
    notes.push(`downmixed ${s.channelLayout ?? `${s.channels} channels`} → stereo (MP3 maximum)`);
  }
  const quality = settings.mp3Mode === "v0" ? ["-q:a", "0"] : ["-b:a", "320k"];
  return {
    format: "mp3",
    extension: "mp3",
    mimeType: "audio/mpeg",
    kind: "encode",
    summary: `Encoded with LAME from ${codecLabel(s)} (MP3 is always lossy)`,
    notes,
    args: [
      ...withFilters([endTrim(info, s)]),
      ...extra,
      "-c:a",
      "libmp3lame",
      ...quality,
      "-compression_level",
      "2",
      ...STRIP_METADATA,
      // Fills the 9-byte encoder field of the LAME/Info header; gapless decoders look for "LAME".
      "-metadata:s:a:0",
      "encoder=LAME3.100",
      ...container,
    ],
  };
}

export function planConversion(info: ProbeInfo, stream: AudioStream, format: OutputFormat, settings: Settings): Plan {
  switch (format) {
    case "wav":
      return planWav(info, stream, settings);
    case "m4a":
      return planM4a(info, stream);
    case "mp3":
      return planMp3(info, stream, settings);
  }
}

/** Full ffmpeg argument list for one conversion. */
export function ffmpegArgs(plan: Plan, stream: AudioStream, inputPath: string, outputPath: string): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-i", inputPath, "-map", `0:${stream.index}`, ...plan.args, outputPath];
}
