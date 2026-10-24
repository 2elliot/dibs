# Decisions

One file per decision that another lane needs to know about: a contract change, a new dependency, a library choice, a naming convention, something cut.

- Name it `YYYY-MM-DD-short-title.md`. Dates instead of numbers, so two people adding a decision at once never collide.
- Add new files. To reverse a decision, write a new one that says so; don't rewrite history.
- Keep it short:

```markdown
# Title

Lane: core · Date: 2026-10-24

What we decided, and why, in a few sentences. What it means for the other lanes.
```
