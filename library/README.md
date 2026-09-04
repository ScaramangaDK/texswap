# Shipped skin collection

Every `*.aq2skin.json` in this folder (any sub-folder) ships with TexSwap and shows
up in the Skin studio's **Collection** panel for its weapon, marked as built-in.

Make one from the studio: get the skin looking right, then **Save to collection…**
(it lands in your AppData collection) or **Export skin…**, and copy the file here.
Suggested layout: one folder per weapon, e.g. `v_m4/gold.aq2skin.json`.
The file carries the skin image (and a model, if the weapon uses a replacement
model) as base64; `name` and `author` are shown on the card.
