create extension if not exists postgis;
create extension if not exists hstore;

drop materialized view if exists public.osm_admin_boundary;

create materialized view public.osm_admin_boundary as
with tagged as (
  select
    osm_id,
    tags,
    case when tags->'admin_level' ~ '^[0-9]+$' then (tags->'admin_level')::integer end as admin_level,
    way
  from public.osm_polygon
  where tags->'boundary' = 'administrative'
    and way is not null
),
raw as (
  select
    osm_id,
    tags,
    nullif(tags->'name:cs', '') as name_cs,
    nullif(tags->'name', '') as name_default,
    nullif(tags->'ISO3166-2', '') as iso_3166_2,
    nullif(tags->'ref', '') as ref_code,
    nullif(tags->'ISO3166-1:alpha2', '') as iso_country,
    admin_level,
    st_multi(st_collectionextract(st_makevalid(way), 3))::geometry(MultiPolygon, 4326) as geom
  from tagged
  where admin_level in (2, 4, 6, 7, 8)
),
prepared as (
  select
    osm_id,
    admin_level,
    coalesce(name_cs, name_default) as name,
    coalesce(iso_3166_2, ref_code, osm_id::text) as code,
    coalesce(iso_country, 'CZ') as country_code,
    geom,
    tags
  from raw
  where geom is not null
    and not st_isempty(geom)
)
select
  osm_id,
  admin_level,
  name,
  code,
  country_code,
  'osm_postgis'::text as source,
  geom,
  st_simplifypreservetopology(geom, 0.01)::geometry(MultiPolygon, 4326) as geom_z5,
  st_simplifypreservetopology(geom, 0.003)::geometry(MultiPolygon, 4326) as geom_z8,
  st_simplifypreservetopology(geom, 0.0008)::geometry(MultiPolygon, 4326) as geom_z11,
  hstore_to_jsonb(tags) as tags,
  now() as imported_at
from prepared;

create index osm_admin_boundary_geom_gix on public.osm_admin_boundary using gist(geom);
create index osm_admin_boundary_geom_z5_gix on public.osm_admin_boundary using gist(geom_z5);
create index osm_admin_boundary_geom_z8_gix on public.osm_admin_boundary using gist(geom_z8);
create index osm_admin_boundary_geom_z11_gix on public.osm_admin_boundary using gist(geom_z11);
create index osm_admin_boundary_level_idx on public.osm_admin_boundary(admin_level);
create index osm_admin_boundary_code_idx on public.osm_admin_boundary(code);
analyze public.osm_admin_boundary;
