import { distanceKm } from '@/utils/geo';

/**
 * PlayPort delivers within 15 km of the Kachiguda hub by road. The straight
 * line is the first check; the server's road distance (saved on the address as
 * roadCheck) has the final say.
 *
 * Named localities in EXCLUDED_* are blocked even when they fall inside the
 * radius (e.g. ECIL).
 */
export const SERVICE_CITY = 'Hyderabad';
export const SERVICE_HUB_NAME = 'Kachiguda';
export const SERVICE_CENTER = { lat: 17.386683, lng: 78.4895742 };
export const SERVICE_RADIUS_KM = 15;

/** Pincodes we do not serve, even inside the radius. */
export const EXCLUDED_PINCODES = new Set(['500062']);

/** Area / address text that marks a drop-off as unavailable. */
export const EXCLUDED_AREA_PATTERNS = [/\becil\b/i];

/**
 * Map pins inside these circles are unavailable even without area text
 * (ECIL centre ≈ 17.47, 78.57 — ~13 km from the hub).
 */
export const EXCLUDED_ZONES: { lat: number; lng: number; radiusKm: number }[] = [
  { lat: 17.4699, lng: 78.5738, radiusKm: 2.5 },
];

const CITY_NAMES = /\b(hyderabad|secunderabad)\b/i;

export type ServiceAreaInput = {
  lat?: number | null;
  lng?: number | null;
  pincode?: string | null;
  city?: string | null;
  area?: string | null;
  line1?: string | null;
  line2?: string | null;
  addressFull?: string | null;
  roadCheck?: { lat: number; lng: number; km: number } | null;
};

function normalizePin(pincode?: string | null): string {
  return String(pincode ?? '').replace(/\D/g, '').slice(0, 6);
}

/** True when this place is on the do-not-serve list (ECIL, etc.). */
export function isExcludedLocality(place: ServiceAreaInput | null | undefined): boolean {
  if (!place) return false;

  const pin = normalizePin(place.pincode);
  if (pin.length === 6 && EXCLUDED_PINCODES.has(pin)) return true;

  const hay = [place.area, place.city, place.line1, place.line2, place.addressFull]
    .filter(Boolean)
    .join(' ');
  if (EXCLUDED_AREA_PATTERNS.some((re) => re.test(hay))) return true;

  const { lat, lng } = place;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const zone of EXCLUDED_ZONES) {
      if (distanceKm(lat, lng, zone.lat, zone.lng) <= zone.radiusKm) return true;
    }
  }

  return false;
}

/**
 * A map pin decides when present (pins are what riders drive to). Without one
 * we can only guess from Hyderabad pincodes (500xxx) or the city name; checkout
 * still needs a pin, and the server re-checks the 15 km radius from it.
 */
export function isInServiceArea(place: ServiceAreaInput | null | undefined): boolean {
  if (!place) return false;
  if (isExcludedLocality(place)) return false;

  const { lat, lng } = place;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    const road = place.roadCheck;
    if (road && road.lat === lat && road.lng === lng && Number.isFinite(road.km)) {
      return road.km <= SERVICE_RADIUS_KM;
    }
    return distanceKm(lat, lng, SERVICE_CENTER.lat, SERVICE_CENTER.lng) <= SERVICE_RADIUS_KM;
  }
  const pin = normalizePin(place.pincode);
  if (pin.length === 6) return pin.startsWith('500') && !EXCLUDED_PINCODES.has(pin);
  return CITY_NAMES.test(place.city ?? '');
}

export const OUT_OF_AREA_TITLE = 'Sorry, we are not serviceable here.';
export const OUT_OF_AREA_MESSAGE = `Delivery is available only within a ${SERVICE_RADIUS_KM} km radius of ${SERVICE_HUB_NAME}.`;
