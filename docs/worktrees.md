# Managed worktrees

This implementation checkpoint provides the server-side registry, MCP tools and branch claims. The web/IM cleanup workflow and automatic runtime write-root integration are not part of this checkpoint.

## Create and reuse

Only a writable, server-managed local agent working on an owner's task can create or remove a worktree. Guest-origin tasks, guest agents, unconfigured agents and remote/proxied requests are rejected. The room must have a local, non-bare Git workspace.

Call `hive_worktree_create({ slug, base?, branch? })`. The default directory is `<repository-parent>/<repository-name>-wt/<agent>-<slug>` and the default branch is `feat/<agent>-<slug>`. Creation uses the latest **local** default-branch commit: the local branch named by `origin/HEAD`, falling back to `main` or `master`. It does not fetch, pull, change the primary checkout, install dependencies or execute Git hooks.

A slug identifies one development task line, not one message. Supplements, retries and review changes reuse the slug. Call create again before working on that line to register the current invocation as an occupant. Concurrent creates are serialized; an existing managed checkout is reused after its identity is verified. Explicit changes to its branch or base are rejected. The same slug in a different room is not silently adopted into another session.

Reservations are persisted before Git runs. Failed creations remain visible and are not forcibly removed. An interrupted successful creation can be reused if its repository, path and branch still match the reservation.

Existing manually created directories, including the current `superhive-wt` convention, are not adopted or deleted. They can continue to be used manually. New managed directories use the actual repository directory name; no existing paths are moved.

## Runtime permissions

Creation does **not** switch an agent's cwd or move its old runtime session. Full-access agents can explicitly execute commands in the returned directory. A workspace-access agent receives `requiresWorkspaceApproval: true`: creating a checkout on its behalf does not grant the running model write access outside its sandbox. It must obtain a local-owner directory approval or be started with that checkout as its workspace before writing. The CLI's existing `--allow-root` controls following room workspaces, not a blanket write grant to every sibling checkout.

Automatic safe runtime/root integration and its real-Codex workspace-write test remain a separate implementation stage. Do not present this checkpoint as automatic sandbox integration.

## Inventory and cleanup

`hive_worktree_list()` reports only registered worktrees, including tracked changes, untracked and ignored files, merge evidence, active invocation IDs and whether removal is safe. Failed Git checks or changed checkout identities are not removable. Ignored files are also protected: this includes `.env`, build output and dependency directories, which must be handled explicitly before removal.

`hive_worktree_remove({ path, deleteBranch? })` validates the exact registered directory and linked Git identity. It refuses dirty, untracked, ignored, unmerged, locked or occupied checkouts. It never uses force or recursively deletes an arbitrary path.

Merge evidence is evaluated against the recorded default branch's current commit:

- Ordinary merges use ancestor reachability.
- Linear cherry-picks use Git's patch-equivalence checks; unrepresented merge commits are not accepted through this shortcut.
- Multi-commit squashes compare the aggregate patch with first-parent target-branch patches. Search is bounded to 500 commits and Git operations have time/output limits. Uncertain or unmatched histories remain non-removable rather than being guessed safe.

Bound running, queued, cancelling, waiting-human and unresolved timed-out invocations block cleanup, as do their active descendants and queued tasks for the same room/agent. A new independent task must register its slug before writing. A completed turn alone is not proof that a branch was merged.

Branch deletion defaults to `git branch -d`. Squash/cherry-pick equivalence can justify removing the checkout while Git still refuses `-d`; in that case the tool reports `removed: true`, `branchDeleted: false` and `branchError`. The branch is retained. `deleteBranch: false` also retains it. No force option is provided.

The owner should approve cleanup after merge, not after every reply. Batch reminders, a selection/cleanup interface and IM buttons remain to be implemented; there is no background deletion in this checkpoint.

## Claims

`hive_board_update({ ..., claim: { repo, branch } })` uses a canonical repository identity, including calls from linked checkouts or symlinks. An active claim cannot be taken by another entry, even in another room. The existing author updating the same entry without specifying `claim` preserves it; another author does not implicitly inherit an inactive claim. Moving the entry out of `in_progress` releases the active claim. Active claimed entries are not silently evicted by the usual board limit.

Creation registers its own whiteboard entry and claim. Claims coordinate agents; they are not filesystem locks or a security sandbox. Direct Git/shell operations by other programs can still change the checkout. Removal rechecks identity, occupancy and branch tip and uses Git's non-forced worktree removal.
