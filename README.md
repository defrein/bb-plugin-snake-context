# bb-plugin-snake-context

A pixel snake for bb threads. It moves only while the thread's agent is
running, and its length is the thread's context-window usage.

- It shows as a strip above each thread's chat input; the chevron collapses it.
- Arrow keys / WASD (click the board first) or the on-screen D-pad steer; Space toggles autopilot.
- Walls wrap. Biting yourself counts a crash and respawns the snake. Food only adds score.

## Install

```
bb plugin install git:https://github.com/<owner>/bb-plugin-snake-context
```

## Develop

```
npm install
bb plugin build .
```
