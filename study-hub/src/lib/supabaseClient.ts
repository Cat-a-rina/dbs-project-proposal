"use client";

import { useCallback } from "react";
import { useSession } from "@clerk/nextjs";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// Creates a Supabase client that attaches the current Clerk session token
// to every request, so Supabase (and future RLS policies) know who's asking.
export function useClerkSupabaseClient() {
  const { session } = useSession();

  return useCallback(() => {
    return createClient(supabaseUrl, supabasePublishableKey, {
      async accessToken() {
        return session?.getToken() ?? null;
      },
    });
  }, [session]);
}
