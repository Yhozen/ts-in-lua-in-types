// A small worker pool: each worker keeps one wasmoon factory (tslua mounted)
// and runs checks in fresh Lua states. Jobs and results are plain JSON.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CheckOptions, CheckResult, Lib } from "./tslua.ts";

export interface Job {
  id: number;
  source: string;
  lib: Lib["name"];
  options: CheckOptions;
  /** Run the check twice (once without the hook, once with it) and compare. */
  twice?: boolean;
  libSource?: string;
  args?: string[];
}

export interface JobResult {
  id: number;
  result: CheckResult;
  /** Wall time of the unhooked run (with `twice`). */
  plainMs?: number;
  /** With `twice`: whether both runs printed the same thing. */
  same?: boolean;
}

export async function runPool(
  jobs: Job[],
  onDone: (r: JobResult, done: number) => void,
  size = Math.max(1, Math.min(jobs.length, availableParallelism() - 2, 12)),
): Promise<JobResult[]> {
  const results: JobResult[] = Array.from({ length: jobs.length });
  let next = 0;
  let done = 0;
  const url = new URL("./pool-worker.ts", import.meta.url);
  await Promise.all(
    Array.from({ length: size }, async () => {
      const worker = new Worker(url);
      try {
        while (next < jobs.length) {
          const job = jobs[next++]!;
          const r = await new Promise<JobResult>((resolve, reject) => {
            const onMessage = (m: JobResult) => {
              worker.off("error", reject);
              resolve(m);
            };
            worker.once("message", onMessage);
            worker.once("error", reject);
            worker.postMessage(job);
          });
          results[job.id] = r;
          onDone(r, ++done);
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return results;
}
