import type { Plan } from "../lib/plan";
import type { AudioStream, ProbeResponse } from "../lib/types";

/** "auto" writes outputs to the Origin Private File System when the browser supports it. */
export type OutputStorage = "auto" | "memory";

export type WorkerRequest =
  | { id: number; type: "probe"; file: Blob; name: string }
  | {
      id: number;
      type: "convert";
      file: Blob;
      name: string;
      plan: Plan;
      stream: AudioStream;
      duration: number | null;
      jobId: string;
      storage: OutputStorage;
    };

export type WorkerResponse =
  | { id: number; type: "probe"; result: ProbeResponse }
  | { id: number; type: "progress"; ratio: number }
  | { id: number; type: "done"; file: Blob; storage: "opfs" | "memory" }
  | { id: number; type: "error"; message: string; log: string[] };

/** OPFS directory holding finished outputs until the user is done with them. */
export const OUTPUT_DIR = "outputs";
