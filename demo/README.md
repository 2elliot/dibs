# Demo target

The small app the agents work on during the demo: a study-group app where students can create groups. It's owned by the demo lane and isn't part of the npm workspaces. For the demo, copy it into its own repo so the two laptops branch from that, not from dibs.

## The scenario

Two teammates give their agents these prompts at the same time:

- **Elliot:** "Add the ability for students to post questions in a study group and reply to them."
- **Teammate:** "When someone replies to your question, send them a notification."

The prompts share no keywords, but both depend on how replies are stored. That's exactly the overlap file locks can't see.

**Without dibs**, each agent works on its own branch. Elliot's agent creates an `Answer` model with `postId` and `authorId`. The teammate's agent finds no reply model, builds its own `Reply` model with `questionId` and `userId`, and fires notifications when a `Reply` is created. Git merges cleanly (different files) and the types probably check, but the app is quietly broken: posting a reply creates an `Answer`, and nobody gets notified.

**With dibs**, Elliot's agent calls dibs on question and reply storage. The teammate's agent publishes its intent, and dibs flags that notifications depend on replies, which Elliot's agent owns. It sends its requirements ("I need an event when a reply is created, including the question author's ID"), and they agree on `onReplyCreated(reply)` with `questionId`, `questionAuthorId`, `replierId` and `body`. The teammate's agent builds against a stub, a test checks the event fires with those fields, and after the merge notifications work on the first try.

## What we measure

Write one end-to-end test **before either run**, so both conditions are judged the same way: user 1 posts a question, user 2 replies, and the test checks user 1 got a notification.

1. **Does the end-to-end test pass right after merge?** The headline. Expect fail without dibs, pass with it.
2. **Duplicate models for the same concept.** Two versus one, by inspection.
3. **Rework after merge.** Lines changed to get the test passing (`git diff --stat` on the fix). Should be zero with dibs.
4. **Time until the test passes**, from when both prompts are sent, including fix time in the baseline.
5. **Total tokens** across both sessions, including the fix.
6. **Human interventions:** how many times a person had to step in.

Keep it fair: the same repo commit, prompts and model for both conditions. Run each three times and report the median. If dibs uses more tokens in some runs because of coordination messages, say so. The case still holds: the baseline merges cleanly into a broken app, and dibs doesn't.

## Results

| Metric                             | Without dibs (median of 3) | With dibs (median of 3) |
| ---------------------------------- | -------------------------- | ----------------------- |
| End-to-end test passes after merge |                            |                         |
| Duplicate models                   |                            |                         |
| Lines of rework                    |                            |                         |
| Minutes to passing test            |                            |                         |
| Total tokens                       |                            |                         |
| Human interventions                |                            |                         |

## To build

- A tiny TypeScript app with study groups and nothing else yet, plus the end-to-end test above (failing, since neither feature exists).
- Small enough that each agent finishes its feature in a few minutes on stage.
