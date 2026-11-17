// Крошечный прокси для поиска по каталогу.
// Каталог не отдаёт CORS, поэтому браузер не может звать api-v2 напрямую.
// Воркер принимает ?url=<полный адрес api-v2> и возвращает JSON с CORS.
//
// Развёртывание: см. worker/README.md

const ALLOWED = /^https:\/\/api-v2\.soundcloud\.com\//;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const target = new URL(request.url).searchParams.get("url");
    if (!target || !ALLOWED.test(target)) {
      return json({ error: "bad url" }, 400);
    }

    let response;
    try {
      response = await fetch(target, {
        headers: { accept: "application/json", "user-agent": "kokky/1.0" },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (_) {
      return json({ error: "upstream failed" }, 502);
    }

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        ...CORS,
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}
