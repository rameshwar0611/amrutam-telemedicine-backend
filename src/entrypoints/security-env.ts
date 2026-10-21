import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const values = {
  AUTH_JWT_KEY_ID: 'local-1',
  AUTH_JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
  AUTH_JWT_PUBLIC_KEYS: JSON.stringify({ 'local-1': Buffer.from(publicKey).toString('base64') }),
  AUTH_ENCRYPTION_KEY_ID: 'local-1',
  AUTH_ENCRYPTION_KEYS: JSON.stringify({ 'local-1': randomBytes(32).toString('base64') }),
  AUTH_TOKEN_PEPPER_BASE64: randomBytes(32).toString('base64'),
};
await mkdir(resolve('work'), { recursive: true });
await writeFile(
  resolve('work/security.env'),
  Object.entries(values)
    .map(([name, value]) => `${name}='${value}'`)
    .join('\n') + '\n',
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  'Generated fresh local security configuration in ignored work/security.env. Do not share or commit it.\n',
);
