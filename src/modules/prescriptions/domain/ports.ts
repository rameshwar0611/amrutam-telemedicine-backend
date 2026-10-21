import type { JsonValue } from '../../../shared/json.js';
export interface PrescriptionRecord {
  id: string;
  consultation_id: string;
  doctor_id: string;
  version: number;
  revision: number;
  status: 'draft' | 'finalized' | 'revoked';
  clinical_payload: JsonValue;
  correction_of: string | null;
  finalized_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
}
export interface PrescriptionStore {
  get(id: string): Promise<PrescriptionRecord | undefined>;
  list(id: string, limit: number, offset: number, patient?: boolean): Promise<PrescriptionRecord[]>;
  current(id: string): Promise<PrescriptionRecord | undefined>;
  nextVersion(id: string): Promise<number>;
  create(
    id: string,
    consultationId: string,
    doctorId: string,
    version: number,
    payload: JsonValue,
    correctionOf: string | null,
  ): Promise<PrescriptionRecord>;
  edit(id: string, payload: JsonValue): Promise<void>;
  finalize(id: string, now: Date): Promise<void>;
  revoke(id: string, reason: string, now: Date): Promise<void>;
}
