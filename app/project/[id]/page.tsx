import { redirect, notFound } from "next/navigation"
import { ProjectWorkspaceClient } from "@/components/chat/project-workspace-client"
import { buildAccountSummary } from "@/lib/account-summary"
import { isDualProjectConfigured } from "@/lib/supabase/config"
import {
  getDemoJiraAccess,
  getEnterpriseAccountStatus,
  getEnterpriseCopilotContext,
  HttpError,
  requireChatProject,
} from "@/lib/auth"

interface ProjectPageProps {
  params: Promise<{ id: string }> | { id: string }
}

export default async function ProjectWorkspacePage({ params }: ProjectPageProps) {
  const resolvedParams = await Promise.resolve(params)
  const id = resolvedParams?.id

  if (!id) {
    notFound()
  }

  const { project, enterprise, user, supabase } = await requireChatProject(id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 401) redirect("/login?workspace=personal")
    if (error instanceof HttpError && (error.status === 400 || error.status === 404)) notFound()
    throw error
  })
  if (enterprise) redirect("/?tab=enterprise")
  const [enterpriseContext, accountStatus, demoJiraAccess] = !isDualProjectConfigured()
    ? await Promise.all([
        getEnterpriseCopilotContext(supabase),
        getEnterpriseAccountStatus(supabase),
        getDemoJiraAccess(supabase).catch(() => false),
      ])
    : [null, null, false]
  const accountSummary = buildAccountSummary({
    email: user.email,
    enterprise: enterpriseContext,
    accountStatus,
    demoJiraAccess,
  })
  return <ProjectWorkspaceClient userId={user.id} projectId={project.id} projectName={project.name} accountSummary={accountSummary} />
}
