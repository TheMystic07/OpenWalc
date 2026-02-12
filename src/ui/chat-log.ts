interface ChatLogAPI {
  addMessage(agentId: string, text: string): void;
  addSystem(text: string): void;
  addBattle(text: string): void;
  getRecent(limit?: number): string[];
}

/**
 * Scrollable chat log panel (bottom-left).
 * Shows broadcast messages, system events, and battle updates.
 */
export function setupChatLog(): ChatLogAPI {
  const container = document.getElementById("chat-log")!;
  const recentEntries: string[] = [];

  const titleEl = document.createElement("div");
  titleEl.className = "chat-title";
  titleEl.textContent = "World Chat";
  container.appendChild(titleEl);

  const messagesEl = document.createElement("div");
  messagesEl.className = "chat-messages";
  container.appendChild(messagesEl);

  function addEntry(className: string, content: string): void {
    const el = document.createElement("div");
    el.className = `chat-entry ${className}`;
    el.textContent = content;
    messagesEl.appendChild(el);
    recentEntries.push(content);

    while (messagesEl.children.length > 120) {
      messagesEl.removeChild(messagesEl.firstChild!);
    }
    while (recentEntries.length > 120) {
      recentEntries.shift();
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  return {
    addMessage(agentId: string, text: string) {
      const time = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      addEntry("chat-msg", `[${time}] ${agentId}: ${text}`);
    },
    addSystem(text: string) {
      addEntry("chat-system", `- ${text}`);
    },
    addBattle(text: string) {
      addEntry("chat-battle", `[BATTLE] ${text}`);
    },
    getRecent(limit = 8): string[] {
      return recentEntries.slice(-Math.max(1, limit));
    },
  };
}
