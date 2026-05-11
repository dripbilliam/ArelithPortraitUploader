insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bulk-exports',
  'bulk-exports',
  false,
  524288000,
  array['application/zip']
)
on conflict (id) do nothing;
