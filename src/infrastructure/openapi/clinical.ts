import { z } from 'zod';
import {
  notesWriteSchema,
  transitionSchema,
  notesDtoSchema,
  noteSavedSchema,
} from '../../modules/consultations/schemas.js';
import {
  prescriptionCreateSchema,
  prescriptionEditSchema,
  prescriptionRevokeSchema,
  prescriptionDtoSchema,
} from '../../modules/prescriptions/schemas.js';
import {
  paymentCreateSchema,
  paymentTransitionSchema,
  paymentDtoSchema,
} from '../../modules/payments/schemas.js';
import {
  auditQuerySchema,
  analyticsQuerySchema,
  jobsQuerySchema,
} from '../../modules/analytics/schemas.js';
import { paginationSchema } from '../../modules/bookings/schemas.js';
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), limit: z.number(), offset: z.number(), hasMore: z.boolean() });
const audit = z.object({
  id: z.uuid(),
  occurred_at: z.iso.datetime(),
  actor_id: z.uuid().nullable(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.uuid().nullable(),
  outcome: z.enum(['success', 'failure', 'denied']),
  request_id: z.uuid().nullable(),
});
const job = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  attempts: z.number(),
  max_attempts: z.number(),
  available_at: z.iso.datetime(),
  lease_until: z.iso.datetime().nullable(),
  completed_at: z.iso.datetime().nullable(),
  last_error_code: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export const analyticsDtoSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  asOf: z.iso.datetime(),
  totals: z.object({
    bookings: z.number(),
    completed: z.number(),
    cancellations: z.number(),
    noShows: z.number(),
  }),
  doctors: z.array(
    z.object({
      doctorId: z.uuid(),
      name: z.string(),
      offeredSeconds: z.number(),
      bookedSeconds: z.number(),
      utilization: z.number(),
    }),
  ),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});
function op(
  id: string,
  description: string,
  options: {
    response: string;
    request?: string;
    path?: string;
    query?: z.ZodType;
    status?: number;
    write?: boolean;
  },
) {
  return {
    operationId: id,
    tags: ['Clinical, payments and compliance'],
    description,
    security: [{ AccessToken: [] }],
    parameters: [
      ...(options.path
        ? [
            {
              name: options.path,
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ]
        : []),
      ...(options.query
        ? Object.entries(z.toJSONSchema(options.query, { io: 'input' }).properties ?? {}).map(
            ([name, schema]) => ({
              name,
              in: 'query',
              required: ['from', 'to'].includes(name),
              schema,
            }),
          )
        : []),
      ...(options.write
        ? [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
              description:
                'Actor and operation scoped; encrypted original status/body replays for 24h after fresh authorization. Changed body 409. Never retries a clinical mutation as another actor.',
            },
          ]
        : []),
    ],
    ...(options.request
      ? { requestBody: { required: true, content: json(ref(options.request)) } }
      : {}),
    responses: {
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((s) => [
          String(s),
          {
            description:
              s === 409
                ? 'Invalid state/version, idempotency conflict or expired key'
                : s === 403
                  ? 'Role, ownership or recent MFA denied'
                  : s === 503
                    ? 'Security enforcement unavailable'
                    : 'Safe request error; no sensitive values',
            content: json(ref('Error')),
          },
        ]),
      ),
      [String(options.status ?? 200)]: {
        description: 'Success; no-store, audited access and safe DTO',
        content: json(ref(options.response)),
      },
    },
  };
}
export const clinicalPaths = {
  '/v1/consultations/{consultationId}': {
    get: op(
      'getConsultation',
      'Owning patient or assigned doctor; audited metadata access, no clinical notes.',
      { path: 'consultationId', response: 'ConsultationBooking' },
    ),
  },
  '/v1/consultations/{consultationId}/notes': {
    get: op(
      'getClinicalNotes',
      'Assigned doctor or owning patient after completion only. Decrypted authorized clinical DTO; never cached. Read and audit commit together.',
      { path: 'consultationId', response: 'ClinicalNotes' },
    ),
    put: op(
      'writeClinicalNotes',
      'Assigned doctor only during in_progress; expectedVersion prevents lost updates. AES-GCM bound to consultation; completion freezes contents.',
      { path: 'consultationId', request: 'WriteNotes', response: 'NotesSaved', write: true },
    ),
  },
  '/v1/consultations/{consultationId}/transitions': {
    post: op(
      'transitionConsultation',
      'Assigned doctor only. scheduled→in_progress within slot, in_progress→completed, scheduled→no_show after slot end. Cancellation uses the existing cancel endpoint. Notes are immutable after completion. State/audit/outbox/idempotency commit atomically.',
      {
        path: 'consultationId',
        request: 'ClinicalTransition',
        response: 'ConsultationBooking',
        write: true,
      },
    ),
  },
  '/v1/consultations/{consultationId}/prescriptions': {
    post: op(
      'createPrescriptionDraft',
      'Assigned doctor only for in_progress/completed consultation. Encrypted draft and monotonically allocated version. correctionOf must link the current finalized prescription when one exists.',
      {
        path: 'consultationId',
        request: 'CreatePrescription',
        response: 'Prescription',
        status: 201,
        write: true,
      },
    ),
    get: op(
      'listPrescriptions',
      'Assigned doctor sees all versions; patient sees only their own currently finalized versions. Admins cannot access clinical contents. Audited, bounded pagination.',
      { path: 'consultationId', query: paginationSchema, response: 'PrescriptionPage' },
    ),
  },
  '/v1/prescriptions/{prescriptionId}': {
    get: op(
      'getPrescription',
      'Assigned doctor or owning patient. Patient cannot retrieve drafts/revoked prescriptions; all accesses audited.',
      { path: 'prescriptionId', response: 'Prescription' },
    ),
    patch: op(
      'editPrescriptionDraft',
      'Assigned doctor only; draft status and expectedRevision required. Finalized payloads/identity are immutable.',
      {
        path: 'prescriptionId',
        request: 'EditPrescription',
        response: 'Prescription',
        write: true,
      },
    ),
  },
  '/v1/prescriptions/{prescriptionId}/finalize': {
    post: op(
      'finalizePrescription',
      'Assigned doctor only. Finalizing a linked correction revokes its predecessor atomically, preserving old ciphertext/history. Only one current finalized prescription per consultation.',
      { path: 'prescriptionId', request: 'EmptyRequest', response: 'Prescription', write: true },
    ),
  },
  '/v1/prescriptions/{prescriptionId}/revoke': {
    post: op(
      'revokePrescription',
      'Assigned doctor only. Coded reason; immutable content retained. Patient no longer sees revoked versions.',
      {
        path: 'prescriptionId',
        request: 'RevokePrescription',
        response: 'Prescription',
        write: true,
      },
    ),
  },
  '/v1/consultations/{consultationId}/payments': {
    post: op(
      'createInternalPayment',
      'Admin with MFA within five minutes. Internal accounting only, no gateway and no booking dependency. Amount/currency immutable. Cannot create against cancelled/no_show consultations.',
      {
        path: 'consultationId',
        request: 'CreatePayment',
        response: 'Payment',
        status: 201,
        write: true,
      },
    ),
    get: op(
      'listInternalPayments',
      'Owning patient or admin; safe accounting DTO, no provider/credential payload. Audited access.',
      { path: 'consultationId', query: paginationSchema, response: 'PaymentPage' },
    ),
  },
  '/v1/payments/{paymentId}/transitions': {
    post: op(
      'transitionInternalPayment',
      'Recent-MFA admin only. pending→authorized/failed/cancelled; authorized→paid/failed/cancelled; paid→refund_pending. Only the worker records refunded via deterministic fake adapter. Capture/authorize denied after cancelled/no_show. Cancellation/no_show asynchronously compensates existing records.',
      { path: 'paymentId', request: 'PaymentTransition', response: 'Payment', write: true },
    ),
  },
  '/v1/admin/audit-logs': {
    get: op(
      'queryAuditLogs',
      'Admin with recent MFA. [from,to) <=31 days, secure filters and bounded pagination. Payload/metadata omitted; query itself is audited atomically.',
      { query: auditQuerySchema, response: 'AuditPage' },
    ),
  },
  '/v1/admin/analytics': {
    get: op(
      'getAdminAnalytics',
      'Admin with recent MFA. [from,to) <=31 days by scheduled start cohort. Current-state counts include all bookings/rebookings; totals are not restricted by doctor page. Offered/booked seconds are clipped to the range; blocked capacity excluded, no-shows count as booked capacity. DB snapshot asOf records freshness; no aggregate cache.',
      { query: analyticsQuerySchema, response: 'AdminAnalytics' },
    ),
  },
  '/v1/admin/jobs': {
    get: op(
      'listOutboxJobs',
      'Admin with recent MFA; bounded creation-date window and status filtering. Safe status/attempt/error codes only, never payload. Failed jobs expose terminal exhaustion; setup delivery remains manual.',
      { query: jobsQuerySchema, response: 'JobPage' },
    ),
  },
};
const input = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });
export const clinicalSchemas = {
  WriteNotes: input(notesWriteSchema),
  ClinicalTransition: input(transitionSchema),
  ClinicalNotes: z.toJSONSchema(notesDtoSchema),
  NotesSaved: z.toJSONSchema(noteSavedSchema),
  CreatePrescription: input(prescriptionCreateSchema),
  EditPrescription: input(prescriptionEditSchema),
  RevokePrescription: input(prescriptionRevokeSchema),
  Prescription: z.toJSONSchema(prescriptionDtoSchema),
  PrescriptionPage: z.toJSONSchema(page(prescriptionDtoSchema)),
  CreatePayment: input(paymentCreateSchema),
  PaymentTransition: input(paymentTransitionSchema),
  Payment: z.toJSONSchema(paymentDtoSchema),
  PaymentPage: z.toJSONSchema(page(paymentDtoSchema)),
  AuditPage: z.toJSONSchema(page(audit)),
  JobPage: z.toJSONSchema(page(job)),
  AdminAnalytics: z.toJSONSchema(analyticsDtoSchema),
};
