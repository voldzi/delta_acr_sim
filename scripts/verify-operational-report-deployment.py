#!/usr/bin/env python3
"""Secret-safe checks for the narrow main API deployment; run on Docker host."""
import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Unexpected API redirect; protected acceptance refuses redirects')


def command(*args):
    return subprocess.check_output(args, cwd='/srv/sim', timeout=30, stderr=subprocess.DEVNULL)


def container():
    return json.loads(command('docker', 'inspect', 'csm-sim-api'))[0]


def other_containers(project):
    ids = command('docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}').decode().split()
    data = json.loads(command('docker', 'inspect', *ids)) if ids else []
    return {item['Name']: {'id': item['Id'], 'startedAt': item['State']['StartedAt']}
            for item in data if item['Name'] != '/csm-sim-api'}


def verify_environment(current):
    compose = json.loads(command('docker', 'compose', 'config', '--format', 'json'))
    expected = compose['services']['sim-api'].get('environment', {})
    actual = dict(value.split('=', 1) for value in current['Config']['Env'] if '=' in value)
    if any(actual.get(key) != str(value if value is not None else '') for key, value in expected.items()):
        raise RuntimeError('Compose/runtime environment mismatch; refusing main API recreation')
    if actual.get('SIM_OPERATIONS_REPORT_FILE') != '/data/operational-checks/latest.json':
        raise RuntimeError('Unexpected operational report configuration')
    mounts = [m for m in current['Mounts'] if m['Destination'] == '/data']
    if len(mounts) != 1 or mounts[0]['Source'] != '/srv/x5-production/data/csm-sim/sim-data':
        raise RuntimeError('Unexpected main API data bind')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['snapshot', 'accept'])
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    current = container()
    verify_environment(current)
    project = current['Config']['Labels']['com.docker.compose.project']
    if args.mode == 'snapshot':
        args.manifest.write_text(json.dumps({
            'createdAt': datetime.now(timezone.utc).isoformat(), 'previousImage': current['Image'],
            'project': project, 'otherContainers': other_containers(project)
        }, indent=2) + '\n')
        args.manifest.chmod(0o600)
        print(json.dumps({'composeEnvironmentMatches': True, 'snapshotCreated': True}))
        return
    original = json.loads(args.manifest.read_text())
    other = other_containers(project)
    previous = original['otherContainers']
    if set(other) != set(previous):
        raise RuntimeError('An unrelated SIM container changed during the narrow deployment')
    for name, value in other.items():
        expected = previous[name]
        if isinstance(expected, str):
            # Compatibility with the first installed ID-only manifest. Prove
            # the current start predates the snapshot instead of assuming it.
            started = datetime.fromisoformat(value['startedAt'].replace('Z', '+00:00'))
            if value['id'] != expected or started > datetime.fromisoformat(original['createdAt']):
                raise RuntimeError('An unrelated SIM container was recreated or restarted')
        elif value != expected:
            raise RuntimeError('An unrelated SIM container was recreated or restarted')
    # Existing service credentials stay in memory only; never print/read .env values.
    env = dict(value.split('=', 1) for value in current['Config']['Env'] if '=' in value)
    token = env.get('SIM_API_INTERNAL_TOKEN') or env.get('SIM_API_ADMIN_TOKEN')
    if not token:
        raise RuntimeError('No existing internal credential for acceptance')
    request = Request('http://127.0.0.1:5020/api/v1/operations/summary',
                      headers={'Accept': 'application/json', 'Authorization': f'Bearer {token}'})
    with build_opener(NoRedirect).open(request, timeout=30) as response:
        payload = json.load(response)
    report = json.loads(Path('/srv/x5-production/data/csm-sim/sim-data/operational-checks/latest.json').read_text())
    operational = payload.get('operationalCheck') or {}
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(report['finishedAt'].replace('Z', '+00:00'))).total_seconds()
    if not -30 <= age <= 900 or operational.get('finishedAt') != report['finishedAt']:
        raise RuntimeError('Real operational report not fresh and visible through SIM API')
    if operational.get('status') != report['status']:
        raise RuntimeError('Operational status differs between disk and API')
    if report['status'] == 'failed' and not any(alert.get('code') == 'operational_check_failed' for alert in payload.get('alerts', [])):
        raise RuntimeError('Existing operational failure alert is missing')
    if current.get('State', {}).get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('Main API is not healthy')
    print(json.dumps({
        'apiReportVisible': True, 'finishedAt': report['finishedAt'], 'operationalStatus': operational.get('status'),
        'operationalAlertVisible': any(alert.get('code') == 'operational_check_failed' for alert in payload.get('alerts', [])),
        'valhallaCheckVisible': 'valhallaUpdates' in report.get('checks', {}),
        'unrelatedSimContainersUnchanged': True, 'image': current['Image']
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not expose provider error bodies, token values or command output.
        print(f'Operational deployment verification failed: {type(error).__name__}')
        raise SystemExit(1)
