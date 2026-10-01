#include "openlr-native-core.h"
#include <cassert>
#include <iostream>
#include <map>

struct FixtureGraph {
  std::map<uint64_t, sim_openlr::Edge> edges;
  std::set<std::pair<uint64_t, uint64_t>> forbidden;
  sim_openlr::Edge edge(uint64_t id) { return edges.at(id); }
  std::vector<sim_openlr::Edge> outgoing(uint64_t node) {
    std::vector<sim_openlr::Edge> output;
    for (const auto& [id, edge] : edges) if (edge.from == node) output.push_back(edge);
    return output;
  }
  bool allowed_turn(uint64_t a, uint64_t b) {
    const auto& prior = edges.at(a);
    const auto& next = edges.at(b);
    return prior.to == next.from && prior.from != next.to && !forbidden.count({a, b});
  }
  double lower_bound_m(uint64_t, uint64_t) { return 0; }
};
struct QuantizedFixtureGraph : FixtureGraph {
  // Native stored lengths are integer meters. This bound would incorrectly
  // prune a legitimate competing path at the exact upper distance boundary.
  double lower_bound_m(uint64_t node, uint64_t) { return node == 60 ? 68.2 : 0.; }
};

int main() {
  using namespace sim_openlr;
  FixtureGraph graph{{{1, {1, 10, 20, 100, 2}}, {2, {2, 20, 30, 100, 2}},
                      {3, {3, 30, 40, 100, 2}}, {4, {4, 20, 10, 100, 2}}}, {}};
  auto pair = [&](std::vector<Candidate> first, std::vector<Candidate> last, double length,
                  uint32_t mask = 255, Limits limits = {}) {
    return resolve_pair(graph, first, last, length, 1, mask, limits);
  };
  auto same = pair({{1, .1}}, {{1, .9}}, 80);
  assert(same.status == "matched" && same.path.intervals.size() == 1);
  assert(pair({{1, .9}}, {{1, .1}}, 80).status == "unmatched");
  assert(pair({{1, .1}}, {{1, .9}}, 50).status == "unmatched");
  assert(pair({{1, .1}}, {{1, .9}}, 80, 1).status == "unmatched");
  auto multi = pair({{1, .5}}, {{3, .5}}, 200);
  assert(multi.status == "matched" && multi.path.intervals.size() == 3);
  assert(full_edges(multi.path) == std::vector<uint64_t>{2});
  const auto trimmed = trim_offsets(multi.path, 60, 30);
  assert(trimmed.intervals.size() == 2 && std::abs(trimmed.intervals[0].begin - .1) < 1e-8 &&
         std::abs(trimmed.intervals.back().end - .2) < 1e-8);
  bool invalid_offset = false;
  try { trim_offsets(multi.path, 200, 0); } catch (const std::invalid_argument&) { invalid_offset = true; }
  assert(invalid_offset);
  assert(pair({{1, 0}}, {{4, 1}}, 200).status == "unmatched"); // U-turn
  graph.forbidden.insert({1, 2});
  assert(pair({{1, 0}}, {{3, 1}}, 300).status == "unmatched");
  graph.forbidden.clear();
  // A longer competing path must make the reference ambiguous even though
  // a shortest-path query always returns the original 1,2,3 path.
  graph.edges.emplace(5, Edge{5, 20, 50, 49.8, 2});
  graph.edges.emplace(6, Edge{6, 50, 30, 50.7, 2});
  assert(pair({{1, 0}}, {{3, 1}}, 300).status == "ambiguous");
  graph.edges.erase(5); graph.edges.erase(6);
  assert(pair({{1, 0}}, {{3, 1}}, 300, 255, {1, 64, 64}).status == "search_limit");
  graph.edges[2].unsupported = true;
  assert(pair({{1, 0}}, {{3, 1}}, 300).status == "unsupported_restriction");
  graph.edges[2].unsupported = false;
  Path assembled;
  auto first = pair({{1, 0}}, {{2, .5}}, 150);
  auto second = pair({{2, .5}}, {{3, 1}}, 150);
  assert(merge_pair(graph, assembled, first.path) && merge_pair(graph, assembled, second.path));
  assert(assembled.intervals.size() == 3 && full_edges(assembled) == std::vector<uint64_t>({1, 2, 3}));
  Path bad = second.path; bad.intervals[0].begin = .6;
  Path copy = first.path; assert(!merge_pair(graph, copy, bad));
  // Distinct partially-covered paths must stay distinct even if their only
  // fully-covered edge is equal. Do not deduplicate after throwing partials away.
  graph.edges.emplace(7, Edge{7, 9, 20, 100, 2});
  assert(pair({{1, .5}, {7, .5}}, {{3, .5}}, 200).status == "ambiguous");
  QuantizedFixtureGraph quantized;
  quantized.edges = {{1, {1, 10, 20, 10, 2}}, {2, {2, 40, 50, 10, 2}},
    {3, {3, 20, 30, 50, 2}}, {4, {4, 30, 40, 50, 2}},
    {5, {5, 20, 60, 67, 2}}, {6, {6, 60, 40, 68, 2}}};
  assert(resolve_pair(quantized, {{1, 0}}, {{2, 1}}, 120, 35, 255).status == "ambiguous");
  const auto reject_lower = [](const Edge& edge, double, double) { return edge.id != 5 && edge.id != 6; };
  assert(resolve_pair(quantized, {{1, 0}}, {{2, 1}}, 120, 35, 255, {}, reject_lower).status == "matched");
  std::cout << "openlr native core: 20 directed-path/offset/ambiguity/corridor checks passed\n";
}
