#include <boost/property_tree/json_parser.hpp>
#include <valhalla/baldr/graphreader.h>

#include <cstdint>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <limits>
#include <queue>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

using valhalla::baldr::GraphId;
using valhalla::baldr::GraphReader;

struct PathResult {
  std::vector<uint64_t> edges;
  double length_m = 0;
};

PathResult bounded_path(GraphReader& reader, uint64_t source_value, double source_percent,
                        uint64_t target_value, double target_percent, double max_m,
                        uint32_t road_classes) {
  PathResult empty;
  if (!std::isfinite(source_percent) || !std::isfinite(target_percent) ||
      !std::isfinite(max_m) || source_percent < 0 || source_percent > 1 ||
      target_percent < 0 || target_percent > 1 || max_m <= 0 || max_m > 20000 ||
      source_value == target_value) {
    return empty;
  }
  const GraphId source_id(source_value), target_id(target_value);
  auto source_tile = reader.GetGraphTile(source_id);
  auto target_tile = reader.GetGraphTile(target_id);
  if (!source_tile || !target_tile) return empty;
  const auto* source_edge = source_tile->directededge(source_id);
  const auto* target_edge = target_tile->directededge(target_id);
  if (!source_edge || !target_edge) return empty;
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
    std::cerr << "usage: openlr-graph-probe VALHALLA_JSON EDGE_ID|--stream\n";
    return 2;
  }
  try {
    boost::property_tree::ptree config;
    boost::property_tree::read_json(argv[1], config);
    valhalla::baldr::GraphReader reader(config.get_child("mjolnir"));
    if (std::string(argv[2]) == "--stream") {
      std::string line;
      while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        uint64_t source_id, target_id;
        double source_percent, target_percent, max_m;
        uint32_t classes;
        if (!(input >> source_id >> source_percent >> target_id >> target_percent >> max_m >> classes)) {
          std::cout << "{\"status\":\"invalid_input\"}\n" << std::flush;
          continue;
        }
        try {
          const auto path = bounded_path(reader, source_id, source_percent, target_id,
                                         target_percent, max_m, classes);
          if (path.edges.empty()) {
            std::cout << "{\"status\":\"no_path\"}\n";
          } else {
            std::cout << "{\"status\":\"ok\",\"lengthMeters\":" << path.length_m
                      << ",\"edges\":[";
            for (size_t i = 0; i < path.edges.size(); ++i) {
              if (i) std::cout << ',';
              std::cout << path.edges[i];
            }
            std::cout << "]}\n";
          }
        } catch (const std::exception&) {
          std::cout << "{\"status\":\"graph_error\"}\n";
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
