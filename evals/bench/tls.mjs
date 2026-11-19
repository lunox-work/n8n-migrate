#!/usr/bin/env node
// TLS interception material for the bench's HTTP mock: one local CA and one leaf certificate
// per host, made with the `openssl` CLI (no npm dependency). The folder is git-ignored and
// holds bench-only keys that protect nothing.
//
//   node evals/bench/tls.mjs [host ...]     make the CA (once) and a leaf for each host
//   node evals/bench/tls.mjs --list         hosts that have a leaf
//
// Layout (TLS_DIR, default evals/bench/.tls):
//   ca.key, ca.pem                 the CA; n8n trusts ca.pem through NODE_EXTRA_CA_CERTS
//   hosts/<host>.key, <host>.pem   leaf for one host (subjectAltName DNS:<host>, IP:<host> for an IPv4 host), signed by the CA
// The mock (evals/n8n/mock-server.mjs --tls-dir) terminates TLS on CONNECT for every host
// that has a leaf here, and refuses CONNECT for any other host, as before.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TLS_DIR = resolve(process.env.N8M_BENCH_TLS || join(HERE, ".tls"));

function openssl(args, cwd) {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.error) throw new Error(`openssl not available: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || "").trim().slice(0, 500)}`);
  return r.stdout;
}

// A host name is used as a file name and in an openssl config: keep it to DNS characters.
export function safeHost(h) {
  const host = String(h).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) throw new Error(`not a host name: ${h}`);
  return host;
}

export function ensureCa(dir = TLS_DIR) {
  mkdirSync(join(dir, "hosts"), { recursive: true });
  if (existsSync(join(dir, "ca.pem")) && existsSync(join(dir, "ca.key"))) return join(dir, "ca.pem");
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3650", "-subj", "/CN=n8nmigrate bench CA (test only)", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], dir);
  return join(dir, "ca.pem");
}

// PROPOSALS P62: an IPv4 host gets an `IP:` subjectAltName (a TLS client checks an IP host
// against the certificate's IP addresses, never its DNS names); a leaf made before for such a
// host with a DNS name only is made again.
export const isIPv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(h)) && String(h).split(".").every((x) => Number(x) <= 255);
const hasIpSan = (pem) => /IP Address:/.test(spawnSync("openssl", ["x509", "-noout", "-ext", "subjectAltName", "-in", pem], { encoding: "utf8" }).stdout ?? "");

export function ensureLeaf(host, dir = TLS_DIR) {
  const h = safeHost(host);
  ensureCa(dir);
  const hd = join(dir, "hosts");
  if (existsSync(join(hd, `${h}.pem`)) && existsSync(join(hd, `${h}.key`)) && (!isIPv4(h) || hasIpSan(join(hd, `${h}.pem`)))) return { key: join(hd, `${h}.key`), cert: join(hd, `${h}.pem`), made: false };
  const ext = join(hd, `${h}.ext`);
  writeFileSync(ext, `subjectAltName=${isIPv4(h) ? "IP" : "DNS"}:${h}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${h}.key`, "-out", `${h}.csr`, "-subj", `/CN=${h}`], hd);
  // A random serial per leaf: the same serial twice from one CA makes some clients refuse.
  openssl(["x509", "-req", "-in", `${h}.csr`, "-CA", "../ca.pem", "-CAkey", "../ca.key", "-set_serial", `0x${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`, "-days", "825", "-out", `${h}.pem`, "-extfile", `${h}.ext`], hd);
  rmSync(join(hd, `${h}.csr`), { force: true });
  rmSync(ext, { force: true });
  return { key: join(hd, `${h}.key`), cert: join(hd, `${h}.pem`), made: true };
}

export function listHosts(dir = TLS_DIR) {
  const hd = join(dir, "hosts");
  return existsSync(hd) ? readdirSync(hd).filter((f) => f.endsWith(".pem")).map((f) => f.slice(0, -4)).sort() : [];
}

// A throwaway RSA key in PEM (for a Google service-account credential, which n8n signs a JWT
// with before it calls the token endpoint).
export function ensureServiceAccountKey(dir = TLS_DIR) {
  const p = join(dir, "service-account.key");
  if (!existsSync(p)) {
    mkdirSync(dir, { recursive: true });
    openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", "service-account.key"], dir);
  }
  return p;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) console.log(listHosts().join("\n"));
  else {
    console.log(ensureCa());
    for (const h of args) console.log(h, ensureLeaf(h).made ? "made" : "exists");
  }
}
