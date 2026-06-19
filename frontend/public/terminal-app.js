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
    fontFamily: '"Fira Code", "Cascadia Code", monospace',
    fontSize: 15,
    lineHeight: 1.25,
    theme: {
      background: "#0b120b",
      foreground: "#8bff8b",
      cursor: "#8bff8b",
      selectionBackground: "rgba(139,255,139,0.25)",
      black: "#0b120b",
      green: "#8bff8b",
      brightGreen: "#c6ffc6",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(root);
  fitAddon.fit();

  const settings = loadSettings();
  let ws = null;
  let currentRoomKey = settings.lastRoomKey;
  let currentState = null;
  let input = "";
  let promptLabel = "> ";
  let promptCount = 0;
  let isRendering = false;
  let statusLine = "Type 'help' for commands.";

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
    term.writeln("ESTIMATE planning poker");
    term.writeln("Commands stay inside terminal. Rooms live in Durable Objects.");
    if (settings.name) {
      term.writeln(`Saved name: ${settings.name}`);
    }
    if (settings.lastRoomName && settings.lastRoomKey) {
      term.writeln(`Saved room: ${settings.lastRoomName} (${settings.lastRoomKey})`);
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
    term.writeln("help                        show commands");
    term.writeln("name <display-name>         save display name in cookie");
    term.writeln("join <room> <password>      join or auto-create room");
    term.writeln("rejoin                      join last saved room key");
    term.writeln("leave                       disconnect from current room");
    term.writeln("vote <value>                cast planning vote");
    term.writeln("reveal                      show all votes and overall estimate");
    term.writeln("clear                       reset revealed state and votes");
    term.writeln("room                        redraw room TUI");
    term.writeln("users                       alias for room");
  }

  function handleName(args) {
    const name = args.join(" ").trim();
    if (!name) {
      term.writeln("Usage: name <display-name>");
      return;
    }

    settings.name = name;
    saveSettings(settings);
    send({ type: "rename", name });
    term.writeln(`Name saved: ${name}`);
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
    refresh();
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
      row("ESTIMATE lobby", lobbyWidth),
      border(lobbyWidth),
      row(`name: ${settings.name || "<unset>"}`, lobbyWidth),
      row(`saved room: ${settings.lastRoomName || "<none>"}`, lobbyWidth),
      row("", lobbyWidth),
      row("Commands", lobbyWidth),
      row("  name <display-name>", lobbyWidth),
      row("  join <room> <password>", lobbyWidth),
      row("  rejoin", lobbyWidth),
      row("  help", lobbyWidth),
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
      })
      .slice(0, 10);

    while (users.length < 10) {
      users.push("");
    }

    const average = state.summary.average === null ? "n/a" : String(state.summary.average);

    return [
      border(roomWidth),
      row(`room: ${state.roomName}    password: ${currentPassword()}`, roomWidth),
      row(`reveal: ${state.revealed ? "open" : "hidden"}    participants: ${state.participants.length}`, roomWidth),
      row(`overall estimate: ${average}`, roomWidth),
      border(roomWidth),
      row(`votes: ${voteLine}`, roomWidth),
      sectionBorder("users", roomWidth),
      ...users.map((line) => row(line, roomWidth)),
      border(roomWidth),
      row("Commands", roomWidth),
      row("  vote <value>   reveal   clear   leave   room   help", roomWidth),
      border(roomWidth),
    ];
  }

  function renderPrompt() {
    promptLabel = currentState ? `${currentState.roomName}> ` : "> ";
    promptCount += 1;
    term.write(`${promptLabel}${input}`);
  }

  function currentPassword() {
    if (currentState && currentState.id === settings.lastRoomKey && settings.lastRoomPassword) {
      return settings.lastRoomPassword;
    }

    return "<unknown>";
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
