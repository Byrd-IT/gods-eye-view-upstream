// The share-token batch reserved ahead of the feature PRs by
// docs/LAYER-TOKEN-COORDINATION.md, as [layer id, token] rows. The ledger tests
// pin it once here so the codec and ledger tests cannot drift apart.
export const COORDINATED_LAYER_TOKEN_ROWS = Object.freeze([
  Object.freeze(['local-usgs-lakes', '00']),
  Object.freeze(['local-usgs-springs', '01']),
  Object.freeze(['local-usgs-water', '02']),
  Object.freeze(['caba-traffic-enforcement', '03']),
  Object.freeze(['river-levels', '04']),
  Object.freeze(['shipwrecks', '05']),
  Object.freeze(['air-accidents', '06']),
]);

export const COORDINATED_LAYER_TOKEN_IDS = Object.freeze(
  new Set(COORDINATED_LAYER_TOKEN_ROWS.map(([id]) => id)),
);
