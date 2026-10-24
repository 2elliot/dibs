import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** null until dashboard/.env.local is filled in, so the page can say so instead of crashing. */
export const supabase = url && key ? createClient(url, key) : null;
