import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '../../shared/json.js';
import type { SecretBox } from '../../modules/identity/domain/security.js';

const envelope = z.object({
  ciphertext: z.string(),
  iv: z.string(),
  tag: z.string(),
  key_version: z.string(),
});

export class AesSecretBox implements SecretBox {
  constructor(
    private readonly keys: Record<string, string>,
    private readonly current: string,
    private readonly pepper: string,
  ) {
    if (!Object.hasOwn(keys, current)) throw new Error('Missing active encryption key');
  }
  encrypt(value: JsonValue, context: string): JsonValue {
    const key = this.keys[this.current];
    if (!key) throw new Error('Missing encryption key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      key_version: this.current,
    };
  }
  decrypt(value: JsonValue, context: string): JsonValue {
    const parsed = envelope.parse(value);
    const key = Object.hasOwn(this.keys, parsed.key_version)
      ? this.keys[parsed.key_version]
      : undefined;
    if (!key) throw new Error('Unknown encryption key version');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'base64'),
      Buffer.from(parsed.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ) as JsonValue;
  }
  digest(value: string): string {
    return createHmac('sha256', Buffer.from(this.pepper, 'base64')).update(value).digest('hex');
  }
  equal(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  randomToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
