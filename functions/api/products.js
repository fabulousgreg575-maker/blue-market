// Blue Market products API — Cloudflare Pages Function.
// KV binding "PRODUCTS" (namespace blue-market-products).
// GET  /api/products            -> { builtin, added, deleted, kvAvailable }
// POST /api/products            -> { pin, name, price, colour, size, img } adds a product
// DELETE /api/products?id=..&pin=..            -> deletes an added product, or hides a built-in one
// DELETE /api/products?id=..&pin=..&restore=1  -> brings back a hidden built-in product

const BUILTIN = [
  { id: 1, name: "Black Slip-On — Leather-Look", price: 350, colours: ["Black"] },
  { id: 2, name: "Suede-Look Slip-On", price: 350, colours: ["Black", "Tan"] },
  { id: 3, name: "Mesh Slip-On", price: 350, colours: ["Black/Grey", "Grey"] },
  { id: 4, name: "Brown Formal Zip Shoe", price: 350, colours: ["Brown"] },
  { id: 5, name: "Black Loafers — Leather-Look", price: 350, colours: ["Black"] },
  { id: 6, name: "Black Canvas Slip-On — Cream Sole", price: 350, colours: ["Black"] },
  { id: 7, name: "Black Sport Lace-Up — Red Accent", price: 350, colours: ["Black"] },
  { id: 8, name: "Navy Mesh Outdoor Shoe", price: 350, colours: ["Navy"] },
];

const DEFAULT_PIN = "4821";
const MAX_ADDED = 50;
const MAX_IMG_CHARS = 2600000; // ~1.9 MB of photo after base64
const BLOCK_AFTER = 5; // wrong PIN tries
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

async function attemptsKey(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  return "pin_attempts:" + ip;
}

async function checkPin(kv, request, pin) {
  // Returns { ok: true } or { ok: false, error } and counts failed tries.
  if (typeof pin !== "string" || !pin) return { ok: false, error: "Enter your PIN." };
  if (kv) {
    const key = await attemptsKey(request);
    const raw = await kv.get(key);
    const rec = raw ? JSON.parse(raw) : { count: 0, resetAt: 0 };
    if (rec.count >= BLOCK_AFTER && Date.now() < rec.resetAt) {
      return { ok: false, error: "Too many wrong tries. Wait 15 minutes and try again." };
    }
    const real = await getPin(kv);
    if (pin !== real) {
      const next = {
        count: rec.count + 1,
        resetAt: rec.count + 1 >= BLOCK_AFTER ? Date.now() + BLOCK_MS : 0,
      };
      await kv.put(key, JSON.stringify(next), { expirationTtl: 1800 });
      return { ok: false, error: "Wrong PIN. Try again." };
    }
    await kv.delete(key);
    return { ok: true };
  }
  return pin === DEFAULT_PIN
    ? { ok: true }
    : { ok: false, error: "Wrong PIN. Try again." };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function loadCustom(kv) {
  if (!kv) return [];
  const raw = await kv.get("custom_products");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function loadDeleted(kv) {
  if (!kv) return [];
  const raw = await kv.get("deleted_builtin");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.PRODUCTS || null;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "GET") {
    return json({
      builtin: BUILTIN,
      added: await loadCustom(kv),
      deleted: await loadDeleted(kv),
      kvAvailable: !!kv,
    });
  }

  if (method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "Could not read that. Try again." }, 400);
    const pinCheck = await checkPin(kv, request, body.pin);
    if (!pinCheck.ok) return json({ error: pinCheck.error }, 401);
    if (!kv) return json({ error: "The shop store is not set up yet. Tell Red." }, 503);

    const name = String(body.name || "").trim();
    const price = Number(body.price);
    const colour = String(body.colour || "").trim().slice(0, 40);
    const size = String(body.size || "").trim().slice(0, 20);
    const img = String(body.img || "");
    if (!name || name.length > 80) return json({ error: "Give the product a name." }, 400);
    if (!Number.isFinite(price) || price < 1 || price > 100000 || !Number.isInteger(price))
      return json({ error: "Give a whole price in GH¢, for example 350." }, 400);
    if (!img.startsWith("data:image/") || !img.includes(";base64,"))
      return json({ error: "Add a photo of the product." }, 400);
    if (img.length > MAX_IMG_CHARS)
      return json({ error: "That photo is too big. Try a smaller one." }, 400);

    const custom = await loadCustom(kv);
    if (custom.length >= MAX_ADDED)
      return json({ error: "The shop is full. Delete an old product first." }, 400);
    const product = {
      id: "c-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 6),
      name,
      price,
      colour,
      size,
      img,
      createdAt: Date.now(),
    };
    custom.push(product);
    await kv.put("custom_products", JSON.stringify(custom));
    return json({ product }, 201);
  }

  if (method === "DELETE") {
    const pin = url.searchParams.get("pin") || "";
    const id = url.searchParams.get("id") || "";
    const restore = url.searchParams.get("restore") === "1";
    const pinCheck = await checkPin(kv, request, pin);
    if (!pinCheck.ok) return json({ error: pinCheck.error }, 401);
    if (!kv) return json({ error: "The shop store is not set up yet. Tell Red." }, 503);
    if (!id) return json({ error: "No product picked." }, 400);

    if (restore) {
      const deleted = await loadDeleted(kv);
      const next = deleted.filter((d) => String(d) !== String(id));
      await kv.put("deleted_builtin", JSON.stringify(next));
      return json({ ok: true, restored: id });
    }

    if (id.startsWith("c-")) {
      const custom = await loadCustom(kv);
      const next = custom.filter((p) => p.id !== id);
      if (next.length === custom.length) return json({ error: "That product is not there." }, 404);
      await kv.put("custom_products", JSON.stringify(next));
      return json({ ok: true, deleted: id });
    }

    const numId = Number(id);
    if (!BUILTIN.some((b) => b.id === numId)) return json({ error: "That product is not there." }, 404);
    const deleted = await loadDeleted(kv);
    if (!deleted.map(String).includes(String(numId))) {
      deleted.push(numId);
      await kv.put("deleted_builtin", JSON.stringify(deleted));
    }
    return json({ ok: true, deleted: id });
  }

  return json({ error: "Not supported." }, 405);
}
