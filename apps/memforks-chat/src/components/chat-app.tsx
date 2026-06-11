"use client";

import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecalledFact } from "@/lib/memfork";
import { addBranch, loadBranches } from "@/lib/branches";
import { Header } from "./header";
import { MessageList } from "./message-list";
import styles from "./chat-app.module.css";

function parseRecalledHeader(value: string | null): RecalledFact[] {
  if (!value) return [];
  try {
    return JSON.parse(decodeURIComponent(value)) as RecalledFact[];
  } catch {
    return [];
  }
}

export function ChatApp() {
  const [branch, setBranch] = useState("main");
  const [branches, setBranches] = useState<string[]>(["main"]);
  const [branchingIndex, setBranchingIndex] = useState<number | null>(null);
  const [recalledByMessageId, setRecalledByMessageId] = useState<
    Record<string, RecalledFact[]>
  >({});
  const pendingRecalled = useRef<RecalledFact[]>([]);

  useEffect(() => {
    setBranches(loadBranches());
  }, []);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    setMessages,
  } = useChat({
    api: "/api/chat",
    body: { branch },
    onResponse(response) {
      pendingRecalled.current = parseRecalledHeader(
        response.headers.get("X-MemForks-Recalled"),
      );
    },
    onFinish(message) {
      if (pendingRecalled.current.length === 0) return;
      setRecalledByMessageId((prev) => ({
        ...prev,
        [message.id]: pendingRecalled.current,
      }));
      pendingRecalled.current = [];
    },
  });

  const handleBranchChange = useCallback(
    (next: string) => {
      setBranch(next);
      setMessages([]);
      setRecalledByMessageId({});
    },
    [setMessages],
  );

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setRecalledByMessageId({});
  }, [setMessages]);

  const handleBranchFrom = useCallback(
    async (messageIndex: number) => {
      setBranchingIndex(messageIndex);
      try {
        const res = await fetch("/api/branch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: branch }),
        });
        const data = (await res.json()) as { branch?: string; error?: string };
        if (!res.ok || !data.branch) {
          throw new Error(data.error ?? "Failed to create branch");
        }

        const nextBranches = addBranch(data.branch);
        setBranches(nextBranches);
        setBranch(data.branch);
        setMessages(messages.slice(0, messageIndex + 1));
        setRecalledByMessageId({});
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : "Branch failed");
      } finally {
        setBranchingIndex(null);
      }
    },
    [branch, messages, setMessages],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;
      handleSubmit(e);
    },
    [handleSubmit, input, isLoading],
  );

  const isForked = useMemo(() => branch !== "main", [branch]);

  return (
    <div className={styles.root}>
      <Header
        branch={branch}
        branches={branches}
        onBranchChange={handleBranchChange}
        onNewChat={handleNewChat}
        isForked={isForked}
      />

      <main className={styles.main}>
        <MessageList
          messages={messages}
          recalledByMessageId={recalledByMessageId}
          branch={branch}
          isLoading={isLoading}
          onBranchFrom={handleBranchFrom}
          branchingIndex={branchingIndex}
        />
      </main>

      <form className={styles.composer} onSubmit={onSubmit}>
        <input
          className={styles.input}
          value={input}
          onChange={handleInputChange}
          placeholder="Message…"
          disabled={isLoading}
          autoFocus
        />
        <button className={styles.sendBtn} type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
