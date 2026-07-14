# v1 release and recovery notes

## Release status

The v1 implementation is pre-release. Protocol, core, Vault/config workflows, safety checks, and deterministic simulation are implemented, but a release build is not approved until all external provider and desktop lifecycle gates have evidence. Mobile is explicitly outside the v1 release scope.

## Legacy prototype migration

The old `.s3-sync/manifest.json` repository cannot be upgraded in place. Do not point v1 at it as if it were a v1 repository and do not rebuild remote state over it.

1. Keep the existing Vault and old remote objects unchanged.
2. Create or select a new v1 repositoryId under the chosen Prefix.
3. Run non-destructive onboarding. Local-only bytes become root versions only after confirmation; remote-only bytes are previewed before apply.
4. Resolve any explicit Vault or ConfigTree conflicts.
5. Enable automatic triggers only after the initial audit, projection confirmation, and pending work are complete.

Replacing remote content is implemented as a new repository generation. The old generation is retained for rollback and requires separate maintenance credentials for later deletion.

## Disaster recovery

| Condition | Recovery behavior |
| --- | --- |
| Frozen or publishing Outbox after restart | Replay the exact staged objects and Commit bytes in FIFO writer order. Never allocate a replacement sequence. |
| Pending Vault apply or ConfigTree batch | Resume the persisted Journal. Preserve recovery bytes and revalidate current local bytes before each destructive boundary. |
| Empty Vault after local operational state loss | Rebuild projections from a complete verified remote audit, with automatic publication and destructive apply still disabled until confirmation. |
| Non-empty Vault after local operational state loss | Enter non-destructive onboarding. Do not infer parents, deletion, or a safe baseline. |
| Missing or corrupt repository descriptor | Stop publication/apply and retain all local queues. Reattach only to a separately verified repository identity. |
| configDir changed or an unrecorded historical root appears | Stop the old route and migrate to a new repositoryId with the full historical exclusion union. |
| Plugin uninstall/reinstall | Preserve remote objects and any recovery directory. A reinstall without valid local state follows the same empty/non-empty state-loss rules. |

Synchronization is not an independent backup. Confirmed deletions propagate. Provider versioning, object lock, or a separate backup remains recommended.

## Release gates

Run the local deterministic gate on Node 22:

```text
npm run test:ci
```

Run each claimed object-store suite with restricted credentials. These suites create a unique `contract/release/*` namespace and intentionally do not require `DeleteObject`:

```text
npm run test:s3-minio
npm run test:s3-baidu
npm run test:s3-aws
```

For the exact desktop bundle, run the in-plugin desktop runtime contract, restart Obsidian to complete durable-readback verification, and execute startup, suspend/resume, plugin update, disable/enable, uninstall/reinstall, interrupted apply, and state-loss drills on disposable Vaults. Record the app version, OS, bundle Hash, repositoryId, provider, and result outside the repository; never record credentials or content.

Obsidian mobile must not be included in v1 release claims. Enabling it requires a mobile bundle build, runtime contract, lifecycle drill, and a revised support matrix in a later release.
