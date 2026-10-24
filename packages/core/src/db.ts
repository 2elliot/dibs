import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config";

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (!client) {
    const { supabaseUrl, supabaseKey } = loadConfig();
    client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  }
  return client;
}
