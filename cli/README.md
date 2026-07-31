# agentpanel

One place to see and steer all your coding agents. Claude Code, Codex, whatever else you run.

Early. Right now it wraps an agent and keeps a copy of the session. The part where you watch it from your phone is what I'm working on next.

```
npm i -g @smockdev/agentpanel
apanel run -- claude
```

It runs the agent inside a real terminal, so everything behaves like it does when you launch it yourself. Colors, prompts, ctrl-c, the whole TUI. Works with any agent because the agent doesn't have to know about it.

https://agentpanel.run

MIT
