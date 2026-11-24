// Kinds of activity, for showing or hiding them on the heatmap. Garmin's list,
// .fit files and exports name sports differently ("mountain_biking", "cycling",
// "Biking"), so each is put in one of a few groups.

export type Activity = 'cycling' | 'running' | 'walking' | 'snow' | 'water' | 'other';

export const ACTIVITIES: { id: Activity; label: string }[] = [
  { id: 'cycling', label: 'Cycling' },
  { id: 'running', label: 'Running' },
  { id: 'walking', label: 'Walking and hiking' },
  { id: 'snow', label: 'Snow sports' },
  { id: 'water', label: 'Water sports' },
  { id: 'other', label: 'Other' },
];
export const ACTIVITY_IDS = ACTIVITIES.map((a) => a.id);

const RULES: [Activity, RegExp][] = [
  // In order: the first match wins, so a snow bike is cycling and a trail run is running.
  ['cycling', /cycl|bik|bmx|gravel/],
  ['running', /run|jog/],
  ['walking', /walk|hik|trek|mountaineer|climb|backpack|orienteer/],
  ['snow', /ski|snow|sled|skat/],
  ['water', /swim|row|paddl|kayak|canoe|sup\b|stand_up|sail|surf|boat|kite|water/],
];

/** The group a sport name belongs to. */
export function activityOf(sport: string | null | undefined): Activity {
  const s = (sport ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  // Strava's .gpx files give numbers: 1 is a ride, 9 a run, 10 a walk, 4 a hike.
  const n = { '1': 'cycling', '9': 'running', '10': 'walking', '4': 'walking' }[s] as Activity | undefined;
  if (n) return n;
  for (const [a, re] of RULES) if (re.test(s)) return a;
  return 'other';
}
