# v1.0.0 release preparation

This is a release target, not a published version. No tag, GitHub release,
registry push or public deployment is performed by this documentation task.

## Repository readiness

The existing README covers the overview, visual placeholders, confirmed features,
architecture and message-flow diagrams, setup, security, measurements, engineering
trade-offs and limitations. Detailed Docker, event, testing and CI documentation
is linked rather than duplicated. The MIT licence is present in `LICENSE`.

The recovered [automatic workflow](../.github/workflows/ci.yml),
[manual E2E workflow](../.github/workflows/e2e.yml), CI helpers and
[CI documentation](ci.md) have been inspected. Their triggers, service isolation,
permissions and tag-derived image metadata match the README. Missing Prompt 15
files are no longer a release blocker. Successful GitHub-hosted execution still
needs confirmation for the final release commit.

The root and all three workspaces remain private packages at `0.1.0`. Those
internal versions are separate from the planned application release tag
`v1.0.0`; publishing derives the image version from that tag. No npm package
publication or manifest/lockfile version rewrite is performed in this docs task.
Application behavior, schema, dependencies and security controls are unchanged.

## Diagnostic artifact review

`scripts/load/commit-diagnostics.json` is an **intended, safe-to-commit project
artifact**: the README/load report reference it as a compact historical benchmark
summary. Its exact field allowlist was reviewed. It contains workload dimensions,
operator-labelled settings, six timestamps, non-sensitive source basenames,
SHA-256 checksums of result files, latency measurements, loss/duplicate counts
and reconciliation flags. It contains no credentials, connection URLs, password
hashes, session identifiers, tokens, user emails or machine-specific paths.
The SHA-256 fields are report-file checksums, not authentication material.

All six checksums and measured fields match the existing local raw reports.
The medians recompute to 251 ms ON and 28 ms OFF. The labels are operator-supplied
experiment labels, not proof obtained from querying the server configuration.
These are historical diagnostics, not capacity or crash-durability guarantees.
Keep the raw `scripts/load/results/` directory ignored; do not replace this
reviewed summary with unrestricted environment dumps. The JSON is preserved
without content changes during this completion pass.

## Validation record

Fresh checks completed on the recovered working tree on **2026-11-11**:

| Check                                              | Actual result                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint and additional CI-helper lint      | Passed                                                                                                                 |
| Workspace unit tests                               | 98 passed                                                                                                              |
| Docker configuration tests                         | 15 passed                                                                                                              |
| PostgreSQL/Redis integration tests                 | 89 passed                                                                                                              |
| Coverage command                                   | Passed all existing independent 80% line thresholds                                                                    |
| Coverage lines                                     | Shared 96.77%, API 92.51%, web 91.26%                                                                                  |
| Playwright                                         | 9 passed; existing local API/preview mode                                                                              |
| CI helper and load-harness tests                   | 5 and 8 passed respectively                                                                                            |
| Application build                                  | Passed through `npm run test:e2e` prerequisite                                                                         |
| Docker                                             | Static configuration and complete live verifier passed for both loopback origins                                       |
| Production audit                                   | 0 vulnerabilities, exit 0                                                                                              |
| Full audit                                         | 11 moderate development findings, exit 1; no forced fixes                                                              |
| Formatting and local documentation links           | Passed                                                                                                                 |
| Workflow YAML, shell syntax and security structure | Passed local checks; GitHub-hosted execution unverified                                                                |
| Mermaid                                            | Simple diagram grammar, node/participant references and requested restrictions checked; visual rendering not performed |
| Diagnostic JSON                                    | Exact safe-field allowlist, six source checksums, measured fields and medians verified                                 |

All **44 local documentation links and anchors** checked across the README,
security notes, docs directory and load README resolve. A read-only
`SHOW synchronous_commit` returned `on` for both development and integration
databases; no setting was changed.

The fresh coverage run reproduced the recovered [coverage report](coverage.md)
exactly at workspace level. The existing document was preserved, including the
resolved working-tree content. No thresholds or coverage exclusions changed.
These are current results; earlier failed or interrupted runs remain historical
observations and are not counted as successful executions. No retries, manual
skips or increased timeouts were introduced. No new load campaign was run.

Formatting/link and workflow syntax checks are local validation, not GitHub's
workflow evaluator or Mermaid renderer. No new validator packages were installed;
`actionlint` and a Mermaid renderer are not installed in this environment.

## Remaining release verification

- Confirm required GitHub-hosted checks and manual Docker E2E for the final
  reviewed commit. Local E2E uses the existing local fixture mode, not the hosted
  workflow's fresh isolated Compose browser mode.
- Review Mermaid appearance in GitHub's Markdown preview. No fabricated images,
  CI badges or deployment URLs are used.
- Review the 11 moderate development findings; the production dependency audit
  is clean. Compatible dependency updates are outside this docs task.
- After approval, verify actual tag-triggered GHCR packages and the eventual
  release. Their names/configuration have been inspected, but no publication is
  performed or claimed here. Public deployment, if desired, is a separate action.

Found but not changed: auth, channel and socket integration teardown still
assumes Redis was initialized before calling `redis.quit()`. An earlier database
setup failure exposed that cleanup weakness. Today's successful tests do not
exercise that setup-failure path; changing test infrastructure is outside this
documentation completion pass.

No Git or stash operation, application/dependency change, container startup or
shutdown, tag, release, image push or deployment was performed.

## Manual release checklist

After review and merge, an authorized maintainer should complete these steps:

1. Confirm all required hosted checks pass for the exact release commit, review
   workflow permissions/action pins, and run the manual real-stack E2E workflow.
2. Review the final README, licence, security notes, links and Mermaid rendering
   on GitHub. Record accepted audit findings and confirm the documented distinction
   between private package versions and the application tag. Add only genuine
   screenshots or recordings if desired; placeholders are deliberate.
3. Set the web image's exact deployment `PUBLIC_ORIGIN` when appropriate. Review
   its HTTPS ingress/CSP implications in `docker.md`. Ensure Actions is enabled
   and package publication is permitted by repository/organization policy.
4. Review migration compatibility, backups and restoration procedures before any
   real deployment. Local two-replica Compose is not proof of high availability.
5. Only after approval, manually create and push the `v1.0.0` tag for the reviewed
   commit. Do not retag a different commit to hide a failed release.
6. Confirm tag-triggered checks succeed before image publication. Verify separate
   API/web GHCR packages, their `v1.0.0` tags, source/version labels and image
   digests. Change package visibility to public if intended and verify access.
7. Manually publish the GitHub release for that exact tag with honest release
   notes: implemented behavior, validation evidence, known limitations and Docker
   instructions. Do not describe an image or deployment as published before it is.
8. Public deployment is a separate authorized action. Confirm TLS, cookies,
   readiness, browser-facing headers and authenticated cross-instance behavior on
   the actual target before making deployment claims.

No release creation command is run automatically by this checklist.
