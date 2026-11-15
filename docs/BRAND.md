# Echo identity

The Echo symbol combines a flowing, open letterform with a profile suggested by
negative space. Its smooth eyelid and the break below the chin are intentional.
It is application identity, independent of any installed character or extension.

The editable sources live in `apps/workbench/public/brand`:

- `echo-mark.svg`: the primary symbol, including the smooth eyelid.
- `echo-mark-small.svg`: the same face and silhouette, with a slightly wider chin
  gap for 16–24 px raster exports.
- `echo-wordmark.svg`: outlined Inter, weight 580, optical size 32.

The workbench renders the primary symbol and wordmark as masks in its neutral
foreground color, so they adapt to light, dark, high contrast and accent settings.
Character portraits are separate and retain their existing styling.

Run `pnpm exec tsx scripts/icons.ts` after changing the sources. This generates
the white application tile with a black symbol, browser favicon, desktop PNG, small tray PNG and
the seven-size Windows ICO. Keep the optical placement and generous clear space;
do not stretch or close the chin gap. The desktop build regenerates these assets
before bundling, so installer and frontend use the same artwork.

The symbol is original Echo artwork developed from the project's logo studies.
The Inter-derived wordmark retains its OFL notice beside the public vector files.
