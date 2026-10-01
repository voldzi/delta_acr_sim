import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("traffic_inspection", Path(__file__).with_name("inspect-traffic-archive.py"))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class InspectionTests(unittest.TestCase):
    def test_aggregate_active_and_cleared_archive_without_id_disclosure(self):
        for words in ((0, 42), (0, 0)):
            with self.subTest(words=words), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "update.lock").touch()
                count = sum(word != 0 for word in words)
                (root / "applied-edges.json").write_text(json.dumps([123456789] if count else []))
                (root / "last-applied.json").write_text(json.dumps({"nextRecomputeAtEpoch": 100,
                    "report": {"status": "current" if count else "degraded", "overlayGeneration": "a" * 32, "appliedEdgeCount": count}}))
                with tarfile.open(root / "traffic.tar", "w:") as archive:
                    member = tarfile.TarInfo("synthetic.gph")
                    payload = bytes(32) + struct.pack("<2Q", *words)
                    member.size = len(payload)
                    archive.addfile(member, io.BytesIO(payload))
                    metadata = tarfile.TarInfo("index.bin")
                    metadata.size = 48
                    archive.addfile(metadata, io.BytesIO(bytes([42]) * 48))
                result = inspection.inspect(root)
                self.assertEqual(result["nonzeroSpeedRecordCount"], count)
                self.assertTrue(result["ledgerMatchesPhysicalCount"])
                self.assertNotIn("123456789", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
