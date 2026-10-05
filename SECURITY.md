# Security policy

## Report a vulnerability

Use the repository’s private GitHub vulnerability reporting option when available.
If it is unavailable, email victor@scalewithsearch.com with a minimal reproduction.
Do not include credentials, private transcripts, or customer data in a public issue.

## Support scope

Reports against the current default branch receive review. There is no guaranteed response time or long-term release support.

## Data and permission boundaries

Use only a trusted local vault. The server is for loopback access and requires a bearer token for protected endpoints.
Do not expose it through a public proxy. Loop paths and regular expressions require trusted configuration.
Privacy filters do not prove that output contains no private information.

Keep tokens in environment variables or your secret store. Use temporary directories and synthetic data for tests.
