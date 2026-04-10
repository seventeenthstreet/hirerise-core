CREATE TABLE IF NOT EXISTS public.chi_scores (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    resume_id uuid,
    chi_score numeric(6,2) NOT NULL,
    score_version text NOT NULL,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);