// worker.js
//
// Cloudflare Worker: server-side redemption check for Bulk File Downloader
// activation codes. Replaces the old client-side VALID_CODES list in
// popup.js, which shipped all 200 valid codes inside the extension source
// where anyone could read them for free.
//
// This Worker is the ONLY thing that knows whether a given code has already
// been redeemed. The extension never holds a list of valid codes — it just
// asks this Worker "is BFD-XXXX-XXXX good to activate on device Y?" and
// gets back yes/no.
//
// Storage: a KV namespace bound as `CODES`. Each key is a code
// (e.g. "BFD-2FXX-RKXD"), each value is JSON:
//   { redeemed: boolean, deviceIds: string[], firstActivatedAt?: number }
// Un-redeemed codes should be seeded with { redeemed: false, deviceIds: [] }
// before this goes live (see seed-kv.js in this same folder).
//
// A code allows up to MAX_DEVICES activations so a legitimate buyer can use
// it on e.g. a work laptop and a home laptop without being blocked — this is
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
  // and stores in chrome.storage.local — it identifies "this install", not a
  // real hardware fingerprint. Good enough to raise the bar above "completely
  // unlimited," not meant to be un-defeatable.
  if (!code || !/^BFD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) || !deviceId) {
    return withCors(json({ ok: false, reason: "bad_request" }, 400));
  }

  const raw = await env.CODES.get(code);
  if (raw === null) {
    return withCors(json({ ok: false, reason: "invalid" }, 404));
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    record = { redeemed: false, deviceIds: [] };
  }
  if (!Array.isArray(record.deviceIds)) record.deviceIds = [];

  // First redemption of this code.
  if (!record.redeemed) {
    record.redeemed = true;
    record.deviceIds = [deviceId];
    record.firstActivatedAt = Date.now();
    await env.CODES.put(code, JSON.stringify(record));
    return withCors(json({ ok: true }));
  }

  // Same device re-activating (reinstall, clicked Activate twice, etc.) —
  // idempotent, always allow.
  if (record.deviceIds.includes(deviceId)) {
    return withCors(json({ ok: true }));
  }

  // A new device, but still under the per-code device cap.
  if (record.deviceIds.length < MAX_DEVICES) {
    record.deviceIds.push(deviceId);
    await env.CODES.put(code, JSON.stringify(record));
    return withCors(json({ ok: true }));
  }

  // Cap reached — this code has already been activated on MAX_DEVICES
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
// anything sensitive — the only thing this API does is check/burn a code.
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
