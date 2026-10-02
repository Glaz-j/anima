const $ = (selector) => document.querySelector(selector);
const state = { roles: [], selected: null, controller: null, history: [], loading: false };
const starterTopics = {
  sheldon: ["我想临时改一下我们今天的计划。", "朋友难过的时候，你会怎么安慰他？", "你觉得聪明和讨人喜欢，哪个更重要？", "如果有人坐了你常坐的位置呢？"],
  sherlock: ["只凭聊天，你能观察出我什么？", "今天很无聊，给我一个值得想的问题。", "直觉和证据矛盾的时候，你相信哪个？", "如果华生不愿意陪你查案呢？"],
  deadpool: ["我今天有点丧，陪我聊两句。", "如果你过一天普通人的生活呢？", "你是不是一认真就要开玩笑？", "给我们俩的初次见面起个片名。"],
  lvziqiao: ["预算只有五十块，今晚怎么过？", "我约朋友吃饭，但是忘记带钱包了。", "你会不会也有不自信的时候？", "你和一菲谁更适合当室友？"],
  huyifei: ["我又拖延了，事情到现在还没做。", "有人答应帮忙，最后却找借口跑了。", "你是嘴硬心软吗？", "如果我们合租，你有什么规矩？"],
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败。");
  return value;
}
function status(text = "", error = false) { $("#status").textContent = text; $("#status").classList.toggle("error", error); }
function controls() {
  const active = Boolean(state.controller);
  $("#send").textContent = active ? "■" : "↑";
  $("#send").setAttribute("aria-label", active ? "停止生成" : "发送消息");
  $("#send").disabled = !state.selected || state.loading;
  $("#input").disabled = !state.selected || state.loading;
  $("#new-button").disabled = active || state.loading || !state.selected;
  document.querySelectorAll(".role-button").forEach((b) => { b.disabled = active || state.loading; });
  document.querySelectorAll(".starters button").forEach((b) => { b.disabled = active || state.loading; });
}
function scrollBottom() { const area = $("#scroll-area"); area.scrollTop = area.scrollHeight; }
function addMessage(message, pending = false) {
  const row = element("article", `message ${message.role}${pending ? " pending" : ""}`);
  if (message.role === "assistant") row.append(element("div", "avatar", state.selected.mark));
  const body = element("div", "message-body");
  body.append(element("div", "message-label", message.role === "user" ? "你" : state.selected.name));
  const text = element("div", "message-text", message.text);
  body.append(text); row.append(body); $("#messages").append(row);
  return { row, text };
}
function renderHistory() {
  $("#messages").replaceChildren();
  $("#welcome").classList.toggle("hidden", state.history.length > 0);
  state.history.forEach((message) => addMessage(message));
  scrollBottom();
}
async function selectRole(role) {
  if (state.controller || state.loading) return;
  state.loading = true; state.selected = role; status(); controls();
  document.documentElement.style.setProperty("--role-color", role.color);
  $("#role-name").textContent = role.name;
  $("#role-version").textContent = `${role.work} · ${role.version}`;
  $("#header-avatar").textContent = role.mark; $("#hero-avatar").textContent = role.mark;
  $("#welcome-title").textContent = `和${role.name}，聊一会儿。`;
  $("#role-summary").textContent = role.summary;
  $("#input").placeholder = `想对${role.name}说些什么？`;
  $("#role-tags").replaceChildren(...role.tags.map((tag) => element("span", "", tag)));
  $("#starters").replaceChildren(...starterTopics[role.id].map((text) => {
    const button = element("button", "", text);
    button.type = "button"; button.append(element("span", "", "↗"));
    button.addEventListener("click", () => { $("#input").value = text; $("#input").focus(); resizeInput(); });
    return button;
  }));
  document.querySelectorAll(".role-button").forEach((b) => {
    b.classList.toggle("active", b.dataset.id === role.id); b.setAttribute("aria-pressed", String(b.dataset.id === role.id));
  });
  try { const saved = await api(`/api/roles/${role.id}/history`); state.history = saved.messages; }
  catch (error) { state.history = []; status(error.message, true); }
  finally { state.loading = false; renderHistory(); controls(); }
}
function resizeInput() { const input = $("#input"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 150)}px`; }

async function sendMessage(event) {
  event.preventDefault();
  if (state.controller) { state.controller.abort(); return; }
  const message = $("#input").value.trim();
  if (!message || !state.selected || state.loading) return;
  const role = state.selected;
  const controller = new AbortController(); state.controller = controller; controls();
  $("#input").value = ""; resizeInput(); status(`${role.name}正在想…`);
  $("#welcome").classList.add("hidden");
  const user = addMessage({ role: "user", text: message });
  const assistant = addMessage({ role: "assistant", text: "" }, true);
  scrollBottom();
  let finished = false;
  try {
    const response = await fetch(`/api/roles/${role.id}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }), signal: controller.signal,
    });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || "请求失败。"); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!block.startsWith("data: ")) continue;
        const result = JSON.parse(block.slice(6));
        if (result.type === "delta") { assistant.text.textContent += result.text; status(); scrollBottom(); }
        if (result.type === "error") throw new Error(result.error);
        if (result.type === "done") {
          assistant.text.textContent = result.text; assistant.row.classList.remove("pending");
          state.history.push({ role: "user", text: message }, { role: "assistant", text: result.text });
          finished = true; status(); scrollBottom();
        }
      }
    }
    if (!finished) throw new Error("连接结束，但回复未保存。可以重试。");
  } catch (error) {
    if (!finished) {
      user.row.remove(); assistant.row.remove();
      $("#input").value = message; resizeInput();
      // Reconcile with disk in case generation finished just as the connection was cancelled.
      try { state.history = (await api(`/api/roles/${role.id}/history`)).messages; renderHistory(); } catch {}
      status(error.name === "AbortError" ? "已停止。未完成的回复不会进入记忆。" : error.message, true);
    }
  } finally { state.controller = null; controls(); $("#input").focus(); }
}

$("#composer").addEventListener("submit", sendMessage);
$("#input").addEventListener("input", resizeInput);
$("#input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.controller) $("#composer").requestSubmit(); }
});
$("#new-button").addEventListener("click", async () => {
  if (!state.selected || state.controller) return;
  try {
    await api(`/api/roles/${state.selected.id}/new`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.history = []; renderHistory(); status("已开始新对话，旧记录已在本地归档。");
  } catch (error) { status(error.message, true); }
});
$("#profile-button").addEventListener("click", async () => {
  if (!state.selected) return;
  try {
    const profile = await api(`/api/roles/${state.selected.id}/profile`);
    $("#profile-title").textContent = `${profile.name} · 人物档案`;
    const content = $("#profile-content"); content.replaceChildren();
    content.append(element("div", "source-facts", `${profile.targetUtterances.toLocaleString()} 条本人台词 · ${profile.evidenceChunks.toLocaleString()} 个材料片段 · ${profile.sampledWindows} 个档案分析样本`));
    content.append(element("p", "", "这是根据抽样台词生成的第一版档案，聊天时还会检索角色材料。我们可以边聊边修正。"));
    for (const [title, text] of [["性格与表达", profile.persona], ["原作事实与关系", profile.memory], ["当前局限", profile.limitations.join("\n")]]) {
      content.append(element("h3", "", title), element("pre", "", text));
    }
    const source = element("a", "", `材料来源：${profile.source.dataset}`); source.href = profile.source.url; source.target = "_blank"; source.rel = "noreferrer"; content.append(source);
    $("#profile-dialog").showModal();
  } catch (error) { status(error.message, true); }
});
$("#close-profile").addEventListener("click", () => $("#profile-dialog").close());
$("#profile-dialog").addEventListener("click", (event) => { if (event.target === $("#profile-dialog")) $("#profile-dialog").close(); });

try {
  const config = await api("/api/bootstrap"); state.roles = config.roles;
  $("#connection").textContent = "角色已就绪"; $("#model-label").textContent = config.model;
  for (const role of state.roles) {
    const button = element("button", "role-button"); button.type = "button"; button.dataset.id = role.id; button.title = role.name;
    const avatar = element("span", "avatar", role.mark); avatar.style.setProperty("--role-color", role.color);
    const copy = element("span", "role-copy"); copy.append(element("strong", "", role.name), element("small", "", role.work));
    button.append(avatar, copy, element("span", "arrow", "↗")); button.addEventListener("click", () => selectRole(role)); $("#roles").append(button);
  }
  await selectRole(state.roles[0]);
} catch (error) { $("#connection").textContent = "连接未就绪"; status(error.message, true); controls(); }
