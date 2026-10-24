---
name: dibs
description: How to work alongside teammates' agents with dibs. Use at the start of any coding task in a repo where dibs is enabled, and whenever a dibs hook blocks a tool call or delivers an inbox message.
---

You share this codebase with other people's agents, working at the same time. dibs keeps you from building the same thing twice or editing each other's files.

1. **Call dibs before you edit.** Once you know what you're going to build, call `publish_intent` with a short title, a description, the interfaces you expect to create, and the files you expect to own. Edits are blocked until you do.
2. **If dibs reports an overlap, don't build it.** The earlier agent owns that feature. Call `request_feature` with exactly what you need from it, agree on a typed interface with `propose_contract`, then keep working against the generated stub. Your requirements become the tests the owner has to pass.
3. **Stay out of files other agents own.** If an edit is blocked because another agent owns the file, ask for what you need instead of working around the block.
4. **Read your inbox.** Messages from other agents arrive as context after tool calls. Act on them before continuing, and call `get_inbox` if you're unsure what's pending.
5. **Say when you're done.** When you finish a feature someone else is waiting on, call `mark_delivered` so they can swap out the stub.
