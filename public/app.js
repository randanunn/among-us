'use strict';

const PLAYER_ID_KEY = 'amongus.playerId';
const NAME_KEY = 'amongus.name';
const SEEN_ROLE_KEY = 'amongus.seenRole';
const SEEN_RESULT_KEY = 'amongus.seenResult';
const CONFIRM_MS = 3000;
const PEEK_MS = 3000;
const VOTE_TIMES = [30, 60, 90, 120, 180, 240, 300];
const COOLDOWNS = [0, 10, 15, 30, 60];

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const playerId = loadPlayerId();

let ws = null;
let online = false;
let reconnectTimer = null;
let reconnectDelay = 500;
let state = null;
let heardFromServer = false;
let buildId = null;
let roomCode = location.hash.slice(1).toUpperCase() || null;
let meetingEndsAt = 0;
let cooldownUntil = 0;
let revealing = false; // the role reveal has been tapped open
let pickingBody = false;
let peekUntil = 0;
let confirming = null; // { key, until } for two-tap actions
let toastTimer = null;
const openDetails = new Set();

function loadPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    // crypto.randomUUID needs HTTPS; getRandomValues also works over plain http on the LAN.
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------- connection

function connect() {
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = socket;
  socket.onopen = () => {
    online = true;
    reconnectDelay = 500;
    send({ type: 'hello', playerId, room: roomCode });
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'build') onBuild(message.id);
    else if (message.type === 'state') onState(message);
    else if (message.type === 'error') onError(message.message);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    online = false;
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
}

// Phones freeze background tabs and their sockets can go stale; reconnect fresh on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const old = ws;
  ws = null;
  old?.close();
  connect();
});

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else showToast('Reconnecting… try again in a sec');
}

function onState({ room, state: next, missingRoom }) {
  if (missingRoom) showToast(`No game with code ${missingRoom}`);
  roomCode = room;
  history.replaceState(null, '', room ? `#${room}` : location.pathname);

  heardFromServer = true;
  const prev = state;
  state = next;
  if (!next) return render();

  meetingEndsAt = next.meeting ? Date.now() + next.meeting.remainingMs : 0;
  cooldownUntil = Date.now() + next.meetingCooldownMs;
  if (next.phase !== 'playing') pickingBody = false;

  // Buzz when something happens that everyone needs to look at.
  if (prev && prev.phase !== next.phase && ['playing', 'meeting', 'gameover'].includes(next.phase)) {
    if (next.phase !== 'playing' || prev.phase !== 'meeting') navigator.vibrate?.(300);
  }
  if (prev?.gameNumber !== next.gameNumber) revealing = false;

  render();
}

/**
 * An open page keeps running its old code when it reconnects to a newly deployed server,
 * so reload to pick up the matching client. The room and player id survive the reload.
 */
function onBuild(id) {
  if (buildId !== null && buildId !== id) location.reload();
  buildId = id;
}

function onError(message) {
  showToast(message);
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

// The vote timer, meeting cooldown, and role peek count down on screen.
setInterval(() => {
  if (!state) return;
  const now = Date.now();
  if (state.meeting || now < cooldownUntil + 1000 || now < peekUntil + 1000) render();
}, 500);

// ---------------------------------------------------------------- actions

function enteredName() {
  const name = document.getElementById('name').value.trim();
  if (!name) showToast('Enter your name');
  else localStorage.setItem(NAME_KEY, name);
  return name;
}

const roleKey = () => `${roomCode}:${state.gameNumber}`;
const resultKey = () => `${roomCode}:${state.gameNumber}:${state.lastResult?.number}`;

const actions = {
  create() {
    const name = enteredName();
    if (name) send({ type: 'create', name });
  },
  findRoom() {
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!code) return showToast('Enter the room code');
    send({ type: 'hello', playerId, room: code });
  },
  join() {
    const name = enteredName();
    if (name) send({ type: 'join', name });
  },
  share() {
    navigator.share?.({ title: 'Among Us', text: `Join my Among Us game: ${roomCode}`, url: shareUrl() }).catch(() => {});
  },
  step(value) {
    const [key, delta] = value.split(':');
    send({ type: 'settings', [key]: state.settings[key] + Number(delta) });
  },
  taskMode(mode) {
    send({ type: 'settings', taskMode: mode });
  },
  lock() {
    send({ type: 'lock' });
  },
  unlock() {
    send({ type: 'unlock' });
  },
  addTask() {
    const input = document.getElementById('task');
    const text = input.value.trim();
    if (!text) return showToast('Type a task first');
    send({ type: 'addTask', text });
    input.value = '';
    input.focus();
  },
  deleteTask(id) {
    withConfirm(`deleteTask:${id}`, () => send({ type: 'deleteTask', taskId: Number(id) }));
  },
  start() {
    send({ type: 'start' });
  },
  reveal() {
    revealing = true;
    render();
  },
  gotRole() {
    localStorage.setItem(SEEN_ROLE_KEY, roleKey());
    render();
  },
  toggleTask(index) {
    const task = state.you.tasks[Number(index)];
    send({ type: 'task', index: Number(index), done: !task.done });
  },
  peek() {
    peekUntil = Date.now() + PEEK_MS;
    render();
  },
  meeting() {
    withConfirm('meeting', () => send({ type: 'meeting' }));
  },
  pickBody() {
    pickingBody = !pickingBody;
    render();
  },
  reportBody(id) {
    withConfirm(`body:${id}`, () => {
      send({ type: 'reportBody', playerId: id });
      pickingBody = false;
      showToast(`Reported. Call a meeting to tell everyone.`);
    });
  },
  undoDeath() {
    withConfirm('undoDeath', () => send({ type: 'undoDeath' }));
  },
  vote(id) {
    send({ type: 'vote', playerId: id || null });
  },
  seenResult() {
    localStorage.setItem(SEEN_RESULT_KEY, resultKey());
    render();
  },
  remove(id) {
    withConfirm(`remove:${id}`, () => send({ type: 'remove', playerId: id }));
  },
  leave() {
    withConfirm('leave', () => send({ type: 'leave' }));
  },
  back() {
    send({ type: 'leave' });
  },
  playAgain() {
    send({ type: 'playAgain' });
  },
};

/** Final actions need a second tap within a few seconds. */
function withConfirm(key, action) {
  if (isConfirming(key)) {
    confirming = null;
    action();
  } else {
    confirming = { key, until: Date.now() + CONFIRM_MS };
    setTimeout(render, CONFIRM_MS + 50);
  }
  render();
}

function isConfirming(key) {
  return confirming?.key === key && Date.now() < confirming.until;
}

app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  actions[button.dataset.action]?.(button.dataset.value);
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  actions[event.target.dataset.submit]?.();
});

app.addEventListener('change', (event) => {
  const setting = event.target.dataset.setting;
  if (setting) send({ type: 'settings', [setting]: Number(event.target.value) });
});

// `toggle` doesn't bubble, so listen in the capture phase.
app.addEventListener(
  'toggle',
  (event) => {
    if (!event.target.id) return;
    if (event.target.open) openDetails.add(event.target.id);
    else openDetails.delete(event.target.id);
  },
  true,
);

// ---------------------------------------------------------------- rendering

/**
 * Replaces only the top-level sections that changed, so a half-typed name or task
 * survives other players' updates.
 */
function render() {
  const template = document.createElement('template');
  template.innerHTML = view();
  const next = [...template.content.children];
  const current = [...app.children];
  next.forEach((node, i) => {
    if (!current[i]) app.appendChild(node);
    else if (!current[i].isEqualNode(node)) current[i].replaceWith(node);
  });
  for (const stale of current.slice(next.length)) stale.remove();
}

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isHost = () => state.youAreHost;
const openAttr = (id) => (openDetails.has(id) ? 'open' : '');
const waitingFor = (what) => `<p class="muted center">Waiting for ${esc(state.hostName)} to ${what}…</p>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seconds = (s) => (s % 60 === 0 ? `${s / 60} min` : s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const clock = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const savedName = () => esc(localStorage.getItem(NAME_KEY) ?? '');
const shareUrl = () => `${location.origin}${location.pathname}#${roomCode}`;

function view() {
  if (!heardFromServer) return '<p class="muted center">Connecting…</p>';
  const banner = online ? '' : '<div class="offline-bar">Reconnecting…</div>';
  if (!state) return banner + homeView();
  if (!state.youId) return banner + (state.phase === 'lobby' ? joinView() : lockedView());
  const views = { lobby: lobbyView, tasks: taskEntryView, playing: playingView, meeting: meetingView, gameover: gameOverView };
  return banner + views[state.phase]();
}

function nameInput() {
  return `<input id="name" placeholder="Your name" maxlength="20" autocomplete="off" autocapitalize="words" enterkeyhint="go" value="${savedName()}" />`;
}

function homeView() {
  return `
    <h1>AMONG US</h1>
    <form class="panel stack" data-submit="create">
      <h2>New game</h2>
      ${nameInput()}
      <button class="primary big" type="submit">Start a new game</button>
    </form>
    <form class="panel stack" data-submit="findRoom">
      <h2>Join a friend's game</h2>
      <input id="code" placeholder="Room code" maxlength="4" autocomplete="off" autocapitalize="characters" enterkeyhint="go" class="code-input" />
      <button class="big" type="submit">Find game</button>
    </form>
    ${rulesPanel()}`;
}

function joinView() {
  return `
    <h1>AMONG US</h1>
    <form class="panel stack" data-submit="join">
      <h2>Join game ${esc(roomCode)}</h2>
      ${nameInput()}
      <button class="primary big" type="submit">Join</button>
    </form>
    ${state.players.length ? `<section class="panel"><h2>Already here</h2>${playerList()}</section>` : ''}
    ${rulesPanel()}
    <button class="link" data-action="back">← Back</button>`;
}

function lockedView() {
  return `
    <h1>AMONG US</h1>
    <section class="panel stack center">
      <p>🔒 Room ${esc(roomCode)} is locked${state.phase === 'tasks' ? ' while everyone adds tasks' : ' because a game is going'}.</p>
      <p class="muted">You can join when they're back in the waiting room. Keep this page open.</p>
    </section>
    <button class="link" data-action="back">← Back</button>`;
}

// ---------------------------------------------------------------- waiting room

function lobbyView() {
  const { minPlayers, maxPlayers } = state.limits;
  const count = state.players.length;
  const manual = state.settings.taskMode === 'manual';
  const tooManyImposters = state.settings.imposters > state.maxImposters;
  const ready = count >= minPlayers && !tooManyImposters;
  const blocker =
    count < minPlayers
      ? `Need at least ${minPlayers} players.`
      : tooManyImposters
        ? `${count} players can only have ${plural(state.maxImposters, 'imposter')}.`
        : '';

  return `
    <h1>AMONG US</h1>
    <section class="panel stack center">
      <h2>Room code</h2>
      <div class="room-code">${esc(roomCode)}</div>
      <p class="muted">Friends can tap <b>Join a friend's game</b> and enter this code, or open<br />${esc(shareUrl())}</p>
      ${navigator.share ? '<button data-action="share">Share invite link</button>' : ''}
    </section>
    <section class="panel">
      <h2>Players (${count}/${maxPlayers})</h2>
      ${playerList({ removable: true })}
    </section>
    ${settingsPanel()}
    ${
      isHost()
        ? `<button class="primary big" data-action="${manual ? 'lock' : 'start'}" ${ready ? '' : 'disabled'}>
             ${manual ? '🔒 Lock room & add tasks' : 'Start game'}
           </button>
           ${blocker ? `<p class="muted center">${blocker}</p>` : ''}`
        : waitingFor(manual ? 'lock the room' : 'start the game')
    }
    ${rulesPanel()}
    ${leaveButton()}`;
}

function settingsPanel() {
  const s = state.settings;
  const { maxMeetings, maxCooldownSeconds } = state.limits;
  if (!isHost()) {
    return `
      <section class="panel stack">
        <h2>Settings</h2>
        <p>${plural(s.imposters, 'imposter')} · ${s.taskMode === 'manual' ? '✍️ Players write the tasks' : '🎲 Automatic tasks'}</p>
        <p class="muted">${seconds(s.voteSeconds)} to vote · ${plural(s.meetingsPerPlayer, 'emergency meeting')} each · ${s.cooldownSeconds}s meeting cooldown</p>
      </section>`;
  }
  const stepper = (key, min, max) => `
    <div class="stepper">
      <button data-action="step" data-value="${key}:-1" ${s[key] <= min ? 'disabled' : ''} aria-label="Fewer">−</button>
      <span class="value">${s[key]}</span>
      <button data-action="step" data-value="${key}:1" ${s[key] >= max ? 'disabled' : ''} aria-label="More">+</button>
    </div>`;
  const select = (key, options, label) => `
    <select data-setting="${key}">
      ${[...new Set([...options, s[key]])]
        .sort((a, b) => a - b)
        .map((v) => `<option value="${v}" ${v === s[key] ? 'selected' : ''}>${label(v)}</option>`)
        .join('')}
    </select>`;
  const modes = { auto: '🎲 Automatic', manual: '✍️ Manual' };
  return `
    <section class="panel stack">
      <h2>Settings</h2>
      <div class="setting">
        <span class="label">Imposters<small>Up to ${state.maxImposters} with ${plural(state.players.length, 'player')}</small></span>
        ${stepper('imposters', 1, Math.max(s.imposters, state.maxImposters))}
      </div>
      ${
        state.phase === 'lobby'
          ? `<div class="label">Tasks</div>
             <div class="segmented">
               ${Object.entries(modes)
                 .map(([mode, label]) => `<button class="${s.taskMode === mode ? 'selected' : ''}" data-action="taskMode" data-value="${mode}">${label}</button>`)
                 .join('')}
             </div>
             <p class="muted">${s.taskMode === 'manual' ? 'You lock the room, then everyone writes tasks before the game starts.' : 'Everyone gets 3 tasks from around the house.'}</p>`
          : ''
      }
      <div class="setting">
        <span class="label">Vote timer</span>
        ${select('voteSeconds', VOTE_TIMES, seconds)}
      </div>
      <div class="setting">
        <span class="label">Emergency meetings<small>Per player. Free after a body is found.</small></span>
        ${stepper('meetingsPerPlayer', 0, maxMeetings)}
      </div>
      <div class="setting">
        <span class="label">Meeting cooldown<small>After the start and each meeting</small></span>
        ${select('cooldownSeconds', COOLDOWNS.filter((c) => c <= maxCooldownSeconds), (v) => `${v}s`)}
      </div>
    </section>`;
}

function taskEntryView() {
  const pool = state.taskPool;
  const needed = state.tasksNeeded;
  const enough = pool.length >= needed;
  const tooManyImposters = state.settings.imposters > state.maxImposters;
  const items = pool
    .map((t) => {
      const key = `deleteTask:${t.id}`;
      return `
        <li>
          <span class="text">${esc(t.text)}<span class="by">by ${esc(t.by)}</span></span>
          <button class="small ${isConfirming(key) ? 'confirm' : ''}" data-action="deleteTask" data-value="${t.id}">${isConfirming(key) ? 'Delete?' : '✕'}</button>
        </li>`;
    })
    .reverse()
    .join('');
  return `
    <h1>AMONG US</h1>
    <section class="panel stack">
      <div class="row spread"><strong>🔒 Room ${esc(roomCode)} locked</strong><span class="badge">${plural(state.players.length, 'player')}</span></div>
      <div class="row spread"><span>${pool.length} of ${needed} tasks</span><span class="muted">${enough ? 'Enough!' : `${needed - pool.length} more needed`}</span></div>
      <div class="progress"><div class="fill" style="width: ${Math.min(100, (pool.length / needed) * 100)}%"></div></div>
    </section>
    <form class="panel stack" data-submit="addTask">
      <h2>Add a task</h2>
      <input id="task" placeholder="Wash dishes at the kitchen sink" maxlength="120" autocomplete="off" enterkeyhint="done" />
      <button class="primary" type="submit">Add task</button>
      <p class="muted">One sentence: something specific, somewhere in the house, that takes 30 seconds to a minute.</p>
    </form>
    ${
      isHost()
        ? `<button class="primary big" data-action="start" ${enough && !tooManyImposters ? '' : 'disabled'}>Start game</button>
           ${tooManyImposters ? `<p class="muted center">${plural(state.players.length, 'player')} can only have ${plural(state.maxImposters, 'imposter')}.</p>` : ''}`
        : waitingFor('start the game')
    }
    <section class="panel">
      <h2>Tasks (${pool.length})</h2>
      ${items ? `<ul class="task-pool">${items}</ul>` : '<p class="muted">No tasks yet. Anyone can add them, and one person can add them all.</p>'}
    </section>
    ${settingsPanel()}
    <section class="panel"><h2>Players</h2>${playerList({ removable: true })}</section>
    ${isHost() ? '<button class="link" data-action="unlock">🔓 Unlock room to let more people join</button>' : ''}
    ${leaveButton()}`;
}

// ---------------------------------------------------------------- playing

function playingView() {
  if (localStorage.getItem(SEEN_ROLE_KEY) !== roleKey()) return roleRevealView();
  if (state.lastResult && localStorage.getItem(SEEN_RESULT_KEY) !== resultKey()) return resultView();
  const you = state.you;
  return `
    ${countsBar()}
    ${deadBanner()}
    <section class="panel">
      <h2>Your tasks</h2>
      <ul class="task-list">
        ${you.tasks
          .map(
            (t, i) => `
              <li><button class="${t.done ? 'done' : ''}" data-action="toggleTask" data-value="${i}">
                <span class="check">${t.done ? '✓' : ''}</span><span class="text">${esc(t.text)}</span>
              </button></li>`,
          )
          .join('')}
      </ul>
    </section>
    ${you.death ? '' : actionsPanel()}
    ${peekPanel()}
    <section class="panel"><h2>Players</h2>${playerList()}</section>
    ${state.lastResult ? `<details id="last-vote" class="panel" ${openAttr('last-vote')}><summary>Last vote</summary>${voteBreakdown(state.lastResult)}</details>` : ''}
    ${rulesPanel()}
    ${leaveButton()}`;
}

/** Looks the same for crewmates and imposters until it's tapped, so it's safe if someone glances over. */
function roleRevealView() {
  const you = state.you;
  if (!revealing) {
    return `
      <section class="panel role-card">
        <div style="font-size: 64px">🤫</div>
        <p class="role-name">SHHH</p>
        <p>Hide your screen, then tap to see your role.</p>
        <button class="primary big" data-action="reveal">Show my role</button>
      </section>`;
  }
  const imposter = you.role === 'imposter';
  const total = state.counts.imposters;
  const detail = imposter
    ? you.fellowImposters.length
      ? `<p>The other imposter${you.fellowImposters.length === 1 ? ' is' : 's are'}:<br /><b>${you.fellowImposters.map(esc).join(', ')}</b></p>`
      : '<p>You are the only imposter.</p>'
    : `<p>There ${total === 1 ? 'is 1 imposter' : `are ${total} imposters`} among us.</p>`;
  const goal = imposter
    ? 'Pretend to do your tasks. Secretly "kill" crewmates without getting caught.'
    : `Do your tasks and figure out who ${total === 1 ? 'the imposter is' : 'the imposters are'}.`;
  return `
    <section class="panel role-card">
      <p class="muted">You are</p>
      <p class="role-name ${imposter ? 'imposter' : 'crew'}">${imposter ? '🔪 IMPOSTER' : '👩‍🚀 CREWMATE'}</p>
      ${detail}
      <p class="muted">${goal}</p>
      <button class="primary big" data-action="gotRole">Got it</button>
    </section>`;
}

function countsBar() {
  const { crew, imposters } = state.counts;
  const { done, total } = state.progress;
  return `
    <section class="panel stack">
      <div class="counts">
        <span class="badge crew">👩‍🚀 ${plural(crew, 'crewmate')}</span>
        <span class="badge imposter">🔪 ${plural(imposters, 'imposter')}</span>
      </div>
      <div class="row spread"><span class="muted">Crew tasks</span><span>${done} / ${total}</span></div>
      <div class="progress"><div class="fill" style="width: ${total ? (done / total) * 100 : 0}%"></div></div>
    </section>`;
}

function deadBanner() {
  const death = state.you.death;
  if (!death) return '';
  const undo = isConfirming('undoDeath');
  return `
    <section class="panel stack dead-banner">
      <div class="ghost">👻 You're dead</div>
      <p class="muted">${death === 'ejected' ? 'You were voted out.' : 'Someone reported finding your body.'} Keep doing your tasks, but you can't vote or call meetings.</p>
      ${death === 'killed' ? `<button class="${undo ? 'confirm' : ''}" data-action="undoDeath">${undo ? "Tap again: I'm really not dead" : "I'm not dead"}</button>` : ''}
    </section>`;
}

function actionsPanel() {
  const you = state.you;
  const wait = cooldownUntil - Date.now();
  const coolingDown = wait > 0;
  const confirmMeeting = isConfirming('meeting');
  const meetingLabel = coolingDown
    ? `🚨 Meetings open in ${Math.ceil(wait / 1000)}s`
    : !you.canCallMeeting
      ? '🚨 No emergency meetings left'
      : confirmMeeting
        ? 'Tap again to call a meeting'
        : '🚨 Emergency meeting';
  const candidates = state.players.filter((p) => p.id !== state.youId && !p.death);
  const bodyPicker = pickingBody
    ? `
      <p class="muted center">Whose body did you find?</p>
      <div class="vote-list stack">
        ${candidates
          .map((p) => {
            const key = `body:${p.id}`;
            return `<button class="${isConfirming(key) ? 'confirm' : ''}" data-action="reportBody" data-value="${esc(p.id)}">
              <span class="name">${isConfirming(key) ? `Tap again: ${esc(p.name)} is dead` : esc(p.name)}</span></button>`;
          })
          .join('')}
      </div>
      <button class="link" data-action="pickBody">Cancel</button>`
    : '<button data-action="pickBody">💀 Found a dead body</button>';
  return `
    <section class="panel stack">
      <button class="big emergency ${confirmMeeting ? 'confirm' : ''}" data-action="meeting" ${coolingDown || !you.canCallMeeting ? 'disabled' : ''}>${meetingLabel}</button>
      <p class="muted center">${plural(you.meetingsLeft, 'emergency meeting')} left</p>
      ${bodyPicker}
    </section>`;
}

/** Anyone can peek at their role. It hides itself again after a few seconds. */
function peekPanel() {
  const you = state.you;
  if (Date.now() >= peekUntil) return '<button class="link" data-action="peek">👁 Peek at my role</button>';
  const imposter = you.role === 'imposter';
  const others = imposter && you.fellowImposters.length ? ` with ${you.fellowImposters.map(esc).join(', ')}` : '';
  return `<p class="center peek"><span class="tag ${imposter ? 'imposter' : 'crew'}">${imposter ? '🔪 Imposter' : '👩‍🚀 Crewmate'}</span>${others}</p>`;
}

function resultView() {
  const r = state.lastResult;
  const ejected = r.ejected;
  const headline = ejected
    ? `<div class="result-banner">${esc(ejected.name)} was voted out.</div>
       <div class="result-banner ${ejected.role === 'imposter' ? 'imposter' : 'crew'}">${ejected.role === 'imposter' ? '🔪 They were an imposter!' : '👩‍🚀 They were not an imposter.'}</div>`
    : `<div class="result-banner">Nobody was voted out.</div>
       <p class="muted">${r.tie ? "It's a tie." : 'Everyone skipped.'}</p>`;
  return `
    <section class="panel stack center">
      ${headline}
      <p>${plural(r.crewLeft, 'crewmate')} and ${plural(r.impostersLeft, 'imposter')} left.</p>
    </section>
    <section class="panel"><h2>Votes</h2>${voteBreakdown(r)}</section>
    <button class="primary big" data-action="seenResult">Back to tasks</button>`;
}

/** Who voted for whom, grouped by who they picked, most votes first. */
function voteBreakdown(result) {
  const groups = new Map();
  for (const v of result.votes) {
    const label = v.targetName ? esc(v.targetName) : v.voted ? '<span class="muted">Skipped</span>' : '<span class="muted">Didn\'t vote</span>';
    const key = v.targetId ?? (v.voted ? '~skip' : '~none');
    if (!groups.has(key)) groups.set(key, { label, voters: [], player: !!v.targetId });
    groups.get(key).voters.push(esc(v.voterName));
  }
  const items = [...groups.values()]
    .sort((a, b) => Number(b.player) - Number(a.player) || b.voters.length - a.voters.length)
    .map((g) => `<li><span class="count">${g.voters.length}</span><b>${g.label}</b><br /><span class="muted">${g.voters.join(', ')}</span></li>`)
    .join('');
  return `<ul class="vote-groups">${items}</ul>`;
}

// ---------------------------------------------------------------- meeting

function meetingView() {
  const m = state.meeting;
  const remaining = Math.max(0, meetingEndsAt - Date.now());
  const alive = state.players.filter((p) => !p.death);
  const dead = state.players.filter((p) => p.death);
  const canVote = !state.you.death;
  const voted = new Set(m.votedIds);
  const choice = (id, label, extra = '') => {
    const selected = m.youVoted && m.yourVote === id;
    return `<button class="${selected ? 'selected' : ''}" data-action="vote" data-value="${esc(id ?? '')}" ${canVote ? '' : 'disabled'}>
      <span class="name">${label}</span>${extra}${selected ? '<span>🗳️</span>' : ''}</button>`;
  };
  return `
    <section class="panel stack center">
      <div class="result-banner imposter">🚨 EMERGENCY MEETING</div>
      <p class="muted">Called by ${esc(m.calledBy)}</p>
      <div class="timer ${remaining < 15_000 ? 'low' : ''}">${clock(remaining)}</div>
      <p class="muted">${voted.size} of ${alive.length} voted</p>
    </section>
    ${countsBar()}
    ${deadBanner()}
    <section class="panel stack">
      <h2>${canVote ? 'Vote' : 'Votes'}</h2>
      <div class="vote-list stack">
        ${alive
          .map((p) =>
            choice(
              p.id,
              `${esc(p.name)}${p.id === state.youId ? ' <span class="tag you">(you)</span>' : ''}`,
              voted.has(p.id) ? '<span class="tag">voted</span>' : '',
            ),
          )
          .join('')}
        ${choice(null, '⏭️ Skip')}
      </div>
      ${canVote ? '<p class="muted center">You can change your vote until time runs out.</p>' : ''}
    </section>
    ${dead.length ? `<section class="panel"><h2>Dead</h2><p>${dead.map((p) => `💀 ${esc(p.name)}`).join('<br />')}</p></section>` : ''}
    ${leaveButton()}`;
}

// ---------------------------------------------------------------- game over

function gameOverView() {
  const w = state.winner;
  const crewWon = w.team === 'crew';
  const youWon = state.you && (state.you.role === 'imposter') !== crewWon;
  const result = w.afterVote && state.lastResult;
  return `
    <h1>AMONG US</h1>
    <section class="panel stack center">
      <div class="result-banner ${crewWon ? 'crew' : 'imposter'}">${crewWon ? '👩‍🚀 Crewmates win!' : '🔪 Imposters win!'}</div>
      <p>${esc(w.reason)}</p>
      ${result?.ejected ? `<p class="muted">${esc(result.ejected.name)} was voted out and was ${result.ejected.role === 'imposter' ? 'an imposter' : 'not an imposter'}.</p>` : ''}
      ${state.you ? `<p><b>${youWon ? '🎉 You won!' : 'You lost.'}</b></p>` : ''}
    </section>
    <section class="panel"><h2>Who was who</h2>${playerList({ roles: true })}</section>
    ${result ? `<section class="panel"><h2>Final vote</h2>${voteBreakdown(result)}</section>` : ''}
    ${isHost() ? '<button class="primary big" data-action="playAgain">Play again</button>' : waitingFor('start a new game')}
    ${leaveButton()}`;
}

// ---------------------------------------------------------------- shared

function playerList({ removable = false, roles = false } = {}) {
  const items = state.players.map((p) => {
    const classes = [p.connected ? '' : 'offline', p.death ? 'dead' : ''].join(' ');
    const removeKey = `remove:${p.id}`;
    const removeButton =
      removable && isHost() && p.id !== state.youId
        ? `<button class="small ${isConfirming(removeKey) ? 'confirm' : ''}" data-action="remove" data-value="${esc(p.id)}">
             ${isConfirming(removeKey) ? 'Remove?' : '✕'}
           </button>`
        : '';
    const role = roles && p.role ? `<span class="tag ${p.role}">${p.role === 'imposter' ? '🔪 Imposter' : '👩‍🚀 Crew'}</span>` : '';
    return `
      <li class="${classes}">
        ${p.id === state.hostId ? '<span title="Host">👑</span>' : ''}
        ${p.death ? '<span>💀</span>' : ''}
        <span class="name">
          ${esc(p.name)}
          ${p.id === state.youId ? '<span class="tag you">(you)</span>' : ''}
          ${p.connected ? '' : '<span class="tag">offline</span>'}
        </span>
        ${role}
        ${removeButton}
      </li>`;
  });
  return `<ul class="players">${items.join('')}</ul>`;
}

function rulesPanel() {
  return `
    <details id="rules" class="panel" ${openAttr('rules')}>
      <summary>How to play</summary>
      <ul class="rules">
        <li>Everyone gets 3 tasks around the house. Imposters get tasks too, so nobody can tell from their phone.</li>
        <li>Crewmates do their tasks and check them off. If every crewmate task is done, the crew wins.</li>
        <li>Imposters pretend to do tasks while secretly "killing" crewmates (tag them quietly). Dead players stay put.</li>
        <li>Found a body? Tap <b>Found a dead body</b> and pick who it was, then call an <b>Emergency meeting</b> to tell everyone.</li>
        <li>In a meeting, discuss and vote. The player with the most votes is out. A tie, or everyone skipping, means nobody is.</li>
        <li>Crew wins if every imposter is voted out. Imposters win once they equal the crewmates.</li>
        <li>Dead players keep doing tasks but can't vote or call meetings. Reported dead by mistake? Tap <b>I'm not dead</b>.</li>
      </ul>
    </details>`;
}

function leaveButton() {
  return `<button class="link" data-action="leave">${isConfirming('leave') ? 'Tap again to leave the game' : 'Leave game'}</button>`;
}

connect();
