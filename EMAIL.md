# Resend SMTP setup for Youth Capital

Use **smtp.resend.com:587 with STARTTLS**. Hetzner blocks outbound 25/465 by default but permits 587. Django already sets `EMAIL_USE_TLS=True`; its `EMAIL_USE_SSL` remains false. No Resend SDK, dependency change, or image rebuild is needed.

This guide uses **noreply@yoshlarkapitali.uz** as the sender and verifies **yoshlarkapitali.uz** in Resend. These are outgoing application emails, such as password resets. A sending identity is not a staffed mailbox; set up a separate inbox if you want to receive replies. If you already verified a sending subdomain instead, use that subdomain in both the sender address and API-key restriction.

## 1. Add and verify the sending domain

1. Create/sign in to your account at [Resend](https://resend.com/), then open [Domains](https://resend.com/domains).
2. Click **Add domain**, enter `yoshlarkapitali.uz` without `https://` or a path, and choose the sending region you intend to use.
3. Keep **Sending** enabled. Leave **Receiving** disabled for this outgoing SMTP setup.
4. Open the domain's DNS setup. Choose manual setup if you want to add the records yourself; Resend also provides a Cloudflare authorization flow.
5. In another tab, open **Cloudflare → yoshlarkapitali.uz → DNS → Records**. Add the sending records displayed by Resend, copying their actual values:

   | Resend record | Cloudflare fields |
   | --- | --- |
   | DKIM TXT | Type `TXT`; Name usually `resend._domainkey`; Content is the complete public DKIM value displayed by Resend; TTL Auto. |
   | SPF TXT | Type `TXT`; Name usually `send`; Content is the complete SPF value displayed by Resend; TTL Auto. |
   | Return-path MX | Type `MX`; Name usually `send`; Mail server and Priority exactly as displayed by Resend; TTL Auto. |

   Resend's dashboard is authoritative: names can differ for a custom return path or a verified subdomain, and the MX destination depends on region. Do not invent a DKIM key or copy a region-specific MX example from another project. In this Cloudflare zone, `send.yoshlarkapitali.uz` corresponds to Name `send`.

6. Preserve existing mailbox MX records at `@`. The sending return-path MX at `send` is a different hostname. Do not enable incoming mail or replace root MX records just to send app emails. If an SPF record already exists at the exact requested hostname, reconcile it rather than creating a second SPF policy there.
7. Return to Resend, click **I've added the records / Verify**, and wait until the **Sending** capability is verified. Resolve any individual record failures shown there before continuing.

**Keep the website's A/AAAA records orange-cloud proxied.** TXT and MX records are not HTTP-proxied; adding email authentication records does not require turning off the website proxy. If Resend supplies a verification CNAME, that specific verification record must be unproxied, not the website's root records.

If adding DMARC, first check whether `_dmarc.yoshlarkapitali.uz` already exists. Preserve an existing policy. If absent, Resend's domain setup can guide an initial monitoring policy; tighten it after confirming your legitimate senders authenticate correctly. For password-reset emails, leave open/click tracking disabled to preserve the original authentication links.

## 2. Generate the SMTP credential

1. Open [Resend → API Keys](https://resend.com/api-keys).
2. Click **Create API key**.
3. Name it `youth-capital-prod-smtp`.
4. Choose **Sending access** and restrict it to the verified `yoshlarkapitali.uz` domain. Full account access is unnecessary for sending.
5. Create it and copy the full token beginning `re_` immediately. Resend does not let you retrieve the token value later.

That **API key is the SMTP password**. SMTP username is always `resend`: not your account email, sender address, key ID, or key name. Store the token directly in the GitHub environment secret below; do not commit it or paste it into chat. No separate SMTP password needs to be generated.

## 3. Fill infra/prod with the exact values

Open [infra → Settings → Environments](https://github.com/Youth-Capital/infra/settings/environments), click **prod**. Use its **Environment secrets** and **Environment variables** sections:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `EMAIL_HOST_USER` | `resend` |
| Secret | `EMAIL_HOST_PASSWORD` | The complete `re_...` token you just generated. |
| Variable | `EMAIL_HOST` | `smtp.resend.com` |
| Variable | `EMAIL_PORT` | `587` |
| Variable | `DEFAULT_FROM_EMAIL` | `Youth Capital <noreply@yoshlarkapitali.uz>` |

Paste values without surrounding quotation marks. A display name in `DEFAULT_FROM_EMAIL` is supported. The sender's domain must match the domain verified in Resend and allowed by the key.

Keep these values in **infra/prod only**. The backend/frontend repositories do not need the Resend key, and you do not need an extra `RESEND_API_KEY` secret: our existing SMTP settings read `EMAIL_HOST_PASSWORD`. Likewise, no GitHub `EMAIL_USE_TLS` variable is needed; production settings already enforce STARTTLS. Do not select implicit SSL/465 in a mail configuration wizard.

## 4. Apply the settings to the running backend

Changing GitHub values alone does not update the server's installed runtime file.

1. Open [infra → Actions → deploy-backend](https://github.com/Youth-Capital/infra/actions/workflows/deploy-backend.yml).
2. Click **Run workflow** and select branch **main**.
3. Leave **expected_image** empty.
4. Set **apply_shared=true** (checked).
5. Start the run. Wait for **Validate infra** and **Deploy backend** to succeed; approve the prod deployment if your environment requires it.

This installs the new private runtime settings and reapplies initialized services with their current pinned images. It may briefly interrupt the backend. You do not need to rebuild images or rerun server bootstrap for an SMTP provider change. Do not edit `/opt/youthcapital/runtime/backend.env` by hand, since a future shared apply replaces it.

## 5. Check the connection from the VPS

In a trusted admin SSH session or Hetzner console, run this **on the Ubuntu VPS**, not your laptop. It tests TCP 587 and TLS without sending credentials or an email:

```bash
timeout 20s openssl s_client -starttls smtp \
  -connect smtp.resend.com:587 \
  -servername smtp.resend.com \
  -verify_hostname smtp.resend.com \
  -verify_return_error -brief </dev/null
```

Look for a negotiated TLS version and successful certificate verification. A timeout means outbound connectivity needs attention; check any custom Hetzner/host egress rules. No inbound SMTP firewall rule is needed, and no request to unblock 465 is needed for this configuration.

## 6. Send one explicit test from the backend container

The following command sends a real message. Replace `REPLACE_WITH_YOUR_OWN_EMAIL` with an inbox you control before executing it. Run in the **VPS admin session/console**; credentials are read from the container's installed runtime environment and are not printed.

```bash
cd /opt/youthcapital
sudo docker compose -p youthcapital \
  -f compose.yaml -f apps/backend/compose.yaml \
  --env-file apps/backend/image.env \
  exec -T backend python - <<'PY'
import django
django.setup()
from django.conf import settings
from django.core.mail import get_connection, send_mail

recipient = "REPLACE_WITH_YOUR_OWN_EMAIL"
if recipient == "REPLACE_WITH_YOUR_OWN_EMAIL":
    raise SystemExit("Set your own recipient address before running this test.")
assert settings.EMAIL_HOST == "smtp.resend.com", "Wrong runtime host; apply shared settings."
assert settings.EMAIL_PORT == 587, "Expected SMTP port 587."
assert settings.EMAIL_USE_TLS and not settings.EMAIL_USE_SSL, "Expected STARTTLS, not implicit SSL."
with get_connection(timeout=20) as connection:
    sent = send_mail(
        subject="Youth Capital — production SMTP test",
        message="This message was sent from the production Django container using Resend SMTP on port 587 with STARTTLS.",
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[recipient],
        fail_silently=False,
        connection=connection,
    )
print(f"SMTP accepted {sent} message(s).")
PY
```

Expected: `SMTP accepted 1 message(s).` This confirms provider acceptance, not final inbox placement. Open [Resend → Emails](https://resend.com/emails), find the test and inspect its delivery status; also check your inbox/spam folder. Inspect received authentication headers for SPF/DKIM/DMARC results.

Finally, use the site's **Forgot your password?** flow with an existing account whose mailbox you control, and confirm its link begins `https://yoshlarkapitali.uz/auth/reset-password`. The current app intentionally responds generically for unknown accounts and uses `fail_silently=True` for this mail call. Therefore, the UI confirmation or HTTP 202 alone is not evidence that SMTP worked; use the explicit test and provider delivery status above. Do not share reset links or their tokens in logs/screenshots.

## Troubleshooting and key rotation

| Symptom | Check |
| --- | --- |
| Authentication failure | Username exactly `resend`; password is the full API token, without quotes/whitespace. Check it was applied to the container and not merely saved in GitHub. |
| Sender/domain denied | Sending domain is verified, the key permits that domain, and DEFAULT_FROM_EMAIL uses it. Use your verified domain rather than `resend.dev` for production recipients. Complete any account approval requested by Resend. |
| TLS or certificate error | Port 587, STARTTLS enabled, correct host, working system time and CA certificates. Keep certificate verification enabled. |
| Connection timeout | Test from the VPS/container; inspect outbound restrictions to smtp.resend.com:587. This configuration does not use 465. |
| Accepted but not in inbox | Inspect Resend delivery/bounce events, spam folder, recipient address, suppression state and account limits. |
| Reset UI says sent but Resend has no message | Verify the account exists, then run the explicit SMTP test to expose errors rather than relying on the generic UI response. |

To rotate the token: create a replacement with the same sending/domain scope, update only infra/prod's `EMAIL_HOST_PASSWORD`, run deploy-backend with `apply_shared=true`, and verify a test. Then revoke the old key in Resend. No image rebuild is required.

Sources checked 2026-10-17: [Resend SMTP](https://resend.com/docs/send-with-smtp), [Resend Django STARTTLS](https://resend.com/docs/send-with-django-smtp), [Cloudflare DNS setup](https://resend.com/docs/guides/dns/cloudflare), [API keys](https://resend.com/docs/dashboard/api-keys/introduction), [verified domains](https://resend.com/docs/dashboard/domains/introduction), [Hetzner mail ports](https://docs.hetzner.com/cloud/servers/faq/#why-can-i-not-send-any-mails-from-my-server).
