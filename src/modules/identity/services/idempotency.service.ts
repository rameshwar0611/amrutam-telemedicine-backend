import { canonicalJson, type JsonValue } from '../../../shared/json.js';
import { HttpError } from '../../../shared/http-error.js';
import type { SecurityRepositories } from '../domain/ports.js';
import type { Clock, SecretBox, ServiceResult } from '../domain/security.js';

export class IdempotencyService {
  constructor(
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}
  fingerprint(input: JsonValue): string {
    return this.secrets.digest(`request:${canonicalJson(input)}`);
  }
  async execute(
    repositories: Pick<SecurityRepositories, 'idempotency'>,
    input: {
      actorId: string | null;
      scope: string;
      key: string;
      payload: JsonValue;
      ttl: number;
    },
    operation: () => Promise<ServiceResult>,
    onConflict?: () => Promise<ServiceResult>,
  ): Promise<ServiceResult> {
    const record = await repositories.idempotency.claim({
      ...input,
      fingerprint: this.fingerprint(input.payload),
      expiresAt: new Date(this.clock.now().getTime() + input.ttl * 1000),
    });
    if (record.request_fingerprint !== this.fingerprint(input.payload)) {
      if (onConflict) return onConflict();
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
    }
    if (record.expires_at <= this.clock.now()) throw new HttpError(409, 'IDEMPOTENCY_EXPIRED');
    const context = `idempotency:${input.scope}:${input.key}`;
    if (record.status === 'completed') {
      if (
        record.response_status === null ||
        record.response_body === null ||
        !record.response_encrypted
      )
        throw new Error('Invalid idempotency state');
      return {
        status: record.response_status,
        body: this.secrets.decrypt(record.response_body, context),
      };
    }
    const result = await operation();
    await repositories.idempotency.complete(
      record.id,
      result.status,
      this.secrets.encrypt(result.body, context),
    );
    return result;
  }
}
