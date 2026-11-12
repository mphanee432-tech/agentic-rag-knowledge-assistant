import { redirect, notFound } from "next/navigation"
import { ProjectWorkspaceClient } from "@/components/chat/project-workspace-client"
import { HttpError, requireChatProject } from "@/lib/auth"

interface ProjectPageProps {
  params: Promise<{ id: string }> | { id: string }
}

export default async function ProjectWorkspacePage({ params }: ProjectPageProps) {
  const resolvedParams = await Promise.resolve(params)
  const id = resolvedParams?.id

  if (!id) {
    notFound()
  }

  const { project, enterprise } = await requireChatProject(id).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    if (error instanceof HttpError && (error.status === 400 || error.status === 404)) notFound()
    throw error
  })
  return <ProjectWorkspaceClient projectId={project.id} projectName={project.name} enterprise={enterprise} />
}
