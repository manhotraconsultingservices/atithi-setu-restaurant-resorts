import React, { useState, useCallback } from 'react';
import { RefreshCw, BarChart3, AlertCircle } from 'lucide-react';
import { DataTable, ColDef } from './DataTable';
import { todayIST } from '../lib/utils';

interface Props {
  restaurantId: string;
  token: string;
}

type Category = 'front-office' | 'accounting' | 'management' | 'groups';

interface ReportDef {
  key: string;
  label: string;
  description: string;
  category: Category;
  endpoint: string;
  noDateRange?: boolean;
  stub?: boolean;
  stubNote?: string;
  columns: ColDef[];
}

const CATEGORIES: { id: Category; label: string; emoji: string }[] = [
  { id: 'front-office', label: 'Front Office',  emoji: '🏨' },
  { id: 'accounting',   label: 'Accounting',    emoji: '💰' },
  { id: 'management',   label: 'Management',    emoji: '📊' },
  { id: 'groups',       label: 'Groups',         emoji: '👥' },
];

const CAT_COLOR: Record<Category, string> = {
  'front-office': '#1e3a5f',
  'accounting':   '#0f766e',
  'management':   '#b8860b',
  'groups':       '#9f1239',
};

const fmt = (n: any) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const pct = (n: any) => `${Number(n || 0).toFixed(1)}%`;

// GET .../group-revenue has no status column of its own - derive one from
// the room counts and settled_at it does return, same lifecycle the group
// itself goes through (booked → in house → checked out → settled), so the
// Group Sales Report's Status column has something real to show instead of
// reading a field that was never there.
const groupStatus = (r: any): string => {
  const numRooms = Number(r.num_rooms || 0);
  if (r.settled_at) return 'SETTLED';
  if (numRooms > 0 && Number(r.cancelled_rooms || 0) >= numRooms) return 'CANCELLED';
  if (numRooms > 0 && Number(r.checked_out_rooms || 0) >= numRooms) return 'CHECKED_OUT';
  if (Number(r.active_rooms || 0) > 0) return 'IN_HOUSE';
  return 'BOOKED';
};

const idProof = (raw: any) => {
  try {
    const p = JSON.parse(raw || '{}');
    return `${p.type || '—'}: ${p.number || '—'}`;
  } catch {
    return raw || '—';
  }
};

const REPORTS: ReportDef[] = [
  // ── FRONT OFFICE ───────────────────────────────────────────────────────────
  {
    key: 'arrivals',
    label: 'Arrival Report',
    description: 'Expected arrivals for the date range. Use for pre-arrival prep, room assignments, and guest welcome planning.',
    category: 'front-office',
    endpoint: '/hotel/reports/arrivals?from={from}&to={to}',
    columns: [
      { key: 'check_in_date',  label: 'Check-in',  sortable: true },
      { key: 'guest_name',     label: 'Guest',      sortable: true },
      { key: 'guest_phone',    label: 'Phone' },
      { key: 'room',           label: 'Room',        getValue: r => r.room_name || r.room_number || '—' },
      { key: 'room_category',  label: 'Category',   sortable: true, getValue: r => r.room_category || r.room_type || '—' },
      { key: 'num_guests',     label: 'Pax',         sortable: true, align: 'right' },
      { key: 'booking_source', label: 'Source',     sortable: true, getValue: r => r.booking_source || 'DIRECT' },
      { key: 'status',         label: 'Status',     sortable: true },
    ],
  },
  {
    key: 'departures',
    label: 'Departure Report',
    description: 'Expected departures for the date range. Track check-outs, folio totals, and room turnovers.',
    category: 'front-office',
    endpoint: '/hotel/reports/departures?from={from}&to={to}',
    columns: [
      { key: 'check_out_date', label: 'Check-out',  sortable: true },
      { key: 'guest_name',     label: 'Guest',       sortable: true },
      { key: 'guest_phone',    label: 'Phone' },
      { key: 'room',           label: 'Room',         getValue: r => r.room_name || r.room_number || '—' },
      { key: 'check_in_date',  label: 'Check-in',   sortable: true },
      { key: 'folio_total',    label: 'Folio Total', sortable: true, align: 'right',
        getValue: r => Number(r.folio_total || r.total_amount || 0),
        render: r => fmt(r.folio_total || r.total_amount) },
      { key: 'status',         label: 'Status',     sortable: true },
    ],
  },
  {
    key: 'night-audit',
    label: 'Night Audit Report',
    description: 'End-of-day audit: in-house guests, room charges posted, payments received. Runs against the "To" date.',
    category: 'front-office',
    endpoint: '/hotel/reports/night-audit?date={to}',
    // The endpoint's response has no top-level rows/data array (see the
    // in_house fallback above) and no per-booking charges_today/folio_balance
    // - those two columns guessed fields the API never computed per guest,
    // so they always read (blank). Nights So Far is now computed from
    // check_in_date instead of reading a field that didn't exist; Booking
    // Value replaces the two unavailable money columns with one the API does
    // return per booking.
    columns: [
      { key: 'room_name',     label: 'Room',       sortable: true, getValue: r => r.room_name || r.room_number || '—' },
      { key: 'guest_name',    label: 'Guest',      sortable: true },
      { key: 'check_in_date', label: 'Check-in',  sortable: true,
        getValue: r => String(r.check_in_date || '').slice(0, 10) || '—' },
      { key: 'check_out_date',label: 'Check-out', sortable: true,
        getValue: r => String(r.check_out_date || '').slice(0, 10) || '—' },
      { key: 'room_rate',     label: 'Rate/Night', align: 'right',
        getValue: r => Number(r.room_rate || 0), render: r => fmt(r.room_rate) },
      { key: 'nights_so_far', label: 'Nights So Far', align: 'right',
        getValue: r => {
          const ci = String(r.check_in_date || '').slice(0, 10);
          if (!ci) return 0;
          const days = Math.floor((Date.now() - new Date(ci + 'T00:00:00Z').getTime()) / 86400000);
          return Math.max(1, days + 1);
        } },
      { key: 'total_amount',  label: 'Booking Value', align: 'right',
        getValue: r => Number(r.total_amount || 0), render: r => fmt(r.total_amount) },
    ],
  },
  {
    key: 'police-enquiry',
    label: 'Police Enquiry Report',
    description: 'Statutory guest register: ID proof, nationality, and stay details for law-enforcement compliance (Form C).',
    category: 'front-office',
    endpoint: '/hotel/reports/police-enquiry?from={from}&to={to}',
    columns: [
      { key: 'check_in_date',  label: 'Check-in',    sortable: true },
      { key: 'guest_name',     label: 'Guest Name',  sortable: true },
      { key: 'guest_phone',    label: 'Phone' },
      { key: 'nationality',    label: 'Nationality',  sortable: true },
      { key: 'id_proof',       label: 'ID Proof',    getValue: r => idProof(r.guest_id_proof) },
      { key: 'num_guests',     label: 'Pax',          align: 'right' },
      { key: 'room',           label: 'Room',          getValue: r => r.room_name || r.room_number || '—' },
      { key: 'check_out_date', label: 'Check-out',   sortable: true },
      { key: 'status',         label: 'Status',      sortable: true },
    ],
  },
  {
    key: 'no-shows',
    label: 'No Show Report',
    description: 'Guests who booked but did not arrive. Useful for OTA disputes and no-show rate recovery.',
    category: 'front-office',
    endpoint: '/hotel/reports/no-shows?from={from}&to={to}',
    columns: [
      { key: 'check_in_date',  label: 'Expected Arrival', sortable: true },
      { key: 'guest_name',     label: 'Guest',             sortable: true },
      { key: 'guest_phone',    label: 'Phone' },
      { key: 'room',           label: 'Room',               getValue: r => r.room_name || r.room_number || '—' },
      { key: 'room_category',  label: 'Category',          getValue: r => r.room_category || '—' },
      { key: 'room_rate',      label: 'Rate',              align: 'right',
        getValue: r => Number(r.room_rate || 0), render: r => fmt(r.room_rate) },
      { key: 'total_amount',   label: 'Booking Value',     align: 'right',
        getValue: r => Number(r.total_amount || 0), render: r => fmt(r.total_amount) },
      { key: 'booking_source', label: 'Source',            sortable: true,
        getValue: r => r.booking_source || 'DIRECT' },
    ],
  },
  {
    key: 'room-status',
    label: 'Room Status Report',
    description: 'Current occupancy snapshot — which rooms are available, occupied, dirty, or blocked right now.',
    category: 'front-office',
    endpoint: '/hotel/reports/room-status',
    noDateRange: true,
    columns: [
      { key: 'room_number',   label: 'Room No.',  sortable: true },
      // GET /hotel/reports/room-status names its columns name/occupied_by/
      // occupied_check_in/occupied_check_out (matches the working Hotel
      // Reports > Room Status screen) - this table guessed different names
      // (room_name/guest_name/check_in/check_out), so Room Name, Guest,
      // Check-in and Check-out always fell through to '-' even for a room
      // the API had a real guest and dates for.
      { key: 'room_name',     label: 'Room Name', sortable: true,
        getValue: r => r.name || r.room_name || '—' },
      { key: 'room_category', label: 'Category',  sortable: true,
        getValue: r => r.room_category || r.room_type || '—' },
      { key: 'status',        label: 'Status',    sortable: true },
      { key: 'guest',         label: 'Guest',
        getValue: r => r.occupied_by || r.guest_name || r.current_guest || '—' },
      { key: 'check_in',      label: 'Check-in',
        getValue: r => r.occupied_check_in ? String(r.occupied_check_in).slice(0, 10) : (r.check_in_date || r.check_in || '—') },
      { key: 'check_out',     label: 'Check-out',
        getValue: r => r.occupied_check_out ? String(r.occupied_check_out).slice(0, 10) : (r.check_out_date || r.check_out || '—') },
    ],
  },
  {
    key: 'out-of-order-rooms',
    label: 'Out of Order Rooms',
    description: 'Rooms currently under maintenance, blocked, or cleaning — snapshot of unavailable inventory.',
    category: 'front-office',
    endpoint: '/hotel/reports/out-of-order-rooms',
    noDateRange: true,
    columns: [
      { key: 'room_number',   label: 'Room No.',  sortable: true },
      { key: 'name',          label: 'Room Name', sortable: true },
      { key: 'room_category', label: 'Category',  sortable: true },
      { key: 'status',        label: 'Status',    sortable: true },
      { key: 'notes',         label: 'Notes',     getValue: r => r.notes || '—' },
    ],
  },
  {
    key: 'room-changes',
    label: 'Room Change Report',
    description: 'Log of every room move during the period — reassignments and complimentary upgrades with reason and timestamp.',
    category: 'front-office',
    endpoint: '/hotel/reports/room-changes?from={from}&to={to}',
    columns: [
      { key: 'changed_at',      label: 'Changed At',   sortable: true },
      { key: 'guest_name',      label: 'Guest',        sortable: true },
      { key: 'from_room_name',  label: 'From Room',    sortable: true, getValue: r => r.from_room_name || '—' },
      { key: 'to_room_name',    label: 'To Room',      sortable: true, getValue: r => r.to_room_name   || '—' },
      { key: 'reason',          label: 'Reason',       getValue: r => r.reason || '—' },
      { key: 'check_in_date',   label: 'Check-in',     sortable: true,
        getValue: r => r.check_in_date ? String(r.check_in_date).slice(0, 10) : '—' },
      { key: 'booking_status',  label: 'Status',       sortable: true },
    ],
  },

  // ── ACCOUNTING ─────────────────────────────────────────────────────────────
  {
    key: 'payment-received',
    label: 'Payments Report',
    description: 'All payments received in the date range, broken down by method and booking source.',
    category: 'accounting',
    endpoint: '/hotel/reports/payment-received?from={from}&to={to}',
    // GET .../payment-received returns one row per period x payment-method x
    // source ({period, method, source, amount, txns}), same as the working
    // Hotel Reports > Payment Received screen - it does NOT return a flat
    // per-transaction list, so there is no guest_name/room_name/payment_date
    // to read. This card guessed a per-payment shape that never existed on
    // this endpoint, so every column but Amount always fell through to '—'.
    columns: [
      { key: 'period',   label: 'Period',  sortable: true },
      { key: 'method',   label: 'Method',  sortable: true,
        getValue: r => r.method || 'OTHER' },
      { key: 'source',   label: 'Source',  sortable: true,
        getValue: r => r.source || 'DIRECT' },
      { key: 'amount',   label: 'Amount',  sortable: true, align: 'right',
        getValue: r => Number(r.amount || 0), render: r => fmt(r.amount) },
      { key: 'txns',     label: 'Payments', sortable: true, align: 'right',
        getValue: r => Number(r.txns || 0) },
    ],
  },
  {
    key: 'pos-report',
    label: 'POS Report',
    description: 'Restaurant / F&B point-of-sale summary by day — order count, gross revenue, and GST collected.',
    category: 'accounting',
    endpoint: '/hotel/reports/pos-report?from={from}&to={to}',
    columns: [
      { key: 'sale_date',     label: 'Date',         sortable: true },
      { key: 'order_count',   label: 'Orders',       sortable: true, align: 'right' },
      { key: 'tables_served', label: 'Tables',       align: 'right' },
      { key: 'net_revenue',   label: 'Net Revenue',  sortable: true, align: 'right',
        getValue: r => Number(r.net_revenue || 0), render: r => fmt(r.net_revenue) },
      { key: 'gst',           label: 'GST',          align: 'right',
        getValue: r => Number(r.gst || 0), render: r => fmt(r.gst) },
      { key: 'gross_revenue', label: 'Gross Revenue',sortable: true, align: 'right',
        getValue: r => Number(r.gross_revenue || 0), render: r => fmt(r.gross_revenue) },
    ],
  },
  {
    key: 'item-consumption',
    label: 'Item Consumption Report',
    description: 'F&B items sold by quantity and revenue — identify best sellers and high-margin products.',
    category: 'accounting',
    endpoint: '/hotel/reports/item-consumption?from={from}&to={to}',
    columns: [
      { key: 'item_name',     label: 'Item',      sortable: true },
      { key: 'category',      label: 'Category',  sortable: true },
      { key: 'qty_sold',      label: 'Qty Sold',  sortable: true, align: 'right',
        getValue: r => Number(r.qty_sold || 0) },
      { key: 'avg_price',     label: 'Avg Price', align: 'right',
        getValue: r => Number(r.avg_price || 0), render: r => fmt(r.avg_price) },
      { key: 'total_revenue', label: 'Revenue',   sortable: true, align: 'right',
        getValue: r => Number(r.total_revenue || 0), render: r => fmt(r.total_revenue) },
    ],
  },
  {
    key: 'outstanding-payments',
    label: 'City Ledger / Outstanding',
    description: 'Bookings with unpaid or partially-paid folios — OTAs, corporate accounts, and walk-in dues.',
    category: 'accounting',
    endpoint: '/hotel/reports/outstanding-payments?from={from}&to={to}',
    // This endpoint doesn't join rooms (there's no room_name/room_number to
    // read) and names the money field outstanding_balance, not outstanding -
    // Room always read '-' and Outstanding, the whole point of this report,
    // always read 0. Paid is now derived (commission - what's still owed)
    // since the API has no separate amount_paid field; Partner replaces the
    // meaningless Room column with data the API actually returns.
    columns: [
      { key: 'guest_name',     label: 'Guest',       sortable: true },
      { key: 'partner_name',   label: 'Partner',      getValue: r => r.partner_name || r.booking_source || '—' },
      { key: 'check_in_date',  label: 'Check-in',   sortable: true },
      { key: 'check_out_date', label: 'Check-out',  sortable: true },
      { key: 'total_amount',   label: 'Total',      align: 'right',
        getValue: r => Number(r.total_amount || 0), render: r => fmt(r.total_amount) },
      { key: 'amount_paid',    label: 'Settled',    align: 'right',
        getValue: r => Math.max(0, Number(r.commission_amount || 0) - Number(r.outstanding_balance ?? r.outstanding ?? 0)),
        render: r => fmt(Math.max(0, Number(r.commission_amount || 0) - Number(r.outstanding_balance ?? r.outstanding ?? 0))) },
      { key: 'outstanding',    label: 'Outstanding', sortable: true, align: 'right',
        getValue: r => Number(r.outstanding_balance ?? r.outstanding ?? r.outstanding_amount ?? 0),
        render: r => fmt(r.outstanding_balance ?? r.outstanding ?? r.outstanding_amount) },
      { key: 'booking_source', label: 'Source',     sortable: true,
        getValue: r => r.booking_source || 'DIRECT' },
    ],
  },

  // ── MANAGEMENT ─────────────────────────────────────────────────────────────
  {
    key: 'hotel-sales',
    label: 'Hotel Sales Report',
    description: 'Daily settled revenue split by room charges vs services. The core metric for ownership reporting.',
    category: 'management',
    endpoint: '/hotel/reports/hotel-sales?from={from}&to={to}',
    columns: [
      { key: 'sale_date',       label: 'Date',          sortable: true },
      { key: 'folios_settled',  label: 'Check-outs',    sortable: true, align: 'right' },
      { key: 'room_revenue',    label: 'Room Revenue',  sortable: true, align: 'right',
        getValue: r => Number(r.room_revenue || 0), render: r => fmt(r.room_revenue) },
      { key: 'service_revenue', label: 'Service Rev.',  sortable: true, align: 'right',
        getValue: r => Number(r.service_revenue || 0), render: r => fmt(r.service_revenue) },
      { key: 'gross_revenue',   label: 'Gross',         sortable: true, align: 'right',
        getValue: r => Number(r.gross_revenue || 0), render: r => fmt(r.gross_revenue) },
      { key: 'gst_collected',   label: 'GST',           align: 'right',
        getValue: r => Number(r.gst_collected || 0), render: r => fmt(r.gst_collected) },
      { key: 'net_billed',      label: 'Net Billed',    sortable: true, align: 'right',
        getValue: r => Number(r.net_billed || 0), render: r => fmt(r.net_billed) },
    ],
  },
  {
    key: 'revenue-by-room-type',
    label: 'Revenue by Room Type',
    description: 'Revenue contribution per room category — compare ADR and occupancy across room types.',
    category: 'management',
    endpoint: '/hotel/reports/revenue-by-room-type?from={from}&to={to}',
    // The API names the occupied-nights column room_nights, not 'occupied' -
    // that one guessed name meant this column (and, before the endpoint was
    // fixed, Total Rooms + Occupancy % too, since the API never computed
    // them) always fell through to 0.
    columns: [
      { key: 'room_type',     label: 'Room Type',      sortable: true },
      { key: 'total_rooms',   label: 'Total Rooms',    align: 'right' },
      { key: 'room_nights',   label: 'Occupied Nights',sortable: true, align: 'right',
        getValue: r => Number(r.room_nights || 0) },
      { key: 'occupancy_pct', label: 'Occupancy %',   sortable: true, align: 'right',
        getValue: r => Number(r.occupancy_pct || 0), render: r => pct(r.occupancy_pct) },
      { key: 'adr',           label: 'ADR',            sortable: true, align: 'right',
        getValue: r => Number(r.adr || 0), render: r => fmt(r.adr) },
      { key: 'revenue',       label: 'Revenue',        sortable: true, align: 'right',
        getValue: r => Number(r.revenue || 0), render: r => fmt(r.revenue) },
    ],
  },
  {
    key: 'occupancy-trend',
    label: 'Occupancy Trend',
    description: 'Daily occupancy rate trend — spot seasonal peaks, pricing opportunities, and demand patterns.',
    category: 'management',
    endpoint: '/hotel/reports/occupancy-trend?from={from}&to={to}',
    // The API names the date column 'night' (not 'date') and has no
    // 'available' field of its own - it's total_rooms minus occupied - so
    // both columns always read blank.
    columns: [
      { key: 'date',          label: 'Date',        sortable: true,
        getValue: r => r.night || r.date || '—' },
      { key: 'available',     label: 'Avail. Rooms', align: 'right',
        getValue: r => Math.max(0, Number(r.total_rooms || 0) - Number(r.occupied || 0)) },
      { key: 'occupied',      label: 'Occupied',    sortable: true, align: 'right' },
      { key: 'occupancy_pct', label: 'Occupancy %', sortable: true, align: 'right',
        getValue: r => Number(r.occupancy_pct || r.occupancy || 0),
        render: r => pct(r.occupancy_pct || r.occupancy) },
    ],
  },
  {
    key: 'daily-forecast',
    label: 'Daily Forecast',
    description: 'Forward-looking arrivals: expected check-ins, guest count, and projected revenue by date.',
    category: 'management',
    endpoint: '/hotel/reports/daily-forecast?from={from}&to={to}',
    columns: [
      { key: 'forecast_date',     label: 'Date',             sortable: true },
      { key: 'expected_arrivals', label: 'Exp. Arrivals',    sortable: true, align: 'right' },
      { key: 'expected_guests',   label: 'Exp. Guests',      sortable: true, align: 'right' },
      { key: 'day_use_count',     label: 'Day-use',          align: 'right' },
      { key: 'expected_revenue',  label: 'Exp. Revenue',     sortable: true, align: 'right',
        getValue: r => Number(r.expected_revenue || 0), render: r => fmt(r.expected_revenue) },
    ],
  },
  {
    key: 'monthly-pnl',
    label: 'Monthly P&L',
    description: 'Month-by-month room revenue vs petty-cash expenses and net profit — owner and investor view.',
    category: 'management',
    endpoint: '/hotel/reports/monthly-pnl?from={from}&to={to}',
    columns: [
      { key: 'month',      label: 'Month',      sortable: true },
      { key: 'revenue',    label: 'Revenue',    sortable: true, align: 'right',
        getValue: r => Number(r.revenue || 0), render: r => fmt(r.revenue) },
      { key: 'gst',        label: 'GST',        align: 'right',
        getValue: r => Number(r.gst || 0), render: r => fmt(r.gst) },
      { key: 'expenses',   label: 'Expenses',   sortable: true, align: 'right',
        getValue: r => Number(r.expenses || 0), render: r => fmt(r.expenses) },
      { key: 'net_profit', label: 'Net Profit', sortable: true, align: 'right',
        getValue: r => Number(r.net_profit || 0), render: r => fmt(r.net_profit) },
    ],
  },
  {
    key: 'contribution',
    label: 'Contribution Report',
    description: 'Revenue by booking source — direct vs OTA vs corporate. See which channels contribute most.',
    category: 'management',
    endpoint: '/hotel/reports/contribution?from={from}&to={to}',
    columns: [
      { key: 'source',          label: 'Channel / Source', sortable: true },
      { key: 'bookings',        label: 'Bookings',         sortable: true, align: 'right' },
      { key: 'total_revenue',   label: 'Total Revenue',   sortable: true, align: 'right',
        getValue: r => Number(r.total_revenue || 0), render: r => fmt(r.total_revenue) },
      { key: 'settled_revenue', label: 'Settled Revenue', sortable: true, align: 'right',
        getValue: r => Number(r.settled_revenue || 0), render: r => fmt(r.settled_revenue) },
      { key: 'avg_revenue',     label: 'Avg / Booking',   align: 'right',
        getValue: r => Number(r.avg_revenue || 0), render: r => fmt(r.avg_revenue) },
      { key: 'share_pct',       label: 'Share %',         sortable: true, align: 'right',
        getValue: r => Number(r.share_pct || 0), render: r => pct(r.share_pct) },
    ],
  },

  // ── GROUPS ─────────────────────────────────────────────────────────────────
  // GET .../group-revenue returns room_booking_groups rows named name (not
  // group_name), num_rooms (not rooms/room_count), advance_amount (not
  // advance_paid), and no status column at all - group-revenue and group-pnl
  // both guessed different names, so Group Name/Company/Rooms/Advance/Status
  // always fell through to '-' or 0 (Outstanding, being Total - Advance,
  // silently overstated every group's due amount by its full advance paid).
  // Status is derived here from the room counts + settled_at the API does
  // return, since the query itself has no status field to rename to.
  {
    key: 'group-revenue',
    label: 'Group Sales Report',
    description: 'Group bookings by revenue — company names, room counts, stay dates, and settlement status.',
    category: 'groups',
    endpoint: '/hotel/reports/group-revenue?from={from}&to={to}',
    columns: [
      { key: 'group_name',    label: 'Group Name', sortable: true,
        getValue: r => r.name || r.group_name || '—' },
      { key: 'company_name',  label: 'Contact',    sortable: true,
        getValue: r => r.contact_name || r.company_name || r.name || '—' },
      { key: 'rooms',         label: 'Rooms',      sortable: true, align: 'right',
        getValue: r => Number(r.num_rooms || r.rooms || r.room_count || r.bookings_count || 0) },
      { key: 'check_in_date', label: 'Check-in',  sortable: true },
      { key: 'check_out_date',label: 'Check-out', sortable: true },
      { key: 'total_revenue', label: 'Total Revenue', sortable: true, align: 'right',
        getValue: r => Number(r.total_revenue || r.total_amount || 0),
        render: r => fmt(r.total_revenue || r.total_amount) },
      { key: 'advance_paid',  label: 'Advance',   align: 'right',
        getValue: r => Number(r.advance_paid || r.advance_amount || 0),
        render: r => fmt(r.advance_paid || r.advance_amount) },
      { key: 'status',        label: 'Status',    sortable: true,
        getValue: r => groupStatus(r) },
    ],
  },
  {
    key: 'group-pnl',
    label: 'Group P&L',
    description: 'Group billing: advance collected vs outstanding balance per group stay.',
    category: 'groups',
    endpoint: '/hotel/reports/group-revenue?from={from}&to={to}',
    columns: [
      { key: 'group_name',    label: 'Group',       sortable: true,
        getValue: r => r.name || r.group_name || '—' },
      { key: 'total_revenue', label: 'Total Billed',sortable: true, align: 'right',
        getValue: r => Number(r.total_revenue || r.total_amount || 0),
        render: r => fmt(r.total_revenue || r.total_amount) },
      { key: 'advance_paid',  label: 'Advance',    align: 'right',
        getValue: r => Number(r.advance_paid || r.advance_amount || 0),
        render: r => fmt(r.advance_paid || r.advance_amount) },
      { key: 'outstanding',   label: 'Outstanding', sortable: true, align: 'right',
        getValue: r => Math.max(0, Number(r.total_revenue || r.total_amount || 0) - Number(r.advance_paid || r.advance_amount || 0)),
        render: r => fmt(Math.max(0, Number(r.total_revenue || r.total_amount || 0) - Number(r.advance_paid || r.advance_amount || 0))) },
      { key: 'status',        label: 'Status',     sortable: true },
      { key: 'check_in_date', label: 'Check-in',  sortable: true },
      { key: 'check_out_date',label: 'Check-out', sortable: true },
    ],
  },
];

// ─── sub-component ────────────────────────────────────────────────────────────

interface ReportCardProps {
  report: ReportDef;
  isActive: boolean;
  loading: boolean;
  onRun: () => void;
}

const ReportCard: React.FC<ReportCardProps> = ({ report, isActive, loading, onRun }) => {
  return (
    <div className={`bg-white rounded-3xl border-2 transition-all duration-150 p-4 flex flex-col gap-3 ${
      isActive
        ? 'border-brand shadow-lg shadow-brand/10'
        : 'border-[#e8dccf] hover:border-brand/40'
    }`}>
      <div className="flex items-start justify-between">
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white uppercase tracking-wide"
          style={{ background: CAT_COLOR[report.category] }}
        >
          {report.category.replace('-', ' ')}
        </span>
        {report.noDateRange && (
          <span className="text-[10px] text-[#9c8e85] font-medium">Live snapshot</span>
        )}
      </div>
      <div>
        <h3 className="font-bold text-sm text-[#1a1208] leading-tight">{report.label}</h3>
        <p className="text-xs text-[#6b5d52] leading-relaxed mt-1">{report.description}</p>
      </div>
      {report.stub ? (
        <p className="text-xs text-[#9c8e85] italic">{report.stubNote || 'Coming Soon'}</p>
      ) : (
        <button
          onClick={onRun}
          disabled={loading}
          className="mt-auto flex items-center justify-center gap-1.5 px-3 py-2 bg-brand hover:bg-brand-dark text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-60 w-full"
        >
          {loading
            ? <RefreshCw size={12} className="animate-spin" />
            : <BarChart3 size={12} />
          }
          {loading ? 'Running…' : 'Run Report'}
        </button>
      )}
    </div>
  );
};


// ─── main component ───────────────────────────────────────────────────────────

export function AllReportsHub({ restaurantId, token }: Props) {
  const todayStr = todayIST();
  const firstOfMonth = todayStr.slice(0, 8) + '01';

  const [category, setCategory] = useState<Category>('front-office');
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayStr);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [reportState, setReportState] = useState<{ loading: boolean; rows: any[]; error?: string } | null>(null);

  const run = useCallback(async (rpt: ReportDef) => {
    const path = rpt.noDateRange
      ? rpt.endpoint
      : rpt.endpoint.replace('{from}', from).replace('{to}', to);
    setActiveKey(rpt.key);
    setReportState({ loading: true, rows: [] });
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      // Night Audit's endpoint returns { as_of, summary, arrivals, departures,
      // in_house } - no top-level rows/data key - so this report's table
      // showed zero rows no matter the date, until in_house was added as a
      // fallback (the "who's in the hotel right now" list the report card
      // itself is about).
      const rows = Array.isArray(data) ? data : (data.rows || data.data || data.in_house || []);
      setReportState({ loading: false, rows });
    } catch (e: any) {
      setReportState({ loading: false, rows: [], error: e.message });
    }
  }, [restaurantId, token, from, to]);

  const catReports = REPORTS.filter(r => r.category === category);
  const activeRpt = activeKey ? REPORTS.find(r => r.key === activeKey) ?? null : null;
  const showDateBar = catReports.some(r => !r.noDateRange);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold font-serif text-[#1a1208]">📋 Reports</h2>
        <p className="text-sm text-[#6b5d52] mt-1">
          Comprehensive reporting across hotel operations, accounting, management intelligence, and group activity.
          Select a category, set the date range, and click <strong>Run Report</strong> — results export to CSV.
        </p>
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map(c => (
          <button
            key={c.id}
            onClick={() => { setCategory(c.id); setActiveKey(null); setReportState(null); }}
            className={`px-4 py-2 rounded-2xl text-sm font-semibold transition-colors ${
              category === c.id
                ? 'bg-brand text-white shadow-sm'
                : 'bg-white text-[#6b5d52] border border-[#e8dccf] hover:border-brand hover:text-brand'
            }`}
          >
            {c.emoji} {c.label}
          </button>
        ))}
      </div>

      {/* Date range bar */}
      {showDateBar && (
        <div className="flex flex-wrap items-center gap-3 p-3 bg-white rounded-2xl border border-[#e8dccf]">
          <span className="text-xs font-semibold text-[#6b5d52] uppercase tracking-wide">Date Range</span>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-[#9c8e85]">From</label>
            <input
              type="date" value={from} max={to}
              onChange={e => setFrom(e.target.value)}
              className="border border-[#e8dccf] rounded-xl px-2 py-1 text-sm text-[#3d3128] focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-[#9c8e85]">To</label>
            <input
              type="date" value={to} min={from}
              onChange={e => setTo(e.target.value)}
              className="border border-[#e8dccf] rounded-xl px-2 py-1 text-sm text-[#3d3128] focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <button
            onClick={() => { setFrom(todayStr); setTo(todayStr); }}
            className="text-xs text-brand underline underline-offset-2"
          >Today</button>
          <button
            onClick={() => { setFrom(firstOfMonth); setTo(todayStr); }}
            className="text-xs text-brand underline underline-offset-2"
          >This month</button>
        </div>
      )}

      {/* Report cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {catReports.map(rpt => (
          <ReportCard
            key={rpt.key}
            report={rpt}
            isActive={activeKey === rpt.key}
            loading={activeKey === rpt.key && !!reportState?.loading}
            onRun={() => run(rpt)}
          />
        ))}
      </div>

      {/* Result table */}
      {activeRpt && reportState && !reportState.loading && (
        <div className="rounded-3xl border border-[#e8dccf] overflow-hidden">
          <div className="px-5 py-3 bg-[#faf7f2] flex items-center gap-3">
            <span className="font-bold font-serif text-[#1a1208] text-lg">{activeRpt.label}</span>
            {!reportState.error && (
              <span className="text-xs text-[#9c8e85]">{reportState.rows.length} records</span>
            )}
            {!activeRpt.noDateRange && (
              <span className="text-xs text-[#9c8e85] ml-auto">{from} → {to}</span>
            )}
          </div>
          {reportState.error ? (
            <div className="p-8 flex items-center justify-center gap-2 text-[#c13b3b]">
              <AlertCircle size={18} />
              <span className="text-sm">{reportState.error}</span>
            </div>
          ) : (
            <div className="p-4">
              <DataTable
                data={reportState.rows}
                columns={activeRpt.columns}
                rowKey={(r, i) => r.id ?? i}
                exportFilename={`${activeRpt.key}${activeRpt.noDateRange ? '' : `-${from}-${to}`}`}
                searchPlaceholder="Search report…"
                emptyMessage="No data for this period."
                compact
              />
            </div>
          )}
        </div>
      )}

      {/* Loading spinner */}
      {activeRpt && reportState?.loading && (
        <div className="flex items-center justify-center py-12 text-[#6b5d52]">
          <RefreshCw size={20} className="animate-spin mr-2" />
          <span className="text-sm">Loading {activeRpt.label}…</span>
        </div>
      )}
    </div>
  );
}
