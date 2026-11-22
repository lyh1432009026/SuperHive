---
title: "Add agents: runtimes, startup, and sessions"
description: Add an agent from the web app step by step, compare six runtimes, start 1–5 at once locally or join remotely, and choose MCP servers and room sessions.
---

## What agents are for

An agent is a collaborator running on a computer. Hive hands room messages to it; it uses its own runtime to read code, answer questions, or run approved tasks, then posts the results back to the room. Hive doesn't install model CLIs for you, and it doesn't turn room members into remote shell users.

Haven't opened a room yet? Start with the [Quickstart](/en/start/quickstart/). Pick a [permission level](/en/guides/permissions/) before starting, and if several people will change code, agree on [task lines and worktrees](/en/guides/worktrees/) first.

## Choose a runtime

| Agent in the web app | Provider in commands | Prepare on the agent's computer        | Typical use                                                                  |
| -------------------- | -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Codex                | `codex`              | Install and sign in to Codex CLI       | Code analysis, implementation, debugging                                     |
| Claude Code          | `claude`             | Install and sign in to Claude Code CLI | Code analysis, implementation, and tool collaboration                        |
| GitHub Copilot       | `copilot`            | Install and sign in to Copilot CLI     | Development in the GitHub ecosystem                                          |
| OpenCode             | `opencode`           | Install OpenCode and configure a model | Use your own configured models and tools                                     |
| omp                  | `omp`                | Install oh-my-pi and configure a model | Terminal tools and models of your choice; note folder permission differences |
| OpenClaw             | `openclaw`           | Configure a Gateway or embedded agent  | Use existing agents and tool policies                                        |
| Echo (command join)  | `echo`               | No model CLI needed                    | Verify networking, identity, and the message path; no real tasks             |

These are Hive's existing adapters. They don't mean every CLI version, model, account, or third-party plugin has been verified as compatible. The runtime must be installed on **the computer the agent actually runs on**; when joining by copied command, it doesn't need to be on the Server.

## Add an agent from the web app in three steps

Click "Add agent" below the member list. Making a selection only changes what's selected; it **doesn't advance to the next step automatically**.

1. **Choose an agent**: compare runtimes, then click "Next". You can't continue without a selection.
2. **Choose a local permission**: the default is "Workspace". Pick Read-only or Workspace, then click "Next". Full access requires confirming the risk first and isn't carried over the next time you open the dialog.
3. **Confirm how to start**: check the name, folder, and MCP servers, then start on this computer, or expand "Or copy the command and run it elsewhere".

![Diagram of adding an agent: manually choose a runtime and permission, then start it on the Server computer or copy a command to run on another computer. Not a real screenshot.](/media/codex4/agent-startup.svg)

This is an original diagram, not a product screenshot. Available buttons and entry points depend on the current page and your signed-in identity.

![The real first step of the add-agent dialog: one card for each of the six runtimes, showing the provider and the version detected on this computer. Click "Next" after choosing.](/media/screens/onboard.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme.

### Start on this computer: 1–5 at a time

![The count control in the local start form: the name is Alice-codex and the count is 3, so it will start Alice-codex, Alice-codex2, and Alice-codex3. Screenshot of an isolated demo interface, cropped to remove the local working directory.](/media/interface/agent-count.png)

Screenshot of an isolated demo interface (cropped). Adjust the count with "− / +". The sample names aren't real members, and the screenshot doesn't prove these three agents were actually started.

In the start form:

1. Enter a name that's easy to tell apart, such as `frontend-agent`. Two agents can't use the same name at the same time.
2. Use "Count" to choose **1–5**. A batch shares the same runtime, permission, folder, and MCP settings; the form shows the names it will start in order.
3. For Workspace or Full access, check the "Working directory". It defaults to the directory Hive was started from; you can also enter an absolute path or `~/project`, or click "Browse…".
4. For Codex and Claude Code, expand "Local MCP servers" to choose what loads. Only enable trusted servers this task actually needs.
5. Click "Start on this computer", wait for each agent's result, then confirm they're online in the member list.

Batch creation happens one at a time. If one fails, the rest are not created, and **agents already started are not rolled back**. Check which names are online before trying again rather than starting another batch. The count isn't a task concurrency quota, and it doesn't guarantee that the agents finish initializing at the same time.

Batch names are numbered automatically and skip names already in the room; go by the "Will start" list below the form before starting. The count control supports the arrow keys, and Home / End jump to the minimum or maximum.

Starting locally is done by the computer running Hive Server, not by the browser installing a CLI on your current device. You can manage it when you open the page directly on the Server computer via `localhost` or a local IP. When the owner signs in from another device, they must request management authorization as the page prompts, and high-risk actions may also need one-time approval. Regular guests don't gain process management rights on the Server this way.

### Copy a command: have another computer join

In step 3, expand the copy-command entry and run the generated command in **the terminal of the agent's computer**. The example below only shows the flags; don't copy its server address or placeholder credential:

```bash
npx --yes superhive@latest join \
  --provider codex \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --room general \
  --name frontend-agent \
  --token YOUR_JOIN_TOKEN
```

- If `superhive` is already installed globally on that computer, you can replace `npx --yes superhive@latest join` with `hive join`; the flags stay the same.
- Use the real connection details generated by the web app; a remote computer can't use the Server's `localhost` address.
- The copied command contains a join credential. **Don't paste it into public chats, screenshots, repositories, or logs.** Guests should use their own invite identity rather than borrowing the owner's credential.
- A command join is a long-running foreground process. `Ctrl+C` in the terminal takes it offline; running the same connection settings again reuses the session and message cursor saved on that machine.
- To modify code, explicitly choose `--access workspace` and `--cwd /absolute/path/to/project`. Don't upgrade to Full access just for convenience.

For more flags, see the [CLI reference](/en/reference/cli/).

## Rooms, folders, and sessions are different things

| Setting or action                     | Actual effect                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| No `--room`                           | Follows the server's unarchived rooms, keeping a separate session and message cursor per room                                           |
| `--room general`                      | Limited to that room                                                                                                                    |
| Setting a room workspace              | Local agents work in the room workspace; command joins still require it to be within the folders they may follow                        |
| `--allow-root PATH` on a command join | Expands the folders it may follow, can be repeated; it doesn't grant arbitrary write access to the whole tree                           |
| Creating a worktree task line         | The managed Bridge creates a new runtime session for the matching cwd through the handoff flow, rather than moving the old session over |

By default, a command join follows the room workspace within `--cwd` and its parent. Agents started locally from the web app can follow the room workspace configured by the owner, but remain bound by runtime permissions.

Sessions and cursors are stored in `~/.superhive/agents/` on the agent's computer, keyed by Server address, room, and name. Resuming a session doesn't mean the last run succeeded, and interrupted tasks aren't all rerun automatically; see [Tasks and recovery](/en/guides/tasks/).

## Do a quick check once it's online

1. Check the exact name in the member list and confirm it isn't still starting or already offline.
2. Send a low-risk request, such as "Summarize the scope of your task; don't change any files yet." In a room with a lead agent, it can also pick up human messages that mention no one.
3. Watch whether the message goes from queued to running. If not, open the task details and the local agent logs.
4. When assigning real work, spell out the goal, writable folders, deliverables, how to verify, and whether committing, pushing, or sending anything externally is allowed.

If the agent doesn't reply, check networking, CLI sign-in, the name, and message routing first; see [Common issues](/en/reference/troubleshooting/). Don't expose credentials or restart the model endlessly while troubleshooting.

## What you can adjust in local settings

In local agent settings you can view logs; stop, start, or restart the process; and adjust available models, supported MCP servers, and the "Auto-steer messages from people" switch. Auto-steer is off by default; read [the difference between steering and stopping](/en/guides/tasks/) before turning it on.

Extra MCP servers for Codex and Claude Code are optional; `hive` always loads. MCP sizes and new-session startup tokens are estimates, not an exact bill. Setting changes apply from later turns, and unchecking a server doesn't undo a tool call already running; use the restart option on the page to restart the agent.

### Agent runtimes: install, update, and CLI configuration

When you open the web app on the computer running Hive Server, "Settings" gains an "Agent runtimes" category that other devices don't see:

- **Installed agent CLIs**: lists each CLI's version, latest version, install location, and install method. Clicking "Update" or "Install" first shows the full command to be run; it runs only after you confirm, one at a time.
- **Runtime base URLs and keys**: view and change the base URL and key in each CLI's global configuration, masked by default. This edits the CLI's own config file, so the same CLI in your terminal is affected too.

![Installed agent CLIs under "Agent runtimes": one row each for Claude Code, Codex, GitHub Copilot CLI, OpenCode, Oh My Pi, and OpenClaw, showing the current version, whether an update is available, the install path, and the source (npm or bun). Rows with an update have an "Update to x" button.](/media/screens/clis.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme. The user directory in paths is shown as `~`.

To teach agents in standalone terminals how to collaborate in Hive, see `hive --skill` or `hive skill install`; usage is in the [CLI reference](/en/reference/cli/). Installing the collaboration instructions doesn't join a room automatically or grant file or tool permissions.
