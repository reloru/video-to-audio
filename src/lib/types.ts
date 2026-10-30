/** Shape of the JSON produced by core/probe.c. */
export interface ProbeStream {
  index: number;
  type: "audio" | "video" | "data" | "subtitle" | "attachment" | null;
  codec: string | null;
  codecTag: string | null;
  profile: string | null;
  decodable: boolean;
  bitRate: number;
  duration: number | null;
  default: boolean;
  language: string | null;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string | null;
  sampleFormat?: string | null;
  bitsPerRawSample?: number;
  bitsPerCodedSample?: number;
  initialPadding?: number;
  frameSize?: number;
  durationSamples?: number | null;
  width?: number;
  height?: number;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
}

export interface ProbeInfo {
  format: string;
  duration: number | null;
  startTime: number | null;
  bitRate: number;
  streams: ProbeStream[];
}

export type ProbeResponse = ProbeInfo | { error: string };

export interface AudioStream extends ProbeStream {
  type: "audio";
  codec: string;
  sampleRate: number;
  channels: number;
}

export type OutputFormat = "m4a" | "mp3" | "wav";
export type WavDepth = "auto" | "16" | "24" | "32f";
export type Mp3Mode = "cbr320" | "v0";

export interface Settings {
  formats: OutputFormat[];
  wavDepth: WavDepth;
  mp3Mode: Mp3Mode;
}

export const DEFAULT_SETTINGS: Settings = {
  formats: ["m4a"],
  wavDepth: "auto",
  mp3Mode: "cbr320",
};
