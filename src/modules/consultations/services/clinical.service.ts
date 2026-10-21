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
import type { ClinicalRecord, ClinicalRepositories } from '../domain/ports.js';
import { clinicalNotesSchema, type ClinicalNotes } from '../schemas.js';
import { consultationDto } from '../../bookings/services/booking.service.js';
export function assignedDoctor(actor: Actor, row: ClinicalRecord) {
  if (actor.role !== 'doctor' || actor.userId !== row.doctor_user_id)
    throw new HttpError(403, 'FORBIDDEN');
}
export function clinicalReader(actor: Actor, row: ClinicalRecord) {
  if (!(
    (actor.role === 'doctor' && actor.userId === row.doctor_user_id) ||
    (actor.role === 'patient' && actor.userId === row.patient_id)
  ))
    throw new HttpError(403, 'FORBIDDEN');
}
export class ClinicalService {
  constructor(
    private readonly work: UnitOfWork<ClinicalRepositories>,
    private readonly auth: AuthorizationService,
    private readonly idem: IdempotencyService,
    private readonly secrets: SecretBox,
    private readonly clock: Clock,
  ) {}
  async read(actor: Actor, id: string, context: RequestContext, notes = false) {
    return this.work.run(async (r) => {
      await this.auth.require(r, actor);
      const row = await r.clinical.get(id);
      if (!row) throw new HttpError(404, 'NOT_FOUND');
      clinicalReader(actor, row);
      if (notes && actor.role === 'patient' && row.status !== 'completed')
        throw new HttpError(403, 'FORBIDDEN');
      const value = notes
        ? {
            consultationId: id,
            version: row.version,
            notes: row.clinical_notes
              ? clinicalNotesSchema.parse(
                  this.secrets.decrypt(row.clinical_notes, `consultation:${id}:notes`),
                )
              : null,
          }
        : consultationDto(row);
      await r.audit.append({
        actorId: actor.userId,
        action: notes ? 'clinical.notes_accessed' : 'consultation.accessed',
        resourceType: 'consultation',
        resourceId: id,
        outcome: 'success',
        requestId: context.requestId,
      });
      return { status: 200, body: toJson(value) };
    });
  }
  async transition(
    actor: Actor,
    id: string,
    status: 'in_progress' | 'completed' | 'no_show',
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
          scope: `clinical-transition:${actor.userId}`,
          key,
          payload: { id, status },
          ttl: 86400,
        },
        async () => {
          const row = (await r.clinical.lock(id))!;
          const now = this.clock.now();
          const valid =
            status === 'in_progress'
              ? row.status === 'scheduled' && row.starts_at <= now && now < row.ends_at
              : status === 'completed'
                ? row.status === 'in_progress' && !!row.started_at && row.started_at <= now
                : row.status === 'scheduled' && row.ends_at <= now;
          if (!valid) return failure('INVALID_CONSULTATION_STATE', 409);
          await r.clinical.transition(id, status, now);
          await r.audit.append({
            actorId: actor.userId,
            action: `consultation.${status}`,
            resourceType: 'consultation',
            resourceId: id,
            outcome: 'success',
            requestId: context.requestId,
          });
          await r.events.enqueue(`consultation.${status}`, id, { consultationId: id });
          return { status: 200, body: toJson(consultationDto((await r.clinical.get(id))!)) };
        },
      );
    });
  }
  async writeNotes(
    actor: Actor,
    id: string,
    input: { expectedVersion: number; notes: ClinicalNotes },
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
          scope: `clinical-notes:${actor.userId}`,
          key,
          payload: toJson({ id, ...input }),
          ttl: 86400,
        },
        async () => {
          const row = (await r.clinical.lock(id))!;
          if (row.status !== 'in_progress' || row.version !== input.expectedVersion)
            return failure('INVALID_CONSULTATION_STATE', 409);
          await r.clinical.notes(
            id,
            this.secrets.encrypt(toJson(input.notes), `consultation:${id}:notes`),
          );
          await r.audit.append({
            actorId: actor.userId,
            action: 'clinical.notes_updated',
            resourceType: 'consultation',
            resourceId: id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 200, body: { consultationId: id, version: row.version + 1 } };
        },
      );
    });
  }
}
