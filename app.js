/* global Peer */
const CARDS = ["0", "½", "1", "2", "3", "5", "8", "13", "21", "34", "?", "☕"]
const NUMERIC = { 0: 0, "½": 0.5, 1: 1, 2: 2, 3: 3, 5: 5, 8: 8, 13: 13, 21: 21, 34: 34 }
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const state = {
  room: null,
  playerId: null,
  playerName: null,
  role: null, // "host" | "guest"
  activeVoterId: null,
  mode: "create",
  error: null,
  copied: false,
  sync: "idle",
  confirmLeave: false,
  status: "",
}

/** @type {import('peerjs').Peer | null} */
let peer = null
/** @type {Map<string, import('peerjs').DataConnection>} */
const connections = new Map()
let storyTimer = null

const app = document.getElementById("app")

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function createRoomId() {
  let id = ""
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length]
  return id
}

function createPlayerId() {
  return crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function peerIdForRoom(roomId) {
  return `planningpoker${roomId.toUpperCase()}`
}

function roomFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return (params.get("salle") || params.get("room") || "").toUpperCase() || null
}

function setRoomUrl(roomId) {
  const url = new URL(window.location.href)
  url.searchParams.set("salle", roomId)
  window.history.replaceState({}, "", url)
}

function clearRoomUrl() {
  const url = new URL(window.location.href)
  url.searchParams.delete("salle")
  url.searchParams.delete("room")
  window.history.replaceState({}, "", url)
}

function identityKey(roomId) {
  return `planning-poker:me:${roomId}`
}

function saveIdentity(roomId, playerId, name, role) {
  localStorage.setItem(identityKey(roomId), JSON.stringify({ playerId, name, role }))
}

function loadIdentity(roomId) {
  try {
    return JSON.parse(localStorage.getItem(identityKey(roomId)) || "null")
  } catch {
    return null
  }
}

function clearIdentity(roomId) {
  localStorage.removeItem(identityKey(roomId))
}

function emptyRoom(id) {
  return {
    id,
    story: "",
    revealed: false,
    players: [],
    updatedAt: Date.now(),
  }
}

function touch(room) {
  room.updatedAt = Date.now()
}

function brandMark(compact = false) {
  return `<span class="brand brand-mark${compact ? " brand-compact" : ""}">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#173528"></rect>
      <rect x="8" y="5" width="13" height="20" rx="2" fill="#f3efe4" transform="rotate(-8 14 15)"></rect>
      <rect x="11" y="7" width="13" height="20" rx="2" fill="#f3efe4" stroke="#d4a017" stroke-width="1.2"></rect>
      <text x="17.5" y="21" text-anchor="middle" fill="#0e1712" font-size="9" font-weight="800" font-family="Syne, sans-serif">8</text>
    </svg>
    Planning Poker
  </span>`
}

function pokerCard(value, revealed) {
  if (value == null) {
    return `<div class="poker-card" aria-hidden="true"><div class="face face-empty">…</div></div>`
  }
  return `<div class="poker-card${revealed ? " flipped" : ""}" aria-hidden="true">
    <div class="poker-card-inner">
      <div class="face face-back"></div>
      <div class="face face-front">${escapeHtml(value)}</div>
    </div>
  </div>`
}

function formatPoints(value) {
  return Number.isInteger(value) ? String(value) : String(value).replace(".", ",")
}

function computeStats(players) {
  const votes = players.map((p) => p.vote).filter((v) => v != null)
  const numeric = votes.map((v) => NUMERIC[v]).filter((n) => typeof n === "number")
  const coffeeCount = votes.filter((v) => v === "☕").length
  const questionCount = votes.filter((v) => v === "?").length
  let consensus = null
  if (votes.length && votes.every((v) => v === votes[0])) consensus = votes[0]
  const average =
    numeric.length > 0
      ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10
      : null
  let median = null
  if (numeric.length) {
    const sorted = [...numeric].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }
  const spread = numeric.length >= 2 && Math.max(...numeric) - Math.min(...numeric) >= 8
  return { average, median, consensus, spread, coffeeCount, questionCount }
}

function broadcast(message) {
  for (const conn of connections.values()) {
    if (conn.open) conn.send(message)
  }
}

function sendState() {
  if (!state.room) return
  broadcast({ type: "state", room: state.room })
}

function applyRoom(room, { renderNow = true } = {}) {
  state.room = room
  if (!room.players.some((p) => p.id === state.activeVoterId)) {
    state.activeVoterId = state.playerId
  }
  if (renderNow) render()
}

function upsertPlayer(room, playerId, name) {
  const existing = room.players.find((p) => p.id === playerId)
  if (existing) {
    existing.name = name
    return existing
  }
  const byName = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (byName) {
    byName.name = name
    return byName
  }
  const player = { id: playerId || createPlayerId(), name: name.slice(0, 24) || "Joueur", vote: null }
  room.players.push(player)
  return player
}

function handleHostMessage(conn, message) {
  if (!state.room || state.role !== "host") return
  if (message.type === "join") {
    const player = upsertPlayer(state.room, message.playerId, String(message.name || "").trim())
    touch(state.room)
    connections.set(player.id, conn)
    conn.send({ type: "welcome", playerId: player.id, room: state.room })
    sendState()
    state.sync = "ok"
    render()
    return
  }
  if (message.type === "action") {
    applyAction(message.payload, message.playerId)
  }
}

function handleGuestMessage(message) {
  if (message.type === "welcome") {
    state.playerId = message.playerId
    saveIdentity(message.room.id, message.playerId, state.playerName, "guest")
    applyRoom(message.room)
    state.sync = "ok"
    state.status = ""
    return
  }
  if (message.type === "state") {
    applyRoom(message.room)
    state.sync = "ok"
  }
  if (message.type === "error") {
    state.error = message.error
    state.sync = "bad"
    render()
  }
}

function wireConnection(conn, asHost) {
  conn.on("data", (message) => {
    if (asHost) handleHostMessage(conn, message)
    else handleGuestMessage(message)
  })
  conn.on("close", () => {
    if (asHost) {
      for (const [id, c] of connections) {
        if (c === conn) connections.delete(id)
      }
    } else {
      state.sync = "bad"
      state.status = "Connexion perdue avec l’hôte. Demandez-lui de garder son onglet ouvert."
      render()
    }
  })
  conn.on("error", () => {
    state.sync = "bad"
    render()
  })
}

function destroyPeer() {
  for (const conn of connections.values()) {
    try {
      conn.close()
    } catch {
      /* ignore */
    }
  }
  connections.clear()
  if (peer) {
    try {
      peer.destroy()
    } catch {
      /* ignore */
    }
  }
  peer = null
}

function createPeer(id) {
  return new Peer(id, {
    debug: 0,
  })
}

function waitOpen(p) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Délai de connexion dépassé.")), 12000)
    p.on("open", (id) => {
      clearTimeout(timer)
      resolve(id)
    })
    p.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function startHost(name) {
  destroyPeer()
  const roomId = createRoomId()
  const playerId = createPlayerId()
  const room = emptyRoom(roomId)
  upsertPlayer(room, playerId, name)
  touch(room)

  state.status = "Ouverture de la table…"
  render()

  peer = createPeer(peerIdForRoom(roomId))
  await waitOpen(peer)

  peer.on("connection", (conn) => {
    wireConnection(conn, true)
    conn.on("open", () => {
      // join message arrives after open
    })
  })

  state.room = room
  state.playerId = playerId
  state.playerName = name
  state.role = "host"
  state.activeVoterId = playerId
  state.error = null
  state.sync = "ok"
  state.status = ""
  saveIdentity(roomId, playerId, name, "host")
  setRoomUrl(roomId)
  render()
}

async function startGuest(roomId, name) {
  destroyPeer()
  roomId = roomId.toUpperCase()
  const previous = loadIdentity(roomId)
  const playerId = previous?.playerId || createPlayerId()

  state.status = "Connexion à la table…"
  state.error = null
  render()

  peer = createPeer()
  await waitOpen(peer)

  const conn = peer.connect(peerIdForRoom(roomId), { reliable: true })
  wireConnection(conn, false)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Table introuvable. Vérifiez le code et que l’hôte a la page ouverte.")), 10000)
    conn.on("open", () => {
      clearTimeout(timer)
      resolve()
    })
    conn.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  connections.set("host", conn)
  state.playerName = name
  state.role = "guest"
  state.playerId = playerId
  state.activeVoterId = playerId
  setRoomUrl(roomId)
  saveIdentity(roomId, playerId, name, "guest")
  conn.send({ type: "join", playerId, name })
}

function applyAction(payload, actorId) {
  if (!state.room) return
  const room = state.room
  const action = payload.action

  if (action === "vote") {
    if (room.revealed) return
    const targetId = payload.targetId || actorId
    const target = room.players.find((p) => p.id === targetId)
    if (!target || !CARDS.includes(payload.value)) return
    target.vote = payload.value
  } else if (action === "story") {
    room.story = String(payload.story || "").slice(0, 160)
  } else if (action === "reveal") {
    room.revealed = true
  } else if (action === "reset") {
    room.revealed = false
    room.players.forEach((p) => {
      p.vote = null
    })
  } else if (action === "add_player") {
    const name = String(payload.name || "").trim().slice(0, 24)
    if (!name) return
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return
    room.players.push({ id: createPlayerId(), name, vote: null })
  } else if (action === "remove_player") {
    if (payload.targetId === actorId) return
    room.players = room.players.filter((p) => p.id !== payload.targetId)
  } else if (action === "leave") {
    room.players = room.players.filter((p) => p.id !== actorId)
  } else {
    return
  }

  touch(room)
  if (state.role === "host") {
    sendState()
    render()
  }
}

async function dispatch(payload) {
  if (!state.room) return
  if (state.role === "host") {
    applyAction(payload, state.playerId)
    return
  }
  const conn = connections.get("host")
  if (!conn || !conn.open) {
    state.sync = "bad"
    state.status = "Pas de lien avec l’hôte."
    render()
    return
  }
  conn.send({ type: "action", playerId: state.playerId, payload })
}

function renderLanding() {
  const prefill = roomFromUrl() || ""
  if (prefill && state.mode === "create" && !state.room) {
    // keep mode if user toggled; only default to join when arriving with code
  }
  return `<section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Estimation agile</p>
      <h1 class="brand hero-brand">${brandMark()}</h1>
      <p class="lead">Chacun sur son téléphone ou son ordi. Créez une table, partagez le lien — les votes se synchronisent en direct.</p>
    </div>
    <form class="panel" id="landing-form">
      <h2>${state.mode === "create" ? "Ouvrir une table" : "Rejoindre une table"}</h2>
      <div class="field">
        <label for="name">Votre prénom</label>
        <input id="name" name="name" autocomplete="nickname" placeholder="Alex" maxlength="24" required />
      </div>
      ${
        state.mode === "join"
          ? `<div class="field">
              <label for="room">Code de la table</label>
              <input id="room" name="room" placeholder="AB12" maxlength="8" required value="${escapeHtml(prefill)}" style="letter-spacing:0.18em;font-weight:700" />
            </div>`
          : ""
      }
      <div class="hero-actions">
        <button class="btn btn-primary" type="submit">${state.mode === "create" ? "Créer la table" : "Entrer"}</button>
        <button class="btn btn-ghost" type="button" id="toggle-mode">${state.mode === "create" ? "J’ai un code" : "Nouvelle table"}</button>
      </div>
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
      ${state.status ? `<p class="hint">${escapeHtml(state.status)}</p>` : ""}
      <p class="hint">La personne qui crée la table doit laisser l’onglet ouvert.</p>
    </form>
  </section>`
}

function renderRoom() {
  const room = state.room
  const me = room.players.find((p) => p.id === state.playerId)
  const active = room.players.find((p) => p.id === state.activeVoterId) || me
  const votedCount = room.players.filter((p) => p.vote != null).length
  const allVoted = room.players.length > 0 && votedCount === room.players.length
  const stats = computeStats(room.players)
  const syncClass = state.sync === "ok" ? "ok" : state.sync === "bad" ? "bad" : ""

  return `
    <header class="topbar">
      ${brandMark(true)}
      <div style="display:flex;flex-wrap:wrap;gap:0.65rem;align-items:center">
        <span class="room-chip">Table <code>${escapeHtml(room.id)}</code></span>
        <span class="sync ${syncClass}">${state.sync === "ok" ? (state.role === "host" ? "Hôte · en ligne" : "Connecté") : state.sync === "bad" ? "Déconnecté" : "…"}</span>
        <button class="btn btn-ghost" type="button" data-action="copy">${state.copied ? "Lien copié" : "Copier le lien"}</button>
        <button class="btn btn-danger" type="button" data-action="leave">${state.confirmLeave ? "Confirmer la sortie" : "Quitter"}</button>
      </div>
    </header>

    ${state.status ? `<p class="error">${escapeHtml(state.status)}</p>` : ""}

    <div class="story-bar">
      <label class="eyebrow" for="story">User story</label>
      <input id="story" value="${escapeHtml(room.story)}" placeholder="Ex. En tant qu’utilisateur, je peux réinitialiser mon mot de passe" maxlength="160" />
    </div>

    <form class="join-row" id="add-form">
      <div class="field">
        <label for="add-player">Ajouter un joueur (même écran)</label>
        <input id="add-player" maxlength="24" placeholder="Prénom" />
      </div>
      <button class="btn btn-ghost" type="submit">Ajouter</button>
    </form>

    <section class="table" aria-label="Table de vote">
      <div class="players">
        ${room.players
          .map((player) => {
            const isActive = player.id === (active && active.id)
            const isMe = player.id === state.playerId
            return `<div class="seat">
              <button type="button" class="seat-pick" data-action="select" data-id="${player.id}" ${room.revealed ? "disabled" : ""} style="${isActive && !room.revealed ? "outline:2px solid var(--amber);outline-offset:4px" : ""}" aria-label="Voter pour ${escapeHtml(player.name)}">
                ${pokerCard(player.vote, room.revealed)}
              </button>
              <div class="seat-name${isMe ? " me" : ""}">${escapeHtml(player.name)}${isMe ? " (vous)" : ""}${isActive && !room.revealed ? " · vote" : ""}</div>
              ${!isMe ? `<button type="button" class="btn btn-ghost" style="min-height:2rem;padding:0.25rem 0.7rem;font-size:0.78rem" data-action="remove" data-id="${player.id}">Retirer</button>` : ""}
            </div>`
          })
          .join("")}
      </div>

      <p class="hint" style="text-align:center;margin-top:0">
        ${
          room.revealed
            ? "Votes révélés"
            : active
              ? `${escapeHtml(active.name)} choisit une carte · ${votedCount}/${room.players.length} votes`
              : "En attente de joueurs"
        }
      </p>

      <div class="hand" role="group" aria-label="Main de cartes">
        ${CARDS.map((value) => {
          const selected = active && active.vote === value
          return `<button type="button" class="hand-card${selected ? " selected" : ""}" data-action="vote" data-value="${escapeHtml(value)}" ${room.revealed || !active ? "disabled" : ""}>${escapeHtml(value)}</button>`
        }).join("")}
      </div>

      <div class="actions">
        ${
          room.revealed
            ? `<button class="btn btn-primary" type="button" data-action="reset">Nouvelle manche</button>`
            : `<button class="btn btn-primary" type="button" data-action="reveal" ${votedCount === 0 ? "disabled" : ""}>${allVoted ? "Révéler les cartes" : "Révéler quand même"}</button>`
        }
      </div>

      ${
        room.revealed
          ? `
        ${stats.consensus ? `<div class="banner">Consensus : ${escapeHtml(stats.consensus)}</div>` : ""}
        ${!stats.consensus && stats.spread ? `<div class="banner warn">Écart important — à discuter avant de trancher.</div>` : ""}
        ${stats.coffeeCount > 0 ? `<div class="banner">Pause café demandée (${stats.coffeeCount})</div>` : ""}
        <div class="stats">
          <div class="stat"><span>Moyenne</span><strong>${stats.average == null ? "—" : formatPoints(stats.average)}</strong></div>
          <div class="stat"><span>Médiane</span><strong>${stats.median == null ? "—" : formatPoints(stats.median)}</strong></div>
          <div class="stat"><span>Votes</span><strong>${votedCount}</strong></div>
          <div class="stat"><span>Incertains</span><strong>${stats.questionCount}</strong></div>
        </div>`
          : ""
      }
    </section>
  `
}

function render() {
  app.innerHTML = state.room && state.playerId ? renderRoom() : renderLanding()
  bind()
}

function bind() {
  const landing = document.getElementById("landing-form")
  if (landing) {
    landing.addEventListener("submit", async (event) => {
      event.preventDefault()
      const name = landing.name.value.trim()
      state.error = null
      try {
        if (state.mode === "create") await startHost(name)
        else await startGuest(landing.room.value.trim().toUpperCase(), name)
      } catch (error) {
        state.error = error.message || String(error)
        state.status = ""
        destroyPeer()
        render()
      }
    })
    document.getElementById("toggle-mode")?.addEventListener("click", () => {
      state.mode = state.mode === "create" ? "join" : "create"
      state.error = null
      render()
    })
  }

  document.getElementById("story")?.addEventListener("input", (event) => {
    const story = event.target.value
    if (state.room) state.room.story = story
    clearTimeout(storyTimer)
    storyTimer = setTimeout(() => {
      dispatch({ action: "story", story }).catch(() => {})
    }, 250)
  })

  document.getElementById("add-form")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const input = document.getElementById("add-player")
    const name = input.value.trim()
    if (!name) return
    await dispatch({ action: "add_player", name })
    input.value = ""
  })

  app.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", onActionClick)
  })
}

async function onActionClick(event) {
  const button = event.currentTarget
  const type = button.dataset.action
  try {
    if (type === "copy") {
      const url = new URL(window.location.href)
      url.searchParams.set("salle", state.room.id)
      await navigator.clipboard.writeText(url.toString())
      state.copied = true
      render()
      setTimeout(() => {
        state.copied = false
        if (state.room) render()
      }, 2000)
      return
    }
    if (type === "leave") {
      if (!state.confirmLeave) {
        state.confirmLeave = true
        render()
        return
      }
      const roomId = state.room.id
      await dispatch({ action: "leave" })
      clearIdentity(roomId)
      destroyPeer()
      state.room = null
      state.playerId = null
      state.activeVoterId = null
      state.role = null
      state.confirmLeave = false
      clearRoomUrl()
      render()
      return
    }
    if (type === "select") {
      state.activeVoterId = button.dataset.id
      render()
      return
    }
    if (type === "vote") {
      await dispatch({
        action: "vote",
        value: button.dataset.value,
        targetId: state.activeVoterId || state.playerId,
      })
      return
    }
    if (type === "reveal") {
      await dispatch({ action: "reveal" })
      return
    }
    if (type === "reset") {
      await dispatch({ action: "reset" })
      return
    }
    if (type === "remove") {
      await dispatch({ action: "remove_player", targetId: button.dataset.id })
    }
  } catch (error) {
    alert(error.message || String(error))
  }
}

async function boot() {
  const roomId = roomFromUrl()
  if (roomId) state.mode = "join"
  render()
}

boot()
