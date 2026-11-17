"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { UserButton, useSession, useUser } from "@clerk/nextjs";
import { useClerkSupabaseClient } from "@/lib/supabaseClient";

type Presence = {
  name: string;
  topic: string | null;
  started_at: string | null;
};

function presenceTopic(userId: string) {
  return `study:${userId}`;
}

// A dev-mode hot-reload (or any reconnect that doesn't fully close the old
// socket first) can leave more than one entry under the same presence key.
// Always prefer whichever one is actually live over just taking index [0],
// which after a few reloads is often a stale leftover.
function pickCurrentMeta(metas: Presence[] | undefined): Presence | undefined {
  if (!metas || metas.length === 0) return undefined;
  return metas.find((m) => m.topic) ?? metas[metas.length - 1];
}

function timeAgo(iso: string | null): string {
  if (!iso) return "just now";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return mins === 0 ? "just now" : `${mins} min ago`;
}

export default function Home() {
  const { isLoaded, user } = useUser();

  if (!isLoaded) {
    return <main style={{ maxWidth: 480, margin: "40px auto", padding: "0 16px" }}>Loading...</main>;
  }

  // Remounting StudyHubApp whenever the signed-in user changes discards
  // every piece of its local state in one shot -- no manual reset list to
  // maintain as new state gets added later. The resets and epoch guards
  // inside it stay too, as defense in depth for the brief in-between
  // renders React itself doesn't treat as a full identity change.
  return <StudyHubApp key={user?.id ?? "signed-out"} />;
}

function StudyHubApp() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { session } = useSession();
  const createClerkSupabaseClient = useClerkSupabaseClient();

  // isSignedIn can flip true slightly before Clerk's session token is
  // actually ready, which is exactly the race that caused the friend-list
  // fetch to silently run unauthenticated after an account switch. This is
  // a plain boolean (not the `session` object itself) so effects below only
  // re-run on a true/false transition, not on every routine token refresh
  // (which hands back a new `session` object reference each time).
  const sessionReady = !!session;

  const [joined, setJoined] = useState(false);
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState("");

  // Presence we're actually authorized to see: only ever populated from our
  // own channel and our friends' channels (see schema.sql) -- never from
  // anyone else's, so there's nothing to filter client-side.
  const [presenceById, setPresenceById] = useState<Record<string, Presence>>({});
  // Derived, not separately tracked: whether the Start/Stop button shows
  // "Stop" must always match what the server actually thinks our presence
  // is, or the two can drift apart (e.g. after a dropped/reconnected
  // websocket) -- which is exactly what showed "Stop" while the real
  // presence data said idle.
  const sessionActive = !!(user && presenceById[user.id]?.topic);
  const [friendIds, setFriendIds] = useState<string[]>([]);
  const [addFriendInput, setAddFriendInput] = useState("");
  const [addFriendStatus, setAddFriendStatus] = useState("");
  const [inviteLink, setInviteLink] = useState("");

  const ownChannelRef = useRef<RealtimeChannel | null>(null);
  const friendChannelsRef = useRef<Map<string, RealtimeChannel>>(new Map());
  const supabaseRef = useRef<SupabaseClient | null>(null);

  // Bumped every time a new identity's setup effect runs. Unsubscribing a
  // channel doesn't guarantee an in-flight event's callback won't still fire
  // afterward -- a late update from a PREVIOUS account's channel can land
  // after a newer account has already reset state. Every callback below
  // checks its captured epoch against the current one and no-ops if a newer
  // identity has since taken over, regardless of async teardown timing.
  const epochRef = useRef(0);

  // re-render every 30s so "started X min ago" keeps ticking
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Clerk hands back a new `createClerkSupabaseClient` every time the session
  // token silently refreshes (roughly once a minute). Stash the latest one in
  // a ref instead of effect dependency arrays, so a routine token refresh
  // doesn't tear down and rejoin channels. The client itself doesn't need to
  // be recreated on refresh -- its accessToken callback fetches a fresh token
  // on every request regardless.
  const createClientRef = useRef(createClerkSupabaseClient);
  useEffect(() => {
    createClientRef.current = createClerkSupabaseClient;
  }, [createClerkSupabaseClient]);

  async function refreshFriendIds(supabase: SupabaseClient, myId: string, myEpoch: number) {
    const { data, error } = await supabase.from("friendships").select("friend_id").eq("user_id", myId);
    if (!error && data && epochRef.current === myEpoch) {
      setFriendIds(data.map((row) => row.friend_id as string));
    }
  }

  // Once signed in: make sure our profile row exists, join our own private
  // presence channel (where we publish), and load our friend list.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !sessionReady || !user || ownChannelRef.current) return;

    epochRef.current += 1;
    const myEpoch = epochRef.current;

    const displayName = user.firstName || user.username || "Student";
    const supabase = createClientRef.current();
    supabaseRef.current = supabase;

    // Wipe every piece of state that could hold a previous account's data in
    // this same tab (e.g. signing out and into a different test account
    // without a full page reload). Audited every useState in this
    // component for this -- inviteLink isn't listed because it's always
    // unconditionally overwritten right below, not merged, so there's no
    // stale-value window for it.
    setPresenceById({});
    setFriendIds([]);
    setTopic("");
    setJoined(false);
    setStatus("");
    setAddFriendInput("");
    setAddFriendStatus("");

    setInviteLink(typeof window !== "undefined" ? `${window.location.origin}/invite/${user.username}` : "");

    supabase.from("profiles").upsert({ id: user.id, username: user.username ?? user.id }).then();

    const channel = supabase.channel(presenceTopic(user.id), {
      config: { private: true, presence: { key: user.id } },
    });
    ownChannelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      if (epochRef.current !== myEpoch) return;
      const state = channel.presenceState<Presence>();
      const mine = pickCurrentMeta(state[user.id]);
      setPresenceById((prev) => {
        if (mine) return { ...prev, [user.id]: mine };
        const next = { ...prev };
        delete next[user.id];
        return next;
      });
    });

    channel.subscribe(async (subStatus) => {
      if (epochRef.current !== myEpoch) return;
      setStatus("connection: " + subStatus);
      if (subStatus === "SUBSCRIBED") {
        await channel.track({ name: displayName, topic: null, started_at: null });
        setJoined(true);
      }
    });

    refreshFriendIds(supabase, user.id, myEpoch);

    const friendChannels = friendChannelsRef.current;
    return () => {
      channel.unsubscribe();
      ownChannelRef.current = null;
      friendChannels.forEach((c) => c.unsubscribe());
      friendChannels.clear();
    };
    // Deliberately keyed on user?.id (not the whole `user` object, which can
    // get a new reference without the id changing) and on sessionReady's
    // true/false transitions (not on `session` itself, which gets a new
    // reference on every routine token refresh). Either would cause this to
    // tear down and rejoin every channel far more often than intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, sessionReady, user?.id]);

  // Live-update our friend list the moment someone adds us, instead of only
  // picking it up on next page load. Relies on the "users can read their own
  // friendships" RLS policy in schema.sql -- Postgres Changes only ever
  // delivers rows that policy already lets this user select.
  useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase || !user || !sessionReady) return;
    const myEpoch = epochRef.current;

    const changes = supabase
      .channel(`friendships-changes:${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "friendships", filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (epochRef.current !== myEpoch) return;
          const newFriendId = payload.new.friend_id as string;
          setFriendIds((prev) => (prev.includes(newFriendId) ? prev : [...prev, newFriendId]));
        },
      )
      .subscribe();

    return () => {
      changes.unsubscribe();
    };
    // See the join effect above for why user?.id/sessionReady, not user/session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, sessionReady, user?.id]);

  // Open one private, read-only channel per friend so we can see their
  // status -- this only works because schema.sql's RLS policies authorize us
  // specifically as their friend; anyone else's subscribe attempt is refused
  // by Supabase itself, not just hidden in this UI.
  useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    const myEpoch = epochRef.current;

    for (const friendId of friendIds) {
      if (friendChannelsRef.current.has(friendId)) continue;

      const channel = supabase.channel(presenceTopic(friendId), {
        config: { private: true },
      });
      friendChannelsRef.current.set(friendId, channel);

      channel.on("presence", { event: "sync" }, () => {
        if (epochRef.current !== myEpoch) return;
        const state = channel.presenceState<Presence>();
        const theirs = pickCurrentMeta(state[friendId]);
        setPresenceById((prev) => {
          // "sync" also fires when they disconnect/sign out -- theirs will
          // be undefined in that case, and the entry must be removed, not
          // left untouched, or they'd stay stuck looking live forever.
          if (theirs) return { ...prev, [friendId]: theirs };
          const next = { ...prev };
          delete next[friendId];
          return next;
        });
      });

      channel.subscribe();
    }
  }, [friendIds]);

  async function handleStart() {
    const channel = ownChannelRef.current;
    const displayName = user?.firstName || user?.username || "Student";
    if (!channel || !user) return;
    const chosenTopic = topic.trim() || "studying";
    await channel.track({
      name: displayName,
      topic: chosenTopic,
      started_at: new Date().toISOString(),
    });
  }

  async function handleStop() {
    const channel = ownChannelRef.current;
    const displayName = user?.firstName || user?.username || "Student";
    if (!channel) return;
    await channel.track({ name: displayName, topic: null, started_at: null });
  }

  async function handleAddFriend() {
    const supabase = supabaseRef.current;
    const username = addFriendInput.trim();
    if (!supabase || !user || !username) return;
    setAddFriendStatus("Adding...");
    const { error } = await supabase.rpc("add_friend", { friend_username: username });
    if (error) {
      setAddFriendStatus(error.message);
      return;
    }
    setAddFriendInput("");
    setAddFriendStatus(`Added ${username}`);
    refreshFriendIds(supabase, user.id, epochRef.current);
  }

  const online = Object.entries(presenceById).filter(([, p]) => !!p.topic);
  const idle = Object.entries(presenceById).filter(([, p]) => !p.topic);

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
            {[...online, ...idle].map(([id, p]) => (
              <li
                key={id}
                style={{ padding: 8, border: "1px solid #ccc", marginBottom: 6, borderRadius: 4 }}
              >
                {p.topic
                  ? `🟢 ${p.name} — ${p.topic} (started ${timeAgo(p.started_at)})`
                  : `⚪ ${p.name} (idle)`}
                {id === user?.id && " (you)"}
              </li>
            ))}
            {online.length === 0 && idle.length === 0 && (
              <li style={{ padding: 8, color: "#888" }}>No friends online yet.</li>
            )}
          </ul>
          <div style={{ fontSize: "0.8rem", color: "#666", marginTop: 10 }}>{status}</div>

          <h3 style={{ marginTop: 24 }}>Add a friend</h3>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                placeholder="their username"
                value={addFriendInput}
                onChange={(e) => setAddFriendInput(e.target.value)}
                style={{ padding: 8, paddingRight: 28, fontSize: "1rem", width: "100%", boxSizing: "border-box" }}
              />
              {addFriendInput && (
                <button
                  type="button"
                  onClick={() => setAddFriendInput("")}
                  aria-label="Clear"
                  style={{
                    position: "absolute",
                    right: 4,
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "1rem",
                    lineHeight: 1,
                    padding: 4,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <button onClick={handleAddFriend} style={{ padding: "8px 16px" }}>
              Add
            </button>
          </div>
          {addFriendStatus && <div style={{ fontSize: "0.8rem", color: "#666" }}>{addFriendStatus}</div>}

          <h3 style={{ marginTop: 24 }}>Your invite link</h3>
          <p style={{ fontSize: "0.85rem", color: "#666" }}>
            Share this with a friend — once they sign in and open it, you&apos;re automatically added to
            each other&apos;s friend list.
          </p>
          <input
            readOnly
            value={inviteLink}
            onFocus={(e) => e.target.select()}
            style={{ padding: 8, fontSize: "0.85rem", width: "100%", boxSizing: "border-box" }}
          />
        </div>
      )}
    </main>
  );
}
