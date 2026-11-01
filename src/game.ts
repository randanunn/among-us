import { randomInt } from 'node:crypto';
import { AUTO_TASKS } from './tasks.ts';

export type Phase = 'lobby' | 'tasks' | 'playing' | 'meeting' | 'gameover';
export type Role = 'crew' | 'imposter';
export type Team = 'crew' | 'imposters';
export type TaskMode = 'auto' | 'manual';
/** 'killed' when the player marked themselves killed (they can undo it); 'ejected' when voted out. */
export type Death = 'killed' | 'ejected';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 20;
export const DEFAULT_TASKS_PER_PLAYER = 3;
export const MAX_TASKS_PER_PLAYER = 10;
/** Each imposter past the first needs this many more crewmates. */
export const CREW_PER_EXTRA_IMPOSTER = 5;
export const MAX_NAME_LENGTH = 20;
export const MAX_TASK_LENGTH = 120;
export const MAX_TASK_POOL = 200;
export const DEFAULT_VOTE_SECONDS = 120;
export const MIN_VOTE_SECONDS = 15;
export const MAX_VOTE_SECONDS = 600;
export const DEFAULT_MEETINGS = 1;
export const MAX_MEETINGS = 9;
export const DEFAULT_COOLDOWN_SECONDS = 15;
export const MAX_COOLDOWN_SECONDS = 120;
/** How long a kill that would end the game waits, in case the player tapped "I was killed" by mistake. */
export const WIN_GRACE_MS = 15_000;

export interface Task {
  text: string;
  done: boolean;
}

export interface Player {
  id: string;
  name: string;
  connected: boolean;
  role: Role;
  tasks: Task[];
  death: Death | null;
  /** Whether everyone has been shown this death. Deaths come out when the next meeting starts. */
  deathKnown: boolean;
  meetingsUsed: number;
}

export interface PoolTask {
  id: number;
  text: string;
  by: string;
}

export interface Settings {
  imposters: number;
  taskMode: TaskMode;
  tasksPerPlayer: number;
  voteSeconds: number;
  meetingsPerPlayer: number;
  cooldownSeconds: number;
}

interface Meeting {
  number: number;
  calledBy: string;
  endsAt: number;
  /** Voter id → the player they picked, or null for Skip. Voters can change their minds until it closes. */
  votes: Map<string, string | null>;
}

export interface MeetingResult {
  number: number;
  ejected: { id: string; name: string; role: Role } | null;
  tie: boolean;
  votes: { voterId: string; voterName: string; voted: boolean; targetId: string | null; targetName: string | null }[];
  crewLeft: number;
  impostersLeft: number;
}

export interface Winner {
  team: Team;
  reason: string;
  /** True when the game ended on a vote, so the result screen should show how everyone voted. */
  afterVote: boolean;
}

/** A rule violation that should be shown to the player who caused it. */
export class GameError extends Error {}

/** A 2nd imposter needs more than 5 crewmates, a 3rd more than 10, and so on. */
export function maxImposters(playerCount: number): number {
  return Math.max(1, Math.floor((playerCount + CREW_PER_EXTRA_IMPOSTER - 1) / (CREW_PER_EXTRA_IMPOSTER + 1)));
}

export interface GameOptions {
  now?: () => number;
  /** Returns an integer in [0, max). */
  random?: (max: number) => number;
}

export class Game {
  phase: Phase = 'lobby';
  /** In join order, which is also the order hosting passes down. */
  players: Player[] = [];
  hostId: string | null = null;
  settings: Settings = {
    imposters: 1,
    taskMode: 'auto',
    tasksPerPlayer: DEFAULT_TASKS_PER_PLAYER,
    voteSeconds: DEFAULT_VOTE_SECONDS,
    meetingsPerPlayer: DEFAULT_MEETINGS,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  };
  /** Tasks typed in by players in manual mode. Kept between games in the same room. */
  taskPool: PoolTask[] = [];
  /** Counts games played in this room, so phones know when to show a fresh role reveal. */
  gameNumber = 0;
  meeting: Meeting | null = null;
  meetingNumber = 0;
  lastResult: MeetingResult | null = null;
  meetingAvailableAt = 0;
  /** When a kill leaves one team winning, the game ends at this time unless it's undone. */
  pendingWinAt: number | null = null;
  winner: Winner | null = null;

  private nextTaskId = 1;
  private readonly now: () => number;
  private readonly random: (max: number) => number;

  constructor(options: GameOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((max) => randomInt(max));
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  join(id: string, rawName: string): void {
    if (this.player(id)) return;
    const name = rawName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) throw new GameError('Enter a name');
    if (this.phase !== 'lobby') throw new GameError('This room is locked');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`The room is full (${MAX_PLAYERS} players max)`);
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new GameError('That name is taken');
    this.players.push({ id, name, connected: true, role: 'crew', tasks: [], death: null, deathKnown: false, meetingsUsed: 0 });
    this.hostId ??= id;
  }

  setConnected(id: string, connected: boolean): void {
    const player = this.player(id);
    if (player) player.connected = connected;
  }

  updateSettings(id: string, changes: Record<string, unknown>): void {
    this.requireHost(id);
    if (this.phase !== 'lobby' && this.phase !== 'tasks') {
      throw new GameError('Settings can only be changed before the game starts');
    }
    const next = { ...this.settings };
    if (changes.imposters !== undefined) {
      next.imposters = requireInt(changes.imposters, 1, maxImposters(MAX_PLAYERS), 'Imposters');
    }
    if (changes.taskMode !== undefined) {
      if (changes.taskMode !== 'auto' && changes.taskMode !== 'manual') throw new GameError('Unknown task mode');
      if (this.phase !== 'lobby' && changes.taskMode !== this.settings.taskMode) {
        throw new GameError('Unlock the room to change the task mode');
      }
      next.taskMode = changes.taskMode;
    }
    if (changes.tasksPerPlayer !== undefined) {
      next.tasksPerPlayer = requireInt(changes.tasksPerPlayer, 1, MAX_TASKS_PER_PLAYER, 'Tasks per player');
    }
    if (changes.voteSeconds !== undefined) {
      next.voteSeconds = requireInt(changes.voteSeconds, MIN_VOTE_SECONDS, MAX_VOTE_SECONDS, 'Vote time');
    }
    if (changes.meetingsPerPlayer !== undefined) {
      next.meetingsPerPlayer = requireInt(changes.meetingsPerPlayer, 0, MAX_MEETINGS, 'Meetings per player');
    }
    if (changes.cooldownSeconds !== undefined) {
      next.cooldownSeconds = requireInt(changes.cooldownSeconds, 0, MAX_COOLDOWN_SECONDS, 'Meeting cooldown');
    }
    this.settings = next;
  }

  /** Manual task mode: stops new players joining so everyone can write tasks. */
  lockRoom(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'lobby') throw new GameError('The room is already locked');
    if (this.settings.taskMode !== 'manual') throw new GameError('Only manual task mode locks the room first');
    if (this.players.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    this.phase = 'tasks';
  }

  unlockRoom(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'tasks') throw new GameError('The room is not locked');
    this.phase = 'lobby';
  }

  addTask(id: string, rawText: string): void {
    const player = this.requirePlayer(id);
    if (this.phase !== 'tasks') throw new GameError('Tasks can only be added before the game starts');
    const text = rawText.trim().replace(/\s+/g, ' ').slice(0, MAX_TASK_LENGTH);
    if (!text) throw new GameError('Type a task first');
    if (this.taskPool.length >= MAX_TASK_POOL) throw new GameError(`That's plenty of tasks (${MAX_TASK_POOL} max)`);
    this.taskPool.push({ id: this.nextTaskId++, text, by: player.name });
  }

  deleteTask(id: string, taskId: unknown): void {
    this.requirePlayer(id);
    if (this.phase !== 'tasks') throw new GameError('Tasks can only be removed before the game starts');
    this.taskPool = this.taskPool.filter((t) => t.id !== taskId);
  }

  get tasksNeeded(): number {
    return this.players.length * this.settings.tasksPerPlayer;
  }

  start(id: string): void {
    this.requireHost(id);
    const manual = this.settings.taskMode === 'manual';
    if (manual && this.phase === 'lobby') throw new GameError('Lock the room so everyone can add tasks first');
    if (this.phase !== (manual ? 'tasks' : 'lobby')) throw new GameError('The game has already started');
    const count = this.players.length;
    if (count < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    const { imposters } = this.settings;
    if (imposters > maxImposters(count)) {
      throw new GameError(`${count} players can have at most ${maxImposters(count)} imposter${maxImposters(count) === 1 ? '' : 's'}`);
    }
    const pool = manual ? this.taskPool.map((t) => t.text) : [...AUTO_TASKS];
    if (pool.length < this.tasksNeeded) {
      throw new GameError(
        manual
          ? `Need at least ${this.tasksNeeded} tasks (${pool.length} so far)`
          : `There are only ${AUTO_TASKS.length} built-in tasks, not enough for ${this.settings.tasksPerPlayer} each`,
      );
    }

    this.shuffle(pool);
    const order = this.shuffle(this.players.map((_, i) => i));
    const imposterSeats = new Set(order.slice(0, imposters));
    this.players.forEach((p, i) => {
      p.role = imposterSeats.has(i) ? 'imposter' : 'crew';
      p.tasks = pool.splice(0, this.settings.tasksPerPlayer).map((text) => ({ text, done: false }));
      p.death = null;
      p.deathKnown = false;
      p.meetingsUsed = 0;
    });
    this.gameNumber++;
    this.meeting = null;
    this.meetingNumber = 0;
    this.lastResult = null;
    this.pendingWinAt = null;
    this.winner = null;
    this.meetingAvailableAt = this.now() + this.settings.cooldownSeconds * 1000;
    this.phase = 'playing';
  }

  setTaskDone(id: string, index: unknown, done: unknown): void {
    const player = this.requirePlayer(id);
    if (this.phase !== 'playing') throw new GameError('Tasks are paused right now');
    const task = Number.isInteger(index) ? player.tasks[index as number] : undefined;
    if (!task || typeof done !== 'boolean') throw new GameError('Unknown task');
    task.done = done;
    if (player.role === 'crew' && this.crewTasksDone()) this.endGame('crew', 'Every task is done!');
  }

  /**
   * A crewmate who was killed marks it on their own phone. Nobody is told until the next
   * meeting starts; if they mark it during a meeting, it shows right away. Imposters have the
   * same button so their phones look the same, but it does nothing for them.
   */
  markKilled(id: string): void {
    if (this.phase !== 'playing' && this.phase !== 'meeting') throw new GameError('The game is over');
    const player = this.requireAlive(id);
    if (player.role === 'imposter') return;
    player.death = 'killed';
    // Don't end the game right away, in case the tap was a mistake.
    if (this.survivorsWinner()) this.pendingWinAt = this.now() + WIN_GRACE_MS;
    if (this.phase === 'meeting') {
      player.deathKnown = true;
      this.meeting!.votes.delete(id);
      if (this.alivePlayers().every((p) => this.meeting!.votes.has(p.id))) this.closeVote();
    }
  }

  /** Takes back an "I was killed" tapped by mistake. */
  undoDeath(id: string): void {
    const player = this.requirePlayer(id);
    if (this.phase !== 'playing' && this.phase !== 'meeting') throw new GameError('The game is over');
    if (player.death !== 'killed') throw new GameError("You haven't been marked dead");
    player.death = null;
    player.deathKnown = false;
  }

  callMeeting(id: string): void {
    if (this.phase !== 'playing') throw new GameError('A meeting is already going');
    const caller = this.requireAlive(id);
    const wait = this.meetingAvailableAt - this.now();
    if (wait > 0) throw new GameError(`Meetings open again in ${Math.ceil(wait / 1000)}s`);
    // Like reporting a body in the real game, a meeting called after a kill is free.
    if (!this.hasUnrevealedDeath()) {
      if (caller.meetingsUsed >= this.settings.meetingsPerPlayer) throw new GameError('You have no emergency meetings left');
      caller.meetingsUsed++;
    }
    for (const p of this.players) if (p.death) p.deathKnown = true;
    this.meeting = {
      number: ++this.meetingNumber,
      calledBy: caller.name,
      endsAt: this.now() + this.settings.voteSeconds * 1000,
      votes: new Map(),
    };
    this.phase = 'meeting';
  }

  /** `targetId` null means Skip. */
  vote(id: string, targetId: unknown): void {
    if (this.phase !== 'meeting') throw new GameError('There is no vote right now');
    this.requireAlive(id);
    if (targetId !== null) {
      const target = typeof targetId === 'string' ? this.player(targetId) : undefined;
      if (!target || target.death) throw new GameError('You can only vote for a living player');
    }
    this.meeting!.votes.set(id, targetId as string | null);
    if (this.alivePlayers().every((p) => this.meeting!.votes.has(p.id))) this.closeVote();
  }

  /** Called regularly by the server. Returns true if anything changed. */
  tick(): boolean {
    if (this.phase === 'meeting' && this.now() >= this.meeting!.endsAt) {
      this.closeVote();
      return true;
    }
    if (this.pendingWinAt !== null && this.now() >= this.pendingWinAt) {
      this.pendingWinAt = null;
      return this.endIfOutnumbered(false);
    }
    return false;
  }

  removePlayer(id: string, targetId: string): void {
    this.requireHost(id);
    if (targetId === id) throw new GameError("You can't remove yourself. Use Leave instead.");
    if (this.phase !== 'lobby' && this.phase !== 'tasks') throw new GameError('Players can only be removed before the game starts');
    this.dropPlayer(targetId);
  }

  leave(id: string): void {
    this.dropPlayer(id);
  }

  /** Back to the waiting room with the same players and settings. */
  playAgain(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'gameover') throw new GameError('The game is not over yet');
    this.phase = 'lobby';
    this.meeting = null;
    this.lastResult = null;
    this.winner = null;
    this.pendingWinAt = null;
    for (const p of this.players) {
      p.role = 'crew';
      p.tasks = [];
      p.death = null;
      p.deathKnown = false;
      p.meetingsUsed = 0;
    }
  }

  /**
   * The game as one player sees it. Roles stay secret (except fellow imposters) until the
   * game ends, and deaths only show once a meeting has revealed them.
   */
  viewFor(viewerId: string | null) {
    const me = viewerId ? this.player(viewerId) : undefined;
    const inGame = this.phase === 'playing' || this.phase === 'meeting' || this.phase === 'gameover';
    const over = this.phase === 'gameover';
    const counts = this.publicCounts();
    const crewTasks = this.players.filter((p) => p.role === 'crew').flatMap((p) => p.tasks);
    const meeting = this.meeting;
    return {
      phase: this.phase,
      youId: me?.id ?? null,
      youAreHost: viewerId !== null && viewerId === this.hostId,
      hostId: this.hostId,
      hostName: this.hostId ? this.player(this.hostId)?.name ?? null : null,
      settings: this.settings,
      maxImposters: maxImposters(this.players.length),
      tasksNeeded: this.tasksNeeded,
      taskPool: this.phase === 'tasks' ? this.taskPool : [],
      gameNumber: this.gameNumber,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        death: p.death && (p.deathKnown || over) ? p.death : null,
        role: over ? p.role : null,
      })),
      you:
        me && inGame
          ? {
              role: me.role,
              fellowImposters:
                me.role === 'imposter' ? this.players.filter((p) => p.role === 'imposter' && p !== me).map((p) => p.name) : [],
              tasks: me.tasks,
              death: me.death,
              meetingsLeft: Math.max(0, this.settings.meetingsPerPlayer - me.meetingsUsed),
              canCallMeeting: !me.death && (this.hasUnrevealedDeath() || me.meetingsUsed < this.settings.meetingsPerPlayer),
            }
          : null,
      counts: inGame ? { crew: counts.crew, imposters: counts.imposters } : null,
      progress: inGame ? { done: crewTasks.filter((t) => t.done).length, total: crewTasks.length } : null,
      meeting: meeting
        ? {
            number: meeting.number,
            calledBy: meeting.calledBy,
            remainingMs: Math.max(0, meeting.endsAt - this.now()),
            votedIds: [...meeting.votes.keys()],
            youVoted: me ? meeting.votes.has(me.id) : false,
            yourVote: me ? meeting.votes.get(me.id) ?? null : null,
          }
        : null,
      lastResult: this.lastResult,
      meetingCooldownMs: this.phase === 'playing' ? Math.max(0, this.meetingAvailableAt - this.now()) : 0,
      winner: this.winner,
      limits: { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, maxTasksPerPlayer: MAX_TASKS_PER_PLAYER, autoTaskCount: AUTO_TASKS.length, minVoteSeconds: MIN_VOTE_SECONDS, maxVoteSeconds: MAX_VOTE_SECONDS, maxMeetings: MAX_MEETINGS, maxCooldownSeconds: MAX_COOLDOWN_SECONDS },
    };
  }

  /** Skips count for nobody. The single most-voted player is ejected; a tie (or all skips) ejects nobody. */
  private closeVote(): void {
    const meeting = this.meeting!;
    const voters = this.alivePlayers();
    const tally = new Map<string, number>();
    const votes = voters.map((voter) => {
      const voted = meeting.votes.has(voter.id);
      let target = voted ? this.player(meeting.votes.get(voter.id) ?? '') : undefined;
      // Someone who left or was un-reported after the vote was cast can't be ejected.
      if (target?.death || (target && !this.players.includes(target))) target = undefined;
      if (target) tally.set(target.id, (tally.get(target.id) ?? 0) + 1);
      return { voterId: voter.id, voterName: voter.name, voted, targetId: target?.id ?? null, targetName: target?.name ?? null };
    });
    const top = Math.max(0, ...tally.values());
    const leaders = [...tally].filter(([, n]) => n === top).map(([pid]) => pid);
    const ejected = leaders.length === 1 ? this.player(leaders[0])! : null;
    if (ejected) {
      ejected.death = 'ejected';
      ejected.deathKnown = true;
    }
    const counts = this.publicCounts();
    this.lastResult = {
      number: meeting.number,
      ejected: ejected ? { id: ejected.id, name: ejected.name, role: ejected.role } : null,
      tie: leaders.length > 1,
      votes,
      crewLeft: counts.crew,
      impostersLeft: counts.imposters,
    };
    this.meeting = null;
    this.phase = 'playing';
    this.meetingAvailableAt = this.now() + this.settings.cooldownSeconds * 1000;
    // A pending win from a kill still gets its full grace period.
    if (this.pendingWinAt === null) this.endIfOutnumbered(true);
  }

  private hasUnrevealedDeath(): boolean {
    return this.players.some((p) => p.death && !p.deathKnown);
  }

  private alivePlayers(): Player[] {
    return this.players.filter((p) => !p.death);
  }

  /** Living players by team, as far as everyone knows: unrevealed deaths still count as alive. */
  private publicCounts(): { crew: number; imposters: number } {
    const shown = this.players.filter((p) => !(p.death && p.deathKnown));
    return {
      crew: shown.filter((p) => p.role === 'crew').length,
      imposters: shown.filter((p) => p.role === 'imposter').length,
    };
  }

  private crewTasksDone(): boolean {
    const tasks = this.players.filter((p) => p.role === 'crew').flatMap((p) => p.tasks);
    return tasks.length > 0 && tasks.every((t) => t.done);
  }

  private survivorsWinner(): Team | null {
    const alive = this.alivePlayers();
    const imposters = alive.filter((p) => p.role === 'imposter').length;
    if (imposters === 0) return 'crew';
    if (imposters >= alive.length - imposters) return 'imposters';
    return null;
  }

  private endIfOutnumbered(afterVote: boolean): boolean {
    const team = this.survivorsWinner();
    if (!team) return false;
    this.endGame(team, team === 'crew' ? 'No imposters left!' : 'The imposters now equal the crewmates.', afterVote);
    return true;
  }

  private endGame(team: Team, reason: string, afterVote = false): void {
    this.winner = { team, reason, afterVote };
    this.meeting = null;
    this.pendingWinAt = null;
    this.phase = 'gameover';
  }

  private dropPlayer(id: string): void {
    const index = this.players.findIndex((p) => p.id === id);
    if (index === -1) throw new GameError('That player is not in the game');
    this.players.splice(index, 1);
    if (this.hostId === id) this.hostId = this.players.length ? this.players[index % this.players.length].id : null;
    if (this.hostId === null) {
      this.reset();
      return;
    }
    if (this.phase === 'playing' || this.phase === 'meeting') {
      if (this.players.length < MIN_PLAYERS) this.endGame('imposters', 'Too many players left the game.');
      else if (this.crewTasksDone()) this.endGame('crew', 'Every task is done!');
      else if (!this.endIfOutnumbered(false) && this.phase === 'meeting') {
        if (this.alivePlayers().every((p) => this.meeting!.votes.has(p.id))) this.closeVote();
      }
    }
  }

  private reset(): void {
    Object.assign(this, new Game({ now: this.now, random: this.random }));
  }

  /** Shuffles in place (Fisher–Yates) and returns the array. */
  private shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.random(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  private requirePlayer(id: string): Player {
    const player = this.player(id);
    if (!player) throw new GameError('You are not in this game');
    return player;
  }

  private requireAlive(id: string): Player {
    const player = this.requirePlayer(id);
    if (player.death) throw new GameError("You're dead 👻");
    return player;
  }

  private requireHost(id: string): void {
    if (id !== this.hostId) throw new GameError('Only the host can do that');
  }
}

function requireInt(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new GameError(`${label} must be between ${min} and ${max}`);
  }
  return value as number;
}

export type GameView = ReturnType<Game['viewFor']>;
