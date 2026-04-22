export type UserRole =
  | 'SUPER_ADMIN' | 'OWNER' | 'CHEF' | 'WAITER' | 'CUSTOMER'
  | 'SALES_REP'   | 'CTO'   | 'MANAGER'
  // Hospitality module roles (Phase 1+):
  | 'HOUSEKEEPING' | 'FRONT_DESK' | 'CONCIERGE' | 'MAINTENANCE';
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

export type MenuDisplayMode = 'PHOTO' | 'CARD' | 'COMPACT' | 'MAGAZINE';

export interface Restaurant {
  id: string;
  name: string;
  adminId: string;
  slug?: string;
  property_type?: PropertyType;   // 'RESTAURANT' (default) | 'HOTEL' | 'BOTH'
  gst_number?: string;
  gst_percentage?: number;
  is_gst_enabled?: boolean;
  template_id?: 'CLASSIC' | 'MODERN' | 'EDITORIAL';
  menu_display_mode?: MenuDisplayMode;  // default 'PHOTO'
  alerts_enabled?: boolean | number;    // default true — audible/visual alerts for unack'd items
  logo_url?: string;
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

/* ─────────────────────────────────────────────────────────────────────────
 * Hospitality module types (Hotels & Resorts)
 * Added as part of the hospitality feature. Purely additive — doesn't affect
 * existing restaurant types.
 * ───────────────────────────────────────────────────────────────────────── */

export type PropertyType = 'RESTAURANT' | 'HOTEL' | 'BOTH';

export type RoomStatus =
  | 'VACANT'       // Clean, ready for next guest
  | 'OCCUPIED'     // Guest currently checked in
  | 'CLEANING'     // Housekeeping in progress
  | 'MAINTENANCE'  // Repair/maintenance work
  | 'BLOCKED';     // Admin-held (DND or inventory)

export type ServiceCategory =
  | 'HOUSEKEEPING' | 'MAINTENANCE' | 'ROOM_SERVICE'
  | 'CONCIERGE'    | 'LAUNDRY'     | 'SPA' | 'UPGRADE';

export type ServiceRequestStatus =
  | 'PENDING' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type ServiceRequestPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type BookingStatus =
  | 'BOOKED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';

export type SmokingPreference = 'SMOKING' | 'NON_SMOKING' | 'ANY';

export interface Room {
  id: string;
  name: string;
  room_number?: string;
  floor?: number;
  type?: 'STANDARD' | 'DELUXE' | 'SUITE' | 'VILLA' | string;
  capacity?: number;
  base_rate?: number;
  status?: RoomStatus;
  amenities?: string[]; // parsed from JSON
  qr_code_data?: string;
  notes?: string;
  smoking_preference?: SmokingPreference;
  created_at?: string;
}

export interface Service {
  id: string;
  name: string;
  description?: string;
  category: ServiceCategory;
  is_complimentary: boolean;
  price: number;
  price_type: 'FIXED' | 'PER_HOUR' | 'PER_PERSON' | 'PER_NIGHT';
  sla_minutes?: number;
  assigned_role?: UserRole;
  icon?: string;
  image_url?: string;
  is_active: boolean;
  display_order?: number;
}

export interface ServiceRequest {
  id: string;
  room_id: string;
  booking_id?: string;
  guest_session_id?: string;
  service_id?: string;
  service_name: string;
  category: ServiceCategory;
  quantity?: number;
  notes?: string;
  priority: ServiceRequestPriority;
  status: ServiceRequestStatus;
  assigned_to?: string;
  assigned_role?: UserRole;
  is_complimentary: boolean;
  charge_amount?: number;
  folio_entry_id?: string;
  requested_at: string;
  acknowledged_at?: string;
  completed_at?: string;
  guest_rating?: number;
  guest_feedback?: string;
  // Convenience fields added by server joins:
  room_name?: string;
  guest_name?: string;
}

export interface RoomSession {
  id: string;
  room_id: string;
  booking_id?: string;
  session_token: string;
  status: 'active' | 'expired' | 'checked_out';
  guest_name?: string;
  guest_phone?: string;
  opened_at: string;
  last_activity_at?: string;
  closed_at?: string;
}

export interface RoomBooking {
  id: string;
  room_id: string;
  guest_name: string;
  guest_phone?: string;
  guest_email?: string;
  guest_id_proof?: string;
  guest_nationality?: string;
  num_guests?: number;
  check_in_date: string;
  check_out_date: string;
  actual_checkin_at?: string;
  actual_checkout_at?: string;
  status: BookingStatus;
  booking_source?: 'DIRECT' | 'BOOKING' | 'MMT' | 'AGODA' | 'WALKIN' | string;
  room_rate?: number;
  total_amount?: number;
  special_requests?: string;
  created_at?: string;
  // convenience joins:
  room_name?: string;
}

export interface Folio {
  id: string;
  booking_id: string;
  room_id: string;
  status: 'open' | 'settled' | 'voided';
  subtotal: number;
  gst_amount: number;
  service_charge: number;
  discount: number;
  grand_total: number;
  payment_method?: string;
  settled_at?: string;
  created_at?: string;
}

export interface FolioEntry {
  id: string;
  folio_id: string;
  entry_type: 'ROOM_CHARGE' | 'SERVICE' | 'F&B' | 'TAX' | 'DISCOUNT' | 'PAYMENT';
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  gst_rate?: number;
  gst_amount?: number;
  source_id?: string;
  created_at?: string;
}
