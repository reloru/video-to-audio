import { CanceledError, clearOutputs, Engine, removeOutput, type Conversion } from "../engine/client";
import type { OutputStorage } from "../engine/protocol";
import { audioStreams, defaultAudioStream, planConversion, type Plan } from "../lib/plan";
import { DEFAULT_SETTINGS, type AudioStream, type OutputFormat, type ProbeInfo, type Settings } from "../lib/types";

export type ItemStatus = "probing" | "ready" | "noaudio" | "unsupported" | "error";
export type OutputStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface Output {
  id: string;
  key: string;
  plan: Plan;
  /** Index of the source stream this output is made from. */
  streamIndex: number;
  /** 1-based audio track number, set only when the video has more than one audio track. */
  track: number | null;
  status: OutputStatus;
  progress: number;
  file?: File;
  url?: string;
  error?: string;
  log?: string[];
  seconds?: number;
  storage?: "opfs" | "memory";
}

export interface Item {
  id: string;
  file: File;
  status: ItemStatus;
  info?: ProbeInfo;
  streamIndex?: number;
  error?: string;
  outputs: Output[];
}

const SETTINGS_KEY = "video-to-audio:settings";
const FORMAT_ORDER: OutputFormat[] = ["m4a", "mp3", "wav"];

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    if (!saved) return DEFAULT_SETTINGS;
    const formats = (saved.formats ?? []).filter((f): f is OutputFormat => FORMAT_ORDER.includes(f));
    return {
      formats: formats.length ? formats : DEFAULT_SETTINGS.formats,
      wavDepth: ["auto", "16", "24", "32f"].includes(saved.wavDepth ?? "") ? saved.wavDepth! : DEFAULT_SETTINGS.wavDepth,
      mp3Mode: saved.mp3Mode === "v0" ? "v0" : "cbr320",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or storage blocked: settings just won't persist */
  }
}

function uid(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Identifies an output by everything that changes its bytes. */
function outputKey(format: OutputFormat, streamIndex: number, settings: Settings): string {
  if (format === "wav") return `wav:${streamIndex}:${settings.wavDepth}`;
  if (format === "mp3") return `mp3:${streamIndex}:${settings.mp3Mode}`;
  return `m4a:${streamIndex}`;
}

function baseName(name: string): string {
  return name.replace(/\.[^./]+$/, "") || "audio";
}

export function selectedStream(item: Item): AudioStream | null {
  if (!item.info || item.streamIndex === undefined) return null;
  return audioStreams(item.info).find((s) => s.index === item.streamIndex) ?? null;
}

export class AppStore {
  items: Item[] = [];
  settings: Settings = loadSettings();
  private listeners = new Set<() => void>();
  private engine: Engine;
  private running: { output: Output; conversion: Conversion } | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor(storage: OutputStorage = "auto") {
    this.engine = new Engine(storage);
    void clearOutputs();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.busy) void this.holdWakeLock();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get busy(): boolean {
    return this.items.some((item) => item.status === "probing" || item.outputs.some((o) => o.status === "queued" || o.status === "running"));
  }

  get doneFiles(): File[] {
    return this.items.flatMap((item) => item.outputs.flatMap((o) => (o.status === "done" && o.file ? [o.file] : [])));
  }

  /** Items that still lack an output for the currently selected formats and quality settings. */
  get pendingWork(): number {
    return this.items.reduce((n, item) => n + this.missingFormats(item).length, 0);
  }

  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.emit();
  }

  toggleFormat(format: OutputFormat): void {
    const has = this.settings.formats.includes(format);
    if (has && this.settings.formats.length === 1) return;
    const formats = has ? this.settings.formats.filter((f) => f !== format) : [...this.settings.formats, format];
    this.setSettings({ formats: FORMAT_ORDER.filter((f) => formats.includes(f)) });
  }

  async addFiles(files: File[]): Promise<void> {
    const added = files.map<Item>((file) => ({ id: uid(), file, status: "probing", outputs: [] }));
    this.items = [...this.items, ...added];
    this.emit();
    void this.holdWakeLock();
    for (const item of added) {
      await this.probe(item);
      this.queueMissing(item);
    }
  }

  private async probe(item: Item): Promise<void> {
    try {
      const result = await this.engine.probe(item.file);
      if ("error" in result) {
        item.status = "error";
        item.error = result.error;
      } else {
        item.info = result;
        const audio = audioStreams(result);
        const stream = defaultAudioStream(result);
        if (stream) {
          item.status = "ready";
          item.streamIndex = stream.index;
        } else {
          item.status = audio.length ? "unsupported" : "noaudio";
        }
      }
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
    }
    this.emit();
  }

  private missingFormats(item: Item): OutputFormat[] {
    if (item.status !== "ready" || item.streamIndex === undefined) return [];
    const index = item.streamIndex;
    return this.settings.formats.filter((format) => {
      const key = outputKey(format, index, this.settings);
      return !item.outputs.some((o) => o.key === key && o.status !== "error" && o.status !== "canceled");
    });
  }

  private queueMissing(item: Item): void {
    const stream = selectedStream(item);
    if (!stream || !item.info) return;
    const tracks = audioStreams(item.info);
    const track = tracks.length > 1 ? tracks.findIndex((s) => s.index === stream.index) + 1 : null;
    for (const format of this.missingFormats(item)) {
      const key = outputKey(format, stream.index, this.settings);
      item.outputs = item.outputs.filter((o) => o.key !== key);
      item.outputs.push({
        id: uid(),
        key,
        plan: planConversion(item.info, stream, format, this.settings),
        streamIndex: stream.index,
        track,
        status: "queued",
        progress: 0,
      });
    }
    item.outputs.sort((a, b) => FORMAT_ORDER.indexOf(a.plan.format) - FORMAT_ORDER.indexOf(b.plan.format));
    this.emit();
    void this.pump();
  }

  convertMissing(): void {
    for (const item of this.items) this.queueMissing(item);
  }

  setStream(itemId: string, streamIndex: number): void {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;
    item.streamIndex = streamIndex;
    this.queueMissing(item);
  }

  retry(itemId: string, outputId: string): void {
    const item = this.items.find((i) => i.id === itemId);
    const output = item?.outputs.find((o) => o.id === outputId);
    if (!item || !output) return;
    Object.assign(output, { status: "queued", progress: 0, error: undefined, log: undefined, id: uid() });
    this.emit();
    void this.pump();
  }

  cancel(itemId: string, outputId: string): void {
    const item = this.items.find((i) => i.id === itemId);
    const output = item?.outputs.find((o) => o.id === outputId);
    if (!output) return;
    if (this.running?.output === output) this.running.conversion.cancel();
    else if (output.status === "queued") output.status = "canceled";
    this.emit();
  }

  remove(itemId: string): void {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;
    for (const output of item.outputs) this.release(output);
    if (this.running && item.outputs.includes(this.running.output)) this.running.conversion.cancel();
    this.items = this.items.filter((i) => i !== item);
    this.emit();
  }

  clear(): void {
    for (const item of [...this.items]) this.remove(item.id);
  }

  private release(output: Output): void {
    if (output.status === "queued") output.status = "canceled";
    if (output.url) URL.revokeObjectURL(output.url);
    output.url = undefined;
    if (output.status === "done") void removeOutput(output.id, output.plan.extension);
  }

  private fileName(item: Item, output: Output): string {
    const base = baseName(item.file.name) + (output.track ? ` (track ${output.track})` : "");
    const name = `${base}.${output.plan.extension}`;
    const taken = item.outputs.some((o) => o !== output && o.file?.name === name);
    return taken ? `${base} (${output.plan.notes[0]}).${output.plan.extension}` : name;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.nextQueued();
    if (!next) {
      void this.dropWakeLock();
      return;
    }
    const { item, output } = next;
    const stream = item.info ? audioStreams(item.info).find((s) => s.index === output.streamIndex) : undefined;
    if (!stream || !item.info) {
      output.status = "error";
      output.error = "The audio track is no longer available";
      this.emit();
      return this.pump();
    }
    void this.holdWakeLock();
    output.status = "running";
    output.progress = 0;
    this.emit();
    const started = performance.now();
    const conversion = this.engine.convert(item.file, output.plan, stream, item.info.duration, output.id, (ratio) => {
      output.progress = ratio;
      this.emit();
    });
    this.running = { output, conversion };
    try {
      const { file, storage } = await conversion.promise;
      if (!this.items.includes(item)) {
        void removeOutput(output.id, output.plan.extension);
      } else {
        output.file = new File([file], this.fileName(item, output), { type: output.plan.mimeType });
        output.url = URL.createObjectURL(output.file);
        output.status = "done";
        output.storage = storage;
        output.progress = 1;
        output.seconds = (performance.now() - started) / 1000;
      }
    } catch (error) {
      if (error instanceof CanceledError) {
        output.status = "canceled";
      } else {
        output.status = "error";
        output.error = error instanceof Error ? error.message : String(error);
        output.log = (error as { log?: string[] }).log;
      }
    } finally {
      this.running = null;
    }
    this.emit();
    return this.pump();
  }

  private nextQueued(): { item: Item; output: Output } | null {
    for (const item of this.items) {
      const output = item.outputs.find((o) => o.status === "queued");
      if (output) return { item, output };
    }
    return null;
  }

  private async holdWakeLock(): Promise<void> {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wakeLock || this.wakeLock || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await wakeLock.request("screen");
      (this.wakeLock as unknown as EventTarget).addEventListener?.("release", () => (this.wakeLock = null));
    } catch {
      /* not allowed right now; conversion still works, the screen may just dim */
    }
  }

  private async dropWakeLock(): Promise<void> {
    if (this.busy) return;
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => {});
  }
}
