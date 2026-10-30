/// <reference lib="webworker" />
import createFFmpegCore from "../../core/dist/ffmpeg-core.js";
import wasmUrl from "../../core/dist/ffmpeg-core.wasm?url";
import { ffmpegArgs } from "../lib/plan";
import { createCore, failureReason, runFFmpeg, type FFmpegCore } from "./core";
import { createSink } from "./opfs";
import { addReadAhead } from "./readahead";
import type { WorkerRequest, WorkerResponse } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

let compiled: Promise<WebAssembly.Module> | null = null;

function wasmModule(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    try {
      return await WebAssembly.compileStreaming(fetch(wasmUrl));
    } catch {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`Could not load the converter (HTTP ${response.status})`);
      return WebAssembly.compile(await response.arrayBuffer());
    }
  })();
  compiled.catch(() => (compiled = null));
  return compiled;
}

/** Exposes the picked file to ffmpeg without copying it: reads go straight to the Blob. */
function mountInput(core: FFmpegCore, file: Blob, name: string): string {
  core.FS.mkdir("/in");
  core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name, data: file }] }, "/in");
  const path = `/in/${name}`;
  addReadAhead(core.FS, path, file);
  return path;
}

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

async function handle(request: WorkerRequest): Promise<void> {
  const core = await createCore(createFFmpegCore, await wasmModule());
  const input = mountInput(core, request.file, request.name);

  if (request.type === "probe") {
    post({ id: request.id, type: "probe", result: core.probe(input) });
    return;
  }

  const { plan, stream } = request;
  const sink = await createSink(core.FS, request.jobId, plan.extension, request.storage === "auto");
  let lastReported = -1;
  let result;
  try {
    result = runFFmpeg(core, ffmpegArgs(plan, stream, input, sink.path), request.duration, (ratio) => {
      if (ratio - lastReported >= 0.01) {
        lastReported = ratio;
        post({ id: request.id, type: "progress", ratio });
      }
    });
  } catch (error) {
    await sink.discard();
    throw error;
  }

  if (result.exitCode !== 0) {
    await sink.discard();
    post({ id: request.id, type: "error", message: failureReason(result.log), log: result.log });
    return;
  }
  const file = await sink.finish();
  post({ id: request.id, type: "done", file, storage: sink.storage });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({ id: request.id, type: "error", message, log: [] });
  });
};
