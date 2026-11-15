import { create } from 'zustand';
import {
  resolveRiderProfile,
  riderClaimOwnOrder,
  riderUpdateOrderStatus,
  watchRiderOrders,
} from '@/lib/riderFirestore';
import type { Order, OrderStatus, Rider } from '@/types';
import type { Unsubscribe } from 'firebase/firestore';

interface RiderState {
  ready: boolean;
  rider: Rider | null;
  available: Order[];
  /** Paid runs for this hub whose slot is still ahead — visible, not claimable yet. */
  upcoming: Order[];
  mine: Order[];
  error: string | null;
  bootstrap: () => Promise<() => void>;
  accept: (orderId: string) => Promise<void>;
  setStatus: (orderId: string, status: OrderStatus, otp?: string) => Promise<void>;
}

let unsub: Unsubscribe | null = null;

export const useRiderStore = create<RiderState>((set, get) => ({
  ready: false,
  rider: null,
  available: [],
  upcoming: [],
  mine: [],
  error: null,

  bootstrap: async () => {
    unsub?.();
    unsub = null;
    set({ ready: false, error: null });
    try {
      const rider = await resolveRiderProfile();
      if (!rider || !rider.active) {
        set({ ready: true, rider: null, available: [], upcoming: [], mine: [] });
        return () => undefined;
      }
      set({ rider, ready: true });
      unsub = watchRiderOrders(rider.id, (available, mine, upcoming) => {
        const inHub = (o: Order) => !rider.hubId || !o.hubId || o.hubId === rider.hubId;
        set({
          available: available.filter(inHub),
          upcoming: upcoming.filter(inHub),
          mine,
        });
      });
      return () => {
        unsub?.();
        unsub = null;
      };
    } catch (e) {
      set({
        ready: true,
        error: e instanceof Error ? e.message : 'Could not load rider portal',
      });
      return () => undefined;
    }
  },

  accept: async (orderId) => {
    const rider = get().rider;
    if (!rider) throw new Error('Not signed in as rider');
    await riderClaimOwnOrder(orderId);
  },

  setStatus: async (orderId, status, otp) => {
    const rider = get().rider;
    if (!rider) throw new Error('Not signed in as rider');
    await riderUpdateOrderStatus(orderId, status, rider.id, otp);
  },
}));
