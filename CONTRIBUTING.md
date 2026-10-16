# Contributing

Thanks for helping improve DB-Sankhya.

## Before opening a change

- Keep the public repository generic and free of company-specific data.
- Never commit real credentials, tokens, cookies, certificates, production dumps, private IPs, private domains, customer records, or internal screenshots.
- Prefer supported Sankhya APIs and platform mechanisms over direct or undocumented database manipulation.
- Privileged operations must remain protected by server-side authorization and policy checks.
- Any state-changing Sankhya operation must preserve the preview/authorization/confirmation/audit model.

## Development checks

Before opening a pull request, run the checks provided by the project for the affected area. As the codebase stabilizes, this will normally include:

- lint;
- typecheck;
- unit tests;
- integration tests;
- relevant end-to-end tests;
- production build.

## Security-sensitive changes

Changes involving authentication, authorization, secrets, write operations, audit logging, networking, exports, or deployment require extra review. Describe the security impact in the pull request template.

## Commit hygiene

Use clear, scoped commit messages. Do not commit generated local data, debugging dumps, temporary exports, or environment-specific configuration.

## Documentation

Update documentation whenever behavior, configuration, permissions, supported Sankhya capabilities, or deployment requirements change.
