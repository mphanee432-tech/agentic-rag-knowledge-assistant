-- WP9.13: Signup opt-in for demo Jira ticket creation only.
-- Completely separate from enterprise organization_employees, departments, and document RLS.

CREATE TABLE IF NOT EXISTS public.demo_jira_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.demo_jira_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own demo_jira_access" ON public.demo_jira_access;
CREATE POLICY "Users can read own demo_jira_access"
  ON public.demo_jira_access
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.demo_jira_access FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.demo_jira_access TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_demo_jira_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(NEW.raw_user_meta_data ->> 'demo_jira_access', '') = 'true' THEN
    INSERT INTO public.demo_jira_access (user_id, enabled)
    VALUES (NEW.id, true)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_demo_jira_signup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_demo_jira ON auth.users;
CREATE TRIGGER on_auth_user_created_demo_jira
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_demo_jira_signup();

