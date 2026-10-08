#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

// A leaf signed by a real local CA works in both Node and workerd. A self-signed
// leaf with CA:FALSE may work in Node but fail in workerd even when explicitly trusted.
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--output' || args[2] !== '--zone' || !/^[a-z0-9.-]+\.localhost$/.test(args[3])) throw new Error();
  const directory = resolve(args[1]);
  if (existsSync(directory)) {
    console.error(JSON.stringify({ code: 'TLS_DIRECTORY_ALREADY_EXISTS' }));
    process.exit(1);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = (args) => execFileSync('openssl', args, { cwd: directory, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '365', '-subj', '/CN=Neon Local Development CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wildcard.key', '-out', 'wildcard.csr', '-subj', `/CN=*.${args[3]}`]);
  writeFileSync(join(directory, 'server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:*.${args[3]},DNS:${args[3]}\n`, { mode: 0o600 });
  run(['x509', '-req', '-in', 'wildcard.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'wildcard.crt', '-days', '30', '-extfile', 'server.ext']);
  run(['verify', '-CAfile', 'ca.crt', 'wildcard.crt']);
  for (const name of readdirSync(directory)) chmodSync(join(directory, name), 0o600);
  for (const name of ['wildcard.csr', 'server.ext', 'ca.srl']) unlinkSync(join(directory, name));
  console.log(JSON.stringify({ status: 'created', directory, trustFile: 'ca.crt', serverCertificate: 'wildcard.crt', serverKey: 'wildcard.key', installedSystemTrust: false }));
} catch {
  console.error(JSON.stringify({ code: 'LOCAL_TLS_SETUP_FAILED', hint: 'Use a new --output directory and a --zone ending in .localhost; openssl is required.' }));
  process.exitCode = 1;
}
