import { Terminal } from "https://esm.sh/xterm@5.3.0";
import { FitAddon } from "https://esm.sh/xterm-addon-fit@0.8.0";

const settingsCookie = "estimate-settings";
const defaultNumbers = ["0", "1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "?"];
const lobbyWidth = 61;
const roomWidth = 72;

initTerminalApp();

function initTerminalApp() {
  const root = document.getElementById("terminal-root");

  if (!root) {
    throw new Error("terminal root missing");
  }

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Courier New", "Lucida Console", monospace',
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 1.15,
    theme: {
      background: "#08101e",
      foreground: "#a8c8ff",
      cursor: "#f2f4ff",
      selectionBackground: "rgba(168,200,255,0.28)",
      black: "#08101e",
      blue: "#7ea8ff",
      brightBlue: "#d5e2ff",
      white: "#a8c8ff",
      brightWhite: "#f2f4ff",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(root);
  fitAddon.fit();

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = [];

      if (currentState) {
        const linkText = currentQuickJoinLabel(currentState.roomName);
        const start = line.indexOf(linkText);

        if (start !== -1) {
          links.push({
            range: {
              start: { x: start + 1, y },
              end: { x: start + linkText.length, y },
            },
            text: linkText,
            activate: async () => {
              try {
                await navigator.clipboard.writeText(currentQuickJoinUrl(currentState.id));
                statusLine = "QUICK JOIN LINK COPIED TO CLIPBOARD.";
              } catch {
                statusLine = "CLIPBOARD COPY FAILED.";
              }
              refresh();
            },
          });
        }

        if (line.includes("VOTE ROM : ")) {
          let searchFrom = line.indexOf("VOTE ROM : ") + "VOTE ROM : ".length;
          for (const value of currentState.numbers) {
            const valueStart = line.indexOf(value, searchFrom);
            if (valueStart === -1) {
              continue;
            }

            searchFrom = valueStart + value.length;
            links.push({
              range: {
                start: { x: valueStart + 1, y },
                end: { x: valueStart + value.length, y },
              },
              text: value,
              activate: () => {
                void runCommand(`vote ${value}`);
              },
            });
          }
        }
      }

      for (const action of commandActions()) {
        const start = line.indexOf(action.label);
        if (start === -1) {
          continue;
        }

        links.push({
          range: {
            start: { x: start + 1, y },
            end: { x: start + action.label.length, y },
          },
          text: action.label,
          activate: () => {
            if (action.run) {
              void runCommand(action.run);
            } else if (action.prefill) {
              prefillCommand(action.prefill);
            }
          },
        });
      }

      callback(links);
    },
  });

  const settings = loadSettings();
  const pendingQuickJoinRoomKey = parseQuickJoinRoomKey(window.location.pathname);
  let ws = null;
  let currentRoomKey = settings.lastRoomKey;
  let currentState = null;
  let input = "";
  let promptLabel = "> ";
  let promptCount = 0;
  let isRendering = false;
  let statusLine = "READY. TYPE HELP FOR COMMAND INDEX.";
  let awaitingQuickJoinName = false;

  window.addEventListener("resize", () => {
    fitAddon.fit();
    refresh();
  });

  term.onData((data) => {
    if (data === "\r") {
      const command = input.trim();
      const promptBefore = promptCount;
      input = "";
      term.write("\r\n");

      if (awaitingQuickJoinName) {
        awaitingQuickJoinName = false;
        handleName([command]);
        if (promptCount === promptBefore) {
          renderPrompt();
        }
        return;
      }

      void Promise.resolve(runCommand(command)).finally(() => {
        if (promptCount === promptBefore) {
          renderPrompt();
        }
      });
      return;
    }

    if (data === "\u007F") {
      if (input.length > 0) {
        input = input.slice(0, -1);
        term.write("\b \b");
      }
      return;
    }

    if (data === "\u0003") {
      input = "";
      awaitingQuickJoinName = false;
      term.write("^C\r\n");
      renderPrompt();
      return;
    }

    if (/^[\x20-\x7E]$/.test(data)) {
      input += data;
      term.write(data);
    }
  });

  printBoot();
  refresh();

  function printBoot() {
    term.writeln("EstiMate Poker Planning Terminal v1.0");
    term.writeln("Copyright (C) EstiMate Systems");
    term.writeln("CPU : 80486DX2-66 Compatible        MODE : PROTECTED");
    term.writeln("BUS : ISA/VLB BACKPLANE             I/O  : DURABLE OBJECT FABRIC");
    term.writeln("BOOT: ROOM SESSION MANAGER [OK]     RTC  : SYNCHRONIZED");
    term.writeln("POST: POKER PLANNING CORE  [OK]     NET  : WEBSOCKET LINK READY");
    if (settings.name) {
      term.writeln(`CMOS USER PROFILE ................. ${settings.name}`);
    }
    if (settings.lastRoomName && settings.lastRoomKey) {
      term.writeln(`LAST ROOM IMAGE ................... ${settings.lastRoomName}`);
    }
    if (pendingQuickJoinRoomKey) {
      term.writeln("BOOT LINK ........................ QUICK JOIN LINK DETECTED");
    }
    term.writeln("");
  }

  async function runCommand(command) {
    if (!command) {
      return;
    }

    const [cmd, ...args] = parseArgs(command);

    switch ((cmd || "").toLowerCase()) {
      case "help":
        printHelp();
        break;
      case "name":
        handleName(args);
        break;
      case "join":
        await handleJoin(args);
        break;
      case "rejoin":
        await handleRejoin();
        break;
      case "leave":
        handleLeave();
        break;
      case "vote":
        handleVote(args);
        break;
      case "reveal":
        send({ type: "reveal" });
        break;
      case "clear":
        send({ type: "clear" });
        break;
      case "users":
      case "room":
        render();
        break;
      default:
        term.writeln(`Unknown command: ${cmd}`);
        term.writeln("Type 'help'.");
    }
  }

  function printHelp() {
    term.writeln("COMMAND  ARGUMENTS               FUNCTION");
    term.writeln("HELP                            SHOW COMMAND INDEX");
    term.writeln("NAME    <DISPLAY-NAME>          SAVE USER PROFILE IN CMOS COOKIE");
    term.writeln("JOIN    <ROOM> <PASSWORD>       ATTACH TO OR BOOT ROOM IMAGE");
    term.writeln("REJOIN                          LOAD LAST ROOM IMAGE");
    term.writeln("LEAVE                           DROP ACTIVE SOCKET LINK");
    term.writeln("VOTE    <VALUE>                 WRITE PLANNING POKER VALUE");
    term.writeln("REVEAL                          UNMASK ALL ESTIMATES");
    term.writeln("CLEAR                           RESET ACTIVE ROUND STATE");
    term.writeln("ROOM                            REDRAW ACTIVE TUI FRAME");
    term.writeln("USERS                           ALIAS FOR ROOM");
  }

  function handleName(args) {
    const name = args.join(" ").trim();
    if (!name) {
      term.writeln(awaitingQuickJoinName ? "Name required for quick join." : "Usage: name <display-name>");
      if (pendingQuickJoinRoomKey && !currentState) {
        awaitingQuickJoinName = true;
      }
      return;
    }

    settings.name = name;
    saveSettings(settings);
    send({ type: "rename", name });
    term.writeln(`Name saved: ${name}`);

    if (pendingQuickJoinRoomKey && !currentState) {
      void handleQuickJoin();
    }
  }

  async function handleJoin(args) {
    if (args.length < 2) {
      term.writeln("Usage: join <room> <password>");
      return;
    }

    const roomName = args[0];
    const password = args.slice(1).join(" ");
    const userName = ensureName();
    if (!userName) {
      return;
    }

    statusLine = `Joining room ${roomName}...`;
    refresh();

    try {
      const session = await postJson("/api/session/room", {
        roomName,
        password,
        participantId: settings.participantId,
        participantName: userName,
      });

      currentRoomKey = session.roomKey;
      settings.participantId = session.participantId;
      settings.lastRoomKey = session.roomKey;
      settings.lastRoomName = session.roomName;
      settings.lastRoomPassword = password;
      currentState = session.state;
      saveSettings(settings);
      window.history.replaceState({}, "", currentQuickJoinPath(session.roomKey));
      connectSocket();
      statusLine = `Joined ${session.roomName}.`;
      refresh();
    } catch (error) {
      statusLine = error instanceof Error ? error.message : String(error);
      refresh();
    }
  }

  async function handleRejoin() {
    const userName = ensureName();
    if (!userName) {
      return;
    }

    if (!settings.lastRoomKey) {
      term.writeln("No saved room.");
      return;
    }

    statusLine = `Rejoining ${settings.lastRoomName || settings.lastRoomKey}...`;
    refresh();

    try {
      const session = await postJson("/api/session/room", {
        roomKey: settings.lastRoomKey,
        participantId: settings.participantId,
        participantName: userName,
      });

      currentRoomKey = session.roomKey;
      settings.participantId = session.participantId;
      currentState = session.state;
      saveSettings(settings);
      if (session.roomKey) {
        window.history.replaceState({}, "", currentQuickJoinPath(session.roomKey));
      }
      connectSocket();
      statusLine = `Rejoined ${session.roomName}.`;
      refresh();
    } catch (error) {
      statusLine = error instanceof Error ? error.message : String(error);
      refresh();
    }
  }

  function handleLeave() {
    if (ws) {
      ws.close();
      ws = null;
    }
    currentRoomKey = "";
    currentState = null;
    statusLine = "Disconnected.";
    window.history.replaceState({}, "", "/");
    refresh();
  }

  async function handleQuickJoin() {
    const userName = ensureName();
    if (!userName || !pendingQuickJoinRoomKey) {
      return;
    }

    statusLine = "Booting quick join link...";
    refresh();

    try {
      const session = await postJson("/api/session/room", {
        roomKey: pendingQuickJoinRoomKey,
        participantId: settings.participantId,
        participantName: userName,
      });

      currentRoomKey = session.roomKey;
      settings.participantId = session.participantId;
      settings.lastRoomKey = session.roomKey;
      settings.lastRoomName = session.roomName;
      currentState = session.state;
      saveSettings(settings);
      window.history.replaceState({}, "", currentQuickJoinPath(session.roomKey));
      connectSocket();
      statusLine = `Joined ${session.roomName}.`;
      refresh();
    } catch (error) {
      statusLine = error instanceof Error ? error.message : String(error);
      refresh();
    }
  }

  function handleVote(args) {
    const value = args[0];
    if (!currentState) {
      term.writeln("Join room first.");
      return;
    }
    if (!value) {
      term.writeln(`Usage: vote <${currentState.numbers.join("|")}>`);
      return;
    }
    if (!currentState.numbers.includes(value)) {
      term.writeln(`Invalid vote. Allowed: ${currentState.numbers.join(", ")}`);
      return;
    }
    send({ type: "vote", value });
    statusLine = `Vote sent: ${value}`;
    refresh();
  }

  function ensureName() {
    if (settings.name) {
      return settings.name;
    }
    if (pendingQuickJoinRoomKey && !currentState) {
      awaitingQuickJoinName = true;
      statusLine = "QUICK JOIN REQUIRES NAME. ENTER NAME NOW.";
      refresh();
      return "";
    }
    term.writeln("Set name first: name <display-name>");
    return "";
  }

  function connectSocket() {
    if (!currentRoomKey) {
      return;
    }

    if (ws) {
      ws.close();
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/ws/${currentRoomKey}`);
    url.searchParams.set("pid", settings.participantId);
    url.searchParams.set("name", settings.name);

    ws = new WebSocket(url);

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "room_state") {
        currentState = message.state;
        refresh();
        return;
      }
      if (message.type === "system") {
        statusLine = message.message;
        refresh();
        return;
      }
      if (message.type === "error") {
        statusLine = `Error: ${message.message}`;
        refresh();
      }
    });

    ws.addEventListener("close", () => {
      if (currentRoomKey) {
        statusLine = "Socket closed. Run rejoin or join again.";
        refresh();
      }
    });
  }

  function send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (payload && typeof payload === "object" && "type" in payload) {
        term.writeln("Not connected.");
      }
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function render() {
    if (isRendering) {
      return;
    }

    isRendering = true;
    term.write("\x1b[2J\x1b[H");

    const lines = currentState ? roomView(currentState) : lobbyView();
    for (const line of lines) {
      term.writeln(line);
    }

    term.writeln("");
    term.writeln(statusLine);
    isRendering = false;
  }

  function refresh() {
    render();
    renderPrompt();
  }

  function lobbyView() {
    return [
      border(lobbyWidth),
      row("ESTIMATE SETUP UTILITY", lobbyWidth),
      border(lobbyWidth),
      row(`USER PROFILE ....... ${settings.name || "<UNSET>"}`, lobbyWidth),
      row(`LAST ROOM .......... ${settings.lastRoomName || "<NONE>"}`, lobbyWidth),
      row("", lobbyWidth),
      row("BOOT OPTIONS", lobbyWidth),
      row("  NAME <DISPLAY-NAME>", lobbyWidth),
      row("  JOIN <ROOM> <PASSWORD>", lobbyWidth),
      row("  REJOIN", lobbyWidth),
      row("  HELP", lobbyWidth),
      border(lobbyWidth),
    ];
  }

  function roomView(state) {
    const voteLine = state.numbers.join(" ");
    const users = state.participants
      .map((participant) => {
        const marker = participant.online ? "@" : "-";
        const vote = state.revealed ? (participant.vote ?? "-") : (participant.hasVoted ? "*" : ".");
        return `${marker} ${participant.name} [${vote}]`;
      });

    const average = state.summary.average === null ? "n/a" : String(state.summary.average);

    return [
      border(roomWidth),
      row(`ROOM : ${state.roomName}    PASSWORD : ${currentPassword()}`, roomWidth),
      row(`QUICK JOIN : ${currentQuickJoinLabel(state.roomName)} [CLICK TO COPY]`, roomWidth),
      row(`REVEAL : ${state.revealed ? "OPEN" : "HIDDEN"}    PARTICIPANTS : ${state.participants.length}`, roomWidth),
      row(`SYSTEM ESTIMATE : ${average}`, roomWidth),
      border(roomWidth),
      row(`VOTE ROM : ${voteLine}`, roomWidth),
      sectionBorder("ROOM BUS", roomWidth),
      ...users.map((line) => row(line, roomWidth)),
      row("", roomWidth),
      border(roomWidth),
      row("CONTROL BUS", roomWidth),
      row("  VOTE <VALUE>   REVEAL   CLEAR   LEAVE   ROOM   HELP", roomWidth),
      border(roomWidth),
    ];
  }

  function renderPrompt() {
    if (awaitingQuickJoinName) {
      promptLabel = "NAME> ";
    } else {
      promptLabel = currentState ? `${currentState.roomName}> ` : "> ";
    }
    promptCount += 1;
    term.write(`${promptLabel}${input}`);
  }

  function prefillCommand(value) {
    input = value;
    statusLine = `COMMAND LOADED: ${value}`;
    refresh();
  }

  function commandActions() {
    if (!currentState) {
      return [
        { label: "NAME", prefill: "name " },
        { label: "JOIN", prefill: "join " },
        { label: "REJOIN", run: "rejoin" },
        { label: "HELP", run: "help" },
      ];
    }

    return [
      { label: "VOTE <VALUE>", prefill: "vote " },
      { label: "REVEAL", run: "reveal" },
      { label: "CLEAR", run: "clear" },
      { label: "LEAVE", run: "leave" },
      { label: "ROOM", run: "room" },
      { label: "HELP", run: "help" },
    ];
  }

  function currentPassword() {
    if (currentState && currentState.id === settings.lastRoomKey && settings.lastRoomPassword) {
      return settings.lastRoomPassword;
    }

    return "<unknown>";
  }

  if (pendingQuickJoinRoomKey && settings.name) {
    void handleQuickJoin();
  } else if (pendingQuickJoinRoomKey) {
    awaitingQuickJoinName = true;
    statusLine = "QUICK JOIN LINK DETECTED. ENTER NAME TO BOOT ROOM.";
  }
}

function parseArgs(value) {
  const matches = value.match(/"([^"]+)"|'([^']+)'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ""));
}

function pad(value, width) {
  const safe = value.length > width ? `${value.slice(0, width - 3)}...` : value;
  return safe.padEnd(width, " ");
}

function border(width) {
  return `+${"-".repeat(width + 2)}+`;
}

function row(value, width) {
  return `| ${pad(value, width)} |`;
}

function sectionBorder(label, width) {
  const text = ` ${label} `;
  const total = width + 2;
  const left = Math.floor((total - text.length) / 2);
  const right = total - text.length - left;
  return `+${"-".repeat(left)}${text}${"-".repeat(right)}+`;
}

function currentQuickJoinUrl(roomKey) {
  return `${window.location.origin}${currentQuickJoinPath(roomKey)}`;
}

function currentQuickJoinLabel(roomName) {
  return `<${roomName}>`;
}

function currentQuickJoinPath(roomKey) {
  return `/${encodeURIComponent(roomKey)}`;
}

function parseQuickJoinRoomKey(pathname) {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  if (!path || path === "room") {
    return null;
  }

  return decodeURIComponent(path);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data.error) {
        message = data.error;
      }
    } catch {
      // ignore parse failure
    }
    throw new Error(message);
  }

  return response.json();
}

function loadSettings() {
  const raw = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${settingsCookie}=`))
    ?.split("=")[1];

  if (!raw) {
    return {
      name: "",
      participantId: crypto.randomUUID(),
      lastRoomKey: "",
      lastRoomName: "",
      lastRoomPassword: "",
    };
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return {
      name: parsed.name ?? "",
      participantId: parsed.participantId || crypto.randomUUID(),
      lastRoomKey: parsed.lastRoomKey ?? "",
      lastRoomName: parsed.lastRoomName ?? "",
      lastRoomPassword: parsed.lastRoomPassword ?? "",
    };
  } catch {
    return {
      name: "",
      participantId: crypto.randomUUID(),
      lastRoomKey: "",
      lastRoomName: "",
      lastRoomPassword: "",
    };
  }
}

function saveSettings(settings) {
  const value = encodeURIComponent(JSON.stringify(settings));
  document.cookie = `${settingsCookie}=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
}
