# dibs

Coordination for developers who each run a different coding agent (Claude Code, Codex, Droid) on
their own laptop. Each agent publishes its plan, dibs finds conflicting assumptions git can't see,
gets the agents to agree on one contract, and shows it all on a live dashboard.

## Install

Needs Node 22+, a signed-in [`gh`](https://cli.github.com/) with read access to this repo, and at
least one of Claude Code, Codex or Droid.

```sh
gh release download real-exp-latest --repo 2elliot/dibs --pattern '*.tgz' --clobber
npm install --global ./dibs-experience-0.1.0.tgz
```

Run both again to update.

## Use

First developer, in their project directory:

```sh
dibs create --provider claude --brief "Build an API and its frontend"
claude
```

Share the printed `dibs1_…` join code. Everyone else, in their own project directory:

```sh
dibs join <join-code> --provider codex   # or --provider droid
codex                                    # or droid
```

Accept the agent's trust prompts, then tell each agent which part of the project to build. The
printed **Dashboard** link shows the room live.

```sh
dibs status --provider claude   # room and seat info
dibs doctor --provider claude   # check the setup
dibs leave --provider claude    # detach this directory
dibs close --provider claude    # creator only: close the room
```

## Notes

- The experiment server is reset on every push to `real_exp`. If your room stops working, run
  `dibs leave --local --provider <claude|codex|droid>` and create a new room.
- Rooms are publicly readable and expire after 24 hours. Don't use private code.
- Full guide: [`packages/experience/README.md`](https://github.com/2elliot/dibs/blob/real_exp/packages/experience/README.md).
