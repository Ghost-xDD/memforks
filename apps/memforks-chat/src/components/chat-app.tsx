"use client";

import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecalledFact } from "@/lib/memfork";
import { addBranch, loadBranches } from "@/lib/branches";
import { useTheme } from "@/lib/theme";
import { Header } from "./header";
import { MessageList } from "./message-list";
import { PromptPills } from "./prompt-pills";
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
  const [theme, toggleTheme] = useTheme();
  const [branch, setBranch] = useState("main");
  const [branches, setBranches] = useState<string[]>(["main"]);
  const [branchingIndex, setBranchingIndex] = useState<number | null>(null);
  const [recalledByMessageId, setRecalledByMessageId] = useState<
    Record<string, RecalledFact[]>
  >({});
  const pendingRecalled = useRef<RecalledFact[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBranches(loadBranches());
  }, []);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
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

  const isEmpty = messages.length === 0;

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

  const handlePromptSelect = useCallback(
    (prompt: string) => {
      if (isLoading) return;
      void append({ role: "user", content: prompt });
    },
    [append, isLoading],
  );

  // Auto-grow textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Scroll to bottom on new messages.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!input.trim() || isLoading) return;
        formRef.current?.requestSubmit();
      }
    },
    [input, isLoading],
  );

  const isForked = useMemo(() => branch !== "main", [branch]);

  const composer = (
    <div className={isEmpty ? styles.composerCenter : styles.composerWrap}>
      <form ref={formRef} className={styles.composer} onSubmit={onSubmit}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          value={input}
          onChange={handleInputChange}
          onKeyDown={onKeyDown}
          placeholder="Message…"
          rows={1}
          disabled={isLoading}
          autoFocus
        />
        <button
          className={styles.sendBtn}
          type="submit"
          disabled={isLoading || !input.trim()}
          aria-label="Send message"
        >
          <svg className={styles.sendIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 19V5M5 12l7-7 7 7"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>

      <PromptPills onSelect={handlePromptSelect} disabled={isLoading} />

      <p className={styles.hint}>
        Memory recalled &amp; committed on branch <code>{branch}</code> · Enter
        to send, Shift+Enter for newline
      </p>
    </div>
  );

  return (
    <div className={styles.root}>
      <Header
        branch={branch}
        branches={branches}
        onBranchChange={handleBranchChange}
        onNewChat={handleNewChat}
        onThemeToggle={toggleTheme}
        theme={theme}
        isForked={isForked}
      />

      {isEmpty ? (
        <main className={styles.mainEmpty}>
          <div className={styles.emptyStage}>
            <p className={styles.emptyTitle}>What should we work through?</p>
            <p className={styles.emptyHint}>
              Memory persists across sessions on branch <code>{branch}</code>.
              Branch from any reply to explore an alternative.
            </p>
            {composer}
          </div>
        </main>
      ) : (
        <>
          <main className={styles.main}>
            <MessageList
              messages={messages}
              recalledByMessageId={recalledByMessageId}
              branch={branch}
              isLoading={isLoading}
              onBranchFrom={handleBranchFrom}
              branchingIndex={branchingIndex}
            />
            <div ref={endRef} />
          </main>
          {composer}
        </>
      )}
    </div>
  );
}
