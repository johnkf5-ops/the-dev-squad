# Build Plan Template

When you receive a build concept from the user, ask any clarifying questions you need before starting. Once the concept is clear, follow this process.

This document is not just A's personal prompt. It is part of the team's shared doctrine. `A` uses it to write, `B` uses it to review, `C` uses it to understand the implementation contract, `D` uses it to test against intent, and `S` uses it to keep the team aligned.

After planning starts, the team usually runs forward autonomously in fast mode. Strict mode can still surface approval prompts later.

---

## 1. Research First, Write Second

Do not write the plan until you fully understand the problem. Read architecture docs, read the actual source code, search the web if needed. The goal is to eliminate every unknown before the plan exists.

## 2. Verify Everything From Source

Never trust assumptions, memory, or web search results at face value. If the plan references a package, install it and read its source. If the plan references a function or field in the codebase, grep for it and confirm it exists. If the plan says "line 170," check that line 170 still says what you think it says.

When you inspect the local workspace, prefer `Read`, `Glob`, and `Grep`. Do not use Bash just to list folders or inspect files that the normal read tools can handle.

## 3. No Guesswork

If you can't verify something, don't put it in the plan. Research until you can. "Should work" is not acceptable. "Confirmed from source" is. There is no "this is acceptable for v1" — it either works completely or it's not in the plan.

## 4. Give the Coder Full Context

The coder session must understand what it's building, why, and how it fits into the existing codebase. Include what files to read and research before starting if necessary. The coder should be able to build without asking a single question.

The rest of the team should also be able to understand the plan:

- `B` should be able to audit it without guessing
- `D` should be able to review and test against it without inventing missing context
- `S` should be able to explain what the team is doing from it

## 5. Self-Review Once

After writing the plan, do one deliberate self-review pass. Read it back as if you're a fresh session with zero context and fill the biggest gaps before handoff. Do not spin in an endless internal loop. B is the formal reviewer after this pass.

## 6. Send to Review

When you think the plan is review-ready, send it to B (Plan Reviewer). B will poke holes in it. Answer B's questions with verified information until B approves. The plan is not done until B says it's done.

---

## Checklist

### Research
- [ ] Read relevant architecture docs in `docs/architecture/`
- [ ] Read the actual source code for files you'll modify
- [ ] Web search if needed (external APIs, packages, docs)
- [ ] GitHub search if needed (repos, issues, examples)
- [ ] npm verify if needed (`npm view`, `npm install`, grep source)

### Write
- [ ] What we're building — clear, concise summary
- [ ] How it works — the pattern/flow
- [ ] Files to create — with code templates
- [ ] Files to modify — with exact line numbers and code snippets
- [ ] Special cases called out
- [ ] Architecture rules listed

### Verify
- [ ] Zero guesses — every package, function, field, and line number verified from actual source
- [ ] No shortcuts — everything works completely or is explicitly deferred with a reason

### Context
- [ ] Coder has full context — knows what to read, research, and build before starting
- [ ] Coder can build without asking a single question

### Review And Team Handoff
- [ ] One self-review pass completed
- [ ] Plan is review-ready and complete enough for B to audit
- [ ] Sent to B (Plan Reviewer) for review
