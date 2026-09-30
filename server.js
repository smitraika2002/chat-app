// server.js — the backend.
// Express serves the web page; Socket.IO sends messages back and forth in real time.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 50;        // how many recent messages new users get to see
const MAX_MESSAGE_LENGTH = 500;
const MAX_NAME_LENGTH = 20;

// Serve everything in the "public" folder (index.html, style.css, script.js)
app.use(express.static("public"));

// Messages live in memory only — they disappear when the server restarts.
const history = [];

// Clean up text from users: make sure it's a string, trim spaces, cap its length.
// (The browser also displays text safely with textContent, so HTML can't be injected.)
function clean(text, maxLength) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, maxLength);
}

// Runs every time a new browser connects
io.on("connection", (socket) => {
  // A user picked a name and joined the room
  socket.on("join", (rawName) => {
    const name = clean(rawName, MAX_NAME_LENGTH);
    if (!name) return;

    socket.data.name = name;

    // Send recent chat history to just this user
    socket.emit("history", history);

    // Tell everyone else that this user joined
    socket.broadcast.emit("notice", `${name} joined the chat`);
  });

  // A user sent a chat message
  socket.on("message", (rawText) => {
    const name = socket.data.name;
    const text = clean(rawText, MAX_MESSAGE_LENGTH);
    if (!name || !text) return; // ignore empty messages or users who haven't joined

    const message = {
      id: socket.id,          // lets the browser tell "my" messages from others
      name,
      text,
      time: Date.now(),
    };

    // Save it and keep only the most recent messages
    history.push(message);
    if (history.length > MAX_HISTORY) history.shift();

    // Send it to everyone, including the sender
    io.emit("message", message);
  });

  // Typing indicator: pass it along to everyone except the person typing
  socket.on("typing", (isTyping) => {
    if (!socket.data.name) return;
    socket.broadcast.emit("typing", { name: socket.data.name, isTyping: !!isTyping });
  });

  // User closed the tab or lost connection
  socket.on("disconnect", () => {
    const name = socket.data.name;
    if (!name) return;
    socket.broadcast.emit("typing", { name, isTyping: false });
    socket.broadcast.emit("notice", `${name} left the chat`);
  });
});

server.listen(PORT, () => {
  console.log(`Chat app running at http://localhost:${PORT}`);
});
