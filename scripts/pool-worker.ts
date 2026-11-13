import { parentPort } from "node:worker_threads";
import type { Job, JobResult } from "./pool.ts";
import { check, libs } from "./tslua.ts";

parentPort!.on("message", async (job: Job) => {
  const lib = libs[job.lib];
  const run = (options = job.options) => check(job.source, lib, options, job.libSource, job.args);
  let reply: JobResult;
  if (job.twice) {
    const plain = await run({ ...job.options, count: false, peak: false });
    const result = await run();
    reply = { id: job.id, result, plainMs: plain.ms, same: plain.output === result.output };
  } else {
    reply = { id: job.id, result: await run() };
  }
  parentPort!.postMessage(reply);
});
