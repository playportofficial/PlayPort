import { distanceKm } from '@/utils/geo';

/**
 * PlayPort delivers within 15 km of the Kachiguda hub by road. The straight
 * line is the first check; the server's road distance (saved on the address as
 * roadCheck) has the final say.
 */
export const SERVICE_CITY = 'Hyderabad';
export const SERVICE_HUB_NAME = 'Kachiguda';
export const SERVICE_CENTER = { lat: 17.386683, lng: 78.4895742 };
export const SERVICE_RADIUS_KM = 15;

const CITY_NAMES = /\b(hyderabad|secunderabad)\b/i;

export type ServiceAreaInput = {
  lat?: number | null;
  lng?: number | null;
  pincode?: string | null;
  city?: string | null;
  roadCheck?: { lat: number; lng: number; km: number } | null;
};

/**
 * A map pin decides when present (pins are what riders drive to). Without one
 * we can only guess from Hyderabad pincodes (500xxx) or the city name; checkout
 * still needs a pin, and the server re-checks the 15 km radius from it.
 */
export function isInServiceArea(place: ServiceAreaInput | null | undefined): boolean {
  if (!place) return false;
  const { lat, lng } = place;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    const road = place.roadCheck;
    if (road && road.lat === lat && road.lng === lng && Number.isFinite(road.km)) {
      return road.km <= SERVICE_RADIUS_KM;
    }
    return distanceKm(lat, lng, SERVICE_CENTER.lat, SERVICE_CENTER.lng) <= SERVICE_RADIUS_KM;
  }
  const pin = String(place.pincode ?? '').replace(/\D/g, '');
  if (pin.length === 6) return pin.startsWith('500');
  return CITY_NAMES.test(place.city ?? '');
}

export const OUT_OF_AREA_TITLE = 'Sorry, we are not serviceable here.';
export const OUT_OF_AREA_MESSAGE = `Delivery is available only within a ${SERVICE_RADIUS_KM} km radius of ${SERVICE_HUB_NAME}.`;
