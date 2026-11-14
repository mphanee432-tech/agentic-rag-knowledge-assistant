import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export const DEMO_DEPARTMENTS = [
  "Engineering",
  "HR",
  "Product Management",
  "Project Management",
  "UI/UX",
  "Operations",
  "Marketing",
  "Finance",
] as const

export type DemoDepartment = (typeof DEMO_DEPARTMENTS)[number]
export const PENDING_DEMO_DEPARTMENT_COOKIE = "pending_demo_department"

export function isDemoDepartment(value: unknown): value is DemoDepartment {
  return typeof value === "string" && (DEMO_DEPARTMENTS as readonly string[]).includes(value.trim())
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
