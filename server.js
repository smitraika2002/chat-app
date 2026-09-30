// server.js — the backend.
// Express serves the web page; Socket.IO sends messages back and forth in real time.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 100;       // how many recent messages new users get to see
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NAME_LENGTH = 20;
const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥"]; // the only emojis allowed as reactions

// Serve everything in the "public" folder (index.html, style.css, script.js, icons...)
app.use(express.static("public"));

// Everything lives in memory only — it disappears when the server restarts.
const history = [];   // recent messages
let nextMessageId = 1;

// Clean up text from users: make sure it's a string, trim spaces, cap its length.
// (The browser also displays text safely with textContent, so HTML can't be injected.)
function clean(text, maxLength) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, maxLength);
}

// Build the list of who's online right now (one entry per person, even with several tabs open)
function onlineUsers() {
  const users = new Map();
  for (const s of io.sockets.sockets.values()) {
    if (s.data.name) users.set(s.data.userId, { userId: s.data.userId, name: s.data.name });
  }
  return [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Is this person still connected in another tab?
function isStillOnline(userId) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId) return true;
  }
  return false;
}

// Runs every time a new browser connects
io.on("connection", (socket) => {
  // A user picked a name and joined the room.
  // userId is a random id the browser remembers, so "my messages" survive a reconnect.
  socket.on("join", (payload) => {
    const name = clean(payload && payload.name, MAX_NAME_LENGTH);
    const userId = clean(payload && payload.userId, 64);
    if (!name || !userId) return;

    const alreadyHere = isStillOnline(userId); // e.g. a second tab, or a quick reconnect
    socket.data.name = name;
    socket.data.userId = userId;

    // Send recent chat history to just this user
    socket.emit("history", history);

    if (!alreadyHere) socket.broadcast.emit("notice", `${name} joined the chat`);
    io.emit("users", onlineUsers());
  });

  // A user sent a chat message (optionally replying to an earlier one)
  socket.on("message", (payload) => {
    const { name, userId } = socket.data;
    const text = clean(payload && payload.text, MAX_MESSAGE_LENGTH);
    if (!name || !text) return; // ignore empty messages or users who haven't joined

    // If it's a reply, attach a short copy of the original message
    let replyTo = null;
    const original = history.find((m) => m.id === (payload && payload.replyTo));
    if (original) {
      replyTo = { id: original.id, name: original.name, text: original.text.slice(0, 120) };
    }

    const message = {
      id: nextMessageId++,
      userId,
      name,
      text,
      time: Date.now(),
      replyTo,
      reactions: {},        // e.g. { "❤️": ["userId1", "userId2"] }
    };

    // Save it and keep only the most recent messages
    history.push(message);
    if (history.length > MAX_HISTORY) history.shift();

    // Send it to everyone, including the sender
    io.emit("message", message);
  });

  // A user tapped a reaction: add it, or remove it if they already had it
  socket.on("react", (payload) => {
    const { userId } = socket.data;
    const emoji = payload && payload.emoji;
    const message = history.find((m) => m.id === (payload && payload.messageId));
    if (!userId || !message || !REACTIONS.includes(emoji)) return;

    const people = message.reactions[emoji] || [];
    if (people.includes(userId)) {
      message.reactions[emoji] = people.filter((id) => id !== userId);
      if (message.reactions[emoji].length === 0) delete message.reactions[emoji];
    } else {
      message.reactions[emoji] = [...people, userId];
    }

    io.emit("reactions", { messageId: message.id, reactions: message.reactions });
  });

  // Typing indicator: pass it along to everyone except the person typing
  socket.on("typing", (isTyping) => {
    if (!socket.data.name) return;
    socket.broadcast.emit("typing", { name: socket.data.name, isTyping: !!isTyping });
  });

  // User closed the tab or lost connection
  socket.on("disconnect", () => {
    const { name, userId } = socket.data;
    if (!name) return;
    socket.broadcast.emit("typing", { name, isTyping: false });
    if (!isStillOnline(userId)) socket.broadcast.emit("notice", `${name} left the chat`);
    io.emit("users", onlineUsers());
  });
});

server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
