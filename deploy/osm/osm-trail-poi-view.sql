create extension if not exists postgis;
create extension if not exists hstore;

drop materialized view if exists public.osm_trail_poi;

create materialized view public.osm_trail_poi as
with raw as (
  select
    'node'::text as osm_type,
    osm_id,
    tags,
    way::geometry(Point, 4326) as geom
  from public.osm_point
  where tags ? 'tourism'
    or tags ? 'amenity'
    or tags ? 'shop'
    or tags ? 'railway'
    or tags ? 'highway'
    or tags ? 'public_transport'
    or tags ? 'emergency'
    or tags ? 'drinking_water'
    or tags ? 'service:bicycle:rental'

  union all

  select
    'area'::text as osm_type,
    osm_id,
    tags,
    st_pointonsurface(way)::geometry(Point, 4326) as geom
  from public.osm_polygon
  where tags ? 'tourism'
    or tags ? 'amenity'
    or tags ? 'shop'
    or tags ? 'railway'
    or tags ? 'highway'
    or tags ? 'public_transport'
    or tags ? 'emergency'
    or tags ? 'drinking_water'
    or tags ? 'service:bicycle:rental'
),
classified as (
  select
    osm_type,
    osm_id,
    tags,
    geom,
    case
      when tags->'tourism' in ('hotel', 'guest_house', 'hostel', 'alpine_hut', 'wilderness_hut') then 'sleep'
      when tags->'tourism' = 'camp_site' then 'camp'
      when tags->'amenity' = 'shelter' then 'shelter'
      when tags->'amenity' = 'drinking_water' or tags->'drinking_water' = 'yes' then 'water'
      when tags->'amenity' in ('restaurant', 'pub', 'cafe') or tags->'shop' in ('supermarket', 'convenience', 'bakery') then 'food'
      when tags->'shop' = 'bicycle' then 'repair'
      when tags->'amenity' in ('bicycle_rental', 'boat_rental') or tags->'service:bicycle:rental' = 'yes' then 'rental'
      when tags->'railway' in ('station', 'halt') or tags->'highway' = 'bus_stop' or tags->'public_transport' in ('platform', 'stop_position') then 'transport'
      when tags->'highway' = 'emergency_access_point'
        or tags->'emergency' in ('access_point', 'phone', 'defibrillator', 'assembly_point', 'first_aid', 'lifeguard', 'fire_water_pond')
        then 'emergency'
      else null
    end as category
  from raw
)
select
  osm_id,
  osm_type,
  category,
  coalesce(nullif(tags->'name', ''), nullif(tags->'operator', ''), nullif(tags->'brand', '')) as name,
  geom,
  st_x(geom)::double precision as lon,
  st_y(geom)::double precision as lat,
  hstore_to_jsonb(slice(tags, array[
    'name', 'operator', 'brand', 'tourism', 'amenity', 'shop', 'railway', 'highway', 'public_transport', 'emergency',
    'drinking_water', 'service:bicycle:rental', 'opening_hours', 'website',
    'wheelchair', 'fee', 'capacity', 'access'
  ])) as tags,
  now() as imported_at
from classified
where category is not null
  and geom is not null;

create index osm_trail_poi_identity_idx on public.osm_trail_poi(osm_type, osm_id, category);
create index osm_trail_poi_geom_gix on public.osm_trail_poi using gist(geom);
create index osm_trail_poi_category_idx on public.osm_trail_poi(category);
analyze public.osm_trail_poi;
