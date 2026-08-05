// worker.js
//
// Cloudflare Worker: thin, secure proxy between the extension and Creem's
// license key API.
//
// WHY THIS PROXY EXISTS AT ALL (don't remove it and call Creem directly from
// the extension): Creem's license validate/activate endpoints require an
// `x-api-key` header. Creem's own docs are explicit that this key must never
// be shipped in client-side code -- an extension's popup.js is exactly that,
// readable by anyone who unpacks the .crx. So this Worker holds the API key
// as a server-side secret, and the extension only ever talks to this Worker,
// never to api.creem.io directly.
//
// This REPLACES the old design (see CLAUDE.md / git history) where this
// Worker queried its own D1 database of 200 pre-generated codes. That whole
// system -- the D1 table, the Google Sheet code pool, the Make.com scenario
// that looked up an unused code and emailed it -- is retired. Creem now
// generates a fresh license key automatically for every real purchase and
// emails it to the buyer itself. This Worker's only job is: given a code +
// a device id, ask Creem's API "is this valid, can this device use it?"
// and translate the answer into the same {ok:true} / {ok:false, reason}
// shape the extension already expects, so popup.js needed zero changes.
//
// Config (set in the Cloudflare dashboard, Worker > Settings > Variables):
//   CREEM_API_KEY   (secret)   -- test key while validating, swap to the
//                                 live key before shipping to real users
//   CREEM_API_BASE  (var)      -- "https://test-api.creem.io" during testing,
//                                 "https://api.creem.io" once live

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

  // Creem license keys don't follow the old BFD-XXXX-XXXX shape, so this is
  // deliberately just a non-empty check, not a format check.
  const code = String(body.code || "").trim();
  const deviceId = String(body.deviceId || "").trim();

  if (!code || !deviceId) {
    return withCors(json({ ok: false, reason: "bad_request" }, 400));
  }

  if (!env.CREEM_API_KEY || !env.CREEM_API_BASE) {
    // Misconfigured Worker (missing secret/var) -- fail closed, don't leak
    // details to the client.
    console.error("Worker misconfigured: CREEM_API_KEY or CREEM_API_BASE not set");
    return withCors(json({ ok: false, reason: "bad_response" }, 500));
  }

  let creemRes;
  try {
    creemRes = await fetch(`${env.CREEM_API_BASE}/v1/licenses/activate`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "x-api-key": env.CREEM_API_KEY,
        "Content-Type": "application/json"
      },
      // instance_name is just a label on Creem's side (per their docs) --
      // we pass our random per-install deviceId so each install shows up as
      // a distinct, identifiable instance in the Creem dashboard.
      body: JSON.stringify({ key: code, instance_name: deviceId })
    });
  } catch (err) {
    console.error("Creem API request failed:", err);
    return withCors(json({ ok: false, reason: "bad_response" }, 502));
  }

  if (creemRes.ok) {
    return withCors(json({ ok: true }));
  }

  // Map Creem's error codes (see docs.creem.io/features/addons/licenses)
  // onto the reasons popup.js already knows how to show a message for.
  if (creemRes.status === 403) {
    // Activation limit reached for this key.
    return withCors(json({ ok: false, reason: "already_used" }, 409));
  }
  if (creemRes.status === 404 || creemRes.status === 410) {
    // Unknown key, or revoked/expired.
    return withCors(json({ ok: false, reason: "invalid" }, 404));
  }

  // Anything else (401 = our own API key is wrong, 400 = malformed request,
  // 5xx = Creem's side having issues) -- don't try to guess further, just
  // fail closed with a generic reason.
  const text = await creemRes.text().catch(() => "");
  console.error(`Creem activate returned ${creemRes.status}: ${text}`);
  return withCors(json({ ok: false, reason: "bad_response" }, 502));
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
