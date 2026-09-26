#!/usr/bin/env python3
"""Small offline contract check for the aggregate static-geometry audit."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import xml.etree.ElementTree as ET


spec = importlib.util.spec_from_file_location(
    "audit_tpeg_static_geometry", Path(__file__).with_name("audit-tpeg-static-geometry.py")
)
assert spec and spec.loader
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

sample = ET.fromstring("""
<ApplicationRootMessageML xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:type="tfp:TFPMessage">
  <mmt><optionMMCPartLink><partID>1</partID></optionMMCPartLink></mmt>
  <loc>
    <method><optionTMCLocationReferenceLink><locationID>secret</locationID></optionTMCLocationReferenceLink></method>
    <method><optionOpenLRLocationReferenceLink><first><coordinate/></first><last><coordinate/></last>
      </optionOpenLRLocationReferenceLink></method>
  </loc>
</ApplicationRootMessageML>
""")
assert audit.summarize_message(sample) == {
    "tmc": 1, "openlr": 1, "geometric": 0,
    "openlr_points": 2, "geometry_points": 0,
}
sample.find("mmt/optionMMCPartLink/partID").text = "2"
assert audit.summarize_message(sample) is None
sample.find("mmt/optionMMCPartLink").tag = "optionMMCMasterLink"
sample.find("mmt/optionMMCMasterLink/partID").text = "1"
assert audit.summarize_message(sample) is None
print("static geometry audit tests passed")
