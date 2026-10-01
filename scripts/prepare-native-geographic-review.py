#!/usr/bin/env python3
"""Private operator review sheet. No network calls or automatic acceptance."""
import argparse
import gzip
import html
import json
import math
import os
from pathlib import Path


def load(path):
    with gzip.open(path, "rb") as stream: raw = stream.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024: raise ValueError("Private input bound")
    return json.loads(raw)


def run(args):
    root = args.directory
    report = json.loads(args.report.read_text())
    if report.get("automatedPilotPassed") is not True or report.get("approvedForLive") is not False:
        raise ValueError("Expected unapproved successful pilot")
    candidate = load(root / "native-v2-isolated-candidates-20261001.json.gz")
    shapes = load(root / "native-v2-directed-shapes-20261001.json.gz")
    static = load(root / "native-v2-national-static-20261001.json.gz")
    if any(v.get("graphSha256") != report.get("graphSha256") for v in (candidate, shapes)):
        raise ValueError("Private graph mismatch")
    segments = {s["messageId"]: s for s in static["segments"]}
    forward = [p for p in report["pairs"] if p["kind"] == "forward" and p.get("paired") and not p["shapeChanged"]
               and p.get("candidateTargetEdgeCount", 0) > 0]
    if not 4 <= len(forward) <= 16: raise ValueError("Review cohort bound")
    frames = []
    for index, pair in enumerate(forward, 1):
        ident = pair["reference"]; segment = segments[ident]
        paths = [shapes["shapes"][str(e["id"])] for e in candidate["mapping"][ident]]
        points = [p for path in paths for p in path] + segment["coordinates"]
        west, east = min(p[0] for p in points), max(p[0] for p in points)
        south, north = min(p[1] for p in points), max(p[1] for p in points)
        lon, lat = (west+east)/2, (south+north)/2
        cos = math.cos(math.radians(lat))
        xs, ys = [(p[0]-lon)*cos*111320 for p in points], [(p[1]-lat)*111320 for p in points]
        scale = min(660/max(120,max(xs)-min(xs)), 320/max(120,max(ys)-min(ys)))
        def project(point): return (360+(point[0]-lon)*cos*111320*scale, 180-(point[1]-lat)*111320*scale)
        def line(path, color, width, **attr):
            coords = ' '.join(f'{x:.1f},{y:.1f}' for x,y in map(project,path))
            attrs = ' '.join(f'{k}="{html.escape(str(v),quote=True)}"' for k,v in attr.items())
            return f'<polyline fill="none" stroke="{color}" stroke-width="{width}" points="{coords}" {attrs}/>'
        svg = line(segment["coordinates"], '#237ec4', 2, **{'stroke-dasharray':'5 5'})
        for path in paths:
            svg += line(path, '#d73845', 4)
            mid = len(path)//2
            if mid:
                svg += line(path[mid-1:mid+1], '#d73845', 2, **{'marker-end':'url(#arrow)'})
        for i, point in enumerate(segment["coordinates"]):
            x,y = project(point)
            svg += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="#237ec4"/><text x="{x+8:.1f}" y="{y-8:.1f}">{i+1}</text>'
        road_class = segment['openlr']['points'][0]['frc']
        url = f'https://www.openstreetmap.org/#map=18/{lat:.6f}/{lon:.6f}'
        frames.append(f'<section><h2>Úsek {index:02d} · FRC {road_class}</h2>'
            f'<p>Změna času {pair["deltaSeconds"]:+.3f} s, stejná trasa. '
            f'<a href="{url}" target="_blank" rel="noreferrer noopener">Otevřít okolí v OSM</a></p>'
            '<svg viewBox="0 0 720 360" aria-label="Směr kandidátních hran a pořadí referenčních bodů">'
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#d73845"/></marker></defs>'
            f'{svg}</svg><p>Ověřit správnou komunikaci, vozovku, směr, návaznost na nájezdy a koncové body. '
            'OSM odkaz je pouze orientační: nezobrazuje tento překryv a není automatickým schválením.</p></section>')
    document = '<!doctype html><html lang="cs"><meta charset="utf-8"><title>Soukromá geografická kontrola</title>'
    document += '<style>body{font:16px system-ui;max-width:1000px;margin:36px auto;padding:0 20px;color:#183247;background:#f3f6f8}section{background:white;border:1px solid #cbd5df;border-radius:12px;margin:24px 0;padding:22px}svg{width:100%;background:#fbfbfa;border:1px solid #e0e5eb}text{font:15px system-ui;fill:#237ec4}p{line-height:1.6}a{color:#166eb5}</style>'
    document += f'<h1>Soukromá kontrola {len(forward)} pilotních úseků</h1><p>Licencovaná data ŘSD/NDIC. '
    document += 'Nezveřejňovat ani nenahrávat na veřejné služby. Stránka nic nestahuje; OSM se otevře pouze po kliknutí.</p>'
    document += '<p>Červeně: celé směrové hrany kandidáta a orientační šipky. Modře: pořadí referenčních bodů. '
    document += 'Jde o schéma, nikoli mapový podklad; okolní komunikace nejsou zakreslené. Automatický pilot neprokazuje správnost vozovky ani přesnost ETA.</p>'
    document += '<p>Pokud geografii nelze spolehlivě potvrdit, úsek neschválit. Instalační volba '
    document += '<code>--geographic-review-confirmed</code> smí následovat až po skutečné kontrole všech zde uvedených úseků.</p>'
    document += ''.join(frames) + '</html>'
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd,'w') as stream: stream.write(document)
    print(json.dumps({'reviewSectionCount':len(frames),'approvedForLive':False,'automaticNetworkRequests':0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    run(parser.parse_args())
