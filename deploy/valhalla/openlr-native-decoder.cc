// Version-pinned, offline OpenLR decoder. Uses Valhalla's native Loki search
// and AutoCost access/turn validation; exhaustively searches bounded detailed
// graph paths by distance so a first shortest route is not mistaken for a
// unique location. It never opens a traffic archive for writing.
#include "openlr-native-core.h"
#include <boost/property_tree/json_parser.hpp>
#include <valhalla/baldr/graphreader.h>
#include <valhalla/loki/search.h>
#include <valhalla/sif/autocost.h>
#include <valhalla/sif/edgelabel.h>
#include <openssl/evp.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>

using valhalla::baldr::GraphId;
using valhalla::baldr::GraphReader;
namespace fs = std::filesystem;
using sim_openlr::Candidate;
using sim_openlr::Edge;
using sim_openlr::Path;
struct UnsupportedHierarchy : std::runtime_error {
  UnsupportedHierarchy() : std::runtime_error("hierarchy transition requires native expansion") {}
};

std::string file_sha256(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("graph extract unavailable");
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!ctx || EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1)
    throw std::runtime_error("graph hash unavailable");
  char buffer[1 << 20];
  while (input) {
    input.read(buffer, sizeof(buffer));
    if (input.gcount() && EVP_DigestUpdate(ctx.get(), buffer, input.gcount()) != 1)
      throw std::runtime_error("graph hash failed");
  }
  if (!input.eof()) throw std::runtime_error("graph read failed");
  unsigned char digest[EVP_MAX_MD_SIZE]; unsigned size = 0;
  if (EVP_DigestFinal_ex(ctx.get(), digest, &size) != 1)
    throw std::runtime_error("graph hash failed");
  std::ostringstream output;
  for (unsigned i = 0; i < size; ++i) output << std::hex << std::setw(2) << std::setfill('0') << unsigned(digest[i]);
  return output.str();
}
bool hash_string(const std::string& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}
void exact_keys(const rapidjson::Value& value, const std::set<std::string>& keys) {
  if (!value.IsObject()) throw std::invalid_argument("invalid structure");
  std::set<std::string> seen;
  for (auto it = value.MemberBegin(); it != value.MemberEnd(); ++it)
    if (!keys.count(it->name.GetString()) || !seen.insert(it->name.GetString()).second)
      throw std::invalid_argument("unknown or duplicate field");
}
double number(const rapidjson::Value& value, const char* key, double lower, double upper) {
  if (!value.HasMember(key) || !value[key].IsNumber()) throw std::invalid_argument("missing number");
  const double output = value[key].GetDouble();
  if (!std::isfinite(output) || output < lower || output > upper) throw std::invalid_argument("invalid number");
  return output;
}
unsigned integer(const rapidjson::Value& value, const char* key, unsigned lower, unsigned upper) {
  if (!value.HasMember(key) || !value[key].IsUint()) throw std::invalid_argument("missing integer");
  const unsigned output = value[key].GetUint();
  if (output < lower || output > upper) throw std::invalid_argument("invalid integer");
  return output;
}
std::string text_field(const rapidjson::Value& value, const char* key) {
  if (!value.HasMember(key) || !value[key].IsString()) throw std::invalid_argument("missing text");
  return value[key].GetString();
}

struct Lrp {
  double lon, lat, bearing;
  unsigned frc, fow;
  double distance = 0;
  unsigned lowest_frc = 7;
};
struct Corridor {
  std::string revision;
  double tolerance_m = 0;
  std::vector<std::vector<valhalla::midgard::PointLL>> parts;
};
double corridor_distance(const valhalla::midgard::PointLL& point, const Corridor& corridor) {
  const double x_scale = 111320. * std::cos(point.lat() * std::acos(-1.) / 180.);
  double best = std::numeric_limits<double>::infinity();
  for (const auto& part : corridor.parts) for (size_t i = 1; i < part.size(); ++i) {
    const double ax = (part[i - 1].lng() - point.lng()) * x_scale;
    const double ay = (part[i - 1].lat() - point.lat()) * 111320.;
    const double dx = (part[i].lng() - part[i - 1].lng()) * x_scale;
    const double dy = (part[i].lat() - part[i - 1].lat()) * 111320.;
    const double t = dx * dx + dy * dy > 0 ? std::clamp(-(ax * dx + ay * dy) / (dx * dx + dy * dy), 0., 1.) : 0.;
    best = std::min(best, std::hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
Corridor parse_corridor(const rapidjson::Value& value) {
  exact_keys(value, {"revision", "toleranceMeters", "parts"});
  Corridor output;
  output.revision = text_field(value, "revision");
  if (!hash_string(output.revision)) throw std::invalid_argument("invalid corridor revision");
  output.tolerance_m = number(value, "toleranceMeters", 10, 100);
  if (!value.HasMember("parts") || !value["parts"].IsArray() ||
      value["parts"].Empty() || value["parts"].Size() > 16) throw std::invalid_argument("invalid corridor parts");
  size_t count = 0;
  for (const auto& part : value["parts"].GetArray()) {
    if (!part.IsArray() || part.Size() < 2 || (count += part.Size()) > 512)
      throw std::invalid_argument("invalid corridor point limit");
    std::vector<valhalla::midgard::PointLL> points;
    for (const auto& point : part.GetArray()) {
      if (!point.IsArray() || point.Size() != 2 || !point[0].IsNumber() || !point[1].IsNumber())
        throw std::invalid_argument("invalid corridor coordinate");
      const double lon = point[0].GetDouble(), lat = point[1].GetDouble();
      if (!std::isfinite(lon) || !std::isfinite(lat) || lon < -180 || lon > 180 || lat < -85 || lat > 85)
        throw std::invalid_argument("invalid corridor coordinate");
      points.emplace_back(lon, lat);
    }
    output.parts.push_back(std::move(points));
  }
  return output;
}
// FRC categories of different map vendors are not identical. Rank zero is
// the declared category, rank one an adjacent category; larger discrepancies
// are rejected. The same versioned mapping is used for LFRCNP traversal.
unsigned road_rank(unsigned declared, unsigned actual) {
  return declared > actual ? declared - actual : actual - declared;
}
uint32_t lowest_mask(unsigned declared) {
  const unsigned limit = std::min(7u, declared + 1);
  return (1u << (limit + 1)) - 1;
}

class NativeGraph {
public:
  GraphReader& reader;
  valhalla::sif::cost_ptr_t cost;
  explicit NativeGraph(GraphReader& r) : reader(r) {
    valhalla::Costing options;
    rapidjson::Document defaults;
    defaults.Parse("{}");
    google::protobuf::RepeatedPtrField<valhalla::CodedDescription> warnings;
    valhalla::sif::ParseAutoCostOptions(defaults, "/costing_options/auto", &options, warnings);
    options.set_type(valhalla::Costing::auto_);
    options.mutable_options()->set_shortest(true);
    options.mutable_options()->set_ignore_closures(true);
    cost = valhalla::sif::CreateAutoCost(options);
  }
  Edge edge(uint64_t value) {
    const GraphId id(value);
    auto tile = reader.GetGraphTile(id);
    if (!tile || id.id() >= tile->header()->directededgecount()) throw std::runtime_error("edge unavailable");
    const auto* native = tile->directededge(id);
    const auto nodes = reader.GetDirectedEdgeNodes(tile, native);
    if (!nodes.first.is_valid() || !nodes.second.is_valid()) throw std::runtime_error("edge nodes unavailable");
    return {id.value, nodes.first.value, nodes.second.value, double(native->length()),
            unsigned(native->classification()), native->is_shortcut() ||
            native->access_restriction() || native->part_of_complex_restriction() ||
            native->start_restriction() || native->end_restriction()};
  }
  std::vector<Edge> outgoing(uint64_t node_value) {
    const GraphId node_id(node_value);
    auto tile = reader.GetGraphTile(node_id);
    if (!tile || node_id.id() >= tile->header()->nodecount()) throw std::runtime_error("node unavailable");
    const auto* node = tile->node(node_id);
    // Same-edge references work on all road hierarchy levels. Multi-edge
    // paths are accepted only when the traversed graph does not require
    // a transition. Ignoring transitions would falsely certify uniqueness.
    if (node->transition_count()) throw UnsupportedHierarchy();
    if (!cost->Allowed(node)) return {};
    std::vector<Edge> output;
    for (uint32_t index = node->edge_index(); index < node->edge_index() + node->edge_count(); ++index) {
      const GraphId id(node_id.tileid(), node_id.level(), index);
      const auto* native = tile->directededge(id);
      if (native->is_shortcut() || !cost->Allowed(native, tile, valhalla::sif::kDisallowShortcut)) continue;
      output.push_back(edge(id.value));
    }
    std::sort(output.begin(), output.end(), [](const Edge& a, const Edge& b) { return a.id < b.id; });
    return output;
  }
  bool allowed_turn(uint64_t incoming_value, uint64_t next_value) {
    const GraphId incoming(incoming_value), next(next_value);
    auto previous_tile = reader.GetGraphTile(incoming), tile = reader.GetGraphTile(next);
    if (!previous_tile || !tile) return false;
    const auto* previous = previous_tile->directededge(incoming);
    const auto* native = tile->directededge(next);
    const auto nodes = reader.GetDirectedEdgeNodes(tile, native);
    auto node_tile = reader.GetGraphTile(nodes.first);
    if (!node_tile || !cost->Allowed(node_tile->node(nodes.first)) || previous->endnode() != nodes.first ||
        reader.GetOpposingEdgeId(incoming) == next || native->is_shortcut()) return false;
    const valhalla::sif::EdgeLabel predecessor(
      valhalla::baldr::kInvalidLabel, incoming, previous, {}, 0,
      valhalla::sif::TravelMode::kDrive, 0, valhalla::baldr::kInvalidRestriction,
      false, false, valhalla::sif::InternalTurn::kNoTurn);
    uint8_t restriction = valhalla::baldr::kInvalidRestriction, destination_mask = 0;
    return cost->Allowed(native, false, predecessor, tile, next, 0, 0, restriction, destination_mask);
  }
  double lower_bound_m(uint64_t a_value, uint64_t b_value) {
    const GraphId a(a_value), b(b_value);
    auto a_tile = reader.GetGraphTile(a), b_tile = reader.GetGraphTile(b);
    if (!a_tile || !b_tile) throw std::runtime_error("node unavailable");
    return a_tile->node(a)->latlng(a_tile->header()->base_ll()).Distance(
      b_tile->node(b)->latlng(b_tile->header()->base_ll()));
  }
  bool interval_in_corridor(const Edge& reference, double begin, double end, const Corridor& corridor) {
    if (end - begin <= sim_openlr::kFractionEpsilon) return true;
    const GraphId id(reference.id);
    auto tile = reader.GetGraphTile(id);
    if (!tile) throw std::runtime_error("corridor graph unavailable");
    const auto* edge = tile->directededge(id);
    auto shape = tile->edgeinfo(edge).shape();
    if (shape.size() < 2) return false;
    if (!edge->forward()) std::reverse(shape.begin(), shape.end());
    double shape_m = 0;
    for (size_t i = 1; i < shape.size(); ++i) shape_m += shape[i - 1].Distance(shape[i]);
    if (!std::isfinite(shape_m) || shape_m <= 0) return false;
    const double start = begin * shape_m, stop = end * shape_m;
    double walked = 0;
    for (size_t i = 1; i < shape.size(); ++i) {
      const double segment_m = shape[i - 1].Distance(shape[i]);
      if (segment_m <= 0) continue;
      const double low = std::max(start, walked), high = std::min(stop, walked + segment_m);
      if (high >= low) {
        // Check clipped endpoints, every intervening shape vertex, and no
        // more than 10 m between samples. Long chords cannot skip divergence.
        const size_t samples = std::max<size_t>(1, size_t(std::ceil((high - low) / 10.)));
        for (size_t j = 0; j <= samples; ++j) {
          const double fraction = ((low + (high - low) * j / samples) - walked) / segment_m;
          valhalla::midgard::PointLL point(
            shape[i - 1].lng() + (shape[i].lng() - shape[i - 1].lng()) * fraction,
            shape[i - 1].lat() + (shape[i].lat() - shape[i - 1].lat()) * fraction);
          // A conservative margin covers the <=5 m unsampled midpoint and
          // local planar approximation; never accept just vertex inclusion.
          if (corridor_distance(point, corridor) > corridor.tolerance_m - 6.) return false;
        }
      }
      walked += segment_m;
    }
    return true;
  }
};

std::vector<Candidate> candidates(const valhalla::Location& location, const Lrp& lrp,
                                  NativeGraph& graph, bool at_start, bool at_end) {
  struct Ranked { Candidate candidate; double distance, heading; };
  std::vector<Ranked> ranked;
  for (const auto& correlated : location.correlation().edges()) {
    const GraphId id(correlated.graph_id());
    if (id.level() > 2) continue;
    auto tile = graph.reader.GetGraphTile(id);
    if (!tile) continue;
    const auto* edge = tile->directededge(id);
    if (edge->is_shortcut() || !graph.cost->Allowed(edge, tile, valhalla::sif::kDisallowShortcut)) continue;
    const unsigned frc_rank = road_rank(lrp.frc, unsigned(edge->classification()));
    const bool motorway = edge->classification() == valhalla::baldr::RoadClass::kMotorway;
    const bool slip = edge->link() || edge->use() == valhalla::baldr::Use::kRamp ||
                      edge->use() == valhalla::baldr::Use::kTurnChannel;
    const bool one_way = !(edge->reverseaccess() & valhalla::baldr::kAutoAccess);
    unsigned form_rank = 0;
    if (lrp.fow == 1) form_rank = (!motorway || slip || edge->roundabout());
    else if (lrp.fow == 2) form_rank = (!one_way || slip || edge->roundabout());
    else if (lrp.fow == 3) form_rank = (motorway || slip || edge->roundabout());
    else if (lrp.fow == 4) form_rank = !edge->roundabout();
    else if (lrp.fow == 6) form_rank = !slip;
    else continue; // FOW 5/7 lack a reliable graph interpretation in v1.
    // Structural disagreement is not compensated by a matching FRC. In
    // particular a roundabout/ramp must never become an ordinary road.
    if (form_rank) continue;
    const unsigned rank = frc_rank + form_rank;
    const double fraction = correlated.percent_along();
    const double heading = std::abs(std::remainder(correlated.heading() - lrp.bearing, 360.));
    if (rank > 1 || !sim_openlr::valid_fraction(fraction) ||
        correlated.distance() > 20 || heading > 34) continue;
    ranked.push_back({{id.value, fraction, rank}, correlated.distance(), heading});
  }
  // At a snapped node use the edge which actually begins/ends there, rather
  // than carrying a zero-length predecessor/successor into the search.
  const bool has_start = std::any_of(ranked.begin(), ranked.end(), [](const Ranked& r) { return r.candidate.fraction < 1e-7; });
  const bool has_end = std::any_of(ranked.begin(), ranked.end(), [](const Ranked& r) { return r.candidate.fraction > 1 - 1e-7; });
  ranked.erase(std::remove_if(ranked.begin(), ranked.end(), [&](const Ranked& r) {
    return (at_start && has_start && r.candidate.fraction > 1 - 1e-7) ||
           (at_end && has_end && r.candidate.fraction < 1e-7);
  }), ranked.end());
  std::sort(ranked.begin(), ranked.end(), [](const Ranked& a, const Ranked& b) {
    return std::tie(a.candidate.rank, a.distance, a.heading, a.candidate.edge) <
           std::tie(b.candidate.rank, b.distance, b.heading, b.candidate.edge);
  });
  if (ranked.size() > 8) throw std::length_error("candidate limit");
  std::vector<Candidate> output;
  for (const auto& item : ranked) output.push_back(item.candidate);
  return output;
}

sim_openlr::Result decode(const rapidjson::Value& request, NativeGraph& graph,
                         const std::string& dataset, const std::string& graph_hash) {
  exact_keys(request, {"requestId", "routingDataset", "graphSha256", "staticRevision", "lrps",
                       "positiveOffsetMeters", "negativeOffsetMeters", "corridor"});
  if (text_field(request, "routingDataset") != dataset || text_field(request, "graphSha256") != graph_hash)
    return {"graph_mismatch", {}, 0};
  if (!hash_string(text_field(request, "staticRevision"))) throw std::invalid_argument("invalid static revision");
  if (!request.HasMember("lrps") || !request["lrps"].IsArray() ||
      request["lrps"].Size() < 2 || request["lrps"].Size() > 16) throw std::invalid_argument("invalid LRP count");
  const double positive = request.HasMember("positiveOffsetMeters") ? number(request, "positiveOffsetMeters", 0, 20000) : 0;
  const double negative = request.HasMember("negativeOffsetMeters") ? number(request, "negativeOffsetMeters", 0, 20000) : 0;
  const bool with_corridor = request.HasMember("corridor");
  const Corridor corridor = with_corridor ? parse_corridor(request["corridor"]) : Corridor{};
  std::function<bool(const Edge&, double, double)> interval_filter;
  if (with_corridor) interval_filter = [&](const Edge& edge, double begin, double end) {
    return graph.interval_in_corridor(edge, begin, end, corridor);
  };
  std::vector<Lrp> lrps;
  google::protobuf::RepeatedPtrField<valhalla::Location> locations;
  for (rapidjson::SizeType i = 0; i < request["lrps"].Size(); ++i) {
    const auto& value = request["lrps"][i];
    exact_keys(value, {"lon", "lat", "bearingDegrees", "frc", "fow", "distanceToNext", "lowestFrcToNext", "againstDrivingDirection"});
    if (value.HasMember("againstDrivingDirection")) {
      if (!value["againstDrivingDirection"].IsBool()) throw std::invalid_argument("invalid direction");
      if (value["againstDrivingDirection"].GetBool()) return {"unsupported_driving_direction", {}, 0};
    }
    Lrp lrp{number(value, "lon", -180, 180), number(value, "lat", -85, 85),
            number(value, "bearingDegrees", 0, 359.999999), integer(value, "frc", 0, 7), integer(value, "fow", 0, 7)};
    if (lrp.fow == 0 || lrp.fow == 5 || lrp.fow == 7) return {"unsupported_fow", {}, 0};
    const bool final = i + 1 == request["lrps"].Size();
    if (!final) {
      lrp.distance = number(value, "distanceToNext", 1, 20000);
      lrp.lowest_frc = integer(value, "lowestFrcToNext", 0, 7);
    } else {
      if (value.HasMember("distanceToNext") || value.HasMember("lowestFrcToNext"))
        throw std::invalid_argument("last LRP has path properties");
      lrp.bearing = std::fmod(lrp.bearing + 180, 360);
    }
    lrps.push_back(lrp);
    auto* location = locations.Add();
    location->mutable_ll()->set_lng(lrp.lon); location->mutable_ll()->set_lat(lrp.lat);
    location->set_heading(unsigned(std::lround(lrp.bearing)) % 360);
    location->set_heading_tolerance(34); location->set_node_snap_tolerance(2);
    location->set_radius(20); location->set_search_cutoff(20);
    location->set_minimum_reachability(0);
    location->set_skip_ranking_candidates(true);
    auto* filter = location->mutable_search_filter();
    // The raw proto defaults are not the JSON API defaults. Search interprets
    // min_road_class as the largest numeric class, and level must be kMaxLevel
    // to avoid filtering ordinary edges as if a building floor were selected.
    filter->set_min_road_class(valhalla::RoadClass::kServiceOther);
    filter->set_max_road_class(valhalla::RoadClass::kMotorway);
    filter->set_level(valhalla::baldr::kMaxLevel);
    filter->set_exclude_closures(false);
  }
  valhalla::loki::Search search(graph.reader);
  search.search(locations, graph.cost);
  std::vector<std::vector<Candidate>> correlated;
  for (size_t i = 0; i < lrps.size(); ++i)
    correlated.push_back(candidates(locations.Get(i), lrps[i], graph, i == 0,
                                    i + 1 == lrps.size()));
  for (const auto& list : correlated) if (list.empty())
    return {"no_endpoint", {}, 0};
  Path result;
  size_t expansions = 0;
  for (size_t i = 0; i + 1 < lrps.size(); ++i) {
    auto pair = sim_openlr::resolve_pair(graph, correlated[i], correlated[i + 1],
      lrps[i].distance, std::max(35., lrps[i].distance * .1), lowest_mask(lrps[i].lowest_frc), {}, interval_filter);
    expansions += pair.expansions;
    if (pair.status != "matched") return {pair.status, {}, expansions};
    if (!sim_openlr::merge_pair(graph, result, pair.path)) return {"disconnected_lrps", {}, expansions};
  }
  return {"matched", sim_openlr::trim_offsets(std::move(result), positive, negative), expansions};
}

void response(uint64_t request_id, const sim_openlr::Result& result,
              const std::string& dataset, const std::string& graph_hash, const std::string& corridor_revision) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("requestId"); writer.Uint64(request_id);
  writer.Key("decoderVersion"); writer.String(sim_openlr::kDecoderVersion);
  writer.Key("routingDataset"); writer.String(dataset.c_str());
  writer.Key("graphSha256"); writer.String(graph_hash.c_str());
  writer.Key("corridorRevision"); writer.String(corridor_revision.c_str());
  writer.Key("status"); writer.String(result.status.c_str());
  writer.Key("expansions"); writer.Uint64(result.expansions);
  if (result.status == "matched") {
    writer.Key("lengthMeters"); writer.Double(result.path.meters);
    writer.Key("intervals"); writer.StartArray();
    for (const auto& interval : result.path.intervals) {
      writer.StartObject(); writer.Key("edgeId"); writer.Uint64(interval.edge);
      writer.Key("beginFraction"); writer.Double(interval.begin);
      writer.Key("endFraction"); writer.Double(interval.end);
      writer.Key("edgeLengthMeters"); writer.Double(interval.meters); writer.EndObject();
    }
    writer.EndArray();
    writer.Key("fullEdgeIds"); writer.StartArray();
    for (const auto edge : sim_openlr::full_edges(result.path)) writer.Uint64(edge);
    writer.EndArray();
  }
  writer.EndObject();
  std::cout << buffer.GetString() << '\n' << std::flush;
}
int main(int argc, char** argv) {
  if (argc != 4) {
    std::cerr << "usage: openlr-native-decoder CONFIG EXPECTED_ROUTING_DATASET EXPECTED_GRAPH_SHA256\n";
    return 2;
  }
  try {
    const std::string dataset(argv[2]), expected_hash(argv[3]);
    if (dataset.empty() || !hash_string(expected_hash)) throw std::invalid_argument("invalid graph identity");
    boost::property_tree::ptree config;
    boost::property_tree::read_json(argv[1], config);
    const fs::path extract(config.get<std::string>("mjolnir.tile_extract"));
    if (!fs::is_regular_file(extract) || file_sha256(extract) != expected_hash)
      throw std::runtime_error("graph identity mismatch");
    const auto original_size = fs::file_size(extract);
    const auto original_time = fs::last_write_time(extract);
    // Search diagnostics must stay off the machine-correlated stdout channel.
    valhalla::midgard::logging::Configure({{"type", "std_err"}, {"color", "false"}});
    // No tiles from an unhashed directory, remote server, or live traffic
    // may supplement the extract which has been verified above.
    boost::property_tree::ptree extract_only;
    extract_only.put("tile_extract", extract.string());
    extract_only.put("tile_dir", "/__sim_openlr_extract_only_no_fallback__");
    extract_only.put("tile_url", "");
    extract_only.put("traffic_extract", "");
    extract_only.put("max_cache_size", 134217728);
    GraphReader reader(extract_only);
    NativeGraph graph(reader);
    std::string line;
    while (std::getline(std::cin, line)) {
      uint64_t request_id = 0;
      std::string corridor_revision;
      sim_openlr::Result result{"invalid_reference", {}, 0};
      try {
        if (line.size() > 65536) throw std::invalid_argument("request limit");
        if (fs::file_size(extract) != original_size || fs::last_write_time(extract) != original_time)
          throw std::runtime_error("graph changed");
        rapidjson::Document request;
        request.Parse(line.c_str());
        if (request.HasParseError() || !request.IsObject() || !request.HasMember("requestId") ||
            !request["requestId"].IsUint64()) throw std::invalid_argument("invalid request id");
        request_id = request["requestId"].GetUint64();
        if (request.HasMember("corridor")) corridor_revision = parse_corridor(request["corridor"]).revision;
        result = decode(request, graph, dataset, expected_hash);
      } catch (const std::length_error&) { result.status = "candidate_limit"; }
        catch (const UnsupportedHierarchy&) { result.status = "unsupported_hierarchy"; }
        catch (const std::invalid_argument&) { result.status = "invalid_reference"; }
        catch (const std::exception&) { result.status = "graph_error"; }
      response(request_id, result, dataset, expected_hash, corridor_revision);
    }
    if (file_sha256(extract) != expected_hash) throw std::runtime_error("graph changed during batch");
    return 0;
  } catch (const std::exception&) {
    std::cerr << "native decoder startup failed: invalid graph/configuration\n";
    return 1;
  }
}
