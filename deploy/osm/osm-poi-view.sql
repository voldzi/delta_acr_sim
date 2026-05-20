create extension if not exists postgis;
create extension if not exists hstore;

drop materialized view if exists public.osm_poi;

create materialized view public.osm_poi as
with raw as (
  select
    'node'::text as osm_type,
    osm_id,
    tags,
    way::geometry(Point, 4326) as geom
  from public.osm_point
  where tags ? 'amenity'
    or tags ? 'emergency'
    or tags ? 'healthcare'
    or tags ? 'man_made'
    or tags ? 'tower:type'
    or tags ? 'communication:mobile_phone'

  union all

  select
    'area'::text as osm_type,
    osm_id,
    tags,
    st_pointonsurface(way)::geometry(Point, 4326) as geom
  from public.osm_polygon
  where tags ? 'amenity'
    or tags ? 'emergency'
    or tags ? 'healthcare'
    or tags ? 'man_made'
    or tags ? 'tower:type'
    or tags ? 'communication:mobile_phone'
),
classified as (
  select
    osm_type,
    osm_id,
    tags,
    geom,
    case
      when tags->'amenity' in ('hospital', 'clinic', 'doctors', 'pharmacy', 'police', 'fire_station', 'shelter', 'community_centre', 'townhall') then tags->'amenity'
      when tags->'healthcare' in ('hospital', 'clinic', 'doctor', 'pharmacy') then concat('healthcare_', tags->'healthcare')
      when tags->'emergency' in ('ambulance_station', 'fire_hydrant', 'defibrillator', 'siren', 'assembly_point') then tags->'emergency'
      when tags->'man_made' = 'communications_tower'
        or tags->'tower:type' = 'communication'
        or tags ? 'communication:mobile_phone' then 'communications_tower'
      else null
    end as category
  from raw
)
select
  osm_id,
  osm_type,
  category,
  case when category = 'communications_tower' then 'mobile' else 'ground' end as layer,
  coalesce(nullif(tags->'name', ''), nullif(tags->'operator', ''), nullif(tags->'brand', '')) as name,
  geom,
  st_x(geom)::double precision as lon,
  st_y(geom)::double precision as lat,
  hstore_to_jsonb(tags) as tags,
  now() as imported_at
from classified
where category is not null
  and geom is not null;

create index osm_poi_identity_idx on public.osm_poi(osm_type, osm_id, category);
create index osm_poi_geom_gix on public.osm_poi using gist(geom);
create index osm_poi_layer_idx on public.osm_poi(layer);
create index osm_poi_category_idx on public.osm_poi(category);
analyze public.osm_poi;
