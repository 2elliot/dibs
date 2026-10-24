# dibs

This describes the full plan. Cut anything that doesn't make it in before the freeze so it stays accurate.

## Long version

When I work on a project with other people and we're all using coding agents, the agents have no idea what each other are doing. Everyone's on their own branch, and you don't find out you overlapped until you try to merge. Sometimes two agents build the same thing twice. Sometimes they build two pieces that are supposed to fit together and don't.

dibs lets your team's agents talk to each other in realtime while they work. Before an agent starts on something, it says what it's planning to build. If someone else's agent is already working on the same thing, dibs catches it, even if they describe it differently. Whoever called dibs first builds it. The second agent doesn't build it again. It sends over what it actually needs, the two agree on how it should work, and the second agent gets a placeholder it can start building against right away. When the first agent finishes, tests check that what it built actually does what the second agent asked for.

We built it as a Claude Code plugin with a shared server that keeps track of what every agent on the team is working on. An agent can't start editing files until it's said what it's working on, and it can't edit something another agent already owns. There's also a live dashboard where you can see every agent, what it's building, and when two of them run into each other.

The goal is that you can split up a project with your friends, point your agents at it, and not worry about them writing over each other or building the same thing twice.

## Short version

When you work on a project with other people and everyone's using coding agents, the agents have no idea what each other are doing. You don't find out you overlapped until you merge, and by then two agents might have built the same thing twice or built pieces that don't fit.

dibs lets your team's agents talk to each other in realtime. Each agent says what it's building before it starts, and if two agents are working on the same thing, dibs catches it. Whoever called dibs first builds it. The other agent sends over what it needs and keeps building against a placeholder, and tests check that the real version does what was asked.

It's a Claude Code plugin with a shared server and a live dashboard, so you can split up a project, point your agents at it, and not worry about them writing over each other.
