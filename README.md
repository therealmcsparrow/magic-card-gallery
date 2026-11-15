# magic-card-gallery

Reviewed, signed looks for Magic Card.

A look is a set of style settings for a card: colours, fonts, borders, spacing and similar. A look never holds entities, text, actions or templates, so applying one changes how a card looks and never what it does.

## Using the gallery

You do not use this repository directly. The gallery is built into the Magic Card editor and is off by default.

1. Install Magic Card Utils.
2. In Home Assistant, go to Settings → Devices & services → Magic Card Utils → Configure and turn on **Look gallery**. This also turns on **Load Google Fonts**. Read the two screens that follow before you confirm.
3. Reload each open dashboard, then open a card in the editor and select **Browse looks**.

The [look gallery guide](https://github.com/therealmcsparrow/magic-card/blob/main/documentation/look-gallery/README.md) in the Magic Card documentation has the full steps, including preview, Keep, Cancel and Undo.

## How the list is published

- Each look lives in `looks/<id>/` as `look.json`, `meta.json` and `preview.webp`.
- Every pull request runs the `look-ci` check. It verifies the look files and the preview, and it publishes nothing.
- After a merge, the release workflow builds a signed list of looks and publishes it on GitHub Pages. Magic Card checks the signature and every look again before it shows anything.
- The gallery holds at most 50 looks.

## Sending a look

See [CONTRIBUTING.md](CONTRIBUTING.md). Looks are added by pull request, under your own GitHub account.

## Reporting a problem

To report a look that should not be listed, use the Report link on its tile or open a public issue. For a security problem, read [SECURITY.md](SECURITY.md) and report it privately.
