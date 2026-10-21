import type { SecurityRepositories } from '../../identity/domain/ports.js';
import type { JsonValue } from '../../../shared/json.js';
import type { AvailabilityQuery, SlotInput } from '../schemas.js';
export interface DoctorRecord {
  id: string;
  user_id: string;
  active: boolean;
  account_active: boolean;
}
export interface SlotRecord {
  id: string;
  doctor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: 'open' | 'blocked';
  created_at: Date;
  updated_at: Date;
}
export interface ConsultationRecord {
  id: string;
  slot_id: string;
  doctor_id: string;
  patient_id: string;
  doctor_user_id: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  version: number;
  starts_at: Date;
  ends_at: Date;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
}
export interface BookingStore {
  doctor(id: string): Promise<DoctorRecord | undefined>;
  slot(id: string, lock?: boolean): Promise<SlotRecord | undefined>;
  createSlot(doctorId: string, input: SlotInput): Promise<SlotRecord>;
  blockSlot(id: string): Promise<void>;
  occupied(slotId: string): Promise<boolean>;
  listSlots(
    doctorId: string,
    query: AvailabilityQuery,
    own: boolean,
    now: Date,
  ): Promise<(SlotRecord & { occupied: boolean })[]>;
  consultation(id: string, lock?: boolean): Promise<ConsultationRecord | undefined>;
  book(slotId: string, doctorId: string, patientId: string): Promise<ConsultationRecord>;
  cancel(id: string, reason: string, now: Date): Promise<ConsultationRecord>;
  enqueue(
    kind: 'consultation.booked' | 'consultation.cancelled',
    id: string,
    payload: JsonValue,
  ): Promise<void>;
}
export interface BookingRepositories extends SecurityRepositories {
  booking: BookingStore;
}
