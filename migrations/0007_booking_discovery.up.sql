-- Existing GiST [start,end) exclusion and partial unique occupancy indexes remain authoritative.
-- Lock the slot for non-cancelled inserts, including writers outside the HTTP service.
CREATE FUNCTION guard_bookable_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot_status text;
BEGIN
  IF NEW.status <> 'cancelled' THEN
    SELECT status INTO slot_status FROM availability_slots WHERE id = NEW.slot_id FOR UPDATE;
    IF FOUND AND slot_status <> 'open' THEN
      RAISE EXCEPTION 'Slot is blocked' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consultation_bookable_slot BEFORE INSERT ON consultations
  FOR EACH ROW EXECUTE FUNCTION guard_bookable_slot();

-- A transactional generation avoids stale cache resurrection after a failed Redis invalidation.
CREATE TABLE doctor_directory_revision (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation uuid NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO doctor_directory_revision DEFAULT VALUES;
CREATE FUNCTION invalidate_doctor_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.doctor_directory_revision SET generation = gen_random_uuid() WHERE id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION invalidate_doctor_directory() FROM PUBLIC;
CREATE TRIGGER doctors_directory_revision AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON doctors
  FOR EACH STATEMENT EXECUTE FUNCTION invalidate_doctor_directory();
CREATE TRIGGER users_directory_revision AFTER UPDATE OF status, role, activated_at ON users
  FOR EACH STATEMENT EXECUTE FUNCTION invalidate_doctor_directory();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN
    GRANT SELECT ON doctor_directory_revision TO amrutam_api;
  END IF;
END $$;
