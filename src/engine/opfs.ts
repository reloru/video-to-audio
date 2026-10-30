import type { EmscriptenFS, EmscriptenNode, EmscriptenStream } from "./core";
import { OUTPUT_DIR } from "./protocol";

/** Where ffmpeg writes its output, and how to collect it afterwards. */
export interface OutputSink {
  path: string;
  storage: "opfs" | "memory";
  finish(): Promise<Blob>;
  discard(): Promise<void>;
}

interface SyncHandle {
  read(buffer: ArrayBufferView, options: { at: number }): number;
  write(buffer: ArrayBufferView, options: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

const EINVAL = 28;

/**
 * Backs one Emscripten file with an OPFS sync access handle, so ffmpeg's output goes to disk
 * instead of memory. Seeking keeps working, which the WAV header update and the M4A faststart
 * pass both rely on.
 */
function attachHandle(FS: EmscriptenFS, path: string, handle: SyncHandle): void {
  const node: EmscriptenNode = FS.create(path, 0o666);
  const memfsGetattr = FS.filesystems.MEMFS.node_ops.getattr as unknown as (n: EmscriptenNode) => { size: number };
  node.node_ops = {
    ...node.node_ops,
    getattr(n: EmscriptenNode) {
      const attr = memfsGetattr(n);
      attr.size = handle.getSize();
      return attr;
    },
    setattr(n: EmscriptenNode & { mode?: number; timestamp?: number }, attr: { size?: number; mode?: number; timestamp?: number }) {
      if (attr.size !== undefined) handle.truncate(attr.size);
      if (attr.mode !== undefined) n.mode = attr.mode;
      if (attr.timestamp !== undefined) n.timestamp = attr.timestamp;
    },
  };
  node.stream_ops = {
    llseek(stream: EmscriptenStream, offset: number, whence: number) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += handle.getSize();
      if (position < 0) throw new FS.ErrnoError(EINVAL);
      return position;
    },
    read(_stream: EmscriptenStream, buffer: Int8Array, offset: number, length: number, position: number) {
      return handle.read(buffer.subarray(offset, offset + length), { at: position });
    },
    write(_stream: EmscriptenStream, buffer: Int8Array, offset: number, length: number, position: number) {
      return handle.write(buffer.subarray(offset, offset + length), { at: position });
    },
  };
}

async function opfsSink(FS: EmscriptenFS, jobId: string, ext: string): Promise<OutputSink | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  let handle: SyncHandle | null = null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OUTPUT_DIR, { create: true });
    const name = `${jobId}.${ext}`;
    const fileHandle = await dir.getFileHandle(name, { create: true });
    const create = (fileHandle as unknown as { createSyncAccessHandle?: () => Promise<SyncHandle> }).createSyncAccessHandle;
    if (typeof create !== "function") return null;
    handle = await create.call(fileHandle);
    // Safari before 17 shipped an older draft whose methods return promises; treat it as unsupported.
    if (typeof handle.getSize() !== "number") {
      await Promise.resolve(handle.close());
      await dir.removeEntry(name);
      return null;
    }
    handle.truncate(0);
    const path = `/out/${name}`;
    attachHandle(FS, path, handle);
    const opened = handle;
    return {
      path,
      storage: "opfs",
      async finish() {
        opened.flush();
        opened.close();
        return fileHandle.getFile();
      },
      async discard() {
        opened.close();
        await dir.removeEntry(name).catch(() => {});
      },
    };
  } catch {
    try {
      handle?.close();
    } catch {
      /* already closed */
    }
    return null;
  }
}

function memorySink(FS: EmscriptenFS, ext: string): OutputSink {
  const path = `/out/output.${ext}`;
  return {
    path,
    storage: "memory",
    async finish() {
      const data = FS.readFile(path);
      FS.unlink(path);
      return new Blob([data as Uint8Array<ArrayBuffer>]);
    },
    async discard() {
      try {
        FS.unlink(path);
      } catch {
        /* never created */
      }
    },
  };
}

export async function createSink(FS: EmscriptenFS, jobId: string, ext: string, preferDisk: boolean): Promise<OutputSink> {
  FS.mkdir("/out");
  return (preferDisk ? await opfsSink(FS, jobId, ext) : null) ?? memorySink(FS, ext);
}
