export interface ChatLogAPI {
  addMessage(agentId: string, text: string): void;
  addSystem(text: string): void;
  addBattle(text: string): void;
  getRecent(limit?: number): string[];
  /** Provide a function that resolves agentId -> display name */
  setNameResolver(fn: (agentId: string) => string): void;
  setMobileOpen(open: boolean): void;
  isMobileOpen(): boolean;
}

/**
 * Chat log panel (bottom-left).
 * Three modes: compact (default), expanded, fullscreen.
 */
export function setupChatLog(): ChatLogAPI {
  const container = document.getElementById("chat-log")!;
  const recentEntries: string[] = [];
  let nameResolver: (id: string) => string = (id) => id;
  let mode: "compact" | "expanded" | "fullscreen" = "compact";
  let mobileOpen = false;
  let userScrolledUp = false;
  let unreadCount = 0;

  // ── Header ─────────────────────────────────────────────────
  const headerEl = document.createElement("div");
  headerEl.className = "chat-header";

  const titleEl = document.createElement("span");
  titleEl.className = "chat-title";
  titleEl.textContent = "World Chat";
  headerEl.appendChild(titleEl);

  const badgeEl = document.createElement("span");
  badgeEl.className = "chat-badge";
  badgeEl.textContent = "0";
  badgeEl.style.display = "none";
  headerEl.appendChild(badgeEl);

  // Expand button (compact -> expanded)
  const expandBtn = document.createElement("button");
  expandBtn.className = "chat-expand-btn";
  expandBtn.textContent = "\u25B3"; // up triangle
  expandBtn.title = "Expand";
  headerEl.appendChild(expandBtn);

  // Fullscreen button (-> fullscreen)
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "chat-expand-btn chat-fullscreen-btn";
  fullscreenBtn.textContent = "\u2922"; // expand arrows
  fullscreenBtn.title = "Fullscreen";
  headerEl.appendChild(fullscreenBtn);

  container.appendChild(headerEl);

  // ── Messages ───────────────────────────────────────────────
  const messagesEl = document.createElement("div");
  messagesEl.className = "chat-messages";
  container.appendChild(messagesEl);

  // ── Mode switching ─────────────────────────────────────────
  function setMode(next: "compact" | "expanded" | "fullscreen"): void {
    mode = next;
    container.classList.remove("chat-expanded", "chat-fullscreen");

    if (mode === "expanded") {
      container.classList.add("chat-expanded");
      expandBtn.textContent = "\u25BD"; // down triangle (collapse)
      expandBtn.title = "Collapse";
      fullscreenBtn.style.display = "";
    } else if (mode === "fullscreen") {
      container.classList.add("chat-fullscreen");
      expandBtn.textContent = "\u25BD";
      expandBtn.title = "Exit fullscreen";
      fullscreenBtn.style.display = "none";
    } else {
      expandBtn.textContent = "\u25B3";
      expandBtn.title = "Expand";
      fullscreenBtn.style.display = "";
    }

    if (mode !== "compact") {
      unreadCount = 0;
      badgeEl.style.display = "none";
    }
    scrollToBottom();
  }

  expandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (mode === "compact") setMode("expanded");
    else if (mode === "expanded") setMode("compact");
    else setMode("compact"); // fullscreen -> compact
  });

  fullscreenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (window.matchMedia("(max-width: 900px)").matches) {
      setMode("expanded");
      return;
    }
    setMode("fullscreen");
  });

  headerEl.addEventListener("click", () => {
    if (mode === "compact") setMode("expanded");
    else setMode("compact");
  });

  // Escape exits fullscreen
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mode === "fullscreen") {
      setMode("compact");
    }
  });

  // ── Smart auto-scroll ──────────────────────────────────────
  messagesEl.addEventListener("scroll", () => {
    const atBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 30;
    userScrolledUp = !atBottom;
  });

  function scrollToBottom(): void {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── Time formatting ────────────────────────────────────────
  function formatTime(): string {
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  // ── Track unread + cap messages ────────────────────────────
  function postInsert(rawText: string): void {
    recentEntries.push(rawText);
    while (messagesEl.children.length > 200) {
      messagesEl.removeChild(messagesEl.firstChild!);
    }
    while (recentEntries.length > 200) {
      recentEntries.shift();
    }
    if (!userScrolledUp) scrollToBottom();
    if (mode === "compact" && !mobileOpen) {
      unreadCount++;
      badgeEl.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      badgeEl.style.display = "";
    }
  }

  // ── Add generic entry ──────────────────────────────────────
  function addEntry(className: string, content: string, rawText: string): void {
    const el = document.createElement("div");
    el.className = `chat-entry ${className}`;
    el.textContent = content;
    messagesEl.appendChild(el);
    postInsert(rawText);
  }

  return {
    setNameResolver(fn: (agentId: string) => string): void {
      nameResolver = fn;
    },
    setMobileOpen(open: boolean): void {
      mobileOpen = open;
      container.classList.toggle("mobile-open", open);
      if (!open && mode === "fullscreen") {
        setMode("compact");
      }
      if (open && mode === "compact") {
        unreadCount = 0;
        badgeEl.style.display = "none";
      }
    },
    isMobileOpen(): boolean {
      return mobileOpen;
    },

    addMessage(agentId: string, text: string) {
      const time = formatTime();
      const name = nameResolver(agentId);

      const el = document.createElement("div");
      el.className = "chat-entry chat-msg";

      const timeSpan = document.createElement("span");
      timeSpan.className = "chat-time";
      timeSpan.textContent = time;
      el.appendChild(timeSpan);

      const nameSpan = document.createElement("span");
      nameSpan.className = "chat-agent-name";
      nameSpan.textContent = name;
      nameSpan.title = agentId;
      el.appendChild(nameSpan);

      const textSpan = document.createElement("span");
      textSpan.className = "chat-text";
      textSpan.textContent = text;
      el.appendChild(textSpan);

      messagesEl.appendChild(el);
      postInsert(`${name}: ${text}`);
    },

    addSystem(text: string) {
      addEntry("chat-system", `${formatTime()}  ${text}`, text);
    },

    addBattle(text: string) {
      addEntry("chat-battle", `${formatTime()}  ${text}`, `[BATTLE] ${text}`);
    },

    getRecent(limit = 8): string[] {
      return recentEntries.slice(-Math.max(1, limit));
    },
  };
}
