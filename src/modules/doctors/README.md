# Doctors module

Implemented in Phase 3: authenticated discovery by public name, specialty and
live slot availability, validated pagination, public DTOs and bounded Redis cache
fallback. Directory revision triggers prevent reuse of obsolete cache generations.
Availability-filtered queries always use PostgreSQL; no clinical data is cached.

Doctor/admin provisioning remains owned by identity. Availability management is
owned by bookings. Constructor-injected ports keep SQL/cache adapters out of services.
See docs/booking-and-discovery.md and the generated OpenAPI contract.
