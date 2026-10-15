/** Private, reproducible measurement reports only. The caller must hold the
 * actual target PostgreSQL publication lock throughout every operation. */
import {
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
  existsSync,
  constants
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const unavailable = () => new Error("SIM_DRIVER_REPORT_STORAGE_UNAVAILABLE");
export class DriverReportFiles {
  constructor(directory, { production = process.env.NODE_ENV === "production" } = {}) {
    if (
      typeof directory !== "string" ||
      (production
        ? !["/driver-measurement-reports", "/srv/x5-production/cache/csm-sim/driver-measurement-reports"].includes(directory)
        : !/^\/private\/tmp\/(?:sim-erasure-installer-|sim-erasure-restore-|cop-erasure-owned-)[^/]+\/driver-report-files$/.test(directory))
    )
      throw unavailable();
    this.directory = directory;
    this.uid = production ? 0 : process.getuid();
    this.inventory();
  }
  inventory() {
    try {
      if (realpathSync(this.directory) !== this.directory) throw unavailable();
      const root = lstatSync(this.directory),
        entries = [];
      if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== this.uid || (root.mode & 0o777) !== 0o700) throw unavailable();
      const walk = (path, depth) => {
        if (depth > 8) throw unavailable();
        for (const name of readdirSync(path)) {
          const file = join(path, name),
            s = lstatSync(file);
          if (entries.length >= 10000 || s.dev !== root.dev || s.uid !== this.uid || s.isSymbolicLink()) throw unavailable();
          if (path === this.directory && name === ".publication-lock") {
            if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || readdirSync(file).length !== 0) throw unavailable();
            continue;
          }
          if (s.isDirectory()) {
            if ((s.mode & 0o777) !== 0o700) throw unavailable();
            entries.push({ file, directory: true, bytes: 0 });
            walk(file, depth + 1);
          } else {
            if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0) throw unavailable();
            entries.push({ file, directory: false, bytes: s.size });
          }
        }
      };
      walk(this.directory, 0);
      return { entries, root };
    } catch {
      throw unavailable();
    }
  }
  assertProtected() {
    const { entries } = this.inventory();
    return {
      fileCount: entries.filter((x) => !x.directory).length,
      bytes: entries.reduce((n, x) => n + x.bytes, 0),
      lockPresent: existsSync(join(this.directory, ".publication-lock"))
    };
  }
  async withLock(work) {
    this.inventory();
    if (this.held) throw unavailable();
    const path = join(this.directory, ".publication-lock");
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch {
      throw unavailable();
    }
    const own = lstatSync(path);
    this.held = true;
    this.syncDirectory();
    try {
      return await work();
    } finally {
      this.held = false;
      const current = lstatSync(path);
      if (current.dev !== own.dev || current.ino !== own.ino) throw unavailable();
      rmdirSync(path);
      this.syncDirectory();
    }
  }
  syncDirectory() {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  invalidateAll() {
    if (!this.held) throw unavailable();
    const { entries } = this.inventory();
    for (const entry of [...entries].reverse()) {
      if (entry.directory) rmdirSync(entry.file);
      else unlinkSync(entry.file);
    }
    this.syncDirectory();
    if (this.assertProtected().fileCount !== 0) throw unavailable();
  }
  write(kind, value) {
    if (!this.held || !["aggregates", "quality"].includes(kind)) throw unavailable();
    this.inventory();
    const bytes = JSON.stringify(value);
    if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 10 * 1024 * 1024) throw unavailable();
    const temporary = join(this.directory, ".report-tmp-" + randomUUID());
    let fd;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, join(this.directory, kind + ".json"));
      this.syncDirectory();
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}
