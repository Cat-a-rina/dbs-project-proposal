"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useClerkSupabaseClient } from "@/lib/supabaseClient";

export default function InvitePage() {
  const { username } = useParams<{ username: string }>();
  const { isLoaded, isSignedIn, user } = useUser();
  const createClerkSupabaseClient = useClerkSupabaseClient();
  const [status, setStatus] = useState("Adding friend...");

  const isOwnLink = isLoaded && isSignedIn && user?.username === username;

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user || user.username === username) return;

    const supabase = createClerkSupabaseClient();
    supabase.rpc("add_friend", { friend_username: username }).then(({ error }) => {
      setStatus(error ? error.message : `You and ${username} are now friends.`);
    });
    // Only run once per invite link load -- not on every Clerk token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, user?.id, username]);

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", padding: "0 16px", fontFamily: "Arial, sans-serif" }}>
      <h1>Study-Hub invite</h1>
      <p>{isOwnLink ? "This is your own invite link." : status}</p>
      <Link href="/">Go to Study-Hub</Link>
    </main>
  );
}
