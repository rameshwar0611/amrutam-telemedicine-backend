ALTER TABLE outbox_jobs ADD COLUMN trace_parent text CHECK(trace_parent IS NULL OR trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
CREATE FUNCTION maintain_audit_partitions() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE month_start date; month_end date; partition_name text; made integer:=0; skipped integer:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(8245101) THEN RETURN jsonb_build_object('busy',true); END IF;
 FOR offset_month IN 0..3 LOOP
  month_start:=(date_trunc('month',CURRENT_DATE)+make_interval(months=>offset_month))::date;
  month_end:=(month_start+interval '1 month')::date;
  partition_name:='audit_logs_'||to_char(month_start,'YYYY_MM');
  IF to_regclass('public.'||partition_name) IS NOT NULL THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM public.audit_logs_default WHERE occurred_at>=month_start::timestamptz AND occurred_at<month_end::timestamptz) THEN skipped:=skipped+1;CONTINUE;END IF;
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',partition_name,month_start::text||' 00:00:00+00',month_end::text||' 00:00:00+00');made:=made+1;
 END LOOP;
 RETURN jsonb_build_object('created',made,'fallback_conflicts',skipped);
END $$;
CREATE FUNCTION cleanup_security_records(batch_size integer DEFAULT 500) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE n integer;result jsonb:='{}'::jsonb;cutoff timestamptz:=clock_timestamp()-interval '7 days';
BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'Invalid cleanup batch';END IF;
 IF NOT pg_try_advisory_xact_lock(8245102) THEN RETURN jsonb_build_object('busy',true);END IF;
 DELETE FROM public.outbox_jobs WHERE id IN(SELECT j.id FROM public.outbox_jobs j JOIN public.auth_tokens t ON j.deduplication_key='setup:'||t.id::text WHERE j.kind='identity.setup_delivery' AND t.expires_at<cutoff AND NOT EXISTS(SELECT 1 FROM public.job_receipts r WHERE r.job_id=j.id) ORDER BY t.expires_at LIMIT batch_size);
 GET DIAGNOSTICS n=ROW_COUNT;result:=result||jsonb_build_object('setup_deliveries',n);
 DELETE FROM public.auth_tokens WHERE id IN(SELECT id FROM public.auth_tokens WHERE expires_at<cutoff ORDER BY expires_at LIMIT batch_size);
 GET DIAGNOSTICS n=ROW_COUNT;result:=result||jsonb_build_object('tokens',n);
 DELETE FROM public.idempotency_records WHERE id IN(SELECT id FROM public.idempotency_records WHERE expires_at<cutoff ORDER BY expires_at LIMIT batch_size);
 GET DIAGNOSTICS n=ROW_COUNT;result:=result||jsonb_build_object('idempotency',n);
 DELETE FROM public.auth_flows WHERE id IN(SELECT f.id FROM public.auth_flows f WHERE expires_at<cutoff AND NOT EXISTS(SELECT 1 FROM public.mfa_factors m WHERE m.enrollment_flow_id=f.id) ORDER BY expires_at LIMIT batch_size);
 GET DIAGNOSTICS n=ROW_COUNT;result:=result||jsonb_build_object('flows',n);
 DELETE FROM public.auth_sessions WHERE id IN(SELECT id FROM public.auth_sessions WHERE expires_at<cutoff ORDER BY expires_at LIMIT batch_size);
 GET DIAGNOSTICS n=ROW_COUNT;result:=result||jsonb_build_object('sessions',n);
 INSERT INTO public.audit_logs(action,resource_type,outcome,metadata)VALUES('operations.security_cleanup','user','success',result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION maintain_audit_partitions() FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_security_records(integer) FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_maintenance') THEN CREATE ROLE amrutam_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;END IF;
 GRANT USAGE ON SCHEMA public TO amrutam_maintenance;
 GRANT EXECUTE ON FUNCTION maintain_audit_partitions(),cleanup_security_records(integer) TO amrutam_maintenance;
END $$;
