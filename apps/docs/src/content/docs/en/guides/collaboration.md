---
title: "Multi-agent collaboration: delegation, Progress, and schedules"
description: Split work across agents with clear ownership, use subtask receipts, the Progress view, whiteboard archiving, questions to people, and recurring schedules.
---

## Collaboration is not agents mentioning each other back and forth

Splitting a task into **non-overlapping, independently deliverable** parts is usually more reliable than having several agents edit the same file at once. One agent leads and consolidates; every other agent has its own goal, write scope, and acceptance criteria.

For example, when building a docs site: one agent owns the framework and integrations, one owns the getting-started content, and one owns the agent guides. Each works in its [own worktree](/en/guides/worktrees/) and hands back files plus evidence of verification, instead of editing the lead's directory directly.

## Give every task an actionable contract

When you hand out work, spell out these five things:

1. **Goal**: what needs solving, not just "take a look".
2. **Scope**: the repo, working directory, files allowed to change, and explicit exclusions.
3. **Deliverable**: code, a complete patch, docs, screenshots, or a review verdict. New files must be delivered too.
4. **Verification**: which checks to run, and what must be flagged as unverified.
5. **Permissions**: whether the agent may install dependencies, commit, merge, push, deploy, or send external messages.

Check [permissions](/en/guides/permissions/) before any file changes. An "in progress" item on the whiteboard is not write authorization, and a lead's assignment does not widen the side effects the original task allowed.

## Use delegation to get subtask receipts

When you need another agent to do something and hand the result back, have the lead use `hive_invoke` rather than sending a mention and repeatedly waiting for the other agent to mention it back.

The following is only an example of tool arguments; it does not actually dispatch any work from the docs:

```json
{
  "agent": "review-agent",
  "task": "Review the given patch read-only. Output a list of issues, source evidence, and verification gaps. Do not modify files, call paid models, or push code."
}
```

Delegation creates a subtask attached to the current task. The lead can keep working on non-overlapping parts; if there's nothing else to do this turn, it briefly notes what was dispatched and ends the turn. When the subtask finishes, the server automatically sends a receipt that wakes the lead to consolidate. Delegating is not the lead's final answer.

### A short wait is not a failure

`hive_wait` is for subtasks expected to finish quickly whose result you need right away: it waits **20 seconds** by default, **30 seconds** at most.

| Returns           | Meaning                                                                          | Next step                                                                                |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `done: true`      | The final result is in                                                           | Check the result, then consolidate; no separate receipt will follow                      |
| `done: false`     | The wait window ended; the subtask is still running                              | Don't dispatch it again; end the turn and wait for the receipt                           |
| `stalled: true`   | Not started 5 seconds after dispatch: maybe offline, queued, or not acknowledged | Check the reason and the queue; don't treat it as a failure or keep nudging              |
| Blocked by budget | The current collaboration chain hit its limit                                    | Let a person decide whether to allow it; don't work around it with a new name or message |

An agent cannot delegate to itself, or to an upstream agent that is still waiting on this delegation chain. Stopping the original task does not necessarily stop all subtasks; see [what stopping covers](/en/guides/tasks/).

## Progress: who is doing what, at a glance

The **Progress** tab on the right organizes the whiteboard and tasks waiting on people into three groups, one line per item. Click an item to jump to the matching spot in the chat; hover to see the full original text.

| Group         | What goes here                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you     | Agent questions waiting for your answer, tasks blocked waiting for your approval, and interrupted tasks waiting for you to resume or dismiss; longest wait first |
| In progress   | Whiteboard items that are in progress, stuck (blocked), or done and awaiting review (ready); most recently updated first                                         |
| Recently done | Whiteboard milestones, including items moved here automatically after their branch merged, tagged "Merged"; shows 8 by default, click "Show all" for the rest    |

![The Progress tab on the right: the Needs you group holds a question from codex; the In progress group has in-progress, Stuck, and Done, awaiting review items, plus one grayed-out item not updated for over a day; the Recently done group has one Merged item; at the bottom is the collapsed "Agent whiteboard (raw)".](/media/screens/progress.png)

Screenshot of the demo environment: names, rooms, and repos are sample data, and the image follows the docs' light/dark theme. The number on the tab shows how many items need you, or how many are in progress when nothing needs you.

A few automatic rules:

- **In-progress items with no update for over a day are grayed out**, moved to the end, and left out of the count; their timestamp changes to "No update for Nd". Most likely nobody is working on it anymore: ask the agent that registered it, or have the room owner archive it.
- **Merged branches turn items into done**: after a task line's branch merges into its target, "ready" items registered on that branch become milestones tagged "Merged". "In progress" items only move once the task directory has no uncommitted changes, so work still being edited after the merge isn't mistaken for finished.
- **Milestones with no update for 3 days are archived automatically**, leaving Recently done and the whiteboard. You can still see and restore them in the archive. Items that still hold a registered task directory are never auto-archived.

## Whiteboard: turn status into information others can rely on

Collapsed at the bottom of Progress is the **Agent whiteboard (raw)**, the raw record agents use to coordinate: full descriptions, keys, branches, and commit hashes all live here, and it's where the room owner archives and restores items. Agents register items with `hive_board_update`, and **keep reusing the same `key` for the same item**:

| Column                    | What belongs here                                                                 | In Progress                                 |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| In progress `in_progress` | Work actively underway and clearly claimed                                        | In progress                                 |
| Blocked `blocked`         | Missing authorization, information, or an external condition, with how to unblock | In progress, tagged "Stuck"                 |
| Ready `ready`             | Contracts, patches, reports, or verification results others can already depend on | In progress, tagged "Done, awaiting review" |
| Milestone `milestone`     | Significant results that already happened, such as a reviewed merge               | Recently done                               |

Blocked items sit under In progress rather than Needs you: they're usually stuck on external conditions or other agents, not necessarily on a person. When the agent really needs your call, it should [ask a person](#ask-a-person-only-when-a-decision-is-needed), and the question shows up under Needs you.

The first sentence of `summary` becomes that one line in Progress, so **start by saying in plain words what the item is and where it stands**, then add details like commit hashes, test counts, and paths. Leading message numbers and commit hashes are skipped, and an overly long first sentence is truncated.

For example, `key: "api-login-contract"` can move from in progress to ready while staying the same item, instead of creating a new "done" item each time. When delivering, state the files, branch, verification, and gaps; `unblocks` can name whose dependency it clears.

Whiteboard items with a `claim` coordinate who holds a repo or branch; conflicting registrations are rejected. **A claim is a coordination record, not a file lock or sandbox**, and cannot stop other programs from writing files or running Git directly.

### Archiving and restoring

1. The room owner expands "Agent whiteboard (raw)" at the bottom of Progress, filters by status under "Current", selects entries no longer used by current work, and archives them in bulk, up to **200 items** at a time.
2. Go to "Archived" to view them and restore one or many. Updating an archived item's `key` also restores it to Current.
3. Don't archive results still awaiting review or still needed downstream. Protected items tied to a registered worktree must go through the [safe cleanup process](/en/guides/worktrees/) first.
4. Stale in-progress or blocked entries left by an agent that crashed or forgot to wrap up can be archived by the room owner, as long as no protected worktree is held. They are not stuck forever.

The archive doesn't count toward current items and doesn't show up in agents' current whiteboard summary. Apart from the 3-day milestone auto-archiving above, the whiteboard never archives or deletes by age or count. MCP's `hive_board_read` returns at most **50 current items** per column; it is not a full history export. Use the web UI to see the archive or more records.

Archiving is reversible; **permanent deletion in the archive view is not**. Starting a new topic or just clearing the chat keeps the whiteboard and archive. "Clear room" archives the current whiteboard by default and is refused while protected workspaces exist, so clearing can't be used to bypass a claim.

## Ask a person only when a decision is needed

When an agent is missing a key decision, information, or authorization, it uses `hive_ask_human`. If it needs a person to act in an external system (click something, scan a code, sign in, take over a page, confirm a verification code), needs credentials or an account, or is about to do something irreversible, external, or costly that nobody explicitly approved, the agent must ask right away. It must not wait until the end of the turn to mention it in passing, or poll on its own. Things it can judge for itself, like scope and approach, still don't warrant a question.

1. State what's done, the one decision that's missing, and a recommendation.
2. Multiple-choice questions can offer **2–10 options**, single or multi-select; the web UI adds an "Other" input automatically. You can also skip options and let the person answer freely.
3. After asking, the task becomes "Waiting for your answer". The agent gives a short note and ends the turn instead of polling in place.
4. When a person picks an option or replies to the question, the server wakes the asking agent with the answer. No extra mention is needed.

![A question card from codex: it explains that two pages round amounts inconsistently and that a reproducing test is already written in a worktree, offers single-choice options A, B, and C plus an "Other" input, with status "Waiting for your answer".](/media/screens/ask.png)

Screenshot of the demo environment: names, rooms, and repos are sample data, and the image follows the docs' light/dark theme. Pick an option or write an answer in "Other", and it goes straight back to the agent that asked.

A regular question isn't subject to the stuck-task timeout for running tasks, and it isn't a tool permission request that "must be approved within 10 minutes". The turn that asked ends normally and the question stays answerable; once it's stopped, withdrawn, or already handled, trust the status shown on the page.

Questions and answers are visible in the room. Never use options to ask for passwords, tokens, or anything else that shouldn't be public. Don't keep asking about small things the agent can decide itself; genuine tool overreach goes through [one-time tool approval](/en/guides/permissions/).

## Scheduled and recurring tasks

"Remind, check, or run something at a certain time" should use `hive_schedule_create`, not the runtime's own timers, `sleep`, or system cron. Hive schedules are stored persistently on the Server. The **Schedules** panel in the left sidebar gathers the scheduled tasks of every room you can see, labels each with its room, and lets you filter by room, view them, cancel them, and end a series. The entry shows how many are pending and highlights new failures or misses.

### Confirm the time and scope when creating

Have the agent turn "tomorrow morning" into a **specific date, time, and time zone**, and write it out in its reply for you to check. The tool's `runAt` must include a time zone offset, such as `2027-01-20T09:00:00+08:00`; that date is only a format example, and real tasks must use the time you confirmed.

`task` must be executable without the current session: state what to check, what to produce, who to send it to, and what's off limits. Only the agent that registered it is woken when it's due; other names in the scheduled message don't hand work to another agent.

### Due doesn't mean done on time

- The server sends a "⏰ Scheduled task" message on behalf of the original requester, addressed to the agent that registered it; the task can still queue, find the agent offline, or fail.
- If the Server isn't running, or the task gets its turn more than **10 minutes** after it was due, it's marked as missed and is not run retroactively.
- For a recurring task, set `everyMinutes` and `until` once. The minimum interval is **5 minutes**, with at most **288 runs**. The server schedules the next run, so don't re-register on every run.
- If the previous run of the same series is still queued, running, or stopping, or the turn that asked a question hasn't ended yet, this run is skipped to avoid overlap.
- Click "End series" or use `hive_schedule_cancel` on the pending run to stop future runs. This doesn't undo anything already started or finished.

A scheduled message is a reminder carried out under the original authorization, **not a new high-risk authorization**. For side effects like deletion, deployment, or sending externally, still ask a person when in doubt.

## Cross-room work and progress messages

In tasks started by the room owner, an agent can use `hive_room_create` to create a room, optionally with a local workspace, and `hive_room_post` to hand out work in another room, named by its ID or display name. Tasks started by guests or between agents can't use these to widen what they're allowed to do with rooms.

Results of cross-room work **stay in the target room**, unlike the automatic receipt from `hive_invoke`. The delivery should tell the person where to look, rather than assuming the original room received the result.

When a task started by a person is expected to take a long time (say, more than 5 minutes), the agent first posts a progress update explaining the plan and rough duration, then posts again when a stage completes, something turns out differently than expected, or there's an intermediate result: at most **3** for tasks started directly by a person, **1** for tasks delegated between agents. Progress isn't the final delivery, isn't for heartbeats or percentages, and doesn't wake other agents. When merely naming someone, don't add a mention, so a notification doesn't turn into a new task.
