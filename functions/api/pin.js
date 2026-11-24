// Blue Market manage PIN API — Cloudflare Pages Function.
// POST /api/pin  { action: "verify", pin }            -> { ok: true } or 401
// POST /api/pin  { action: "change", pin, newPin }    -> { ok: true } or 401/400
// Shares the KV namespace and the same PIN as /api/products.

const DEFAULT_PIN = "4821";
const BLOCK_AFTER = 5;
const BLOCK_MS = 15 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function getPin(kv) {
  if (!kv) return DEFAULT_PIN;
  return (await kv.get("manage_pin")) || DEFAULT_PIN;
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.PRODUCTS || null;
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Not supported." }, 405);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Could not read that. Try again." }, 400);
  }
  if (!body || typeof body.action !== "string") {
    return json({ error: "Could not read that. Try again." }, 400);
  }

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  const attKey = "pin_attempts:" + ip;

  const readAttempts = async () => {
    if (!kv) return { count: 0, resetAt: 0 };
    const raw = await kv.get(attKey);
    if (!raw) return { count: 0, resetAt: 0 };
    try {
      return JSON.parse(raw);
    } catch {
      return { count: 0, resetAt: 0 };
    }
  };
  const noteFailure = async (rec) => {
    if (!kv) return;
    const next = {
      count: rec.count + 1,
      resetAt: rec.count + 1 >= BLOCK_AFTER ? Date.now() + BLOCK_MS : 0,
    };
    await kv.put(attKey, JSON.stringify(next), { expirationTtl: 1800 });
  };

  const pin = String(body.pin || "");
  if (body.action === "verify") {
    if (!pin) return json({ ok: false, error: "Enter your PIN." }, 401);
    const rec = await readAttempts();
    if (rec.count >= BLOCK_AFTER && Date.now() < rec.resetAt) {
      return json({ ok: false, error: "Too many wrong tries. Wait 15 minutes and try again." }, 401);
    }
    const real = await getPin(kv);
    if (pin !== real) {
      await noteFailure(rec);
      return json({ ok: false, error: "Wrong PIN. Try again." }, 401);
    }
    if (kv) await kv.delete(attKey);
    return json({ ok: true });
  }

  if (body.action === "change") {
    const newPin = String(body.newPin || "");
    if (!pin) return json({ error: "Enter your current PIN." }, 401);
    const rec = await readAttempts();
    if (rec.count >= BLOCK_AFTER && Date.now() < rec.resetAt) {
      return json({ error: "Too many wrong tries. Wait 15 minutes and try again." }, 401);
    }
    const real = await getPin(kv);
    if (pin !== real) {
      await noteFailure(rec);
      return json({ error: "Wrong PIN. Try again." }, 401);
    }
    if (!/^[0-9]{4,8}$/.test(newPin)) {
      return json({ error: "The new PIN must be 4 to 8 numbers." }, 400);
    }
    if (!kv) return json({ error: "The shop store is not set up yet. Tell Red." }, 503);
    await kv.put("manage_pin", newPin);
    await kv.delete(attKey);
    return json({ ok: true });
  }

  return json({ error: "Not supported." }, 400);
}
