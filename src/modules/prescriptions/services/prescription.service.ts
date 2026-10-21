import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { HttpError } from '../../../shared/http-error.js';
import { toJson } from '../../../shared/json.js';
import {
  failure,
  type Actor,
  type Clock,
  type RequestContext,
  type SecretBox,
} from '../../identity/domain/security.js';
import type { AuthorizationService } from '../../identity/services/authorization.service.js';
import type { IdempotencyService } from '../../identity/services/idempotency.service.js';
import type { ClinicalRepositories } from '../../consultations/domain/ports.js';
import { assignedDoctor, clinicalReader } from '../../consultations/services/clinical.service.js';
import type { PrescriptionStore, PrescriptionRecord } from '../domain/ports.js';
import { prescriptionContentSchema, type PrescriptionContent } from '../schemas.js';
export interface PrescriptionRepositories extends ClinicalRepositories {
  prescriptions: PrescriptionStore;
}
export class PrescriptionService {
  constructor(
    private readonly work: UnitOfWork<PrescriptionRepositories>,
    private readonly auth: AuthorizationService,
    private readonly idem: IdempotencyService,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}
  private dto(row: PrescriptionRecord) {
    return {
      id: row.id,
      consultationId: row.consultation_id,
      doctorId: row.doctor_id,
      version: row.version,
      revision: row.revision,
      status: row.status,
      correctionOf: row.correction_of,
      finalizedAt: row.finalized_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      revocationReason: row.revocation_reason,
      content: prescriptionContentSchema.parse(
        this.secrets.decrypt(row.clinical_payload, `prescription:${row.id}:content`),
      ),
    };
  }
  async create(
    actor: Actor,
    id: string,
    input: { content: PrescriptionContent; correctionOf?: string | undefined },
    key: string,
    context: RequestContext,
  ) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const initial = await r.clinical.get(id);
      if (!initial) throw new HttpError(404, 'NOT_FOUND');
      assignedDoctor(actor, initial);
      return this.idem.execute(
        r,
        {
          actorId: actor.userId,
          scope: `prescription-create:${actor.userId}`,
          key,
          payload: toJson({ id, ...input }),
          ttl: 86400,
        },
        async () => {
          const row = (await r.clinical.lock(id))!;
          if (!['in_progress', 'completed'].includes(row.status))
            return failure('INVALID_CONSULTATION_STATE', 409);
          const current = await r.prescriptions.current(id);
          if (current && current.id !== input.correctionOf)
            return failure('CORRECTION_REQUIRED', 409);
          if (input.correctionOf) {
            const previous = await r.prescriptions.get(input.correctionOf);
            if (!previous || previous.consultation_id !== id || previous.status === 'draft')
              return failure('INVALID_CORRECTION', 409);
          }
          const prescriptionId = randomUUID();
          const version = await r.prescriptions.nextVersion(id);
          const created = await r.prescriptions.create(
            prescriptionId,
            id,
            row.doctor_id,
            version,
            this.secrets.encrypt(toJson(input.content), `prescription:${prescriptionId}:content`),
            input.correctionOf ?? null,
          );
          await r.audit.append({
            actorId: actor.userId,
            action: 'prescription.created',
            resourceType: 'prescription',
            resourceId: prescriptionId,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 201, body: toJson(this.dto(created)) };
        },
      );
    });
  }
  async read(actor: Actor, id: string, context: RequestContext) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const row = await r.prescriptions.get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND');
      const consultation = (await r.clinical.get(row.consultation_id))!;
      clinicalReader(actor, consultation);
      if (actor.role === 'patient' && row.status !== 'finalized')
        throw new HttpError(404, 'NOT_FOUND');
      await r.audit.append({
        actorId: actor.userId,
        action: 'prescription.accessed',
        resourceType: 'prescription',
        resourceId: id,
        outcome: 'success',
        requestId: context.requestId,
      });
      return { status: 200, body: toJson(this.dto(row)) };
    });
  }
  async list(actor: Actor, id: string, limit: number, offset: number, context: RequestContext) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const row = await r.clinical.get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND');
      clinicalReader(actor, row);
      const rows = await r.prescriptions.list(id, limit, offset, actor.role === 'patient');
      await r.audit.append({
        actorId: actor.userId,
        action: 'prescription.history_accessed',
        resourceType: 'consultation',
        resourceId: id,
        outcome: 'success',
        requestId: context.requestId,
      });
      return {
        status: 200,
        body: toJson({
          items: rows.slice(0, limit).map((row) => this.dto(row)),
          limit,
          offset,
          hasMore: rows.length > limit,
        }),
      };
    });
  }
  async mutate(
    actor: Actor,
    id: string,
    action: 'edit' | 'finalize' | 'revoke',
    input: { content?: PrescriptionContent; expectedRevision?: number; reason?: string },
    key: string,
    context: RequestContext,
  ) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const initial = await r.prescriptions.get(id);
      if (!initial) throw new HttpError(404, 'NOT_FOUND');
      const consultation = (await r.clinical.get(initial.consultation_id))!;
      assignedDoctor(actor, consultation);
      return this.idem.execute(
        r,
        {
          actorId: actor.userId,
          scope: `prescription-${action}:${actor.userId}`,
          key,
          payload: toJson({ id, ...input }),
          ttl: 86400,
        },
        async () => {
          await r.clinical.lock(initial.consultation_id);
          const row = (await r.prescriptions.get(id))!;
          if (action === 'edit') {
            if (row.status !== 'draft' || row.revision !== input.expectedRevision || !input.content)
              return failure('INVALID_PRESCRIPTION_STATE', 409);
            await r.prescriptions.edit(
              id,
              this.secrets.encrypt(toJson(input.content), `prescription:${id}:content`),
            );
          } else if (action === 'finalize') {
            if (row.status !== 'draft') return failure('INVALID_PRESCRIPTION_STATE', 409);
            const current = await r.prescriptions.current(row.consultation_id);
            if (current) {
              if (row.correction_of !== current.id) return failure('CORRECTION_REQUIRED', 409);
              await r.prescriptions.revoke(current.id, 'clinical_correction', this.clock.now());
              await r.audit.append({
                actorId: actor.userId,
                action: 'prescription.revoked',
                resourceType: 'prescription',
                resourceId: current.id,
                outcome: 'success',
                requestId: context.requestId,
              });
              await r.events.enqueue('prescription.revoked', current.id, {
                prescriptionId: current.id,
              });
            }
            await r.prescriptions.finalize(id, this.clock.now());
          } else {
            if (row.status !== 'finalized' || !input.reason)
              return failure('INVALID_PRESCRIPTION_STATE', 409);
            await r.prescriptions.revoke(id, input.reason, this.clock.now());
          }
          const event =
            action === 'edit'
              ? 'prescription.edited'
              : action === 'finalize'
                ? 'prescription.finalized'
                : 'prescription.revoked';
          await r.audit.append({
            actorId: actor.userId,
            action: event,
            resourceType: 'prescription',
            resourceId: id,
            outcome: 'success',
            requestId: context.requestId,
          });
          if (action !== 'edit') await r.events.enqueue(event, id, { prescriptionId: id });
          return { status: 200, body: toJson(this.dto((await r.prescriptions.get(id))!)) };
        },
      );
    });
  }
}
