import { codecLabel } from "./plan";
import type { AudioStream, ProbeInfo, ProbeStream } from "./types";

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function channelsLabel(s: AudioStream): string {
  if (s.channels === 1) return "mono";
  if (s.channels === 2) return "stereo";
  return s.channelLayout ?? `${s.channels} channels`;
}

export function describeAudio(s: AudioStream): string {
  const parts = [codecLabel(s), `${(s.sampleRate / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 })} kHz`, channelsLabel(s)];
  if (s.bitRate > 0) parts.push(`${Math.round(s.bitRate / 1000)} kb/s`);
  if (s.language && s.language !== "und") parts.push(s.language);
  return parts.join(" · ");
}

const VIDEO_CODECS: Record<string, string> = {
  hevc: "HEVC",
  h264: "H.264",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4",
  prores: "ProRes",
  mjpeg: "Motion JPEG",
};

function hdrLabel(v: ProbeStream): string | null {
  if (v.colorTransfer === "smpte2084") return v.colorPrimaries === "bt2020" ? "HDR10" : "HDR (PQ)";
  if (v.colorTransfer === "arib-std-b67") return "HLG";
  return null;
}

export function describeVideo(info: ProbeInfo): string | null {
  const v = info.streams.find((s) => s.type === "video" && s.width);
  if (!v) return null;
  const codec = (v.codec && VIDEO_CODECS[v.codec]) ?? v.codec?.toUpperCase() ?? v.codecTag ?? "video";
  return [codec, `${v.width}×${v.height}`, hdrLabel(v)].filter(Boolean).join(" · ");
}
