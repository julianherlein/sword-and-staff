// Which Durable Object hosts the game, and where. An object is placed once, when it is first
// created, and never moves; so the region is part of its name: changing LOBBY_REGION creates a new
// object in the new place instead of silently keeping the old location.
// Regions: wnam enam sam weur eeur apac apac-ne apac-se oc afr me (Cloudflare locationHint values).
export const REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'];

export function lobbyFor(env = {}) {
  const region = env.LOBBY_REGION;
  if (!region) return { name: 'lobby', options: undefined }; // placed near whoever connects first
  if (!REGIONS.includes(region)) throw new Error(`LOBBY_REGION must be one of ${REGIONS.join(', ')} (got "${region}")`);
  return { name: `lobby-${region}`, options: { locationHint: region } };
}
