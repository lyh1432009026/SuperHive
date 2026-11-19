# Managed worktrees

Hive registers task checkouts, binds local runtime sessions to their working directories and provides owner-controlled cleanup on the web and IM. The room sidebar and primary checkout are unchanged.

Directory reservations appear in the whiteboard's collapsed **Task directories** group, separate from ordinary tasks and milestones. They do not count toward task badges or the agent context's ten entries per column. Existing `worktree:` records are classified when read: their IDs, summaries, branches, claims, authors, timestamps and archive state are preserved without rewriting stored rows. Cleared directory records remain available in the same separate group, including in archive history.

## Create and reuse

Only a writable, server-managed local agent working on an owner's task can create or remove a worktree. Guest-origin tasks, guest agents, unconfigured agents and remote/proxied requests are rejected. The room must have a local, non-bare Git workspace.

Call `hive_worktree_create({ slug, base?, branch? })`. The default directory is `<repository-parent>/<repository-name>-wt/<agent>-<slug>` and the default branch is `feat/<agent>-<slug>`. Creation uses the latest **local** default-branch commit: the local branch named by `origin/HEAD`, falling back to `main` or `master`. It does not fetch, pull, change the primary checkout, install dependencies or execute Git hooks.

A slug identifies one development task line, not one message. Supplements, retries and review changes reuse the slug. Call create again before working on that line to register the current invocation as an occupant. Concurrent creates are serialized; an existing managed checkout is reused after its identity is verified. Explicit changes to its branch or base are rejected. The same slug in a different room is not silently adopted into another session.

Reservations are persisted before Git runs. Failed creations remain visible and are not forcibly removed. An interrupted successful creation can be reused if its repository, path and branch still match the reservation.

Existing manually created directories, including the current `superhive-wt` convention, are not adopted or deleted. They can continue to be used manually. New managed directories use the actual repository directory name; no existing paths are moved.

## Runtime permissions

For a server-managed local Bridge, creation selects the checkout but does not move an executing session. The tool returns `runtimeHandoff`: finish the setup turn without editing files. Once the runtime has returned normally, the Bridge closes it and continues the remaining task in a new responder and session with the exact checkout as cwd. It refreshes instructions and attachment publication boundaries, retains the configured access level and supplies full room context plus the setup summary. The original session is never resumed under another cwd. Earlier steps in the setup turn never block the handoff: the Bridge lists every step that may have changed something (with commands that may not have finished and irreversible outbound actions such as push/publish marked) in the new session's first prompt, which must check the original checkout, move or revert stray edits, and ask a human via `hive_ask_human` before redoing an irreversible action whose result is unclear.

Read-only preparation, worktree creation, board updates and explicitly identified `hive_message_send({ progress: true })` notifications do not block this normal setup handoff. These notifications remain side effects for interrupted-turn retries: handoff continues with the setup summary rather than replaying them. Ordinary messages, questions, delegation, edits and unknown tool calls still block automatic handoff. Runtimes that cannot identify progress arguments conservatively treat those calls as ordinary messages.

After `hive_ask_human`, workspace validation remains available while that runtime turn is still unfinished. Once the turn ends, its `waiting_human` question remains answerable, but the old invocation no longer qualifies for workspace execution. Cancellation, resolution, binding checks and local writable-agent restrictions remain unchanged.

Workspace mode does not grant the entire `-wt` parent or another agent's checkout. Codex uses workspace-write at the new cwd; Claude/ACP use their existing workspace access controls at that cwd. Full mode remains full mode, not an OS sandbox. Existing `--allow-root` still controls room following, not a blanket write grant. Upgrade and restart the managed Agent once to load this Bridge version; later handoffs replace only the provider runtime, not the Bridge. Workspace-mode creation is refused until the new Bridge has verified support. Legacy full-access and manually managed Bridges must explicitly use the returned checkout, as stated in their tool response.

An invocation's explicit checkout binding survives changes to room/agent focus, so retrying an older task does not use a newer task's checkout. Unbound follow-up messages use the current focus; Hive does not infer task lines from natural language. Start a different line by calling create with a new slug. Managed writable Bridges look up queued bindings in one request and batch adjacent messages using the same directory, including ordinary unbound messages. Steering remains available for the current directory or an unbound message; messages bound to another directory stay queued with an explanation. Selections are reused only for the immediate batch and refreshed after a turn, never cached across task-line changes. Switching between checkout directories discards the old thread; returning to a saved thread is allowed only when its recorded workspace matches.

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

Manual cleanup also removes those checkouts from pending batch notices. Empty batches or notices for older branch tips expire and cannot be requested again; a partially cleaned batch retains only its remaining checkouts. The web refreshes eligibility and clears expired notices without dismissing a newer batch for the same room. Temporarily occupied or dirty entries are not offered for cleanup.

## Cleanup SOP for reviewers and agents

Removal must go through the occupancy-checked paths: `hive_worktree_remove`, the web Worktree list, or the batch notifications. Never remove another agent's checkout with a raw `git worktree remove` or filesystem deletion, even immediately after merging the branch: queued or in-flight messages can still be bound to that directory, and the runtime's stale-workspace guard will then fail that turn ("Cannot safely select the task workspace") even though nothing was actually lost. The occupancy checks inside the removal tools exist precisely to close that race — accept their refusal while the owner still has running or queued work. Reviewers who merge a branch should leave removal to the owner via the batch notice, or use `hive_worktree_remove` themselves and treat a refusal as "try later", not as an obstacle to bypass. The same rule applies to your own checkout.

## Retired task bindings

Safe removal persists a server-side receipt before releasing the active record, focus and invocation bindings. A queued message or delegated receipt belonging to that retired task finishes without running an Agent or requesting a retry. Its invocation is completed with a `superseded` resolution explaining that the task directory was cleaned up. A new unrelated request remains runnable in the primary workspace; a new live binding takes precedence over an older removal receipt.

If someone bypassed the safe tools and removed both the checkout and its branch, the server can release only the stale registration after verifying the original repository identity, absence of the checkout in Git's worktree inventory, and absence of both the path and branch. The remove tool still requires owner authorization and no active occupants. Workspace selection may release such a registration only when no other invocation is active. The whiteboard explicitly records that this metadata recovery does **not** establish whether the deleted branch was merged. Recovery does not delete files, branches or Git worktree metadata.

A retained branch, remaining checkout registration, replaced directory, changed repository, unknown missing record without a removal receipt, failed verification or other active invocation still blocks recovery. HTTP 403/404 alone never counts as proof of cleanup.

## Verification helpers

`pnpm --filter superhive exec tsx ../../scripts/worktree-runtime.smoke.ts` creates an isolated temporary repository and registered checkout, runs a real Codex workspace Agent inside it, commits/merges the proof, waits for an owner notification and requests batch cleanup. The default separates deterministic checkout setup from the live model write test. `--create-with-model` additionally asks the live model to call the creation tool and exercise setup-turn handoff. `--provider=claude` explicitly uses a temporary Claude Agent instead of Codex; it does not change any production Agent or model setting. The helper checks that the checkout starts with a fresh runtime session. Model/network failures are reported, never counted as passed checks. No in-use Agent or user repository is modified.

`pnpm --filter superhive exec tsx ../../scripts/worktree-ui.smoke.ts` serves a disposable production-build UI with eligible, unmerged and dirty checkouts. Stop it with SIGINT/SIGTERM to remove the fixture. Unit/integration tests cover setup handoff, stale workspace/session rejection, other-side-effect refusal, real Git safety checks, owner-only APIs, once-only notifications and IM fallbacks.

## Claims

`hive_board_update({ ..., claim: { repo, branch } })` uses a canonical repository identity, including calls from linked checkouts or symlinks. An active claim cannot be taken by another entry, even in another room. The existing author updating the same entry without specifying `claim` preserves it; another author does not implicitly inherit an inactive claim. Moving the entry out of `in_progress` releases the active claim. Active claimed entries are not silently evicted by the usual board limit.

Creation registers its own whiteboard entry and claim. Claims coordinate agents; they are not filesystem locks or a security sandbox. Direct Git/shell operations by other programs can still change the checkout. Removal rechecks identity, occupancy and branch tip and uses Git's non-forced worktree removal.
