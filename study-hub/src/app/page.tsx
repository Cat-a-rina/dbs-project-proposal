"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { UserButton, useUser } from "@clerk/nextjs";
import { useClerkSupabaseClient } from "@/lib/supabaseClient";

type Presence = {
  name: string;
  topic: string | null;
  started_at: string | null;
};

function timeAgo(iso: string | null): string {
  if (!iso) return "just now";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins === 0 ? "just now" : `${mins} min ago`;
}

export default function Home() {
  const { isLoaded, isSignedIn, user } = useUser();
  const createClerkSupabaseClient = useClerkSupabaseClient();

  const [joined, setJoined] = useState(false);
  const [topic, setTopic] = useState("");
  const [sessionActive, setSessionActive] = useState(false);
  const [online, setOnline] = useState<Presence[]>([]);
  const [status, setStatus] = useState("");
  const channelRef = useRef<RealtimeChannel | null>(null);

  // re-render every 30s so "started X min ago" keeps ticking
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Clerk hands back a new `createClerkSupabaseClient` every time the session
  // token silently refreshes (roughly once a minute). Stash the latest one in
  // a ref instead of the join effect's dependency array, so a routine token
  // refresh doesn't tear down and rejoin the presence channel.
  const createClientRef = useRef(createClerkSupabaseClient);
  useEffect(() => {
    createClientRef.current = createClerkSupabaseClient;
  }, [createClerkSupabaseClient]);

  // once Clerk confirms who you are, join the presence channel automatically
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user || channelRef.current) return;

    const displayName = user.firstName || user.username || "Student";

    const supabase = createClientRef.current();
    // Use the Clerk user id as the presence key so reconnects/reloads update
    // this person's existing slot instead of adding a duplicate entry.
    const channel = supabase.channel("study-room", {
      config: { presence: { key: user.id } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<Presence>();
      setOnline(Object.values(state).flat());
    });

    channel.subscribe(async (subStatus) => {
      setStatus("connection: " + subStatus);
      if (subStatus === "SUBSCRIBED") {
        await channel.track({ name: displayName, topic: null, started_at: null });
        setJoined(true);
      }
    });

    return () => {
      channel.unsubscribe();
      channelRef.current = null;
    };
  }, [isLoaded, isSignedIn, user?.id]);

  async function handleStart() {
    const channel = channelRef.current;
    const displayName = user?.firstName || user?.username || "Student";
    if (!channel) return;
    const chosenTopic = topic.trim() || "studying";
    await channel.track({
      name: displayName,
      topic: chosenTopic,
      started_at: new Date().toISOString(),
    });
    setSessionActive(true);
  }

  async function handleStop() {
    const channel = channelRef.current;
    const displayName = user?.firstName || user?.username || "Student";
    if (!channel) return;
    await channel.track({ name: displayName, topic: null, started_at: null });
    setSessionActive(false);
  }

  if (!isLoaded) {
    return <main style={{ maxWidth: 480, margin: "40px auto", padding: "0 16px" }}>Loading...</main>;
  }

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", padding: "0 16px", fontFamily: "Arial, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Study-Hub — live test</h1>
        <UserButton />
      </div>

      {joined && (
        <div>
          <input
            placeholder="What are you working on?"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            style={{ padding: 8, fontSize: "1rem", width: "100%", marginBottom: 8, boxSizing: "border-box" }}
          />
          {!sessionActive ? (
            <button onClick={handleStart} style={{ padding: "8px 16px", marginRight: 6 }}>
              Start Session
            </button>
          ) : (
            <button onClick={handleStop} style={{ padding: "8px 16px", marginRight: 6 }}>
              Stop
            </button>
          )}

          <h3>Who&apos;s online</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {online.map((p, i) => (
              <li
                key={i}
                style={{ padding: 8, border: "1px solid #ccc", marginBottom: 6, borderRadius: 4 }}
              >
                {p.topic
                  ? `🟢 ${p.name} — ${p.topic} (started ${timeAgo(p.started_at)})`
                  : `⚪ ${p.name} (idle)`}
              </li>
            ))}
          </ul>
          <div style={{ fontSize: "0.8rem", color: "#666", marginTop: 10 }}>{status}</div>
        </div>
      )}
    </main>
  );
}
