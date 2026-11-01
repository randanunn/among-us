import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, maxImposters, WIN_GRACE_MS, DEFAULT_TASKS_PER_PLAYER } from '../src/game.ts';

/**
 * An automatic-task game with a controllable clock. With `random: () => 0` the shuffle
 * is deterministic; roles are then reassigned explicitly so tests read clearly.
 */
function setup(names: string[], imposters: string[] = [names.at(-1)!]) {
  let time = 0;
  const game = new Game({ now: () => time, random: () => 0 });
  for (const name of names) game.join(name, name);
  game.updateSettings(names[0], { imposters: imposters.length, cooldownSeconds: 0 });
  game.start(names[0]);
  for (const p of game.players) p.role = imposters.includes(p.id) ? 'imposter' : 'crew';
  const finishTasks = (id: string) => game.player(id)!.tasks.forEach((_, i) => game.setTaskDone(id, i, true));
  return { game, tick: (ms: number) => (time += ms), finishTasks };
}

/** Everyone alive votes for `target` (null = skip). */
function everyoneVotes(game: Game, target: string | null) {
  for (const p of game.players.filter((p) => !p.death)) if (game.phase === 'meeting') game.vote(p.id, target);
}

test('maxImposters: a 2nd needs more than 5 crewmates, a 3rd more than 10', () => {
  assert.equal(maxImposters(3), 1);
  assert.equal(maxImposters(7), 1); // 2 imposters would leave only 5 crewmates
  assert.equal(maxImposters(8), 2);
  assert.equal(maxImposters(13), 2);
  assert.equal(maxImposters(14), 3);
  assert.equal(maxImposters(20), 4);
});

test('first player to join is host and only the host can change settings or start', () => {
  const game = new Game();
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  assert.equal(game.hostId, 'a');
  assert.throws(() => game.start('b'), /Only the host/);
  assert.throws(() => game.updateSettings('b', { imposters: 1 }), /Only the host/);
  game.start('a');
  assert.equal(game.phase, 'playing');
});

test('needs 3 players and respects the imposter cap', () => {
  const game = new Game();
  game.join('a', 'a');
  game.join('b', 'b');
  assert.throws(() => game.start('a'), /at least 3/);
  game.join('c', 'c');
  game.updateSettings('a', { imposters: 2 });
  assert.throws(() => game.start('a'), /at most 1 imposter/);
});

test('automatic mode deals 3 unique tasks each and locks the room', () => {
  const { game } = setup(['a', 'b', 'c', 'd']);
  const all = game.players.flatMap((p) => p.tasks.map((t) => t.text));
  assert.equal(all.length, 4 * DEFAULT_TASKS_PER_PLAYER);
  assert.equal(new Set(all).size, all.length);
  assert.throws(() => game.join('e', 'e'), /locked/);
  assert.doesNotThrow(() => game.join('a', 'a')); // reconnecting is fine
});

test('manual mode: lock, anyone adds tasks, need 3 per player, then start', () => {
  const game = new Game({ random: () => 0 });
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  game.updateSettings('a', { taskMode: 'manual' });
  assert.throws(() => game.start('a'), /Lock the room/);
  assert.throws(() => game.addTask('b', 'x'), /before the game starts/);
  game.lockRoom('a');
  assert.throws(() => game.join('d', 'd'), /locked/);
  for (let i = 0; i < 8; i++) game.addTask('b', `Task ${i}`);
  assert.throws(() => game.start('a'), /Need at least 9 tasks \(8 so far\)/);
  game.addTask('c', 'Task 8');
  game.addTask('c', 'Oops');
  game.deleteTask('a', game.taskPool.at(-1)!.id);
  assert.equal(game.taskPool.length, 9);
  game.start('a');
  const dealt = game.players.flatMap((p) => p.tasks.map((t) => t.text)).sort();
  assert.deepEqual(dealt, game.taskPool.map((t) => t.text).sort());
});

test('tasks per player is configurable', () => {
  const game = new Game({ random: () => 0 });
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  assert.throws(() => game.updateSettings('a', { tasksPerPlayer: 0 }), /between 1 and 10/);
  game.updateSettings('a', { tasksPerPlayer: 5, taskMode: 'manual' });
  game.lockRoom('a');
  for (let i = 0; i < 14; i++) game.addTask('a', `Task ${i}`);
  assert.throws(() => game.start('a'), /Need at least 15 tasks \(14 so far\)/);
  game.addTask('b', 'Task 14');
  game.start('a');
  assert.ok(game.players.every((p) => p.tasks.length === 5));
  assert.equal(game.viewFor('a').progress!.total, 10);
});

test('automatic mode says when there are not enough built-in tasks', () => {
  const game = new Game({ random: () => 0 });
  for (let i = 0; i < 7; i++) game.join(`p${i}`, `p${i}`);
  game.updateSettings('p0', { tasksPerPlayer: 10 });
  assert.throws(() => game.start('p0'), /only \d+ built-in tasks/);
});

test('manual mode can deal the same task twice only if it was entered twice', () => {
  const game = new Game({ random: () => 0 });
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  game.updateSettings('a', { taskMode: 'manual' });
  game.lockRoom('a');
  for (let i = 0; i < 9; i++) game.addTask('a', i < 2 ? 'Same' : `Task ${i}`);
  game.start('a');
  assert.equal(game.players.flatMap((p) => p.tasks).filter((t) => t.text === 'Same').length, 2);
});

test('imposters see each other; crew see nobody; roles are hidden from everyone else', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const { game } = setup(names, ['g', 'h']);
  assert.deepEqual(game.viewFor('g').you!.fellowImposters, ['h']);
  assert.deepEqual(game.viewFor('a').you!.fellowImposters, []);
  assert.ok(game.viewFor('a').players.every((p) => p.role === null));
  assert.equal(game.viewFor('g').you!.tasks.length, DEFAULT_TASKS_PER_PLAYER);
});

test('crew win when every crewmate task is done; imposter tasks do not count', () => {
  const { game, finishTasks } = setup(['a', 'b', 'c']);
  finishTasks('c'); // the imposter
  assert.deepEqual(game.viewFor('a').progress, { done: 0, total: 6 });
  finishTasks('a');
  game.setTaskDone('a', 0, false); // unchecking works
  assert.deepEqual(game.viewFor('b').progress, { done: 2, total: 6 });
  game.setTaskDone('a', 0, true);
  finishTasks('b');
  assert.equal(game.phase, 'gameover');
  assert.equal(game.winner!.team, 'crew');
});

test('dead crewmates keep doing tasks', () => {
  const { game, finishTasks } = setup(['a', 'b', 'c', 'd', 'e']);
  game.markKilled('a');
  finishTasks('a');
  assert.equal(game.viewFor('b').progress!.done, 3);
});

test('a kill stays hidden until the next meeting', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.markKilled('a');
  assert.equal(game.viewFor('c').players[0].death, null);
  assert.deepEqual(game.viewFor('c').counts, { crew: 4, imposters: 1 });
  assert.equal(game.viewFor('a').you!.death, 'killed');
  game.callMeeting('c');
  assert.equal(game.viewFor('c').players[0].death, 'killed');
  assert.deepEqual(game.viewFor('c').counts, { crew: 3, imposters: 1 });
});

test('marking yourself killed during a meeting shows right away and takes back your vote', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('b');
  game.vote('a', 'e');
  game.markKilled('a');
  assert.equal(game.viewFor('c').players[0].death, 'killed');
  assert.deepEqual(game.viewFor('c').counts, { crew: 3, imposters: 1 });
  assert.ok(!game.meeting!.votes.has('a'));
  assert.throws(() => game.vote('c', 'a'), /living player/);
});

test('the last vote missing closes the meeting when that player marks themselves killed', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('b');
  for (const id of ['b', 'c', 'd', 'e']) game.vote(id, null);
  game.markKilled('a');
  assert.equal(game.phase, 'playing');
  assert.equal(game.lastResult!.votes.length, 4);
});

test("an imposter's I was killed does nothing", () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.markKilled('e');
  assert.equal(game.player('e')!.death, null);
  assert.equal(game.pendingWinAt, null);
  assert.equal(game.viewFor('e').you!.canCallMeeting, true);
});

test('a killed player can undo any time, including during a meeting, and then vote', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.markKilled('a');
  game.callMeeting('b');
  assert.throws(() => game.vote('a', null), /dead/);
  game.undoDeath('a');
  assert.deepEqual(game.viewFor('c').counts, { crew: 4, imposters: 1 });
  game.vote('a', null);
  assert.ok(game.meeting!.votes.has('a'));
});

test('dead players cannot call meetings or die twice', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.markKilled('a');
  assert.throws(() => game.callMeeting('a'), /dead/);
  assert.throws(() => game.markKilled('a'), /dead/);
});

test('a kill that ties imposters with crew ends the game after a grace period', () => {
  const { game, tick } = setup(['a', 'b', 'c']);
  game.markKilled('a');
  assert.equal(game.phase, 'playing');
  tick(WIN_GRACE_MS - 1);
  game.tick();
  assert.equal(game.phase, 'playing');
  tick(1);
  assert.equal(game.tick(), true);
  assert.equal(game.phase, 'gameover');
  assert.equal(game.winner!.team, 'imposters');
});

test('a kill marked during a meeting also waits before the imposters win', () => {
  const { game, tick } = setup(['a', 'b', 'c']);
  game.callMeeting('a');
  game.markKilled('b');
  assert.equal(game.phase, 'meeting');
  game.undoDeath('b');
  tick(WIN_GRACE_MS);
  game.tick();
  assert.equal(game.phase, 'meeting');
  game.markKilled('b');
  tick(WIN_GRACE_MS);
  game.tick();
  assert.equal(game.phase, 'gameover');
  assert.equal(game.winner!.team, 'imposters');
});

test('undoing a mistaken kill during the grace period cancels the win', () => {
  const { game, tick } = setup(['a', 'b', 'c']);
  game.markKilled('a');
  game.undoDeath('a');
  tick(WIN_GRACE_MS);
  assert.equal(game.tick(), false);
  assert.equal(game.phase, 'playing');
});

test('emergency meetings: one each by default, free after a kill, with a cooldown', () => {
  const { game, tick } = setup(['a', 'b', 'c', 'd', 'e']);
  assert.throws(() => game.updateSettings('a', { voteSeconds: 30 }), /before the game starts/);
  game.settings.cooldownSeconds = 15;
  game.callMeeting('a');
  everyoneVotes(game, null);
  assert.throws(() => game.callMeeting('b'), /open again in 15s/);
  tick(15_000);
  assert.throws(() => game.callMeeting('a'), /no emergency meetings left/);
  game.markKilled('d');
  game.callMeeting('a'); // free: someone was killed since the last meeting
  assert.equal(game.player('a')!.meetingsUsed, 1);
});

test('meeting cooldown applies at the start of the game', () => {
  let time = 0;
  const game = new Game({ now: () => time, random: () => 0 });
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  game.start('a');
  assert.throws(() => game.callMeeting('a'), /open again in 15s/);
  time += 15_000;
  game.callMeeting('a');
});

test('voting: most votes is ejected, skips count for nobody, votes can change', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('a');
  game.vote('a', 'b');
  game.vote('a', 'e'); // changed mind
  game.vote('b', 'e');
  game.vote('c', null);
  game.vote('d', null);
  assert.equal(game.phase, 'meeting');
  game.vote('e', 'a');
  // e had 2 votes, a had 1, two skips: e is out, and e was the only imposter.
  assert.equal(game.phase, 'gameover');
  assert.equal(game.winner!.team, 'crew');
  assert.equal(game.winner!.afterVote, true);
  assert.equal(game.lastResult!.ejected!.name, 'e');
  assert.equal(game.lastResult!.ejected!.role, 'imposter');
});

test('dead players (killed or voted out) cannot vote or be voted for', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  game.callMeeting('a');
  everyoneVotes(game, 'b'); // b is voted out
  game.markKilled('c');
  game.player('d')!.meetingsUsed = 0;
  game.callMeeting('d');
  for (const dead of ['b', 'c']) {
    assert.throws(() => game.vote(dead, 'a'), /dead/);
    assert.throws(() => game.vote(dead, null), /dead/);
    assert.throws(() => game.vote('a', dead), /living player/);
  }
  // Only the 5 living players need to vote for the meeting to close.
  everyoneVotes(game, null);
  assert.equal(game.phase, 'playing');
  assert.deepEqual(game.lastResult!.votes.map((v) => v.voterId), ['a', 'd', 'e', 'f', 'g']);
});

test('voting: a tie or all skips ejects nobody', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('a');
  game.vote('a', 'b');
  game.vote('b', 'a');
  for (const id of ['c', 'd', 'e']) game.vote(id, null);
  assert.equal(game.lastResult!.ejected, null);
  assert.equal(game.lastResult!.tie, true);
  assert.equal(game.phase, 'playing');
  game.player('b')!.meetingsUsed = 0;
  game.callMeeting('b');
  everyoneVotes(game, null);
  assert.equal(game.lastResult!.ejected, null);
  assert.equal(game.lastResult!.tie, false);
});

test('ejecting a crewmate reports their role and who is left, then play continues', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('a');
  everyoneVotes(game, 'b');
  const result = game.lastResult!;
  assert.equal(result.ejected!.role, 'crew');
  assert.equal(result.crewLeft, 3);
  assert.equal(result.impostersLeft, 1);
  assert.equal(result.votes.length, 5);
  assert.equal(game.phase, 'playing');
  assert.throws(() => game.undoDeath('b'), /haven't been marked dead/);
});

test('the vote timer closes the meeting and non-voters count as skips', () => {
  const { game, tick } = setup(['a', 'b', 'c', 'd', 'e']);
  game.callMeeting('a');
  game.vote('a', 'b');
  tick(game.settings.voteSeconds * 1000);
  assert.equal(game.tick(), true);
  assert.equal(game.lastResult!.ejected!.name, 'b');
  assert.equal(game.lastResult!.votes.filter((v) => !v.voted).length, 4);
});

test('imposters win when ejecting a crewmate leaves them equal', () => {
  const { game } = setup(['a', 'b', 'c']);
  game.callMeeting('a');
  everyoneVotes(game, 'b');
  assert.equal(game.winner!.team, 'imposters');
});

test('host passes to the next player to join when the host leaves', () => {
  const game = new Game();
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  game.leave('a');
  assert.equal(game.hostId, 'b');
  game.leave('c');
  game.leave('b');
  assert.equal(game.hostId, null);
  assert.equal(game.players.length, 0);
});

test('only the host can remove players, and only before the game starts', () => {
  const game = new Game();
  for (const id of ['a', 'b', 'c', 'd']) game.join(id, id);
  assert.throws(() => game.removePlayer('b', 'c'), /Only the host/);
  game.removePlayer('a', 'd');
  assert.equal(game.players.length, 3);
  game.start('a');
  assert.throws(() => game.removePlayer('a', 'c'), /before the game starts/);
});

test('play again returns everyone to an unlocked waiting room', () => {
  const { game } = setup(['a', 'b', 'c']);
  game.callMeeting('a');
  everyoneVotes(game, 'c');
  assert.equal(game.phase, 'gameover');
  assert.throws(() => game.playAgain('b'), /Only the host/);
  game.playAgain('a');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.length, 3);
  assert.ok(game.players.every((p) => !p.death && p.tasks.length === 0));
  game.join('d', 'd');
  assert.equal(game.players.length, 4);
});

test('roles are revealed to everyone at game over', () => {
  const { game } = setup(['a', 'b', 'c']);
  game.callMeeting('a');
  everyoneVotes(game, 'c');
  assert.deepEqual(
    game.viewFor('a').players.map((p) => p.role),
    ['crew', 'crew', 'imposter'],
  );
});

test('rejects bad input', () => {
  const { game } = setup(['a', 'b', 'c', 'd', 'e']);
  assert.throws(() => game.setTaskDone('a', 9, true), GameError);
  game.callMeeting('a');
  assert.throws(() => game.vote('a', 'nobody'), /living player/);
});
