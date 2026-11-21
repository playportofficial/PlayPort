import { describe, expect, it } from 'vitest';
import { isDropoffInServiceArea } from '../functions/src/serviceArea';
import { isInServiceArea } from './serviceArea';

describe('isInServiceArea (15 km of the Kachiguda hub)', () => {
  it('accepts pins within 15 km', () => {
    expect(isInServiceArea({ lat: 17.386683, lng: 78.4895742 })).toBe(true); // hub
    expect(isInServiceArea({ lat: 17.4126, lng: 78.4482 })).toBe(true); // Banjara Hills, 5.3 km
    expect(isInServiceArea({ lat: 17.4635, lng: 78.5196 })).toBe(true); // Karkhana, 9.1 km
    expect(isInServiceArea({ lat: 17.4486, lng: 78.3908 })).toBe(true); // HITEC City, 12.5 km
    expect(isInServiceArea({ lat: 17.4849, lng: 78.4138 })).toBe(true); // Kukatpally, 13.6 km
  });

  it('rejects pins past 15 km, even inside Hyderabad', () => {
    expect(isInServiceArea({ lat: 17.4401, lng: 78.3489 })).toBe(false); // Gachibowli, 16.1 km
    expect(isInServiceArea({ lat: 17.5406, lng: 78.4867 })).toBe(false); // Kompally, 17.1 km
    expect(isInServiceArea({ lat: 17.24, lng: 78.43 })).toBe(false); // Shamshabad, 17.5 km
    expect(isInServiceArea({ lat: 12.9716, lng: 77.5946 })).toBe(false); // Bengaluru
  });

  it('lets the pin win over a typed Hyderabad address', () => {
    expect(isInServiceArea({ lat: 17.4401, lng: 78.3489, city: 'Hyderabad', pincode: '500032' })).toBe(false);
  });

  it('falls back to the pincode, then the city name, when there is no pin', () => {
    expect(isInServiceArea({ pincode: '500027' })).toBe(true);
    expect(isInServiceArea({ pincode: '560038', city: 'Hyderabad' })).toBe(false);
    expect(isInServiceArea({ city: 'Secunderabad' })).toBe(true);
    expect(isInServiceArea({ city: 'Bengaluru' })).toBe(false);
    expect(isInServiceArea(null)).toBe(false);
  });

  it('server check agrees with the app on the same pins', () => {
    expect(isDropoffInServiceArea({ lat: 17.4486, lng: 78.3908 })).toBe(true);
    expect(isDropoffInServiceArea({ lat: 17.4401, lng: 78.3489 })).toBe(false);
  });

  it('excludes ECIL even though it sits inside the 15 km radius', () => {
    expect(isInServiceArea({ lat: 17.4699, lng: 78.5738 })).toBe(false);
    expect(isInServiceArea({ area: 'ECIL', city: 'Hyderabad', pincode: '500062' })).toBe(false);
    expect(isInServiceArea({ pincode: '500062' })).toBe(false);
    expect(isDropoffInServiceArea({ lat: 17.4699, lng: 78.5738 })).toBe(false);
    expect(isDropoffInServiceArea({ addressFull: 'ECIL X Roads, Hyderabad 500062' })).toBe(false);
  });
});
