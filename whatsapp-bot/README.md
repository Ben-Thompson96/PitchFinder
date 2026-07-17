# PitchFinder — WhatsApp auto-poster 🤖

Posts the weekly 5-a-side slots as a **native WhatsApp poll** straight to your
group, so there's nothing to paste. It reads `../config.toml` (shared with the
Python app) but is otherwise standalone.

Heads up: this drives WhatsApp through an unofficial library (`@whiskeysockets/baileys`),
which is against WhatsApp's ToS. For a once-a-week personal poll the risk is low,
but it's your account. If you'd rather not, the Python script is the safe path.

## One-time setup

```
cd whatsapp-bot
npm install
```

Then find your group's id and put it in the config:

```
npm run groups
```

The first time, a QR code appears in the terminal — scan it with **WhatsApp →
Settings → Linked devices → Link a device**. It then prints all your groups and ids.

Copy the right id (looks like `120363...@g.us`) into `../config.toml`:

```toml
[whatsapp]
group_id = "120363012345678901@g.us"
```

The login is saved in `.baileys_auth/` (gitignored — it's your session, never
commit it), so you only scan the QR once.

## Test it on yourself first

Before posting to the group, send the poll to your own "Message yourself" chat.
`npm run groups` prints your own id at the top — or just use your number:

```
node post-poll.js --to 447911123456     # bare number = personal chat (your own = message yourself)
node post-poll.js --to 447911123456@s.whatsapp.net
```

`--to` overrides the group in config, so nothing lands in the group while you test.

## Each week

Check what it'll post first:

```
npm run dry-run      # prints the poll, posts nothing
```

Then post it for real:

```
npm start
```

It runs, posts the poll, and exits. No server needed — it only runs when you run it.

## Notes

- The poll allows **multiple answers**, so everyone can tick every slot they can make.
- WhatsApp polls cap at **12 options**; extra slots are dropped with a warning.
- If there are fewer than 2 free slots, it posts nothing (a poll needs 2+ options).
- If WhatsApp changes something and the library breaks, `npm update @whiskeysockets/baileys`
  for the latest usually fixes it — or just fall back to the Python script.
