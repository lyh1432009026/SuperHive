---
title: Install and start SuperHive
description: Check the Node.js and agent CLI prerequisites, install SuperHive globally with npm, start it with hive, then stop, update, and enable autostart safely.
---

## What it's for

SuperHive puts people and multiple agents into one shared chat room. Hive Server stores rooms, messages, and task state; agents work on the computers they join from, each through its own runtime.

Installing Hive doesn't install a model or give you model credits. If you only want to see the web app, you can skip agents for now. For agents to answer, you also need the corresponding CLI, a signed-in session, and an available model service.

## What you need

| Item      | Requirement                                                                          |
| --------- | ------------------------------------------------------------------------------------ |
| Node.js   | 22.12 or later; check with `node --version` first                                    |
| OS        | macOS, Linux, or Windows                                                             |
| Browser   | Able to reach the Hive Server address                                                |
| Network   | Installing and updating need npm access; model calls need access to the service      |
| Agent CLI | Installed and signed in on the computer the agent runs on, e.g. Codex or Claude Code |

The add-agent dialog also offers GitHub Copilot, OpenCode, omp, and OpenClaw. Installation, authentication, and available models for each CLI are up to its provider; Hive won't buy credits for you or solve those sign-in issues automatically.

## Step 1: Start Hive Server

Open a terminal on the computer that will run the service. You don't need to clone the repository. A global install is recommended, in two steps:

1. **Install** (once per computer; this gives you the `hive` command):

   ```bash
   npm i -g superhive
   ```

2. **Run** (starts Hive Server and opens the web UI; use this every time you start it):

   ```bash
   hive
   ```

If you'd rather not install globally, run `npx superhive` instead. It behaves the same as `hive`, and every `hive` below can be replaced with `npx superhive`.

`hive` runs in the background by default, listens on `0.0.0.0:8787`, and tries to open the local web page `http://127.0.0.1:8787` in your default browser. The terminal also shows an address other devices can reach, for example:

```text
[hive] Web UI：http://192.168.1.20:8787
```

The IP is an example; don't copy it. Headless, SSH, and CI environments don't open a browser automatically.

If you only plan to try it on this computer, listen on the loopback address only:

```bash
hive --host 127.0.0.1
```

Other computers then can't connect directly. When you need multi-person or cross-device access, configure networking and access control as described in the [Deployment reference](/en/reference/deployment/).

## Step 2: Confirm the web page and your identity

1. On the Server computer, visit `http://127.0.0.1:8787` and enter a chat username.
2. Confirm you can see the room list, then follow the [Quickstart](/en/start/quickstart/) to add your first agent.
3. On other devices, don't use `localhost` or `127.0.0.1`; those point to the device itself. Regular members join through an invite link from the room owner; owners switching devices should use [device sign-in](/en/guides/rooms/#signing-in-as-owner-on-another-device).

The username is a chat display name, not an account password that grants owner rights just by matching it. Agent names must also not clash with existing members.

![Four-step diagram: start Hive, open the web page, add one read-only agent, then send a targeted message](/media/codex2/quickstart-flow.svg)

This is an original flow diagram, not a real screenshot. Starting the service and bringing an agent online are two separate steps.

## Step 3: Adjust how it starts if needed

| What you want                        | Command                              |
| ------------------------------------ | ------------------------------------ |
| Watch logs in the foreground         | `hive --foreground`                  |
| Don't open the browser automatically | `hive --no-open`                     |
| Use a different port                 | `hive --port 9000`                   |
| Set the data directory               | `hive --data-dir /path/to/hive-data` |
| Disable starting agents from the web | `hive --no-local-agents`             |

Replace the example directory with a real one on your machine. Startup flags apply when starting the service; to change settings while it's running, pass the same flags to `restart` instead of launching another process on the same port.

## Stop, update, and autostart

```bash
hive stop             # Stop; hive off also works
hive restart          # Restart with the original startup settings
hive update           # Update to the latest version; restarts on it if the Server is running
hive update --check   # Only check for a new version, don't install
```

`hive update` first checks npm for the latest version, then installs it with the same package manager you originally used for `superhive` (global npm, pnpm, bun, or yarn, detected automatically). If you're already up to date, it says so. `restart` no longer opens the browser by default; add `--open` if you want it. Only SuperHive itself is updated; external agent CLIs are not.

When you run `hive` in a terminal, it also checks for a new version: it waits at most 1.5 seconds, never blocks you if the check fails, and caches the result for 1 hour. If there's a new version, it suggests running `hive update`. Set `NO_UPDATE_NOTIFIER=1` to turn this off.

When running through `npx`, there's no `hive update`; use `npx superhive@latest restart` to update and restart.

Start the Server automatically when you log in to this computer:

```bash
hive autostart on
hive autostart status
```

`hive autostart off` turns off start at login. Autostart applies to the current system user: macOS uses a LaunchAgent, Linux a systemd user service, and Windows the Startup folder. It's best to enable it after a global install: `hive update` updates in place and keeps the same path, so you usually don't need to re-enable it. Run `hive autostart on` again if you switch Node version managers or change the global install directory. Autostart enabled through npx stops working once the npx cache is cleared.

## Notes

- The default data directory is `~/.superhive/`, which holds messages, authentication data, and logs. Don't share the whole directory as a public attachment; for backup and restore, see the [Deployment reference](/en/reference/deployment/).
- Listening on all interfaces by default doesn't mean it's ready to be exposed to the internet. Public access needs HTTPS/WSS, a correct public address, and extra access control; see [Security boundaries](/en/reference/security/).
- If the web page opens but agents don't reply, check the CLI and its sign-in first. Don't try to fix network or authentication problems by raising local permissions.
- This tutorial describes commands and flows based on the repository's implementation; it hasn't run the install, connected a real model, or verified every platform for you. For problems, see [Troubleshooting](/en/reference/troubleshooting/).
