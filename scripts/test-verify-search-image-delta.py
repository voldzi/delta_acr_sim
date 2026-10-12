#!/usr/bin/env python3
"""Offline RAM-only tests for the two reviewed Docker layer deltas."""
import hashlib
import importlib.util
import io
import json
import datetime
import pathlib
import sys
import tarfile
import types
import unittest
from unittest import mock

_spec = importlib.util.spec_from_file_location(
    "synthetic_search_image_delta", pathlib.Path(__file__).with_name("verify-search-image-delta.py")
)
_helper = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _helper
_spec.loader.exec_module(_helper)

SOURCE = "app/apps/situation-data-api/src/search-data.ts"
DIST = "app/apps/situation-data-api/dist/search-data.js"
SOURCE_EPOCH = 1791829376
CANDIDATE_EPOCH = SOURCE_EPOCH + 60
OLD_EPOCH = SOURCE_EPOCH - 100
PAYLOAD = b"synthetic reviewed payload; no application or user data\n"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def ancestors(target):
    parts = target.split("/")
    return ["/".join(parts[:index]) for index in range(1, len(parts))]


def baseline(target=SOURCE):
    result = {
        name: {"kind": "directory", "mode": 0o755, "uid": 0, "gid": 0, "mtime": OLD_EPOCH}
        for name in ancestors(target)
    }
    result[target] = {"kind": "file", "mode": 0o644, "uid": 0, "gid": 0, "mtime": OLD_EPOCH}
    return result


def member(name, kind=tarfile.REGTYPE, data=PAYLOAD, mtime=None, **overrides):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
    info.uid = info.gid = 0
    info.mtime = SOURCE_EPOCH if mtime is None else mtime
    info.size = len(data) if kind in (tarfile.REGTYPE, tarfile.AREGTYPE) else 0
    for key, value in overrides.items():
        setattr(info, key, value)
    return info, data


def entries(target=SOURCE):
    return [member(name + "/", tarfile.DIRTYPE, b"", OLD_EPOCH) for name in ancestors(target)] + [
        member(target, mtime=SOURCE_EPOCH if target == SOURCE else CANDIDATE_EPOCH)
    ]


def archive(items=None, target=SOURCE, format=tarfile.USTAR_FORMAT, pax_headers=None):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=format, pax_headers=pax_headers) as writer:
        for info, data in entries(target) if items is None else items:
            writer.addfile(info, io.BytesIO(data) if info.size else None)
    return out.getvalue()


def repair_checksum(raw, offset):
    changed = bytearray(raw)
    changed[offset + 148 : offset + 156] = b" " * 8
    checksum = sum(changed[offset : offset + 512])
    changed[offset + 148 : offset + 156] = ("%06o\0 " % checksum).encode("ascii")
    return bytes(changed)


class TailTarProofTests(unittest.TestCase):
    def verify(self, raw, target=SOURCE, metadata=None, digest=None, expected_sha=None, source_epoch=SOURCE_EPOCH, candidate_epoch=CANDIDATE_EPOCH):
        return _helper.verify_tail_tar(
            raw,
            digest or "sha256:" + sha(raw),
            target,
            expected_sha or sha(PAYLOAD),
            baseline(target) if metadata is None else metadata,
            source_epoch,
            candidate_epoch,
        )

    def reject(self, raw, **kwargs):
        with self.assertRaises(_helper.DeltaProofError) as caught:
            self.verify(raw, **kwargs)
        self.assertRegex(caught.exception.code, r"^[A-Z][A-Z0-9_]+$")
        self.assertNotIn("app/", str(caught.exception))
        self.assertNotIn("synthetic reviewed payload", str(caught.exception))

    def test_golden_source_and_dist_have_exact_aggregate_proofs(self):
        for target in (SOURCE, DIST):
            with self.subTest(target=target):
                proof = self.verify(archive(target=target), target=target)
                self.assertEqual(proof, {
                    "verified": True,
                    "entryCount": len(ancestors(target)) + 1,
                    "fileCount": 1,
                    "directoryCount": len(ancestors(target)),
                    "extendedAttributesRejected": True,
                })

    def test_valid_original_and_reviewed_window_parent_times(self):
        for epoch in (OLD_EPOCH, SOURCE_EPOCH, CANDIDATE_EPOCH + 5):
            items = entries()
            for info, _ in items[:-1]:
                info.mtime = epoch
            self.assertTrue(self.verify(archive(items))["verified"])
        items = entries(DIST)
        items[-1][0].mtime = SOURCE_EPOCH
        self.assertTrue(self.verify(archive(items), target=DIST)["verified"])

    def test_diff_id_and_payload_hash_must_match_exactly(self):
        raw = archive()
        self.reject(raw, digest="sha256:" + "a" * 64)
        self.reject(raw, digest=sha(raw))
        self.reject(raw, digest="sha256:" + sha(raw).upper())
        self.reject(raw, expected_sha="b" * 64)
        changed = entries()
        changed[-1] = member(SOURCE, data=b"synthetic wrong reviewed payload")
        self.reject(archive(changed))

    def test_only_canonical_reviewed_target_and_existing_ancestors_are_allowed(self):
        for name in (
            "app/apps/situation-data-api/src/other.ts", "/" + SOURCE,
            "app/apps/situation-data-api/src/../src/search-data.ts",
            "./" + SOURCE, SOURCE.replace("/src/", "//src/"),
            "app/apps/situation-data-api/src/.wh.synthetic", ".wh..wh..opq",
        ):
            with self.subTest(name=name):
                changed = entries()
                changed[-1] = member(name)
                self.reject(archive(changed))
        self.reject(archive(), target="app/apps/situation-data-api/src/other.ts")
        self.reject(archive(entries() + [member(SOURCE)]))
        self.reject(archive(entries() + [member("app/apps/situation-data-api/src/other.ts")]))
        self.reject(archive(entries() + [member("app/new-directory/", tarfile.DIRTYPE, b"", OLD_EPOCH)]))

    def test_links_devices_fifo_sparse_and_extended_headers_are_rejected(self):
        for kind in (tarfile.LNKTYPE, tarfile.SYMTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE):
            with self.subTest(kind=kind):
                changed = entries()
                changed[-1] = member(SOURCE, kind, b"", linkname="synthetic-link-target", devmajor=1, devminor=1)
                self.reject(archive(changed))
        self.reject(archive(format=tarfile.PAX_FORMAT, pax_headers={"synthetic.global": "synthetic-value"}))
        for attributes in (
            {"SCHILY.xattr.security.capability": "synthetic capability"},
            {"SCHILY.xattr.user.synthetic": "synthetic xattr"},
            {"SCHILY.acl.access": "synthetic ACL"},
            {"GNU.sparse.map": "0,1"},
        ):
            changed = entries()
            changed[-1][0].pax_headers = attributes
            self.reject(archive(changed, format=tarfile.PAX_FORMAT))
        changed = entries()
        changed.append(member("synthetic-" + "long-name-" * 20))
        self.reject(archive(changed, format=tarfile.GNU_FORMAT))

    def test_ancestor_metadata_and_target_metadata_cannot_drift(self):
        for index in (0, len(entries()) - 1):
            for attribute, value in (("mode", 0o777), ("uid", 1), ("gid", 1), ("mode", 0o4644)):
                with self.subTest(index=index, attribute=attribute, value=value):
                    changed = entries()
                    setattr(changed[index][0], attribute, value)
                    self.reject(archive(changed))
        changed = entries()
        changed[0] = member("app", tarfile.REGTYPE, b"synthetic false ancestor", OLD_EPOCH)
        self.reject(archive(changed))
        for changed in ({key: value for key, value in baseline().items() if key != "app"}, baseline()):
            if "app" in changed:
                changed["app"] = {**changed["app"], "kind": "file"}
            self.reject(archive(), metadata=changed)
        changed = baseline()
        changed["app"] = {**changed["app"], "uid": True}
        self.reject(archive(), metadata=changed)

    def test_file_and_parent_mtimes_are_constrained(self):
        for epoch in (SOURCE_EPOCH - 1, SOURCE_EPOCH + 1):
            changed = entries()
            changed[-1][0].mtime = epoch
            self.reject(archive(changed))
        for target, index in ((DIST, -1), (SOURCE, 0)):
            for epoch in (OLD_EPOCH - 1, CANDIDATE_EPOCH + 6):
                changed = entries(target)
                changed[index][0].mtime = epoch
                self.reject(archive(changed), target=target)
        self.reject(archive(), candidate_epoch=SOURCE_EPOCH - 1)

    def test_headers_checksum_padding_and_hidden_extensions_are_verified(self):
        raw = archive()
        target_header = len(ancestors(SOURCE)) * 512
        changed = bytearray(raw)
        changed[target_header + 148] ^= 1
        self.reject(bytes(changed))
        changed = bytearray(raw)
        changed[target_header + 500] = 1
        self.reject(repair_checksum(changed, target_header))
        changed = bytearray(raw)
        changed[target_header + 108 : target_header + 116] = bytes([0x80]) + bytes(7)
        self.reject(repair_checksum(changed, target_header))
        changed = bytearray(raw)
        changed[target_header + 512 + len(PAYLOAD)] = 1
        self.reject(bytes(changed))
        changed = bytearray(raw)
        changed[target_header + 156] = ord("x")
        self.reject(repair_checksum(changed, target_header))

    def test_eof_alignment_and_hidden_following_tar_are_verified(self):
        raw = archive()
        data_end = (len(ancestors(SOURCE)) + 2) * 512
        self.reject(raw[:data_end])
        self.reject(raw[:data_end + 512])
        self.reject(raw[:-1])
        changed = bytearray(raw)
        changed[-1] = 1
        self.reject(bytes(changed))
        self.reject(raw + archive([member("synthetic-hidden-file")]))
        self.reject(raw + b"synthetic-hidden-trailer" + bytes(490))

    def test_bounds_and_missing_or_duplicate_required_file_fail_closed(self):
        self.reject(bytes(4 * 1024 * 1024 + 512))
        self.reject(archive(entries()[:-1]))
        self.reject(archive(entries() + [member(SOURCE)]))
        changed = entries()
        changed[-1][0].uname = "synthetic-cosmetic-user"
        changed[-1][0].gname = "synthetic-cosmetic-group"
        self.assertTrue(self.verify(archive(changed))["verified"])
        changed[-1][0].uid = 1
        self.reject(archive(changed))


def image_fixture(oci=False):
    base_items = [member(name + "/", tarfile.DIRTYPE, b"", OLD_EPOCH) for name in sorted(_helper.ANCESTORS)]
    base_items += [member(name, data=b"synthetic old payload", mtime=OLD_EPOCH) for name in (SOURCE, DIST)]
    base0 = archive(base_items)
    src_parent = "app/apps/situation-data-api/src"
    base1 = archive([member(src_parent + "/", tarfile.DIRTYPE, b"", OLD_EPOCH - 10)])
    source_items = entries(SOURCE)
    source_items[-2][0].mtime = OLD_EPOCH - 10
    raw_layers = [base0, base1, archive(source_items), archive(target=DIST)]
    layers = ["sha256:" + sha(raw) for raw in raw_layers]
    config = json.dumps({"rootfs": {"type": "layers", "diff_ids": layers}, "synthetic": True}, separators=(",", ":")).encode()
    candidate_id = "sha256:" + sha(config)
    refs = ["blobs/sha256/" + sha(raw) if oci else (str(index + 1) * 64) + "/layer.tar" for index, raw in enumerate(raw_layers)]
    config_ref = "blobs/sha256/" + candidate_id[7:] if oci else candidate_id[7:] + ".json"
    manifest = json.dumps([{"Config": config_ref, "RepoTags": [], "Layers": refs}], separators=(",", ":")).encode()
    mapping = {config_ref: config, "manifest.json": manifest, **dict(zip(refs, raw_layers))}
    old = {"RootFS": {"Type": "layers", "Layers": layers[:-2]}, "Config": {"Labels": {"org.opencontainers.image.revision": _helper.BASE_REVISION}}}
    candidate = {
        "RootFS": {"Type": "layers", "Layers": layers},
        "Created": datetime.datetime.fromtimestamp(CANDIDATE_EPOCH, datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "Config": {"Labels": {
            "org.opencontainers.image.revision": _helper.SOURCE_REVISION,
            "org.opencontainers.image.base-revision": _helper.BASE_REVISION,
            "org.opencontainers.image.base-image-id": _helper.OLD_ID,
        }},
    }
    return {"candidate_id": candidate_id, "config_ref": config_ref, "refs": refs, "mapping": mapping, "layers": layers, "old": old, "candidate": candidate}


def outer_archive(fixture, mapping=None, order=None):
    mapping = fixture["mapping"] if mapping is None else mapping
    order = list(reversed(list(mapping))) if order is None else order
    return archive([member(name, data=mapping[name]) for name in order])


class SaveCollectorProofTests(unittest.TestCase):
    def fake_stream(self, archives, calls):
        def stream(args, budget, consume):
            calls.append(list(args))
            self.assertEqual(args[:2], ["image", "save"])
            raw = archives[min(len(calls) - 1, len(archives) - 1)]
            budget.count(len(raw))
            return consume(io.BytesIO(raw))
        return stream

    def assert_safe_error(self, operation):
        with self.assertRaises(_helper.DeltaProofError) as caught:
            operation()
        self.assertRegex(caught.exception.code, r"^[A-Z][A-Z0-9_]+$")
        self.assertNotIn("app/", str(caught.exception))

    def test_legacy_and_oci_save_passes_preserve_manifest_order_despite_reverse_outer_order(self):
        for oci in (False, True):
            fixture = image_fixture(oci)
            calls = []
            with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture)], calls)):
                first = _helper.save_pass(fixture["candidate_id"], fixture["layers"], _helper.Budget())
                second = _helper.save_pass(fixture["candidate_id"], fixture["layers"], _helper.Budget(), first["manifest"])
            self.assertEqual(len(calls), 2)
            self.assertEqual(first["manifest"]["layers"], fixture["refs"])
            self.assertEqual(first["manifest"]["config"], fixture["config_ref"])
            self.assertEqual(set(second["base"]), {0, 1})
            self.assertEqual(set(second["tails"]), {2, 3})
            merged = {}
            for index in range(2):
                merged.update(second["base"][index])
            self.assertEqual(merged["app/apps/situation-data-api/src"]["mtime"], OLD_EPOCH - 10)

    def test_verify_image_uses_two_passes_exact_config_hash_and_full_base_manifest_order(self):
        fixture = image_fixture()
        calls, inspect_calls = [], []
        def inspect(image_id, budget):
            inspect_calls.append(image_id)
            return json.loads(json.dumps(fixture["old"] if image_id == _helper.OLD_ID else fixture["candidate"]))
        with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture)], calls)), \
             mock.patch.object(_helper, "inspect_image", inspect), \
             mock.patch.object(_helper, "SOURCE_SHA", sha(PAYLOAD)), mock.patch.object(_helper, "DIST_SHA", sha(PAYLOAD)):
            result = _helper.verify_image(fixture["candidate_id"])
        self.assertTrue(result["basePrefixVerified"] and result["tailEntriesVerified"])
        self.assertEqual(result["dockerSavePasses"], 2)
        self.assertEqual(result["candidateImageId"], fixture["candidate_id"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(inspect_calls, [_helper.OLD_ID, fixture["candidate_id"], _helper.OLD_ID, fixture["candidate_id"]])

    def test_missing_or_mismatched_config_and_manifest_fail_closed(self):
        fixture = image_fixture()
        changed_sets = []
        for missing in (fixture["config_ref"], "manifest.json"):
            changed_sets.append({key: value for key, value in fixture["mapping"].items() if key != missing})
        wrong_config = dict(fixture["mapping"])
        wrong_config[fixture["config_ref"]] += b" "
        changed_sets.append(wrong_config)
        duplicate_config = dict(fixture["mapping"])
        duplicate_config["blobs/sha256/" + fixture["candidate_id"][7:]] = fixture["mapping"][fixture["config_ref"]]
        changed_sets.append(duplicate_config)
        for manifest in (
            [],
            [{"Config": "a" * 64 + ".json", "Layers": fixture["refs"]}],
            [{"Config": fixture["config_ref"], "Layers": fixture["refs"][:-1]}],
            [{"Config": fixture["config_ref"], "Layers": [fixture["refs"][0]] * 4}],
        ):
            changed = dict(fixture["mapping"])
            changed["manifest.json"] = json.dumps(manifest).encode()
            changed_sets.append(changed)
        for mapping in changed_sets:
            with self.subTest(keys=list(mapping)):
                calls = []
                with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture, mapping)], calls)):
                    self.assert_safe_error(lambda: _helper.save_pass(fixture["candidate_id"], fixture["layers"], _helper.Budget()))

    def test_missing_layers_changed_manifest_and_wrong_complete_base_diff_ids_fail_second_pass(self):
        fixture = image_fixture()
        first_known = _helper.validate_manifest(fixture["mapping"]["manifest.json"], fixture["candidate_id"], fixture["layers"])
        mutations = []
        for index in (0, 3):
            mutations.append({key: value for key, value in fixture["mapping"].items() if key != fixture["refs"][index]})
        changed = dict(fixture["mapping"])
        changed[fixture["refs"][0]] += bytes(512)  # Even zero bytes beyond TAR EOF change the full DiffID.
        mutations.append(changed)
        changed = dict(fixture["mapping"])
        changed["manifest.json"] = fixture["mapping"]["manifest.json"] + b" "
        mutations.append(changed)
        changed = dict(fixture["mapping"])
        changed[fixture["config_ref"]] = fixture["mapping"][fixture["config_ref"]] + b" "
        mutations.append(changed)
        for mapping in mutations:
            calls = []
            with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture, mapping)], calls)):
                self.assert_safe_error(lambda: _helper.save_pass(fixture["candidate_id"], fixture["layers"], _helper.Budget(), first_known))
        changed = dict(fixture["mapping"])
        changed["manifest.json"] = json.dumps([{"Config": fixture["config_ref"], "Layers": list(reversed(fixture["refs"]))}]).encode()
        calls = []
        with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture, changed)], calls)):
            self.assert_safe_error(lambda: _helper.save_pass(fixture["candidate_id"], fixture["layers"], _helper.Budget(), first_known))

    def test_relevant_base_whiteouts_and_unsafe_ancestors_are_not_silently_skipped(self):
        fixture = image_fixture()
        for unsafe in (
            member(".wh..wh..opq", data=b""),
            member(".wh.app", data=b""),
            member("app/.wh..wh..opq", data=b""),
            member("app/apps/situation-data-api/src/.wh.search-data.ts", data=b""),
            member("app", tarfile.SYMTYPE, b"", linkname="synthetic-unsafe"),
            member("app/", tarfile.DIRTYPE, b"", OLD_EPOCH, mode=0o777),
        ):
            with self.subTest(name=unsafe[0].name, kind=unsafe[0].type):
                raw = archive([unsafe])
                self.assert_safe_error(lambda: _helper.base_layer(io.BytesIO(raw), "sha256:" + sha(raw), _helper.Budget()))

    def test_verify_image_detects_identity_or_inspect_drift_without_extra_save_passes(self):
        fixture = image_fixture()
        calls, inspect_calls = [], []
        def inspect(image_id, budget):
            inspect_calls.append(image_id)
            value = json.loads(json.dumps(fixture["old"] if image_id == _helper.OLD_ID else fixture["candidate"]))
            if len(inspect_calls) == 4:
                value["syntheticChanged"] = True
            return value
        with mock.patch.object(_helper, "docker_stream", self.fake_stream([outer_archive(fixture)], calls)), \
             mock.patch.object(_helper, "inspect_image", inspect), \
             mock.patch.object(_helper, "SOURCE_SHA", sha(PAYLOAD)), mock.patch.object(_helper, "DIST_SHA", sha(PAYLOAD)):
            self.assert_safe_error(lambda: _helper.verify_image(fixture["candidate_id"]))
        self.assertEqual(len(calls), 2)


class ParserRuntimeBoundaryTests(unittest.TestCase):
    def fake_resource(self, previous=(-1, -1), fail_set=False):
        get = mock.Mock(return_value=previous)
        setter = mock.Mock(side_effect=OSError("synthetic denied limit") if fail_set else None)
        return types.SimpleNamespace(RLIMIT_AS=9, RLIM_INFINITY=-1, getrlimit=get, setrlimit=setter)

    def test_memory_limit_is_applied_and_restored_without_enlarging_a_smaller_existing_limit(self):
        for previous, expected in ((
            (-1, -1), (_helper.MAX_MEMORY, -1)
        ), ((1024 * 1024, 2 * 1024 * 1024), (1024 * 1024, 2 * 1024 * 1024))):
            resource = self.fake_resource(previous)
            with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"):
                with _helper.bounded_parser_memory():
                    resource.setrlimit.assert_called_once_with(9, expected)
            self.assertEqual(resource.setrlimit.call_args_list, [mock.call(9, expected), mock.call(9, previous)])

    def test_memory_boundary_restores_after_body_error_and_fails_closed_if_setting_is_denied(self):
        resource = self.fake_resource()
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"):
            with self.assertRaisesRegex(ValueError, "synthetic body error"):
                with _helper.bounded_parser_memory():
                    raise ValueError("synthetic body error")
        self.assertEqual(resource.setrlimit.call_args_list[-1], mock.call(9, (-1, -1)))
        denied = self.fake_resource(fail_set=True)
        with mock.patch.object(_helper, "resource", denied), mock.patch.object(_helper.sys, "platform", "linux"):
            with self.assertRaises(_helper.DeltaProofError) as caught:
                with _helper.bounded_parser_memory():
                    self.fail("Denied resource limit must not execute the body")
        self.assertEqual(caught.exception.code, "MEMORY_LIMIT")
        self.assertEqual(denied.setrlimit.call_count, 1)

    def test_memory_boundary_rejects_non_linux_and_attempts_restore_even_when_restore_fails(self):
        resource = self.fake_resource()
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "darwin"):
            with self.assertRaises(_helper.DeltaProofError) as caught:
                with _helper.bounded_parser_memory():
                    self.fail("Unsupported boundary must not run")
        self.assertEqual(caught.exception.code, "MEMORY_LIMIT")
        resource.setrlimit.assert_not_called()
        resource = self.fake_resource()
        resource.setrlimit.side_effect = [None, OSError("synthetic restore denial")]
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"):
            with self.assertRaises(OSError):
                with _helper.bounded_parser_memory():
                    pass
        self.assertEqual(resource.setrlimit.call_args_list[-1], mock.call(9, (-1, -1)))

    def test_consumer_memory_error_kills_owned_process_reaps_it_closes_stdout_and_restores_limit(self):
        resource = self.fake_resource()
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.return_value = -9
        budget = mock.Mock()
        budget.remaining.return_value = 30
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"), \
             mock.patch.object(_helper.subprocess, "Popen", return_value=process) as spawn:
            with self.assertRaises(_helper.DeltaProofError) as caught:
                _helper.docker_stream(["image", "save", "synthetic-only"], budget, mock.Mock(side_effect=MemoryError()))
        self.assertEqual(caught.exception.code, "MEMORY_LIMIT")
        spawn.assert_called_once()
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)
        process.stdout.close.assert_called_once()
        self.assertEqual(resource.setrlimit.call_args_list[-1], mock.call(9, (-1, -1)))

    def test_a_short_process_poll_timeout_is_not_the_global_deadline(self):
        resource = self.fake_resource()
        process = mock.Mock(returncode=0)
        process.poll.side_effect = [None, None, 0, 0]
        process.wait.side_effect = [_helper.subprocess.TimeoutExpired("synthetic docker poll", 0.2), 0, 0]
        budget = mock.Mock()
        budget.remaining.return_value = 30
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"), \
             mock.patch.object(_helper.subprocess, "Popen", return_value=process):
            result = _helper.docker_stream(["image", "save", "synthetic-only"], budget, lambda _stream: {"synthetic": True})
        self.assertEqual(result, {"synthetic": True})
        self.assertEqual(process.wait.call_args_list, [mock.call(timeout=0.2), mock.call(timeout=0.2), mock.call(timeout=2)])
        process.kill.assert_not_called()
        process.stdout.close.assert_called_once()

    def test_non_linux_stream_fails_before_spawning_docker(self):
        with mock.patch.object(_helper.sys, "platform", "darwin"), \
             mock.patch.object(_helper.subprocess, "Popen") as spawn:
            with self.assertRaises(_helper.DeltaProofError) as caught:
                _helper.docker_stream(["image", "save", "synthetic-only"], _helper.Budget(), mock.Mock())
        self.assertEqual(caught.exception.code, "MEMORY_LIMIT")
        spawn.assert_not_called()

    def test_global_deadline_kills_and_reaps_only_the_owned_process(self):
        resource = self.fake_resource()
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.return_value = -9
        budget = mock.Mock()
        budget.remaining.side_effect = _helper.DeltaProofError("TIMEOUT")
        with mock.patch.object(_helper, "resource", resource), mock.patch.object(_helper.sys, "platform", "linux"), \
             mock.patch.object(_helper.subprocess, "Popen", return_value=process):
            with self.assertRaises(_helper.DeltaProofError) as caught:
                _helper.docker_stream(["image", "save", "synthetic-only"], budget, lambda _stream: None)
        self.assertEqual(caught.exception.code, "TIMEOUT")
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=2)
        process.stdout.close.assert_called_once()

    def test_main_signal_interruption_emits_only_static_timeout_and_restores_handlers(self):
        candidate_id = "sha256:" + "a" * 64
        registered = {}
        previous = {signum: "synthetic-old-handler-" + str(signum) for signum in (_helper.signal.SIGTERM, _helper.signal.SIGINT)}
        def change_handler(signum, handler):
            old = registered.get(signum, previous[signum])
            registered[signum] = handler
            return old
        def interrupted(_candidate):
            registered[_helper.signal.SIGTERM](_helper.signal.SIGTERM, None)
        with mock.patch.object(_helper.signal, "signal", side_effect=change_handler) as handlers, \
             mock.patch.object(_helper, "verify_image", side_effect=interrupted), mock.patch("builtins.print") as output:
            result = _helper.main(["--candidate-id", candidate_id])
        self.assertEqual(result, 1)
        self.assertEqual(handlers.call_count, 4)
        self.assertEqual(registered, previous)
        output.assert_called_once()
        self.assertEqual(json.loads(output.call_args.args[0]), {"error": "TIMEOUT"})


if __name__ == "__main__":
    unittest.main()
