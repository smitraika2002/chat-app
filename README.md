# Simple Chat

A minimal real-time chat app built with Node.js, Express, and Socket.IO.

## Run it locally

1. Install Node.js (version 18 or newer) from https://nodejs.org
2. Open a terminal in this `chat-app` folder
3. Install the dependencies:
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
5. Open http://localhost:3000 in your browser
6. To test chatting, open a second browser tab (or a private window) and join with a different name

To chat from your phone on the same Wi-Fi, open `http://YOUR-COMPUTER-IP:3000` on the phone.

## Files

- `server.js` – the backend: serves the page and relays messages
- `public/index.html` – the page layout (join screen + chat screen)
- `public/style.css` – the look, including dark mode
- `public/script.js` – the browser logic: joining, sending, typing indicator

## Ideas for next features

- Multiple rooms (Socket.IO has built-in rooms)
- A sidebar showing who's online
- Save messages in a database (SQLite or MongoDB) so they survive restarts
- Emoji reactions on messages
- Image uploads
- Read receipts ("Seen")
- Deploy it online (Render, Railway, or Fly.io) so friends can join from anywhere
