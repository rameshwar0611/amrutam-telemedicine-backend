import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Passwords } from '../../modules/identity/domain/security.js';

export class ArgonPasswords implements Passwords {
  private dummy: Promise<string> | undefined;
  hash(value: string): Promise<string> {
    return argon2.hash(value, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  }
  async verify(value: string, hash: string | null): Promise<boolean> {
    this.dummy ??= this.hash(randomBytes(32).toString('base64url'));
    const dummy = await this.dummy;
    const candidate = hash ?? dummy;
    try {
      const valid = await argon2.verify(candidate, value);
      return hash !== null && valid;
    } catch {
      await argon2.verify(await this.dummy, value);
      return false;
    }
  }
}
