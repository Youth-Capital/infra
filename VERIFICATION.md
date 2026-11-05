# Migration verification

Initially prepared on 2026-10-26. The user authorized committing and pushing the migration on 2026-11-06; deployment remains unapproved. No production migrations, database writes, service starts/restarts/reloads, deployment, DNS change, credential rotation, or volume removal were performed by this migration task. The server was accessed only for inventory, catalog/privilege queries and HTTP/TLS checks. No credentials were displayed.

Before pushing, the latest remote main branches were fetched to preserve newer application changes and image manifests. Backend main includes dependency remediation commit `251bb84` and later feature commits. The scan results below describe the original 2026-10-26 snapshot, not the newer combined revision; release CI must assess that revision. The user requested pushing infra on 2026-11-06. Its source-only main push preserves both image manifests and triggers infrastructure checks; application deployment workflows trigger only on changes to their respective image manifests or manual dispatch.

## Executed checks

| Check | Result |
| --- | --- |
| Linux runtime/release/SSH/quoting and workflow-forwarding tests | 13 passed, no skips |
| Independent Compose, merged edge override, standalone/merged Caddy validation, bootstrap isolation, log redaction and proxy trust tests | 6 passed, no skips |
| Linux shell deployment failure/isolation/timeout tests | Passed |
| Project backup/restore identity, checksum, path and round-trip tests | 5 passed in disposable local Python container |
| Backend database configuration and settings sanity tests | 15 passed; no database access |
| Ruff on changed backend settings/config tests | Passed |
| ShellCheck 0.11.0 | Passed after correcting findings in new shell code |
| Actionlint 1.7.12 | Only the existing `concurrency.queue` property is unsupported by this installed version; passed with that diagnostic filtered |
| Gitleaks | Final infra working source clean; configured backend history scan clean (7 commits); backend working source has the two known synthetic/example false positives below |
| Semgrep, pinned repository rules | Infra and backend: zero findings |
| Trivy source, HIGH/CRITICAL | Infra: zero findings; backend: 7 critical and 26 high pre-existing dependency findings |
| Git whitespace checks | Passed |

Backend Gitleaks working-tree findings are the same conditions documented by its existing history-only `.gitleaksignore`: the synthetic registration-test payload and the empty AUTH_COOKIE_DOMAIN line joined with AXES_FAILURE_LIMIT. The seven inserted DB documentation lines move the latter finding to `.env.example:41`; the test finding remains `apps/accounts/tests/test_registration_consent.py:22`. Neither is a new credential. No broad ignore was added and no security scan was disabled.

The original backend Trivy findings concerned then-pinned dependencies: brotli 1.2.0 (reported fix 1.2.1), certifi 2026.7.22 (2026.10.19), djangorestframework 3.17.2 (3.18.2), and Pillow 12.3.0 (13.0.0). This migration task did not change pyproject.toml or uv.lock; newer upstream commits did update dependencies. The historical results have not been waived and must not be presented as a scan of the newer dependency set. No production image scan/build was claimed; existing application CI retains both source and image scanning.

Source scan reports are stored outside the repositories under the workspace's `.verification/migration-2026-10-26/security/`. Reports are redacted for Gitleaks and are not committed. The final migration source should be rescanned if further code changes are made. Trivy reported no supported configuration files in the infra tree; Compose structure/isolation and Caddy behavior were checked by the dedicated tests rather than claiming Trivy validated Compose security.

GitHub's current documentation supports `queue: max`; the existing configuration was preserved instead of deleting it to accommodate an older linter: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Live inventory and TLS evidence

The shared PostgreSQL catalog confirms `yoshlar_kapitali_db` is owned by `yoshlar_kapitali_user`, currently with zero application tables. The role has LOGIN and no SUPERUSER/CREATEDB/CREATEROLE. Database and schema privilege checks succeeded. Password authentication has not been tested because the app password was not provided through an accessible secure source.

The existing edge owns 80/443; the YouthCapital Compose name, root directory, networks and loopback probe ports were absent/free during inspection. The edge's existing domain is `website-project.uz`. Attaching unique project service names prevents the shared edge from confusing generic backend/frontend aliases across projects.

`yoshlarkapitali.uz` resolves to Cloudflare IPv4/IPv6 addresses and public HTTPS returned 200. Direct SNI/Host TLS to 127.0.0.1 on the **new** server failed with a TLS internal error; the edge has not yet been configured with that hostname/certificate. No successful origin issuance is claimed. Cloudflare dashboard encryption mode, current origin DNS contents, WAF/redirect exceptions and certificate issuance remain rollout checks.

The configured Cloudflare CIDRs match the official [IPv4 list](https://www.cloudflare.com/ips-v4) and [IPv6 list](https://www.cloudflare.com/ips-v6) inspected during preparation. HTTP-01 is configured with TLS-ALPN disabled; [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls) documents these issuer options. Full (strict) requires a valid matching origin certificate: [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/). See SETUP.md for challenge routing and the expected initial issuance window.

## Remaining rollout prerequisites

GitHub CLI returned HTTP 401 for prod settings; no environment settings were written. Git transport access works through its existing credential mechanism as of 2026-11-06, but this does not verify access to prod settings. Enter the existing application password securely. Obtain old-origin SSH access and transfer/verify this project's production data before migrations. Require passing security checks on the combined revision. Review/persist the shared-edge integration and schedule its one-time Caddy recreation. Push approval has been granted; explicit deployment approval is still required before executing rollout steps in SETUP.md.
