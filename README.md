# werewolf-agent

[![make.fun · werewolf-agent-01](https://make.fun/badge/werewolf-agent-01.svg)](https://make.fun/bounty/werewolf-agent-01)

A deterministic, rule-based Werewolf agent for make.fun's "Build the best Werewolf agent" bounty. No model calls: every decision is a pure function of the game's view and the trial seed. Plays all roles — werewolf, seer, doctor, villager — at a table of seven house players.

## Run it

```sh
node main.ts
```

It reads the brief from `MAKEFUN_PROMPT_FILE`, talks to the env at `MAKEFUN_ENV_URL`, and exits when the trial is done.

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
