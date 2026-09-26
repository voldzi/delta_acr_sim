#!/usr/bin/env python3
"""Count location-reference shapes in an authorized TPEG2 static XML file.

This offline audit never prints message IDs, coordinates, XML, or credentials.
It does not fetch the provider feed or modify SIM's production cache.
"""

from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def summarize_message(message: ET.Element) -> dict[str, int] | None:
    if not any(local_name(key) == "type" and value.endswith(":TFPMessage")
               for key, value in message.attrib.items()):
        return None
    part_links = [node for node in message.iter()
                  if local_name(node.tag) == "optionMMCPartLink"]
    if not any(any(local_name(child.tag) == "partID" and child.text == "1"
                   for child in link.iter()) for link in part_links):
        return None
    methods = [node for node in message.iter() if local_name(node.tag) == "method"]
    names = {local_name(child.tag) for method in methods for child in method}
    openlr_points = sum(local_name(node.tag) == "coordinate" for method in methods
                        for node in method.iter())
    geometry_points = sum(local_name(node.tag) == "linePoints" for method in methods
                          for node in method.iter())
    return {
        "tmc": int("optionTMCLocationReferenceLink" in names),
        "openlr": int("optionOpenLRLocationReferenceLink" in names),
        "geometric": int(any("GLR" in name or "Geometric" in name for name in names)),
        "openlr_points": openlr_points,
        "geometry_points": geometry_points,
    }


def audit(path: Path) -> dict[str, int]:
    counts: Counter[str] = Counter()
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if local_name(element.tag) != "ApplicationRootMessageML":
                continue
            summary = summarize_message(element)
            element.clear()
            if summary is None:
                continue
            counts["part1_messages"] += 1
            for key in ("tmc", "openlr", "geometric"):
                counts[f"with_{key}"] += summary[key]
            counts["with_openlr_2plus_points"] += int(summary["openlr_points"] >= 2)
            counts["with_geometry_3plus_points"] += int(summary["geometry_points"] >= 3)
    return dict(sorted(counts.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xml", type=Path, help="authorized static TPEG2 XML or XML.gz file")
    args = parser.parse_args()
    print(json.dumps(audit(args.xml), sort_keys=True))


if __name__ == "__main__":
    main()
