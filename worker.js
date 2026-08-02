// worker.js
//
// Cloudflare Worker: server-side redemption check for Bulk File Downloader
// activation codes. Replaces the old client-side VALID_CODES list in
// popup.js, which shipped all 200 valid codes inside the extension source
// where anyone could read them for free.
//
// This Worker is the ONLY thing that knows whether a given code has already
// been redeemed. The extension never holds a list of valid codes -- it just
// asks this Worker "is BFD-XXXX-XXXX good to activate on device Y?" and
// gets back yes/no.
//
// Storage: a D1 database bound as `DB`, table `codes` with columns
// (code TEXT PRIMARY KEY, redeemed INTEGER, device_ids TEXT, first_activated_at INTEGER).
// device_ids is a JSON-encoded array stored as text (D1/SQLite has no native
// array type). All 200 codes were seeded with redeemed=0, device_ids='[]'
// directly via SQL -- see CLAUDE.md for how (switched from Workers KV to D1
// because the Cloudflare account's connected tooling could create a KV
// namespace but had no way to bulk-write key/value pairs into it, whereas D1
// accepts arbitrary SQL including bulk INSERT).
//
// A code allows up to MAX_DEVICES activations so a legitimate buyer can use
// it on e.g. a work laptop and a home laptop without being blocked -- this is
// a deliberate compromise, not a bug. Sharing a code publicly still gets cut
// off after MAX_DEVICES people redeem it, instead of being unlimited like
// the old client-side check.

const MAX_DEVICES = 3;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/activate") {
      return handleActivate(request, env);
    }

    return withCors(json({ ok: false, reason: "not_found" }, 404));
  }
};

async function handleActivate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return withCors(json({ ok: false, reason: "bad_request" }, 400));
  }

  const code = String(body.code || "").trim().toUpperCase();
  const deviceId = String(body.deviceId || "").trim();

  // deviceId is a random UUID the extension generates once on first install
  // and stores in chrome.storage.local -- it identifies "this install", not a
  // real hardware fingerprint. Good enough to raise the bar above "completely
  // unlimited," not meant to be un-defeatable.
  if (!code || !/^BFD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) || !deviceId) {
    return withCors(json({ ok: false, reason: "bad_request" }, 400));
  }

  const row = await env.DB.prepare(
    "SELECT redeemed, device_ids FROM codes WHERE code = ?"
  ).bind(code).first();

  if (!row) {
    return withCors(json({ ok: false, reason: "invalid" }, 404));
  }

  let deviceIds;
  try {
    deviceIds = JSON.parse(row.device_ids || "[]");
  } catch {
    deviceIds = [];
  }
  if (!Array.isArray(deviceIds)) deviceIds = [];

  // First redemption of this code.
  if (!row.redeemed) {
    await env.DB.prepare(
      "UPDATE codes SET redeemed = 1, device_ids = ?, first_activated_at = ? WHERE code = ?"
    ).bind(JSON.stringify([deviceId]), Date.now(), code).run();
    return withCors(json({ ok: true }));
  }

  // Same device re-activating (reinstall, clicked Activate twice, etc.) --
  // idempotent, always allow.
  if (deviceIds.includes(deviceId)) {
    return withCors(json({ ok: true }));
  }

  // A new device, but still under the per-code device cap.
  if (deviceIds.length < MAX_DEVICES) {
    deviceIds.push(deviceId);
    await env.DB.prepare(
      "UPDATE codes SET device_ids = ? WHERE code = ?"
    ).bind(JSON.stringify(deviceIds), code).run();
    return withCors(json({ ok: true }));
  }

  // Cap reached -- this code has already been activated on MAX_DEVICES
  // different installs.
  return withCors(json({ ok: false, reason: "already_used" }, 409));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// The extension calls this from a chrome-extension:// origin, not a regular
// web page, so a permissive CORS policy here isn't handing out access to
// anything sensitive -- the only thing this API does is check/burn a code.
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
