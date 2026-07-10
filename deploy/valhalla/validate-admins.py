#!/usr/bin/env python3
"""Validate the country coverage of a Valhalla admins.sqlite database."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


EXPECTED_COUNTRIES = {"AT", "CZ", "DE", "HU", "PL", "SK"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--min-areas", type=int, default=60)
    args = parser.parse_args()

    if not args.database.is_file() or args.database.stat().st_size == 0:
        print(f"admin database is missing or empty: {args.database}")
        return 1

    try:
        with sqlite3.connect(f"file:{args.database}?mode=ro", uri=True) as database:
            rows = database.execute(
                "SELECT upper(iso_code) FROM admins WHERE admin_level = 2 AND iso_code IS NOT NULL"
            ).fetchall()
            area_count = database.execute("SELECT count(*) FROM admins").fetchone()[0]
    except (sqlite3.Error, OSError) as exc:
        print(f"cannot inspect admin database: {exc}")
        return 1

    countries = {str(row[0]).split("-")[0] for row in rows if row and row[0]}
    missing = sorted(EXPECTED_COUNTRIES.difference(countries))
    if missing:
        print(f"admin database is missing countries: {', '.join(missing)}; found: {', '.join(sorted(countries))}")
        return 1
    if area_count < args.min_areas:
        print(f"admin database has only {area_count} areas; at least {args.min_areas} required")
        return 1

    print(f"admin database contains {len(countries)} countries and {area_count} areas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
