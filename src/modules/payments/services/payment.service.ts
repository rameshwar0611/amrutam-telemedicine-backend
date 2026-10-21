import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { HttpError } from '../../../shared/http-error.js';
import { toJson } from '../../../shared/json.js';
import { failure, type Actor, type RequestContext } from '../../identity/domain/security.js';
import type { AuthorizationService } from '../../identity/services/authorization.service.js';
import type { IdempotencyService } from '../../identity/services/idempotency.service.js';
import type { ClinicalRepositories } from '../../consultations/domain/ports.js';
import type { PaymentStore, PaymentRecord } from '../domain/ports.js';
import { canPaymentTransition } from '../domain/ports.js';
export interface PaymentRepositories extends ClinicalRepositories {
  payments: PaymentStore;
}
export const paymentDto = (row: PaymentRecord) => ({
  id: row.id,
  consultationId: row.consultation_id,
  amountMinor: row.amount_minor,
  currency: row.currency,
  status: row.status,
  mode: 'internal_fake' as const,
  updatedAt: row.updated_at.toISOString(),
});
export class PaymentService {
  constructor(
    private readonly work: UnitOfWork<PaymentRepositories>,
    private readonly auth: AuthorizationService,
    private readonly idem: IdempotencyService,
  ) {}
  private admin(actor: Actor) {
    if (actor.role !== 'admin') throw new HttpError(403, 'FORBIDDEN');
  }
  async create(
    actor: Actor,
    id: string,
    input: { amountMinor: number; currency: string },
    key: string,
    context: RequestContext,
  ) {
    this.admin(actor);
    return this.work.run(async (r) => {
      await this.auth.require(r, actor, { recent: true });
      return this.idem.execute(
        r,
        {
          actorId: actor.userId,
          scope: `payment-create:${actor.userId}`,
          key,
          payload: { id, ...input },
          ttl: 86400,
        },
        async () => {
          const row = await r.clinical.lock(id);
          if (!row) return failure('NOT_FOUND', 404);
          if (['cancelled', 'no_show'].includes(row.status))
            return failure('INVALID_PAYMENT_STATE', 409);
          const payment = await r.payments.create(id, input.amountMinor, input.currency);
          await r.audit.append({
            actorId: actor.userId,
            action: 'payment.created',
            resourceType: 'payment',
            resourceId: payment.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          await r.events.enqueue('payment.created', payment.id, { paymentId: payment.id });
          return { status: 201, body: toJson(paymentDto(payment)) };
        },
      );
    });
  }
  async list(actor: Actor, id: string, limit: number, offset: number, context: RequestContext) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const row = await r.clinical.get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND');
      if (actor.role !== 'admin' && !(actor.role === 'patient' && actor.userId === row.patient_id))
        throw new HttpError(403, 'FORBIDDEN');
      const rows = await r.payments.list(id, limit, offset);
      await r.audit.append({
        actorId: actor.userId,
        action: 'payment.accessed',
        resourceType: 'consultation',
        resourceId: id,
        outcome: 'success',
        requestId: context.requestId,
      });
      return {
        status: 200,
        body: toJson({
          items: rows.slice(0, limit).map(paymentDto),
          limit,
          offset,
          hasMore: rows.length > limit,
        }),
      };
    });
  }
  async transition(
    actor: Actor,
    id: string,
    status: 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refund_pending',
    key: string,
    context: RequestContext,
  ) {
    this.admin(actor);
    return this.work.run(async (r) => {
      await this.auth.require(r, actor, { recent: true });
      const initial = await r.payments.get(id);
      if (!initial) throw new HttpError(404, 'NOT_FOUND');
      return this.idem.execute(
        r,
        {
          actorId: actor.userId,
          scope: `payment-transition:${actor.userId}`,
          key,
          payload: { id, status },
          ttl: 86400,
        },
        async () => {
          const consultation = (await r.clinical.lock(initial.consultation_id))!;
          const row = (await r.payments.get(id, true))!;
          if (
            !canPaymentTransition(row.status, status) ||
            (['authorized', 'paid'].includes(status) &&
              ['cancelled', 'no_show'].includes(consultation.status))
          )
            return failure('INVALID_PAYMENT_STATE', 409);
          await r.payments.update(id, status);
          await r.audit.append({
            actorId: actor.userId,
            action: 'payment.state_changed',
            resourceType: 'payment',
            resourceId: id,
            outcome: 'success',
            requestId: context.requestId,
            metadata: { from: row.status, to: status },
          });
          await r.events.enqueue(
            status === 'refund_pending' ? 'payment.refund_requested' : `payment.${status}`,
            id,
            { paymentId: id },
          );
          return { status: 200, body: toJson(paymentDto((await r.payments.get(id))!)) };
        },
      );
    });
  }
}
