import { create } from 'zustand';
import {
  adminAdvanceOrderStatus,
  adminDashboardCounts,
  adminDeleteCategory,
  adminDeleteExperience,
  adminDeleteInventoryUnit,
  adminDeleteProduct,
  adminDeleteReview,
  adminSetReviewHidden,
  adminGetAppConfig,
  adminListCategories,
  adminListExperiences,
  adminListHubs,
  adminListInventoryUnits,
  adminListOrders,
  adminListProducts,
  adminListReviews,
  adminListUsers,
  adminSaveAppConfig,
  adminSetUnitStatus,
  adminListOpsNotifications,
  adminMarkOpsNotificationRead,
  adminMarkAllOpsNotificationsRead,
  adminUpsertCategory,
  adminUpsertExperience,
  adminUpsertHub,
  adminUpsertInventoryUnit,
  adminUpsertProduct,
  adminDeleteHub,
} from '@/lib/adminFirestore';
import type {
  AppConfig,
  Category,
  Experience,
  HubInfo,
  InventoryUnit,
  InventoryUnitStatus,
  OpsNotification,
  Order,
  OrderStatus,
  Product,
  Review,
  User,
} from '@/types';
import { DEFAULT_APP_CONFIG } from '@/types';

interface AdminState {
  ready: boolean;
  loading: boolean;
  error: string | null;
  products: Product[];
  experiences: Experience[];
  categories: Category[];
  hubs: HubInfo[];
  units: InventoryUnit[];
  orders: Order[];
  reviews: Review[];
  users: User[];
  config: AppConfig;
  counts: {
    products: number;
    availableUnits: number;
    totalUnits: number;
    openOrders: number;
    hubs: number;
    experiences: number;
    categories: number;
    reviews: number;
  } | null;
  opsNotifications: OpsNotification[];
  hydrateAll: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  loadProducts: () => Promise<void>;
  loadExperiences: () => Promise<void>;
  loadCategories: () => Promise<void>;
  loadHubs: () => Promise<void>;
  loadUnits: () => Promise<void>;
  loadOrders: (status?: OrderStatus) => Promise<void>;
  loadReviews: () => Promise<void>;
  loadUsers: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveProduct: (product: Product) => Promise<void>;
  removeProduct: (id: string) => Promise<void>;
  saveExperience: (experience: Experience) => Promise<void>;
  removeExperience: (id: string) => Promise<void>;
  saveCategory: (category: Category) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;
  saveHub: (hub: HubInfo) => Promise<void>;
  removeHub: (id: string) => Promise<void>;
  saveUnit: (unit: InventoryUnit) => Promise<void>;
  setUnitStatus: (id: string, status: InventoryUnitStatus) => Promise<void>;
  removeUnit: (id: string) => Promise<void>;
  advanceOrder: (orderId: string, status: OrderStatus) => Promise<void>;
  removeReview: (id: string) => Promise<void>;
  setReviewHidden: (id: string, hidden: boolean) => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  loadOpsNotifications: () => Promise<void>;
  markOpsNotificationRead: (id: string) => Promise<void>;
  markAllOpsNotificationsRead: () => Promise<void>;
  requestAdminNotificationPermission: () => Promise<boolean>;
}

export const useAdminStore = create<AdminState>((set, get) => ({
  ready: false,
  loading: false,
  error: null,
  products: [],
  experiences: [],
  categories: [],
  hubs: [],
  units: [],
  orders: [],
  reviews: [],
  users: [],
  config: { ...DEFAULT_APP_CONFIG },
  counts: null,
  opsNotifications: [],

  hydrateAll: async () => {
    set({ loading: true, error: null });
    try {
      const [products, experiences, categories, hubs, units, orders, reviews, users, config, counts] =
        await Promise.all([
          adminListProducts(),
          adminListExperiences(),
          adminListCategories(),
          adminListHubs(),
          adminListInventoryUnits(),
          adminListOrders(),
          adminListReviews(),
          adminListUsers(),
          adminGetAppConfig(),
          adminDashboardCounts(),
        ]);
      set({
        products,
        experiences,
        categories,
        hubs,
        units,
        orders,
        reviews,
        users,
        config,
        counts,
        ready: true,
        loading: false,
      });
    } catch (e) {
      set({
        loading: false,
        ready: true,
        error: e instanceof Error ? e.message : 'Failed to load admin data',
      });
    }
  },

  refreshCounts: async () => {
    try {
      const counts = await adminDashboardCounts();
      set({ counts });
    } catch {
      /* ignore */
    }
  },

  loadProducts: async () => set({ products: await adminListProducts() }),
  loadExperiences: async () => set({ experiences: await adminListExperiences() }),
  loadCategories: async () => set({ categories: await adminListCategories() }),
  loadHubs: async () => set({ hubs: await adminListHubs() }),
  loadUnits: async () => set({ units: await adminListInventoryUnits() }),
  loadOrders: async (status) => set({ orders: await adminListOrders(status) }),
  loadReviews: async () => set({ reviews: await adminListReviews() }),
  loadUsers: async () => set({ users: await adminListUsers() }),
  loadConfig: async () => set({ config: await adminGetAppConfig() }),
  loadOpsNotifications: async () => {
    try {
      set({ opsNotifications: await adminListOpsNotifications() });
    } catch {
      /* keep last known */
    }
  },

  saveProduct: async (product) => {
    await adminUpsertProduct(product);
    await get().loadProducts();
    await get().refreshCounts();
  },

  removeProduct: async (id) => {
    const prev = get().products;
    set({ products: prev.filter((p) => p.id !== id), error: null });
    try {
      await adminDeleteProduct(id);
      await get().refreshCounts();
    } catch (e) {
      set({
        products: prev,
        error: e instanceof Error ? e.message : 'Could not delete product. Check admin permissions.',
      });
      throw e;
    }
  },

  saveExperience: async (experience) => {
    await adminUpsertExperience(experience);
    await get().loadExperiences();
    await get().refreshCounts();
  },

  removeExperience: async (id) => {
    await adminDeleteExperience(id);
    await get().loadExperiences();
    await get().refreshCounts();
  },

  saveCategory: async (category) => {
    await adminUpsertCategory(category);
    await get().loadCategories();
    await get().refreshCounts();
  },

  removeCategory: async (id) => {
    await adminDeleteCategory(id);
    await get().loadCategories();
    await get().refreshCounts();
  },

  saveHub: async (hub) => {
    await adminUpsertHub(hub);
    await get().loadHubs();
    await get().refreshCounts();
  },

  removeHub: async (id) => {
    await adminDeleteHub(id);
    await get().loadHubs();
    await get().refreshCounts();
  },

  saveUnit: async (unit) => {
    await adminUpsertInventoryUnit(unit);
    await get().loadUnits();
    await get().refreshCounts();
  },

  setUnitStatus: async (id, status) => {
    await adminSetUnitStatus(id, status);
    await get().loadUnits();
    await get().refreshCounts();
  },

  removeUnit: async (id) => {
    await adminDeleteInventoryUnit(id);
    await get().loadUnits();
    await get().refreshCounts();
  },

  advanceOrder: async (orderId, status) => {
    await adminAdvanceOrderStatus(orderId, status);
    await get().loadOrders();
    await get().refreshCounts();
  },

  removeReview: async (id) => {
    await adminDeleteReview(id);
    await get().loadReviews();
    await get().refreshCounts();
  },

  setReviewHidden: async (id, hidden) => {
    await adminSetReviewHidden(id, hidden);
    await get().loadReviews();
  },

  saveConfig: async (config) => {
    await adminSaveAppConfig(config);
    set({ config });
  },

  markOpsNotificationRead: async (id) => {
    try {
      await adminMarkOpsNotificationRead(id);
      set({
        opsNotifications: get().opsNotifications.map((n) =>
          n.id === id ? { ...n, read: true } : n
        ),
      });
    } catch {
      /* ignore */
    }
  },

  markAllOpsNotificationsRead: async () => {
    try {
      await adminMarkAllOpsNotificationsRead();
      set({ opsNotifications: get().opsNotifications.map((n) => ({ ...n, read: true })) });
    } catch {
      /* ignore */
    }
  },

  requestAdminNotificationPermission: async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
      const granted = await Notification.requestPermission();
      return granted === 'granted';
    }
    return false;
  },
}));

