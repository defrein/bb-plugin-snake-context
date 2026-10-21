---
name: snake-context
description: Explain the Snake Context plugin, a pixel snake game above the thread chat input that moves only while the agent runs and grows with the thread's context-window usage. Use when the user asks about the snake panel or its behavior.
---

# Snake Context

It renders as a banner above every thread's chat input (composer). The chevron
collapses it to a one-line context bar; the choice is remembered per browser.

- The snake moves only while the thread's agent is running (`starting` or
  `active`). It freezes when the thread is idle, failed, or stopped.
- Snake length is the thread's context-window usage: `usedTokens /
  modelContextWindow` mapped onto the board. Compaction or clearing context
  shrinks it.
- Steer with arrow keys or WASD (click the board first) or the small D-pad
  beside it, which keeps focus in the chat input. Space or `A` toggles
  autopilot.
- Walls wrap. Biting your own body counts a crash and respawns the snake
  coiled at the centre. Food only adds score; context drives length.

The plugin has no settings, CLI commands, or agent tools.
