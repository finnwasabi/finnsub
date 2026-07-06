const fs = require("fs");
const https = require("https");
const path = require("path");
const { createPrivateKey, createPublicKey, X509Certificate } = require("crypto");

const CERT_URL = "https://local-ip.medicmobile.org/fullchain";
const KEY_URL = "https://local-ip.medicmobile.org/key";
const CERT_DIR = path.join(__dirname, "..", "certs");
const CERT_PATH = path.join(CERT_DIR, "local-ip.pem");
const KEY_PATH = path.join(CERT_DIR, "local-ip.key");
const WILDCARD_DOMAIN = "*.local-ip.medicmobile.org";

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} returned HTTP ${res.statusCode}`));
          return;
        }

        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function getLeafCertificate(fullchain) {
  const match = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!match) throw new Error("Downloaded certificate does not contain a PEM certificate");
  return match[0];
}

function normalizePublicKey(key) {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function validateDownloadedFiles(fullchain, privateKeyPem) {
  if (!fullchain.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("Downloaded certificate is not PEM encoded");
  }

  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKeyPem)) {
    throw new Error("Downloaded private key is not PEM encoded");
  }

  const certificate = new X509Certificate(getLeafCertificate(fullchain));
  const expiresAt = new Date(certificate.validTo);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error(`Downloaded certificate is expired or invalid: ${certificate.validTo}`);
  }

  if (!certificate.subjectAltName.includes(`DNS:${WILDCARD_DOMAIN}`)) {
    throw new Error(`Downloaded certificate is not valid for ${WILDCARD_DOMAIN}`);
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const certPublicKey = normalizePublicKey(certificate.publicKey);
  const privatePublicKey = normalizePublicKey(createPublicKey(privateKey));
  if (certPublicKey !== privatePublicKey) {
    throw new Error("Downloaded certificate and private key do not match");
  }

  return certificate;
}

function writeFileAtomically(filePath, contents, mode) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, contents, { mode });
  fs.renameSync(tempPath, filePath);
}

async function main() {
  console.log("Refreshing local-ip.medicmobile.org HTTPS certificate...");

  const [fullchain, privateKey] = await Promise.all([fetchText(CERT_URL), fetchText(KEY_URL)]);
  const certificate = validateDownloadedFiles(fullchain, privateKey);

  fs.mkdirSync(CERT_DIR, { recursive: true });
  writeFileAtomically(CERT_PATH, fullchain.trimEnd() + "\n", 0o644);
  writeFileAtomically(KEY_PATH, privateKey.trimEnd() + "\n", 0o600);

  console.log(`Certificate refreshed. Valid until ${certificate.validTo}.`);
}

main().catch((error) => {
  console.error(`Failed to refresh local HTTPS certificate: ${error.message}`);

  try {
    const existingCertificate = validateDownloadedFiles(
      fs.readFileSync(CERT_PATH, "utf8"),
      fs.readFileSync(KEY_PATH, "utf8")
    );
    console.log(`Using existing local certificate. Valid until ${existingCertificate.validTo}.`);
  } catch (existingError) {
    console.error(`Existing local certificate cannot be used: ${existingError.message}`);
    process.exitCode = 1;
  }
});
