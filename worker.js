// worker.js
//
// Cloudflare Worker: thin proxy between the extension and Dodo Payments'
// license key API.
//
// WHY THIS PROXY EXISTS (even though Dodo's activate/validate endpoints are
// public and need no API key -- unlike Creem's, which is why this Worker was
// originally built): keeping this indirection layer means that if Dodo ever
// changes its API shape, or we ever need to switch payment processors again,
// we only have to edit and redeploy this Worker (takes seconds, no review).
// Without it, any backend change would require shipping a new popup.js,
// which means a new Chrome Web Store submission and another review wait.
// This is the second processor this Worker has fronted -- it was Creem
// before Creem's account review rejected us. See CLAUDE.md for that history.
//
// This Worker's only job: given a license key + a device id, ask Dodo's API
// "is this valid, can this device activate it?" and translate the answer
// into the same {ok:true} / {ok:false, reason} shape the extension already
// expects, so popup.js needs zero changes.
//
// Config (set in the Cloudflare dashboard, Worker > Settings > Variables):
//   DODO_API_BASE  (var, NOT secret) -- "https://test.dodopayments.com"
//                                       during testing, "https://live.dodopayments.com"
//                                       once live. No API key needed --
//                                       Dodo's license endpoints are public,
//                                       designed to be called straight from
//                                       client apps.

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

  // Dodo license keys don't follow the old BFD-XXXX-XXXX shape, so this is
  // deliberately just a non-empty check, not a format check.
  const code = String(body.code || "").trim();
  const deviceId = String(body.deviceId || "").trim();

  if (!code || !deviceId) {
    return withCors(json({ ok: false, reason: "bad_request" }, 400));
  }

  if (!env.DODO_API_BASE) {
    // Misconfigured Worker (missing var) -- fail closed, don't leak details
    // to the client.
    console.error("Worker misconfigured: DODO_API_BASE not set");
    return withCors(json({ ok: false, reason: "bad_response" }, 500));
  }

  let dodoRes;
  try {
    dodoRes = await fetch(`${env.DODO_API_BASE}/licenses/activate`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json"
      },
      // `name` is just a label on Dodo's side (shows up per-instance in
      // their dashboard) -- we pass our random per-install deviceId so each
      // install is a distinct, identifiable activation.
      body: JSON.stringify({ license_key: code, name: deviceId })
    });
  } catch (err) {
    console.error("Dodo API request failed:", err);
    return withCors(json({ ok: false, reason: "bad_response" }, 502));
  }

  // 201 = license key instance created successfully.
  if (dodoRes.status === 201) {
    return withCors(json({ ok: true }));
  }

  // Map Dodo's error codes (see docs.dodopayments.com/api-reference/licenses)
  // onto the reasons popup.js already knows how to show a message for.
  if (dodoRes.status === 422) {
    // Activation limit reached for this key.
    return withCors(json({ ok: false, reason: "already_used" }, 409));
  }
  if (dodoRes.status === 403 || dodoRes.status === 404) {
    // 403 = key exists but is inactive/revoked/expired. 404 = unknown key.
    return withCors(json({ ok: false, reason: "invalid" }, 404));
  }

  // Anything else (400 = malformed request, 5xx = Dodo's side having
  // issues) -- don't try to guess further, just fail closed with a generic
  // reason.
  const text = await dodoRes.text().catch(() => "");
  console.error(`Dodo activate returned ${dodoRes.status}: ${text}`);
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
