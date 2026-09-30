// script.js — runs in the browser. Handles the screens, sending, and showing messages.

const socket = io(); // connect to the server

// Grab the page elements we need
const joinScreen = document.getElementById("join-screen");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name-input");
const chatScreen = document.getElementById("chat-screen");
const meLabel = document.getElementById("me-label");
const messagesEl = document.getElementById("messages");
const typingEl = document.getElementById("typing");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendButton = messageForm.querySelector("button");

let myName = "";
const typers = new Set(); // names of people currently typing

// ---------- Joining ----------
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  myName = name;
  socket.emit("join", name);

  joinScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  meLabel.textContent = `You are ${name}`;
  updateSendButton();
  messageInput.focus();
});

// If the connection drops and comes back, re-join automatically
socket.on("connect", () => {
  if (myName) socket.emit("join", myName);
});

// ---------- Sending ----------
messageForm.addEventListener("submit", (e) => {
  e.preventDefault(); // Enter key submits the form
  const text = messageInput.value.trim();
  if (!text) return;  // don't send empty messages

  socket.emit("message", text);
  messageInput.value = "";
  updateSendButton();
  stopTyping();
});

// Grey out the send button when the box is empty
function updateSendButton() {
  sendButton.disabled = messageInput.value.trim() === "";
}

// ---------- Typing indicator ----------
let typingTimer = null;
let isTyping = false;

messageInput.addEventListener("input", () => {
  updateSendButton();

  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", true);
  }
  // Stop "typing" after 1.5 seconds of no keystrokes
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
});

function stopTyping() {
  clearTimeout(typingTimer);
  if (isTyping) {
    isTyping = false;
    socket.emit("typing", false);
  }
}

socket.on("typing", ({ name, isTyping }) => {
  if (isTyping) typers.add(name);
  else typers.delete(name);
  renderTyping();
});

function renderTyping() {
  const names = [...typers];
  if (names.length === 0) typingEl.textContent = "";
  else if (names.length === 1) typingEl.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) typingEl.textContent = `${names[0]} and ${names[1]} are typing…`;
  else typingEl.textContent = "Several people are typing…";
}

// ---------- Receiving ----------
socket.on("history", (messages) => {
  messagesEl.innerHTML = "";
  messages.forEach(addMessage);
  scrollToBottom();
});

socket.on("message", (msg) => {
  typers.delete(msg.name); // they sent it, so they're done typing
  renderTyping();
  addMessage(msg);
  scrollToBottom();
});

socket.on("notice", (text) => {
  addNotice(text);
  scrollToBottom();
});

// Build one message on the page.
// We use textContent (never innerHTML) for user text, so nobody can inject HTML/scripts.
function addMessage(msg) {
  const wrapper = document.createElement("div");
  wrapper.className = "msg" + (msg.id === socket.id ? " mine" : "");

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = msg.name;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = msg.text;

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTime(msg.time);

  wrapper.append(name, bubble, time);
  messagesEl.appendChild(wrapper);
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  messagesEl.appendChild(el);
}

// Turn a timestamp into something like "5:42 PM"
function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
