import type { RoutingCoordinate, RoutingRouteRequest } from "./routing-service.js";
import type { PlanningContext } from "./planning-origin.js";

/** Exact normalized query for closure evidence, not the actor/purpose hash. */
export function planningOrdinaryQuery(context: PlanningContext, coordinate: RoutingCoordinate): RoutingRouteRequest {
  return { profileId: "car", from: { lon: coordinate.lon, lat: coordinate.lat },
    to: { lon: context.destination.lon, lat: context.destination.lat }, vehicleProfile: structuredClone(context.vehicleProfile),
    via: [], avoid: [], alternatives: 1, includeSteps: false, includeRoadAttributes: false,
    includeElevationProfile: false, includeWeatherOnRoute: false, includeHazardsOnRoute: false, includeTraffic: false };
}
