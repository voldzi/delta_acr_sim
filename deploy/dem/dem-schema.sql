create extension if not exists postgis;

create table if not exists public.dem_datasets (
  dataset_id text primary key,
  source text not null,
  version text not null,
  resolution_m integer not null,
  source_url text,
  license_name text,
  attribution text,
  storage_backend text not null default 'seaweedfs+local-cache+postgis',
  s3_endpoint text,
  s3_bucket text,
  s3_prefix text,
  local_cache_dir text,
  status text not null default 'ready',
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dem_tiles (
  dataset_id text not null references public.dem_datasets(dataset_id) on delete cascade,
  tile_id text not null,
  source_url text not null,
  object_key text,
  local_path text,
  checksum_sha256 text,
  content_length_bytes bigint,
  west double precision not null,
  south double precision not null,
  east double precision not null,
  north double precision not null,
  resolution_m integer not null,
  available_locally boolean not null default false,
  available_object_store boolean not null default false,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  geom geometry(Polygon, 4326) generated always as (
    st_makeenvelope(west, south, east, north, 4326)
  ) stored,
  primary key (dataset_id, tile_id)
);

create index if not exists dem_tiles_geom_gix on public.dem_tiles using gist (geom);
create index if not exists dem_tiles_dataset_idx on public.dem_tiles(dataset_id);
create index if not exists dem_tiles_object_store_idx on public.dem_tiles(available_object_store);
create index if not exists dem_tiles_local_idx on public.dem_tiles(available_locally);

create table if not exists public.mobile_coverage_cells (
  dataset_id text,
  model_version text not null,
  technology text not null,
  operator text not null default 'unknown',
  quality text not null,
  estimated_signal_dbm integer,
  confidence double precision not null,
  resolution_m integer not null,
  dem_dataset_id text,
  generated_at timestamptz not null,
  expires_at timestamptz not null,
  assumptions jsonb not null default '{}'::jsonb,
  geom geometry(Polygon, 4326) not null,
  feature_id text primary key
);

create index if not exists mobile_coverage_cells_geom_gix on public.mobile_coverage_cells using gist (geom);
create index if not exists mobile_coverage_cells_model_idx on public.mobile_coverage_cells(model_version, technology, operator);
create index if not exists mobile_coverage_cells_expires_idx on public.mobile_coverage_cells(expires_at);
