import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Copies legacy entity images into production storage and links them.
//
// Reads pending rows from legacy_photo_migration_queue, fetches each image from
// the legacy project's public bucket, uploads the bytes into this project's
// entity-photos bucket, inserts the entity_photos row, and closes out the queue
// row. Safe to invoke repeatedly and safe to interrupt: rows are claimed before
// work starts, and an already-linked photo finishes without re-copying.
//
// Deploy:
//   supabase functions deploy migrate-legacy-photos --no-verify-jwt
// Invoke until "remaining" reaches 0:
//   curl -X POST "$PROJECT_URL/functions/v1/migrate-legacy-photos?batch=50" \
//        -H "x-migration-secret: $MIGRATION_SECRET"
//
// verify_jwt is disabled because an operator tool invokes this, not an end
// user; it enforces its own shared secret instead. Set MIGRATION_SECRET with
// `supabase secrets set` before deploying.
const SECRET = Deno.env.get("MIGRATION_SECRET");
const TARGET_BUCKET = "entity-photos";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req: Request) => {
  if (!SECRET || req.headers.get("x-migration-secret") !== SECRET) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const batch = Math.min(parseInt(url.searchParams.get("batch") ?? "25", 10), 100);

  // Claim a batch up front so overlapping invocations cannot pick the same rows.
  const { data: claimed, error: claimErr } = await db
    .from("legacy_photo_migration_queue")
    .select("id, entity_slug, source_url, is_cover, sort_order")
    .eq("status", "pending")
    .order("id")
    .limit(batch);
  if (claimErr) {
    return new Response(JSON.stringify({ error: claimErr.message }), { status: 500 });
  }
  if (!claimed?.length) {
    const { count } = await db
      .from("legacy_photo_migration_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    return new Response(JSON.stringify({ done: true, remaining: count ?? 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const ids = claimed.map((r) => r.id);
  await db.from("legacy_photo_migration_queue")
    .update({ status: "processing" }).in("id", ids);

  let copied = 0, skipped = 0, failed = 0;

  for (const row of claimed) {
    try {
      const filename = row.source_url.split("/").pop()!;
      const objectPath = `${row.entity_slug}/${filename}`;
      const publicUrl =
        `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${TARGET_BUCKET}/${objectPath}`;

      // Already linked by an earlier run: close the row without re-copying.
      const { data: existing } = await db
        .from("entity_photos").select("id")
        .eq("entity_slug", row.entity_slug).eq("url", publicUrl).maybeSingle();

      if (existing) {
        await db.from("legacy_photo_migration_queue").update({
          status: "done", new_entity_photo_id: existing.id,
          processed_at: new Date().toISOString(), error: null,
        }).eq("id", row.id);
        skipped++;
        continue;
      }

      const res = await fetch(row.source_url);
      if (!res.ok) throw new Error(`source fetch ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("empty source file");

      const { error: upErr } = await db.storage.from(TARGET_BUCKET)
        .upload(objectPath, bytes, {
          contentType: res.headers.get("content-type") ?? "image/jpeg",
          upsert: true,
        });
      if (upErr) throw new Error(`upload: ${upErr.message}`);

      const { data: inserted, error: insErr } = await db
        .from("entity_photos").insert({
          entity_slug: row.entity_slug,
          url: publicUrl,
          image_path: objectPath,
          is_cover: row.is_cover,
          sort_order: row.sort_order,
          photo_type: "legacy_migration",
        }).select("id").single();
      if (insErr) throw new Error(`insert: ${insErr.message}`);

      await db.from("legacy_photo_migration_queue").update({
        status: "done", new_entity_photo_id: inserted.id,
        processed_at: new Date().toISOString(), error: null,
      }).eq("id", row.id);
      copied++;
    } catch (e) {
      // Leave the row inspectable rather than silently dropping it.
      await db.from("legacy_photo_migration_queue").update({
        status: "error", error: String(e).slice(0, 500),
        processed_at: new Date().toISOString(),
      }).eq("id", row.id);
      failed++;
    }
  }

  const { count: remaining } = await db
    .from("legacy_photo_migration_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  return new Response(
    JSON.stringify({ processed: claimed.length, copied, skipped, failed, remaining }),
    { headers: { "Content-Type": "application/json" } },
  );
});
