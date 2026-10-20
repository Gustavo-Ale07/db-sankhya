# Security Policy

Security is a core requirement of DB-Sankhya because the application may be deployed with access to
ERP data and privileged integration credentials. The threat model and the controls are described in
[docs/security.md](docs/security.md).

## Supported versions

Until the first stable release, only the latest revision of the default branch is considered
supported.

## Reporting a vulnerability

Do not publish credentials, production data, exploit details, access tokens, private URLs, or
customer/company information in a public issue.

Prefer GitHub's private vulnerability reporting feature when it is available for this repository.
If private reporting is not available, contact the maintainer privately through the contact options
on the maintainer's GitHub profile before disclosing sensitive technical details.

Please include, when possible:

- affected component;
- impact;
- minimal reproduction steps;
- expected vs. observed behavior;
- whether credentials or production data may have been exposed;
- suggested mitigation, if known.

Reports about the following are especially welcome:

- a statement that reaches the Sankhya gateway without passing the read gate, the capability
  check or the policy engine;
- a write that runs without a matching plan, confirmation, approval or kill-switch check, or that
  is sent more than once;
- a way to gain a permission, approve one's own plan, or act on another user's plans, history or
  scratch workspace;
- a secret (gateway credentials, `AUTH_SECRET`, `ENCRYPTION_KEY`, session tokens) appearing in a
  response, log, history row or audit record.

## Security expectations

Contributions must not introduce:

- hardcoded credentials or tokens;
- production/customer fixtures, real company names, tax ids, hostnames or ERP identifiers (use
  `example.com` and fictitious data);
- private infrastructure details;
- authorization bypasses, including an administrator bypass;
- client-side-only authorization for privileged actions;
- unsafe write paths that bypass the policy engine or the plan lifecycle;
- retries of non-idempotent gateway calls;
- execution of native DDL;
- logging of secrets or authentication material.

## Deployment responsibilities

The operator of a deployment is responsible for:

- generating unique secrets and keeping `.env` files out of version control;
- backing up `ENCRYPTION_KEY` separately from the database dumps (see
  [docs/operations.md](docs/operations.md));
- giving the Sankhya integration user the least access it needs, because the gateway documents no
  read-only guarantee for its query service (see [docs/sankhya.md](docs/sankhya.md));
- keeping the write switches at their safe defaults until writes are deliberately enabled.

## Secret exposure

If a real secret is committed, treat it as compromised even if the commit is later removed. Rotate
or revoke the secret first, then sanitize repository history as appropriate. A leaked
`ENCRYPTION_KEY` requires a new key and re-entering every stored connection secret.
