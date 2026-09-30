// script.js — runs in the browser. Handles the screens, sending, and showing messages.

const socket = io(); // connect to the server

// Register the service worker so the app can be installed and show notifications
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- Small helpers ----------

// Save/load settings in the browser. Wrapped in try/catch because some private modes block storage.
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// A random id for this browser, remembered so "my messages" stay mine after a reconnect
let myUserId = load("chat-user-id");
if (!myUserId) {
  myUserId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  save("chat-user-id", myUserId);
}

const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];
const GROUP_WINDOW = 5 * 60 * 1000; // messages within 5 minutes from the same person are grouped
const AVATAR_COLORS = ["#ff6b6b", "#f59f00", "#37b24d", "#1c7ed6", "#7048e8", "#d6336c", "#0ca678", "#e8590c"];

// Pick the same color for the same name every time
function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function makeAvatar(name) {
  const el = document.createElement("div");
  el.className = "avatar";
  el.style.background = colorFor(name);
  el.textContent = [...name][0].toUpperCase(); // first letter (works with emoji too)
  return el;
}

// Turn a timestamp into something like "5:42 PM"
function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------- Grab the page elements we need ----------
const $ = (id) => document.getElementById(id);
const joinScreen = $("join-screen");
const joinForm = $("join-form");
const nameInput = $("name-input");
const chatScreen = $("chat-screen");
const messagesEl = $("messages");
const typingEl = $("typing");
const messageForm = $("message-form");
const messageInput = $("message-input");
const sendButton = messageForm.querySelector("button");
const onlineButton = $("online-button");
const onlineCount = $("online-count");
const onlinePanel = $("online-panel");
const onlineList = $("online-list");
const soundButton = $("sound-button");
const notifyButton = $("notify-button");
const replyBar = $("reply-bar");
const replyBarName = $("reply-bar-name");
const replyBarPreview = $("reply-bar-preview");
const replyCancel = $("reply-cancel");
const menu = $("message-menu");
const menuEmojis = $("menu-emojis");
const menuReply = $("menu-reply");

let myName = "";
const typers = new Set();        // names of people currently typing
const messages = new Map();      // message id -> message data
const rows = new Map();          // message id -> its row on the page
let replyingTo = null;           // id of the message we're replying to
let menuFor = null;              // id of the message the pop-up menu is open for

// Remember the last name used
nameInput.value = load("chat-name") || "";

// ---------- Joining ----------
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  myName = name;
  save("chat-name", name);
  socket.emit("join", { name, userId: myUserId });

  joinScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  updateSendButton();
  messageInput.focus();

  unlockSound();          // browsers only allow sound after you've tapped something
  setupNotifications(true);
});

// If the connection drops and comes back, re-join automatically
socket.on("connect", () => {
  if (myName) socket.emit("join", { name: myName, userId: myUserId });
});

// ---------- Sending ----------
messageForm.addEventListener("submit", (e) => {
  e.preventDefault(); // Enter key submits the form
  const text = messageInput.value.trim();
  if (!text) return;  // don't send empty messages

  socket.emit("message", { text, replyTo: replyingTo });
  messageInput.value = "";
  cancelReply();
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
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  messages.clear();
  rows.clear();
  list.forEach(addMessage);
  scrollToBottom();
});

socket.on("message", (msg) => {
  const stick = isNearBottom() || msg.userId === myUserId;
  typers.delete(msg.name); // they sent it, so they're done typing
  renderTyping();
  addMessage(msg);
  if (stick) scrollToBottom();

  if (msg.userId !== myUserId) {
    playDing();
    notifyNewMessage(msg);
  }
});

socket.on("notice", (text) => {
  const stick = isNearBottom();
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  messagesEl.appendChild(el);
  if (stick) scrollToBottom();
});

socket.on("reactions", ({ messageId, reactions }) => {
  const msg = messages.get(messageId);
  if (!msg) return;
  const stick = isNearBottom();
  msg.reactions = reactions;
  renderReactions(messageId);
  if (menuFor === messageId) markPickedEmojis();
  if (stick) scrollToBottom();
});

// Build one message on the page.
// We use textContent (never innerHTML) for user text, so nobody can inject HTML/scripts.
function addMessage(msg) {
  messages.set(msg.id, msg);

  const row = document.createElement("div");
  row.className = "row" + (msg.userId === myUserId ? " mine" : "");
  row.dataset.userId = msg.userId;
  row.dataset.time = msg.time;

  // Group with the previous message if it's the same person, a few minutes apart
  const prev = messagesEl.lastElementChild;
  if (prev && prev.classList.contains("row") &&
      prev.dataset.userId === msg.userId &&
      msg.time - Number(prev.dataset.time) < GROUP_WINDOW) {
    row.classList.add("continued");
    prev.classList.add("has-next");
  }

  const body = document.createElement("div");
  body.className = "body";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = msg.name;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // If this is a reply, show the quoted message first
  if (msg.replyTo) {
    const quote = document.createElement("div");
    quote.className = "quote";
    const qName = document.createElement("div");
    qName.className = "quote-name";
    qName.textContent = msg.replyTo.name;
    const qText = document.createElement("div");
    qText.className = "quote-text";
    qText.textContent = msg.replyTo.text;
    quote.append(qName, qText);
    quote.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpTo(msg.replyTo.id);
    });
    bubble.appendChild(quote);
  }

  const text = document.createElement("div");
  text.textContent = msg.text;
  bubble.appendChild(text);

  // Tap a message to react or reply
  bubble.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(msg.id, bubble);
  });

  const reactions = document.createElement("div");
  reactions.className = "reactions";

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTime(msg.time);

  body.append(name, bubble, reactions, time);
  row.append(makeAvatar(msg.name), body);
  messagesEl.appendChild(row);
  rows.set(msg.id, row);

  renderReactions(msg.id);
}

// Show the little "❤️ 2" chips under a message
function renderReactions(id) {
  const msg = messages.get(id);
  const row = rows.get(id);
  if (!msg || !row) return;

  const box = row.querySelector(".reactions");
  box.innerHTML = "";
  for (const emoji of REACTIONS) {
    const people = (msg.reactions && msg.reactions[emoji]) || [];
    if (people.length === 0) continue;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (people.includes(myUserId) ? " mine" : "");
    chip.textContent = `${emoji} ${people.length}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      socket.emit("react", { messageId: id, emoji }); // tap a chip to add/remove your reaction
    });
    box.appendChild(chip);
  }
}

// Scroll to a message (used when tapping a quoted reply) and flash it
function jumpTo(id) {
  const row = rows.get(id);
  if (!row) return; // too old, no longer in history
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation
  row.classList.add("flash");
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Pop-up menu: react or reply ----------
REACTIONS.forEach((emoji) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emoji;
  b.dataset.emoji = emoji;
  b.addEventListener("click", () => {
    socket.emit("react", { messageId: menuFor, emoji });
    closeMenu();
  });
  menuEmojis.appendChild(b);
});

menuReply.addEventListener("click", () => {
  startReply(menuFor);
  closeMenu();
});

function openMenu(id, bubble) {
  menuFor = id;
  markPickedEmojis();
  menu.classList.remove("hidden");

  // Place the menu just above the message (or below if there's no room), inside the screen
  const b = bubble.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const margin = 8;
  let top = b.top - m.height - margin;
  if (top < 60) top = b.bottom + margin;
  let left = rows.get(id).classList.contains("mine") ? b.right - m.width : b.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - m.width - margin));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function closeMenu() {
  menu.classList.add("hidden");
  menuFor = null;
}

// Highlight the emojis I've already used on this message
function markPickedEmojis() {
  const msg = messages.get(menuFor);
  for (const b of menuEmojis.children) {
    const people = (msg && msg.reactions && msg.reactions[b.dataset.emoji]) || [];
    b.classList.toggle("picked", people.includes(myUserId));
  }
}

// Close pop-ups when tapping elsewhere, scrolling, or pressing Escape
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target)) closeMenu();
  if (!onlinePanel.contains(e.target) && !onlineButton.contains(e.target)) {
    onlinePanel.classList.add("hidden");
  }
});
messagesEl.addEventListener("scroll", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenu();
    cancelReply();
    onlinePanel.classList.add("hidden");
  }
});

// ---------- Replying ----------
function startReply(id) {
  const msg = messages.get(id);
  if (!msg) return;
  replyingTo = id;
  replyBarName.textContent = `Replying to ${msg.userId === myUserId ? "yourself" : msg.name}`;
  replyBarPreview.textContent = msg.text;
  replyBar.classList.remove("hidden");
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  replyBar.classList.add("hidden");
}
replyCancel.addEventListener("click", cancelReply);

// ---------- Who's online ----------
socket.on("users", (users) => {
  onlineCount.textContent = `${users.length} online`;
  onlineList.innerHTML = "";
  for (const user of users) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = user.name;
    li.append(makeAvatar(user.name), label);
    if (user.userId === myUserId) {
      const you = document.createElement("span");
      you.className = "you";
      you.textContent = "(you)";
      li.appendChild(you);
    }
    onlineList.appendChild(li);
  }
});

onlineButton.addEventListener("click", (e) => {
  e.stopPropagation();
  onlinePanel.classList.toggle("hidden");
});

// ---------- Sound ----------
// The "ding" is made with the Web Audio API, so there's no sound file to download.
let soundOn = load("chat-sound") !== "off";
let audio = null;

function updateSoundButton() {
  soundButton.textContent = soundOn ? "🔔" : "🔕";
  soundButton.title = soundOn ? "Sound on (tap to mute)" : "Sound off (tap to unmute)";
}
updateSoundButton();

soundButton.addEventListener("click", () => {
  soundOn = !soundOn;
  save("chat-sound", soundOn ? "on" : "off");
  updateSoundButton();
  unlockSound();
  if (soundOn) playDing();
});

function unlockSound() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!audio) audio = new AudioCtx();
  if (audio.state === "suspended") audio.resume();
}

function playDing() {
  if (!soundOn || !audio) return;
  const now = audio.currentTime;
  // Two quick soft notes, like a message tone
  [[880, 0], [1320, 0.09]].forEach(([freq, delay]) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + delay);
    gain.gain.exponentialRampToValueAtTime(0.2, now + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + delay);
    osc.stop(now + delay + 0.3);
  });
}

// ---------- Notifications ----------
// Shows a notification when a message arrives while the app is in the background.
// (This works while the page is still open in the background. Once the phone fully
// closes the app, the server has no way to reach it without "push" notifications.)
const canNotify = "Notification" in window;

function setupNotifications(askNow) {
  if (!canNotify) return;
  if (Notification.permission === "default") {
    notifyButton.classList.remove("hidden");
    if (askNow) Notification.requestPermission().then(updateNotifyButton);
  }
  updateNotifyButton();
}

function updateNotifyButton() {
  const show = canNotify && Notification.permission === "default";
  notifyButton.classList.toggle("hidden", !show);
}

notifyButton.addEventListener("click", () => {
  Notification.requestPermission().then(updateNotifyButton);
});

let unread = 0;

function notifyNewMessage(msg) {
  if (!document.hidden) return; // you're looking at the chat already

  // Show the unread count in the browser tab: "(3) Simple Chat"
  unread++;
  document.title = `(${unread}) Simple Chat`;

  if (!canNotify || Notification.permission !== "granted") return;
  const options = { body: msg.text, icon: "icon-192.png", badge: "icon-192.png", tag: "chat", renotify: true };

  // Phones need the service worker to show notifications; computers can do it directly
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(msg.name, options))
      .catch(() => { try { new Notification(msg.name, options); } catch {} });
  } else {
    try { new Notification(msg.name, options); } catch {}
  }
}

// Clear the unread count when you come back to the chat
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unread = 0;
    document.title = "Simple Chat";
  }
});
