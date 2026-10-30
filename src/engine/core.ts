import type { ProbeResponse } from "../lib/types";

/** The subset of the Emscripten FS API used here. */
export interface EmscriptenFS {
  mkdir(path: string): void;
  mount(type: unknown, opts: object, mountpoint: string): void;
  unmount(mountpoint: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  stat(path: string): { size: number };
  create(path: string, mode?: number): EmscriptenNode;
  lookupPath(path: string): { node: EmscriptenNode };
  filesystems: Record<string, unknown> & { MEMFS: EmscriptenFilesystem; WORKERFS: unknown };
  ErrnoError: new (errno: number) => Error;
}

export interface EmscriptenFilesystem {
  node_ops: Record<string, (...args: never[]) => unknown>;
}

export interface EmscriptenStream {
  position: number;
  node: EmscriptenNode;
}

export interface EmscriptenNode {
  node_ops: Record<string, unknown>;
  stream_ops: Record<string, unknown>;
}

export interface FFmpegCore {
  FS: EmscriptenFS;
  exec(...args: string[]): number;
  probe(path: string): ProbeResponse;
  logger: (event: { type: string; message: string }) => void;
  progress: (event: { progress: number; time: number }) => void;
}

export type CoreFactory = (options: Record<string, unknown>) => Promise<FFmpegCore>;

/**
 * Instantiates a fresh core. The patched ffmpeg CLI ends each run with abort(), so every
 * probe/convert gets its own instance; `module` lets callers compile the wasm only once.
 */
export function createCore(factory: CoreFactory, module?: WebAssembly.Module): Promise<FFmpegCore> {
  if (!module) return factory({});
  return factory({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
      return {};
    },
  });
}

export interface RunResult {
  exitCode: number;
  log: string[];
}

const LOG_LINES = 40;

/** Runs ffmpeg with `args`, reporting progress in [0, 1] based on the input duration. */
export function runFFmpeg(
  core: FFmpegCore,
  args: string[],
  durationSeconds: number | null,
  onProgress?: (ratio: number) => void,
): RunResult {
  const log: string[] = [];
  core.logger = ({ message }) => {
    log.push(message);
    if (log.length > LOG_LINES) log.shift();
  };
  core.progress = ({ time }) => {
    if (onProgress && durationSeconds && durationSeconds > 0 && time > 0) {
      onProgress(Math.min(1, time / 1e6 / durationSeconds));
    }
  };
  const exitCode = core.exec(...args);
  return { exitCode, log };
}

/** Picks the most useful line of an ffmpeg log to show when a run fails. */
export function failureReason(log: string[]): string {
  const meaningful = log.map((l) => l.trim()).filter((l) => l && !l.startsWith("Conversion failed"));
  return meaningful.at(-1) ?? "ffmpeg failed without an error message";
}
