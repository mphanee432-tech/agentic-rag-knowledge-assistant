"use server"
import { createServerClient } from "@/lib/supabase/server"
export async function signOut() {
  const supabase = await createServerClient()
  const { error } = await supabase.auth.signOut()
  if (error) throw new Error("Unable to sign out.")
}

