# Security Policy

Security is a core requirement of DB-Sankhya because the application may be deployed with access to ERP data and privileged integration credentials.

## Supported versions

Until the first stable release, only the latest revision of the default branch is considered supported.

## Reporting a vulnerability

Do not publish credentials, production data, exploit details, access tokens, private URLs, or customer/company information in a public issue.

Prefer GitHub's private vulnerability reporting feature when it is available for this repository. If private reporting is not available, contact the maintainer privately through the contact options on the maintainer's GitHub profile before disclosing sensitive technical details.

Please include, when possible:

- affected component;
- impact;
- minimal reproduction steps;
- expected vs. observed behavior;
- whether credentials or production data may have been exposed;
- suggested mitigation, if known.

## Security expectations

Contributions must not introduce:

- hardcoded credentials or tokens;
- production/customer fixtures;
- private infrastructure details;
- authorization bypasses;
- client-side-only authorization for privileged actions;
- unsafe write paths that bypass the policy engine;
- logging of secrets or authentication material.

## Secret exposure

If a real secret is committed, treat it as compromised even if the commit is later removed. Rotate or revoke the secret first, then sanitize repository history as appropriate.
