DROP TRIGGER users_directory_revision ON users;
DROP TRIGGER doctors_directory_revision ON doctors;
DROP FUNCTION invalidate_doctor_directory();
DROP TABLE doctor_directory_revision;
DROP TRIGGER consultation_bookable_slot ON consultations;
DROP FUNCTION guard_bookable_slot();
