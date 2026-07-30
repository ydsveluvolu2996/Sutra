# Zoho Mail and Sutra sign-in

Sutra uses the verified `sutracmdb.com` Zoho Mail organization in two separate
ways:

1. public and transactional email through the Zoho Mail REST API; and
2. optional user sign-in through Zoho OpenID Connect (OIDC).

Buying Zoho Mail does not turn the Mail Admin Console into a SAML identity
provider. The SAML screen in Zoho Mail accepts login URLs and a certificate from
another identity provider so that the external provider can sign users *into
Zoho*. Sutra therefore uses Zoho's supported OIDC provider interface instead of
pretending that the mail subscription supplies a SAML IdP.

## Public mail identities

All addresses are aliases of the current primary Zoho mailbox:

| Purpose | Address |
| --- | --- |
| Product and partnerships | `contact@sutracmdb.com` |
| Customer support | `support@sutracmdb.com` |
| Responsible disclosure | `security@sutracmdb.com` |
| Subscriptions and invoices | `billing@sutracmdb.com` |
| Privacy and data requests | `privacy@sutracmdb.com` |

The public contact, privacy, terms, security, and legal-footer surfaces link to
these addresses. They do not expose the primary administrator mailbox.

## Enable Zoho Mail API delivery

The Cloudflare-compatible application runtime cannot open an SMTP socket. The
Zoho adapter therefore refreshes a short-lived OAuth access token and calls the
regional HTTPS Mail API. It never stores or uses the mailbox password.

1. Enable the **Self Client** in the India-region Zoho API Console. Zoho
   documents this client type for server-to-server handling.
2. Generate a code with only `ZohoMail.messages.CREATE`, then exchange it before
   expiry for the long-lived refresh token.
3. Retrieve the primary mailbox account id. If a temporary
   `ZohoMail.accounts.READ` grant is used for this one-time lookup, revoke that
   temporary refresh token immediately; the delivery token should retain only
   `ZohoMail.messages.CREATE`.
4. Put the following values in the ignored operator environment
   (`deploy/ec2/.env.ec2`), never in Git:

```dotenv
SUTRA_CONTACT_RECIPIENT=contact@sutracmdb.com
SUTRA_CONTACT_FROM=Sutra Contact <contact@sutracmdb.com>
SUTRA_CONTACT_PROVIDER=zoho

SUTRA_INVITATION_FROM=Sutra Support <support@sutracmdb.com>
SUTRA_INVITATION_EMAIL_PROVIDER=zoho

SUTRA_ZOHO_DATACENTER=in
SUTRA_ZOHO_MAIL_ACCOUNT_ID=<numeric-account-id>
SUTRA_ZOHO_CLIENT_ID=<client-id>
SUTRA_ZOHO_CLIENT_SECRET=<managed-client-secret>
SUTRA_ZOHO_REFRESH_TOKEN=<managed-refresh-token>
```

The same transport delivers public contact notifications, membership
invitations, password resets, and scheduled cost reports. A send is recorded as
accepted only after Zoho returns a successful response.

## Configure “Continue with Zoho”

Register a second server-based OAuth client for authentication, with this exact
redirect URI:

```text
https://www.sutracmdb.com/api/auth/oidc/callback
```

Configure the provider as one managed, single-line JSON value:

```dotenv
SUTRA_OIDC_PROVIDERS=[{"id":"zoho","issuer":"https://accounts.zoho.in","authorizationEndpoint":"https://accounts.zoho.in/oauth/v2/auth","tokenEndpoint":"https://accounts.zoho.in/oauth/v2/token","jwksUri":"https://accounts.zoho.in/oauth/v2/keys","clientId":"<zoho-client-id>","clientSecret":"<managed-zoho-client-secret>"}]
```

Sutra sends authorization code, S256 PKCE, state, and nonce; exchanges the code
with the confidential client secret only at the pinned Zoho token endpoint; and
verifies the ID token signature, issuer, audience, nonce, expiry, subject, and
verified email before issuing a session.

Do not switch the current private-beta deployment from password identity to
OIDC until the Zoho client has been created, the existing owner has a matching
invitation or membership, and all hosted release gates pass. This prevents an
authentication cutover from locking the administrator out.

## Local credential custody

The workstation setup stores the completed mail and OIDC runtime bundle in the
macOS Keychain service `com.sutracmdb.zoho.integration`, under the primary Zoho
mailbox account. No real client secret, refresh token, or transaction key belongs
in this repository. Copy the values from the secure store to the deployment's
managed/ignored environment only during an approved release.
