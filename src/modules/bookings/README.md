# Bookings module

Implemented in Phase 3: doctor-owned availability creation/listing/blocking,
transactional patient booking, authorized cancellation and encrypted write
idempotency. A transaction-scoped repository writes consultation, audit, outbox
and idempotency together. PostgreSQL locks and constraints own occupancy.

Routes/controllers depend on services; services depend on domain ports. The
composition root supplies infrastructure adapters and the shared security services.
See docs/booking-and-discovery.md and the generated OpenAPI contract.
