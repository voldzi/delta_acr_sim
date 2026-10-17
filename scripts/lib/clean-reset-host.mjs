import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stoppedWriters } from "./clean-reset-ops.mjs";
const run = promisify(execFile);
/** Read-only, fixed two containers; deliberately never reads Config/Env. */
export async function collectStoppedSimWriters(expectedImages) {
  return stoppedWriters(async (name) => {
    const format = "{{json .Name}}\t{{json .Id}}\t{{json .Image}}\t{{json .State.Running}}\t{{json .State.Status}}\t{{json .State.Restarting}}";
    const r = await run("/usr/bin/docker", ["inspect", "--format", format, name], { timeout: 5000, maxBuffer: 8192 });
    const [Name, Id, Image, Running, Status, Restarting] = r.stdout
      .trim()
      .split("\t")
      .map((x) => JSON.parse(x));
    return { Name, Id, Image, State: { Running, Status, Restarting } };
  }, expectedImages);
}
