import type { EnterpriseAccountStatusRow } from "@/lib/auth"

export type EnterpriseAccessStatus = "Active" | "Inactive" | "No enterprise access"

export interface AccountSummaryInfo {
  email: string
  role: string | null
  organizationName: string | null
  departmentName?: string | null
  accessStatus: EnterpriseAccessStatus
  jiraAccessAvailable: boolean
}

const KNOWN_ORGANIZATIONS: Readonly<Record<string, string>> = {
  "c0000000-0000-4000-8000-000000000001": "DeccanBridge Software",
}

function formatEnterpriseRole(role: string | null | undefined): string | null {
  switch (role?.trim().toLowerCase()) {
    case "employee":
      return "Employee"
    case "manager":
      return "Manager"
    case "cxo":
      return "CXO"
    default:
      return null
  }
}

export function buildAccountSummary(params: {
  email?: string | null
  enterprise?: { organization_id: string; can_upload_policy: boolean } | null
  accountStatus?: EnterpriseAccountStatusRow | null
  demoJiraAccess?: boolean | null
}): AccountSummaryInfo {
  const email = params.email?.trim() || "Authenticated user"
  const { enterprise, accountStatus, demoJiraAccess } = params

  if (accountStatus) {
    const isActive = Boolean(accountStatus.is_active)
    const departmentName = accountStatus.department_name?.trim() || null
    const jiraAccessAvailable = isActive && demoJiraAccess === true
    return {
      email,
      role: formatEnterpriseRole(accountStatus.role),
      organizationName: accountStatus.organization_name || null,
      ...(departmentName ? { departmentName } : {}),
      accessStatus: isActive ? "Active" : "Inactive",
      jiraAccessAvailable,
    }
  }

  if (!enterprise) {
    return {
      email,
      role: null,
      organizationName: null,
      accessStatus: "No enterprise access",
      jiraAccessAvailable: demoJiraAccess === true,
    }
  }

  return {
    email,
    role: enterprise.can_upload_policy ? null : "Employee",
    organizationName: KNOWN_ORGANIZATIONS[enterprise.organization_id] ?? "Enterprise Organization",
    accessStatus: "Active",
    jiraAccessAvailable: demoJiraAccess === true,
  }
}
