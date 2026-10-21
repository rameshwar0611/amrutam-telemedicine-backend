import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { HttpError } from '../../../shared/http-error.js';
import { toJson } from '../../../shared/json.js';
import {
  failure,
  type Actor,
  type Clock,
  type RequestContext,
  type ServiceResult,
} from '../../identity/domain/security.js';
import type { AuthorizationService } from '../../identity/services/authorization.service.js';
import type { IdempotencyService } from '../../identity/services/idempotency.service.js';
import type {
  BookingRepositories,
  ConsultationRecord,
  DoctorRecord,
  SlotRecord,
} from '../domain/ports.js';
import type { AvailabilityQuery, SlotInput } from '../schemas.js';

export const slotDto = (row: SlotRecord, occupied: boolean, now: Date) => ({
  id: row.id,
  doctorId: row.doctor_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  bookable: row.status === 'open' && !occupied && row.starts_at > now,
});
export const consultationDto = (row: ConsultationRecord) => ({
  id: row.id,
  slotId: row.slot_id,
  doctorId: row.doctor_id,
  patientId: row.patient_id,
  status: row.status,
  version: row.version,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  cancelledAt: row.cancelled_at?.toISOString() ?? null,
  cancellationReason: row.cancellation_reason,
});

export class BookingService {
  constructor(
    private readonly work: UnitOfWork<BookingRepositories>,
    private readonly authorization: Pick<AuthorizationService, 'require'>,
    private readonly idempotency: IdempotencyService,
    private readonly clock: Clock,
  ) {}
  private role(actor: Actor, roles: Actor['role'][]) {
    if (!roles.includes(actor.role)) throw new HttpError(403, 'FORBIDDEN');
  }
  private async doctor(
    repositories: BookingRepositories,
    id: string,
    owner?: Actor,
  ): Promise<DoctorRecord> {
    const doctor = await repositories.booking.doctor(id);
    if (!doctor) throw new HttpError(404, 'NOT_FOUND');
    if (owner && doctor.user_id !== owner.userId) throw new HttpError(403, 'FORBIDDEN');
    if (!doctor.active || !doctor.account_active) throw new HttpError(409, 'DOCTOR_UNAVAILABLE');
    return doctor;
  }
  async createSlot(
    actor: Actor,
    doctorId: string,
    input: SlotInput,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    this.role(actor, ['doctor']);
    try {
      return await this.work.run(async (r) => {
        await this.authorization.require(r, actor);
        await this.doctor(r, doctorId, actor);
        return this.idempotency.execute(
          r,
          {
            actorId: actor.userId,
            scope: `availability-create:${actor.userId}:${doctorId}`,
            key,
            payload: toJson(input),
            ttl: 86400,
          },
          async () => {
            if (new Date(input.startsAt) <= this.clock.now()) return failure('SLOT_IN_PAST', 409);
            const slot = await r.booking.createSlot(doctorId, input);
            await r.audit.append({
              actorId: actor.userId,
              action: 'availability.created',
              resourceType: 'availability_slot',
              resourceId: slot.id,
              outcome: 'success',
              requestId: context.requestId,
            });
            return { status: 201, body: toJson(slotDto(slot, false, this.clock.now())) };
          },
        );
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23P01')
        throw new HttpError(409, 'SLOT_OVERLAP');
      throw error;
    }
  }
  async block(
    actor: Actor,
    doctorId: string,
    slotId: string,
    key: string,
    context: RequestContext,
  ) {
    this.role(actor, ['doctor']);
    return this.work.run(async (r) => {
      await this.authorization.require(r, actor);
      await this.doctor(r, doctorId, actor);
      return this.idempotency.execute(
        r,
        {
          actorId: actor.userId,
          scope: `availability-block:${actor.userId}`,
          key,
          payload: { doctorId, slotId },
          ttl: 86400,
        },
        async () => {
          const slot = await r.booking.slot(slotId, true);
          if (!slot || slot.doctor_id !== doctorId) return failure('NOT_FOUND', 404);
          if (slot.starts_at <= this.clock.now()) return failure('SLOT_IN_PAST', 409);
          if (await r.booking.occupied(slotId)) return failure('SLOT_OCCUPIED', 409);
          if (slot.status !== 'blocked') {
            await r.booking.blockSlot(slot.id);
            await r.audit.append({
              actorId: actor.userId,
              action: 'availability.blocked',
              resourceType: 'availability_slot',
              resourceId: slot.id,
              outcome: 'success',
              requestId: context.requestId,
            });
          }
          return {
            status: 200,
            body: toJson(slotDto({ ...slot, status: 'blocked' }, false, this.clock.now())),
          };
        },
      );
    });
  }
  async list(actor: Actor, doctorId: string, query: AvailabilityQuery) {
    return this.work.run(async (r) => {
      await this.authorization.require(r, actor);
      const doctor = await this.doctor(r, doctorId);
      const own = actor.role === 'doctor' && doctor.user_id === actor.userId;
      const rows = await r.booking.listSlots(doctorId, query, own, this.clock.now());
      return {
        status: 200,
        body: toJson({
          items: rows
            .slice(0, query.limit)
            .map((row) => slotDto(row, row.occupied, this.clock.now())),
          limit: query.limit,
          offset: query.offset,
          hasMore: rows.length > query.limit,
        }),
      };
    });
  }
  async book(actor: Actor, slotId: string, key: string, context: RequestContext) {
    this.role(actor, ['patient']);
    return this.work.run(async (r) => {
      await this.authorization.require(r, actor);
      return this.idempotency.execute(
        r,
        {
          actorId: actor.userId,
          scope: `consultation-book:${actor.userId}`,
          key,
          payload: { slotId },
          ttl: 86400,
        },
        async () => {
          const initial = await r.booking.slot(slotId);
          if (!initial) return failure('NOT_FOUND', 404);
          await this.doctor(r, initial.doctor_id);
          const slot = await r.booking.slot(slotId, true);
          if (!slot || slot.status !== 'open' || slot.starts_at <= this.clock.now())
            return failure('SLOT_UNAVAILABLE', 409);
          if (await r.booking.occupied(slotId)) return failure('SLOT_OCCUPIED', 409);
          const consultation = await r.booking.book(slotId, slot.doctor_id, actor.userId);
          await r.audit.append({
            actorId: actor.userId,
            action: 'consultation.booked',
            resourceType: 'consultation',
            resourceId: consultation.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          await r.booking.enqueue('consultation.booked', consultation.id, {
            consultationId: consultation.id,
          });
          return { status: 201, body: toJson(consultationDto(consultation)) };
        },
      );
    });
  }
  async cancel(actor: Actor, id: string, reason: string, key: string, context: RequestContext) {
    return this.work.run(async (r) => {
      await this.authorization.require(r, actor);
      // Authorization precedes any replay, and no clinical data is selected into a DTO.
      const initial = await r.booking.consultation(id);
      if (!initial) throw new HttpError(404, 'NOT_FOUND');
      if (
        actor.role !== 'admin' &&
        !(actor.role === 'patient' && initial.patient_id === actor.userId) &&
        !(actor.role === 'doctor' && initial.doctor_user_id === actor.userId)
      )
        throw new HttpError(403, 'FORBIDDEN');
      if (
        (actor.role === 'patient' && reason !== 'patient_request') ||
        (actor.role === 'doctor' && reason !== 'doctor_unavailable')
      )
        throw new HttpError(403, 'FORBIDDEN');
      return this.idempotency.execute(
        r,
        {
          actorId: actor.userId,
          scope: `consultation-cancel:${actor.userId}`,
          key,
          payload: { consultationId: id, reason },
          ttl: 86400,
        },
        async () => {
          // Same shared-doctor -> slot -> consultation lock order as booking/blocking.
          await r.booking.doctor(initial.doctor_id);
          await r.booking.slot(initial.slot_id, true);
          const consultation = await r.booking.consultation(id, true);
          if (
            !consultation ||
            consultation.status !== 'scheduled' ||
            consultation.starts_at <= this.clock.now()
          )
            return failure('INVALID_CONSULTATION_STATE', 409);
          const cancelled = await r.booking.cancel(id, reason, this.clock.now());
          await r.audit.append({
            actorId: actor.userId,
            action: 'consultation.cancelled',
            resourceType: 'consultation',
            resourceId: id,
            outcome: 'success',
            requestId: context.requestId,
          });
          await r.booking.enqueue('consultation.cancelled', id, { consultationId: id });
          return { status: 200, body: toJson(consultationDto(cancelled)) };
        },
      );
    });
  }
}
