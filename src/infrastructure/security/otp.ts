import * as OTPAuth from 'otpauth';
import type { Clock, OtpProvider } from '../../modules/identity/domain/security.js';

export class TotpProvider implements OtpProvider {
  constructor(private readonly clock: Clock) {}
  create(label: string): { secret: string; uri: string } {
    const totp = new OTPAuth.TOTP({
      issuer: 'Amrutam',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: new OTPAuth.Secret({ size: 20 }),
    });
    return { secret: totp.secret.base32, uri: totp.toString() };
  }
  step(secret: string, code: string): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const timestamp = this.clock.now().getTime();
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    return delta === null ? null : Math.floor(timestamp / 30000) + delta;
  }
}
