alter table public.images
add column if not exists tga_set_sha256 text;

create index if not exists images_tga_set_sha256_idx
  on public.images (tga_set_sha256)
  where tga_set_sha256 is not null;