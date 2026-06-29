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
const { Client, LocalAuth, Poll } = require("whatsapp-web.js");

const CONFIG_PATH = path.join(__dirname, "..", "config.toml");
const API_URL = "https://hireapitch.com/venue/getBookingSlots";
const ALLOWED_HOURS_FALLBACK = [18, 19];
const MAX_POLL_OPTIONS = 12; // WhatsApp's hard limit.

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

function makeClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wwebjs_auth") }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });
}

function attachQr(client) {
  client.on("qr", (qr) => {
    console.log("\nScan this with WhatsApp → Settings → Linked devices → Link a device:\n");
    qrcode.generate(qr, { small: true });
  });
}

// Resolve with the ack level once WhatsApp's server confirms the message
// (ack >= 1 = single tick / server received), or 0 if nothing arrives in time.
// Without this we'd destroy the client before the message actually flushes.
function waitForServerAck(client, sent, timeoutMs) {
  return new Promise((resolve) => {
    const target = sent.id._serialized;
    const onAck = (msg, ack) => {
      if (msg.id._serialized === target && ack >= 1) {
        client.removeListener("message_ack", onAck);
        clearTimeout(timer);
        resolve(ack);
      }
    };
    const timer = setTimeout(() => {
      client.removeListener("message_ack", onAck);
      resolve(0);
    }, timeoutMs);
    client.on("message_ack", onAck);
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

function runListGroups() {
  const client = makeClient();
  attachQr(client);
  client.on("ready", async () => {
    console.log(`\nMessage yourself (handy for testing): ${client.info.wid._serialized}`);
    await new Promise((r) => setTimeout(r, 4000)); // give WhatsApp Web a moment to sync chats
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (groups.length) {
      console.log("\nYour groups (copy the id into config.toml → [whatsapp] group_id):\n");
      for (const chat of groups) console.log(`${chat.id._serialized}   ${chat.name}`);
    } else {
      console.log("\nNo groups loaded (WhatsApp Web only syncs recent chats up front).");
      console.log("Run `npm run find-group` instead, then send a message in the group.");
    }
    await client.destroy();
    process.exit(0);
  });
  client.initialize();
}

// Reliable fallback: print the id of any group you send a message in.
function runFindGroup() {
  const client = makeClient();
  attachQr(client);
  const seen = new Set();
  client.on("ready", () => {
    console.log("\nConnected. Now open your group on your phone and send any message (e.g. \"hi\").");
    console.log("The group's id will appear below. Press Ctrl+C once you've copied it.\n");
  });
  const handler = async (msg) => {
    try {
      const chat = await msg.getChat();
      if (chat.isGroup && !seen.has(chat.id._serialized)) {
        seen.add(chat.id._serialized);
        console.log(`${chat.id._serialized}   ${chat.name}`);
      }
    } catch {}
  };
  client.on("message", handler);        // someone else's message
  client.on("message_create", handler); // your own message (incl. from your phone)
  client.initialize();
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
    content = textOverride;
  } else {
    if (options.length < 2) {
      console.log("Fewer than 2 free slots next week — nothing to post (a poll needs at least 2 options).");
      process.exit(0);
    }
    if (trimmed) console.log(`⚠️  ${trimmed} extra slot(s) dropped — WhatsApp polls allow max ${MAX_POLL_OPTIONS}.`);
    content = new Poll(question, options, { allowMultipleAnswers: true });
  }

  const client = makeClient();
  attachQr(client);
  client.on("ready", async () => {
    try {
      const sent = await client.sendMessage(dest, content);
      const ack = await waitForServerAck(client, sent, 20000);
      if (ack >= 1) {
        console.log(`Sent to ${dest} — confirmed by server (ack=${ack}).`);
      } else {
        console.log(`⚠️  Sent to ${dest} but got NO server confirmation in 20s — it likely didn't go through.`);
      }
    } catch (err) {
      console.error(`Send failed: ${err.message || err}`);
    } finally {
      await client.destroy();
      process.exit(0);
    }
  });
  client.initialize();
}

// --- Entry point ------------------------------------------------------------

const args = process.argv.slice(2);

function argValue(name) {
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Accept a full chat id (...@c.us / ...@g.us) or a bare phone number, which we
// treat as a personal chat.
function normalizeChatId(id) {
  if (!id || id.includes("@")) return id;
  return id.replace(/\D/g, "") + "@c.us";
}

if (args.includes("--dry-run")) {
  runDryRun();
} else if (args.includes("--list-groups")) {
  runListGroups();
} else if (args.includes("--find-group")) {
  runFindGroup();
} else {
  runPost(normalizeChatId(argValue("--to")), argValue("--text"));
}
