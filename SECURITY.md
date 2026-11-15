# Security policy

## Supported versions

Only the look list that is currently published on GitHub Pages is supported. Older lists are replaced, not patched. Magic Card only accepts a list that carries a valid signature and a sequence number that is not lower than the last one it saw.

## Status of this project

The Magic Card look gallery is free, non-commercial open source software and content. It is not sold. At most, it receives voluntary donations. Under the EU Cyber Resilience Act (CRA) it is therefore not a product placed on the market in the course of a commercial activity, and it has no reporting duty. This matches the stance in the [Magic Card security policy](https://github.com/therealmcsparrow/magic-card/blob/main/SECURITY.md). If that ever changes, this page changes with it.

## Scope

In scope:

-   **A harmful look.** A look that is listed in the published index and holds an action, a template, an entity id, a value that loads an outside address, script, or any other value that Magic Card should have refused. Also a look whose file does not match its hash in the index but is still shown as applicable.
-   **The signing of the index.** A published index whose signature check passes but that was not built by this repository's release workflow. Also any private signing key, or part of one, found in this repository, its history, its workflow logs or its releases.
-   **The build and deploy workflows** in `.github/`, including a way to publish without the maintainer's approval.

Out of scope:

-   A look that you dislike, or that looks bad. Use the Report link on its tile or open a public issue.
-   Faults in Magic Card, Home Assistant, GitHub Pages or Google Fonts. Report Magic Card problems at <https://github.com/therealmcsparrow/magic-card/security>.
-   A request to GitHub or Google that you allowed by turning on the Look gallery switch in Magic Card Utils. Those requests send your IP address and standard request headers, as the prompt tells you before you confirm.

## Reporting a vulnerability

Please do not open a public issue for a security problem, and do not post a leaked key anywhere public.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** (private vulnerability reporting).

-   **Harmful look:** give the look id (or the file name under `looks/`), the Magic Card version, and what the look does or should have been refused for.
-   **Signing-key leak:** give where you saw the key (file, commit, log or release) and when. Do not paste the key itself into the report.
-   **Workflow problem:** give the workflow file and steps to reproduce.

We handle reports on a best-effort basis and aim to reply within 7 days. A confirmed problem is fixed by removing the look or fixing the workflow, and publishing a new index with a higher sequence number. The report is credited unless you prefer otherwise.

## If a published index is compromised

If we find that a published index was tampered with, that it lists a look that causes harm, or that the signing key may have leaked, we do the following.

Within 24 hours of confirming it:

-   We remove the look or revert the change, and publish a new index with a higher sequence number.
-   We publish a security advisory in this repository.
-   For a possible key leak, we stop all publishing, replace the key, and ship a Magic Card release that trusts the new key. Until that release is out, people can turn the Look gallery switch off in Magic Card Utils.

Within 72 hours of confirming it, we send a voluntary report to the Dutch national CSIRT (the NCSC-NL), or through the single reporting platform that the EU sets up under the CRA once it is open. The report is voluntary because this project is non-commercial open source software and has no reporting duty under the CRA. We make it anyway so that other people who use the gallery hear about it.

These times start when we have confirmed the problem. This project is run by one maintainer, so they are targets, not guarantees.

Draft. Have a qualified lawyer review before publishing.
