create extension if not exists postgis;
create extension if not exists hstore;

drop materialized view if exists public.osm_trail_routes;

create materialized view public.osm_trail_routes as
with raw as (
  select
    osm_id,
    tags,
    way::geometry(LineString, 4326) as geom
  from public.osm_line
  where tags->'route' in ('hiking', 'foot', 'bicycle', 'mtb')
    and way is not null
),
grouped as (
  select
    osm_id,
    tags->'route' as route_mode,
    coalesce(nullif(tags->'network', ''), 'local') as network,
    coalesce(nullif(max(tags->'name'), ''), nullif(max(tags->'ref'), ''), concat('OSM trail ', abs(osm_id))) as name,
    nullif(max(tags->'ref'), '') as ref,
    nullif(max(tags->'operator'), '') as operator,
    nullif(max(tags->'osmc:symbol'), '') as osmc_symbol,
    count(*)::integer as segment_count,
    round((sum(st_length(geom::geography)) / 1000.0)::numeric, 3)::double precision as length_km,
    st_multi(st_collectionextract(st_linemerge(st_collect(geom)), 2))::geometry(MultiLineString, 4326) as geom,
    hstore_to_jsonb(slice((array_agg(tags))[1], array['name', 'ref', 'route', 'network', 'operator', 'osmc:symbol', 'symbol', 'colour', 'color', 'website'])) as tags,
    now() as imported_at
  from raw
  group by osm_id, tags->'route', coalesce(nullif(tags->'network', ''), 'local')
)
select
  osm_id,
  case when osm_id < 0 then 'relation' else 'way' end as osm_type,
  route_mode,
  network,
  name,
  ref,
  operator,
  osmc_symbol,
  segment_count,
  length_km,
  geom,
  st_simplifypreservetopology(geom, 0.0003)::geometry(MultiLineString, 4326) as geom_z11,
  st_simplifypreservetopology(geom, 0.001)::geometry(MultiLineString, 4326) as geom_z8,
  st_simplifypreservetopology(geom, 0.004)::geometry(MultiLineString, 4326) as geom_z5,
  tags,
  imported_at
from grouped
where geom is not null
  and not st_isempty(geom)
  and length_km >= 1.0;

create index osm_trail_routes_identity_idx on public.osm_trail_routes(osm_type, osm_id, route_mode, network);
create index osm_trail_routes_geom_gix on public.osm_trail_routes using gist(geom);
create index osm_trail_routes_geom_z11_gix on public.osm_trail_routes using gist(geom_z11);
create index osm_trail_routes_geom_z8_gix on public.osm_trail_routes using gist(geom_z8);
create index osm_trail_routes_geom_z5_gix on public.osm_trail_routes using gist(geom_z5);
create index osm_trail_routes_mode_idx on public.osm_trail_routes(route_mode);
create index osm_trail_routes_network_idx on public.osm_trail_routes(network);
analyze public.osm_trail_routes;
