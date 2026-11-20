const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");

const logsDir = path.join(process.env.LOCALAPPDATA, "Roblox", "logs");

// RakNet offline magic bytes used by Roblox game servers
const RAKNET_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

function getLatestLogFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({
      fullPath: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

function isPrivateOrLocalIp(ip) {
  return (
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("0.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

function extractServerTarget(content) {
  const pairRegex = /\b((?:\d{1,3}\.){3}\d{1,3})[:\s]+(\d{2,5})\b/g;
  let lastTarget = null;
  let match;

  while ((match = pairRegex.exec(content)) !== null) {
    const ip = match[1];
    const port = Number(match[2]);
    if (!isPrivateOrLocalIp(ip) && port >= 1024 && port <= 65535) {
      lastTarget = { ip, port };
    }
  }

  if (lastTarget) return lastTarget;

  const ipMatches = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  const publicIps = ipMatches.filter((ip) => !isPrivateOrLocalIp(ip));
  const fallbackIp = publicIps[publicIps.length - 1] || null;

  return fallbackIp ? { ip: fallbackIp, port: null } : null;
}

function extractGameIds(content) {
  let placeId = null;
  let universeId = null;

  const placePatterns = [
    /placeid[=:\s"]+([0-9]{4,})/gi,
    /"placeId"\s*:\s*"?([0-9]{4,})"?/gi,
    /place\/([0-9]{4,})/gi,
  ];
  for (const re of placePatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      placeId = m[1];
    }
  }

  const uniPatterns = [
    /universeid[=:\s"]+([0-9]{4,})/gi,
    /"universeId"\s*:\s*"?([0-9]{4,})"?/gi,
  ];
  for (const re of uniPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      universeId = m[1];
    }
  }

  return { placeId, universeId };
}

async function getGameName({ placeId, universeId }) {
  try {
    let resolvedUniverse = universeId;
    if (!resolvedUniverse && placeId) {
      const uniRes = await fetch(
        `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
      );
      if (uniRes.ok) {
        const uniData = await uniRes.json();
        resolvedUniverse = uniData.universeId || null;
      }
    }

    if (resolvedUniverse) {
      const gameRes = await fetch(
        `https://games.roblox.com/v1/games?universeIds=${resolvedUniverse}`
      );
      if (gameRes.ok) {
        const gameData = await gameRes.json();
        const name = gameData?.data?.[0]?.name;
        if (name) return name;
      }
    }
  } catch {}

  if (placeId) return `Place ${placeId}`;
  if (universeId) return `Universe ${universeId}`;
  return "No game ID in log";
}

function raknetPing(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);

    const sock = dgram.createSocket("udp4");
    const start = performance.now();
    let done = false;

    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      resolve(ms);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on("message", (msg) => {
      if (msg.length > 0 && (msg[0] === 0x1c || msg[0] === 0x01)) {
        finish(Math.max(1, Math.round(performance.now() - start)));
      }
    });

    sock.on("error", () => finish(null));

    const packet = Buffer.alloc(1 + 8 + RAKNET_MAGIC.length);
    packet[0] = 0x01;
    packet.writeBigUInt64BE(BigInt(Date.now()), 1);
    RAKNET_MAGIC.copy(packet, 9);

    sock.send(packet, port, host, (err) => {
      if (err) finish(null);
    });
  });
}

async function measurePing(serverIp, loggedPort) {
  const rakMs = await raknetPing(serverIp, loggedPort, 400);
  if (rakMs !== null) {
    return `${rakMs} ms (UDP)`;
  }
  return "check it urself lil bro";
}

ipcMain.handle("get-server", async () => {
  const latest = getLatestLogFile(logsDir);
  if (!latest) return { ip: "No log found", game: "Unknown", ping: "-" };

  const content = fs.readFileSync(latest.fullPath, "utf8");
  const target = extractServerTarget(content);
  if (!target?.ip) {
    return { ip: "No server IP yet", game: "Unknown", ping: "-" };
  }

  const ids = extractGameIds(content);

  const [geoRes, gameName, ping] = await Promise.all([
    fetch(`https://ipinfo.io/${target.ip}/json`)
      .then((r) => r.json())
      .catch(() => ({})),
    getGameName(ids),
    measurePing(target.ip, target.port),
  ]);

  return {
    ip: geoRes.ip || target.ip,
    game: gameName,
    ping,
    city: geoRes.city || "Unknown",
    region: geoRes.region || "Unknown",
    country: geoRes.country || "Unknown",
    org: geoRes.org || "Unknown",
  };
});

let win;
let isPinned = true;

function applyPinState() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(isPinned, "pop-up-menu");
  if (isPinned) {
    win.moveTop();
  }
}

ipcMain.on("win-action", (_, action) => {
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
  if (action === "close") win.close();
});

ipcMain.handle("toggle-pin", () => {
  isPinned = !isPinned;
  applyPinState();
  return isPinned;
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 420,
    height: 465,
    resizable: false,
    maximizable: false,
    frame: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  applyPinState();

  setInterval(() => {
    if (isPinned && win && !win.isDestroyed() && !win.isMinimized()) {
      win.setAlwaysOnTop(true, "pop-up-menu");
      win.moveTop();
    }
  }, 800);

  win.loadFile("index.html");
});