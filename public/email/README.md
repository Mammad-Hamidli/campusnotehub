# Email images

Drop the image files for transactional email in **this folder**. The email
layout looks for the exact filenames below; anything else is ignored.

| Filename               | Used for                          | Recommended size        | Notes |
| ---------------------- | --------------------------------- | ----------------------- | ----- |
| `logo.png`             | Branded header on every email     | 360 x 90 px (2x for 180x45) | Transparent PNG. Rendered at 180px wide. |
| `hero.jpg`             | Hero block (celebratory emails)   | 1200 x 600 px (2x for 600x300) | JPEG keeps the message small. Rendered at 600px wide. |
| `icon-facebook.png`    | Footer social icon                | 48 x 48 px              | Optional. |
| `icon-instagram.png`   | Footer social icon                | 48 x 48 px              | Optional. |
| `icon-linkedin.png`    | Footer social icon                | 48 x 48 px              | Optional. |

## Every file is optional

A missing file never breaks a send. `src/lib/email/assets.ts` checks for the
file, logs one warning naming it, and the layout falls back to the text-only
variant of that block:

- no `logo.png` -> the wordmark renders as styled text (today's behaviour)
- no `hero.jpg` -> the hero block is omitted entirely
- no `icon-*.png` -> that social link renders as a plain text link

This matters because email images are blocked by default in many clients, so
the layout has to read correctly without them regardless.

## How the images are delivered

Controlled by `EMAIL_ASSET_MODE` in `.env` - never by editing code:

- **`cid`** (default) - the files are read from this folder and attached to the
  message as inline attachments with a Content-ID, referenced as
  `src="cid:logo"`. Works with no public hosting at all, which is why it is the
  default while the app is not yet deployed.
- **`url`** - the `src` is built from `EMAIL_ASSET_BASE_URL`, e.g.
  `https://campusnotehub.com/email/logo.png`. Requires the app to be publicly
  reachable. Next.js serves this folder at `/email/...`.

## Sizing

Always supply images at **2x** the rendered width and let the `width` attribute
scale them down, so they stay sharp on high-DPI screens. Keep the total message
under ~100 KB where possible: Gmail clips messages larger than 102 KB.
