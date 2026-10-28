// Source-only request plan. Deliberately performs no HTTP, Docker or provider I/O.
import { readFileSync } from 'node:fs';
import { mappedCostOptions, mappedCosting, parseMappedProfile } from '../apps/situation-data-api/dist/mapped-road-profile.js';
const fixtures = JSON.parse(readFileSync(process.argv[2], 'utf8')).filter(c => c.name.startsWith('time_'));
if (fixtures.length !== 10 || new Set(fixtures.map(c => c.name)).size !== 10) throw new Error('EXACT_SYNTHETIC_FIXTURES_REQUIRED');
const cases = [];
for (const c of fixtures) for (const heightM of [2, 3]) for (const reverse of [false, true]) {
  const profile = { version: 'sim-mapped-road-profile-v1', intent: 'car', coverageAcknowledged: 'mapped_restrictions_incomplete',
    vehicle: { heightM, widthM: 2, lengthM: 5, loadedWeightKg: 3000 } };
  for (const mode of ['none', 'depart_now', 'active_fixed', 'inactive_fixed']) {
    const [from, to] = reverse ? [c.to, c.from] : [c.from, c.to];
    parseMappedProfile({ profileId: 'car', vehicleProfile: profile, from, to });
    const costing = mappedCosting(profile);
    const request = { locations: [from, to].map(p => ({ ...p, minimum_reachability: 1, radius: 10, search_cutoff: 25 })),
      costing, costing_options: { [costing]: mappedCostOptions(profile) }, units: 'kilometers' };
    if (mode === 'depart_now') request.date_time = { type: 0 };
    if (mode === 'active_fixed') request.date_time = { type: 1, value: '2026-10-28T12:00' };
    if (mode === 'inactive_fixed') request.date_time = { type: 1, value: '2026-10-28T22:00' };
    // Physical/explicit access exclusions remain obligations in every time mode.
    // Destination-only and conditional multipass outcomes are observations, not
    // permission to accept warning401 or to relax any production protection.
    const forbidden = c.name === 'time_private' || c.name === 'time_closed' ||
      (c.name === 'time_oneway' && reverse) ||
      (c.name.endsWith('_height') && heightM > 2.5) ||
      (c.name === 'time_denied' && mode === 'active_fixed') ||
      (c.name === 'time_allowed' && mode === 'inactive_fixed');
    cases.push({ name: `${c.name}-${heightM}-${reverse ? 'reverse' : 'forward'}-${mode}`, fixture: c.name,
      requestedMode: mode, restrictedWay: c.restrictedWay, detourWay: c.detourWay,
      forbiddenRestrictedWay: forbidden, requiresWarningInspection: true, request });
  }
}
process.stdout.write(JSON.stringify({ contract: 'sim-routing-time-fixture-plan-v1', syntheticOnly: true,
  engineExecutionAuthorized: false, productionAcceptance: false,
  prerequisites: ['verified_3.8.3_image', 'conditional_tags_materialized', 'Europe/Prague_timezone_materialized',
    'isolated_network_none', 'reviewed_resource_and_deadline_limits'],
  routeRequestCount: cases.length, traceRequestUpperBound: cases.length, cases }));
