import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import createFFmpegCore from "../../core/dist/ffmpeg-core.js";
import { createCore, runFFmpeg, type RunResult } from "../../src/engine/core";
import { defaultAudioStream, ffmpegArgs, planConversion, type Plan } from "../../src/lib/plan";
import type { AudioStream, OutputFormat, ProbeInfo, Settings } from "../../src/lib/types";
import { DEFAULT_SETTINGS } from "../../src/lib/types";

export const FIXTURES = resolve(import.meta.dirname, "../fixtures");

const wasmModule = WebAssembly.compile(readFileSync(resolve(import.meta.dirname, "../../core/dist/ffmpeg-core.wasm")));

async function coreWithInput(fixture: string) {
  const core = await createCore(createFFmpegCore, await wasmModule);
  const input = `/in/input${extname(fixture).toLowerCase()}`;
  core.FS.mkdir("/in");
  core.FS.mkdir("/out");
  core.FS.writeFile(input, readFileSync(resolve(FIXTURES, fixture)));
  return { core, input };
}

export async function probeFixture(fixture: string): Promise<ProbeInfo> {
  const { core, input } = await coreWithInput(fixture);
  const result = core.probe(input);
  if ("error" in result) throw new Error(`probe failed: ${result.error}`);
  return result;
}

export interface Converted extends RunResult {
  info: ProbeInfo;
  stream: AudioStream;
  plan: Plan;
  output: Uint8Array;
  progress: number[];
}

export async function convertFixture(
  fixture: string,
  format: OutputFormat,
  overrides: Partial<Settings> = {},
  streamIndex?: number,
): Promise<Converted> {
  const info = await probeFixture(fixture);
  const stream = streamIndex === undefined
    ? defaultAudioStream(info)
    : (info.streams.find((s) => s.index === streamIndex) as AudioStream | undefined);
  if (!stream) throw new Error(`${fixture} has no usable audio stream`);
  const plan = planConversion(info, stream, format, { ...DEFAULT_SETTINGS, ...overrides });

  const { core, input } = await coreWithInput(fixture);
  const outputPath = `/out/output.${plan.extension}`;
  const progress: number[] = [];
  const result = runFFmpeg(core, ffmpegArgs(plan, stream, input, outputPath), info.duration, (r) => progress.push(r));
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg exited with ${result.exitCode}:\n${result.log.join("\n")}`);
  }
  return { ...result, info, stream, plan, output: core.FS.readFile(outputPath), progress };
}
