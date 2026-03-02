export type UserRole = 'SUPER_ADMIN' | 'OWNER' | 'CHEF' | 'WAITER' | 'CUSTOMER' | 'SALES_REP' | 'CTO';
export type DietaryType = 'VEG' | 'VEGAN' | 'NON_VEG';
export type ItemSize = 'HALF' | 'FULL';

export interface MenuItem {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  price: number; // Default price (Full)
  price_half?: number;
  price_full: number;
  category: string;
  image: string;
  available: boolean;
  is_daily_special?: boolean;
  dietary_type: DietaryType;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  size: ItemSize;
}

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED';

export interface Order {
  id: string;
  restaurantId: string;
  tableNumber: string;
  customerName?: string;
  customerPhone?: string;
  items: OrderItem[];
  totalAmount: number;
  gstAmount?: number;
  status: OrderStatus;
  paymentStatus: 'PENDING' | 'PAID';
  paymentMethod?: 'ONLINE' | 'TABLE';
  eta?: string;
  createdAt: string;
}

export interface Restaurant {
  id: string;
  name: string;
  adminId: string;
  gst_number?: string;
  gst_percentage?: number;
  is_gst_enabled?: boolean;
  template_id?: 'CLASSIC' | 'MODERN' | 'EDITORIAL';
  table_count?: number;
  watermark_image?: string;
  upi_id?: string;
  upi_qr_image?: string;
}

export interface Table {
  id: string;
  name: string;
  is_active: boolean;
}
