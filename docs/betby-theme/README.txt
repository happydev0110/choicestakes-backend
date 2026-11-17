CHOICESTAKES SPORTSBOOK THEME — PROVIDER HANDOFF

Requested appearance
Match reference.png with the tile layout, a navy-blue page, dark navy/purple
cards, blue odds buttons, and the existing bright blue betslip header.

Exact colors sampled from the supplied screenshot:
  Page background         #131C3A
  Cards and navigation    #11102A
  Odds buttons            #1D2A58
  Betslip header          #21A8F7

Files
  theme.json              Full candidate theme in the provider's tile theme format.
  theme-overrides.json    Changed top-level theme tokens only; merge into the
                          blue-dark tile base when creating a NEW custom theme.
  provider-shell.css      Provider page background; add the scoped HTML class
                          as described in the file. Do not add to the portal.
  design-spec.json        Exact palette, base source/hash, proposed name and status.
  preview.html            Offline color preview, not a working sportsbook.
  reference.png           The supplied target screenshot.

Implementation notes
The base is betby-demo-blue-dark-tile, retrieved on 2026-11-17 from the URL in
design-spec.json. Existing dimensions, typography, icons, images, semantic
success/error colors, and blue interaction accents are retained. Dark surface
colors and their rgba variants are recolored, preserving opacity. Navigation
is explicitly set to #11102A. Hover (#25376F) and disabled (#182344) surface
colors are derived companion shades, not samples from the screenshot.

theme.json uses the proposed name choicestakes-navy-blue-tile. The base theme's
key was removed so it is not accidentally imported over the shared preset.
Please create a separate operator theme and assign your own ID/key as required.
The full file is a candidate renderer theme, not a verified dashboard import
format. The provider should adapt it to its current version if necessary.

Apply the page-background CSS on the provider-hosted document. The API client
cannot style the cross-origin sportsbook from the Choicestakes portal. If your
renderer owns that surface independently, map #131C3A to its supported page
background setting instead. Both theme tokens and the surrounding page need
the requested palette; changing only the outer portal background is insufficient.

Provider action requested
1. Create/register a custom tile theme from these files for Choicestakes.
2. Apply the navy page background to the provider-hosted sportsbook shell.
3. Confirm the exact identifier and supported API-MATIC launch parameter, with
   an example request, or confirm how to select the operator's default theme.
4. Verify the resulting sandbox sportsbook against reference.png on desktop
   and mobile, including the expanded betslip and selected/hovered odds states.

Activation status
Prepared only. This theme is NOT registered, uploaded, deployed, or active.
The portal/backend continue requesting the existing blue-dark preset with tile.
The proposed custom name is not currently accepted by SPORTSBOOK_THEME or by
the documented provider color allowlist. Do not set it as an environment value.

Once the provider confirms its mapping, the backend launch configuration must
be updated to select the custom theme. An explicit blue-dark launch override
may need changing if the provider assigns this as the operator default.

No provider credentials, player session tokens, or account data are included.
