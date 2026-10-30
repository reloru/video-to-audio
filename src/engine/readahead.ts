import type { EmscriptenFS, EmscriptenStream } from "./core";

export const MIN_BLOCK = 64 * 1024;
export const MAX_BLOCK = 8 * 1024 * 1024;
/** Forward jumps shorter than this are read through: cheaper than a new read plus a fresh ramp-up. */
export const READ_THROUGH = 1024 * 1024;

/**
 * Wraps reads of a large input so that each underlying read is a sizeable block.
 *
 * Every synchronous Blob read in a worker costs ~1.5 ms regardless of size, while large reads
 * run at hundreds of MB/s. FFmpeg reads 32 KB at a time and, when pulling just the audio out
 * of a video, hops over the video data in between. Reads that continue the current block, or
 * land a short distance past it, keep streaming forward with doubling block sizes (up to
 * MAX_BLOCK); longer jumps start a fresh MIN_BLOCK read, so sparse access stays cheap too.
 */
export function createReadAhead(size: number, readSlice: (start: number, end: number) => ArrayBuffer) {
  let blockStart = 0;
  let block = new Uint8Array(0);
  let blockSize = MIN_BLOCK;

  return function read(target: Uint8Array | Int8Array, offset: number, length: number, position: number): number {
    if (position >= size || length <= 0) return 0;
    const end = Math.min(position + length, size);
    const blockEnd = blockStart + block.length;
    if (position < blockStart || end > blockEnd) {
      const continuing = block.length > 0 && position >= blockStart && position - blockEnd < READ_THROUGH;
      let start = position;
      if (continuing) {
        blockSize = Math.min(blockSize * 2, MAX_BLOCK);
        start = Math.min(position, blockEnd);
      } else {
        blockSize = MIN_BLOCK;
      }
      blockStart = start;
      block = new Uint8Array(readSlice(start, Math.min(size, start + Math.max(blockSize, end - start))));
    }
    const from = position - blockStart;
    const count = end - position;
    target.set(block.subarray(from, from + count), offset);
    return count;
  };
}

/** Replaces the read operation of a WORKERFS-mounted Blob with the read-ahead version. */
export function addReadAhead(FS: EmscriptenFS, path: string, blob: Blob): void {
  const node = FS.lookupPath(path).node;
  const reader = new FileReaderSync();
  const read = createReadAhead(blob.size, (start, end) => reader.readAsArrayBuffer(blob.slice(start, end)));
  node.stream_ops = {
    ...node.stream_ops,
    read: (_stream: EmscriptenStream, buffer: Int8Array, offset: number, length: number, position: number) =>
      read(buffer, offset, length, position),
  };
}
