// script.js — runs in the browser. The whole app: login, chat list, chats, photos, reactions...
// Supabase (our database + login + real-time service) does the storing and syncing.

// =====================================================================
// 1. Setup
// =====================================================================

const config = window.CHAT_CONFIG || {};
const $ = (id) => document.getElementById(id);

// If the Supabase keys are missing, explain it instead of showing a blank screen
if (!config.url || !config.key || !window.supabase) {
  $("loading-screen").innerHTML =
    '<div class="card auth-card"><h1>⚙️ Almost there</h1>' +
    "<p>The app can't reach Supabase yet. Add <b>SUPABASE_URL</b> and <b>SUPABASE_KEY</b> " +
    "in Render → your service → <b>Environment</b>, then redeploy.</p></div>";
  throw new Error("Missing Supabase settings");
}

const db = window.supabase.createClient(config.url, config.key);

// Register the service worker so the app can be installed and show notifications
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];
const GROUP_WINDOW = 5 * 60 * 1000;   // messages within 5 minutes from the same person are grouped
const MESSAGES_TO_LOAD = 200;         // how many recent messages to show when opening a chat
const PHOTO_BUCKET = "chat-photos";
const AVATAR_COLORS = ["#ff6b6b", "#f59f00", "#37b24d", "#1c7ed6", "#7048e8", "#d6336c", "#0ca678", "#e8590c"];

// ---------- App state ----------
let me = null;                      // { id, username }
const profiles = new Map();         // user id -> { id, username, avatar_url }
let chats = [];                     // chat list (from the my_chats function)
let currentChatId = null;           // the chat that's open
let currentMembers = [];            // user ids in the open chat
const messages = new Map();         // message id -> message (open chat only)
const rows = new Map();             // message id -> its row on the page
const seenMessageIds = new Set();   // so we never handle the same new message twice
const photoUrls = new Map();        // photo path -> web address we can show
let onlineIds = new Set();          // user ids online right now
let replyingTo = null;              // id of the message we're replying to
let menuFor = null;                 // id of the message the pop-up menu is open for
let pendingImage = null;            // { blob, preview } photo chosen but not sent yet
let stuckToBottom = true;           // is the chat scrolled to the newest message?
let typingChannel = null;           // real-time channel for "is typing" in the open chat

// =====================================================================
// 2. Small helpers
// =====================================================================

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), 3500);
}

// Pick the same color for the same name every time
function colorFor(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function nameOf(userId) {
  const p = profiles.get(userId);
  return p ? p.username : "Someone";
}

// A colored circle with a person's first letter (or 👥 for groups)
function makeAvatar(userId, size = "") {
  const el = document.createElement("div");
  const name = nameOf(userId);
  el.className = "avatar " + size;
  el.style.background = colorFor(name);
  el.textContent = [...name][0].toUpperCase();
  if (onlineIds.has(userId) && userId !== (me && me.id)) el.classList.add("online");
  return el;
}

function makeGroupAvatar(chat, size = "") {
  const el = document.createElement("div");
  el.className = "avatar group " + size;
  el.style.background = colorFor(chat.name || "group");
  el.textContent = "👥";
  return el;
}

function chatAvatar(chat, size) {
  return chat.is_group ? makeGroupAvatar(chat, size) : makeAvatar(chat.other_user_id, size);
}

function chatTitle(chat) {
  if (chat.is_group) return chat.name || "Group";
  return chat.other_user_id ? nameOf(chat.other_user_id) : "Just you";
}

// "5:42 PM"
function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Chat list times: "5:42 PM", "Yesterday", "Tue", or "9/14/26"
function formatListTime(date) {
  const d = new Date(date);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  if (d >= startOfToday) return formatTime(d);
  if (d >= startOfToday - dayMs) return "Yesterday";
  if (d >= startOfToday - 6 * dayMs) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
}

// Make Supabase errors readable
function friendlyError(error) {
  const msg = (error && error.message) || String(error);
  if (/Invalid login credentials/i.test(msg)) return "Wrong email or password.";
  if (/already registered/i.test(msg)) return "An account with this email already exists. Try logging in.";
  if (/Database error saving new user/i.test(msg)) return "That username is taken. Try another one.";
  if (/Password should be/i.test(msg)) return "Password must be at least 6 characters.";
  if (/Email not confirmed/i.test(msg)) return "Please confirm your email first (check your inbox).";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Can't connect. Check your internet and try again.";
  if (/rate limit/i.test(msg)) return "Too many tries. Please wait a minute and try again.";
  return msg;
}

// Load any profiles we don't have yet (so we can show usernames)
async function ensureProfiles(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !profiles.has(id));
  if (missing.length === 0) return;
  const { data, error } = await db.from("profiles").select("id, username, avatar_url").in("id", missing);
  if (error) return console.error(error);
  data.forEach((p) => profiles.set(p.id, p));
}

// =====================================================================
// 3. Log in / Sign up
// =====================================================================

let authMode = "login";

document.querySelectorAll("#auth-form .tab").forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.mode));
});

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("#auth-form .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  document.querySelectorAll(".signup-only").forEach((el) => el.classList.toggle("hidden", mode !== "signup"));
  $("auth-submit").textContent = mode === "signup" ? "Create account" : "Log in";
  $("auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  hide($("auth-error"));
}

function authError(text, isGood = false) {
  $("auth-error").textContent = text;
  $("auth-error").classList.toggle("success", isGood);
  show($("auth-error"));
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("auth-error"));
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const username = $("auth-username").value.trim();

  if (!email || !password) return authError("Enter your email and password.");

  const button = $("auth-submit");
  button.disabled = true;
  try {
    if (authMode === "signup") {
      if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) {
        return authError("Username must be 3–20 letters, numbers, _ or . (no spaces).");
      }
      if (password.length < 6) return authError("Password must be at least 6 characters.");

      const { data: free, error: checkError } = await db.rpc("username_available", { name: username });
      if (checkError) throw checkError;
      if (!free) return authError("That username is taken. Try another one.");

      const { data, error } = await db.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw error;
      if (!data.session) {
        // Email confirmation is turned on in Supabase
        setAuthMode("login");
        return authError("Account created! Check your email to confirm it, then log in.", true);
      }
      await enterApp(data.session.user);
    } else {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await enterApp(data.user);
    }
  } catch (err) {
    authError(friendlyError(err));
  } finally {
    button.disabled = false;
  }
});

$("logout-button").addEventListener("click", async () => {
  await db.auth.signOut();
  location.reload(); // start fresh
});

// =====================================================================
// 4. Starting the app
// =====================================================================

async function start() {
  let session = null;
  try {
    const { data } = await db.auth.getSession();
    session = data.session;
  } catch (err) {
    console.error(err);
  }
  hide($("loading-screen"));
  if (session) {
    await enterApp(session.user);
  } else {
    show($("auth-screen"));
  }
}

async function enterApp(user) {
  const { data: profile, error } = await db.from("profiles").select("id, username, avatar_url").eq("id", user.id).single();
  if (error || !profile) {
    hide($("loading-screen"));
    show($("auth-screen"));
    return authError("Couldn't load your profile. Did you run the database setup script in Supabase?");
  }
  me = profile;
  profiles.set(me.id, me);

  hide($("auth-screen"));
  hide($("loading-screen"));
  show($("app"));

  const accountButton = $("account-button");
  accountButton.innerHTML = "";
  accountButton.appendChild(makeAvatar(me.id, "medium"));
  $("account-name").textContent = me.username;

  listenForChanges();
  trackOnline();
  await loadChats();
}

// =====================================================================
// 5. Chat list
// =====================================================================

async function loadChats() {
  const { data, error } = await db.rpc("my_chats");
  if (error) {
    toast("Couldn't load your chats: " + friendlyError(error));
    return;
  }
  chats = data;
  await ensureProfiles(chats.flatMap((c) => [c.other_user_id, c.last_sender_id]));
  renderChatList();
  if (currentChatId) updateChatHeader();
}

function previewText(chat) {
  if (!chat.last_sender_id) return chat.is_group ? "Group created" : "No messages yet";
  let text = chat.last_deleted ? "Message deleted" : chat.last_text || (chat.last_has_image ? "📷 Photo" : "");
  if (chat.last_text && chat.last_has_image) text = "📷 " + text;
  if (chat.last_sender_id === me.id) return "You: " + text;
  if (chat.is_group) return nameOf(chat.last_sender_id) + ": " + text;
  return text;
}

function renderChatList() {
  chats.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  const list = $("chat-list");
  list.innerHTML = "";
  $("chat-list-empty").classList.toggle("hidden", chats.length > 0);

  for (const chat of chats) {
    const li = document.createElement("li");
    li.className = "chat-item";
    if (chat.id === currentChatId) li.classList.add("active");
    if (chat.unread > 0) li.classList.add("has-unread");

    const main = document.createElement("div");
    main.className = "chat-item-main";

    const top = document.createElement("div");
    top.className = "chat-item-top";
    const name = document.createElement("span");
    name.className = "chat-item-name";
    name.textContent = chatTitle(chat);
    const time = document.createElement("span");
    time.className = "chat-item-time";
    time.textContent = formatListTime(chat.last_message_at);
    top.append(name, time);

    const bottom = document.createElement("div");
    bottom.className = "chat-item-bottom";
    const preview = document.createElement("span");
    preview.className = "chat-item-preview";
    preview.textContent = previewText(chat);
    bottom.appendChild(preview);
    if (chat.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = chat.unread > 99 ? "99+" : chat.unread;
      bottom.appendChild(badge);
    }

    main.append(top, bottom);
    li.append(chatAvatar(chat, "large"), main);
    li.addEventListener("click", () => openChat(chat.id));
    list.appendChild(li);
  }

  updateUnreadTotal();
}

// Total unread shown in the browser tab and on the home-screen icon (where supported)
function updateUnreadTotal() {
  const total = chats.reduce((sum, c) => sum + Number(c.unread || 0), 0);
  document.title = total > 0 ? `(${total}) Simple Chat` : "Simple Chat";
  try {
    if (total > 0 && navigator.setAppBadge) navigator.setAppBadge(total);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch {}
}

// Account menu (tap your avatar at the top left)
$("account-button").addEventListener("click", (e) => {
  e.stopPropagation();
  $("account-menu").classList.toggle("hidden");
});

// =====================================================================
// 6. Opening a chat
// =====================================================================

const appEl = $("app");
const messagesEl = $("messages");
const messageInput = $("message-input");
const sendButton = document.querySelector(".send-button");
let askedForNotifications = false;

async function openChat(chatId) {
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;

  // On phones, opening a chat adds a "page" so the phone's back button returns to the list
  if (!appEl.classList.contains("in-chat") && window.matchMedia("(max-width: 759px)").matches) {
    history.pushState({ chat: true }, "");
  }

  currentChatId = chatId;
  appEl.classList.add("in-chat");
  hide($("no-chat"));
  show($("chat-view"));
  hide($("members-panel"));
  cancelReply();
  clearPhoto();
  typers.clear();
  renderTyping();
  messageInput.value = "";
  updateSendButton();

  messages.clear();
  rows.clear();
  messagesEl.innerHTML = '<div class="messages-status">Loading…</div>';
  messagesEl.classList.toggle("dm", !chat.is_group);
  renderChatList();
  updateChatHeader();

  if (!askedForNotifications) {
    askedForNotifications = true;
    unlockSound();               // browsers only allow sound after a tap
    setupNotifications();
  }

  joinTypingChannel(chatId);

  // Load members, recent messages and their reactions at the same time
  const [membersRes, messagesRes, reactionsRes] = await Promise.all([
    db.from("chat_members").select("user_id").eq("chat_id", chatId),
    db.from("messages").select("*").eq("chat_id", chatId)
      .order("created_at", { ascending: false }).limit(MESSAGES_TO_LOAD),
    db.from("reactions").select("message_id, user_id, emoji").eq("chat_id", chatId).limit(5000),
  ]);
  if (chatId !== currentChatId) return; // you switched to another chat while this was loading

  if (messagesRes.error || membersRes.error) {
    messagesEl.innerHTML = "";
    toast("Couldn't load this chat: " + friendlyError(messagesRes.error || membersRes.error));
    return;
  }

  currentMembers = membersRes.data.map((m) => m.user_id);
  const list = messagesRes.data.reverse();
  await ensureProfiles([...currentMembers, ...list.map((m) => m.user_id)]);
  await signPhotos(list.map((m) => m.image_path).filter(Boolean));
  if (chatId !== currentChatId) return;

  for (const m of list) m.reactions = {};
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const r of reactionsRes.data || []) {
    const m = byId.get(r.message_id);
    if (!m) continue;
    (m.reactions[r.emoji] = m.reactions[r.emoji] || []).push(r.user_id);
  }

  messagesEl.innerHTML = "";
  messages.clear();
  rows.clear();
  list.forEach((m) => {
    seenMessageIds.add(m.id);
    addMessage(m);
  });
  if (list.length === 0) {
    messagesEl.innerHTML = '<div class="messages-status">No messages yet. Say hi! 👋</div>';
  }
  scrollToBottom();
  updateChatHeader();
  markRead();
  if (window.matchMedia("(min-width: 760px)").matches) messageInput.focus();
}

function closeChat() {
  currentChatId = null;
  appEl.classList.remove("in-chat");
  hide($("chat-view"));
  show($("no-chat"));
  leaveTypingChannel();
  renderChatList();
}

// The ‹ back button (phones) uses the phone's history, so both back buttons behave the same
$("back-button").addEventListener("click", () => {
  if (history.state && history.state.chat) history.back();
  else closeChat();
});
window.addEventListener("popstate", () => {
  if (currentChatId) closeChat();
});

function updateChatHeader() {
  const chat = chats.find((c) => c.id === currentChatId);
  if (!chat) return;
  const avatarSlot = $("chat-avatar");
  avatarSlot.innerHTML = "";
  avatarSlot.appendChild(chatAvatar(chat, "medium"));
  $("chat-title").textContent = chatTitle(chat);

  const subtitle = $("chat-subtitle");
  subtitle.classList.remove("online");
  if (chat.is_group) {
    const count = currentMembers.length || chat.member_count;
    const online = currentMembers.filter((id) => id !== me.id && onlineIds.has(id)).length;
    subtitle.textContent = `${count} members` + (online ? `, ${online} online` : "");
  } else if (onlineIds.has(chat.other_user_id)) {
    subtitle.textContent = "online";
    subtitle.classList.add("online");
  } else {
    subtitle.textContent = "tap for info";
  }
  renderMembers();
}

// Mark the open chat as read (clears its unread badge), at most a couple of times per second
let markReadTimer = null;
function markRead() {
  if (!currentChatId || document.hidden) return;
  const chat = chats.find((c) => c.id === currentChatId);
  if (chat && chat.unread) {
    chat.unread = 0;
    renderChatList();
  }
  clearTimeout(markReadTimer);
  const chatId = currentChatId;
  markReadTimer = setTimeout(() => db.rpc("mark_read", { chat: chatId }), 400);
}

// =====================================================================
// 7. Members panel (tap the chat's name)
// =====================================================================

$("chat-title-button").addEventListener("click", (e) => {
  e.stopPropagation();
  $("members-panel").classList.toggle("hidden");
});

function renderMembers() {
  const chat = chats.find((c) => c.id === currentChatId);
  if (!chat) return;
  const list = $("members-list");
  list.innerHTML = "";
  const sorted = [...currentMembers].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of sorted) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = nameOf(id);
    li.append(makeAvatar(id), label);
    if (id === me.id) {
      const you = document.createElement("span");
      you.className = "you";
      you.textContent = "(you)";
      li.appendChild(you);
    }
    list.appendChild(li);
  }
  $("group-actions").classList.toggle("hidden", !chat.is_group);
}

$("add-members-button").addEventListener("click", () => {
  hide($("members-panel"));
  openNewChat("add");
});

$("leave-group-button").addEventListener("click", async () => {
  const chat = chats.find((c) => c.id === currentChatId);
  if (!chat || !confirm(`Leave "${chat.name}"? You won't see its messages anymore.`)) return;
  const { error } = await db.rpc("leave_group", { chat: chat.id });
  if (error) return toast(friendlyError(error));
  hide($("members-panel"));
  chats = chats.filter((c) => c.id !== chat.id);
  if (history.state && history.state.chat) history.back();
  else closeChat();
});

// =====================================================================
// 8. Showing messages
// =====================================================================

// Build one message on the page.
// We use textContent (never innerHTML) for user text, so nobody can inject HTML/scripts.
function addMessage(msg) {
  if (rows.has(msg.id)) return;
  if (!msg.reactions) msg.reactions = {};
  messages.set(msg.id, msg);

  // Remove the "No messages yet" note
  const status = messagesEl.querySelector(".messages-status");
  if (status) status.remove();

  const time = new Date(msg.created_at).getTime();
  const row = document.createElement("div");
  row.className = "row" + (msg.user_id === me.id ? " mine" : "");
  row.dataset.userId = msg.user_id;
  row.dataset.time = time;

  // Group with the previous message if it's the same person, a few minutes apart
  const prev = messagesEl.lastElementChild;
  if (prev && prev.classList.contains("row") &&
      prev.dataset.userId === msg.user_id &&
      time - Number(prev.dataset.time) < GROUP_WINDOW) {
    row.classList.add("continued");
    prev.classList.add("has-next");
  }

  const body = document.createElement("div");
  body.className = "body";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = nameOf(msg.user_id);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // If this is a reply, show the quoted message first
  if (msg.reply_to) {
    const original = messages.get(msg.reply_to);
    const quote = document.createElement("div");
    quote.className = "quote";
    const qName = document.createElement("div");
    qName.className = "quote-name";
    qName.textContent = original ? nameOf(original.user_id) : "Reply";
    const qText = document.createElement("div");
    qText.className = "quote-text";
    qText.textContent = original ? (original.text || "📷 Photo") : "Earlier message";
    quote.append(qName, qText);
    quote.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpTo(msg.reply_to);
    });
    bubble.appendChild(quote);
  }

  // A photo, if the message has one. Tapping it opens the full-screen viewer.
  if (msg.image_path) {
    bubble.classList.add("has-image");
    const img = document.createElement("img");
    img.className = "photo";
    img.alt = "Photo from " + nameOf(msg.user_id);
    img.addEventListener("load", () => {
      img.classList.add("loaded");
      if (stuckToBottom) scrollToBottom(); // photos load a moment later, so keep the chat at the bottom
    });
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      if (img.src) openViewer(img.src);
    });
    getPhotoUrl(msg.image_path).then((url) => { if (url) img.src = url; });
    bubble.appendChild(img);
  }

  if (msg.text) {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = msg.text;
    bubble.appendChild(text);
  }

  // Tap a message to react or reply
  bubble.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(msg.id, bubble);
  });

  const reactions = document.createElement("div");
  reactions.className = "reactions";

  const timeEl = document.createElement("div");
  timeEl.className = "time";
  timeEl.textContent = formatTime(msg.created_at);

  body.append(name, bubble, reactions, timeEl);
  row.append(makeAvatar(msg.user_id), body);
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
    const people = msg.reactions[emoji] || [];
    if (people.length === 0) continue;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (people.includes(me.id) ? " mine" : "");
    chip.textContent = `${emoji} ${people.length}`;
    chip.title = people.map(nameOf).join(", ");
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleReaction(id, emoji); // tap a chip to add/remove your reaction
    });
    box.appendChild(chip);
  }
}

// Scroll to a message (used when tapping a quoted reply) and flash it
function jumpTo(id) {
  const row = rows.get(id);
  if (!row) return toast("That message is too old to show here.");
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

messagesEl.addEventListener("scroll", () => {
  closeMenu();
  stuckToBottom = isNearBottom();
});

// =====================================================================
// 9. Sending messages
// =====================================================================

$("message-form").addEventListener("submit", (e) => {
  e.preventDefault(); // Enter key submits the form
  sendMessage();
});

async function sendMessage() {
  const chatId = currentChatId;
  const text = messageInput.value.trim();
  const photo = pendingImage;
  const replyTo = replyingTo;
  if (!chatId || (!text && !photo)) return; // don't send empty messages

  // Clear the box right away so it feels instant
  messageInput.value = "";
  clearPhoto();
  cancelReply();
  stopTyping();
  updateSendButton();

  try {
    let imagePath = null;
    if (photo) {
      const ext = photo.blob.type === "image/gif" ? "gif" : "jpg";
      imagePath = `${chatId}/${crypto.randomUUID()}.${ext}`;
      photoUrls.set(imagePath, photo.preview); // show our own copy instantly
      const { error: uploadError } = await db.storage.from(PHOTO_BUCKET)
        .upload(imagePath, photo.blob, { contentType: photo.blob.type });
      if (uploadError) throw uploadError;
    }

    const { data, error } = await db.from("messages")
      .insert({ chat_id: chatId, text, image_path: imagePath, reply_to: replyTo })
      .select()
      .single();
    if (error) throw error;
    stuckToBottom = true;
    handleNewMessage(data);
  } catch (err) {
    toast("Couldn't send: " + friendlyError(err));
    if (currentChatId === chatId && !messageInput.value) messageInput.value = text; // give the text back
    updateSendButton();
  }
}

// Grey out the send button when there's nothing to send
function updateSendButton() {
  sendButton.disabled = messageInput.value.trim() === "" && !pendingImage;
}

// =====================================================================
// 10. Real-time updates from Supabase
// =====================================================================

function listenForChanges() {
  db.channel("db-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
      (p) => handleNewMessage(p.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "reactions" },
      (p) => applyReaction(p.new, true))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "reactions" },
      (p) => applyReaction(p.old, false))
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_members" },
      (p) => handleMembersChange(p))
    .subscribe();
}

// A new message arrived (from anyone, in any of my chats)
async function handleNewMessage(msg) {
  if (seenMessageIds.has(msg.id)) return;
  seenMessageIds.add(msg.id);

  const mine = msg.user_id === me.id;
  const isOpen = msg.chat_id === currentChatId;
  const chat = chats.find((c) => c.id === msg.chat_id);

  // A message in a chat we don't have yet (someone just started a chat with us)
  if (!chat) {
    await loadChats();
  } else {
    chat.last_message_at = msg.created_at;
    chat.last_text = msg.text;
    chat.last_has_image = !!msg.image_path;
    chat.last_sender_id = msg.user_id;
    chat.last_deleted = false;
    if (!mine && !(isOpen && !document.hidden)) chat.unread = Number(chat.unread || 0) + 1;
  }

  await ensureProfiles([msg.user_id]);

  if (isOpen && msg.chat_id === currentChatId) {
    const stick = stuckToBottom || mine;
    typers.delete(msg.user_id); // they sent it, so they're done typing
    renderTyping();
    addMessage(msg);
    if (stick) scrollToBottom();
    if (!mine) markRead();
  }

  renderChatList();

  if (!mine) {
    playDing();
    if (!isOpen || document.hidden) notifyNewMessage(msg);
  }
}

// Someone added or removed a reaction
function applyReaction(r, added) {
  const msg = messages.get(r.message_id);
  if (!msg) return; // not in the open chat
  const people = msg.reactions[r.emoji] || [];
  if (added && !people.includes(r.user_id)) msg.reactions[r.emoji] = [...people, r.user_id];
  if (!added) msg.reactions[r.emoji] = people.filter((id) => id !== r.user_id);
  if (msg.reactions[r.emoji] && msg.reactions[r.emoji].length === 0) delete msg.reactions[r.emoji];

  const stick = isNearBottom();
  renderReactions(msg.id);
  if (menuFor === msg.id) markPickedEmojis();
  if (stick) scrollToBottom();
}

async function toggleReaction(messageId, emoji) {
  const msg = messages.get(messageId);
  if (!msg) return;
  const hasIt = (msg.reactions[emoji] || []).includes(me.id);
  const r = { message_id: messageId, user_id: me.id, emoji };

  applyReaction(r, !hasIt); // update the screen right away
  const { error } = hasIt
    ? await db.from("reactions").delete().match(r)
    : await db.from("reactions").insert({ message_id: messageId, emoji, chat_id: msg.chat_id });
  if (error && !/duplicate/i.test(error.message)) {
    applyReaction(r, hasIt); // undo
    toast("Couldn't react: " + friendlyError(error));
  }
}

// Someone joined or left a chat (including you being added to a new group)
async function handleMembersChange(p) {
  const row = p.new && p.new.user_id ? p.new : p.old;
  if (p.eventType === "INSERT" && row.user_id === me.id) {
    await loadChats(); // you were added to a chat
    return;
  }
  if (p.eventType === "UPDATE") return; // just someone reading messages
  if (currentChatId && (!row.chat_id || row.chat_id === currentChatId)) {
    const { data } = await db.from("chat_members").select("user_id").eq("chat_id", currentChatId);
    if (data) {
      currentMembers = data.map((m) => m.user_id);
      await ensureProfiles(currentMembers);
      updateChatHeader();
    }
  }
}

// ---------- Who's online (Supabase "presence") ----------
function trackOnline() {
  const channel = db.channel("online", { config: { presence: { key: me.id } } });
  channel
    .on("presence", { event: "sync" }, () => {
      onlineIds = new Set(Object.keys(channel.presenceState()));
      renderChatList();
      updateChatHeader();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") await channel.track({ online_at: new Date().toISOString() });
    });
}

// ---------- "Is typing…" (Supabase "broadcast", only for the open chat) ----------
const typers = new Map(); // user id -> timer that clears them after a few seconds

function joinTypingChannel(chatId) {
  leaveTypingChannel();
  typingChannel = db.channel(`typing:${chatId}`, { config: { broadcast: { self: false } } });
  typingChannel
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload || payload.chatId !== currentChatId || payload.userId === me.id) return;
      clearTimeout(typers.get(payload.userId));
      if (payload.isTyping) {
        typers.set(payload.userId, setTimeout(() => { typers.delete(payload.userId); renderTyping(); }, 4000));
      } else {
        typers.delete(payload.userId);
      }
      renderTyping();
    })
    .subscribe();
}

function leaveTypingChannel() {
  if (typingChannel) db.removeChannel(typingChannel);
  typingChannel = null;
  typers.clear();
}

let lastTypingSent = 0;
let typingStopTimer = null;
let isTyping = false;

function sendTyping(state) {
  if (!typingChannel) return;
  typingChannel.send({ type: "broadcast", event: "typing", payload: { chatId: currentChatId, userId: me.id, isTyping: state } });
}

messageInput.addEventListener("input", () => {
  updateSendButton();
  const now = Date.now();
  if (!isTyping || now - lastTypingSent > 2500) { // remind others every few seconds while typing
    isTyping = true;
    lastTypingSent = now;
    sendTyping(true);
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(stopTyping, 1500);
});

function stopTyping() {
  clearTimeout(typingStopTimer);
  if (isTyping) {
    isTyping = false;
    sendTyping(false);
  }
}

function renderTyping() {
  const names = [...typers.keys()].map(nameOf);
  const el = $("typing");
  if (names.length === 0) el.textContent = "";
  else if (names.length === 1) el.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing…`;
  else el.textContent = "Several people are typing…";
}

// =====================================================================
// 11. Pop-up menu: react or reply
// =====================================================================

const menu = $("message-menu");
const menuEmojis = $("menu-emojis");

REACTIONS.forEach((emoji) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = emoji;
  b.dataset.emoji = emoji;
  b.addEventListener("click", () => {
    toggleReaction(menuFor, emoji);
    closeMenu();
  });
  menuEmojis.appendChild(b);
});

$("menu-reply").addEventListener("click", () => {
  startReply(menuFor);
  closeMenu();
});

function openMenu(id, bubble) {
  menuFor = id;
  markPickedEmojis();
  show(menu);

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
  hide(menu);
  menuFor = null;
}

// Highlight the emojis I've already used on this message
function markPickedEmojis() {
  const msg = messages.get(menuFor);
  for (const b of menuEmojis.children) {
    const people = (msg && msg.reactions[b.dataset.emoji]) || [];
    b.classList.toggle("picked", people.includes(me.id));
  }
}

// Close pop-ups when tapping elsewhere, resizing, or pressing Escape
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target)) closeMenu();
  for (const id of ["members-panel", "account-menu"]) {
    if (!$(id).contains(e.target)) hide($(id));
  }
});
window.addEventListener("resize", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenu();
    closeViewer();
    cancelReply();
    hide($("members-panel"));
    hide($("account-menu"));
    if (!$("new-chat-modal").classList.contains("hidden")) closeNewChat();
  }
});

// =====================================================================
// 12. Replying
// =====================================================================

function startReply(id) {
  const msg = messages.get(id);
  if (!msg) return;
  replyingTo = id;
  $("reply-bar-name").textContent = `Replying to ${msg.user_id === me.id ? "yourself" : nameOf(msg.user_id)}`;
  $("reply-bar-preview").textContent = msg.text || "📷 Photo";
  show($("reply-bar"));
  messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  hide($("reply-bar"));
}
$("reply-cancel").addEventListener("click", cancelReply);

// =====================================================================
// 13. Photos
// =====================================================================

const MAX_SIDE = 1600;                     // shrink big photos to at most 1600px wide/tall
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;    // storage limit is 5 MB

// Get web addresses for private photos (they expire after a day; we ask again when needed)
async function signPhotos(paths) {
  const missing = [...new Set(paths)].filter((p) => !photoUrls.has(p));
  if (missing.length === 0) return;
  const { data, error } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(missing, 60 * 60 * 24);
  if (error) return console.error(error);
  data.forEach((d) => { if (d.signedUrl) photoUrls.set(d.path, d.signedUrl); });
}

async function getPhotoUrl(path) {
  if (!photoUrls.has(path)) await signPhotos([path]);
  return photoUrls.get(path);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Shrink and compress a photo so it sends quickly. Small GIFs are sent as-is so they keep moving.
async function prepareImage(file) {
  if (file.type === "image/gif" && file.size < MAX_IMAGE_SIZE / 2) {
    return { blob: file, preview: URL.createObjectURL(file) };
  }
  const img = await loadImage(file);
  let side = MAX_SIDE;
  let quality = 0.82;
  for (let attempt = 0; attempt < 4; attempt++) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs get a white background instead of black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, quality);
    if (blob && blob.size <= MAX_IMAGE_SIZE) return { blob, preview: URL.createObjectURL(blob) };
    side *= 0.75;   // still too big: try smaller and a bit more compressed
    quality -= 0.1;
  }
  throw new Error("too big");
}

async function choosePhoto(file) {
  if (!file || !file.type.startsWith("image/") || !currentChatId) return;
  try {
    pendingImage = await prepareImage(file);
  } catch {
    toast("Sorry, that photo couldn't be used. Try a different one.");
    return;
  }
  $("photo-preview").src = pendingImage.preview;
  show($("photo-bar"));
  updateSendButton();
  messageInput.focus();
}

function clearPhoto() {
  pendingImage = null;
  $("photo-input").value = ""; // lets you pick the same photo again later
  $("photo-preview").removeAttribute("src");
  hide($("photo-bar"));
  updateSendButton();
}

$("photo-input").addEventListener("change", () => choosePhoto($("photo-input").files[0]));
$("photo-cancel").addEventListener("click", clearPhoto);

// On a computer: paste a screenshot straight into the message box
messageInput.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith("image/"));
  if (item) {
    e.preventDefault();
    choosePhoto(item.getAsFile());
  }
});

// On a computer: drag a photo onto the chat
const chatView = $("chat-view");
chatView.addEventListener("dragover", (e) => {
  if ([...e.dataTransfer.types].includes("Files")) {
    e.preventDefault();
    chatView.classList.add("dragging");
  }
});
chatView.addEventListener("dragleave", (e) => {
  if (!chatView.contains(e.relatedTarget)) chatView.classList.remove("dragging");
});
chatView.addEventListener("drop", (e) => {
  e.preventDefault();
  chatView.classList.remove("dragging");
  choosePhoto(e.dataTransfer.files[0]);
});

// Full-screen viewer
function openViewer(src) {
  $("viewer-image").src = src;
  show($("viewer"));
}
function closeViewer() {
  hide($("viewer"));
  $("viewer-image").removeAttribute("src");
}
$("viewer").addEventListener("click", closeViewer);

// =====================================================================
// 14. New chat / new group / add people
// =====================================================================

let modalMode = "dm";       // "dm", "group" or "add"
let picked = new Map();     // user id -> profile (for groups)
let searchTimer = null;

$("new-chat-button").addEventListener("click", () => openNewChat("dm"));
$("empty-new-chat").addEventListener("click", () => openNewChat("dm"));
$("modal-cancel").addEventListener("click", closeNewChat);
$("new-chat-modal").addEventListener("click", (e) => {
  if (e.target === $("new-chat-modal")) closeNewChat(); // tap outside the window
});

document.querySelectorAll("#modal-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => setModalMode(tab.dataset.mode));
});

function openNewChat(mode) {
  picked = new Map();
  $("group-name").value = "";
  $("user-search").value = "";
  hide($("modal-error"));
  show($("new-chat-modal"));
  setModalMode(mode);
  $("user-search").focus();
}

function closeNewChat() {
  hide($("new-chat-modal"));
}

function setModalMode(mode) {
  modalMode = mode;
  document.querySelectorAll("#modal-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $("modal-tabs").classList.toggle("hidden", mode === "add");
  $("group-name").classList.toggle("hidden", mode !== "group");
  $("modal-create").style.visibility = mode === "dm" ? "hidden" : "visible"; // keeps the title centered
  $("modal-create").textContent = mode === "add" ? "Add" : "Create";
  $("modal-title").textContent = { dm: "New chat", group: "New group", add: "Add people" }[mode];
  renderPicked();
  searchUsers();
}

$("group-name").addEventListener("input", updateCreateButton);
$("user-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchUsers, 250);
});

function updateCreateButton() {
  const ok = modalMode === "group"
    ? picked.size > 0 && $("group-name").value.trim() !== ""
    : picked.size > 0;
  $("modal-create").disabled = !ok;
}

function renderPicked() {
  const box = $("picked-people");
  box.innerHTML = "";
  box.classList.toggle("hidden", modalMode === "dm" || picked.size === 0);
  for (const p of picked.values()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "person-chip";
    const label = document.createElement("span");
    label.textContent = p.username + " ✕";
    chip.append(makeAvatar(p.id), label);
    chip.addEventListener("click", () => {
      picked.delete(p.id);
      renderPicked();
      searchUsers();
    });
    box.appendChild(chip);
  }
  updateCreateButton();
}

function note(text) {
  const li = document.createElement("li");
  li.className = "note";
  li.textContent = text;
  return li;
}

// "joined today", "joined yesterday", "joined Sep 28"
function joinedText(date) {
  const label = formatListTime(date);
  if (label === "Yesterday") return "joined yesterday";
  if (/\d:\d\d/.test(label)) return "joined today";
  return "joined " + new Date(date).toLocaleDateString([], { month: "short", day: "numeric" });
}

async function searchUsers() {
  const list = $("user-results");
  const q = $("user-search").value.trim();

  // With an empty search box, list everyone who has joined; otherwise filter by name
  let query = db.from("profiles").select("id, username, avatar_url, created_at").neq("id", me.id);
  if (q) {
    const pattern = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"; // search anywhere in the name
    query = query.ilike("username", pattern).order("username").limit(50);
  } else {
    query = query.order("created_at", { ascending: false }).limit(200);
  }
  const { data, error } = await query;
  if (q !== $("user-search").value.trim()) return; // you kept typing
  list.innerHTML = "";
  if (error) return list.appendChild(note("Couldn't load people. Try again."));
  if (data.length === 0) {
    return list.appendChild(note(q ? `No one called "${q}" yet.` : "No one else has joined yet. Share your link with friends!"));
  }

  // People who are online right now go first
  const people = [...data].sort((a, b) => onlineIds.has(b.id) - onlineIds.has(a.id));
  for (const p of people) {
    profiles.set(p.id, p);
    const already = modalMode === "add" && currentMembers.includes(p.id);
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.className = "grow";
    const name = document.createElement("div");
    name.textContent = p.username;
    const sub = document.createElement("div");
    sub.className = "person-sub" + (onlineIds.has(p.id) ? " online" : "");
    sub.textContent = onlineIds.has(p.id) ? "online" : joinedText(p.created_at);
    label.append(name, sub);

    const check = document.createElement("span");
    check.className = "check";
    if (already) check.textContent = "in group";
    else if (modalMode !== "dm") check.textContent = picked.has(p.id) ? "✓" : "";
    li.append(makeAvatar(p.id, "medium"), label, check);
    if (!already) li.addEventListener("click", () => pickUser(p));
    list.appendChild(li);
  }
}

async function pickUser(p) {
  if (modalMode === "dm") {
    // Private chat: open it straight away
    const { data: chatId, error } = await db.rpc("create_dm", { other_user: p.id });
    if (error) return modalError(error);
    closeNewChat();
    await loadChats();
    openChat(chatId);
    return;
  }
  if (picked.has(p.id)) picked.delete(p.id);
  else picked.set(p.id, p);
  renderPicked();
  searchUsers();
}

function modalError(error) {
  $("modal-error").textContent = friendlyError(error);
  show($("modal-error"));
}

$("modal-create").addEventListener("click", async () => {
  const ids = [...picked.keys()];
  const button = $("modal-create");
  button.disabled = true;

  if (modalMode === "group") {
    const { data: chatId, error } = await db.rpc("create_group", {
      group_name: $("group-name").value.trim(),
      member_ids: ids,
    });
    if (error) { button.disabled = false; return modalError(error); }
    closeNewChat();
    await loadChats();
    openChat(chatId);
  } else if (modalMode === "add") {
    const { error } = await db.rpc("add_group_members", { chat: currentChatId, member_ids: ids });
    if (error) { button.disabled = false; return modalError(error); }
    closeNewChat();
    currentMembers = [...new Set([...currentMembers, ...ids])];
    updateChatHeader();
    await loadChats();
    toast(ids.length === 1 ? `Added ${nameOf(ids[0])}` : `Added ${ids.length} people`);
  }
});

// =====================================================================
// 15. Sound
// =====================================================================
// The "ding" is made with the Web Audio API, so there's no sound file to download.

let soundOn = load("chat-sound") !== "off";
let audio = null;

function updateSoundButton() {
  const b = $("sound-button");
  b.textContent = soundOn ? "🔔" : "🔕";
  b.title = soundOn ? "Sound on (tap to mute)" : "Sound off (tap to unmute)";
}
updateSoundButton();

$("sound-button").addEventListener("click", () => {
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

// =====================================================================
// 16. Notifications (while the app is open in the background)
// =====================================================================

const canNotify = "Notification" in window;

function setupNotifications() {
  if (canNotify && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function notifyNewMessage(msg) {
  if (!canNotify || Notification.permission !== "granted") return;
  const chat = chats.find((c) => c.id === msg.chat_id);
  const title = chat && chat.is_group ? `${nameOf(msg.user_id)} in ${chat.name}` : nameOf(msg.user_id);
  const options = {
    body: msg.text || "📷 Photo",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: msg.chat_id,       // one notification per chat
    renotify: true,
  };

  // Phones need the service worker to show notifications; computers can do it directly
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, options))
      .catch(() => { try { new Notification(title, options); } catch {} });
  } else {
    try { new Notification(title, options); } catch {}
  }
}

// When you come back to the app: mark the open chat read, and refresh the list in case we missed anything
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me) {
    markRead();
    loadChats();
  }
});

// =====================================================================
// Go!
// =====================================================================
start();
