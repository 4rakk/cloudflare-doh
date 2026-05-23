// src/index.js
const DEFAULT_UPSTREAMS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
  "https://dns.quad9.net/dns-query",
];

function toJSON(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function getUpstreams(env) {
  const raw = (env.UPSTREAMS || "").trim();
  const items = raw
    ? raw.split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_UPSTREAMS;

  return [...new Set(items)];
}

function getAllowedPaths(env) {
  const prefix = (env.DOH_PATH_PREFIX || "").trim().replace(/^\/+|\/+$/g, "");
  const paths = ["/dns-query"];

  if (prefix) {
    paths.push(`/${prefix}/dns-query`);
  }

  return paths;
}

async function relayToUpstream(request, upstream, body) {
  const inUrl = new URL(request.url);
  const outUrl = new URL(upstream);

  outUrl.search = inUrl.search;

  const headers = new Headers();
  headers.set("accept", "application/dns-message");
  headers.set("cache-control", "no-store");

  if (request.method === "POST") {
    headers.set(
      "content-type",
      request.headers.get("content-type") || "application/dns-message"
    );
  }

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (body) init.body = body;

  const resp = await fetch(outUrl.toString(), init);

  const respHeaders = new Headers(resp.headers);
  respHeaders.set("cache-control", "no-store");
  respHeaders.set("x-doh-upstream", outUrl.origin);

  if (!respHeaders.get("content-type") && resp.status === 200) {
    respHeaders.set("content-type", "application/dns-message");
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const allowedPaths = getAllowedPaths(env);

    if (request.method === "GET" && path === "/") {
      return toJSON({
        ok: true,
        service: "private-doh-worker",
        supported_methods: ["GET", "POST"],
        doh_paths: allowedPaths,
        hint: "Use one of the listed paths as your DoH endpoint.",
      });
    }

    if (request.method === "GET" && path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (!allowedPaths.includes(path)) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    const upstreams = getUpstreams(env);
    const body = request.method === "POST" ? await request.arrayBuffer() : undefined;

    let lastError = null;

    for (const upstream of upstreams) {
      try {
        const resp = await relayToUpstream(request, upstream, body);
        if (resp.ok) return resp;
        lastError = new Error(`Upstream HTTP ${resp.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    return toJSON(
      {
        ok: false,
        error: "all upstreams failed",
        detail: String(lastError || "unknown"),
      },
      502
    );
  },
};
