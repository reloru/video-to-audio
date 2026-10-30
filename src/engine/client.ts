import type { Plan } from "../lib/plan";
import type { AudioStream, ProbeResponse } from "../lib/types";
import { OUTPUT_DIR, type OutputStorage, type WorkerRequest, type WorkerResponse } from "./protocol";

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (ratio: number) => void;
};

export class CanceledError extends Error {
  constructor() {
    super("Canceled");
  }
}

type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

/** One ffmpeg worker. Cancelling terminates it, which is the only way to stop a running exec. */
class WorkerHandle {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === "progress") {
        entry.onProgress?.(message.ratio);
        return;
      }
      this.pending.delete(message.id);
      entry.resolve(message);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "The converter crashed (the device may be out of memory)"));
    };
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(body: RequestBody, onProgress?: (ratio: number) => void): Promise<WorkerResponse> {
    const id = this.nextId++;
    const worker = this.ensure();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ ...body, id } as WorkerRequest);
    });
  }

  cancel(): void {
    this.fail(new CanceledError());
  }
}

function inputName(fileName: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext ? `input.${ext}` : "input";
}

export interface Conversion {
  promise: Promise<{ file: Blob; storage: "opfs" | "memory" }>;
  cancel(): void;
}

/**
 * Main-thread entry point. Probing and converting use separate workers so that inspecting newly
 * picked files is never stuck behind a long conversion.
 */
export class Engine {
  private prober = new WorkerHandle();
  private converter = new WorkerHandle();

  constructor(private storage: OutputStorage = "auto") {}

  async probe(file: File): Promise<ProbeResponse> {
    const response = await this.prober.request({ type: "probe", file, name: inputName(file.name) });
    if (response.type === "error") return { error: response.message };
    if (response.type !== "probe") throw new Error(`unexpected response ${response.type}`);
    return response.result;
  }

  convert(
    file: File,
    plan: Plan,
    stream: AudioStream,
    duration: number | null,
    jobId: string,
    onProgress: (ratio: number) => void,
  ): Conversion {
    const promise = this.converter
      .request(
        { type: "convert", file, name: inputName(file.name), plan, stream, duration, jobId, storage: this.storage },
        onProgress,
      )
      .then((response) => {
        if (response.type === "error") {
          const error = new Error(response.message);
          (error as Error & { log?: string[] }).log = response.log;
          throw error;
        }
        if (response.type !== "done") throw new Error(`unexpected response ${response.type}`);
        return { file: response.file, storage: response.storage };
      });
    return {
      promise,
      cancel: () => {
        this.converter.cancel();
        void removeOutput(jobId, plan.extension);
      },
    };
  }
}

async function outputDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(OUTPUT_DIR, { create: true }) : null;
  } catch {
    return null;
  }
}

export async function removeOutput(jobId: string, ext: string): Promise<void> {
  const dir = await outputDir();
  await dir?.removeEntry(`${jobId}.${ext}`).catch(() => {});
}

/** Outputs live only for the session; anything left from an earlier visit is removed. */
export async function clearOutputs(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(OUTPUT_DIR, { recursive: true });
  } catch {
    /* nothing stored, or storage unavailable */
  }
}
