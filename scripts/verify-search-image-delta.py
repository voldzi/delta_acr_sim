#!/usr/bin/env python3
"""Read-only, streamed Docker image proof. Never extract or save an archive."""
import datetime
import contextlib
import hashlib
import io
import json
import math
import os
import re
import resource
import select
import signal
import subprocess
import sys
import tarfile
import time

OLD_ID = "sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965"
SOURCE_REVISION = "90e1d8d0cc50236429b32476e3fd2f31899cf03c"
BASE_REVISION = "03b842e005f103bb02d622bb4fc95f27fbea9572"
SOURCE_SHA = "698e3dd4d978db08cd8ddbc484082327b3743392913ad37b53244cab3a327aaa"
DIST_SHA = "3060a86a481496e701f9f3c1523bb2c95f68825348a285fe7979a090fe4aad1b"
SOURCE_EPOCH = 1791829376
SOURCE_FILE = "app/apps/situation-data-api/src/search-data.ts"
DIST_FILE = "app/apps/situation-data-api/dist/search-data.js"
TARGETS = (SOURCE_FILE, DIST_FILE)
ANCESTORS = {"app", "app/apps", "app/apps/situation-data-api", "app/apps/situation-data-api/src", "app/apps/situation-data-api/dist"}
RELEVANT = ANCESTORS | set(TARGETS)
MAX_TAIL = 4 * 1024 * 1024
MAX_SMALL = 256 * 1024
MAX_BYTES = 8 * 1024**3
MAX_MEMBERS = 500_000
MAX_MEMORY = 256 * 1024**2
ID_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SAFE_CODES = {
    "DELTA_PROOF_FAILED", "ARGUMENTS", "TIMEOUT", "BYTE_LIMIT", "MEMORY_LIMIT", "DOCKER_READ", "INSPECT",
    "IMAGE_PROFILE", "IMAGE_CHANGED", "OUTER_ARCHIVE", "MANIFEST", "CONFIG_IDENTITY",
    "LAYER_MISSING", "BASE_TAR", "BASE_DIFF_ID", "BASE_METADATA", "BASE_UNSAFE",
    "TAIL_SIZE", "TAIL_ALIGNMENT", "TAIL_DIFF_ID", "TAIL_FORMAT", "TAIL_HEADER",
    "TAIL_PATH", "TAIL_TYPE", "TAIL_DUPLICATE", "TAIL_CONTENT", "TAIL_PADDING",
    "TAIL_EOF", "TAIL_MEMBERS", "TAIL_METADATA", "TAIL_MTIME",
}


class DeltaProofError(Exception):
    def __init__(self, code):
        self.code = code if isinstance(code, str) and code in SAFE_CODES else "DELTA_PROOF_FAILED"
        super().__init__(self.code)


def require(condition, code):
    if not condition:
        raise DeltaProofError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical_path(value, directory=False):
    require(isinstance(value, str) and value and "\0" not in value and "\\" not in value, "TAIL_PATH")
    if directory and value.endswith("/"):
        value = value[:-1]
    require(value and not value.startswith("/") and not value.endswith("/"), "TAIL_PATH")
    parts = value.split("/")
    require(all(part and part not in (".", "..") for part in parts), "TAIL_PATH")
    return value


def safe_metadata(value, kind):
    require(isinstance(value, dict) and set(value) == {"kind", "mode", "uid", "gid", "mtime"}, "BASE_METADATA")
    require(value["kind"] == kind, "BASE_METADATA")
    for key in ("mode", "uid", "gid"):
        require(type(value[key]) is int and value[key] >= 0, "BASE_METADATA")
    require(value["mode"] <= 0o777 and value["mode"] & 0o022 == 0, "BASE_METADATA")
    require(type(value["mtime"]) in (int, float) and math.isfinite(value["mtime"]) and value["mtime"] >= 0, "BASE_METADATA")
    return value


def octal_field(raw):
    require(raw and raw[0] & 0x80 == 0 and re.fullmatch(rb"[ \0]*[0-7]*[ \0]*", raw), "TAIL_HEADER")
    value = raw.strip(b" \0")
    return int(value, 8) if value else 0


def text_field(raw):
    value, separator, padding = raw.partition(b"\0")
    require(not separator or not any(padding), "TAIL_HEADER")
    try:
        return value.decode("utf8", "strict")
    except UnicodeError:
        raise DeltaProofError("TAIL_HEADER") from None


def validate_ustar_header(raw):
    require(len(raw) == 512 and raw[257:263] == b"ustar\0" and raw[263:265] == b"00", "TAIL_FORMAT")
    require(not any(raw[500:512]), "TAIL_HEADER")
    text_field(raw[265:297])  # Cosmetic USTAR user/group names never override numeric ownership.
    text_field(raw[297:329])
    require(not text_field(raw[157:257]), "TAIL_TYPE")
    fields = [(100, 108), (108, 116), (116, 124), (124, 136), (136, 148), (148, 156), (329, 337), (337, 345)]
    parsed = [octal_field(raw[a:b]) for a, b in fields]
    require(parsed[5] == tarfile.calc_chksums(raw)[0] and parsed[6] == parsed[7] == 0, "TAIL_HEADER")
    try:
        info = tarfile.TarInfo.frombuf(raw, "utf8", "strict")
    except (tarfile.TarError, ValueError, UnicodeError):
        raise DeltaProofError("TAIL_HEADER") from None
    name, prefix = text_field(raw[:100]), text_field(raw[345:500])
    path = (prefix + "/" if prefix else "") + name
    require(info.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and not info.linkname, "TAIL_TYPE")
    return info, canonical_path(path, info.isdir())


def verify_tail_tar(raw, diff_id, expected_file, expected_sha, baseline_metadata, source_epoch, candidate_epoch):
    """Verify one raw USTAR COPY layer in RAM; return counts and booleans only."""
    require(isinstance(raw, bytes) and 1024 <= len(raw) <= MAX_TAIL, "TAIL_SIZE")
    require(len(raw) % 512 == 0, "TAIL_ALIGNMENT")
    require(isinstance(diff_id, str) and ID_RE.fullmatch(diff_id) and "sha256:" + digest(raw) == diff_id, "TAIL_DIFF_ID")
    require(expected_file in TARGETS and isinstance(expected_sha, str) and re.fullmatch(r"[0-9a-f]{64}", expected_sha), "TAIL_CONTENT")
    require(type(source_epoch) is int and type(candidate_epoch) is int and source_epoch >= 0 and candidate_epoch >= source_epoch, "TAIL_MTIME")
    require(isinstance(baseline_metadata, dict), "BASE_METADATA")
    parents = {expected_file.rsplit("/", level)[0] for level in range(1, len(expected_file.split("/")))}
    for parent in parents:
        safe_metadata(baseline_metadata.get(parent), "directory")
    safe_metadata(baseline_metadata.get(expected_file), "file")
    cursor, files, directories, seen = 0, 0, 0, set()
    try:
        archive = tarfile.open(fileobj=io.BytesIO(raw), mode="r:")
        with archive:
            while True:
                member = archive.next()
                if member is None:
                    break
                require(member.offset == cursor and member.offset_data == cursor + 512, "TAIL_HEADER")
                header, path = validate_ustar_header(raw[cursor:cursor + 512])
                require(not member.pax_headers and member.sparse is None and member.type == header.type and member.size == header.size, "TAIL_HEADER")
                require(path not in seen, "TAIL_DUPLICATE")
                seen.add(path)
                require(not any(part.startswith(".wh.") for part in path.split("/")), "TAIL_PATH")
                require(path == expected_file or path in parents, "TAIL_PATH")
                old = baseline_metadata[path]
                require((member.mode, member.uid, member.gid) == (old["mode"], old["uid"], old["gid"]), "TAIL_METADATA")
                require(type(member.mtime) is int, "TAIL_MTIME")
                if member.isdir():
                    require(path in parents and member.size == 0, "TAIL_TYPE")
                    require(member.mtime == old["mtime"] or source_epoch <= member.mtime <= candidate_epoch + 5, "TAIL_MTIME")
                    directories += 1
                else:
                    require(path == expected_file and member.isreg(), "TAIL_TYPE")
                    require(member.mtime == source_epoch if path == SOURCE_FILE else source_epoch <= member.mtime <= candidate_epoch + 5, "TAIL_MTIME")
                    files += 1
                    require(digest(raw[cursor + 512:cursor + 512 + member.size]) == expected_sha, "TAIL_CONTENT")
                end = cursor + 512 + member.size
                padded = cursor + 512 + ((member.size + 511) // 512) * 512
                require(padded <= len(raw) and not any(raw[end:padded]), "TAIL_PADDING")
                cursor = padded
                archive.members.clear()
    except DeltaProofError:
        raise
    except (tarfile.TarError, ValueError, UnicodeError, OverflowError):
        raise DeltaProofError("TAIL_FORMAT") from None
    require(files == 1, "TAIL_MEMBERS")
    require(len(raw) - cursor >= 1024 and not any(raw[cursor:]), "TAIL_EOF")
    return {"verified": True, "entryCount": files + directories, "fileCount": 1,
            "directoryCount": directories, "extendedAttributesRejected": True}


class Budget:
    def __init__(self):
        self.deadline = time.monotonic() + 180
        self.bytes = 0

    def remaining(self):
        left = self.deadline - time.monotonic()
        require(left > 0, "TIMEOUT")
        return left

    def count(self, size):
        self.remaining()
        self.bytes += size
        require(self.bytes <= MAX_BYTES, "BYTE_LIMIT")


class PipeReader:
    def __init__(self, pipe, budget):
        self.pipe, self.budget = pipe, budget

    def read(self, size):
        require(type(size) is int and size >= 0, "DOCKER_READ")
        if size == 0:
            return b""
        while True:
            ready, _, _ = select.select([self.pipe.fileno()], [], [], min(1, self.budget.remaining()))
            if ready:
                raw = os.read(self.pipe.fileno(), min(size, 1024 * 1024))
                self.budget.count(len(raw))
                return raw


class HashReader:
    def __init__(self, stream, budget):
        self.stream, self.budget, self.hasher = stream, budget, hashlib.sha256()

    def read(self, size):
        self.budget.remaining()
        raw = self.stream.read(size)
        self.hasher.update(raw)
        return raw

    def drain(self):
        while self.read(1024 * 1024):
            pass
        return "sha256:" + self.hasher.hexdigest()


@contextlib.contextmanager
def bounded_parser_memory():
    # Set only after Docker has started: its Go process keeps the original limit.
    # Linux RLIMIT_AS bounds stdlib PAX/GNU allocations before member validation.
    require(sys.platform == "linux" and hasattr(resource, "RLIMIT_AS"), "MEMORY_LIMIT")
    previous = resource.getrlimit(resource.RLIMIT_AS)
    ceiling = MAX_MEMORY if previous[1] == resource.RLIM_INFINITY else min(MAX_MEMORY, previous[1])
    ceiling = ceiling if previous[0] == resource.RLIM_INFINITY else min(ceiling, previous[0])
    try:
        resource.setrlimit(resource.RLIMIT_AS, (ceiling, previous[1]))
    except (OSError, ValueError):
        raise DeltaProofError("MEMORY_LIMIT") from None
    try:
        yield
    finally:
        resource.setrlimit(resource.RLIMIT_AS, previous)


def docker_stream(args, budget, consumer):
    require(sys.platform == "linux" and hasattr(resource, "RLIMIT_AS"), "MEMORY_LIMIT")
    process = None
    try:
        process = subprocess.Popen(["docker", *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
        with bounded_parser_memory():
            result = consumer(PipeReader(process.stdout, budget))
        while process.poll() is None:
            try:
                process.wait(timeout=min(0.2, budget.remaining()))
            except subprocess.TimeoutExpired:
                budget.remaining()
        require(process.returncode == 0, "DOCKER_READ")
        return result
    except subprocess.TimeoutExpired:
        raise DeltaProofError("TIMEOUT") from None
    except DeltaProofError:
        raise
    except MemoryError:
        raise DeltaProofError("MEMORY_LIMIT") from None
    except (OSError, ValueError, tarfile.TarError, UnicodeError):
        raise DeltaProofError("DOCKER_READ") from None
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass  # SIGKILL has been sent; never turn cleanup into an unbounded wait.
            if process.stdout is not None:
                process.stdout.close()


def drain(stream, budget):
    while True:
        budget.remaining()
        raw = stream.read(1024 * 1024)
        if not raw:
            return


def small(stream, size, budget):
    require(0 <= size <= MAX_SMALL, "OUTER_ARCHIVE")
    result = bytearray()
    while len(result) < size:
        budget.remaining()
        raw = stream.read(min(64 * 1024, size - len(result)))
        require(raw, "OUTER_ARCHIVE")
        result.extend(raw)
    return bytes(result)


def inspect_image(image_id, budget):
    def collect(pipe):
        result = bytearray()
        while True:
            raw = pipe.read(64 * 1024)
            if not raw:
                break
            result.extend(raw)
            require(len(result) <= 1024 * 1024, "INSPECT")
        try:
            rows = json.loads(result)
            require(isinstance(rows, list) and len(rows) == 1 and rows[0]["Id"] == image_id, "INSPECT")
            return rows[0]
        except (ValueError, KeyError, TypeError):
            raise DeltaProofError("INSPECT") from None
    return docker_stream(["image", "inspect", image_id], budget, collect)


def diff_ids(image):
    try:
        root = image["RootFS"]
        layers = root["Layers"]
        require(root["Type"] == "layers" and isinstance(layers, list) and 0 < len(layers) <= 128,
                "IMAGE_PROFILE")
        require(all(isinstance(value, str) and ID_RE.fullmatch(value) for value in layers), "IMAGE_PROFILE")
        return layers
    except (KeyError, TypeError):
        raise DeltaProofError("IMAGE_PROFILE") from None


def created_epoch(value):
    try:
        require(isinstance(value, str) and value.endswith("Z"), "IMAGE_PROFILE")
        date = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
        epoch = math.floor(date.timestamp())
        require(epoch >= SOURCE_EPOCH, "IMAGE_PROFILE")
        return epoch
    except (ValueError, OverflowError):
        raise DeltaProofError("IMAGE_PROFILE") from None


def validate_manifest(raw, candidate_id, layers):
    try:
        rows = json.loads(raw)
        require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), "MANIFEST")
        item = rows[0]
        config_ref = item["Config"]
        allowed = {candidate_id[7:] + ".json", "blobs/sha256/" + candidate_id[7:]}
        require(config_ref in allowed, "MANIFEST")
        refs = item["Layers"]
        require(isinstance(refs, list) and len(refs) == len(layers) and len(refs) == len(set(refs)), "MANIFEST")
        for ref in refs:
            require(isinstance(ref, str) and canonical_path(ref) == ref and
                    (re.fullmatch(r"[0-9a-f]{64}/layer\.tar", ref) or re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", ref)), "MANIFEST")
        require(config_ref not in refs, "MANIFEST")
        return {"config": config_ref, "layers": refs, "rawSha256": digest(raw)}
    except (ValueError, KeyError, TypeError):
        raise DeltaProofError("MANIFEST") from None


def validate_config(raw, candidate_id, expected_layers):
    require("sha256:" + digest(raw) == candidate_id, "CONFIG_IDENTITY")
    try:
        value = json.loads(raw)
        require(value["rootfs"]["type"] == "layers" and value["rootfs"]["diff_ids"] == expected_layers,
                "CONFIG_IDENTITY")
    except (ValueError, KeyError, TypeError):
        raise DeltaProofError("CONFIG_IDENTITY") from None


def relevant_whiteout(path):
    parent, _, name = path.rpartition("/")
    if name == ".wh..wh..opq":
        return not parent or any(value == parent or value.startswith(parent + "/") for value in RELEVANT)
    if name.startswith(".wh."):
        victim = (parent + "/" if parent else "") + name[4:]
        return any(value == victim or value.startswith(victim + "/") for value in RELEVANT)
    return False


def base_layer(stream, expected_id, budget):
    hashed = HashReader(stream, budget)
    result, count = {}, 0
    try:
        with tarfile.open(fileobj=hashed, mode="r|", bufsize=64 * 1024) as archive:
            while True:
                budget.remaining()
                member = archive.next()
                if member is None:
                    break
                count += 1
                require(count <= MAX_MEMBERS, "BASE_TAR")
                path = canonical_path(member.name, member.isdir())
                require(not relevant_whiteout(path), "BASE_UNSAFE")
                if path in RELEVANT:
                    require(path not in result and set(member.pax_headers) <= {"path", "mtime"}, "BASE_UNSAFE")
                    require(member.sparse is None and not member.linkname and (member.isdir() or member.isreg()), "BASE_UNSAFE")
                    require((path in ANCESTORS and member.isdir() and member.size == 0) or
                            (path in TARGETS and member.isreg()), "BASE_UNSAFE")
                    value = {"kind": "directory" if member.isdir() else "file", "mode": member.mode,
                             "uid": member.uid, "gid": member.gid, "mtime": member.mtime}
                    safe_metadata(value, value["kind"])
                    result[path] = value
                archive.members.clear()
        require(hashed.drain() == expected_id, "BASE_DIFF_ID")
        return result
    except DeltaProofError:
        raise
    except (tarfile.TarError, ValueError, UnicodeError, OverflowError):
        raise DeltaProofError("BASE_TAR") from None


def save_pass(candidate_id, layers, budget, known=None):
    config_names = {candidate_id[7:] + ".json", "blobs/sha256/" + candidate_id[7:]}
    def consume(pipe):
        seen, manifest_raw, config_raw, base, tails = set(), None, None, {}, {}
        try:
            with tarfile.open(fileobj=pipe, mode="r|", bufsize=64 * 1024) as outer:
                while True:
                    budget.remaining()
                    member = outer.next()
                    if member is None:
                        break
                    path = canonical_path(member.name, member.isdir())
                    require(path not in seen and len(seen) < 10_000 and not member.pax_headers and
                            member.sparse is None and not member.linkname and member.offset_data == member.offset + 512 and
                            (member.isdir() or member.isreg()), "OUTER_ARCHIVE")
                    seen.add(path)
                    if member.isdir():
                        require(member.size == 0, "OUTER_ARCHIVE")
                    else:
                        stream = outer.extractfile(member)  # Stream only; never extract a filesystem path.
                        require(stream is not None, "OUTER_ARCHIVE")
                        if path == "manifest.json":
                            manifest_raw = small(stream, member.size, budget)
                        elif path in config_names:
                            require(config_raw is None, "CONFIG_IDENTITY")
                            config_raw = small(stream, member.size, budget)
                        elif known and path in known["layers"]:
                            index = known["layers"].index(path)
                            if index < len(layers) - 2:
                                base[index] = base_layer(stream, layers[index], budget)
                            else:
                                require(member.size <= MAX_TAIL, "TAIL_SIZE")
                                raw = bytearray()
                                while len(raw) < member.size:
                                    budget.remaining()
                                    data = stream.read(min(64 * 1024, member.size - len(raw)))
                                    require(data, "TAIL_SIZE")
                                    raw.extend(data)
                                tails[index] = bytes(raw)
                        drain(stream, budget)
                    outer.members.clear()
            drain(pipe, budget)
        except DeltaProofError:
            raise
        except (tarfile.TarError, ValueError, UnicodeError, OverflowError):
            raise DeltaProofError("OUTER_ARCHIVE") from None
        require(manifest_raw is not None and config_raw is not None, "MANIFEST")
        manifest = validate_manifest(manifest_raw, candidate_id, layers)
        validate_config(config_raw, candidate_id, layers)
        if known:
            require(manifest == known, "MANIFEST")
            require(set(base) == set(range(len(layers) - 2)) and set(tails) == {len(layers) - 2, len(layers) - 1}, "LAYER_MISSING")
        return {"manifest": manifest, "base": base, "tails": tails}
    return docker_stream(["image", "save", candidate_id], budget, consume)


def verify_image(candidate_id):
    require(ID_RE.fullmatch(candidate_id) and candidate_id != OLD_ID, "ARGUMENTS")
    budget = Budget()
    old, candidate = inspect_image(OLD_ID, budget), inspect_image(candidate_id, budget)
    old_layers, layers = diff_ids(old), diff_ids(candidate)
    require(layers[:-2] == old_layers and len(layers) == len(old_layers) + 2, "IMAGE_PROFILE")
    labels = candidate.get("Config", {}).get("Labels", {}) or {}
    require(labels.get("org.opencontainers.image.revision") == SOURCE_REVISION and
            labels.get("org.opencontainers.image.base-image-id") == OLD_ID and
            labels.get("org.opencontainers.image.base-revision") == BASE_REVISION, "IMAGE_PROFILE")
    require((old.get("Config", {}).get("Labels", {}) or {}).get("org.opencontainers.image.revision") == BASE_REVISION, "IMAGE_PROFILE")
    epoch = created_epoch(candidate.get("Created"))
    first = save_pass(candidate_id, layers, budget)
    second = save_pass(candidate_id, layers, budget, first["manifest"])
    baseline = {}
    for index in range(len(old_layers)):
        baseline.update(second["base"][index])
    for path in RELEVANT:
        safe_metadata(baseline.get(path), "directory" if path in ANCESTORS else "file")
    expected = [(SOURCE_FILE, SOURCE_SHA), (DIST_FILE, DIST_SHA)]
    for offset, (path, file_sha) in enumerate(expected):
        index = len(old_layers) + offset
        verify_tail_tar(second["tails"][index], layers[index], path, file_sha, baseline, SOURCE_EPOCH, epoch)
    old_after, candidate_after = inspect_image(OLD_ID, budget), inspect_image(candidate_id, budget)
    require(old_after == old and candidate_after == candidate, "IMAGE_CHANGED")
    budget.remaining()
    return {"schemaVersion": "sim-search-image-delta-v1", "candidateImageId": candidate_id,
            "baseImageId": OLD_ID, "basePrefixVerified": True, "tailLayerCount": 2,
            "tailEntriesVerified": True, "extendedAttributesRejected": True,
            "sourceSha256": SOURCE_SHA, "distSha256": DIST_SHA,
            "directoryMtimePolicy": "old-or-reviewed-build-window", "dockerSavePasses": 2}


def main(argv):
    previous_handlers = {}
    def interrupted(_signum, _frame):
        raise DeltaProofError("TIMEOUT")
    try:
        require(len(argv) == 2 and argv[0] == "--candidate-id" and isinstance(argv[1], str) and ID_RE.fullmatch(argv[1]), "ARGUMENTS")
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, interrupted)
        print(json.dumps(verify_image(argv[1]), separators=(",", ":")))
        return 0
    except DeltaProofError as error:
        print(json.dumps({"error": error.code}, separators=(",", ":")))
        return 1
    except Exception:
        print('{"error":"DELTA_PROOF_FAILED"}')
        return 1
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
