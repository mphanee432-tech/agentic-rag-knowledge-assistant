import * as fs from "fs"
import * as path from "path"
import * as dotenv from "dotenv"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const EXPECTED_PROJECT_REF = "cpowlkptvtnkjkulveph"
const BLOCKED_EMAIL = "phani9119@gmail.com"

const testEnvPath = path.resolve(process.cwd(), ".env.test.local")
if (!fs.existsSync(testEnvPath)) {
  throw new Error("Missing .env.test.local configuration")
}
dotenv.config({ path: testEnvPath, override: true })

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function assertTestProjectUrl(supabaseUrl: string): void {
  const parsed = new URL(supabaseUrl)
  const projectRef = parsed.hostname.split(".")[0]
  if (projectRef !== EXPECTED_PROJECT_REF) {
    throw new Error(
      `SAFETY ERROR: Expected test project ${EXPECTED_PROJECT_REF}, got ${projectRef}`,
    )
  }
}

async function findUsersByEmail(
  adminClient: SupabaseClient,
  targetEmails: string[],
): Promise<Map<string, string>> {
  const remaining = new Set(targetEmails.map((email) => email.toLowerCase()))
  const userIdsByEmail = new Map<string, string>()
  const perPage = 200
  let page = 1

  while (remaining.size > 0) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage })
    if (error) {
      throw new Error("Failed to list existing users")
    }
    const users = data?.users ?? []
    for (const user of users) {
      const normalizedEmail = user.email?.toLowerCase()
      if (normalizedEmail && remaining.has(normalizedEmail)) {
        userIdsByEmail.set(normalizedEmail, user.id)
        remaining.delete(normalizedEmail)
      }
    }
    if (users.length < perPage) {
      break
    }
    page += 1
  }

  return userIdsByEmail
}

async function main() {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL")
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  const employeePassword = requireEnv("WP5_EMPLOYEE_PASSWORD")
  const ownerAPassword = requireEnv("WP5_OWNER_A_PASSWORD")

  assertTestProjectUrl(supabaseUrl)

  const targets: Array<{ email: string; password: string }> = [
    { email: "wp5.test.employee@deccanbridge.invalid", password: employeePassword },
    { email: "owner-a@wp2a-fixture.invalid", password: ownerAPassword },
  ]

  for (const target of targets) {
    if (target.email.toLowerCase() === BLOCKED_EMAIL) {
      throw new Error("SAFETY ERROR: Refusing to reset protected user account")
    }
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const userIdsByEmail = await findUsersByEmail(
    adminClient,
    targets.map((target) => target.email),
  )

  let hasFailure = false
  for (const target of targets) {
    const userId = userIdsByEmail.get(target.email.toLowerCase())
    if (!userId) {
      console.error(`[FAIL] ${target.email}: account not found`)
      hasFailure = true
      continue
    }

    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      password: target.password,
    })
    if (error) {
      console.error(`[FAIL] ${target.email}: password update failed`)
      hasFailure = true
    } else {
      console.log(`[PASS] ${target.email}: password updated`)
    }
  }

  if (hasFailure) {
    process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "Unexpected error"
  console.error(message)
  process.exit(1)
})

