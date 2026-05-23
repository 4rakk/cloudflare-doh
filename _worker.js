const DEFAULT_UPSTREAMS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
  "https://dns.quad9.net/dns-query",
];

const DEFAULT_LEGACY_MAPPINGS = {
  "/google": {
    targetUrl: "https://dns.google/dns-query",
    pathMapping: {
      "/query-dns": "/dns-query",
    },
  },
  "/cloudflare": {
    targetUrl: "https://cloudflare-dns.com/dns-query",
    pathMapping: {
      "/query-dns": "/dns-query",
    },
  },
  "/quad9": {
    targetUrl: "https://dns.quad9.net/dns-query",
    pathMapping: {
      "/query-dns": "/dns-query",
    },
  },
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function normalizePrefix(prefix) {
  const p = String(prefix || "").trim();
  if (!p) return "";
  return `/${p.replace(/^\/+|\/+$/g, "")}`;
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }

  const raw = String(value).trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {}
  }

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}

function getUpstreams(env) {
  const list = parseList(env?.UPSTREAMS);
  const upstreams = list.length ? list : DEFAULT_UPSTREAMS;
  return [...new Set(upstreams)];
}

function getAllowedPaths(env) {
  const paths = new Set(["/dns-query"]);
  const prefix = normalizePrefix(env?.DOH_PATH_PREFIX);
  if (prefix) paths.add(`${prefix}/dns-query`);

  // 兼容旧路径
  paths.add("/google/query-dns");
  paths.add("/cloudflare/query-dns");
  paths.add("/quad9/query-dns");

  const custom = parseObject(env?.DOMAIN_MAPPINGS);
  if (custom) {
    for (const [prefixKey] of Object.entries(custom)) {
      const p = normalizePrefix(prefixKey);
      if (p) paths.add(`${p}/query-dns`);
    }
  }

  return [...paths];
}

function buildTargetUrl(base, pathname, queryString) {
  const url = new URL(base);
  url.pathname = pathname || url.pathname || "/dns-query";
  url.search = queryString || "";
  return url;
}

function resolveLegacyTarget(path, queryString, env) {
  const custom = parseObject(env?.DOMAIN_MAPPINGS);
  const mappings = custom && Object.keys(custom).length ? custom : DEFAULT_LEGACY_MAPPINGS;

  for (const [prefixKey, mapping] of Object.entries(mappings)) {
    const prefix = normalizePrefix(prefixKey);
    if (!prefix) continue;

    if (!path.startsWith(prefix)) continue;

    const remainingPath = path.slice(prefix.length) || "/";
    const pathMapping = mapping?.pathMapping && typeof mapping.pathMapping === "object"
      ? mapping.pathMapping
      : {};

    let targetPath = remainingPath;

    for (const [sourcePath, destPath] of Object.entries(pathMapping)) {
      if (remainingPath === sourcePath || remainingPath.startsWith(sourcePath)) {
        targetPath = remainingPath.replace(sourcePath, destPath);
        break;
      }
    }

    const targetBase =
      mapping?.targetUrl ||
      (mapping?.targetDomain ? `https://${mapping.targetDomain}` : null);

    if (!targetBase) continue;

    return buildTargetUrl(targetBase, targetPath, queryString);
  }

  return null;
}

function resolveStandardTarget(queryString, env) {
  const prefix = normalizePrefix(env?.DOH_PATH_PREFIX);
  if (prefix) {
    return {
      standard: buildTargetUrl("https://cloudflare-dns.com/dns-query", `${prefix}/dns-query`, queryString),
    };
  }

  return {
    standard: buildTargetUrl("https://cloudflare-dns.com/dns-query", "/dns-query", queryString),
  };
}

async function forwardDoH(request, upstreamUrl) {
  const headers = new Headers();
  headers.set("accept", request.headers.get("accept") || "application/dns-message");
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

  if (request.method === "POST") {
    init.body = await request.arrayBuffer();
  }

  const resp = await fetch(upstreamUrl.toString(), init);

  const respHeaders = new Headers(resp.headers);
  respHeaders.set("cache-control", "no-store");
  respHeaders.set("x-doh-upstream", upstreamUrl.origin);

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

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return json({
        ok: true,
        service: "cloudflare-doh",
        note: "Standard DoH endpoint is /dns-query. Legacy /google/query-dns and /cloudflare/query-dns are kept for compatibility.",
        doh_paths: getAllowedPaths(env),
      });
    }

    if (request.method === "GET" && path === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const allowedPaths = getAllowedPaths(env);
    if (!allowedPaths.includes(path)) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }

    const legacyTarget = resolveLegacyTarget(path, url.search, env);
    const standardTarget = resolveStandardTarget(url.search, env).standard;

    const candidates = [];
    if (legacyTarget) {
      candidates.push(legacyTarget);
    } else {
      candidates.push(standardTarget);
      for (const upstream of getUpstreams(env)) {
        try {
          const u = new URL(upstream);
          if (
            u.origin !== standardTarget.origin ||
            u.pathname !== standardTarget.pathname
          ) {
            candidates.push(buildTargetUrl(upstream, "/dns-query", url.search));
          }
        } catch {}
      }
    }

    let lastError = null;

    for (const candidate of candidates) {
      try {
        const resp = await forwardDoH(request, candidate);

        // 4xx 直接返回，5xx 才继续尝试下一个上游
        if (resp.status < 500) return resp;

        lastError = new Error(`upstream returned HTTP ${resp.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    return json(
      {
        ok: false,
        error: "all upstreams failed",
        detail: String(lastError || "unknown"),
      },
      502
    );
  },
};
