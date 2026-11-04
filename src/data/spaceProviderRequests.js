/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  return url;
}

/**
 * CelesTrak SATCAT for the active catalog as CSV: the documented query form
 * `satcat/records.php?{QUERY}=VALUE&FORMAT=CSV` with `GROUP=ACTIVE`
 * (https://celestrak.org/satcat/satcat-format.php). The CSV carries the radar
 * cross-section (`RCS`, m², empty when unknown) beside `NORAD_CAT_ID`.
 */
export function celestrakSatcatUrl() {
  const url = new URL('https://celestrak.org/satcat/records.php');
  url.searchParams.set('GROUP', 'ACTIVE');
  url.searchParams.set('FORMAT', 'CSV');
  return url;
}

export function launchLibraryRecentUrl(end) {
  // Stable minute boundaries let different installations share LL2's cache.
  const roundedEnd = new Date(Math.floor(end.getTime() / 60000) * 60000);
  const start = new Date(roundedEnd.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', roundedEnd.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}
