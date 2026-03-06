export type TimestampCompareResult = 'remote_newer' | 'local_newer' | 'equal' | 'unknown'

export function parseTimestamp(ts: string | undefined): number | null {
  if (!ts) return null
  const parsed = Date.parse(ts)
  return Number.isNaN(parsed) ? null : parsed
}

export function compareTimestamps(
  localTs: string | undefined,
  remoteTs: string | undefined
): TimestampCompareResult {
  const localTime = parseTimestamp(localTs)
  const remoteTime = parseTimestamp(remoteTs)
  if (localTime == null || remoteTime == null) return 'unknown'
  if (remoteTime > localTime) return 'remote_newer'
  if (localTime > remoteTime) return 'local_newer'
  return 'equal'
}
