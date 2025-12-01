#!/usr/bin/env node
/**
 * Sub-Store 节点测活/重命名脚本（参考 xream/Keywos 规则）
 *
 * 功能：
 * - 并发测活：HTTP/HTTPS 请求，支持重试、超时、代理(HTTP META 方式)
 * - 状态码判定：数字、范围表达式(200-299)、比较符(>=400) 或逗号分隔组合
 * - 入口/出口/国旗/IP 等信息透传，支持重命名模板与附加延迟
 * - 可选择保留不兼容协议节点、跳过网络探测（离线验证）
 *
 * 用法示例：
 *   node substore_check.js --input examples/nodes.json --skip-probe
 *   node substore_check.js --input examples/nodes.json \
 *     --url "http://connectivitycheck.platform.hicloud.com/generate_204" \
 *     --status "204,200-299" --timeout 1200 --retries 1 --retry-delay 500 \
 *     --concurrency 8 --pattern "{flag}{name} {entry}->{exit} ({ip})" --show-latency
 *   node substore_check.js --input examples/nodes.json --http-meta-protocol http \
 *     --http-meta-host 127.0.0.1 --http-meta-port 9876 --http-meta-proxy-timeout 8000
 */

const { parseArgs } = require("node:util");
const { readFile, writeFile } = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const { setTimeout: delay } = require("node:timers/promises");
const { performance } = require("node:perf_hooks");

const DEFAULT_URL = "http://connectivitycheck.platform.hicloud.com/generate_204";
const DEFAULT_STATUS = "204";
const PLACEHOLDERS = new Set([
  "index",
  "name",
  "flag",
  "ip",
  "entry",
  "exit",
  "country",
  "city",
  "isp",
  "latency",
]);

function parseCli() {
  const { values: options } = parseArgs({
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      url: { type: "string", default: DEFAULT_URL },
      status: { type: "string", default: DEFAULT_STATUS },
      concurrency: { type: "string", default: "6" },
      timeout: { type: "string", default: "1000" },
      retries: { type: "string", default: "0" },
      "retry-delay": { type: "string", default: "300" },
      "keep-incompatible": { type: "boolean", default: false },
      "show-latency": { type: "boolean", default: false },
      "include-inactive": { type: "boolean", default: false },
      pattern: { type: "string", default: "{flag}{name} {entry}->{exit} ({ip})" },
      "http-meta-protocol": { type: "string" },
      "http-meta-host": { type: "string" },
      "http-meta-port": { type: "string" },
      "http-meta-start-delay": { type: "string", default: "0" },
      "http-meta-proxy-timeout": { type: "string", default: "10000" },
      "skip-probe": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!options.input) {
    throw new Error("--input is required");
  }

  return {
    input: options.input,
    output: options.output,
    url: options.url,
    statusExp: options.status,
    concurrency: Number.parseInt(options.concurrency, 10),
    timeout: Number.parseInt(options.timeout, 10),
    retries: Number.parseInt(options.retries, 10),
    retryDelay: Number.parseInt(options["retry-delay"], 10),
    keepIncompatible: options["keep-incompatible"],
    showLatency: options["show-latency"],
    includeInactive: options["include-inactive"],
    pattern: options.pattern,
    httpMeta: options["http-meta-host"]
      ? {
          protocol: options["http-meta-protocol"] || "http",
          host: options["http-meta-host"],
          port: Number.parseInt(options["http-meta-port"] || "80", 10),
          startDelay: Number.parseInt(options["http-meta-start-delay"], 10),
          proxyTimeout: Number.parseInt(options["http-meta-proxy-timeout"] || "10000", 10),
        }
      : null,
    skipProbe: options["skip-probe"],
  };
}

async function loadNodes(path) {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array of nodes");
  }
  return parsed.map((node, index) => normalizeNode(node, index));
}

function normalizeNode(node, index) {
  return {
    index: index + 1,
    name: String(node.name || node.remark || "Unnamed").trim(),
    flag: node.flag || node.emoji || "",
    ip: node.ip || node.address || node.server || "",
    entry: node.entry || node.ingress || node.inbound || node.source || node.from || "",
    exit: node.exit || node.egress || node.destination || node.to || node.outbound || "",
    country: node.country || node.cn || node.loc || "",
    city: node.city || node.location || "",
    isp: node.isp || node.provider || node.asn || "",
    protocol: (node.type || node.protocol || "").toLowerCase(),
    meta: node.meta || {},
    raw: node,
  };
}

function statusMatcher(expression) {
  const parts = expression
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const matchers = parts.map((part) => {
    if (/^\d+$/.test(part)) {
      const code = Number(part);
      return (status) => status === code;
    }
    if (/^(\d+)-(\d+)$/.test(part)) {
      const [, start, end] = part.match(/^(\d+)-(\d+)$/);
      const s = Number(start);
      const e = Number(end);
      return (status) => status >= s && status <= e;
    }
    if (/^>=\d+$/.test(part)) {
      const code = Number(part.slice(2));
      return (status) => status >= code;
    }
    if (/^<=\d+$/.test(part)) {
      const code = Number(part.slice(2));
      return (status) => status <= code;
    }
    if (/^>\d+$/.test(part)) {
      const code = Number(part.slice(1));
      return (status) => status > code;
    }
    if (/^<\d+$/.test(part)) {
      const code = Number(part.slice(1));
      return (status) => status < code;
    }
    if (/^!=\d+$/.test(part)) {
      const code = Number(part.slice(2));
      return (status) => status !== code;
    }
    throw new Error(`Unsupported status expression: ${part}`);
  });

  return (status) => matchers.some((fn) => fn(status));
}

async function probe(url, timeoutMs, agent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = performance.now();
  const protocol = url.startsWith("https") ? https : http;
  const options = new URL(url);
  const transportOptions = {
    hostname: options.hostname,
    port: options.port || (options.protocol === "https:" ? 443 : 80),
    path: `${options.pathname}${options.search}`,
    method: "GET",
    signal: controller.signal,
    agent,
  };

  return new Promise((resolve, reject) => {
    const req = protocol.request(transportOptions, (res) => {
      res.resume();
      const latency = performance.now() - start;
      clearTimeout(timer);
      resolve({ status: res.statusCode || 0, latency });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

function createHttpMetaAgent(httpMeta) {
  if (!httpMeta) return null;
  // Simple HTTP proxy via CONNECT is overkill; we only support plain proxy style for HTTP.
  const agent = new http.Agent({
    keepAlive: true,
    timeout: httpMeta.proxyTimeout,
  });
  agent.createConnection = (opts, cb) => {
    const req = http.request(
      {
        host: httpMeta.host,
        port: httpMeta.port,
        method: "CONNECT",
        path: `${opts.host}:${opts.port}`,
        timeout: httpMeta.proxyTimeout,
      },
      (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          cb(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
          return;
        }
        cb(null, socket);
      },
    );
    req.on("error", cb);
    req.end();
  };
  return agent;
}

async function probeNode(node, opts, matcher, agent) {
  if (opts.skipProbe) {
    return { active: true, latency: null, status: null };
  }
  let attempts = 0;
  let lastError = null;
  if (opts.httpMeta?.startDelay) {
    await delay(opts.httpMeta.startDelay);
  }

  while (attempts <= opts.retries) {
    try {
      const result = await probe(opts.url, opts.timeout, agent);
      const active = matcher(result.status);
      return { active, latency: result.latency, status: result.status };
    } catch (error) {
      lastError = error;
      attempts += 1;
      if (attempts > opts.retries) break;
      await delay(opts.retryDelay);
    }
  }

  return { active: false, latency: null, status: lastError?.code || null, error: lastError };
}

function renameNode(node, pattern, showLatency, latency) {
  const data = {
    index: node.index,
    name: node.name,
    flag: node.flag,
    ip: node.ip,
    entry: node.entry,
    exit: node.exit,
    country: node.country,
    city: node.city,
    isp: node.isp,
    latency: latency != null ? `${Math.round(latency)}ms` : "",
  };
  const missing = [...PLACEHOLDERS].filter((key) => !(key in data));
  if (missing.length) {
    throw new Error(`Pattern is missing placeholders: ${missing.join(", ")}`);
  }
  let renamed = pattern.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? "");
  if (showLatency && latency != null) {
    renamed += ` (${Math.round(latency)}ms)`;
  }
  return renamed.trim();
}

function isCompatible(node) {
  if (!node.protocol) return true; // unknown protocol is assumed ok
  return ["http", "https", "h2", "trojan", "ss", "vmess", "vless", "tuic"].includes(
    node.protocol,
  );
}

async function run() {
  const opts = parseCli();
  const matcher = statusMatcher(opts.statusExp);
  const nodes = await loadNodes(opts.input);

  const agent = createHttpMetaAgent(opts.httpMeta);
  const results = [];
  let activeCount = 0;

  const queue = [...nodes];
  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    while (queue.length) {
      const node = queue.shift();
      if (!opts.keepIncompatible && !isCompatible(node)) {
        results.push({
          ...node,
          active: false,
          reason: "incompatible",
          renamed: renameNode(node, opts.pattern, opts.showLatency, null),
          latency: null,
          status: null,
        });
        continue;
      }
      const probeResult = await probeNode(node, opts, matcher, agent);
      const renamed = renameNode(node, opts.pattern, opts.showLatency, probeResult.latency);
      const active = probeResult.active;
      if (active) activeCount += 1;
      results.push({
        ...node,
        active,
        status: probeResult.status,
        latency: probeResult.latency,
        renamed,
      });
    }
  });

  await Promise.all(workers);

  const filtered = opts.includeInactive ? results : results.filter((n) => n.active);
  const payload = {
    summary: {
      total: results.length,
      active: activeCount,
      filtered: filtered.length,
      url: opts.url,
      status: opts.statusExp,
    },
    nodes: filtered,
  };

  const serialized = JSON.stringify(payload, null, 2);
  if (opts.output) {
    await writeFile(opts.output, `${serialized}\n`, "utf-8");
  } else {
    process.stdout.write(`${serialized}\n`);
  }
}

run().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
