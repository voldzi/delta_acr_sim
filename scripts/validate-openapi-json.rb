#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"

path = ARGV[0] || "openapi/openapi.json"
doc = JSON.parse(File.read(path))
failures = []

def require_key(failures, object, key, context)
  failures << "#{context} is missing #{key}" unless object.is_a?(Hash) && object.key?(key)
end

def each_operation(paths)
  paths.each do |path, path_item|
    next unless path_item.is_a?(Hash)

    path_item.each do |method, operation|
      next unless %w[get put post delete options head patch trace].include?(method)
      next unless operation.is_a?(Hash)

      yield path, method, operation
    end
  end
end

def local_ref_target(doc, ref)
  return nil unless ref.is_a?(String) && ref.start_with?("#/")

  ref.delete_prefix("#/").split("/").reduce(doc) do |cursor, segment|
    return nil unless cursor.is_a?(Hash)

    cursor[segment]
  end
end

require_key(failures, doc, "openapi", "root")
require_key(failures, doc, "info", "root")
require_key(failures, doc.fetch("info", {}), "title", "info")
require_key(failures, doc.fetch("info", {}), "version", "info")
require_key(failures, doc.fetch("info", {}), "description", "info")
require_key(failures, doc, "servers", "root")
require_key(failures, doc, "paths", "root")
require_key(failures, doc, "components", "root")
require_key(failures, doc.fetch("components", {}), "schemas", "components")

each_operation(doc.fetch("paths", {})) do |path_name, method, operation|
  context = "#{method.upcase} #{path_name}"
  %w[summary operationId tags responses].each { |key| require_key(failures, operation, key, context) }

  if operation["requestBody"]
    content = operation.dig("requestBody", "content")
    if !content.is_a?(Hash) || content.empty?
      failures << "#{context} requestBody is missing content"
    else
      content.each do |content_type, media|
        failures << "#{context} requestBody #{content_type} is missing schema" unless media.is_a?(Hash) && media["schema"]
      end
    end
  end

  operation.fetch("responses", {}).each do |status, response|
    next unless response.is_a?(Hash)
    json_content = response.dig("content", "application/json")
    next unless json_content

    failures << "#{context} response #{status} application/json is missing schema" unless json_content["schema"]
  end
end

refs = []
walker = lambda do |value|
  case value
  when Hash
    refs << value["$ref"] if value["$ref"]
    value.each_value { |item| walker.call(item) }
  when Array
    value.each { |item| walker.call(item) }
  end
end
walker.call(doc)

refs.each do |ref|
  failures << "unresolved local ref #{ref}" if ref.start_with?("#/") && local_ref_target(doc, ref).nil?
end

if failures.any?
  warn "OpenAPI validation failed:"
  failures.each { |failure| warn "- #{failure}" }
  exit 1
end

puts "OpenAPI sanity validation passed: #{doc.fetch("paths", {}).size} paths, #{doc.dig("components", "schemas")&.size || 0} schemas."
