// A worker of `vp run ref`: links the program once, then runs checks on the
// reference, each in a fresh state (loaded from scratch, or restored from a
// boot image).
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import type { Snapshot } from "../vendor/lua-in-types/src/aot/ref/snapshot.ts";
import {
  fromImage,
  imagePath,
  loadedInterp,
  refProgram,
  runCheck,
  type RefCheck,
} from "./luaref.ts";
import { libs, type Lib } from "./tslua.ts";

export interface RefJob {
  id: number;
  source: string;
  lib: Lib["name"];
  image: boolean;
}

export interface RefReply {
  id: number;
  check: RefCheck;
  /** Wall time to get the state the check starts from (load or restore), ms. */
  setupMs: number;
}

const program = refProgram();
const images = new Map<Lib["name"], Snapshot>();

parentPort!.on("message", (job: RefJob) => {
  const lib = libs[job.lib];
  const t0 = performance.now();
  let interp;
  if (job.image) {
    let image = images.get(job.lib);
    if (image === undefined) {
      image = JSON.parse(readFileSync(imagePath(job.lib), "utf8")) as Snapshot;
      images.set(job.lib, image);
    }
    interp = fromImage(program, image);
  } else {
    interp = loadedInterp(program, lib).interp;
  }
  const setupMs = performance.now() - t0;
  const reply: RefReply = {
    id: job.id,
    check: runCheck(interp, program, lib, job.source),
    setupMs,
  };
  parentPort!.postMessage(reply);
});
