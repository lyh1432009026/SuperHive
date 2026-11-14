# Managed worktrees

Hive registers task checkouts, binds local runtime sessions to their working directories and provides owner-controlled cleanup on the web and IM. The room sidebar and primary checkout are unchanged.

## Create and reuse

Only a writable, server-managed local agent working on an owner's task can create or remove a worktree. Guest-origin tasks, guest agents, unconfigured agents and remote/proxied requests are rejected. The room must have a local, non-bare Git workspace.

Call `hive_worktree_create({ slug, base?, branch? })`. The default directory is `<repository-parent>/<repository-name>-wt/<agent>-<slug>` and the default branch is `feat/<agent>-<slug>`. Creation uses the latest **local** default-branch commit: the local branch named by `origin/HEAD`, falling back to `main` or `master`. It does not fetch, pull, change the primary checkout, install dependencies or execute Git hooks.

A slug identifies one development task line, not one message. Supplements, retries and review changes reuse the slug. Call create again before working on that line to register the current invocation as an occupant. Concurrent creates are serialized; an existing managed checkout is reused after its identity is verified. Explicit changes to its branch or base are rejected. The same slug in a different room is not silently adopted into another session.

Reservations are persisted before Git runs. Failed creations remain visible and are not forcibly removed. An interrupted successful creation can be reused if its repository, path and branch still match the reservation.

Existing manually created directories, including the current `superhive-wt` convention, are not adopted or deleted. They can continue to be used manually. New managed directories use the actual repository directory name; no existing paths are moved.

## Runtime permissions

For a server-managed local Bridge, creation selects the checkout but does not move an executing session. The tool returns `runtimeHandoff`: finish the setup turn without editing files. Once the runtime has returned normally, the Bridge closes it and continues the remaining task in a new responder and session with the exact checkout as cwd. It refreshes instructions and attachment publication boundaries, retains the configured access level and supplies full room context plus the setup summary. The original session is never resumed under another cwd. A turn with other possible side effects is not continued automatically; the owner must inspect the original checkout before retrying.

Workspace mode does not grant the entire `-wt` parent or another agent's checkout. Codex uses workspace-write at the new cwd; Claude/ACP use their existing workspace access controls at that cwd. Full mode remains full mode, not an OS sandbox. Existing `--allow-root` still controls room following, not a blanket write grant. Upgrade and restart the managed Agent once to load this Bridge version; later handoffs replace only the provider runtime, not the Bridge. Workspace-mode creation is refused until the new Bridge has verified support. Legacy full-access and manually managed Bridges must explicitly use the returned checkout, as stated in their tool response.

An invocation's explicit checkout binding survives changes to room/agent focus, so retrying an older task does not use a newer task's checkout. Unbound follow-up messages use the current focus; Hive does not infer task lines from natural language. Start a different line by calling create with a new slug. To avoid combining lines accidentally, managed writable Bridges process separate messages individually and queue steering. Switching between checkout directories discards the old thread; returning to a saved thread is allowed only when its recorded workspace matches.

## Inventory and cleanup

`hive_worktree_list()` reports only registered worktrees, including tracked changes, untracked and ignored files, merge evidence, active invocation IDs and whether removal is safe. Failed Git checks or changed checkout identities are not removable. Ignored files are also protected: this includes `.env`, build output and dependency directories, which must be handled explicitly before removal.

`hive_worktree_remove({ path, deleteBranch? })` validates the exact registered directory and linked Git identity. It refuses dirty, untracked, ignored, unmerged, locked or occupied checkouts. It never uses force or recursively deletes an arbitrary path.

Merge evidence is evaluated against the recorded default branch's current commit:

- Ordinary merges use ancestor reachability.
- Linear cherry-picks use Git's patch-equivalence checks; unrepresented merge commits are not accepted through this shortcut.
- Multi-commit squashes compare the aggregate patch with first-parent target-branch patches. Search is bounded to 500 commits and Git operations have time/output limits. Uncertain or unmatched histories remain non-removable rather than being guessed safe.

Bound running, queued, cancelling, waiting-human and unresolved timed-out invocations block cleanup, as do their active descendants and queued tasks for the same room/agent. A new independent task must register its slug before writing. A completed turn alone is not proof that a branch was merged.

Branch deletion defaults to `git branch -d`. Squash/cherry-pick equivalence can justify removing the checkout while Git still refuses `-d`; in that case the tool reports `removed: true`, `branchDeleted: false` and `branchError`. The branch is retained. `deleteBranch: false` also retains it. No force option is provided.

Every 30 seconds, the server checks registered checkouts and batches newly eligible ones by room and owner. Notifications are persisted once per checkout/branch tip, not sent after every reply. The web room settings show the branch, agent, path and safety states; select eligible entries, review the paths and confirm removal. A changed branch tip invalidates the selection. Local owner tokens or approved owner-device management grants are required for mutations; the shared Agent join token is insufficient.

The room's cleanup banner and Feishu card can request cleanup of the displayed batch. IM callbacks only enqueue the request, returning promptly; the server rechecks each recorded commit and checkout and sends a separate result. Personal WeChat has no buttons: send the batch-specific `/worktree clean <batch-id>` command from the linked owner account, or use the web. Old or changed batches never authorize a newer branch tip. Ignored files, including `.env` and `node_modules`, remain protected and must be handled separately; there is no force-delete or blanket dependency deletion.

Automatic cleanup is optional and off by default. Enabling it requires explicit owner/device confirmation; only checkouts passing the same checks are removed. Disabling it prevents subsequent batch items, but cannot undo a Git removal already issued. Queued batches survive a server restart. Review/merge remains the reviewer's responsibility; cleanup does not merge or publish changes.

## Verification helpers

`pnpm --filter superhive exec tsx ../../scripts/worktree-runtime.smoke.ts` creates an isolated temporary repository and registered checkout, runs a real Codex workspace Agent inside it, commits/merges the proof, waits for an owner notification and requests batch cleanup. The default separates deterministic checkout setup from the live model write test. `--create-with-model` additionally asks the live model to call the creation tool and exercise setup-turn handoff. Model/network failures are reported, never counted as passed checks. No in-use Agent or user repository is modified.

`pnpm --filter superhive exec tsx ../../scripts/worktree-ui.smoke.ts` serves a disposable production-build UI with eligible, unmerged and dirty checkouts. Stop it with SIGINT/SIGTERM to remove the fixture. Unit/integration tests cover setup handoff, stale workspace/session rejection, other-side-effect refusal, real Git safety checks, owner-only APIs, once-only notifications and IM fallbacks.

## Claims

`hive_board_update({ ..., claim: { repo, branch } })` uses a canonical repository identity, including calls from linked checkouts or symlinks. An active claim cannot be taken by another entry, even in another room. The existing author updating the same entry without specifying `claim` preserves it; another author does not implicitly inherit an inactive claim. Moving the entry out of `in_progress` releases the active claim. Active claimed entries are not silently evicted by the usual board limit.

Creation registers its own whiteboard entry and claim. Claims coordinate agents; they are not filesystem locks or a security sandbox. Direct Git/shell operations by other programs can still change the checkout. Removal rechecks identity, occupancy and branch tip and uses Git's non-forced worktree removal.
