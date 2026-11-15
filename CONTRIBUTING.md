# Contributing a look

Thank you for sharing a look. A look is style only. This page lists what a pull request must contain and what the `look-ci` check refuses.

## Before you start

- The look must be your own work, or its licence must let you share it under the licence you choose.
- Your name or GitHub username and the licence are shown publicly with the look.
- You send it with your own GitHub account, under GitHub's terms and privacy policy.
- By opening a pull request, you confirm that you may share the look, and you license it to everyone under the licence you wrote in meta.json.
- Anyone who uses the gallery may copy the look's style settings into their own card. For CC-BY-4.0, CC-BY-SA-4.0 and MIT, the author and licence shown with the look in the gallery and in this repository are the credit.
- Your name or username and the licence are published in the look list and stay in this repository's Git history. Removing a look stops it being listed, but it cannot recall copies people already made or erase the history.
- The previews must be your own pictures, made from the look itself. Do not use screenshots, logos or artwork of other people's products, games, films or brands, and do not name them in the look.

## What to add

Add one folder, `looks/<id>/`, with exactly these three files and nothing else:

| File | What it holds |
| --- | --- |
| `look.json` | The style settings, up to 16 KiB. |
| `meta.json` | `id`, `name`, `author` and `licence`, up to 4 KiB. |
| `preview.webp` | A picture of the look, see below. |

Links and folders inside `looks/<id>/` are refused. Each file must be valid UTF-8 and must not repeat a member name.

### meta.json

- `id`: lower-case letters, digits and hyphens, 3 to 40 characters, starting and ending with a letter or digit. It must match the folder name.
- `name`: 1 to 40 characters (counted as Unicode code points after NFC normalisation), with no control, line separator or bidirectional formatting characters.
- `author`: your GitHub username: letters, digits and hyphens, 1 to 39 characters, starting with a letter or digit.
- `licence`: one of `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0` or `MIT`, written exactly like that.

### look.json

A look holds only style settings. The check refuses a look that contains keys Magic Card would drop, such as actions, entities and templates, and a look with nothing left once those are removed. It also refuses a value that is not on the card's allowed list of CSS functions. Colour functions that are newer than the oldest browser Magic Card supports, such as `color-mix()` and `oklch()`, are not on that list, so use `rgb()`, `hsl()` or a plain colour instead.

### preview.webp

- A still WebP image. Animated files are refused.
- At most 1024 pixels wide and 1024 pixels tall.
- At most 96 KiB.

The check decodes your picture and re-encodes it as a clean WebP (quality 80, transparency flattened onto white). The gallery publishes only that re-encoded copy, never your original file. The copy must still be 96 KiB or less and keep the same size. A picture that cannot be decoded cleanly is refused.

## Limits

The gallery holds at most 50 looks, and every `id` must be unique.

## Check your look before you send it

From the repository root, run:

```
node scripts/check-looks.mjs
```

It lists every failure with a code and the file it found it in, and ends with `look-ci: all checks passed` when the look is fine. The same check runs on your pull request and must pass before merge.

## Send the pull request

1. Fork the repository and add your `looks/<id>/` folder.
2. Open a pull request and fill in the checklist in the template.
3. Wait for the `look-ci` check and for review. Fix what the check reports and push again.

Do not change the files in `vendor/` or the lock file in a look pull request. They are the copy of the look checker that Magic Card uses, and the check verifies them against their stored hashes.
