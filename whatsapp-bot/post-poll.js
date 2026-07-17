/*
 * PitchFinder — WhatsApp auto-poster
 * ----------------------------------
 * Finds free 5-a-side slots for the coming week (same logic as ../pitchfinder.py)
 * and posts them as a native WhatsApp poll to your group.
 *
 * Modes:
 *   node post-poll.js --dry-run       Print the poll, don't touch WhatsApp.
 *   node post-poll.js --list-groups   List your groups + ids (to fill in config).
 *   node post-poll.js                 Post the poll to the group in config.toml.
 *
 * Shares ../config.toml with the Python app. This app is otherwise standalone.
 */

const fs = require("fs");
const path = require("path");
const TOML = require("@iarna/toml");
const qrcode = require("qrcode-terminal");
// Baileys is ESM-only, so it's loaded lazily via dynamic import() inside connect().

const CONFIG_PATH = path.join(__dirname, "..", "config.toml");
const API_URL = "https://hireapitch.com/venue/getBookingSlots";
const ALLOWED_HOURS_FALLBACK = [18, 19];
const MAX_POLL_OPTIONS = 12; // WhatsApp's hard limit.
const AUTH_DIR = path.join(__dirname, ".baileys_auth");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// --- Config -----------------------------------------------------------------

function loadConfig() {
  const config = TOML.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return {
    venues: config.venues,
    allowedHours: new Set(config.allowed_start_hours ?? ALLOWED_HOURS_FALLBACK),
    groupId: config.whatsapp?.group_id || "",
  };
}

// --- Which week to look at (mirrors pitchfinder.py) --------------------------

function comingWeek() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pyWeekday = (today.getDay() + 6) % 7;      // JS Sun=0 -> Python Mon=0
  const daysUntilMonday = (7 - pyWeekday) % 7;     // Mon->0, Tue->6, ... Sun->1
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMonday);
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);          // exclusive end, includes Friday
  return { monday, saturday };
}

// --- Talking to hireapitch --------------------------------------------------

function apiDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
}

async function fetchSlots(venue, start, end) {
  const body = new URLSearchParams({
    PlaceID: String(venue.place_id),
    Category: venue.category,
    start: apiDate(start),
    end: apiDate(end),
  });
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "PitchFinder (personal use)",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function freeEveningSlots(venue, slots, allowedHours) {
  const out = [];
  for (const slot of slots) {
    if (slot.id === 0) continue;                   // 0 == already booked
    const when = new Date(slot.start);             // naive ISO -> local time
    if ((when.getDay() + 6) % 7 > 4) continue;     // Mon–Fri only
    if (!allowedHours.has(when.getHours())) continue;
    out.push({ venue: venue.name, when, price: slot.title });
  }
  return out;
}

// --- Build the poll ---------------------------------------------------------

function formatOption(slot) {
  const w = slot.when;
  const date = `${w.getDate()} ${MONTHS[w.getMonth()]}`;
  const hour = w.getHours() % 12 || 12;
  const suffix = w.getHours() < 12 ? "am" : "pm";
  return `${DAYS[w.getDay()]} ${date} · ${hour}${suffix} · ${slot.venue} (${slot.price})`;
}

async function buildPoll() {
  const { venues, allowedHours, groupId } = loadConfig();
  const { monday, saturday } = comingWeek();

  let slots = [];
  for (const venue of venues) {
    const raw = await fetchSlots(venue, monday, saturday);
    slots.push(...freeEveningSlots(venue, raw, allowedHours));
  }
  slots.sort((a, b) => a.when - b.when || a.venue.localeCompare(b.venue));

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const label =
    `${monday.getDate()} ${MONTHS[monday.getMonth()]}–${friday.getDate()} ${MONTHS[friday.getMonth()]}`;
  const question = `⚽ 5-a-side — week of ${DAYS[monday.getDay()]} ${label}. Which slots work for you?`;

  let options = slots.map(formatOption);
  let trimmed = 0;
  if (options.length > MAX_POLL_OPTIONS) {
    trimmed = options.length - MAX_POLL_OPTIONS;
    options = options.slice(0, MAX_POLL_OPTIONS);
  }
  return { question, options, trimmed, groupId };
}

// --- Modes ------------------------------------------------------------------

// Baileys logs to stdout by default; a no-op logger keeps our output clean.
const silentLogger = {
  level: "silent",
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

// Connect (printing a QR to scan on first run), resolving with an open socket.
// Auth persists in AUTH_DIR, so subsequent runs reconnect silently.
async function connect() {
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    let settled = false;
    const start = () => {
      const sock = makeWASocket({
        version,
        auth: state,
        logger: silentLogger,
        browser: ["PitchFinder", "Chrome", "1.0"],
      });
      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("connection.update", (u) => {
        if (u.qr) {
          console.log("\nScan this with WhatsApp → Settings → Linked devices → Link a device:\n");
          qrcode.generate(u.qr, { small: true });
        }
        if (u.connection === "open") {
          if (!settled) { settled = true; resolve(sock); }
        } else if (u.connection === "close") {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.restartRequired) {
            start(); // expected once right after first pairing — reconnect with saved creds
          } else if (!settled) {
            settled = true;
            reject(new Error(code === DisconnectReason.loggedOut
              ? `Logged out. Delete ${AUTH_DIR} and re-run to scan a fresh QR.`
              : `Connection closed before ready (code ${code}).`));
          }
        }
      });
    };
    start();
  });
}

async function runDryRun() {
  const { question, options, trimmed } = await buildPoll();
  console.log(`\n${question}\n`);
  if (options.length < 2) {
    console.log("Fewer than 2 free slots — WhatsApp needs at least 2 poll options, so nothing to post.");
    return;
  }
  options.forEach((o, i) => console.log(`${i + 1}. ${o}`));
  if (trimmed) console.log(`\n⚠️  ${trimmed} extra slot(s) dropped — WhatsApp polls allow max ${MAX_POLL_OPTIONS}.`);
  console.log("\n(dry run — nothing was posted)");
}

async function runListGroups() {
  const sock = await connect();
  try {
    const self = sock.user?.id?.split(":")[0];
    if (self) console.log(`\nMessage yourself (handy for testing): ${self}@s.whatsapp.net`);
    const groups = Object.values(await sock.groupFetchAllParticipating());
    if (groups.length) {
      console.log("\nYour groups (copy the id into config.toml → [whatsapp] group_id):\n");
      for (const g of groups) console.log(`${g.id}   ${g.subject}`);
    } else {
      console.log("\nNo groups found on this account.");
    }
  } finally {
    sock.end(undefined);
    process.exit(0);
  }
}

async function runPost(destOverride, textOverride) {
  const { question, options, trimmed, groupId } = await buildPoll();
  const dest = destOverride || groupId;

  if (!dest) {
    console.error("No destination. Set [whatsapp] group_id in config.toml, or pass --to <id> " +
      "(e.g. --to 447911123456 to message yourself).");
    process.exit(1);
  }

  // --text sends a plain message instead of the poll (handy for diagnosing).
  let content;
  if (textOverride) {
    content = { text: textOverride };
  } else {
    if (options.length < 2) {
      console.log("Fewer than 2 free slots next week — nothing to post (a poll needs at least 2 options).");
      process.exit(0);
    }
    if (trimmed) console.log(`⚠️  ${trimmed} extra slot(s) dropped — WhatsApp polls allow max ${MAX_POLL_OPTIONS}.`);
    content = { poll: { name: question, values: options, selectableCount: 0 } }; // 0 = allow multiple
  }

  const sock = await connect();
  try {
    const sent = await sock.sendMessage(dest, content);
    console.log(`Sent to ${dest}${sent?.key?.id ? ` (id ${sent.key.id})` : ""}.`);
    await new Promise((r) => setTimeout(r, 1500)); // let the send flush before closing
  } catch (err) {
    console.error(`Send failed: ${err.message || err}`);
  } finally {
    sock.end(undefined);
    process.exit(0);
  }
}

// --- Entry point ------------------------------------------------------------

const args = process.argv.slice(2);

function argValue(name) {
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Accept a full jid (...@s.whatsapp.net / ...@g.us) or a bare phone number,
// which we treat as a personal chat.
function normalizeChatId(id) {
  if (!id || id.includes("@")) return id;
  return id.replace(/\D/g, "") + "@s.whatsapp.net";
}

if (args.includes("--dry-run")) {
  runDryRun();
} else if (args.includes("--list-groups")) {
  runListGroups();
} else {
  runPost(normalizeChatId(argValue("--to")), argValue("--text"));
}
