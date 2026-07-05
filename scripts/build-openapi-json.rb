#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "yaml"
require "fileutils"
require "set"

ROOT = File.expand_path("..", __dir__)
OUTPUT = File.join(ROOT, "openapi", "openapi.json")

SPECS = [
  {
    key: "simulator",
    prefix: "Simulator",
    tag_prefix: "Simulator",
    file: "docs/archive/openapi-yaml/openapi-simulator.yaml",
    path_prefix: ""
  },
  {
    key: "flightData",
    prefix: "FlightData",
    tag_prefix: "Flight Data",
    file: "docs/archive/openapi-yaml/openapi-flight-data.yaml",
    path_prefix: "/flight-data"
  },
  {
    key: "situationData",
    prefix: "SituationData",
    tag_prefix: "Situation Data",
    file: "docs/archive/openapi-yaml/openapi-situation-data.yaml",
    path_prefix: "/situation-data/api/v1"
  },
  {
    key: "searchData",
    prefix: "SearchData",
    tag_prefix: "Search Data",
    file: "docs/archive/openapi-yaml/openapi-search-data.yaml",
    path_prefix: "/search-data/api/v1"
  },
  {
    key: "safetyData",
    prefix: "SafetyData",
    tag_prefix: "Safety Data",
    file: "docs/archive/openapi-yaml/openapi-safety-data.yaml",
    path_prefix: "/safety-data/api/v1"
  },
  {
    key: "takGateway",
    prefix: "TakGateway",
    tag_prefix: "TAK Gateway",
    file: "docs/archive/openapi-yaml/openapi-tak-gateway.yaml",
    path_prefix: "/tak-gateway/api/v1"
  }
].freeze

HTTP_METHODS = %w[get put post delete options head patch trace].freeze

def deep_transform(value, prefix)
  case value
  when Hash
    value.each_with_object({}) do |(key, item), result|
      result[key] =
        if key == "$ref" && item.is_a?(String)
          prefix_ref(item, prefix)
        else
          deep_transform(item, prefix)
        end
    end
  when Array
    value.map { |item| deep_transform(item, prefix) }
  else
    value
  end
end

def prefix_ref(ref, prefix)
  return ref.sub(%r{\A\./schemas/}, "../docs/api/schemas/") if ref.start_with?("./schemas/")

  ref.sub(%r{\A#/components/([^/]+)/([^/]+)\z}) do
    "#/components/#{$1}/#{prefix}#{$2}"
  end
end

def transform_security_requirement(value)
  return value unless value.is_a?(Array)

  value.map do |requirement|
    next requirement unless requirement.is_a?(Hash)

    requirement.transform_keys { |key| key.to_s }
  end
end

def ensure_client_error_response(operation)
  responses = operation["responses"]
  return unless responses.is_a?(Hash)
  return if responses.keys.any? { |status| status.to_s.match?(/\A4\d\d\z/) }

  responses["401"] = {
    "description" => "Missing, expired or unauthorized bearer token.",
    "content" => {
      "application/json" => {
        "schema" => { "$ref" => "#/components/schemas/ErrorResponse" }
      }
    }
  }
end

def collect_schema_refs(value, refs)
  case value
  when Hash
    value.each do |key, item|
      if key == "$ref" && item.is_a?(String)
        match = item.match(%r{\A#/components/schemas/([^/]+)\z})
        refs << match[1] if match
      end
      collect_schema_refs(item, refs)
    end
  when Array
    value.each { |item| collect_schema_refs(item, refs) }
  end
end

def prune_unused_schemas(doc)
  schemas = doc.dig("components", "schemas")
  return unless schemas.is_a?(Hash)

  roots = Set.new
  doc_without_schemas = Marshal.load(Marshal.dump(doc))
  doc_without_schemas["components"]["schemas"] = {}
  collect_schema_refs(doc_without_schemas, roots)

  reachable = Set.new
  queue = roots.to_a
  until queue.empty?
    name = queue.shift
    next if reachable.include?(name)

    schema = schemas[name]
    next unless schema

    reachable << name
    nested = Set.new
    collect_schema_refs(schema, nested)
    nested.each { |nested_name| queue << nested_name unless reachable.include?(nested_name) }
  end

  schemas.select! { |name, _schema| reachable.include?(name) }
end

def prefixed_path(path, prefix)
  return path if prefix.empty?

  "#{prefix}#{path}".gsub(%r{/+}, "/")
end

def operation_id(service_key, method, path, existing)
  return "#{service_key}_#{existing}" if existing && !existing.empty?

  suffix = path
    .gsub(/[{}]/, "")
    .split("/")
    .reject(&:empty?)
    .map { |part| part.gsub(/[^A-Za-z0-9]/, "_") }
    .join("_")
  "#{service_key}_#{method}_#{suffix}"
end

def tag_names(operation, fallback)
  tags = operation["tags"]
  tags = [fallback] if !tags.is_a?(Array) || tags.empty?
  tags.map { |tag| "#{fallback}: #{tag}" }.uniq
end

def merge_components(target, source, prefix)
  source.fetch("components", {}).each do |section, values|
    next unless values.is_a?(Hash)

    target["components"][section] ||= {}
    values.each do |name, schema|
      component_name = section == "securitySchemes" ? name : "#{prefix}#{name}"
      target["components"][section][component_name] = deep_transform(schema, prefix)
    end
  end
end

def add_path(target, source_path, path_item, spec)
  path = prefixed_path(source_path, spec[:path_prefix])
  transformed = deep_transform(path_item, spec[:prefix])

  HTTP_METHODS.each do |method|
    operation = transformed[method]
    next unless operation.is_a?(Hash)

    operation["operationId"] = operation_id(spec[:key], method, path, operation["operationId"])
    operation["tags"] = tag_names(operation, spec[:tag_prefix])
    operation["security"] = transform_security_requirement(operation["security"]) if operation.key?("security")
    ensure_client_error_response(operation)
  end

  target["paths"][path] = transformed
end

def add_health_path(target, path, tag, operation_id_prefix)
  return if target["paths"].key?(path)

  target["paths"][path] = {
    "get" => {
      "summary" => path.end_with?("/ready") ? "#{tag} readiness" : "#{tag} liveness",
      "operationId" => "#{operation_id_prefix}_#{path.end_with?("/ready") ? "ready" : "live"}",
      "tags" => ["#{tag}: Health"],
      "security" => [],
      "responses" => {
        "200" => {
          "description" => "Service health response",
          "content" => {
            "application/json" => {
              "schema" => { "$ref" => "#/components/schemas/HealthResponse" }
            }
          }
        },
        "403" => {
          "description" => "Forbidden by the public gateway boundary when accessed from an external network.",
          "content" => {
            "application/json" => {
              "schema" => { "$ref" => "#/components/schemas/ErrorResponse" }
            }
          }
        }
      }
    }
  }
end

def build_document
  doc = {
    "openapi" => "3.1.0",
    "info" => {
      "title" => "CSM SIM Composite API",
      "version" => "0.1.0",
      "description" => "JSON-first composite OpenAPI contract for CSM SIM REST API surfaces.",
      "license" => {
        "name" => "Proprietary - CSM SIM pilot",
        "identifier" => "LicenseRef-CSM-SIM-Pilot"
      }
    },
    "servers" => [
      { "url" => "https://sim.zeleznalady.cz", "description" => "Published SIM reverse proxy" },
      { "url" => "http://docker.home.cz:5020", "description" => "Pilot reverse proxy" }
    ],
    "security" => [
      { "bearerAuth" => [] }
    ],
    "tags" => [],
    "paths" => {},
    "components" => {
      "schemas" => {
        "HealthResponse" => {
          "type" => "object",
          "required" => %w[status timestamp],
          "properties" => {
            "status" => { "type" => "string" },
            "timestamp" => { "type" => "string", "format" => "date-time" }
          },
          "additionalProperties" => true
        },
        "ErrorResponse" => {
          "type" => "object",
          "required" => ["error"],
          "properties" => {
            "error" => {
              "type" => "object",
              "required" => %w[code message requestId],
              "properties" => {
                "code" => { "type" => "string" },
                "message" => { "type" => "string" },
                "requestId" => { "type" => "string" },
                "details" => { "type" => "array", "items" => { "type" => "object", "additionalProperties" => true } }
              },
              "additionalProperties" => true
            }
          }
        }
      }
    },
    "x-csm-sim" => {
      "source" => "Composite generated from archived service-local YAML snapshots.",
      "generator" => "scripts/build-openapi-json.rb",
      "notes" => [
        "openapi/openapi.json is the binding artifact.",
        "Current runtime error responses may use correlationId; requestId unification is a compatibility-safe follow-up."
      ],
      "localServer" => "http://localhost:5020"
    }
  }

  SPECS.each do |spec|
    source = YAML.load_file(File.join(ROOT, spec[:file]))
    merge_components(doc, source, spec[:prefix])

    source.fetch("paths", {}).each do |path, path_item|
      add_path(doc, path, path_item, spec)
    end

    source.fetch("tags", []).each do |tag|
      name = tag.fetch("name", tag.to_s)
      doc["tags"] << {
        "name" => "#{spec[:tag_prefix]}: #{name}",
        "description" => tag["description"] || "#{spec[:tag_prefix]} #{name}"
      }
    end
  end

  add_health_path(doc, "/situation-data/health/live", "Situation Data", "situationData_health_live")
  add_health_path(doc, "/situation-data/health/ready", "Situation Data", "situationData_health_ready")
  add_health_path(doc, "/safety-data/health/live", "Safety Data", "safetyData_health_live")
  add_health_path(doc, "/safety-data/health/ready", "Safety Data", "safetyData_health_ready")
  add_health_path(doc, "/tak-gateway/health/live", "TAK Gateway", "takGateway_health_live")
  add_health_path(doc, "/tak-gateway/health/ready", "TAK Gateway", "takGateway_health_ready")

  doc["tags"].uniq! { |tag| tag["name"] }
  prune_unused_schemas(doc)
  doc
end

generated = JSON.pretty_generate(build_document) + "\n"

if ARGV.include?("--check")
  if !File.exist?(OUTPUT)
    warn "Missing #{OUTPUT}. Run scripts/build-openapi-json.rb."
    exit 1
  end

  current = File.read(OUTPUT)
  if current == generated
    puts "openapi/openapi.json is up to date."
    exit 0
  end

  warn "openapi/openapi.json is stale. Run scripts/build-openapi-json.rb."
  exit 1
end

FileUtils.mkdir_p(File.dirname(OUTPUT))
File.write(OUTPUT, generated)
puts "Wrote #{OUTPUT}"
