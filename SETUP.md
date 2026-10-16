# First production deployment: exact setup

Run **PowerShell blocks on your Windows laptop** and **bash blocks on the Ubuntu VPS**. Replace every `REPLACE_...` placeholder before running its block. Examples use SSH port `22` and account `deploy` throughout.

## 1. Understand which credentials do what

| Credential | Where it belongs | What uses it |
| --- | --- | --- |
| Laptop-generated private key, without `.pub` | `infra` → environment `prod` → secret `VPS_SSH_KEY` | GitHub runner authenticates to SSH as `deploy`. |
| Matching laptop-generated `.pub` key | VPS `/home/deploy/.ssh/authorized_keys` | Server permits that SSH client to log in. |
| VPS public host key from `/etc/ssh/ssh_host_ed25519_key.pub`, prefixed with the server address | `infra/prod` secret `VPS_KNOWN_HOSTS` | Runner verifies the identity of the server it connects to. |
| VPS address | `infra/prod` secret `VPS_HOST` | SSH destination. |
| GitHub App private key | `backend/prod` and `frontend/prod` secret `INFRA_APP_PRIVATE_KEY` | App workflows update infra and observe/retry deployments. |
| GitHub App ID | `backend/prod` and `frontend/prod` variable `INFRA_APP_ID` | Identifies that GitHub App. |
| Automatic `GITHUB_TOKEN` | GitHub supplies it to each workflow | Infra authenticates to GHCR after you grant package Read access. |

**Bootstrap connects as `deploy`, not `root`.** That account must have passwordless sudo. The workflow itself runs `sudo -n ... bash .../bootstrap.sh`, so the installation script executes with root privileges. Do not store a sudo password or root SSH key in GitHub. Root/a trusted admin is needed only for the manual account preparation below. The controller rejects `VPS_USERNAME=root`.

The deployment key is different from the server host key. Never put `/etc/ssh/ssh_host_ed25519_key` (the server's PRIVATE host key) into GitHub. We use its `.pub` file only.

## 2. Prepare the VPS, DNS and provider firewall

Use an x86/64 Ubuntu 24.04 LTS VPS with public IPv4 and IPv6. In your domain's DNS zone, create:

| Record | Name | Value |
| --- | --- | --- |
| A | `@` for the domain root | Your VPS public IPv4 address |
| AAAA | `@` for the domain root | Your VPS assigned public IPv6 address |

For a subdomain, use that subdomain instead of `@`. Use direct DNS records while bootstrapping; all A/AAAA answers must belong to this VPS. Do not enable a DNS provider's HTTP proxy for this setup.

In Hetzner's firewall attached to the server, permit inbound TCP `22`, TCP `80`, TCP `443`, UDP `443`, and ICMP for IPv4/IPv6. Bootstrap also configures Ubuntu's firewall, but cannot open a blocked Hetzner firewall. If SSH source IPs are restricted, the GitHub-hosted runner must also be allowed to reach SSH.

On the laptop, verify DNS (replace the domain):

```powershell
Resolve-DnsName REPLACE_WITH_YOUR_DOMAIN -Type A
Resolve-DnsName REPLACE_WITH_YOUR_DOMAIN -Type AAAA
```

Both must return this VPS's addresses before bootstrap. Docker and Caddy do not need to be installed manually.

## 3. Generate the deployment client key on your laptop

In **Windows PowerShell**:

```powershell
$DeployKey = Join-Path $env:USERPROFILE '.ssh\youthcapital-deploy'
New-Item -ItemType Directory -Force (Split-Path $DeployKey) | Out-Null
if (Test-Path $DeployKey) { throw 'Key already exists. Reuse it or choose another filename; do not overwrite it.' }
ssh-keygen -t ed25519 -f $DeployKey -C 'youthcapital-production'
```

At `Enter passphrase`, press Enter. At `Enter same passphrase again`, press Enter again. This creates:

- `C:\Users\<you>\.ssh\youthcapital-deploy`: PRIVATE key, later copied into `VPS_SSH_KEY`.
- `C:\Users\<you>\.ssh\youthcapital-deploy.pub`: PUBLIC key, installed for `deploy` on the VPS.

Copy the **public** key to the clipboard:

```powershell
Get-Content -Raw "$DeployKey.pub" | Set-Clipboard
```

## 4. Create `deploy` using your existing root/admin access

In **Hetzner Console**, open your project, select this VPS, then click the **console icon at the top right**. Log in as `root` with the server's root password. If the VPS was created with SSH keys and you do not have that password, open the server's **Rescue → Root password → Reset root password** option; Hetzner displays the new password. This is the server's OS password, not your Hetzner account password. Type it into the web console's password prompt; password characters are not displayed.

If you already have a trusted admin SSH session, that also works for account creation. The following block requires a **root shell**: check `whoami`. If it prints a non-root administrator name, run `sudo -i` first. The root password stays out of GitHub; the workflow will use the separate `deploy` key.

On the **Ubuntu VPS**, paste the entire public-key line from step 3 between the single quotes in the first command. The line begins `ssh-ed25519`; do not paste the private key here.

```bash
DEPLOY_PUBLIC_KEY='REPLACE_WITH_ENTIRE_SSH_ED25519_PUBLIC_KEY_LINE'
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos '' deploy
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qF -- "$DEPLOY_PUBLIC_KEY" /home/deploy/.ssh/authorized_keys || printf 'restrict %s\n' "$DEPLOY_PUBLIC_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
printf 'deploy ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/youthcapital-deploy
chmod 0440 /etc/sudoers.d/youthcapital-deploy
visudo -cf /etc/sudoers.d/youthcapital-deploy
```

The last command must report the file parsed OK. This grants root-equivalent administration through sudo, which bootstrap needs to install packages and configure the firewall. The account does not need membership in the `docker` group.

Restrict SSH authentication for this account, still in that **root shell**:

```bash
cat > /etc/ssh/sshd_config.d/60-youthcapital-deploy.conf <<'SSH'
Match User deploy
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
Match all
SSH
/usr/sbin/sshd -t && systemctl reload ssh
sudo -n -u deploy sudo -n id -u
```

The last command must print `0`. SSH commands and SFTP still work; an interactive SSH terminal for this automation key is intentionally disabled. Keep the root/admin console open until the laptop SSH test below succeeds.

## 5. Obtain the EXACT `VPS_KNOWN_HOSTS` value

Use the **Hetzner web console**, so you read the key through the provider's console rather than trusting the first network connection. In its root shell:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
VPS_ADDRESS='REPLACE_WITH_VPS_PUBLIC_IPV4'
SSH_PORT=22
if [ "$SSH_PORT" = 22 ]; then
    printf '%s ' "$VPS_ADDRESS"
else
    printf '[%s]:%s ' "$VPS_ADDRESS" "$SSH_PORT"
fi
cat /etc/ssh/ssh_host_ed25519_key.pub
```

The fingerprint command prints `SHA256:...` for verification. **The fingerprint alone is NOT the secret value.** The final commands print a complete known-hosts line, for example:

```text
203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... root@ubuntu
```

`203.0.113.10` above is an example, not your VPS. Copy your actual complete output line into the GitHub secret `VPS_KNOWN_HOSTS`. The trailing `root@ubuntu` comment is harmless; it does not select the SSH login user. The hostname/address at the beginning must exactly match the `VPS_HOST` secret. Use the bare IPv4 for both when starting out.

For a custom SSH port such as `2222`, set `SSH_PORT=2222` and `VPS_PORT=2222`; the generated line begins `[your-address]:2222`. Changing the variable does not reconfigure the server's SSH port. A literal IPv6 address uses the same bracketed format for a custom port. Never copy the whole `/root/.ssh/known_hosts` file: it describes servers that root previously contacted, not necessarily this VPS.

Now test the SAME key, host trust and account the workflow will use. In **Windows PowerShell**, replace the two placeholders:

```powershell
$VpsAddress = 'REPLACE_WITH_VPS_PUBLIC_IPV4'
$DeployKey = Join-Path $env:USERPROFILE '.ssh\youthcapital-deploy'
$KnownHostsPath = Join-Path $env:USERPROFILE '.ssh\youthcapital_known_hosts'
$KnownHostsLine = 'REPLACE_WITH_COMPLETE_KNOWN_HOSTS_LINE_FROM_CONSOLE'
Set-Content -LiteralPath $KnownHostsPath -Value $KnownHostsLine -Encoding ascii
ssh -i $DeployKey -p 22 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KnownHostsPath" "deploy@$VpsAddress" 'whoami; sudo -n id -u'
```

Expected output:

```text
deploy
0
```

If it prompts for a password, fails host verification, or says sudo needs a password, stop and correct account/key/sudo/host-trust setup before dispatching bootstrap. A host-key mismatch after rebuilding a server requires repeating the console verification and updating the secret; do not bypass checking.

## 6. Fill `infra` → environment `prod`

Open [infra environments](https://github.com/Youth-Capital/infra/settings/environments). Click **New environment**, name it `prod`, then **Configure environment**. If it already exists, click `prod`. Inside it, use **Environment secrets → Add environment secret** and **Environment variables → Add environment variable**. Restrict deployment branches to `main` under Deployment branches and tags.

Create these **environment secrets** in infra/prod:

| Name | Exact value/source |
| --- | --- |
| `VPS_HOST` | Your VPS public IPv4, e.g. your actual server address. No `https://`, `deploy@` or port. Delete an old environment variable named `VPS_HOST` after adding this secret; workflows now read `secrets.VPS_HOST`. |
| `VPS_SSH_KEY` | Entire contents of the laptop PRIVATE key, including `-----BEGIN OPENSSH PRIVATE KEY-----` and its END line. Use the command below to copy it. |
| `VPS_KNOWN_HOSTS` | Complete verified line generated in step 5, not the fingerprint and not the client public key. |
| `DJANGO_SECRET_KEY` | A newly generated random secret, at least 50 characters. |
| `POSTGRES_PASSWORD` | A newly generated random database password, at least 24 characters; keep it for this database. |
| `EMAIL_HOST_USER` | Real SMTP login from your email provider. |
| `EMAIL_HOST_PASSWORD` | SMTP password/app password/API credential accepted by that provider's SMTP service. |

Copy the private key on your **laptop**, then paste directly into the `VPS_SSH_KEY` secret value:

```powershell
Get-Content -Raw (Join-Path $env:USERPROFILE '.ssh\youthcapital-deploy') | Set-Clipboard
```

To generate a secret on the laptop, run this PowerShell block, copy the printed value into GitHub, then run it **again** to generate the other independent secret:

```powershell
$SecretBytes = New-Object byte[] 64
$SecretRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$SecretRng.GetBytes($SecretBytes)
[Convert]::ToBase64String($SecretBytes)
$SecretRng.Dispose()
```

Create these **environment variables** in infra/prod (explicit defaults shown so you can enter them directly):

| Name | Value |
| --- | --- |
| `VPS_USERNAME` | `deploy` |
| `VPS_PORT` | `22` |
| `DOMAIN` | Your real domain, e.g. `domain-name.uz`; no scheme, slash or `/api`. |
| `ACME_EMAIL` | Your real email for TLS certificate registration. |
| `EMAIL_HOST` | Your provider's real SMTP hostname. |
| `EMAIL_PORT` | `587` for SMTP with STARTTLS. |
| `DEFAULT_FROM_EMAIL` | A sender address your SMTP provider permits. |
| `POSTGRES_DB` | `youthcapital` |
| `POSTGRES_USER` | `youthcapital` |
| `GUNICORN_WORKERS` | `2` |
| `GUNICORN_TIMEOUT` | `300` |
| `AI_DEFAULT_PROVIDER` | `RULE_BASED` |

Optional infra/prod secrets: `SENTRY_DSN`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; leave absent unless using their integration. You do not need them to bootstrap.

**Do not add `INFRA_APP_ID`, `INFRA_APP_PRIVATE_KEY`, `INFRA_REPO` or a manually generated `GITHUB_TOKEN` to infra/prod.** The GitHub App is for application repositories to write infra. Bootstrap uses the automatic job token, SSH credentials and runtime settings above. Even first bootstrap needs Django/database/SMTP settings because it prepares the private runtime files before installing services.

## 7. Run server bootstrap, with these credentials

1. Open [infra Actions](https://github.com/Youth-Capital/infra/actions).
2. In the workflow list, click **server bootstrap**.
3. Click **Run workflow**, select branch **main**, then click the green **Run workflow** button.
4. Open the new run, then **Bootstrap Ubuntu server → Bootstrap server** to see its progress. If `prod` requires a reviewer, approve the waiting deployment in that run.

There are no credential inputs in this form. The job loads the **infra/prod environment secrets and variables** you just entered. It connects as `deploy` with `VPS_SSH_KEY`, checks the server against `VPS_KNOWN_HOSTS`, then executes bootstrap with `sudo -n`. You do not manually run the script as deploy, supply a sudo password, or install a GitHub runner on the VPS.

On a fresh VPS bootstrap installs Docker/Compose and Caddy, configures the firewall/QUIC buffers, prepares runtime/upload directories, and starts Postgres/Redis. It does not require backend/frontend images or GitHub App credentials on the first run. Its HTTPS check can reach the empty Caddy site before application deployment; a browser may show 502 until the app containers are deployed.

After the workflow succeeds, verify from the laptop:

```powershell
ssh -i $DeployKey -p 22 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KnownHostsPath" "deploy@$VpsAddress" 'sudo -n systemctl is-active docker caddy; sudo -n docker compose -p youthcapital -f /opt/youthcapital/compose.yaml ps'
```

Expected: Docker/Caddy report `active`; Postgres and Redis are healthy. Use a trusted admin session for interactive database/admin operations; the deployment key has no PTY.

## 8. Configure the GitHub App for backend/frontend

This is separate from bootstrap. Open **Youth-Capital organization → Settings → Developer settings → GitHub Apps → New GitHub App**. Pick an available name, use `https://github.com/Youth-Capital/infra` as the homepage, disable **Active** under Webhook, and set these **Repository permissions**:

- **Contents: Read and write**.
- **Actions: Read and write**.
- Leave unrelated permissions at their defaults; no Workflows permission is needed.

Choose installation for this organization/account and create the App. On its settings page, copy the numeric **App ID** (not Client ID). Under **Private keys**, click **Generate a private key** and save the downloaded `.pem` file privately. Then **Install App → Youth-Capital → Only select repositories → infra → Install**. If organization permissions prevent creating/installing it, an organization owner must perform this step.

Open the environments page for [backend](https://github.com/Youth-Capital/backend/settings/environments), create/open `prod`, and add:

| Kind | Name | Value |
| --- | --- | --- |
| Environment secret | `INFRA_APP_PRIVATE_KEY` | Entire downloaded GitHub App `.pem`, including BEGIN/END lines. This is NOT the VPS SSH key. |
| Environment variable | `INFRA_APP_ID` | Numeric App ID from the App settings page. |
| Environment variable | `INFRA_REPO` | `Youth-Capital/infra` |

Repeat these three entries in [frontend/prod](https://github.com/Youth-Capital/frontend/settings/environments). Restrict both environments to `main`. **Do not put the App credentials into infra/prod. Do not put VPS credentials in either application environment.** If infra main has a ruleset requiring PRs, permit this installed App to bypass that rule for automated image commits.

## 9. Publish packages, grant pulls, deploy applications

Do this once for **each** application repository:

1. Open its **Actions → CI and release → Run workflow**.
2. Choose **main**, set **publish_only=true**, then run it. Wait for the image scan to pass; deploy/cleanup being skipped in this mode is expected.
3. Open the [Youth-Capital packages page](https://github.com/orgs/Youth-Capital/packages), select that application's container package, then **Package settings → Manage Actions access → Add repository**. Select **infra** and grant **Read**. The publishing repo should have **Admin** access. Do not make the package public to work around a missing grant.
4. Return to that app's **CI and release → Run workflow**, choose **main**, set **publish_only=false**, and run it.
5. Its **deploy** job links to infra's deployment run. Wait for it and the final cleanup job to succeed.

No GHCR PAT needs to be created: infra now pulls with its automatic `GITHUB_TOKEN`. You can deploy either app first. Visit the domain after both are deployed. The [README's first-deployment section](README.md#first-deployment-retries-and-changing-servers) contains the exact manual superuser and catalogue-seeding commands.

## Troubleshoot the setup before rerunning

| Error | Corrective action |
| --- | --- |
| `VPS_SSH_KEY and verified VPS_KNOWN_HOSTS are required` / invalid host | Check infra **environment prod**, secret names and full values. `VPS_HOST` is a secret; do not leave it only under variables. |
| `Permission denied (publickey)` | Ensure VPS_USERNAME is `deploy`, its authorized_keys contains the public half of VPS_SSH_KEY, and `.ssh`/authorized_keys have 0700/0600 ownership/modes from step 4. |
| `Host key verification failed` | Regenerate the known-hosts line through the trusted console for the exact host and port in the environment. |
| `sudo: a password is required` | Reapply the sudoers file and run `visudo -cf` in the admin console; repeat the laptop test and require output `deploy` then `0`. |
| Missing Django/database/SMTP setting | Fill every required infra secret/variable from step 6, even for initial bootstrap. |
| SSH timeout | Verify the actual SSH port, public server address and both provider/Ubuntu firewalls; the runner must reach this port. |
| DNS/IPv6 validation failure | A/AAAA must point directly to this VPS; ensure its provider-assigned IPv6 and default route exist. Bootstrap does not invent addresses. |
| GHCR `denied` / `unauthorized` after publication | Add infra Read under that package's Manage Actions access; app tokens cannot grant infra this access themselves. |

After changing infra environment settings, manually dispatch the relevant app's infra deployment with `apply_shared=true` to install the new runtime settings. Changing GitHub values alone does not change the server. Keep `expected_image` empty for ordinary manual deployment. Failed deployment jobs can be retried after the cause is fixed; do not rerun bootstrap just to replace an application image.

References: [Hetzner console](https://docs.hetzner.com/cloud/servers/getting-started/vnc-console), [GitHub environment secrets and variables](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
