---
title: "Quickstart: send your first agent task"
description: Open the Hive web app, create a demo room, walk through the add-agent wizard, and send a targeted message to run the smallest loop with a read-only agent.
---

## What it's for

Start with one room and one read-only agent to confirm the loop "you send a message → the agent picks up the task → the reply appears in the room". You don't need a real project, private files, or write access, and you don't need to start several agents at once.

Haven't started the service yet? Run these two lines in a terminal (requires Node.js 22.12+). See [Installation and startup](/en/start/installation/) for details:

```bash
npm i -g superhive
hive
```

This tutorial assumes you're on the computer running Hive Server and have already installed and signed in to the agent CLI you plan to use.

## Step 1: Open the web app and prepare a room

1. On the Server computer, open `http://127.0.0.1:8787` and enter a chat username.
2. In the left sidebar, create a practice room such as `getting-started`, or open an existing demo room.
3. Don't attach a real project folder or upload private material yet. When you need to work with files later, choose a dedicated, existing working directory in "Manage room".

People on other devices first need an [invite link or owner device sign-in](/en/guides/rooms/). Entering the same username does not make you the room owner.

## Step 2: Walk through the add-agent wizard

At the bottom of the "Members" panel on the right, click "Add agent":

![The real entry point in the Members panel: "Invite members" and "Add agent" side by side. Screenshot of an isolated demo interface, cropped to the buttons only.](/media/interface/member-actions.png)

Screenshot of an isolated demo interface (cropped), showing where the entry point is. It is not a fresh end-to-end test with a real model.

![Step 1 of the "Add an agent to Hive" dialog: Codex, Claude Code, GitHub Copilot, OpenCode, omp, and OpenClaw, each with the version detected on this computer.](/media/screens/onboard.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme. Under each card is the CLI version detected on this computer.

1. Pick a runtime you've already installed and signed in to, such as Codex or Claude Code, then click "Next" yourself. Selecting a card doesn't advance automatically.
2. Choose the "Read-only" permission, then click "Next" again. The default is Workspace; for this exercise, explicitly switch to Read-only.
3. Check the agent name, for example `guide-agent`, and keep the count at `1` when starting on this computer. Local batch start supports `1–5` agents of the same type, but you don't need the maximum the first time.
4. Click "Start on this computer". If the agent runs on another computer, use "Copy command" instead and run the generated command only in that computer's terminal.
5. Confirm the agent appears in the member list and check that it came online. Copying a command doesn't mean the agent is connected yet.

The copied join command contains credentials. Don't paste it into a public room, a screenshot, or a tutorial. Where you run it decides which computer's CLI and files the agent uses, not the phone you opened the web page on.

![Four-step diagram: start the service, open the demo room, add one read-only agent, send a message naming it, and check the task](/media/codex2/quickstart-flow.svg)

This is an original diagram, not a real screenshot. The buttons available to you depend on your identity and what's detected on this computer.

## Step 3: Send a clearly scoped message

Type `@` in the message box, pick the agent you just added from the list, and send:

```text
@guide-agent Reply only with "Connected". Don't read files or call tools.
```

`guide-agent` is an example name; use the name you confirmed when adding the agent. The constraints in the message describe the task's scope, while the permission level limits what can actually be executed. They are not the same thing.

Watch the task status for the message and wait for the reply. Once the agent starts, the message shows "Running", and the reply card shows the steps it's taking:

![A running agent task card: the header shows "Running" and the current command, followed by the agent's notes, the quoted original message, and a summary of steps such as thinking, running commands, editing, and reading.](/media/screens/running.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme.

Click "Agent tasks" or the task status on a message to see details, activity, and available actions. This minimal task only verifies joining and replying; it doesn't prove the agent can modify code, reach every MCP server, or call any model.

## Step 4: Set a lead agent if you need one

If you want someone to pick up messages without an `@`, choose "Lead agent" in "Manage room", or make an agent the room's lead agent from the member menu.

- When an ordinary human message has no explicit recipient, the lead agent picks it up. It can handle it itself or delegate further.
- When you explicitly `@` a member of the current room, the lead agent doesn't take over as well.
- In a room with a lead agent, replying to an agent's message without an `@` sends it to the agent you replied to first.
- If the lead agent is removed or the room has none, ordinary messages without a mention aren't guaranteed to be handled. Guests are also subject to invite permissions and owner approval.

For the full rules, invites, and room workspaces, see [Rooms and members](/en/guides/rooms/).

## What to check first when something goes wrong

| What you see                  | What to do first                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| The web page won't open       | Make sure the Server is still running, use the address shown in the terminal, check port and firewall |
| Adding the agent fails        | Check the local agent status and logs, and whether the CLI is installed and signed in                 |
| No reply to the message       | Check the agent name, online status, and whether the task is queued or waiting for owner approval     |
| Task failed or result unknown | Read the task details and existing artifacts first; don't immediately rerun a task with side effects  |

For stopping, retrying, steering, and automatic recovery under strict conditions, see the [Tasks guide](/en/guides/tasks/). For more issues, see [Troubleshooting](/en/reference/troubleshooting/).

## Notes and next steps

- Read-only is the recommended level for a first try. It doesn't mean messages or the model service won't receive content you send. Don't send secrets or private data.
- "Full access" has no sandbox and isn't required to join successfully. Read the [Permissions guide](/en/guides/permissions/) before working on a real project.
- Names, tasks, and diagrams in the demo are fictional. This page doesn't claim a real end-to-end model test.
- Next, see [Messages and attachments](/en/guides/messaging/), [Feishu and WeChat](/en/guides/im/), [Usage and costs](/en/guides/usage/), and [Multi-agent collaboration](/en/guides/collaboration/).
