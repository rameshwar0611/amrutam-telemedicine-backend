import type { SecurityRepositories } from '../../identity/domain/ports.js';
import type { ConsultationRecord } from '../../bookings/domain/ports.js';
import type { JsonValue } from '../../../shared/json.js';
export interface ClinicalRecord extends ConsultationRecord {
  clinical_notes: JsonValue | null;
  started_at: Date | null;
  completed_at: Date | null;
}
export interface ClinicalStore {
  get(id: string): Promise<ClinicalRecord | undefined>;
  lock(id: string): Promise<ClinicalRecord | undefined>;
  transition(id: string, status: 'in_progress' | 'completed' | 'no_show', now: Date): Promise<void>;
  notes(id: string, value: JsonValue): Promise<void>;
}
export interface EventStore {
  enqueue(kind: string, id: string, payload: JsonValue): Promise<void>;
}
export interface ClinicalRepositories extends SecurityRepositories {
  clinical: ClinicalStore;
  events: EventStore;
}
