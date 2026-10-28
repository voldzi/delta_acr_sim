"""Own isolated OSM fixtures; no provider reads, native execution or activation.

Conditional-tag import and Europe/Prague timezone materialization MUST be
independently verified before any native result is treated as evidence.
"""

def add_time_fixtures(nodes, way, signed):
    cases = []
    scenarios = [
        ('time_unrestricted', {}),
        ('time_private', {'access': 'private'}),
        ('time_oneway', {'oneway': 'yes'}),
        ('time_closed', {'motor_vehicle': 'no'}),
        ('time_denied', {'motor_vehicle:conditional': 'no @ (Mo-Su 08:00-18:00)'}),
        ('time_allowed', {'motor_vehicle': 'no', 'motor_vehicle:conditional': 'yes @ (Mo-Su 08:00-18:00)'}),
        ('time_destination', {'motor_vehicle': 'destination'}),
        ('time_conditional_destination', {'motor_vehicle:conditional': 'destination @ (Mo-Su 08:00-18:00)'}),
        ('time_destination_height', {'motor_vehicle': 'destination', 'maxheight': '2.5'}),
        ('time_conditional_destination_height', {'motor_vehicle:conditional': 'destination @ (Mo-Su 08:00-18:00)', 'maxheight': '2.5'}),
    ]
    for index, (name, restrictions) in enumerate(scenarios):
        # Disconnected seven-node components, with an unrestricted detour.
        x, y = 15 + index * .01, 50
        ids = []
        for dx, dy in [(0, 0), (.001, 0), (.002, 0), (.003, 0), (.001, .002), (.002, .002), (.0015, 0)]:
            node_id = len(nodes) + 1
            ids.append(node_id)
            nodes.append(signed(1, node_id) + signed(8, round((y + dy) * 1e7)) + signed(9, round((x + dx) * 1e7)))
        tags = {'highway': 'secondary', 'surface': 'asphalt', 'maxspeed': '40', 'motor_vehicle': 'yes'}
        wi = 3000 + index * 10
        way(wi, [ids[0], ids[1]], tags)
        way(wi + 1, [ids[1], ids[6], ids[2]], {**tags, **restrictions})
        way(wi + 2, [ids[2], ids[3]], tags)
        way(wi + 3, [ids[1], ids[4], ids[5], ids[2]], tags)
        cases.append({'name': name, 'from': {'lon': x + .0002, 'lat': y},
                      'to': {'lon': x + .0028, 'lat': y},
                      'destinationInside': {'lon': x + .0015, 'lat': y},
                      'restrictedWay': wi + 1, 'detourWay': wi + 3,
                      'syntheticOnly': True, 'restrictionTags': restrictions,
                      'requiresImportInspection': True, 'timezone': 'Europe/Prague'})
    return cases
