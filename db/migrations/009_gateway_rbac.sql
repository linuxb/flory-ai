CREATE TABLE gateway_rbac_role (
    role_id TEXT PRIMARY KEY CHECK (role_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    description TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (role_id <> '*')
);

CREATE TABLE gateway_rbac_subject (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issuer, subject),
    CHECK (issuer <> '' AND subject <> '')
);

CREATE TABLE gateway_rbac_subject_role (
    binding_id BIGSERIAL PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES gateway_rbac_role(role_id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (issuer, subject) REFERENCES gateway_rbac_subject(issuer, subject) ON DELETE CASCADE
);

CREATE UNIQUE INDEX gateway_rbac_subject_role_active
    ON gateway_rbac_subject_role(issuer, subject, role_id)
    WHERE revoked_at IS NULL;

CREATE TABLE gateway_rbac_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    actor_spiffe_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    target JSONB NOT NULL,
    before_revision BIGINT NOT NULL,
    after_revision BIGINT NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (idempotency_key <> '' AND request_id <> '' AND actor_spiffe_id <> '')
);

CREATE OR REPLACE FUNCTION gateway_rbac_put_role(
    p_actor TEXT, p_request_id TEXT, p_idempotency_key TEXT, p_role_id TEXT,
    p_description TEXT, p_enabled BOOLEAN, p_expected_revision BIGINT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    current_revision BIGINT;
    existing_operation TEXT;
    existing_target JSONB;
    result JSONB;
BEGIN
    IF COALESCE(p_actor, '') = '' OR COALESCE(p_request_id, '') = '' OR COALESCE(p_idempotency_key, '') = '' THEN
        RAISE EXCEPTION 'actor, request ID, and idempotency key are required' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gateway-rbac-idempotency:' || p_idempotency_key, 0));
    SELECT operation, target, response INTO existing_operation, existing_target, result
        FROM gateway_rbac_audit WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing_operation <> 'role.put' OR existing_target <> jsonb_build_object('role_id', p_role_id) THEN
            RAISE EXCEPTION 'idempotency key was already used for another mutation' USING ERRCODE = '22023';
        END IF;
        RETURN result;
    END IF;
    IF p_role_id = '*' OR p_role_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
        RAISE EXCEPTION 'invalid or reserved role %', p_role_id USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gateway-rbac-role:' || p_role_id, 0));
    SELECT revision INTO current_revision FROM gateway_rbac_role WHERE role_id = p_role_id FOR UPDATE;
    IF NOT FOUND THEN
        current_revision := 0;
    END IF;
    IF current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'role revision conflict: expected %, found %', p_expected_revision, current_revision USING ERRCODE = '40001';
    END IF;
    INSERT INTO gateway_rbac_role(role_id, description, enabled, revision)
    VALUES (p_role_id, COALESCE(p_description, ''), p_enabled, current_revision + 1)
    ON CONFLICT (role_id) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled,
        revision = EXCLUDED.revision, updated_at = now();
    result := jsonb_build_object('role_id', p_role_id, 'description', COALESCE(p_description, ''),
        'enabled', p_enabled, 'revision', current_revision + 1);
    INSERT INTO gateway_rbac_audit(idempotency_key, request_id, actor_spiffe_id, operation, target,
        before_revision, after_revision, response)
    VALUES (p_idempotency_key, p_request_id, p_actor, 'role.put', jsonb_build_object('role_id', p_role_id),
        current_revision, current_revision + 1, result);
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION gateway_rbac_replace_subject_roles(
    p_actor TEXT, p_request_id TEXT, p_idempotency_key TEXT, p_issuer TEXT, p_subject TEXT,
    p_roles TEXT[], p_enabled BOOLEAN, p_expected_revision BIGINT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    current_revision BIGINT;
    existing_operation TEXT;
    existing_target JSONB;
    result JSONB;
BEGIN
    IF COALESCE(p_actor, '') = '' OR COALESCE(p_request_id, '') = '' OR COALESCE(p_idempotency_key, '') = '' THEN
        RAISE EXCEPTION 'actor, request ID, and idempotency key are required' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gateway-rbac-idempotency:' || p_idempotency_key, 0));
    SELECT operation, target, response INTO existing_operation, existing_target, result
        FROM gateway_rbac_audit WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing_operation <> 'subject.roles.replace' OR existing_target <>
            jsonb_build_object('issuer', p_issuer, 'subject', p_subject) THEN
            RAISE EXCEPTION 'idempotency key was already used for another mutation' USING ERRCODE = '22023';
        END IF;
        RETURN result;
    END IF;
    IF COALESCE(p_issuer, '') = '' OR COALESCE(p_subject, '') = '' OR array_position(p_roles, '*') IS NOT NULL THEN
        RAISE EXCEPTION 'issuer/subject must be non-empty and * cannot be bound' USING ERRCODE = '22023';
    END IF;
    p_roles := COALESCE(p_roles, ARRAY[]::TEXT[]);
    IF EXISTS (SELECT 1 FROM unnest(p_roles) requested(role_id)
        LEFT JOIN gateway_rbac_role r USING (role_id) WHERE r.role_id IS NULL OR NOT r.enabled) THEN
        RAISE EXCEPTION 'all roles must exist and be enabled' USING ERRCODE = '23503';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gateway-rbac-subject:' || p_issuer || E'\n' || p_subject, 0));
    SELECT revision INTO current_revision FROM gateway_rbac_subject
        WHERE issuer = p_issuer AND subject = p_subject FOR UPDATE;
    IF NOT FOUND THEN current_revision := 0; END IF;
    IF current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'subject revision conflict: expected %, found %', p_expected_revision, current_revision USING ERRCODE = '40001';
    END IF;
    INSERT INTO gateway_rbac_subject(issuer, subject, enabled, revision)
    VALUES (p_issuer, p_subject, p_enabled, current_revision + 1)
    ON CONFLICT (issuer, subject) DO UPDATE SET enabled = EXCLUDED.enabled, revision = EXCLUDED.revision, updated_at = now();
    UPDATE gateway_rbac_subject_role SET revoked_at = now()
        WHERE issuer = p_issuer AND subject = p_subject AND revoked_at IS NULL
            AND NOT (role_id = ANY(p_roles));
    INSERT INTO gateway_rbac_subject_role(issuer, subject, role_id)
        SELECT p_issuer, p_subject, requested.role_id
        FROM (SELECT DISTINCT unnest(p_roles) AS role_id) requested
        WHERE NOT EXISTS (
            SELECT 1 FROM gateway_rbac_subject_role existing
            WHERE existing.issuer = p_issuer AND existing.subject = p_subject
                AND existing.role_id = requested.role_id AND existing.revoked_at IS NULL
        );
    result := jsonb_build_object('issuer', p_issuer, 'subject', p_subject, 'roles',
        (SELECT COALESCE(jsonb_agg(role_id ORDER BY role_id), '[]'::jsonb) FROM gateway_rbac_subject_role
            WHERE issuer = p_issuer AND subject = p_subject AND revoked_at IS NULL),
        'enabled', p_enabled, 'revision', current_revision + 1);
    INSERT INTO gateway_rbac_audit(idempotency_key, request_id, actor_spiffe_id, operation, target,
        before_revision, after_revision, response)
    VALUES (p_idempotency_key, p_request_id, p_actor, 'subject.roles.replace',
        jsonb_build_object('issuer', p_issuer, 'subject', p_subject), current_revision, current_revision + 1, result);
    RETURN result;
END $$;

REVOKE ALL ON gateway_rbac_role, gateway_rbac_subject, gateway_rbac_subject_role, gateway_rbac_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION gateway_rbac_put_role(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION gateway_rbac_replace_subject_roles(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BIGINT) FROM PUBLIC;
GRANT SELECT ON gateway_rbac_role, gateway_rbac_subject, gateway_rbac_subject_role, gateway_rbac_audit TO gateway_role;
GRANT USAGE, SELECT ON SEQUENCE gateway_rbac_audit_audit_id_seq, gateway_rbac_subject_role_binding_id_seq TO gateway_role;
GRANT EXECUTE ON FUNCTION gateway_rbac_put_role(TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BIGINT) TO gateway_role;
GRANT EXECUTE ON FUNCTION gateway_rbac_replace_subject_roles(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN, BIGINT) TO gateway_role;

CREATE TABLE run_authorization (
    run_id UUID PRIMARY KEY REFERENCES run(run_id),
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    subject_revision BIGINT NOT NULL,
    roles TEXT[] NOT NULL,
    identity JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION project_run_authorization() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE auth_doc JSONB;
BEGIN
    IF NEW.event_type <> 'run/start' OR NOT (NEW.payload ? 'authorization_identity') THEN RETURN NEW; END IF;
    auth_doc := NEW.payload->'authorization_identity';
    INSERT INTO run_authorization(run_id, issuer, subject, subject_revision, roles, identity)
    VALUES (NEW.run_id, auth_doc->>'issuer', auth_doc->>'subject',
        (auth_doc->>'subject_revision')::BIGINT,
        ARRAY(SELECT jsonb_array_elements_text(auth_doc->'roles') ORDER BY 1), auth_doc);
    RETURN NEW;
END $$;

CREATE TRIGGER event_log_project_run_authorization
AFTER INSERT ON event_log FOR EACH ROW EXECUTE FUNCTION project_run_authorization();

REVOKE ALL ON run_authorization FROM PUBLIC;
GRANT SELECT ON run_authorization TO engine_role, coordinator_role;
