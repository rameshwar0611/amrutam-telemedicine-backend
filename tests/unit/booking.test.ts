import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { slotCreateSchema, availabilityQuerySchema } from '../../src/modules/bookings/schemas.js';
import { discoveryQuerySchema } from '../../src/modules/doctors/schemas.js';
import { slotDto, consultationDto } from '../../src/modules/bookings/services/booking.service.js';

const slot = {
  id: randomUUID(),
  doctor_id: randomUUID(),
  starts_at: new Date('2035-01-01T10:00:00Z'),
  ends_at: new Date('2035-01-01T10:30:00Z'),
  status: 'open' as const,
  created_at: new Date(),
  updated_at: new Date(),
};
describe('availability temporal contract', () => {
  it('canonicalizes equal offset instants to one idempotency payload', () => {
    const utc = slotCreateSchema.parse({
      startsAt: '2035-01-01T10:00:00Z',
      endsAt: '2035-01-01T10:30:00Z',
    });
    const offset = slotCreateSchema.parse({
      startsAt: '2035-01-01T15:30:00+05:30',
      endsAt: '2035-01-01T16:00:00+05:30',
    });
    expect(utc).toEqual(offset);
  });
  it('rejects nonexistent dates and local wall times instead of choosing an offset', () => {
    for (const startsAt of ['2035-02-30T10:00:00Z', '2035-03-11T02:30:00', '2035-01-01T10:00:60Z'])
      expect(slotCreateSchema.safeParse({ startsAt, endsAt: '2035-04-01T12:00:00Z' }).success).toBe(
        false,
      );
  });
  it('rejects reversed ranges after converting different offsets to UTC', () => {
    expect(
      availabilityQuerySchema.safeParse({
        from: '2035-01-01T10:00:00-05:00',
        to: '2035-01-01T11:00:00+05:30',
      }).success,
    ).toBe(false);
  });
  it('requires both discovery time bounds and rejects unknown filters', () => {
    expect(discoveryQuerySchema.safeParse({ availableFrom: '2035-01-01T00:00:00Z' }).success).toBe(
      false,
    );
    expect(discoveryQuerySchema.safeParse({ status: 'disabled' }).success).toBe(false);
    expect(discoveryQuerySchema.parse({ specialty: ' Ayurveda ' })).toMatchObject({
      specialty: 'ayurveda',
      limit: 20,
      offset: 0,
    });
  });
});
describe('booking DTOs', () => {
  it('does not advertise blocked, occupied or started slots as bookable', () => {
    expect(slotDto(slot, false, new Date('2034-01-01')).bookable).toBe(true);
    expect(slotDto(slot, true, new Date('2034-01-01')).bookable).toBe(false);
    expect(slotDto({ ...slot, status: 'blocked' }, false, new Date('2034-01-01')).bookable).toBe(
      false,
    );
    expect(slotDto(slot, false, slot.starts_at).bookable).toBe(false);
  });
  it('omits clinical notes and internal doctor user identity from booking responses', () => {
    const row = {
      id: randomUUID(),
      slot_id: slot.id,
      doctor_id: slot.doctor_id,
      patient_id: randomUUID(),
      status: 'scheduled' as const,
      version: 1,
      clinical_notes: { ciphertext: 'sensitive' },
      doctor_user_id: randomUUID(),
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      started_at: null,
      completed_at: null,
      cancelled_at: null,
      no_show_at: null,
      cancellation_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const dto = consultationDto(row);
    expect(dto).not.toHaveProperty('clinical_notes');
    expect(dto).not.toHaveProperty('doctor_user_id');
    expect(dto.startsAt).toBe('2035-01-01T10:00:00.000Z');
  });
});
