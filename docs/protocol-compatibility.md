# Protocol compatibility

This table is normative for the v1 release. A row marked unsupported must fail closed; it must not be treated as a migration path or a best-effort import.

| Component | Compatibility | Required behavior |
| --- | --- | --- |
| Immutable repository protocol `1` | Supported | Validate canonical bytes, descriptor binding, object keys, limits, and semantics before ingest. |
| Legacy `.s3-sync/manifest.json` prototype | Incompatible | Never read it as v1 state and never upgrade it in place. Use non-destructive onboarding into a new repositoryId. |
| Unknown future protocol number | Unsupported | Stop discovery, publication, and apply for that repository. Preserve local state and remote objects. |
| Same Prefix, different repositoryId | Isolated | Never share heads, writer history, projections, Outbox entries, or configuration identity. |
| Descriptor/configDir identity change | New generation required | Stop the old route and create a new repositoryId carrying the complete current/historical directory union. |
| Node.js `22.x` protocol test runtime | Supported | Release CI must use Node 22. Other Node majors are not release evidence. |
| Obsidian desktop | v1 target | The desktop runtime contract and lifecycle drill must pass for the exact release bundle. |
| Obsidian mobile | Not supported in v1 | `manifest.json` remains desktop-only. Do not infer support from conservative adapter unit tests. |
| MinIO and Baidu Cloud BOS S3-compatible storage | Claimed only with provider contract evidence | Run the provider-specific immutable-write and repository acceptance suites. |
| AWS S3 | Not currently claimed | Run `npm run test:s3-aws` and record release evidence before changing the support claim. |

## Upgrade rules

- A v1 client may join only after it reads and verifies the exact `format.json` bytes for the selected repositoryId.
- Unknown fields, non-canonical JSON, a future protocol number, or a mismatched descriptor Hash are hard failures.
- Writer sequences and frozen Outbox bytes remain bound to one repository fingerprint. Reconfiguration cannot rewrite them.
- Repository generation migration copies verified logical heads into a new immutable namespace, audits both generations, switches only after equivalence, and retains the source for rollback.
- The legacy prototype has no compatible causal history. Its local Vault is treated as ordinary unconfirmed local content during v1 onboarding.

The machine-readable runtime and provider claims are in `protocol/support-matrix.json`. The executable frozen-scenario evidence is in `protocol/frozen-scenarios.json`.
