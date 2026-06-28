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
    const chats = await client.getChats();
    console.log("\nYour groups (copy the id into config.toml → [whatsapp] group_id):\n");
    for (const chat of chats.filter((c) => c.isGroup)) {
      console.log(`${chat.id._serialized}   ${chat.name}`);
    }
    await client.destroy();
    process.exit(0);
  });
  client.initialize();
}

async function runPost(destOverride) {
  const { question, options, trimmed, groupId } = await buildPoll();
  const dest = destOverride || groupId;

  if (!dest) {
    console.error("No destination. Set [whatsapp] group_id in config.toml, or pass --to <id> " +
      "(e.g. --to 447911123456 to message yourself).");
    process.exit(1);
  }
  if (options.length < 2) {
    console.log("Fewer than 2 free slots next week — nothing to post (a poll needs at least 2 options).");
    process.exit(0);
  }
  if (trimmed) console.log(`⚠️  ${trimmed} extra slot(s) dropped — WhatsApp polls allow max ${MAX_POLL_OPTIONS}.`);

  const client = makeClient();
  attachQr(client);
  client.on("ready", async () => {
    const poll = new Poll(question, options, { allowMultipleAnswers: true });
    await client.sendMessage(dest, poll);
    console.log(`Posted poll with ${options.length} option(s) to ${dest}.`);
    await client.destroy();
    process.exit(0);
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
} else {
  runPost(normalizeChatId(argValue("--to")));
}
