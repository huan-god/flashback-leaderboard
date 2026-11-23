import { compressProof, maxScreenshotBytes } from "./compress.ts";

const apiUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Cache-Control": "private, no-store",
};
const boards = {
  mane: { table: "mane_entries", bucket: "mane-proofs" },
  flashback: { table: "submissions", bucket: "proofs" },
};

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status, headers });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return fail(405, "Method not allowed");
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return fail(401, "Sign-in required");

  const callerHeaders = { apikey: anonKey, authorization };
  try {
    const admin = await fetch(`${apiUrl}/rest/v1/rpc/is_admin`, {
      method: "POST",
      headers: { ...callerHeaders, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!admin.ok || await admin.json() !== true) return fail(403, "Administrator required");

    const input = await request.json().catch(() => null);
    const board = input?.board;
    const id = input?.id;
    if ((board !== "mane" && board !== "flashback") ||
        typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      return fail(400, "Invalid submission");
    }
    const { table, bucket } = boards[board as keyof typeof boards];
    const rowUrl = new URL(`${apiUrl}/rest/v1/${table}`);
    rowUrl.search = new URLSearchParams({
      select: "evidence_path",
      id: `eq.${id}`,
      archived_at: "is.null",
      limit: "1",
    }).toString();
    const row = await fetch(rowUrl, { headers: callerHeaders });
    if (!row.ok) return fail(502, "Could not read proof reference");

    const path = (await row.json())[0]?.evidence_path;
    if (typeof path !== "string" || !path) return fail(404, "Screenshot unavailable");
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      return fail(404, "Screenshot unavailable");
    }
    const key = parts.map(encodeURIComponent).join("/");
    const file = await fetch(`${apiUrl}/storage/v1/object/${bucket}/${key}`, { headers: callerHeaders });
    if (!file.ok) return fail(404, "Screenshot unavailable");
    if (Number(file.headers.get("content-length")) > maxScreenshotBytes) return fail(413, "Screenshot too large");
    const preview = await compressProof(await file.arrayBuffer());
    return new Response(preview, {
      headers: { ...headers, "Content-Type": "application/octet-stream" },
    });
  } catch (error) {
    console.error("Proof preview failed", error instanceof Error ? error.name : "unknown");
    return fail(502, "Could not generate preview");
  }
});
