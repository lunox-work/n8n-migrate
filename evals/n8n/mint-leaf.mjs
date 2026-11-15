// A TLS leaf certificate made in process from the bench CA (PROPOSALS P26), for a host the
// fixtures name no route for (LangChain's tokenizer download, a service the template calls
// that the fixture writer did not foresee). Without it the mock refused the CONNECT, so n8n's
// node failed on a refused connection the Claude side never sees (the in-process host answers
// any unrouted request: read-default 404, write-default 200). With it the request inside the
// tunnel is logged and answered like any other unrouted request, and shows in the request log
// as a read gap. Zero dependencies (the mock runs in node:22-alpine, which has no openssl):
// the certificate is written in DER by hand (X.509 v3, RFC 5280) and signed with node:crypto.
//
//   mintLeaf(host, {caKeyPem, caCertPem}) -> {key, cert} (PEM), an EC P-256 key and a
//   certificate for DNS:<host>, or IP:<host> for an IPv4 host (P62) (serverAuth), valid from a day ago for 30 days, issued by the
//   CA's own subject so a client that trusts the CA (NODE_EXTRA_CA_CERTS) accepts it.

import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const len = (n) => (n < 0x80 ? Buffer.from([n]) : (() => {
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
})());
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...xs) => tlv(0x30, Buffer.concat(xs));
const set = (...xs) => tlv(0x31, Buffer.concat(xs));
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = (s) => {
  const p = s.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >>> 7; x > 0; x >>>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d) => {
  const y = d.getUTCFullYear();
  const s = [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${s}Z`)) : tlv(0x18, Buffer.from(`${y}${s}Z`));
};
const explicit = (n, body) => tlv(0xa0 + n, body);
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const NULL = Buffer.from([0x05, 0x00]);

// Reads one DER element at `at`: {tag, start (of the whole element), body, end}.
function element(buf, at) {
  const tag = buf[at];
  let n = buf[at + 1];
  let p = at + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + buf[p + i];
    p += k;
  }
  return { tag, start: at, body: p, end: p + n };
}

// The CA certificate's subject Name, as raw DER (the leaf's issuer must equal it byte for byte).
export function subjectOf(caCertPem) {
  const der = Buffer.from(String(caCertPem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const cert = element(der, 0);
  const tbs = element(der, cert.body);
  let at = tbs.body;
  const parts = [];
  while (at < tbs.end && parts.length < 7) {
    const e = element(der, at);
    parts.push(e);
    at = e.end;
  }
  const off = parts[0].tag === 0xa0 ? 1 : 0; // [0] version present in v3
  const subject = parts[off + 4];
  return der.subarray(subject.start, subject.end);
}

export function mintLeaf(host, { caKeyPem, caCertPem, now = new Date() }) {
  const h = String(host).toLowerCase();
  // PROPOSALS P62: an IPv4 host gets an iPAddress subjectAltName (4 octets), a DNS host a dNSName.
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && h.split(".").every((x) => Number(x) <= 255) ? Buffer.from(h.split(".").map(Number)) : null;
  if (!ip && (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) || /^\d+(\.\d+){3}$/.test(h))) throw new Error(`not a host name: ${host}`);
  const caKey = createPrivateKey(caKeyPem);
  const rsa = caKey.asymmetricKeyType === "rsa";
  const sigAlg = rsa ? seq(oid("1.2.840.113549.1.1.11"), NULL) : seq(oid("1.2.840.10045.4.3.2"));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x3f) | 0x40; // positive, no leading zero byte (DER)
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + 30 * 86_400_000);
  const cn = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(h)))));
  const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), octets(value));
  const extensions = explicit(3, seq(
    ext("2.5.29.17", seq(ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(h)))), // subjectAltName iPAddress or dNSName
    ext("2.5.29.19", seq(), true), // basicConstraints CA:FALSE
    ext("2.5.29.15", tlv(0x03, Buffer.from([0x07, 0x80])), true), // keyUsage digitalSignature
    ext("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage serverAuth
  ));
  const tbs = seq(explicit(0, int(Buffer.from([2]))), int(serial), sigAlg, subjectOf(caCertPem), seq(time(from), time(to)), cn, publicKey.export({ type: "spki", format: "der" }), extensions);
  const signature = sign("sha256", tbs, caKey);
  const der = seq(tbs, sigAlg, bits(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert: pem };
}
