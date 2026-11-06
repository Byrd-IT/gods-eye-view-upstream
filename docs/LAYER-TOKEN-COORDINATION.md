# Coordinated layer-token allocation

Based on upstream main `ad009ea1ebf56345d5be69a61a567c3aeeb9fa02` (36 reservations,
including Wildlife Sightings `9` from #1591). This proposal preserves every
published ID/token pair and reserves one contiguous batch before the feature PRs
land. It does not activate any layer.

| PR    | Layer ID                   | Reserved token |
| ----- | -------------------------- | -------------- |
| #1316 | `local-usgs-lakes`         | `00`           |
| #1316 | `local-usgs-springs`       | `01`           |
| #1316 | `local-usgs-water`         | `02`           |
| #1143 | `caba-traffic-enforcement` | `03`           |
| #1565 | `river-levels`             | `04`           |
| #1583 | `shipwrecks`               | `05`           |
| #1584 | `air-accidents`            | `06`           |

The next free token after this batch is `07`. The existing checker requires
contiguous allocation: assigning only `03` or `04` against current main would
fail while `00` is free. Merge this ledger batch first, then retain all 43
reservations on each feature branch. Feature PR order is then unrestricted.
This is a proposal until maintainers accept it. Recheck fresh main before landing;
if a competing assignment has already been published, that published mapping wins.

## Revision history

An earlier revision of this proposal (based on main `2470b39f`, 35 reservations)
kept `local-usgs-water` at `9` and assigned `02`, `03`, `04` and `05` to CABA,
`river-levels`, `shipwrecks` and `air-accidents`. Wildlife Sightings (#1591)
published `9` first, so that mapping takes precedence: the three USGS layers now
take the first free tokens `00`, `01` and `02`, and the four other reservations
shift to `03` through `06`. The earlier revision's tokens were never published,
so nothing on main changes.

## Feature-branch updates

- Byrd-IT (#1316): `local-usgs-lakes` `00`, `local-usgs-springs` `01` and
  `local-usgs-water` `02`. Adopt the complete ledger and its pinned
  43-reservation test. Rebase and recalculate runtime layer counts and any voice
  schema pins for the actual merged feature set.
- radianx (#1143): replace provisional `6` with `03` in the runtime registry,
  token tests, CABA documentation and PR description; retain published Sea Marks
  `6`, Ski Pistes `7`, Drone Airspace `8`, Wildlife Sightings `9` and all other
  upstream registrations.
- IMBrandao (#1565/#1583/#1584): replace provisional `9` with `04/05/06`
  respectively in the registry, token tests, CURRENT-STATE, changelog and PR
  descriptions or example links wherever referenced. `9` is now owned by
  Wildlife Sightings. Retain all ledger rows.

Counts below are measured at base `ad009ea1` and move as other layer PRs land;
the registry and catalog count tests are authoritative. Ledger-only reservation
leaves the 36 runtime layers, the 38 catalog layers and voice tools unchanged.
If only these five feature PRs subsequently land, the final runtime registry has
43 layers (+3 USGS and +1 for each other PR). The application catalog is separate:
it stays at 38 for this ledger-only batch and would reach 45 if each of the seven
layers adds one catalog entry. In isolation against this base, USGS needs 39
registry / 41 catalog entries, and each one-layer PR needs 37 registry / 39
catalog entries. Intermediate counts reflect only features actually merged; do
not set runtime counts to the reservation count. Recompute schema hashes only
when the actual tool/schema content changes.

Run `npm run layer-token:check -- --base-ref upstream/main`, ledger/codec tests,
and affected catalog/composition/share tests after each rebase. Do not weaken the
allocator or add compatibility aliases for a token already owned by another ID.

## Shared links

All mappings already published on main remain unchanged, including `6` for
Sea Marks and `9` for Wildlife Sightings. The new reservations are not active
decoder entries until their features land; unknown enabled-layer tokens continue
to reject the payload.

Preview links cannot all keep their meaning in schema v2, because the URL has no
branch identity. Regenerate these links with the tokens in the table above:

- USGS Rivers & Streams previews that used `9` now use `02`. `9` decodes as
  Wildlife Sightings on main, so an old streams preview link would enable that
  layer instead. USGS Lakes `00` and Springs `01` previews keep their mapping.
- CABA previews that used `6` (published Sea Marks) now use `03`.
- IMBrandao previews that used `9` now use `04`, `05` or `06`.
- Previews built from the earlier revision of this proposal that used `02`
  (CABA), `03` (river levels), `04` (shipwrecks) or `05` (air accidents) shift to
  the tokens above; `02` is now USGS Rivers & Streams.

ID-based local state does not need a token migration. Never reassign a published
or retired token.

Pre-reserving makes all seven assignments permanent if this coordination PR
lands, even if a feature is later withdrawn. That costs seven namespace slots
but needs no allocator exception, alias, or URL-version change.
