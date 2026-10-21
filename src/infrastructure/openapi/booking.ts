import { z } from 'zod';
import * as booking from '../../modules/bookings/schemas.js';
import * as doctors from '../../modules/doctors/schemas.js';
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const response = (name: string, description: string) => ({ description, content: json(ref(name)) });
const idempotency = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  description:
    'Scoped to actor and operation. Retained for 24 hours. Identical authorized retries replay the original status/body even after subsequent resource changes; changed payloads return 409. Expired keys return 409; use a fresh key.',
};
function queryParameters(schema: z.ZodType) {
  const document = z.toJSONSchema(schema, { io: 'input' });
  return Object.entries(document.properties ?? {}).map(([name, value]) => ({
    name,
    in: 'query',
    required: false,
    schema: value,
  }));
}
function operation(
  id: string,
  description: string,
  options: {
    request?: string;
    response: string;
    status?: number;
    paths?: string[];
    query?: z.ZodType;
    write?: boolean;
  },
) {
  return {
    operationId: id,
    tags: ['Availability and Booking'],
    description,
    security: [{ AccessToken: [] }],
    parameters: [
      ...(options.paths ?? []).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      })),
      ...(options.query ? queryParameters(options.query) : []),
      ...(options.write ? [idempotency] : []),
    ],
    ...(options.request
      ? { requestBody: { required: true, content: json(ref(options.request)) } }
      : {}),
    responses: {
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((status) => [
          String(status),
          response(
            'Error',
            (
              {
                400: 'Invalid request or missing idempotency key',
                401: 'Invalid or incomplete MFA authentication',
                403: 'Role, ownership or reason policy denied',
                404: 'Resource not found',
                409: 'Overlap, occupancy, past time, invalid state, changed request or expired key',
                413: 'Body too large',
                415: 'Unsupported encoding',
                429: 'Rate limited; Retry-After supplies seconds',
                500: 'Internal error; transaction rolled back',
                503: 'Security enforcement unavailable',
              } as Record<number, string>
            )[status]!,
          ),
        ]),
      ),
      [String(options.status ?? 200)]: response(options.response, 'Success'),
    },
  };
}
export const bookingPaths = {
  '/v1/doctors': {
    get: operation(
      'discoverDoctors',
      'All roles with completed MFA. Name is a case-insensitive literal substring; specialty is case-insensitive exact match. availableFrom/availableTo must both be supplied and contain a whole future open unoccupied slot. Explicit RFC3339 offsets; UTC output. Stable name/id order, bounded offset pagination. Only public directory fields are cached for 30s with a transactional DB revision; time-filtered discovery bypasses cache. Cache errors fall back to PostgreSQL; security rate-limit errors still fail closed.',
      { response: 'DoctorPage', query: doctors.discoveryQuerySchema },
    ),
  },
  '/v1/doctors/{doctorId}/availability': {
    get: operation(
      'listDoctorAvailability',
      'Authenticated users see future open unoccupied slots of active doctors. The owning doctor sees all their slots including blocked/occupied/history. from/to contain a whole slot, bounds are inclusive; stable startsAt/id order. Responses are live, not cached.',
      { paths: ['doctorId'], query: booking.availabilityQuerySchema, response: 'SlotPage' },
    ),
    post: operation(
      'createDoctorAvailability',
      'Owning doctor only. Future [startsAt,endsAt) slots; adjacency allowed, overlap forbidden even for blocked slots. Input requires RFC3339 UTC or numeric offset with seconds and optional millisecond precision. timeZone is a validated IANA presentation hint; the explicit offset defines the instant. No recurrence or local-time inference.',
      {
        paths: ['doctorId'],
        request: 'CreateSlot',
        response: 'AvailabilitySlot',
        status: 201,
        write: true,
      },
    ),
  },
  '/v1/doctors/{doctorId}/availability/{slotId}/block': {
    patch: operation(
      'blockDoctorAvailability',
      'Owning doctor only. Future unoccupied slots can be blocked. Occupied slots must be cancelled first. Reblocking succeeds without another logical audit event. Unblocking/moving/deleting slots is not implemented.',
      {
        paths: ['doctorId', 'slotId'],
        request: 'EmptyRequest',
        response: 'AvailabilitySlot',
        write: true,
      },
    ),
  },
  '/v1/consultations': {
    post: operation(
      'bookConsultation',
      'Active MFA-authenticated patient only; patient identity comes from the access token, never the body. Locks and revalidates the slot in PostgreSQL; exactly one non-cancelled consultation can occupy it. Consultation, successful audit, encrypted idempotency result and one logical outbox record commit atomically. Booking/cancellation limits allow 120 requests per actor/minute; Redis never owns slots. No payment or external network call occurs inside this transaction.',
      { request: 'BookConsultation', response: 'ConsultationBooking', status: 201, write: true },
    ),
  },
  '/v1/consultations/{consultationId}/cancel': {
    post: operation(
      'cancelConsultation',
      'Owning patient, assigned doctor or admin only. Scheduled consultations strictly before slot start only; patient reason patient_request, doctor reason doctor_unavailable, admin any defined code. Locks slot before consultation, releases occupancy atomically and emits one cancellation outbox record. Identical same-key retry replays; a different key against cancelled/started/completed state returns 409.',
      {
        paths: ['consultationId'],
        request: 'CancelConsultation',
        response: 'ConsultationBooking',
        write: true,
      },
    ),
  },
};
export const bookingSchemas = {
  CreateSlot: z.toJSONSchema(booking.slotCreateSchema, { io: 'input' }),
  BookConsultation: z.toJSONSchema(booking.bookingCreateSchema),
  CancelConsultation: z.toJSONSchema(booking.cancellationSchema),
  AvailabilitySlot: z.toJSONSchema(booking.slotDtoSchema),
  SlotPage: z.toJSONSchema(booking.slotPageSchema),
  ConsultationBooking: z.toJSONSchema(booking.consultationDtoSchema),
  DoctorPage: z.toJSONSchema(doctors.doctorPageSchema),
};
