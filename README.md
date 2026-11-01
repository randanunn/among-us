# Among Us

An in-person version of Among Us played around the house from everyone's phones. There's nothing to install and no accounts.

## Run it

```sh
npm install
npm start
```

The terminal prints a URL (like `http://192.168.1.23:3000`) and a QR code. Everyone on the same Wi-Fi scans it or types it into their phone's browser.

One person taps **Start a new game** and gets a 4-letter room code. Everyone else taps **Join a friend's game** and enters it, or opens the invite link. The first person in the room is the host. Several rooms can run at once.

Use `PORT=4000 npm start` to pick a different port. If phones can't connect, check that macOS allowed incoming connections for `node` (System Settings → Network → Firewall).

## Deploying to Render (free)

`render.yaml` describes the service. In Render, choose **New → Blueprint**, pick this repo, and deploy. Render then redeploys on every push to `main`, and open phones reload themselves to pick up the new version.

Games live in memory on a single instance. Render's free tier sleeps after 15 minutes without traffic, which ends any games, and the first visit afterwards takes about a minute to wake it up.

## How to play

- In the waiting room, the host picks the number of imposters, the vote timer, how many emergency meetings each player gets, and the meeting cooldown.
- **Automatic tasks:** the host taps **Start game** and everyone gets 3 tasks from around the house.
- **Manual tasks:** the host locks the room, then anyone adds tasks (and can delete them) until there are 3 per player. Then the host starts the game.
- Everyone sees their role privately. Imposters also see who the other imposters are. After that, every phone looks the same.
- Crewmates check off tasks as they do them. Imposters pretend to do theirs and secretly "kill" crewmates in person.
- Anyone who finds a body taps **Found a dead body** and picks who it was. Nobody is told until someone calls an **Emergency meeting**. Then the meeting shows who's dead and updates the crewmate and imposter counts.
- Each player gets 1 emergency meeting by default. Calling one after a body has been found doesn't use it up.
- In a meeting, living players vote for someone or skip. Votes can change until the timer runs out, or until everyone has voted. The player with the most votes is out, and a tie or all skips means nobody is. Everyone then sees who was voted out, whether they were an imposter, how many of each are left, and who voted for whom.
- Dead players keep doing tasks but can't vote or call meetings. Anyone reported dead by mistake (or an imposter, who can't be killed) can tap **I'm not dead** at any time.
- **Crewmates win** when every crewmate task is done or every imposter is voted out. **Imposters win** once they equal the crewmates. If a body report causes that, the game waits 15 seconds in case it was a mistake.
- **Play again** takes everyone back to the waiting room, where the host can change settings, let more people join, or remove players.

## Development

```sh
npm run dev        # restart the server on file changes
npm test           # game rules tests
npm run typecheck
```

- `src/game.ts`: game rules and state, with no networking.
- `src/tasks.ts`: the built-in tasks for automatic mode.
- `src/server.ts`: HTTP and WebSocket server. Sends each player their own view, so roles and unreported deaths stay hidden.
- `public/`: the phone client, in plain HTML, CSS, and JS with no build step.
