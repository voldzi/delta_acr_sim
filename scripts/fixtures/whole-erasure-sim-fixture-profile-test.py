"""Pure closed-profile checks. No SSH, database, secrets or container changes."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("fixture", Path(__file__).with_name("whole-erasure-sim-fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Profiles(unittest.TestCase):
    def tearDown(self):
        fixture.select_profile("negative-v1")

    def test_default_preserves_old_case(self):
        self.assertEqual(fixture.OWNER, "cop-messaging-joint-d2630fa78b21")

    def test_full_case_is_separate_closed_tuple(self):
        old = fixture.HOLDER, set(fixture.NAMES.values())
        fixture.select_profile("full-v2")
        self.assertNotEqual(old[0], fixture.HOLDER)
        self.assertFalse(old[1] & set(fixture.NAMES.values()))
        self.assertEqual(fixture.INPUT_CARRIER, "cop-erasure-whole-e70f147c5b2f-node")
        self.assertEqual(len(fixture.PROFILE["input_sha256"]), 64)

    def test_unknown_profile_rejected(self):
        with self.assertRaises(KeyError):
            fixture.select_profile("production")

    def test_cross_profile_source_rejected_before_private_read(self):
        fixture.select_profile("full-v2")
        args = SimpleNamespace(input_container="cop-erasure-whole-a7d2df56a653-node",
                               input_owner="cop-erasure-whole-a7d2df56a653",
                               input_path=fixture.PROFILE["input_path"])
        with patch.object(fixture, "holder"), patch.object(fixture, "inspect", return_value=None), patch.object(fixture, "remote") as remote:
            with self.assertRaises(AssertionError):
                fixture.serve(args)
            remote.assert_not_called()

    def test_unapproved_path_rejected_before_private_read(self):
        fixture.select_profile("full-v2")
        args = SimpleNamespace(input_container=fixture.INPUT_CARRIER,
                               input_owner=fixture.INPUT_OWNER,
                               input_path="/tmp/other.json")
        with patch.object(fixture, "holder"), patch.object(fixture, "inspect", return_value=None), patch.object(fixture, "remote") as remote:
            with self.assertRaises(AssertionError):
                fixture.serve(args)
            remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
