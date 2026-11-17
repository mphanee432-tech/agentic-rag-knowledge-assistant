import {
  FolderPlus,
  ShieldCheck,
  Database,
  Building2,
  Lock,
} from "lucide-react"
import { isDualProjectConfigured } from "@/lib/supabase/config"
import { createServerClient } from "@/lib/supabase/server"
import { getDemoJiraAccess, getEnterpriseAccountStatus, getEnterpriseCopilotContext } from "@/lib/auth"
import { buildAccountSummary } from "@/lib/account-summary"
import { redirect } from "next/navigation"
import { AccountSummary } from "@/components/account-summary"
import { EnterpriseOnboardCard } from "@/components/enterprise-onboard-card"
import { DemoJiraCard } from "@/components/jira/jira-ticket-draft"
import { ProjectWorkspaceClient } from "@/components/chat/project-workspace-client"
import { WorkspaceTabs, type WorkspaceTab } from "@/components/workspace-tabs"
import { SignOut } from "@/components/sign-out"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { CreateProjectDialog } from "@/components/dashboard/create-project-dialog"
import { ProjectCard, type ProjectCardData } from "@/components/dashboard/project-card"

interface RawProjectRecord {
  id: string
  name?: string | null
  user_id: string
  created_at: string
  documents?: Array<{ count: number }>
}

interface DashboardPageProps {
  searchParams?:
  | Promise<{ tab?: string | string[]; enrolled?: string | string[] }>
  | { tab?: string | string[]; enrolled?: string | string[] }
}

export default async function DashboardPage({ searchParams }: DashboardPageProps = {}) {
  const resolvedSearchParams = await Promise.resolve(searchParams)
  const rawTab = Array.isArray(resolvedSearchParams?.tab)
    ? resolvedSearchParams?.tab[0]
    : resolvedSearchParams?.tab
  const rawEnrolled = Array.isArray(resolvedSearchParams?.enrolled)
    ? resolvedSearchParams?.enrolled[0]
    : resolvedSearchParams?.enrolled
  const activeTab: WorkspaceTab = rawTab === "enterprise" ? "enterprise" : "personal"
  const enrolled = rawEnrolled === "1"

  const supabase = await createServerClient(activeTab)
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect(activeTab === "enterprise" ? "/login?workspace=enterprise" : "/login?workspace=personal")
  }
  const shouldLoadEnterpriseMeta = activeTab === "enterprise" || !isDualProjectConfigured()
  const [enterprise, accountStatus, demoJiraAccess] = shouldLoadEnterpriseMeta
    ? await Promise.all([
      getEnterpriseCopilotContext(supabase),
      getEnterpriseAccountStatus(supabase),
      getDemoJiraAccess(supabase).catch(() => false),
    ])
    : [null, null, false]
  const accountSummary = buildAccountSummary({
    email: user.email,
    enterprise,
    accountStatus,
    demoJiraAccess,
  })
  if (activeTab === "enterprise") {
    if (enterprise) {
      return (
        <ProjectWorkspaceClient
          userId={user.id}
          organizationId={enterprise.organization_id}
          canUploadPolicy={enterprise.can_upload_policy}
          accountSummary={accountSummary}
          enrolled={enrolled}
        />
      )
    }

    return (
      <div className="min-h-screen w-full flex flex-col bg-background text-foreground">
        <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-border bg-card/60 backdrop-blur-sm flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4 w-full lg:w-auto min-w-0">
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shadow-xs">
                RAG
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-tight text-foreground">
                  Employee Knowledge Copilot
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  Enterprise Knowledge Base &amp; Policy Search
                </p>
              </div>
            </div>
            <WorkspaceTabs activeTab="enterprise" />
          </div>

          <div className="flex items-center gap-3">
            <SignOut workspace="enterprise" />
            <ThemeToggle />
          </div>
        </header>
        <AccountSummary account={accountSummary} />

        <main className="flex-1 flex flex-col p-6 md:p-12 max-w-6xl w-full mx-auto">
          {accountSummary.jiraAccessAvailable && <DemoJiraCard />}
          <div
            role="status"
            aria-label="Enterprise access notice"
            className="flex-1 flex flex-col items-center justify-center text-center my-auto py-16"
          >
            <div className="size-16 rounded-3xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 mb-5 shadow-xs">
              <Lock className="size-8" aria-hidden="true" />
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400 mb-3">
              <Building2 className="size-3.5" aria-hidden="true" />
              <span>Enterprise RAG Restricted</span>
            </div>
            <p className="text-base font-medium text-foreground max-w-md">
              You don&apos;t have active enterprise access. Contact your administrator.
            </p>
            {!accountStatus && <EnterpriseOnboardCard />}
          </div>
        </main>
      </div>
    )
  }

  const { data, error } = await supabase.from("projects")
    .select("id, name, user_id, created_at, documents(count)")
    .eq("user_id", user.id).order("created_at", { ascending: false })
  if (error) throw new Error("Unable to load projects.")
  const rawProjects = (data as unknown as RawProjectRecord[]) || []
  const projects: ProjectCardData[] = rawProjects.map((p) => ({
    id: p.id,
    name: p.name,
    user_id: p.user_id,
    created_at: p.created_at,
    documentsCount: p.documents?.[0]?.count ?? 0,
  }))

  const isEmpty = projects.length === 0

  return (
    <div className="min-h-screen w-full flex flex-col bg-background text-foreground">
      {/* Navigation Header */}
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-border bg-card/60 backdrop-blur-sm flex flex-wrap items-center justify-between gap-3 sticky top-0 z-20">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4 w-full lg:w-auto min-w-0">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shadow-xs">
              RAG
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-foreground">
                Knowledge Assistant Dashboard
              </h1>
              <p className="text-[11px] text-muted-foreground">
                Tenant-Isolated Technical Vector Workspaces
              </p>
            </div>
          </div>
          <WorkspaceTabs activeTab="personal" />
        </div>

        <div className="flex items-center gap-3">
          {!isEmpty && <CreateProjectDialog />}
          <SignOut workspace="personal" />
          <ThemeToggle />
        </div>
      </header>
      <AccountSummary account={accountSummary} />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col p-6 md:p-12 max-w-6xl w-full mx-auto">
        {!enterprise && accountSummary.jiraAccessAvailable && <DemoJiraCard />}
        {isEmpty && (
          /* Empty State: Clean, centered layout with folder icon, descriptive text, and primary create button */
          <div className="flex-1 flex flex-col items-center justify-center text-center my-auto py-16">
            <div className="size-20 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-6 shadow-sm">
              <FolderPlus className="size-10" />
            </div>

            <h2 className="text-2xl font-bold tracking-tight text-foreground mb-2">
              No Workspaces Created
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mb-8 leading-relaxed">
              You haven&apos;t created any project workspaces yet. Launch an isolated workspace to upload RFCs, analyze error logs, and query technical specifications.
            </p>

            <CreateProjectDialog
              trigger={
                <Button size="lg" className="h-12 px-6 text-sm font-medium shadow-md gap-2 cursor-pointer">
                  <FolderPlus className="size-4" />
                  <span>Create Your First Project</span>
                </Button>
              }
            />

            <div className="mt-12 flex items-center gap-6 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-emerald-500" />
                <span>Strict Tenant Isolation</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Database className="size-3.5 text-blue-500" />
                <span>1536d Exact k-NN</span>
              </div>
            </div>
          </div>
        )}

        {!isEmpty && (
          /* Populated State: Display a grid of previously created projects with links and options */
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-foreground">
                  Your Workspaces
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Select an active workspace to access chat synthesis, document retrieval, and uploads.
                </p>
              </div>
              <span className="text-xs font-mono text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
                {projects.length} {projects.length === 1 ? "Workspace" : "Workspaces"}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
