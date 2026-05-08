const { execSync } = require("child_process");
const { networkInterfaces } = require("os");

function getLanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;

  try {
    const lines = execSync("getent ahostsv4 host.docker.internal", { timeout: 2000 })
      .toString()
      .trim()
      .split("\n");
    const ipv4 = lines[0]?.split(/\s+/)[0];
    if (isUsableIpv4(ipv4)) return ipv4;
  } catch {
    // host.docker.internal is not available in every runtime.
  }

  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (isUsableIpv4(net.address)) return net.address;
    }
  }

  return "127.0.0.1";
}

function isUsableIpv4(ip) {
  return Boolean(
    ip &&
    /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
    !ip.startsWith("127.") &&
    !ip.startsWith("172.")
  );
}

function ipToDashed(ip) {
  return ip.replace(/\./g, "-");
}

function getAddonUrl(ip, port) {
  const portSuffix = Number(port) === 443 ? "" : `:${port}`;
  return `https://${ipToDashed(ip)}.local-ip.medicmobile.org${portSuffix}`;
}

function isLocalIpHttpsEnabled() {
  return String(process.env.LOCAL_IP_HTTPS || "").toUpperCase() === "TRUE";
}

function getBaseUrlFromRequest(req) {
  const host = req.headers.host;
  if (!host) return null;

  const normalizedHost = host.endsWith(":443") ? host.slice(0, -4) : host;
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${normalizedHost}`;
}

function getPublicBaseUrl(req, fallbackBaseUrl) {
  const host = req.headers.host;
  if (!host) return fallbackBaseUrl;

  const normalizedHost = host.endsWith(":443") ? host.slice(0, -4) : host;
  if (isLoopbackHost(normalizedHost)) return fallbackBaseUrl;

  return getBaseUrlFromRequest(req) || fallbackBaseUrl;
}

function isLoopbackHost(host) {
  const hostname = host.split(":")[0].toLowerCase();
  return hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}

module.exports = {
  getLanIp,
  getAddonUrl,
  getBaseUrlFromRequest,
  getPublicBaseUrl,
  isLocalIpHttpsEnabled,
};
