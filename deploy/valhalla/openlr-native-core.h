#pragma once

// Independent, bounded OpenLR path/interval logic. The graph implementation
// must provide directed vehicular edges and enforce its native turn rules.
// No traffic archive is modified by this library.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace sim_openlr {
constexpr const char* kDecoderVersion = "openlr-native-v2";
constexpr double kFractionEpsilon = 1e-7;
struct Candidate {
  uint64_t edge;
  double fraction;
  unsigned rank = 0;
};
struct Edge {
  uint64_t id, from, to;
  double meters;
  unsigned frc;
  bool unsupported = false;
};
struct Interval {
  uint64_t edge;
  double begin, end, meters;
};
struct Path {
  std::vector<Interval> intervals;
  double meters = 0;
};
struct Limits {
  size_t expansions = 50000;
  size_t edges = 64;
  size_t candidate_pairs = 64;
};
struct Result {
  std::string status;
  Path path;
  size_t expansions = 0;
};
inline bool valid_fraction(double v) {
  return std::isfinite(v) && v >= 0 && v <= 1;
}
inline bool equal_path(const Path& a, const Path& b) {
  if (a.intervals.size() != b.intervals.size()) return false;
  for (size_t i = 0; i < a.intervals.size(); ++i) {
    const auto& x = a.intervals[i];
    const auto& y = b.intervals[i];
    if (x.edge != y.edge || std::abs(x.begin - y.begin) > kFractionEpsilon ||
        std::abs(x.end - y.end) > kFractionEpsilon) return false;
  }
  return true;
}
inline void append(Path& path, const Edge& edge, double begin, double end) {
  if (!valid_fraction(begin) || !valid_fraction(end) || begin > end ||
      !std::isfinite(edge.meters) || edge.meters <= 0)
    throw std::invalid_argument("invalid edge interval");
  if (end - begin <= kFractionEpsilon) return;
  path.intervals.push_back({edge.id, begin, end, edge.meters});
  path.meters += (end - begin) * edge.meters;
}
inline Path trim_offsets(Path path, double positive_m, double negative_m) {
  if (!std::isfinite(positive_m) || !std::isfinite(negative_m) || positive_m < 0 ||
      negative_m < 0 || positive_m + negative_m >= path.meters)
    throw std::invalid_argument("invalid offsets");
  const double trimmed_meters = path.meters - positive_m - negative_m;
  for (auto& interval : path.intervals) {
    const double take = std::min(positive_m, (interval.end - interval.begin) * interval.meters);
    interval.begin += take / interval.meters;
    positive_m -= take;
  }
  for (auto it = path.intervals.rbegin(); it != path.intervals.rend(); ++it) {
    const double take = std::min(negative_m, (it->end - it->begin) * it->meters);
    it->end -= take / it->meters;
    negative_m -= take;
  }
  path.intervals.erase(std::remove_if(path.intervals.begin(), path.intervals.end(),
    [](const Interval& interval) { return interval.end - interval.begin <= kFractionEpsilon; }),
    path.intervals.end());
  path.meters = trimmed_meters;
  return path;
}
inline std::vector<uint64_t> full_edges(const Path& path) {
  std::vector<uint64_t> result;
  for (const auto& edge : path.intervals)
    if (edge.begin <= kFractionEpsilon && edge.end >= 1 - kFractionEpsilon)
      result.push_back(edge.edge);
  return result;
}

// Exhausts all simple directed paths within the distance/expansion envelope.
// A shortest-path match alone cannot certify that parallel paths are absent.
// If the envelope is exhausted, a unique result is never returned.
// Graph interface: edge(id), outgoing(node), allowed_turn(incoming,next),
// outgoing order must be deterministic.
template <class Graph>
Result resolve_pair(Graph& graph, const std::vector<Candidate>& origins,
                    const std::vector<Candidate>& destinations,
                    double expected_m, double tolerance_m, uint32_t frc_mask,
                    Limits limits = {},
                    const std::function<bool(const Edge&, double, double)>& corridor = {}) {
  if (!std::isfinite(expected_m) || expected_m <= 0 || expected_m > 20000 ||
      !std::isfinite(tolerance_m) || tolerance_m < 0 || tolerance_m > 2000 ||
      origins.empty() || destinations.empty() || origins.size() > 8 || destinations.size() > 8 ||
      origins.size() * destinations.size() > limits.candidate_pairs || !frc_mask)
    return {"invalid_reference", {}, 0};
  std::vector<Path> accepted;
  size_t expansions = 0;
  bool exhausted = false, unsupported = false;
  const double minimum = std::max(0., expected_m - tolerance_m);
  const double maximum = expected_m + tolerance_m;
  auto accept = [&](Path path) {
    if (path.meters < minimum || path.meters > maximum || path.intervals.empty()) return;
    if (std::none_of(accepted.begin(), accepted.end(), [&](const Path& prior) { return equal_path(prior, path); }))
      accepted.push_back(std::move(path));
  };
  auto compatible = [&](const Edge& edge) {
    return edge.frc < 8 && (frc_mask & (1u << edge.frc)) &&
           std::isfinite(edge.meters) && edge.meters > 0;
  };
  for (const auto& origin : origins) {
    for (const auto& destination : destinations) {
      if (!valid_fraction(origin.fraction) || !valid_fraction(destination.fraction) ||
          origin.rank > 1 || destination.rank > 1) continue;
      const auto source = graph.edge(origin.edge), target = graph.edge(destination.edge);
      if (!compatible(source) || !compatible(target)) continue;
      if (source.id == target.id) {
        if (destination.fraction > origin.fraction &&
            (!corridor || corridor(source, origin.fraction, destination.fraction))) {
          if (source.unsupported) { unsupported = true; continue; }
          Path path;
          append(path, source, origin.fraction, destination.fraction);
          accept(std::move(path));
        }
        if (accepted.size() > 1) return {"ambiguous", {}, expansions};
        continue;
      }
      if (corridor && (!corridor(source, origin.fraction, 1) || !corridor(target, 0, destination.fraction))) continue;
      if (source.unsupported || target.unsupported) { unsupported = true; continue; }
      Path start;
      append(start, source, origin.fraction, 1);
      const double end_m = target.meters * destination.fraction;
      std::set<uint64_t> visited{source.from, source.to};
      auto visit = [&](auto&& self, uint64_t node, uint64_t incoming, Path path) -> void {
        if (accepted.size() > 1 || exhausted) return;
        if (++expansions > limits.expansions) { exhausted = true; return; }
        if (path.intervals.size() >= limits.edges) { exhausted = true; return; }
        // A geodesic bound is not strictly admissible against quantized
        // DirectedEdge.length() weights. Do not prune a competing path on it.
        if (path.meters + end_m > maximum) return;
        if (node == target.from) {
          // No U-turn or closing loop at the last edge either.
          if (target.to == source.from || (destination.fraction > kFractionEpsilon && visited.count(target.to)) ||
              !graph.allowed_turn(incoming, target.id)) return;
          append(path, target, 0, destination.fraction);
          accept(std::move(path));
          return;
        }
        for (const auto& next : graph.outgoing(node)) {
          if (!compatible(next) || next.id == target.id || visited.count(next.to) ||
              (corridor && !corridor(next, 0, 1)) ||
              !graph.allowed_turn(incoming, next.id)) continue;
          if (next.unsupported) { unsupported = true; continue; }
          if (path.meters + next.meters + end_m > maximum) continue;
          visited.insert(next.to);
          Path extended = path;
          append(extended, next, 0, 1);
          self(self, next.to, next.id, std::move(extended));
          visited.erase(next.to);
          if (accepted.size() > 1 || exhausted) return;
        }
      };
      visit(visit, source.to, source.id, std::move(start));
      if (accepted.size() > 1) return {"ambiguous", {}, expansions};
      if (exhausted) return {"search_limit", {}, expansions};
    }
  }
  if (unsupported) return {"unsupported_restriction", {}, expansions};
  if (accepted.empty()) return {"unmatched", {}, expansions};
  return {"matched", std::move(accepted.front()), expansions};
}

template <class Graph> bool merge_pair(Graph& graph, Path& all, const Path& next) {
  if (next.intervals.empty()) return false;
  if (all.intervals.empty()) { all = next; return true; }
  const auto& first = next.intervals.front();
  auto& last = all.intervals.back();
  size_t begin = 0;
  if (last.edge == first.edge) {
    if (std::abs(last.end - first.begin) > kFractionEpsilon) return false;
    last.end = first.end;
    begin = 1;
  } else if (last.end < 1 - kFractionEpsilon || first.begin > kFractionEpsilon ||
             graph.edge(last.edge).to != graph.edge(first.edge).from ||
             !graph.allowed_turn(last.edge, first.edge)) return false;
  for (size_t i = begin; i < next.intervals.size(); ++i) all.intervals.push_back(next.intervals[i]);
  all.meters += next.meters;
  // Multi-LRP references must not silently create a cycle.
  std::set<uint64_t> ids;
  std::set<uint64_t> nodes{graph.edge(all.intervals.front().edge).from};
  for (const auto& interval : all.intervals)
    if (!ids.insert(interval.edge).second || !nodes.insert(graph.edge(interval.edge).to).second) return false;
  return true;
}
} // namespace sim_openlr
