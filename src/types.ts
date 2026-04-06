export type UserRole = 'SUPER_ADMIN' | 'OWNER' | 'CHEF' | 'WAITER' | 'CUSTOMER' | 'SALES_REP' | 'CTO' | 'MANAGER';
export type DietaryType = 'VEG' | 'VEGAN' | 'NON_VEG';
export type ItemSize = 'HALF' | 'FULL';
export type CheckoutMode = 'prepaid' | 'postpaid';
export type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'NOT_AVAILABLE';

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
  // Prepaid / postpaid fields
  session_id?: string;
  round_number?: number;
  kitchen_status?: 'held_for_payment' | 'queued' | 'preparing' | 'ready' | 'served';
  checkout_mode?: CheckoutMode;
  [key: string]: any; // allow extra server fields (feedbackRequested, etc.)
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
  checkout_mode?: CheckoutMode;
}

export interface Table {
  id: string;
  name: string;
  is_active: boolean;
  status?: TableStatus;
  capacity?: number;
  assigned_waiter_id?: string;
  assigned_waiter_name?: string;
}

/** Rich table view returned by the /tables/live endpoint */
export interface LiveTableView {
  id: string;
  name: string;
  capacity?: number;
  status: TableStatus;
  assigned_waiter_id?: string | null;
  assigned_waiter_name?: string | null;
  // Active session fields (null when table is AVAILABLE)
  session_id?: string | null;
  session_opened_at?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  round_count?: number;
  bill_amount?: number;
  session_status?: 'open' | 'bill_requested' | null;
  order_count?: number;
}

export interface TableSession {
  id: string;
  session_token: string;
  table_id: string;
  table_name: string;
  status: 'open' | 'bill_requested' | 'closed';
  customer_name?: string;
  customer_phone?: string;
  round_count: number;
  bill_amount: number;
  payment_method?: string;
  opened_at: string;
  bill_requested_at?: string;
  closed_at?: string;
  orders?: Order[];
}
