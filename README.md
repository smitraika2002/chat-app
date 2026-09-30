# Simple Chat

A real-time chat app with accounts, private chats and group chats. Messages and photos are saved permanently.

Built with Node.js + Express (hosting) and [Supabase](https://supabase.com) (accounts, database, real-time updates, photo storage).

## Features

- Sign up / log in with email + password and a unique username
- Chat list with the latest message, time and unread counts
- Private chats (search for a username) and group chats (name + members)
- Add people to a group, or leave it
- Messages and photos are saved permanently
- Emoji reactions and replies (tap any message)
- Send photos with 📷 (or paste / drag one in on a computer); tap a photo to view it full screen
- Typing indicator and online status (green dot)
- Sound (🔔 to mute) and notifications while the app is in the background
- Works on phones and computers, light and dark mode, installable to your home screen

## Setup

### 1. Supabase

1. Create a free project at supabase.com.
2. **Authentication → Sign In / Providers → Email**: turn off **Confirm email** (optional, but lets friends sign up instantly).
3. **SQL Editor → New query**: paste all of `supabase-setup.sql` and click **Run**.
4. From **Connect** (or **Project Settings → API Keys**), copy the **Project URL** and the **publishable** (or **anon / public**) key.

### 2. Render

In your Render service, go to **Environment** and add:

| Key | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_KEY` | your publishable key |

Build command: `npm install` · Start command: `npm start`

### Run locally

```
npm install
SUPABASE_URL=... SUPABASE_KEY=... npm start
```
Then open http://localhost:3000

## Files

- `server.js` – serves the app and passes the Supabase settings to the browser
- `supabase-setup.sql` – creates the database tables, security rules and photo storage
- `public/index.html` – the screens (login, chat list, chat, new chat)
- `public/style.css` – the look, including dark mode
- `public/script.js` – everything the app does in the browser
- `public/sw.js`, `public/manifest.json`, icons – home-screen app support

## Coming next

- Delete and edit messages, read receipts, profile pictures
- Swipe to reply, date dividers, long-press to copy, "jump to newest"
- Voice messages, link previews, search
- Push notifications when the app is closed
