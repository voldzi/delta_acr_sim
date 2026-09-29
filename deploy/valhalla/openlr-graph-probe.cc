#include <boost/property_tree/json_parser.hpp>
#include <valhalla/baldr/graphreader.h>

#include <cstdint>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <limits>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

using valhalla::baldr::GraphId;
using valhalla::baldr::GraphReader;

struct Corridor {
  std::vector<std::vector<std::pair<double, double>>> parts;
  double radius_m = 100;
};

double corridor_point_distance_m(double lon, double lat, const Corridor& corridor) {
  const double lon_scale = 111320.0 * std::cos(lat * 3.14159265358979323846 / 180.0);
  double best = std::numeric_limits<double>::infinity();
  for (const auto& part : corridor.parts) {
    for (size_t i = 1; i < part.size(); ++i) {
      const double ax = (part[i - 1].first - lon) * lon_scale;
      const double ay = (part[i - 1].second - lat) * 111320.0;
      const double bx = (part[i].first - lon) * lon_scale;
      const double by = (part[i].second - lat) * 111320.0;
      const double dx = bx - ax, dy = by - ay;
      const double squared = dx * dx + dy * dy;
      const double t = squared > 0 ? std::clamp(-(ax * dx + ay * dy) / squared, 0.0, 1.0) : 0.0;
      best = std::min(best, std::hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

bool edge_in_corridor(GraphReader& reader, const GraphId& id,
                      const valhalla::baldr::DirectedEdge* edge, const Corridor& corridor,
                      std::unordered_map<uint64_t, bool>& cache) {
  if (const auto found = cache.find(id.value); found != cache.end()) return found->second;
  auto tile = reader.GetGraphTile(id);
  if (!tile || !edge) return cache[id.value] = false;
  const auto shape = tile->edgeinfo(edge).shape();
  if (shape.size() < 2) return cache[id.value] = false;
  for (const auto& point : shape) {
    if (corridor_point_distance_m(point.lng(), point.lat(), corridor) > corridor.radius_m)
      return cache[id.value] = false;
  }
  return cache[id.value] = true;
}

struct PathResult {
  std::vector<uint64_t> edges;
  double length_m = 0;
};

PathResult bounded_path(GraphReader& reader, uint64_t source_value, double source_percent,
                        uint64_t target_value, double target_percent, double max_m,
                        uint32_t road_classes, const Corridor* corridor = nullptr) {
  PathResult empty;
  if (!std::isfinite(source_percent) || !std::isfinite(target_percent) ||
      !std::isfinite(max_m) || source_percent < 0 || source_percent > 1 ||
      target_percent < 0 || target_percent > 1 || max_m <= 0 || max_m > 20000) {
    return empty;
  }
  const GraphId source_id(source_value), target_id(target_value);
  auto source_tile = reader.GetGraphTile(source_id);
  auto target_tile = reader.GetGraphTile(target_id);
  if (!source_tile || !target_tile) return empty;
  const auto* source_edge = source_tile->directededge(source_id);
  const auto* target_edge = target_tile->directededge(target_id);
  if (!source_edge || !target_edge) return empty;
  std::unordered_map<uint64_t, bool> corridor_cache;
  if (corridor && (!edge_in_corridor(reader, source_id, source_edge, *corridor, corridor_cache) ||
                   !edge_in_corridor(reader, target_id, target_edge, *corridor, corridor_cache))) return empty;
  if (source_value == target_value) {
    if (!corridor) return empty; // Preserve the legacy audit probe's behavior.
    const double length_m = (target_percent - source_percent) * source_edge->length();
    if (target_percent > source_percent && length_m <= max_m &&
        (source_edge->forwardaccess() & valhalla::baldr::kAutoAccess) &&
        (road_classes & (1u << static_cast<unsigned>(source_edge->classification()))) &&
        !source_edge->access_restriction() && !source_edge->part_of_complex_restriction())
      return {{source_value}, length_m};
    return empty;
  }
  const auto target_nodes = reader.GetDirectedEdgeNodes(target_tile, target_edge);
  if (!target_nodes.first.is_valid()) return empty;
  const double start_cost = (1 - source_percent) * source_edge->length();
  const double end_cost = target_percent * target_edge->length();
  if (start_cost + end_cost > max_m) return empty;
  if (!(source_edge->forwardaccess() & valhalla::baldr::kAutoAccess) ||
      !(target_edge->forwardaccess() & valhalla::baldr::kAutoAccess) ||
      !(road_classes & (1u << static_cast<unsigned>(source_edge->classification()))) ||
      !(road_classes & (1u << static_cast<unsigned>(target_edge->classification()))) ||
      source_edge->access_restriction() || target_edge->access_restriction() ||
      source_edge->part_of_complex_restriction() || target_edge->part_of_complex_restriction()) return empty;

  struct QueueItem { double cost; uint64_t incoming; uint64_t node; };
  struct Greater { bool operator()(const QueueItem& a, const QueueItem& b) const { return a.cost > b.cost; } };
  std::priority_queue<QueueItem, std::vector<QueueItem>, Greater> queue;
  std::unordered_map<uint64_t, double> distance;
  std::unordered_map<uint64_t, uint64_t> parent;
  queue.push({start_cost, source_value, source_edge->endnode().value});
  distance[source_value] = start_cost;
  constexpr size_t max_expansions = 10000;
  size_t expansions = 0;
  while (!queue.empty() && ++expansions <= max_expansions) {
    const QueueItem current = queue.top();
    queue.pop();
    if (current.cost > distance[current.incoming] || current.cost + end_cost > max_m) continue;
    const auto* incoming_edge = reader.directededge(GraphId(current.incoming));
    if (!incoming_edge) continue;
    if (current.node == target_nodes.first.value) {
      if (reader.GetOpposingEdgeId(GraphId(current.incoming)).value == target_value ||
          (incoming_edge->restrictions() & (1u << target_edge->localedgeidx()))) continue;
      std::vector<uint64_t> reverse{target_value};
      uint64_t id = current.incoming;
      while (id != source_value) {
        reverse.push_back(id);
        id = parent.at(id);
      }
      reverse.push_back(source_value);
      std::reverse(reverse.begin(), reverse.end());
      return {reverse, current.cost + end_cost};
    }
    const GraphId node_id(current.node);
    auto tile = reader.GetGraphTile(node_id);
    if (!tile) continue;
    const auto* node = tile->node(node_id);
    if (!node || !(node->access() & valhalla::baldr::kAutoAccess)) continue;
    const uint64_t opposite = reader.GetOpposingEdgeId(GraphId(current.incoming)).value;
    for (uint32_t index = node->edge_index(); index < node->edge_index() + node->edge_count(); ++index) {
      const GraphId next_id(node_id.tileid(), node_id.level(), index);
      const auto* edge = tile->directededge(next_id);
      if (!edge || next_id.value == opposite || edge->is_shortcut() ||
          (incoming_edge->restrictions() & (1u << edge->localedgeidx())) ||
          !(edge->forwardaccess() & valhalla::baldr::kAutoAccess) ||
          edge->access_restriction() || edge->part_of_complex_restriction() ||
          !(road_classes & (1u << static_cast<unsigned>(edge->classification())))) continue;
      if (corridor && !edge_in_corridor(reader, next_id, edge, *corridor, corridor_cache)) continue;
      const double next_cost = current.cost + edge->length();
      if (next_cost + end_cost > max_m) continue;
      const auto known = distance.find(next_id.value);
      if (known == distance.end() || next_cost < known->second) {
        distance[next_id.value] = next_cost;
        parent[next_id.value] = current.incoming;
        queue.push({next_cost, next_id.value, edge->endnode().value});
      }
    }
  }
  return empty;
}

int main(int argc, char* argv[]) {
  if (argc != 3) {
    std::cerr << "usage: openlr-graph-probe VALHALLA_JSON EDGE_ID|--stream|--corridor-stream\n";
    return 2;
  }
  try {
    boost::property_tree::ptree config;
    boost::property_tree::read_json(argv[1], config);
    valhalla::baldr::GraphReader reader(config.get_child("mjolnir"));
    if (std::string(argv[2]) == "--corridor-stream") {
      std::string line;
      while (std::getline(std::cin, line)) {
        uint64_t request_id = 0;
        try {
          boost::property_tree::ptree request;
          std::istringstream input(line);
          boost::property_tree::read_json(input, request);
          request_id = request.get<uint64_t>("requestId");
          Corridor corridor;
          corridor.radius_m = request.get<double>("corridorRadiusMeters");
          if (!std::isfinite(corridor.radius_m) || corridor.radius_m < 10 || corridor.radius_m > 150)
            throw std::runtime_error("invalid corridor radius");
          size_t vertices = 0;
          for (const auto& part_value : request.get_child("corridorParts")) {
            std::vector<std::pair<double, double>> part;
            for (const auto& point_value : part_value.second) {
              auto it = point_value.second.begin();
              if (it == point_value.second.end()) throw std::runtime_error("missing longitude");
              const double lon = it->second.get_value<double>();
              if (++it == point_value.second.end()) throw std::runtime_error("missing latitude");
              const double lat = it->second.get_value<double>();
              if (!std::isfinite(lon) || !std::isfinite(lat) || lon < 11 || lon > 20 || lat < 48 || lat > 52)
                throw std::runtime_error("invalid corridor coordinate");
              part.emplace_back(lon, lat);
              if (++vertices > 4000) throw std::runtime_error("corridor too large");
            }
            if (part.size() >= 2) corridor.parts.push_back(std::move(part));
          }
          if (corridor.parts.empty()) throw std::runtime_error("empty corridor");
          const auto path = bounded_path(
              reader, request.get<uint64_t>("sourceEdge"), request.get<double>("sourcePercent"),
              request.get<uint64_t>("targetEdge"), request.get<double>("targetPercent"),
              request.get<double>("maxMeters"), request.get<uint32_t>("roadClasses"), &corridor);
          if (path.edges.empty()) {
            std::cout << "{\"requestId\":" << request_id << ",\"status\":\"no_path\"}\n";
          } else {
            std::cout << "{\"requestId\":" << request_id
                      << ",\"status\":\"ok\",\"lengthMeters\":" << path.length_m
                      << ",\"edges\":[";
            for (size_t i = 0; i < path.edges.size(); ++i) {
              if (i) std::cout << ',';
              std::cout << path.edges[i];
            }
            std::cout << "],\"edgeLengthsMeters\":[";
            for (size_t i = 0; i < path.edges.size(); ++i) {
              if (i) std::cout << ',';
              const auto* edge = reader.directededge(GraphId(path.edges[i]));
              if (!edge) throw std::runtime_error("path edge unavailable");
              std::cout << edge->length();
            }
            std::cout << "]}\n";
          }
        } catch (const std::exception&) {
          std::cout << "{\"requestId\":" << request_id << ",\"status\":\"invalid_or_failed\"}\n";
        }
        std::cout << std::flush;
      }
      return 0;
    }
    if (std::string(argv[2]) == "--stream") {
      std::string line;
      while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        uint64_t request_id, source_id, target_id;
        double source_percent, target_percent, max_m;
        uint32_t classes;
        if (!(input >> request_id >> source_id >> source_percent >> target_id >> target_percent >> max_m >> classes)) {
          std::cout << "{\"requestId\":0,\"status\":\"invalid_input\"}\n" << std::flush;
          continue;
        }
        try {
          const auto path = bounded_path(reader, source_id, source_percent, target_id,
                                         target_percent, max_m, classes);
          if (path.edges.empty()) {
            std::cout << "{\"requestId\":" << request_id << ",\"status\":\"no_path\"}\n";
          } else {
            std::vector<double> lengths_m;
            lengths_m.reserve(path.edges.size());
            for (const auto value : path.edges) {
              const auto* edge = reader.directededge(GraphId(value));
              if (!edge) throw std::runtime_error("path edge is unavailable");
              lengths_m.push_back(edge->length());
            }
            std::cout << "{\"requestId\":" << request_id
                      << ",\"status\":\"ok\",\"lengthMeters\":" << path.length_m
                      << ",\"edges\":[";
            for (size_t i = 0; i < path.edges.size(); ++i) {
              if (i) std::cout << ',';
              std::cout << path.edges[i];
            }
            std::cout << "],\"edgeLengthsMeters\":[";
            for (size_t i = 0; i < lengths_m.size(); ++i) {
              if (i) std::cout << ',';
              std::cout << lengths_m[i];
            }
            std::cout << "]}\n";
          }
        } catch (const std::exception&) {
          std::cout << "{\"requestId\":" << request_id << ",\"status\":\"graph_error\"}\n";
        }
        std::cout << std::flush;
      }
      return 0;
    }
    valhalla::baldr::GraphId id(std::stoull(argv[2]));
    const auto* edge = reader.directededge(id);
    if (!edge) {
      std::cerr << "edge unavailable\n";
      return 1;
    }
    std::cout << "{\"edgeId\":" << id.value << ",\"lengthMeters\":" << edge->length()
              << ",\"roadClass\":" << static_cast<unsigned>(edge->classification())
              << ",\"endNode\":" << edge->endnode().value << "}\n";
  } catch (const std::exception& error) {
    std::cerr << "graph probe failed: " << error.what() << '\n';
    return 1;
  }
}
