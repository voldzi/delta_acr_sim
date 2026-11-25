"""Offline redirect-security tests: no network, downloaded maps or server state."""
import pathlib
import subprocess
import unittest

SOURCE = pathlib.Path(__file__).with_name("weekly-update.sh").read_text()
FUNCTION = SOURCE[SOURCE.index("resolve_geofabrik_redirect() {"):SOURCE.index("\ndownload_source_consistently() {")]
ORIGIN = "https://download.geofabrik.de/europe/germany-latest.osm.pbf"
MIRROR = "https://ftp5.gwdg.de/pub/misc/openstreetmap/download.geofabrik.de/germany-latest.osm.pbf"

class RedirectSecurity(unittest.TestCase):
    def resolve(self, redirect):
        return subprocess.run(["bash", "-c", FUNCTION + '\nresolve_geofabrik_redirect "$@"', "test", ORIGIN, redirect], text=True, capture_output=True, timeout=2)

    def test_accepted_exact_targets(self):
        for target, expected in [
            (MIRROR, MIRROR),
            ("https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf", "https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf"),
            ("https://download.geofabrik.de/europe/germany/germany-261124.osm.pbf", "https://download.geofabrik.de/europe/germany/germany-261124.osm.pbf"),
            ("/europe/germany/germany-261124.osm.pbf", "https://download.geofabrik.de/europe/germany/germany-261124.osm.pbf"),
            ("https://download.geofabrik.de/europe/germany-261003.osm.pbf", "https://download.geofabrik.de/europe/germany-261003.osm.pbf"),
            ("http://download.geofabrik.de/europe/germany-261003.osm.pbf", "https://download.geofabrik.de/europe/germany-261003.osm.pbf"),
            ("/europe/germany-261003.osm.pbf", "https://download.geofabrik.de/europe/germany-261003.osm.pbf"),
        ]:
            with self.subTest(target=target):
                r=self.resolve(target)
                self.assertEqual(r.returncode, 0)
                self.assertEqual(r.stdout.strip(), expected)

    def test_rejects_other_hosts_paths_countries_and_url_tricks(self):
        for target in [
            MIRROR.replace("https://", "http://"),
            MIRROR + "?cache=bypass", MIRROR + "#fragment", MIRROR + "/extra",
            MIRROR.replace("germany-latest", "poland-latest"),
            MIRROR.replace("ftp5.gwdg.de", "ftp5.gwdg.de.evil.invalid"),
            MIRROR.replace("ftp5.gwdg.de", "ftp5.gwdg.de@evil.invalid"),
            MIRROR.replace("https://ftp5.gwdg.de", "https://user:password@ftp5.gwdg.de"),
            MIRROR.replace("https://ftp5.gwdg.de", "https://ftp5.gwdg.de:444"),
            MIRROR.replace("germany-latest", "germany-261003"),
            "https://download.geofabrik.de/europe/germany-latest.osm.pbf",
            "https://download.geofabrik.de/europe/germany-261003.osm.pbf?x=1",
            "https://download.geofabrik.de/europe/poland-261003.osm.pbf",
            "//download.geofabrik.de/europe/germany-261003.osm.pbf",
            "https://evil.invalid/europe/germany-261003.osm.pbf",
            "https://download.geofabrik.de/europe/germany-abcdef.osm.pbf",
            "http://download.geofabrik.de/europe/germany/germany-latest.osm.pbf",
            "https://download.geofabrik.de/europe/poland/germany-latest.osm.pbf",
            "https://download.geofabrik.de/europe/germany/poland-latest.osm.pbf",
            "https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf?x=1",
            "https://download.geofabrik.de/europe/germany/germany-latest.osm.pbf#x",
            "https://download.geofabrik.de/europe/germany/germany-261124.osm.pbf?x=1",
            "https://download.geofabrik.de/europe/germany/../germany/germany-latest.osm.pbf",
            "https://download.geofabrik.de.evil.invalid/europe/germany/germany-latest.osm.pbf",
            "https://download.geofabrik.de@evil.invalid/europe/germany/germany-latest.osm.pbf",
            "https://download.geofabrik.de:444/europe/germany/germany-latest.osm.pbf",
        ]:
            with self.subTest(target=target):
                r=self.resolve(target)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(r.stdout, "")

    def test_transport_and_content_checks_are_preserved(self):
        self.assertTrue("--proto '=https' --proto-redir '=https'" in SOURCE, "HTTPS-only transfer guard missing")
        self.assertEqual(SOURCE.count('"${resolved_url}.md5"'), 2, "Both checksums must use the same chosen mirror")
        self.assertTrue('verify_source_checksum "${partial_file}" "${checksum_before}"' in SOURCE, "Content checksum gate missing")

    def test_country_directory_layout_for_every_configured_country(self):
        for country in ['czech-republic', 'germany', 'poland', 'slovakia', 'austria', 'hungary']:
            origin = f'https://download.geofabrik.de/europe/{country}-latest.osm.pbf'
            target = f'https://download.geofabrik.de/europe/{country}/{country}-latest.osm.pbf'
            r = subprocess.run(['bash', '-c', FUNCTION + '\nresolve_geofabrik_redirect "$@"',
                                'test', origin, target], text=True, capture_output=True, timeout=2)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, target))

if __name__ == "__main__":
    unittest.main()
