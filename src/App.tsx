import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Utensils, 
  ChefHat, 
  ShieldCheck,
  Shield,
  ShoppingCart, 
  QrCode, 
  Plus, 
  Minus,
  Trash2, 
  CheckCircle2, 
  Clock, 
  BarChart3,
  ChevronRight,
  ChevronLeft,
  Edit3,
  X,
  CreditCard,
  Receipt,
  Settings,
  Star,
  LogOut,
  Layout,
  User,
  Lock,
  Mail,
  Download,
  Leaf,
  Search,
  Smartphone,
  Hash,
  Copy,
  Check,
  Info,
  Calendar,
  UserCheck,
  History,
  RefreshCw,
  Bell,
  MessageCircle,
  MessageSquare,
  Save,
  Users,
  CalendarCheck,
  Menu,
  TrendingUp,
  Award,
  Zap,
  Filter,
  MapPin,
  Eye,
  EyeOff,
  Printer,
  ChevronDown,
  ChevronUp,
  ArrowDownCircle,
  ChevronsUpDown,
  Upload,
  LayoutGrid,
  List,
  Sparkles,
  IndianRupee,
  Bed,
  AlertCircle,
  Globe,
} from 'lucide-react';
import { useSocket } from './lib/socket';
import { useAlertChime } from './lib/useAlertChime';
import { MenuItem, Order, UserRole, OrderItem, Restaurant, Table, DietaryType, ItemSize, TableSession, LiveTableView, TableStatus } from './types';
import { cn } from './lib/utils';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  Line,
  Legend,
} from 'recharts';

// ── Reusable Pagination Bar ────────────────────────────────────────────────
const PAGE_SIZE = 20;

function PaginationBar({ page, totalPages, setPage, total, pageSize = PAGE_SIZE }: {
  page: number; totalPages: number;
  setPage: (p: number | ((prev: number) => number)) => void;
  total: number; pageSize?: number;
}) {
  if (total === 0) return null;
  const start = Math.min((page - 1) * pageSize + 1, total);
  const end   = Math.min(page * pageSize, total);
  const rawPages = Array.from({ length: totalPages }, (_, i) => i + 1)
    .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1);
  const withEllipsis: (number | '...')[] = [];
  rawPages.forEach((p, i) => {
    if (i > 0 && p - rawPages[i - 1] > 1) withEllipsis.push('...');
    withEllipsis.push(p);
  });
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-[#cc5a16]/10 bg-[#faf7f2]/40 select-none">
      <span className="text-xs text-[#9c8e85] font-medium">{start}–{end} of {total}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setPage(1)} disabled={page === 1}
          className="px-2 py-1 rounded-lg text-xs font-bold hover:bg-[#cc5a16]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">«</button>
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
          className="px-2 py-1 rounded-lg text-xs font-bold hover:bg-[#cc5a16]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">‹</button>
        {withEllipsis.map((p, i) =>
          p === '...' ? (
            <span key={`e${i}`} className="px-1.5 text-[#9c8e85] text-xs">…</span>
          ) : (
            <button key={p} onClick={() => setPage(p as number)}
              className={cn('w-7 h-7 rounded-lg text-xs font-bold transition-colors',
                p === page ? 'bg-[#cc5a16] text-white' : 'hover:bg-[#cc5a16]/10 text-[#1a1208]')}>
              {p}
            </button>
          )
        )}
        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
          className="px-2 py-1 rounded-lg text-xs font-bold hover:bg-[#cc5a16]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">›</button>
        <button onClick={() => setPage(totalPages)} disabled={page === totalPages}
          className="px-2 py-1 rounded-lg text-xs font-bold hover:bg-[#cc5a16]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">»</button>
      </div>
    </div>
  );
}

// ─── Per-tenant subdomain helpers ────────────────────────────────────────────
// Reserved subdomains that should NOT resolve to a tenant (they map to apex).
const RESERVED_TENANT_SUBS = new Set([
  'www', 'api', 'admin', 'app', 'demo', 'internal', 'support',
  'mail', 'ftp', 'blog', 'cdn', 'static', 'help', 'docs', 'auth',
  'login', 'signup', 'register', 'test', 'staging', 'dev', 'erp'
]);

// Returns the tenant slug from the current URL, or null for apex / localhost.
// Supports multiple environment layouts:
//   atithi-setu.com                       → apex (null)
//   erp.atithi-setu.com                   → "erp" is reserved → apex (null)
//   demo.atithi-setu.com                  → "demo" is reserved → apex (null)
//   manhotra-kitchen.atithi-setu.com      → tenant "manhotra-kitchen"
//   manhotra-kitchen.demo.atithi-setu.com → tenant "manhotra-kitchen" (demo env)
// Localhost dev supports ?tenant=<slug> query param for testing without DNS.
function getTenantSlug(): string | null {
  try {
    const host = window.location.hostname;

    if (host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const params = new URLSearchParams(window.location.search);
      const qp = params.get('tenant');
      return qp && !RESERVED_TENANT_SUBS.has(qp.toLowerCase()) ? qp.toLowerCase() : null;
    }

    const parts = host.split('.');
    if (parts.length < 3) return null;               // apex or single-label

    const first = parts[0].toLowerCase();
    // Reserved first segment (erp, demo, www, api, etc.) → treat as apex
    if (RESERVED_TENANT_SUBS.has(first)) return null;
    return first;
  } catch {
    return null;
  }
}

interface TenantInfo {
  slug: string;
  id: string;
  name: string;
  city?: string;
  state?: string;
  logo?: string | null;
  templateId?: string | null;
  invoice_delete_enabled?: number;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [role, setRole] = useState<UserRole | null>(localStorage.getItem('role') as UserRole);
  const [userName, setUserName] = useState<string | null>(localStorage.getItem('userName'));
  const [view, setView] = useState<'LANDING' | 'DASHBOARD' | 'AUTH'>(localStorage.getItem('token') ? 'DASHBOARD' : 'LANDING');
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [restaurantId, setRestaurantId] = useState<string | null>(localStorage.getItem('restaurantId'));
  const [authMode, setAuthMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [initialAuthRole, setInitialAuthRole] = useState<UserRole | undefined>(undefined);
  const [restaurantName, setRestaurantName] = useState<string>('RestoFlow');
  const [landingStep, setLandingStep] = useState<'OWNER' | 'ID' | 'LOGIN'>('OWNER');
  const [tempRId, setTempRId] = useState('');
  const [tempRName, setTempRName] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [loginRole, setLoginRole] = useState<UserRole>('OWNER');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // EMAIL-BASED OWNER AUTH STATE
  const [ownerAuthStep, setOwnerAuthStep] = useState<'login' | 'register' | 'restaurant' | 'forgot' | 'reset' | 'pending'>('login');
  const [ownerIdentifier, setOwnerIdentifier] = useState(''); // email or phone for login
  const [ownerPassword, setOwnerPassword] = useState('');
  const [ownerConfirmPassword, setOwnerConfirmPassword] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerRestaurantName, setOwnerRestaurantName] = useState('');
  const [ownerCity, setOwnerCity] = useState('');
  const [ownerCuisine, setOwnerCuisine] = useState('');
  const [ownerAuthError, setOwnerAuthError] = useState('');
  const [showOwnerPassword, setShowOwnerPassword] = useState(false);
  // Forgot / Reset password state
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [availableRestaurants, setAvailableRestaurants] = useState<any[]>([]);
  const [tempOwnerToken, setTempOwnerToken] = useState<string | null>(null);

  // ─── Per-tenant subdomain state ────────────────────────────────────────────
  const [tenantSlug] = useState<string | null>(() => getTenantSlug());
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [tenantLoading, setTenantLoading] = useState<boolean>(!!tenantSlug);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenantIdentifier, setTenantIdentifier] = useState('');
  // Hospitality: when ?room= is present, we render the in-room guest interface
  const [guestRoomId, setGuestRoomId] = useState<string | null>(null);
  const [tenantPassword, setTenantPassword] = useState('');
  const [tenantLoginLoading, setTenantLoginLoading] = useState(false);
  const [tenantLoginError, setTenantLoginError] = useState('');
  const [tenantForgotMode, setTenantForgotMode] = useState(false);
  const [showTenantPassword, setShowTenantPassword] = useState(false);

  // On mount: if we have a tenant slug, load its branding info.
  // Also: if the URL has ?token=... (passed from apex after owner login),
  // accept that token and clean the URL.
  useEffect(() => {
    // Accept cross-subdomain token hand-off (one-time, from apex redirect)
    try {
      const params = new URLSearchParams(window.location.search);
      const handoffToken = params.get('token');
      const handoffRole = params.get('role');
      const handoffRId = params.get('rid');
      const handoffName = params.get('uname');
      if (handoffToken) {
        localStorage.setItem('token', handoffToken);
        setToken(handoffToken);
        if (handoffRole) { localStorage.setItem('role', handoffRole); setRole(handoffRole as UserRole); }
        if (handoffRId) { localStorage.setItem('restaurantId', handoffRId); setRestaurantId(handoffRId); }
        if (handoffName) { localStorage.setItem('userName', handoffName); setUserName(handoffName); }
        setView('DASHBOARD');
        // Strip these params from the URL so they don't stay around
        params.delete('token');
        params.delete('role');
        params.delete('rid');
        params.delete('uname');
        const rest = params.toString();
        const newUrl = window.location.pathname + (rest ? `?${rest}` : '');
        window.history.replaceState({}, '', newUrl);
      }
    } catch {}

    if (!tenantSlug) return;
    setTenantLoading(true);
    fetch(`/api/tenant/by-slug/${encodeURIComponent(tenantSlug)}`)
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Restaurant not found');
        return body;
      })
      .then((data: TenantInfo) => { setTenant(data); setTenantError(null); })
      .catch((err: any) => { setTenant(null); setTenantError(err.message || 'Failed to load restaurant'); })
      .finally(() => setTenantLoading(false));
  }, [tenantSlug]);

  // Handler for the unified tenant-login form (shown on subdomain).
  const handleTenantLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant || !tenantIdentifier || !tenantPassword) return;
    setTenantLoginLoading(true);
    setTenantLoginError('');
    try {
      const res = await fetch('/api/auth/tenant-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: tenant.slug,
          identifier: tenantIdentifier.trim(),
          password: tenantPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('token', data.token);
      localStorage.setItem('role', data.role);
      localStorage.setItem('restaurantId', data.restaurantId);
      if (data.name) localStorage.setItem('userName', data.name);
      setToken(data.token);
      setRole(data.role);
      setRestaurantId(data.restaurantId);
      setUserName(data.name || null);
      setRestaurantName(data.restaurantName || tenant.name);
      setView('DASHBOARD');
    } catch (err: any) {
      setTenantLoginError(err.message || 'Login failed');
    } finally {
      setTenantLoginLoading(false);
    }
  };

  const handleTenantForgotPassword = async () => {
    setTenantLoginError('');
    if (!forgotEmail.trim()) { setTenantLoginError('Please enter your email address'); return; }
    try {
      setTenantLoginLoading(true);
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
      setForgotSent(true);
    } catch (err: any) {
      setTenantLoginError(err.message || 'Failed to send reset email');
    } finally {
      setTenantLoginLoading(false);
    }
  };

  const handleVerifyId = async () => {
    const id = tempRId.trim();
    if (!id) return;
    setIsVerifying(true);
    try {
      const res = await fetch(`/api/restaurant/${id}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || "Restaurant ID is wrong. Please check and try again.");
      }
      
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        setTempRName(data.name);
        setTempRId(data.id); // Use the canonical ID from the server
        setLandingStep('LOGIN');
      } else {
        throw new Error("Received non-JSON response from server");
      }
    } catch (err: any) {
      alert(err.message || "Error validating Restaurant ID. Please try again later.");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleUnifiedLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          loginId: loginId.trim(), 
          password: password.trim(), 
          restaurantId: tempRId, 
          role: loginRole 
        })
      });
      
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Login failed");
        
        setToken(data.token);
        setRestaurantId(data.restaurantId);
        setRole(data.role);
        setUserName(data.name);
        localStorage.setItem('token', data.token);
        localStorage.setItem('restaurantId', data.restaurantId);
        localStorage.setItem('role', data.role);
        localStorage.setItem('userName', data.name);
        setView('DASHBOARD');
      } else {
        throw new Error("Received non-JSON response from server");
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // EMAIL-BASED OWNER AUTH HANDLERS

  const handleOwnerLogin = async () => {
    setOwnerAuthError('');
    if (!ownerIdentifier.trim() || !ownerPassword) {
      setOwnerAuthError('Please enter your email (or phone) and password');
      return;
    }
    try {
      setIsLoggingIn(true);
      const res = await fetch('/api/auth/owner/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: ownerIdentifier.trim(), password: ownerPassword })
      });
      const data = await res.json();
      // Show pending screen if account awaiting approval
      if (!res.ok && data.pending) {
        setOwnerEmail(ownerIdentifier.trim());
        setOwnerAuthStep('pending');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Login failed');

      if (data.restaurants) {
        setAvailableRestaurants(data.restaurants);
        setTempOwnerToken(data.temp_token);
        setOwnerAuthStep('restaurant');
      } else {
        // If this login was on the apex and the tenant has a slug, redirect
        // the owner to their subdomain (hand-off the token in the URL).
        const host = window.location.hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
        if (data.slug && !isLocal && !tenantSlug) {
          const target = `${data.slug}.atithi-setu.com`;
          if (host !== target) {
            const params = new URLSearchParams({
              token: data.jwt_token,
              role: data.role || 'OWNER',
              rid: data.restaurant_id,
              uname: data.restaurant_name || 'Owner',
            });
            window.location.href = `https://${target}/?${params.toString()}`;
            return;
          }
        }

        setToken(data.jwt_token);
        setRestaurantId(data.restaurant_id);
        setRole(data.role || 'OWNER');
        setUserName(data.restaurant_name || 'Owner');
        localStorage.setItem('token', data.jwt_token);
        localStorage.setItem('restaurantId', data.restaurant_id);
        localStorage.setItem('role', data.role || 'OWNER');
        localStorage.setItem('userName', data.restaurant_name || 'Owner');
        setView('DASHBOARD');
      }
    } catch (err: any) {
      setOwnerAuthError(err.message || 'Login failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleForgotPassword = async () => {
    setOwnerAuthError('');
    if (!forgotEmail.trim()) { setOwnerAuthError('Please enter your email address'); return; }
    try {
      setIsLoggingIn(true);
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
      setForgotSent(true);
    } catch (err: any) {
      setOwnerAuthError(err.message || 'Failed to send reset email');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleResetPassword = async () => {
    setOwnerAuthError('');
    if (!resetNewPassword || !resetConfirmPassword) { setOwnerAuthError('Please fill in both password fields'); return; }
    if (resetNewPassword !== resetConfirmPassword) { setOwnerAuthError('Passwords do not match'); return; }
    if (resetNewPassword.length < 6) { setOwnerAuthError('Password must be at least 6 characters'); return; }
    try {
      setIsLoggingIn(true);
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: resetNewPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset password');
      setResetSuccess(true);
    } catch (err: any) {
      setOwnerAuthError(err.message || 'Failed to reset password');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleOwnerRegister = async () => {
    setOwnerAuthError('');
    if (!ownerEmail || !ownerPassword || !ownerName || !ownerRestaurantName || !ownerCity) {
      setOwnerAuthError('Please fill all required fields (marked with *)');
      return;
    }
    if (ownerPassword !== ownerConfirmPassword) {
      setOwnerAuthError('Passwords do not match');
      return;
    }
    if (ownerPassword.length < 6) {
      setOwnerAuthError('Password must be at least 6 characters');
      return;
    }
    try {
      setIsLoggingIn(true);
      const res = await fetch('/api/auth/owner/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: ownerEmail.trim(),
          phone: ownerPhone.trim() || undefined,
          password: ownerPassword,
          owner_name: ownerName.trim(),
          restaurant_name: ownerRestaurantName.trim(),
          location_city: ownerCity.trim(),
          cuisine_type: ownerCuisine || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');

      // Registration is now pending admin approval — show pending screen
      if (data.pending) {
        setOwnerAuthStep('pending');
        return;
      }
      // Fallback: if server somehow returns a token immediately, log in
      if (data.jwt_token) {
        setToken(data.jwt_token);
        setRestaurantId(data.restaurant_id);
        setRole('OWNER');
        setUserName(ownerName.trim());
        localStorage.setItem('token', data.jwt_token);
        localStorage.setItem('restaurantId', data.restaurant_id);
        localStorage.setItem('role', 'OWNER');
        localStorage.setItem('userName', ownerName.trim());
        setView('DASHBOARD');
      }
    } catch (err: any) {
      setOwnerAuthError(err.message || 'Registration failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleOwnerSelectRestaurant = async (rid: string) => {
    setOwnerAuthError('');
    try {
      setIsLoggingIn(true);
      const res = await fetch('/api/auth/owner/select-restaurant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temp_token: tempOwnerToken, restaurant_id: rid })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Selection failed');

      setToken(data.jwt_token);
      setRestaurantId(rid);
      setRole(data.role);
      setUserName(data.restaurant_name);
      localStorage.setItem('token', data.jwt_token);
      localStorage.setItem('restaurantId', rid);
      localStorage.setItem('role', data.role);
      localStorage.setItem('userName', data.restaurant_name);
      setView('DASHBOARD');
    } catch (err: any) {
      setOwnerAuthError(err.message || 'Selection failed');
    } finally {
      setIsLoggingIn(false);
    }
  };

  useEffect(() => {
    const savedRole = localStorage.getItem('role');
    const validRoles: UserRole[] = ['SUPER_ADMIN', 'OWNER', 'CHEF', 'WAITER', 'CUSTOMER', 'SALES_REP', 'CTO'];
    if (savedRole && !validRoles.includes(savedRole as UserRole)) {
      if (savedRole === 'ADMIN') {
        setRole('SUPER_ADMIN');
        localStorage.setItem('role', 'SUPER_ADMIN');
      } else {
        handleLogout();
      }
    }
  }, []);

  useEffect(() => {
    if (restaurantId && typeof restaurantId === 'string' && restaurantId !== 'null' && restaurantId !== 'undefined' && restaurantId !== '' && restaurantId !== '[object Object]') {
      fetch(`/api/restaurant/${restaurantId}`)
        .then(res => {
          if (res.status === 404) {
            return null; // Silently handle not found
          }
          if (!res.ok) throw new Error('Failed to fetch restaurant info');
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.indexOf("application/json") !== -1) {
            return res.json();
          } else {
            throw new Error('Received non-JSON response from server');
          }
        })
        .then(data => {
          if (data && data.name) {
            setRestaurantName(data.name);
          } else if (data === null) {
            // If restaurant not found, clear it
            setRestaurantId(null);
            localStorage.removeItem('restaurantId');
            setView('LANDING');
          }
        })
        .catch(err => {
          console.error("Restaurant fetch error:", err.message);
        });
    }
  }, [restaurantId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rId = params.get('r');
    const orderId = params.get('orderId');
    const resetParam = params.get('reset');
    const path = (window.location.pathname || '/').toLowerCase();

    // ─── /internal → dedicated SUPER_ADMIN / CTO / SALES_REP portal ─────
    // If the user is already logged in as an admin role, go straight to the
    // dashboard; otherwise show the AUTH form pre-scoped to SUPER_ADMIN.
    if (path === '/internal' || path === '/internal/') {
      const existingRole = localStorage.getItem('role');
      if (localStorage.getItem('token') && ['SUPER_ADMIN', 'CTO', 'SALES_REP'].includes(existingRole || '')) {
        setView('DASHBOARD');
      } else {
        setAuthMode('LOGIN');
        setInitialAuthRole('SUPER_ADMIN');
        setView('AUTH');
      }
      return;
    }

    // Password reset flow: ?reset=TOKEN
    if (resetParam) {
      setResetToken(resetParam);
      setOwnerAuthStep('reset');
      setLandingStep('OWNER');
      setView('LANDING');
      // Clean the token from URL bar without a page reload
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (rId) {
      setRestaurantId(rId);
      setRole('CUSTOMER');
      setView('DASHBOARD');
      // Hospitality: capture room ID from URL if present
      const rmId = params.get('room');
      if (rmId) setGuestRoomId(rmId);
    } else if (orderId) {
      // If we have an orderId but no rId, we might be in trouble with multi-tenancy
      // But let's try to see if we can at least show something or prompt
      const savedRId = localStorage.getItem('last_restaurant_id');
      if (savedRId) {
        setRestaurantId(savedRId);
        setRole('CUSTOMER');
        setView('DASHBOARD');
      }
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('restaurantId');
    localStorage.removeItem('role');
    localStorage.removeItem('userName');
    setToken(null);
    setRestaurantId(null);
    setRole(null);
    setUserName(null);
    setLandingStep('OWNER');
    setOwnerAuthStep('login');
    setOwnerIdentifier('');
    setOwnerPassword('');
    setOwnerConfirmPassword('');
    setOwnerAuthError('');
    setAvailableRestaurants([]);
    setTempOwnerToken(null);
    // If we're on the /internal admin portal, stay there; otherwise go to landing
    const stayOnInternal = (window.location.pathname || '').toLowerCase().replace(/\/$/, '') === '/internal';
    if (stayOnInternal) {
      setAuthMode('LOGIN');
      setInitialAuthRole('SUPER_ADMIN');
      setView('AUTH');
    } else {
      setView('LANDING');
    }
  };

  // ─── TENANT SUBDOMAIN BRANCH ───────────────────────────────────────────────
  // When the URL has a tenant slug (e.g. manhotra-kitchen.atithi-setu.com or
  // localhost?tenant=manhotra-kitchen), render the per-tenant login page —
  // unless the user already has a valid token (then fall through to dashboard).
  //
  // Exceptions that SKIP the tenant login page:
  //  • /internal → always opens the admin portal
  //  • ?r=<id>, ?table=<id>, ?room=<id>, ?orderId=<id> → customer/guest flow.
  //    These printed QR codes predate tenant subdomains; whenever present
  //    the user is a guest and must NOT see a login prompt.
  const onInternalPath = (window.location.pathname || '').toLowerCase().replace(/\/$/, '') === '/internal';
  const guestQueryParams = (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      return !!(p.get('r') || p.get('table') || p.get('room') || p.get('orderId'));
    } catch { return false; }
  })();
  // When we're on a tenant subdomain AND the URL has no ?r= parameter, the
  // tenant's own restaurantId *is* identifiable from the slug. Auto-fill it
  // so the guest isn't asked for the Restaurant ID just because they came in
  // via the clean subdomain URL `<slug>.atithi-setu.com/?table=T1`.
  const onTenantSubdomain = !!tenantSlug;
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const hasAnyGuestParam = !!(p.get('table') || p.get('room') || p.get('orderId'));
      // If we have a resolved tenant + guest intent but no ?r=, auto-set it
      if (tenant?.id && hasAnyGuestParam && !p.get('r') && !restaurantId) {
        setRestaurantId(tenant.id);
        setRole('CUSTOMER');
        setView('DASHBOARD');
        const rmId = p.get('room');
        if (rmId) setGuestRoomId(rmId);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  if (tenantSlug && !token && !onInternalPath && !guestQueryParams) {
    // Still loading tenant info
    if (tenantLoading) {
      return (
        <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 border-4 border-[#cc5a16] border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-[#6b5d52] font-medium text-sm">Loading…</p>
          </div>
        </div>
      );
    }

    // Tenant not found (bad subdomain)
    if (!tenant) {
      return (
        <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-10 text-center border-t-[3px] border-[#b8860b]">
            <div className="w-16 h-16 rounded-full bg-[#fdf0f0] flex items-center justify-center mx-auto mb-5">
              <X size={32} className="text-[#c13b3b]" />
            </div>
            <h1 className="text-2xl font-serif font-bold text-[#1a1208] mb-2">Restaurant Not Found</h1>
            <p className="text-[#6b5d52] text-sm mb-6">
              {tenantError || `No restaurant exists at "${tenantSlug}.atithi-setu.com".`}
            </p>
            <a
              href="https://atithi-setu.com"
              className="inline-block px-6 py-3 bg-[#cc5a16] text-white rounded-2xl font-semibold text-sm hover:bg-[#a84612] transition-all"
            >
              Go to Atithi Setu
            </a>
          </div>
        </div>
      );
    }

    // Render the tenant login page
    return (
      <div className="min-h-screen bg-[#faf7f2] flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Subtle background glows */}
        <div className="absolute top-[-15%] left-[-10%] w-[40%] h-[40%] bg-[#cc5a16]/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-15%] right-[-10%] w-[40%] h-[40%] bg-[#b8860b]/5 rounded-full blur-3xl pointer-events-none" />

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-md z-10"
        >
          {/* Tenant branding card */}
          <div
            className="bg-white rounded-[32px] shadow-2xl p-9 border-t-[3px] border-[#b8860b] relative overflow-hidden"
            style={{ boxShadow: '0 20px 60px rgba(26, 18, 8, 0.12), 0 4px 12px rgba(204, 90, 22, 0.06)' }}
          >
            {/* Heritage brass corner accent */}
            <div className="absolute top-0 right-0 w-24 h-24 bg-[#b8860b]/5 rounded-bl-[60px] pointer-events-none" />

            {/* Tenant header */}
            <div className="relative text-center mb-7">
              {tenant.logo ? (
                <img
                  src={tenant.logo}
                  alt={tenant.name}
                  className="w-16 h-16 mx-auto mb-4 rounded-2xl object-cover"
                />
              ) : (
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-[#cc5a16] to-[#a84612] flex items-center justify-center text-white text-2xl font-serif font-bold shadow-md">
                  {tenant.name.charAt(0).toUpperCase()}
                </div>
              )}
              <h1 className="text-3xl font-serif font-bold text-[#1a1208] leading-tight">
                {tenant.name}
              </h1>
              {/* Brass rule */}
              <div className="w-12 h-[2px] bg-[#b8860b] mx-auto my-3 rounded-full" />
              {tenant.city && (
                <p className="text-sm text-[#6b5d52]">
                  {tenant.city}{tenant.state ? `, ${tenant.state}` : ''}
                </p>
              )}
              <p className="text-[11px] uppercase tracking-[0.18em] text-[#9c8e85] font-semibold mt-4">
                Sign in to continue
              </p>
            </div>

            {/* Error banner */}
            {tenantLoginError && (
              <div className="mb-4 px-4 py-3 rounded-xl bg-[#fdf0f0] border border-[#c13b3b]/20 text-[#c13b3b] text-sm font-medium">
                {tenantLoginError}
              </div>
            )}

            {/* Login form OR Forgot-password panel */}
            {tenantForgotMode ? (
              <div className="space-y-4">
                <div className="text-center">
                  <div className="w-12 h-12 bg-[#cc5a16]/10 rounded-full flex items-center justify-center mx-auto mb-2">
                    <Mail size={22} className="text-[#cc5a16]" />
                  </div>
                  <h2 className="text-xl font-bold text-[#1a1208]">Forgot Password?</h2>
                  <p className="text-[#6b5d52] text-sm mt-1">Enter your registered email — we'll send a reset link.</p>
                </div>
                {!forgotSent ? (
                  <>
                    <input
                      type="email"
                      autoFocus
                      autoComplete="email"
                      placeholder="you@example.com"
                      className="w-full bg-[#f5efe6] border border-[#cc5a16]/10 rounded-2xl px-4 py-3 text-base text-[#1a1208] placeholder:text-[#9c8e85] focus:outline-none focus:ring-2 ring-[#cc5a16]/30 focus:border-[#cc5a16]/30 transition-all"
                      value={forgotEmail}
                      onChange={e => setForgotEmail(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleTenantForgotPassword()}
                      disabled={tenantLoginLoading}
                    />
                    <button
                      type="button"
                      onClick={handleTenantForgotPassword}
                      disabled={tenantLoginLoading || !forgotEmail.trim()}
                      className="w-full bg-[#cc5a16] hover:bg-[#a84612] text-white py-3.5 rounded-2xl font-semibold text-base transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-[#cc5a16]/20"
                    >
                      {tenantLoginLoading ? (
                        <><Clock className="animate-spin" size={18} /> Sending…</>
                      ) : (
                        <><Mail size={18} /> Send Reset Link</>
                      )}
                    </button>
                  </>
                ) : (
                  <div className="bg-green-50 border border-green-200 rounded-2xl px-5 py-4 text-center">
                    <CheckCircle2 size={28} className="text-green-500 mx-auto mb-2" />
                    <p className="font-bold text-green-700 text-sm">Reset link sent</p>
                    <p className="text-green-600 text-xs mt-1">Check your inbox at <strong>{forgotEmail}</strong>. The link expires in 1 hour.</p>
                  </div>
                )}
                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => { setTenantForgotMode(false); setForgotSent(false); setForgotEmail(''); setTenantLoginError(''); }}
                    className="text-sm text-[#cc5a16] hover:text-[#a84612] font-medium transition-colors"
                  >
                    ← Back to Login
                  </button>
                </div>
              </div>
            ) : (
              <>
                <form onSubmit={handleTenantLogin} className="space-y-4">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52] mb-2">
                      Email, phone, or staff ID
                    </label>
                    <input
                      type="text"
                      autoFocus
                      autoComplete="username"
                      placeholder="you@example.com or CHEF-001"
                      className="w-full bg-[#f5efe6] border border-[#cc5a16]/10 rounded-2xl px-4 py-3 text-base text-[#1a1208] placeholder:text-[#9c8e85] focus:outline-none focus:ring-2 ring-[#cc5a16]/30 focus:border-[#cc5a16]/30 transition-all"
                      value={tenantIdentifier}
                      onChange={e => setTenantIdentifier(e.target.value)}
                      disabled={tenantLoginLoading}
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wide text-[#6b5d52] mb-2">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showTenantPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        className="w-full bg-[#f5efe6] border border-[#cc5a16]/10 rounded-2xl px-4 py-3 pr-12 text-base text-[#1a1208] placeholder:text-[#9c8e85] focus:outline-none focus:ring-2 ring-[#cc5a16]/30 focus:border-[#cc5a16]/30 transition-all"
                        value={tenantPassword}
                        onChange={e => setTenantPassword(e.target.value)}
                        disabled={tenantLoginLoading}
                      />
                      <button
                        type="button"
                        onClick={() => setShowTenantPassword(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9c8e85] hover:text-[#1a1208] transition-colors p-1"
                        tabIndex={-1}
                      >
                        {showTenantPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={tenantLoginLoading || !tenantIdentifier || !tenantPassword}
                    className="w-full bg-[#cc5a16] hover:bg-[#a84612] text-white py-3.5 rounded-2xl font-semibold text-base transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md shadow-[#cc5a16]/20"
                  >
                    {tenantLoginLoading ? (
                      <>
                        <Clock className="animate-spin" size={18} /> Signing in…
                      </>
                    ) : (
                      <>Sign In <ChevronRight size={18} /></>
                    )}
                  </button>
                </form>

                {/* Forgot password link */}
                <div className="mt-5 text-center">
                  <button
                    type="button"
                    onClick={() => { setTenantForgotMode(true); setForgotSent(false); setForgotEmail(tenantIdentifier.includes('@') ? tenantIdentifier : ''); setTenantLoginError(''); }}
                    className="text-sm text-[#cc5a16] hover:text-[#a84612] font-medium transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
              </>
            )}

            {/* Role hint */}
            <div className="mt-6 pt-5 border-t border-[#cc5a16]/10">
              <p className="text-[11px] text-[#9c8e85] text-center leading-relaxed">
                One login for owners, managers, chefs &amp; waiters.
              </p>
            </div>
          </div>

          {/* Footer */}
          <p className="text-center text-[11px] text-[#9c8e85] mt-6 tracking-wide">
            Powered by{' '}
            <a href="https://atithi-setu.com" className="text-[#cc5a16] hover:text-[#a84612] font-semibold">
              Atithi Setu™
            </a>
          </p>
        </motion.div>
      </div>
    );
  }

  if (view === 'LANDING') {
    return (
      <div className="min-h-screen bg-[#faf7f2] flex flex-col items-center justify-center p-6 font-serif overflow-hidden relative">
        {/* Background decorative elements */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#cc5a16]/5 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#cc5a16]/5 rounded-full blur-3xl" />

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-xl z-10"
        >
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#cc5a16]/10 text-[#1a1208] text-xs font-bold uppercase tracking-widest mb-6">
              <Star size={14} /> The Future of Restaurant Management
            </div>
            <h1 className="text-5xl font-bold text-[#1a1a1a] mb-1 tracking-tight uppercase">Atithi Setu</h1>
            <p className="text-xs text-[#3d3128] font-semibold tracking-wide mb-1">SaaS by Manhotra Consulting</p>
            <a href="https://atithi-setu.com/" target="_blank" rel="noopener noreferrer"
              className="text-xs text-[#a84612] hover:underline font-semibold">www.Atithi-Setu.com</a>
            <p className="text-lg text-[#1a1208] leading-relaxed mt-4 font-medium">
              Seamless multi-tenant operations, real-time analytics, and effortless customer experiences.
            </p>
          </div>

          <div className="bg-white p-10 rounded-[32px] shadow-2xl border border-[#cc5a16]/10 relative overflow-hidden">
            <AnimatePresence mode="wait">
              {/* ── STEP: OWNER LOGIN / REGISTER (primary entry point) ── */}
              {landingStep === 'OWNER' ? (
                <motion.div
                  key="owner-step"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  {/* ── LOGIN FORM ── */}
                  {ownerAuthStep === 'login' && (
                    <>
                      <div className="text-center">
                        <h2 className="text-3xl font-bold mb-1">Owner Login</h2>
                        <p className="text-[#3d3128] text-sm">Sign in with your email or mobile number</p>
                      </div>
                      <div className="space-y-3">
                        <input
                          type="text"
                          autoFocus
                          placeholder="Email or Mobile Number *"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base text-[#1a1208] placeholder:text-[#6b5d52] focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerIdentifier}
                          onChange={e => setOwnerIdentifier(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleOwnerLogin()}
                        />
                        <div className="relative">
                          <input
                            type={showOwnerPassword ? 'text' : 'password'}
                            placeholder="Password *"
                            className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 pr-14 text-base text-[#1a1208] placeholder:text-[#6b5d52] focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                            value={ownerPassword}
                            onChange={e => setOwnerPassword(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleOwnerLogin()}
                          />
                          <button type="button" onClick={() => setShowOwnerPassword(p => !p)}
                            className="absolute right-4 top-1/2 -translate-y-1/2 text-[#6b5d52] hover:text-[#1a1208] transition-colors">
                            {showOwnerPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                        {ownerAuthError && (
                          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{ownerAuthError}</div>
                        )}
                        <button
                          onClick={handleOwnerLogin}
                          disabled={isLoggingIn}
                          className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                          {isLoggingIn ? <><Clock className="animate-spin" size={18} /> Signing in...</> : <>Sign In <ChevronRight size={18} /></>}
                        </button>
                        <div className="text-right">
                          <button
                            type="button"
                            onClick={() => { setOwnerAuthStep('forgot'); setOwnerAuthError(''); setForgotEmail(''); setForgotSent(false); }}
                            className="text-xs text-[#a84612] font-semibold hover:text-[#cc5a16] hover:underline transition-colors"
                          >
                            Forgot password?
                          </button>
                        </div>
                      </div>
                      <div className="pt-3 border-t border-[#cc5a16]/10 text-center space-y-2">
                        <p className="text-sm text-[#3d3128]">
                          New to AtithiSetu?{' '}
                          <button onClick={() => { setOwnerAuthStep('register'); setOwnerAuthError(''); }}
                            className="text-[#a84612] font-bold hover:underline">Register your restaurant</button>
                        </p>
                        <p className="text-xs text-[#6b5d52]">
                          Chef / Waiter?{' '}
                          <button onClick={() => setLandingStep('ID')} className="text-[#3d3128] hover:text-[#cc5a16] font-semibold hover:underline transition-colors">Use Staff Login</button>
                        </p>
                      </div>
                    </>
                  )}

                  {/* ── REGISTER FORM ── */}
                  {ownerAuthStep === 'register' && (
                    <>
                      <div className="text-center">
                        <button onClick={() => { setOwnerAuthStep('login'); setOwnerAuthError(''); }}
                          className="text-[#9c8e85] text-xs hover:text-[#cc5a16] transition-colors mb-3 flex items-center gap-1 mx-auto">
                          <ChevronRight size={12} className="rotate-180" /> Back to Login
                        </button>
                        <h2 className="text-2xl font-bold mb-1">Register Your Restaurant</h2>
                        <p className="text-[#6b5d52] text-sm">Get started in under 2 minutes</p>
                      </div>
                      <div className="space-y-3">
                        <input type="email" placeholder="Email Address *" autoFocus
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} />
                        <input type="tel" placeholder="Mobile Number (optional)"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerPhone} onChange={e => setOwnerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
                        <div className="relative">
                          <input type={showOwnerPassword ? 'text' : 'password'} placeholder="Password * (min 6 chars)"
                            className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 pr-14 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                            value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} />
                          <button type="button" onClick={() => setShowOwnerPassword(p => !p)}
                            className="absolute right-4 top-1/2 -translate-y-1/2 text-[#9c8e85] hover:text-[#1a1208] transition-colors">
                            {showOwnerPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                        <input type="password" placeholder="Confirm Password *"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerConfirmPassword} onChange={e => setOwnerConfirmPassword(e.target.value)} />
                        <div className="w-full h-px bg-[#cc5a16]/10" />
                        <input type="text" placeholder="Your Full Name *"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerName} onChange={e => setOwnerName(e.target.value)} />
                        <input type="text" placeholder="Restaurant Name *"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerRestaurantName} onChange={e => setOwnerRestaurantName(e.target.value)} />
                        <input type="text" placeholder="City *"
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                          value={ownerCity} onChange={e => setOwnerCity(e.target.value)} />
                        <select className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none appearance-none font-sans text-[#6b5d52]"
                          value={ownerCuisine} onChange={e => setOwnerCuisine(e.target.value)}>
                          <option value="">Cuisine Type (optional)</option>
                          <option>North Indian</option><option>South Indian</option><option>Chinese</option>
                          <option>Continental</option><option>Fast Food</option><option>Cafe</option><option>Other</option>
                        </select>
                        {ownerAuthError && (
                          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{ownerAuthError}</div>
                        )}
                        <button onClick={handleOwnerRegister} disabled={isLoggingIn}
                          className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
                          {isLoggingIn ? <><Clock className="animate-spin" size={18} /> Creating account...</> : <>Create Account & Get Started <ChevronRight size={18} /></>}
                        </button>
                      </div>
                    </>
                  )}

                  {/* ── PENDING APPROVAL SCREEN ── */}
                  {ownerAuthStep === 'pending' && (
                    <div className="text-center space-y-5">
                      <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
                        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                      </div>
                      <div>
                        <h2 className="text-2xl font-bold mb-2">Registration Submitted!</h2>
                        <p className="text-[#6b5d52] text-sm leading-relaxed">
                          Your restaurant registration is under review. Our team will activate your account within <strong>24 hours</strong>.
                        </p>
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-left space-y-2">
                        <p className="text-sm font-semibold text-amber-800">What happens next?</p>
                        <ul className="text-sm text-amber-700 space-y-1">
                          <li className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">✓</span> A confirmation email has been sent to <strong>{ownerEmail}</strong></li>
                          <li className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">✓</span> Our team will review and approve your account</li>
                          <li className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">✓</span> You'll receive an approval email once activated</li>
                          <li className="flex items-start gap-2"><span className="text-amber-500 mt-0.5">✓</span> Log in using your registered email & password</li>
                        </ul>
                      </div>
                      <button
                        onClick={() => { setOwnerAuthStep('login'); setOwnerAuthError(''); setOwnerPassword(''); setOwnerConfirmPassword(''); }}
                        className="w-full bg-[#0d0a07]/8 text-[#3d3128] py-3 rounded-2xl font-semibold text-sm hover:bg-[#0d0a07]/12 transition-all">
                        Back to Login
                      </button>
                    </div>
                  )}

                  {/* ── FORGOT PASSWORD ── */}
                  {ownerAuthStep === 'forgot' && (
                    <>
                      <div className="text-center">
                        <button onClick={() => { setOwnerAuthStep('login'); setOwnerAuthError(''); }}
                          className="text-[#9c8e85] text-xs hover:text-[#cc5a16] transition-colors mb-3 flex items-center gap-1 mx-auto">
                          <ChevronRight size={12} className="rotate-180" /> Back to Login
                        </button>
                        <div className="w-14 h-14 bg-[#cc5a16]/10 rounded-full flex items-center justify-center mx-auto mb-3">
                          <Mail size={26} className="text-[#cc5a16]" />
                        </div>
                        <h2 className="text-2xl font-bold mb-1">Forgot Password?</h2>
                        <p className="text-[#6b5d52] text-sm">Enter your registered email and we'll send you a reset link</p>
                      </div>
                      {!forgotSent ? (
                        <div className="space-y-3">
                          <input
                            type="email"
                            autoFocus
                            placeholder="Your registered email *"
                            className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                            value={forgotEmail}
                            onChange={e => setForgotEmail(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleForgotPassword()}
                          />
                          {ownerAuthError && (
                            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{ownerAuthError}</div>
                          )}
                          <button
                            onClick={handleForgotPassword}
                            disabled={isLoggingIn}
                            className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                          >
                            {isLoggingIn ? <><Clock className="animate-spin" size={18} /> Sending...</> : <><Mail size={18} /> Send Reset Link</>}
                          </button>
                        </div>
                      ) : (
                        <div className="text-center space-y-4">
                          <div className="bg-green-50 border border-green-200 rounded-2xl px-6 py-5">
                            <CheckCircle2 size={32} className="text-green-500 mx-auto mb-2" />
                            <p className="font-bold text-green-700 text-sm">Reset link sent!</p>
                            <p className="text-green-600 text-xs mt-1">Check your inbox at <strong>{forgotEmail}</strong>. The link expires in 1 hour.</p>
                          </div>
                          <button onClick={() => { setOwnerAuthStep('login'); setOwnerAuthError(''); setForgotSent(false); }}
                            className="text-sm text-[#cc5a16] hover:underline font-semibold">
                            Back to Login
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── RESET PASSWORD ── */}
                  {ownerAuthStep === 'reset' && (
                    <>
                      <div className="text-center">
                        <div className="w-14 h-14 bg-[#cc5a16]/10 rounded-full flex items-center justify-center mx-auto mb-3">
                          <Lock size={26} className="text-[#cc5a16]" />
                        </div>
                        <h2 className="text-2xl font-bold mb-1">Set New Password</h2>
                        <p className="text-[#6b5d52] text-sm">Choose a strong password for your account</p>
                      </div>
                      {!resetSuccess ? (
                        <div className="space-y-3">
                          <div className="relative">
                            <input
                              type={showResetPassword ? 'text' : 'password'}
                              placeholder="New Password *"
                              autoFocus
                              className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 pr-14 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                              value={resetNewPassword}
                              onChange={e => setResetNewPassword(e.target.value)}
                            />
                            <button type="button" onClick={() => setShowResetPassword(p => !p)}
                              className="absolute right-4 top-1/2 -translate-y-1/2 text-[#9c8e85] hover:text-[#1a1208] transition-colors">
                              {showResetPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                            </button>
                          </div>
                          <input
                            type={showResetPassword ? 'text' : 'password'}
                            placeholder="Confirm New Password *"
                            className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                            value={resetConfirmPassword}
                            onChange={e => setResetConfirmPassword(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleResetPassword()}
                          />
                          {ownerAuthError && (
                            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{ownerAuthError}</div>
                          )}
                          <button
                            onClick={handleResetPassword}
                            disabled={isLoggingIn}
                            className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                          >
                            {isLoggingIn ? <><Clock className="animate-spin" size={18} /> Saving...</> : <><Lock size={18} /> Set New Password</>}
                          </button>
                        </div>
                      ) : (
                        <div className="text-center space-y-4">
                          <div className="bg-green-50 border border-green-200 rounded-2xl px-6 py-5">
                            <CheckCircle2 size={32} className="text-green-500 mx-auto mb-2" />
                            <p className="font-bold text-green-700 text-sm">Password updated!</p>
                            <p className="text-green-600 text-xs mt-1">Your password has been changed successfully.</p>
                          </div>
                          <button
                            onClick={() => { setOwnerAuthStep('login'); setOwnerAuthError(''); setResetSuccess(false); setResetNewPassword(''); setResetConfirmPassword(''); }}
                            className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg flex items-center justify-center gap-2"
                          >
                            Sign In Now <ChevronRight size={18} />
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* ── RESTAURANT SELECTOR (multi-restaurant owners) ── */}
                  {ownerAuthStep === 'restaurant' && (
                    <>
                      <div className="text-center">
                        <h2 className="text-2xl font-bold mb-1">Select Restaurant</h2>
                        <p className="text-[#6b5d52] text-sm">Which location would you like to manage?</p>
                      </div>
                      <div className="space-y-3 max-h-80 overflow-y-auto">
                        {availableRestaurants.map((rest: any) => (
                          <button key={rest.restaurant_id} type="button"
                            onClick={() => handleOwnerSelectRestaurant(rest.restaurant_id)}
                            disabled={isLoggingIn}
                            className="w-full p-4 rounded-2xl border-2 border-[#cc5a16]/20 hover:border-[#cc5a16] hover:bg-[#faf7f2] transition-all text-left disabled:opacity-50 group">
                            <div className="font-bold text-[#1a1208] group-hover:text-[#cc5a16] transition-colors">{rest.restaurant_name}</div>
                            <div className="text-sm text-[#6b5d52]">{rest.location_city} · {rest.role}</div>
                          </button>
                        ))}
                      </div>
                      {ownerAuthError && (
                        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{ownerAuthError}</div>
                      )}
                    </>
                  )}
                </motion.div>
              ) : landingStep === 'ID' ? (
                <motion.div
                  key="id-step"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center">
                    <button onClick={() => setLandingStep('OWNER')} className="text-[#9c8e85] text-sm hover:text-[#cc5a16] transition-colors mb-4 flex items-center gap-1 mx-auto">
                      <ChevronRight size={14} className="rotate-180" /> Back to Owner Login
                    </button>
                    <h2 className="text-3xl font-bold mb-2">Staff Login</h2>
                    <p className="text-[#6b5d52] text-sm">Enter your Restaurant ID then use your numeric credentials.</p>
                  </div>

                  <div className="space-y-4">
                    <div className="relative">
                      <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={20} />
                      <input 
                        type="text"
                        placeholder="e.g. resto-1"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl pl-14 pr-6 py-5 text-xl font-mono focus:ring-2 ring-[#cc5a16]/20 outline-none transition-all"
                        value={tempRId}
                        onChange={e => setTempRId(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !isVerifying && handleVerifyId()}
                      />
                    </div>
                    <button 
                      onClick={handleVerifyId}
                      disabled={!tempRId || isVerifying}
                      className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold text-lg hover:bg-[#a84612] transition-all shadow-lg shadow-[#5A5A40]/20 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isVerifying ? (
                        <>
                          <Clock className="animate-spin" size={20} /> Verifying...
                        </>
                      ) : (
                        <>Verify ID <ChevronRight size={20} /></>
                      )}
                    </button>
                  </div>

                  <div className="pt-6 border-t border-[#cc5a16]/10 flex flex-col gap-4">
                    <div className="flex items-center justify-between text-sm">
                      <button 
                        onClick={() => {
                          setAuthMode('REGISTER');
                          setView('AUTH');
                        }}
                        className="text-[#1a1208] font-bold hover:underline"
                      >
                        Register New Business
                      </button>
                      <button
                        onClick={() => {
                          setAuthMode('LOGIN');
                          setInitialAuthRole('SUPER_ADMIN');
                          setView('AUTH');
                        }}
                        className="text-[#6b5d52] hover:text-[#1a1208] transition-colors flex items-center gap-1"
                        title="Login as SUPER_ADMIN / CTO / SALES_REP"
                      >
                        <ShieldCheck size={14} /> Internal Portal
                      </button>
                    </div>
                    <p className="text-[11px] text-[#9c8e85] text-center uppercase tracking-widest">
                      Use "resto-1" for demo access
                    </p>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="login-step"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setLandingStep('ID')}
                      className="text-[#6b5d52] hover:text-[#1a1208] flex items-center gap-1 text-sm transition-colors"
                    >
                      <ChevronRight className="rotate-180" size={16} /> Change ID
                    </button>
                    <div className="text-right">
                      <h2 className="text-xl font-bold">{tempRName}</h2>
                      <p className="text-[#6b5d52] text-xs font-mono uppercase tracking-widest">{tempRId}</p>
                    </div>
                  </div>

                  <div className="text-center">
                    <h3 className="text-2xl font-bold mb-1">Staff Login</h3>
                    <p className="text-[#6b5d52] text-sm">Enter your credentials to continue</p>
                  </div>

                  <form onSubmit={handleUnifiedLogin} className="space-y-4">
                    <input
                      type="text"
                      autoFocus
                      placeholder="Staff ID (e.g. CHEF-001)"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base font-mono focus:ring-2 ring-[#cc5a16]/30 outline-none"
                      value={loginId}
                      onChange={e => setLoginId(e.target.value)}
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-5 py-4 text-base focus:ring-2 ring-[#cc5a16]/30 outline-none font-sans"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                    />
                    <button
                      type="submit"
                      disabled={isLoggingIn || !loginId || !password}
                      className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold text-base hover:bg-[#a84612] transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {isLoggingIn ? <><Clock className="animate-spin" size={18} /> Signing in...</> : <>Sign In <ChevronRight size={18} /></>}
                    </button>
                  </form>

                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-12 text-center text-[#6b5d52] text-xs space-y-0.5">
            <div>&copy; {new Date().getFullYear()} Atithi Setu — SaaS by Manhotra Consulting</div>
            <div>
              <a href="https://atithi-setu.com/" target="_blank" rel="noopener noreferrer"
                className="text-[#a84612] font-semibold hover:text-[#cc5a16] transition-colors">
                www.Atithi-Setu.com
              </a>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  if (view === 'AUTH') {
    return (
      <AuthView 
        mode={authMode} 
        initialRole={initialAuthRole}
        onSuccess={(t, r, role, name) => {
          setToken(t);
          setRestaurantId(r);
          setRole(role);
          setUserName(name);
          localStorage.setItem('token', t);
          localStorage.setItem('restaurantId', r);
          localStorage.setItem('last_restaurant_id', r);
          localStorage.setItem('role', role);
          localStorage.setItem('userName', name);
          setView('DASHBOARD');
        }}
        onSwitch={() => setAuthMode(prev => prev === 'LOGIN' ? 'REGISTER' : 'LOGIN')}
        onBack={() => setView('LANDING')}
      />
    );
  }

  if (!restaurantId && !['SUPER_ADMIN', 'CTO', 'SALES_REP'].includes(role as string) && role !== null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#faf7f2]">
        <div className="bg-white p-12 rounded-[32px] shadow-xl border border-[#cc5a16]/10 max-w-xl text-center">
          <div className="w-20 h-20 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <X size={40} />
          </div>
          <h2 className="text-3xl font-bold font-serif mb-4">Access Denied</h2>
          <p className="text-[#6b5d52] mb-8">A valid Restaurant ID is required to access this interface. If you are an administrator, please ensure you are logged in with the correct role.</p>
          <button 
            onClick={() => {
              handleLogout();
              setView('LANDING');
            }} 
            className="bg-[#cc5a16] text-white px-8 py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7f2]">
      <nav className="bg-white border-b border-[#cc5a16]/10 px-3 py-3 sm:px-4 sm:py-4 md:px-6 flex justify-between items-center sticky top-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('LANDING')}>
          <Utensils className="w-5 h-5 md:w-6 md:h-6 text-[#1a1208] shrink-0" />
          <span className="text-base md:text-xl font-bold font-serif text-[#1a1a1a] truncate max-w-[140px] sm:max-w-xs md:max-w-none">
            {role === 'SUPER_ADMIN' ? 'RestoFlow ERP Admin' : restaurantName}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-xs font-bold uppercase tracking-wider text-[#1a1208]">
              {userName}
            </span>
            <span className="text-[11px] text-[#6b5d52] uppercase tracking-widest">
              {role} {restaurantId && `| ${restaurantId}`}
            </span>
          </div>
          <div className="h-8 w-px bg-[#cc5a16]/10 mx-2" />
          <button 
            onClick={handleLogout}
            className="bg-red-50 text-red-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-red-100 transition-colors"
          >
            <LogOut size={16} /> <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-3 sm:p-4 md:p-6 xl:p-8">
        {role === 'SUPER_ADMIN' && <SuperAdminDashboard token={token!} />}
        {role === 'CTO' && <CTODashboard token={token!} />}
        {role === 'SALES_REP' && <SalesRepresentativeDashboard token={token!} />}
        {(role === 'OWNER' || role === 'MANAGER') && (
          <OwnerDashboard
            restaurantId={restaurantId!}
            token={token!}
            onRestaurantUpdate={(name) => setRestaurantName(name)}
          />
        )}
        {role === 'CHEF' && <ChefDashboard restaurantId={restaurantId!} token={token!} />}
        {role === 'WAITER' && <WaiterDashboard restaurantId={restaurantId!} token={token!} />}
        {/* Hospitality: if URL has ?room=, render the in-room guest UI;
            otherwise render the classic restaurant customer UI. */}
        {role === 'CUSTOMER' && (
          guestRoomId
            ? <RoomGuestInterface restaurantId={restaurantId!} roomId={guestRoomId} />
            : <CustomerInterface restaurantId={restaurantId!} />
        )}
      </main>
    </div>
  );
}

const INDIAN_STATES: Record<string, string[]> = {
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Kurnool"],
  "Arunachal Pradesh": ["Itanagar", "Naharlagun", "Pasighat"],
  "Assam": ["Guwahati", "Silchar", "Dibrugarh", "Jorhat", "Nagaon"],
  "Bihar": ["Patna", "Gaya", "Bhagalpur", "Muzaffarpur", "Purnia"],
  "Chhattisgarh": ["Raipur", "Bhilai", "Bilaspur", "Korba", "Rajnandgaon"],
  "Goa": ["Panaji", "Margao", "Vasco da Gama", "Mapusa"],
  "Gujarat": ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar"],
  "Haryana": ["Faridabad", "Gurgaon", "Panipat", "Ambala", "Yamunanagar"],
  "Himachal Pradesh": ["Shimla", "Dharamshala", "Solan", "Mandi"],
  "Jharkhand": ["Jamshedpur", "Dhanbad", "Ranchi", "Bokaro", "Deoghar"],
  "Karnataka": ["Bangalore", "Hubli", "Mysore", "Gulbarga", "Belgaum"],
  "Kerala": ["Thiruvananthapuram", "Kochi", "Kozhikode", "Kollam", "Thrissur"],
  "Madhya Pradesh": ["Indore", "Bhopal", "Jabalpur", "Gwalior", "Ujjain"],
  "Maharashtra": ["Mumbai", "Pune", "Nagpur", "Thane", "Pimpri-Chinchwad"],
  "Manipur": ["Imphal", "Thoubal", "Bishnupur"],
  "Meghalaya": ["Shillong", "Tura", "Jowai"],
  "Mizoram": ["Aizawl", "Lunglei", "Saiha"],
  "Nagaland": ["Dimapur", "Kohima", "Tuensang"],
  "Odisha": ["Bhubaneswar", "Cuttack", "Rourkela", "Berhampur", "Sambalpur"],
  "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda", "Pathankot", "Dinanagar", "Gurdaspur", "Batala"],
  "Rajasthan": ["Jaipur", "Jodhpur", "Kota", "Bikaner", "Ajmer"],
  "Sikkim": ["Gangtok", "Namchi", "Geyzing"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli", "Salem"],
  "Telangana": ["Hyderabad", "Warangal", "Nizamabad", "Karimnagar", "Ramagundam"],
  "Tripura": ["Agartala", "Udaipur", "Dharmanagar"],
  "Uttar Pradesh": ["Lucknow", "Kanpur", "Ghaziabad", "Agra", "Meerut"],
  "Uttarakhand": ["Dehradun", "Haridwar", "Roorkee", "Haldwani"],
  "West Bengal": ["Kolkata", "Howrah", "Asansol", "Siliguri", "Durgapur"],
  "Delhi": ["New Delhi", "North Delhi", "South Delhi", "East Delhi", "West Delhi"]
};

function AuthView({ mode, onSuccess, onSwitch, onBack, initialRole }: { mode: 'LOGIN' | 'REGISTER', onSuccess: (token: string, rId: string, role: UserRole, name: string) => void, onSwitch: () => void, onBack: () => void, initialRole?: UserRole }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [restaurantName, setRestaurantName] = useState('');
  const [salesRepId, setSalesRepId] = useState('');
  const [selectedRole, setSelectedRole] = useState<UserRole>(initialRole || 'OWNER');
  const [selectedRestaurantId, setSelectedRestaurantId] = useState('');
  const [restaurants, setRestaurants] = useState<{id: string, name: string}[]>([]);
  const [loading, setLoading] = useState(false);
  const [registrationResult, setRegistrationResult] = useState<{ loginId: string, password: string, restaurantId: string, emailSent?: boolean } | null>(null);
  const [salesReps, setSalesReps] = useState<{id: string, name: string}[]>([]);
  const [locationData, setLocationData] = useState<Record<string, string[]>>(INDIAN_STATES);

  useEffect(() => {
    if (initialRole) setSelectedRole(initialRole);
    if (initialRole === 'SUPER_ADMIN') setSelectedRestaurantId('SYSTEM');
  }, [initialRole]);

  useEffect(() => {
    if (selectedRole === 'SUPER_ADMIN' || selectedRole === 'CTO' || selectedRole === 'SALES_REP') {
      setSelectedRestaurantId('SYSTEM');
    }
  }, [selectedRole]);

  useEffect(() => {
    if (mode === 'LOGIN') {
      fetch('/api/public/restaurants')
        .then(res => {
          if (!res.ok) return [];
          return res.json();
        })
        .then(data => {
          setRestaurants(data);
          if (data && data.length > 0) setSelectedRestaurantId(data[0].id);
        })
        .catch(err => console.error("Error fetching public restaurants:", err));
    } else {
      fetch('/api/public/sales-reps')
        .then(res => res.ok ? res.json() : [])
        .then(data => setSalesReps(Array.isArray(data) ? data : []))
        .catch(err => console.error("Error fetching sales reps:", err));
      // Fetch locations from DB (falls back to hardcoded INDIAN_STATES if API fails)
      fetch('/api/locations')
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data && Object.keys(data).length > 0) setLocationData(data); })
        .catch(() => {}); // silent fallback to INDIAN_STATES
    }
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = mode === 'LOGIN' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'LOGIN' 
        ? { loginId: loginId.trim(), password: password.trim(), restaurantId: selectedRestaurantId, role: selectedRole } 
        : { email, restaurantName, name, password, phone, state, city, sales_rep_id: salesRepId };
        
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Action failed");
        
        if (mode === 'REGISTER') {
          setRegistrationResult({ loginId: data.loginId, password: password, restaurantId: data.restaurantId, emailSent: data.emailSent });
        } else {
          onSuccess(data.token, data.restaurantId, data.role, data.name);
        }
      } else {
        throw new Error("Received non-JSON response from server");
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (registrationResult) {
    return (
      <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-10 rounded-[32px] shadow-xl border border-[#cc5a16]/10 w-full max-w-md text-center"
        >
          <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={40} />
          </div>
          <h2 className="text-3xl font-bold font-serif mb-2">Registration Successful!</h2>
          <p className="text-[#6b5d52] mb-4">Your business has been registered and is pending activation by the Admin. Please save your login credentials.</p>
          {registrationResult?.emailSent === true && (
            <div className="flex items-center justify-center gap-2 bg-green-50 text-green-700 border border-green-200 rounded-2xl px-4 py-2 mb-4 text-sm font-medium">
              <CheckCircle2 size={16} /> Welcome email with credentials sent to your inbox.
            </div>
          )}
          {registrationResult?.emailSent === false && (
            <div className="flex items-center justify-center gap-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-2xl px-4 py-2 mb-4 text-sm font-medium">
              <span>⚠️</span> Email could not be sent — please save the credentials below manually.
            </div>
          )}
          
          <div className="bg-[#faf7f2] p-6 rounded-3xl space-y-4 mb-8 text-left">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Restaurant ID (Required for Login)</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-emerald-500/30 text-emerald-700 select-all">
                {registrationResult.restaurantId}
              </div>
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Login ID</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-[#cc5a16]/10 select-all">
                {registrationResult.loginId}
              </div>
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Password</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-[#cc5a16]/10 select-all">
                {registrationResult.password}
              </div>
            </div>
          </div>
          
          <button 
            onClick={() => {
              setRegistrationResult(null);
              onBack(); // Redirect to landing page
            }}
            className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold hover:bg-[#a84612] transition-all"
          >
            Close
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white p-10 rounded-[32px] shadow-xl border border-[#cc5a16]/10 w-full max-w-2xl"
      >
        <button onClick={onBack} className="text-[#6b5d52] hover:text-[#1a1208] mb-8 flex items-center gap-1 text-sm">
          <ChevronRight className="rotate-180" size={16} /> Back
        </button>
        <h2 className="text-4xl font-bold font-serif mb-2">{mode === 'LOGIN' ? 'Welcome Back' : 'Business Registration'}</h2>
        <p className="text-[#6b5d52] mb-8">{mode === 'LOGIN' ? 'Login to manage your restaurant.' : 'Register your business and we will generate your credentials.'}</p>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === 'REGISTER' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Business Name</label>
                <div className="relative">
                  <Utensils className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="The Gourmet Kitchen"
                    value={restaurantName}
                    onChange={e => setRestaurantName(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Business Owner Name</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="John Doe"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Owner Phone Number</label>
                <div className="relative">
                  <Star className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    type="tel"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Owner Email ID</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    type="email"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="owner@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Business State</label>
                <select 
                  required
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none appearance-none"
                  value={state}
                  onChange={e => {
                    setState(e.target.value);
                    setCity('');
                  }}
                >
                  <option value="">Select State</option>
                  {Object.keys(locationData).sort().map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Business City</label>
                <select 
                  required
                  disabled={!state}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none appearance-none disabled:opacity-50"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                >
                  <option value="">Select City</option>
                  {state && (locationData[state] || []).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Desired Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    type="password"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Sales Representative (Optional)</label>
                <div className="relative">
                  <UserCheck className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <select 
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none appearance-none"
                    value={salesRepId}
                    onChange={e => setSalesRepId(e.target.value)}
                  >
                    <option value="">Select Sales Representative</option>
                    {salesReps.map(sr => (
                      <option key={sr.id} value={sr.id}>{sr.name} ({sr.id})</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-md mx-auto space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Role</label>
                <select 
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none appearance-none"
                  value={selectedRole}
                  onChange={e => setSelectedRole(e.target.value as UserRole)}
                >
                  <option value="OWNER">Business Owner</option>
                  <option value="CHEF">Chef</option>
                  <option value="WAITER">Waiter / Attender</option>
                  <option value="SUPER_ADMIN">ERP Admin</option>
                  <option value="CTO">CTO</option>
                  <option value="SALES_REP">Sales Representative</option>
                </select>
              </div>

              {!['SUPER_ADMIN', 'CTO', 'SALES_REP'].includes(selectedRole) && (
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Business / Restaurant</label>
                  <select 
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none appearance-none"
                    value={selectedRestaurantId}
                    onChange={e => setSelectedRestaurantId(e.target.value)}
                  >
                    {restaurants.map(r => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Login ID</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="OWNER-XXXX"
                    value={loginId}
                    onChange={e => setLoginId(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={18} />
                  <input 
                    required
                    type="password"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
          <div className="max-w-md mx-auto">
            <button 
              disabled={loading}
              type="submit"
              className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold hover:bg-[#a84612] transition-all shadow-lg shadow-[#5A5A40]/20 disabled:opacity-50"
            >
              {loading ? 'Processing...' : mode === 'LOGIN' ? 'Login Dashboard' : 'Register Business'}
            </button>
          </div>
        </form>
        
        <div className="mt-8 text-center">
          <button onClick={onSwitch} className="text-sm text-[#1a1208] hover:underline">
            {mode === 'LOGIN' ? "Don't have an account? Register Business" : "Already have an account? Login"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function RoleCard({ icon, title, description, onClick }: { icon: React.ReactNode, title: string, description: string, onClick: () => void }) {
  return (
    <motion.button
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="bg-white p-8 rounded-[32px] shadow-sm border border-[#cc5a16]/10 text-left hover:shadow-md transition-all group"
    >
      <div className="w-12 h-12 rounded-2xl bg-[#cc5a16]/10 flex items-center justify-center text-[#1a1208] mb-6 group-hover:bg-[#cc5a16] group-hover:text-white transition-colors">
        {icon}
      </div>
      <h3 className="text-2xl font-bold text-[#1a1a1a] mb-2 font-serif">{title}</h3>
      <p className="text-sm text-[#3d3128] leading-relaxed">{description}</p>
    </motion.button>
  );
}

const getDaysInMonth = (monthStr: string) => {
  const [year, month] = monthStr.split('-').map(Number);
  const date = new Date(year, month - 1, 1);
  const days = [];
  while (date.getMonth() === month - 1) {
    days.push(new Date(date).toISOString().slice(0, 10));
    date.setDate(date.getDate() + 1);
  }
  return days;
};

function AttendanceManagement({ role, token, restaurantId }: { role: UserRole, token: string, restaurantId: string }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [hours, setHours] = useState('8');
  const [type, setType] = useState('WORK');
  const [note, setNote] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [staffList, setStaffList] = useState<any[]>([]);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    fetchLogs();
    fetchUser();
    if (role === 'OWNER') {
      fetchStats();
      fetchStaff();
    }
  }, [month, role]);

  const fetchUser = async () => {
    try {
      const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        setUser(data);
        if (data.default_hours) setHours(data.default_hours.toString());
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(`/api/attendance?month=${month}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`/api/owner/attendance/stats?month=${month}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        setStats(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchStaff = async () => {
    try {
      const res = await fetch('/api/owner/staff', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await res.json();
        setStaffList(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/attendance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          date: selectedDate,
          hours: parseFloat(hours),
          type,
          note
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        fetchLogs();
        alert('Attendance logged successfully!');
      } else {
        alert(data.error || 'Failed to log attendance. Please try again.');
      }
    } catch (err) {
      alert('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkSubmit = async () => {
    if (selectedDays.length === 0) return;
    setSubmitting(true);
    try {
      const results = await Promise.all(selectedDays.map(day =>
        fetch('/api/attendance', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ date: day, hours: parseFloat(hours), type, note })
        })
      ));
      const failed = results.filter(r => !r.ok).length;
      fetchLogs();
      setSelectedDays([]);
      if (failed > 0) {
        alert(`${selectedDays.length - failed} days saved. ${failed} failed — please retry.`);
      } else {
        alert(`Attendance logged for ${selectedDays.length} days!`);
      }
    } catch (err) {
      alert('Network error. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusUpdate = async (id: string, status: string) => {
    try {
      const res = await fetch(`/api/attendance/${id}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        fetchLogs();
        fetchStats();
      }
    } catch (err) {
      alert('Failed to update status');
    }
  };

  const updateDefaultHours = async (staffId: string, hours: number) => {
    try {
      const res = await fetch(`/api/owner/staff/${staffId}/settings`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ default_hours: hours })
      });
      if (res.ok) {
        fetchStaff();
        fetchStats();
      }
    } catch (err) {
      alert('Failed to update default hours');
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">Staff Attendance</h2>
          <p className="text-[#6b5d52]">Manage daily logs and monthly reports</p>
        </div>
        <div className="flex items-center gap-3 bg-white p-2 rounded-2xl shadow-sm border border-[#cc5a16]/10">
          <Calendar size={18} className="text-[#9c8e85] ml-2" />
          <input 
            type="month" 
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="bg-transparent border-none focus:ring-0 text-sm font-bold text-[#1a1208] outline-none"
          />
        </div>
      </div>

      {role !== 'OWNER' && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-8 rounded-[32px] shadow-sm border border-[#cc5a16]/10"
        >
          <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
            <UserCheck size={20} className="text-emerald-600" />
            Log Attendance
          </h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-5 gap-6 items-end">
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Date</label>
              <input 
                type="date" 
                required
                max={new Date().toISOString().slice(0, 10)}
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none font-bold"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">
                Hours Worked {user?.default_hours && <span className="text-emerald-600">(Default: {user.default_hours}h)</span>}
              </label>
              <input 
                type="number" 
                step="0.5"
                required
                value={hours}
                onChange={e => setHours(e.target.value)}
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none font-bold"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Type</label>
              <select 
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none font-bold appearance-none"
              >
                <option value="WORK">Work Day</option>
                <option value="LEAVE">Leave</option>
                <option value="SICK">Sick Leave</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Note (Optional)</label>
              <input 
                type="text" 
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. Overtime"
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
              />
            </div>
            <button 
              disabled={submitting}
              type="submit"
              className="bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all disabled:opacity-50"
            >
              {submitting ? 'Logging...' : 'Submit Log'}
            </button>
          </form>
          {selectedDays.length > 0 && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-6 p-4 bg-emerald-50 rounded-2xl border border-emerald-100 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="bg-emerald-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm">
                  {selectedDays.length}
                </div>
                <div>
                  <p className="font-bold text-emerald-900 text-sm">Days Selected</p>
                  <p className="text-emerald-700 text-xs">Submit timesheet for all selected dates with the values above.</p>
                </div>
              </div>
              <button 
                onClick={handleBulkSubmit}
                disabled={submitting}
                className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold text-sm hover:bg-emerald-700 transition-all disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Bulk Submit'}
              </button>
            </motion.div>
          )}
        </motion.div>
      )}

      {role !== 'OWNER' && (
        <div className="bg-white rounded-[32px] shadow-sm border border-[#cc5a16]/10 overflow-hidden">
          <div className="p-8 border-b border-[#cc5a16]/10 flex justify-between items-center">
            <h3 className="text-xl font-bold font-serif">Monthly Timesheet</h3>
            <div className="text-xs font-bold uppercase tracking-widest text-[#9c8e85]">
              {new Date(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#faf7f2]/50">
                  <th className="px-8 py-4 w-12">
                    <input 
                      type="checkbox" 
                      className="rounded border-[#cc5a16]/20 text-[#1a1208] focus:ring-[#cc5a16]/20"
                      onChange={(e) => {
                        if (e.target.checked) {
                          const pastDaysWithoutLogs = getDaysInMonth(month).filter(day => {
                            const log = logs.find(l => String(l.date).slice(0, 10) === day);
                            const isFuture = day > new Date().toISOString().slice(0, 10);
                            return !log && !isFuture;
                          });
                          setSelectedDays(pastDaysWithoutLogs);
                        } else {
                          setSelectedDays([]);
                        }
                      }}
                    />
                  </th>
                  <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Date</th>
                  <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Status</th>
                  <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Hours</th>
                  <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#5A5A40]/5">
                {getDaysInMonth(month).map(day => {
                  // Normalize DB date (may come as ISO timestamp) to YYYY-MM-DD for comparison
                  const log = logs.find(l => {
                    const d = l.date ? String(l.date).slice(0, 10) : '';
                    return d === day;
                  });
                  const isFuture = day > new Date().toISOString().slice(0, 10);
                  const isSelected = selectedDays.includes(day);
                  return (
                    <tr key={day} className={cn("hover:bg-[#faf7f2]/30 transition-colors", isFuture && "opacity-40")}>
                      <td className="px-8 py-4">
                        {!log && !isFuture && (
                          <input 
                            type="checkbox" 
                            checked={isSelected}
                            className="rounded border-[#cc5a16]/20 text-[#1a1208] focus:ring-[#cc5a16]/20"
                            onChange={(e) => {
                              if (e.target.checked) setSelectedDays([...selectedDays, day]);
                              else setSelectedDays(selectedDays.filter(d => d !== day));
                            }}
                          />
                        )}
                      </td>
                      <td className="px-8 py-4 font-mono text-sm">{day}</td>
                      <td className="px-8 py-4">
                        {log ? (
                          <span className={cn(
                            "px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest",
                            log.status === 'APPROVED' ? "bg-green-50 text-green-700" : 
                            log.status === 'REJECTED' ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-700"
                          )}>
                            {log.status}
                          </span>
                        ) : (
                          <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] italic">
                            {isFuture ? 'Future' : 'No Log'}
                          </span>
                        )}
                      </td>
                      <td className="px-8 py-4 font-bold">
                        {log ? `${log.hours} hrs` : '-'}
                      </td>
                      <td className="px-8 py-4 text-right">
                        {!log && !isFuture && (
                          <button 
                            onClick={() => {
                              setSelectedDate(day);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="text-[11px] font-bold uppercase tracking-widest text-[#1a1208] hover:underline"
                          >
                            Log Hours
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
        </div>
      )}

      {role === 'OWNER' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <div className="bg-white rounded-[32px] shadow-sm border border-[#cc5a16]/10 overflow-hidden">
              <div className="p-8 border-b border-[#cc5a16]/10 flex justify-between items-center">
                <h3 className="text-xl font-bold font-serif">Monthly Summary</h3>
                <div className="text-xs font-bold uppercase tracking-widest text-[#9c8e85]">
                  {new Date(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#faf7f2]/50">
                      <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Staff Member</th>
                      <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Total Hours</th>
                      <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Days Worked</th>
                      <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Default Hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#5A5A40]/5">
                    {stats.map(stat => (
                      <tr key={stat.user_id} className="hover:bg-[#faf7f2]/30 transition-colors">
                        <td className="px-8 py-5">
                          <p className="font-bold text-[#1a1208]">{stat.name}</p>
                          {stat.staff_role && (
                            <p className="text-[11px] uppercase tracking-widest text-[#9c8e85] font-bold">{stat.staff_role}</p>
                          )}
                        </td>
                        <td className="px-8 py-5">
                          <span className="font-mono font-bold text-lg">{stat.total_hours}</span>
                          <span className="text-xs text-[#9c8e85] ml-1">hrs</span>
                        </td>
                        <td className="px-8 py-5">
                          <span className="bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold">
                            {stat.days_worked} days
                          </span>
                        </td>
                        <td className="px-8 py-5">
                          <input 
                            type="number" 
                            defaultValue={stat.default_hours}
                            onBlur={(e) => updateDefaultHours(stat.user_id, parseFloat(e.target.value))}
                            className="w-16 bg-[#faf7f2] border-none rounded-lg px-2 py-1 text-sm font-bold outline-none focus:ring-1 ring-[#cc5a16]/20"
                          />
                        </td>
                      </tr>
                    ))}
                    {stats.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-8 py-12 text-center text-[#9c8e85] italic">
                          No approved logs for this month
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white p-8 rounded-[32px] shadow-sm border border-[#cc5a16]/10">
              <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
                <Settings size={18} className="text-[#9c8e85]" />
                Staff Settings
              </h3>
              <div className="space-y-4">
                {staffList.map(staff => (
                  <div key={staff.id} className="flex items-center justify-between p-4 bg-[#faf7f2] rounded-2xl">
                    <div>
                      <p className="font-bold text-sm">{staff.name}</p>
                      <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest">{staff.role}</p>
                    </div>
                    <div className="text-right">
                      <label className="block text-[11px] font-bold uppercase text-[#9c8e85] mb-1">Default Hrs</label>
                      <input 
                        type="number" 
                        defaultValue={staff.default_hours || 8}
                        onBlur={(e) => updateDefaultHours(staff.id, parseFloat(e.target.value))}
                        className="w-12 bg-white border-none rounded-lg px-2 py-1 text-xs font-bold outline-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-[32px] shadow-sm border border-[#cc5a16]/10 overflow-hidden">
        <div className="p-8 border-b border-[#cc5a16]/10 flex justify-between items-center">
          <h3 className="text-xl font-bold font-serif flex items-center gap-2">
            <History size={20} className="text-[#9c8e85]" />
            {role === 'OWNER' ? 'All Attendance Logs' : 'My Attendance History'}
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#faf7f2]/50">
                <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Date</th>
                {role === 'OWNER' && <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Staff</th>}
                <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Hours</th>
                <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Type</th>
                <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Status</th>
                {role === 'OWNER' && <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#5A5A40]/5">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-[#faf7f2]/30 transition-colors">
                  <td className="px-8 py-5 font-mono text-sm">{String(log.date).slice(0, 10)}</td>
                  {role === 'OWNER' && (
                    <td className="px-8 py-5 font-bold text-[#1a1208]">
                      {log.staff_name || staffList.find(s => s.id === log.user_id)?.name || 'Unknown Staff'}
                    </td>
                  )}
                  <td className="px-8 py-5 font-bold">{log.hours} hrs</td>
                  <td className="px-8 py-5">
                    <span className={cn(
                      "px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest",
                      log.type === 'WORK' ? "bg-blue-50 text-blue-700" : "bg-orange-50 text-orange-700"
                    )}>
                      {log.type}
                    </span>
                  </td>
                  <td className="px-8 py-5">
                    <span className={cn(
                      "px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest",
                      log.status === 'APPROVED' ? "bg-green-50 text-green-700" : 
                      log.status === 'REJECTED' ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-700"
                    )}>
                      {log.status}
                    </span>
                  </td>
                  {role === 'OWNER' && (
                    <td className="px-8 py-5 text-right">
                      {log.status === 'PENDING' && (
                        <div className="flex justify-end gap-2">
                          <button 
                            onClick={() => handleStatusUpdate(log.id, 'APPROVED')}
                            className="p-2 bg-green-50 text-green-600 rounded-xl hover:bg-green-600 hover:text-white transition-all"
                          >
                            <Check size={16} />
                          </button>
                          <button 
                            onClick={() => handleStatusUpdate(log.id, 'REJECTED')}
                            className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-600 hover:text-white transition-all"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={role === 'OWNER' ? 6 : 4} className="px-8 py-12 text-center text-[#9c8e85] italic">
                    No logs found for this month
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
      </div>
    </div>
  );
}

// Shared helper: normalize raw DB order rows (snake_case) into camelCase aliases
// so both snake_case references (REPORTS/CSV) and camelCase references (PAYMENTS/UPI) work.
// Also parses the `items` field from a JSON string into an array (PostgreSQL stores it as TEXT).
function normalizeOrder(o: any): any {
  let parsedItems = o.items;
  if (typeof parsedItems === 'string') {
    try { parsedItems = JSON.parse(parsedItems); } catch { parsedItems = []; }
  }
  if (!Array.isArray(parsedItems)) parsedItems = [];

  return {
    ...o,
    items:             parsedItems,
    tableNumber:       o.table_number       ?? o.tableNumber       ?? '',
    totalAmount:       Number(o.total_amount ?? o.totalAmount       ?? 0),
    gstAmount:         Number(o.gst_amount   ?? o.gstAmount         ?? 0),
    customerName:      o.customer_name      ?? o.customerName      ?? '',
    customerPhone:     o.customer_phone     ?? o.customerPhone     ?? '',
    customerEmail:     o.customer_email     ?? o.customerEmail     ?? '',
    paymentStatus:     o.payment_status     ?? o.paymentStatus     ?? 'PENDING',
    paymentMethod:     o.payment_method     ?? o.paymentMethod     ?? '',
    createdAt:         o.created_at         ?? o.createdAt,
    feedbackRequested: o.feedback_requested ?? o.feedbackRequested ?? false,
  };
}

// ─── Analytics Dashboard ────────────────────────────────────────────────────
const CHART_COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#06b6d4','#84cc16','#f97316'];
const PAYMENT_COLORS: Record<string, string> = { CASH:'#10b981', CARD:'#3b82f6', UPI:'#8b5cf6', ONLINE:'#f59e0b', Unknown:'#94a3b8', UNKNOWN:'#94a3b8' };

function AnalyticsDashboard({
  restaurantId, token, feedback, onDateRangeChange, restaurant,
}: {
  restaurantId: string; token: string; feedback: any[];
  onDateRangeChange: (from: string, to: string) => void;
  restaurant?: Restaurant | null;
}) {
  const [reports, setReports]         = useState<any>(null);
  const [loading, setLoading]         = useState(true);
  const [granularity, setGranularity] = useState<'daily'|'weekly'|'monthly'>('daily');
  const [drillCategory, setDrillCategory] = useState<string|null>(null);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  // Hotel analytics state (Phase 3)
  const isHotelEnabled = !!restaurant && ((restaurant as any).property_type === 'HOTEL' || (restaurant as any).property_type === 'BOTH');
  const [hotelAnalytics, setHotelAnalytics] = useState<any>(null);
  useEffect(() => {
    if (!isHotelEnabled) return;
    (async () => {
      try {
        const res = await fetch(`/api/restaurant/${restaurantId}/hotel/analytics`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) setHotelAnalytics(await res.json());
      } catch {}
    })();
  }, [isHotelEnabled, restaurantId, token]);
  const [analyticsOrderPage, setAnalyticsOrderPage] = useState(1);
  const [analyticsOrderSearch, setAnalyticsOrderSearch] = useState('');
  const [analyticsOrderSortCol, setAnalyticsOrderSortCol] = useState<string>('created_at');
  const [analyticsOrderSortDir, setAnalyticsOrderSortDir] = useState<'asc'|'desc'>('desc');

  useEffect(() => { fetchData(); onDateRangeChange(dateFrom, dateTo); }, [dateFrom, dateTo]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/reports?from=${dateFrom}&to=${dateTo}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setReports(await res.json());
    } catch {}
    finally { setLoading(false); }
  };

  const kpi = reports?.kpi || {};
  const avgRating = feedback.length > 0
    ? feedback.reduce((a: number, f: any) => a + Number(f.rating || 0), 0) / feedback.length : 0;

  const timeSeriesData = useMemo(() => {
    if (granularity === 'daily')   return (reports?.dailySales   || []).map((d: any) => ({ label: d.date.slice(5),        revenue: d.revenue, orders: d.orders }));
    if (granularity === 'weekly')  return (reports?.weeklySales  || []).map((d: any) => ({ label: `Wk ${d.week.slice(5)}`, revenue: d.revenue, orders: d.orders }));
    return                                (reports?.monthlySales  || []).map((d: any) => ({ label: d.month,                revenue: d.revenue, orders: d.orders }));
  }, [reports, granularity]);

  const exportToCSV = () => {
    if (!reports?.allOrders) return;
    const headers = ['Order ID','Table','Customer','Phone','Total','GST','Status','Payment','Date'];
    const rows = reports.allOrders.map((o: any) => [
      o.id, o.table_number, o.customer_name || 'N/A', o.customer_phone || 'N/A',
      o.total_amount, o.gst_amount, o.status, o.payment_status,
      new Date(o.created_at).toLocaleString(),
    ]);
    const csv = [headers.join(','), ...rows.map((r: any) => r.map((v: any) => `"${v}"`).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    link.download = `report_${restaurantId}_${dateFrom}_to_${dateTo}.csv`;
    link.click();
  };

  // KPI card helper — inline style gradient so Tailwind purge never strips dynamic colour tokens
  // Heritage Premium KPI Card — saturated solid color, oversized mono number,
  // brass top accent line, subtle decorative flourish. Taj/Oberoi inspired.
  // NOTE: No initial/animate entry animation — AnalyticsDashboard parents can
  // re-render frequently (data refresh), and entry animations would flash on
  // every re-render. Hover animation is retained as it's user-triggered only.
  const KpiCard = ({ label, value, icon: Icon, bg, sub, accent }: any) => (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      className="relative overflow-hidden rounded-3xl p-6 cursor-default"
      style={{
        background: bg,
        boxShadow: '0 10px 30px rgba(20, 17, 12, 0.18), 0 2px 6px rgba(20, 17, 12, 0.08)',
      }}
    >
      {/* Top accent line — brass by default, or per-card accent */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px]"
        style={{ background: accent || 'rgba(184, 134, 11, 0.9)' }}
      />

      {/* Decorative corner flourish */}
      <div
        className="absolute -bottom-10 -right-10 w-32 h-32 rounded-full pointer-events-none"
        style={{ background: 'rgba(255, 255, 255, 0.08)' }}
      />
      <div
        className="absolute top-8 right-8 w-1.5 h-1.5 rounded-full pointer-events-none"
        style={{ background: 'rgba(255, 255, 255, 0.25)' }}
      />

      <div className="relative flex justify-between items-start">
        <div className="min-w-0 flex-1 pr-3">
          <p
            style={{ color: 'rgba(255, 255, 255, 0.72)' }}
            className="text-[10px] font-semibold uppercase tracking-[0.18em] mb-3"
          >
            {label}
          </p>
          <p
            style={{ color: '#ffffff', fontFamily: '"JetBrains Mono", monospace', letterSpacing: '-0.03em' }}
            className="text-2xl xl:text-xl font-bold leading-none whitespace-nowrap"
          >
            {value}
          </p>
          {sub && (
            <p
              style={{ color: 'rgba(255, 255, 255, 0.65)' }}
              className="text-[11px] font-medium mt-2"
            >
              {sub}
            </p>
          )}
        </div>
        <div
          style={{ background: 'rgba(255, 255, 255, 0.15)', backdropFilter: 'blur(8px)' }}
          className="rounded-2xl p-2.5 shrink-0 border border-white/10"
        >
          <Icon size={18} style={{ color: '#ffffff' }} strokeWidth={2.2} />
        </div>
      </div>
    </motion.div>
  );

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-[#6b5d52] font-bold text-sm">Loading analytics…</p>
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      {/* ── Header + Controls ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">Analytics & Reports</h2>
          <p className="text-[#6b5d52] text-sm mt-0.5">Your business intelligence at a glance</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 bg-white px-4 py-2.5 rounded-2xl border border-[#cc5a16]/10 shadow-sm">
            <Calendar size={15} className="text-[#9c8e85] flex-shrink-0" />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="text-sm font-bold text-[#1a1208] border-none outline-none bg-transparent w-32" />
            <span className="text-[#9c8e85] text-xs">→</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="text-sm font-bold text-[#1a1208] border-none outline-none bg-transparent w-32" />
          </div>
          <button onClick={fetchData}
            className="flex items-center gap-2 px-4 py-2.5 bg-white rounded-2xl border border-[#cc5a16]/10 shadow-sm text-sm font-bold text-[#1a1208] hover:bg-[#faf7f2] transition-all">
            <RefreshCw size={15} /> Refresh
          </button>
          <button onClick={exportToCSV}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#cc5a16] text-white rounded-2xl font-bold text-sm hover:bg-[#a84612] transition-all shadow-lg shadow-[#5A5A40]/20">
            <Download size={15} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI Cards — Heritage Premium palette ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Revenue"   value={`₹${Number(kpi.totalRevenue  || 0).toLocaleString('en-IN')}`} icon={TrendingUp}   bg="linear-gradient(135deg, #cc5a16 0%, #a84612 100%)" accent="#fcd34d" sub={`${kpi.totalOrders || 0} orders`} />
        <KpiCard label="Today's Revenue" value={`₹${Number(kpi.todayRevenue  || 0).toLocaleString('en-IN')}`} icon={Zap}          bg="linear-gradient(135deg, #1e3a5f 0%, #152a47 100%)" accent="#b8860b" sub={`${kpi.todayOrders || 0} today`} />
        <KpiCard label="Total Orders"    value={kpi.totalOrders  || 0}                                          icon={ShoppingCart} bg="linear-gradient(135deg, #0f766e 0%, #0a5853 100%)" accent="#fcd34d" sub={`${dateFrom} → ${dateTo}`} />
        <KpiCard label="Avg Order"       value={`₹${Number(kpi.avgOrderValue || 0).toFixed(0)}`}                icon={BarChart3}    bg="linear-gradient(135deg, #b8860b 0%, #8f6608 100%)" accent="#fef3c7" />
        <KpiCard label="Paid Revenue"    value={`₹${Number(kpi.paidRevenue   || 0).toLocaleString('en-IN')}`} icon={CreditCard}   bg="linear-gradient(135deg, #1f1a12 0%, #14110c 100%)" accent="#cc5a16" />
        <KpiCard label="Avg Rating"      value={avgRating.toFixed(1)}                                           icon={Star}         bg="linear-gradient(135deg, #9f1239 0%, #7a0d2c 100%)" accent="#fcd34d" sub={`${feedback.length} reviews`} />
      </div>

      {/* ── Hotel KPIs (only when hotel module is active) ── */}
      {isHotelEnabled && hotelAnalytics && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-1 h-6 bg-[#b8860b] rounded-full"></span>
            <h3 className="text-lg font-serif font-bold text-[#1a1208]">Hotel Performance</h3>
            <span className="text-[11px] text-[#9c8e85] uppercase tracking-widest ml-auto">last 30 days</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
            <KpiCard label="Occupancy" value={`${hotelAnalytics.occupancy_pct}%`} icon={Bed} bg="linear-gradient(135deg, #b8860b 0%, #8f6608 100%)" accent="#fef3c7" sub={`${hotelAnalytics.occupied}/${hotelAnalytics.totalRooms} rooms`}/>
            <KpiCard label="ADR" value={`₹${hotelAnalytics.adr.toLocaleString('en-IN')}`} icon={IndianRupee} bg="linear-gradient(135deg, #cc5a16 0%, #a84612 100%)" accent="#fcd34d" sub="per booking"/>
            <KpiCard label="RevPAR" value={`₹${hotelAnalytics.revpar.toLocaleString('en-IN')}`} icon={TrendingUp} bg="linear-gradient(135deg, #0f766e 0%, #0a5853 100%)" accent="#fcd34d" sub="per avail room"/>
            <KpiCard label="Ancillary" value={`${hotelAnalytics.ancillary_pct}%`} icon={Sparkles} bg="linear-gradient(135deg, #1e3a5f 0%, #152a47 100%)" accent="#b8860b" sub={`₹${Number(hotelAnalytics.ancillary_revenue_30d).toLocaleString('en-IN')}`}/>
            <KpiCard label="Guest Rating" value={Number(hotelAnalytics.avg_rating || 0).toFixed(1)} icon={Star} bg="linear-gradient(135deg, #9f1239 0%, #7a0d2c 100%)" accent="#fcd34d" sub="of 5"/>
            <KpiCard label="Bookings" value={hotelAnalytics.folio_count_30d} icon={Calendar} bg="linear-gradient(135deg, #1f1a12 0%, #14110c 100%)" accent="#cc5a16" sub="settled"/>
          </div>
          {hotelAnalytics.top_services && hotelAnalytics.top_services.length > 0 && (
            <div className="bg-white rounded-3xl border border-[#cc5a16]/10 p-5">
              <h4 className="text-sm font-serif font-bold text-[#1a1208] mb-3">Top Services</h4>
              <div className="space-y-2">
                {hotelAnalytics.top_services.map((s: any, i: number) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm text-[#3d3128]">{s.service_name}</span>
                    <span className="text-sm font-mono font-bold text-[#cc5a16]">{s.n}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── AI Sentiment Analysis (Phase 4) ── */}
          <HotelSentimentPanel restaurantId={restaurantId} token={token} />
        </div>
      )}

      {/* ── Revenue Trend (2/3) + Sales Mix Drilldown (1/3) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Revenue Trend */}
        <div className="lg:col-span-2 bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="text-xl font-bold font-serif">Revenue Trend</h3>
              <p className="text-[11px] text-[#9c8e85] uppercase tracking-widest mt-0.5">Bars = Revenue · Line = Orders</p>
            </div>
            {/* Granularity toggle — roll up / roll down */}
            <div className="flex bg-[#faf7f2] rounded-xl p-1 gap-1">
              {(['daily','weekly','monthly'] as const).map(g => (
                <button key={g} onClick={() => setGranularity(g)}
                  className={cn('px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all',
                    granularity === g ? 'bg-[#cc5a16] text-white shadow' : 'text-[#6b5d52] hover:text-[#1a1208]')}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          {timeSeriesData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-[#9c8e85] italic text-sm">No data for selected range</div>
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timeSeriesData} margin={{ top:5, right:10, left:0, bottom:5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0e8" />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize:10, fill:'#9ca3af' }} />
                  <YAxis yAxisId="rev" axisLine={false} tickLine={false} tick={{ fontSize:10, fill:'#9ca3af' }}
                    tickFormatter={(v) => `₹${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
                  <YAxis yAxisId="ord" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize:10, fill:'#f59e0b' }} />
                  <Tooltip contentStyle={{ borderRadius:14, border:'none', boxShadow:'0 8px 32px rgba(0,0,0,0.1)', fontSize:12 }}
                    formatter={(v: any, name: string) => [
                      name === 'revenue' ? `₹${Number(v).toLocaleString('en-IN')}` : v,
                      name === 'revenue' ? 'Revenue' : 'Orders',
                    ]} />
                  <Legend wrapperStyle={{ fontSize:11, fontWeight:700, paddingTop:8 }} />
                  <Bar yAxisId="rev" dataKey="revenue" name="revenue" fill="#6366f1" radius={[6,6,0,0]} maxBarSize={44} />
                  <Line yAxisId="ord" dataKey="orders" name="orders" type="monotone" stroke="#f59e0b" strokeWidth={2.5} dot={{ r:3, fill:'#f59e0b', strokeWidth:0 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Category Sales Mix with drill-down */}
        <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xl font-bold font-serif">Sales Mix</h3>
            {drillCategory && (
              <button onClick={() => setDrillCategory(null)}
                className="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-700 font-bold uppercase tracking-widest">
                <ChevronLeft size={13} /> All
              </button>
            )}
          </div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-4">
            {drillCategory ? `▸ ${drillCategory}` : 'Click slice → see items'}
          </p>

          {!drillCategory ? (
            <>
              <div className="h-[190px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={reports?.salesByCategory || []} cx="50%" cy="50%"
                      innerRadius={52} outerRadius={80} paddingAngle={3}
                      dataKey="revenue" nameKey="category"
                      onClick={(e: any) => setDrillCategory(e.category)} cursor="pointer">
                      {(reports?.salesByCategory || []).map((_: any, i: number) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius:12, border:'none', boxShadow:'0 4px 16px rgba(0,0,0,0.08)', fontSize:11 }}
                      formatter={(v: any) => `₹${Number(v).toLocaleString('en-IN')}`} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 space-y-1.5 max-h-28 overflow-y-auto pr-1">
                {(reports?.salesByCategory || []).slice(0, 6).map((cat: any, i: number) => (
                  <div key={cat.category} onClick={() => setDrillCategory(cat.category)}
                    className="flex items-center justify-between text-xs cursor-pointer hover:bg-[#faf7f2] rounded-xl px-2 py-1.5 transition-colors">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                      <span className="font-bold text-[#1a1208] truncate max-w-[90px]">{cat.category}</span>
                    </div>
                    <span className="font-bold text-[#1a1208] ml-2">₹{Number(cat.revenue).toLocaleString('en-IN')}</span>
                  </div>
                ))}
                {(!reports?.salesByCategory || reports.salesByCategory.length === 0) && (
                  <p className="text-center text-[#9c8e85] italic text-xs py-4">No category data</p>
                )}
              </div>
            </>
          ) : (
            // Item drill-down bar chart
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={(reports?.salesByCategory?.find((c: any) => c.category === drillCategory)?.items || []).slice(0, 7)}
                  layout="vertical" margin={{ left:0, right:10, top:0, bottom:0 }}>
                  <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize:9, fill:'#9ca3af' }}
                    tickFormatter={(v) => `₹${v}`} />
                  <YAxis type="category" dataKey="name" axisLine={false} tickLine={false}
                    tick={{ fontSize:9, fill:'#5A5A40' }} width={72} />
                  <Tooltip contentStyle={{ borderRadius:12, border:'none', boxShadow:'0 4px 16px rgba(0,0,0,0.08)', fontSize:11 }}
                    formatter={(v: any, name: string) => [name === 'revenue' ? `₹${Number(v).toLocaleString('en-IN')}` : v, name]} />
                  <Bar dataKey="revenue" name="Revenue" radius={[0,6,6,0]} maxBarSize={18}>
                    {(reports?.salesByCategory?.find((c: any) => c.category === drillCategory)?.items || []).map((_: any, i: number) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* ── Payment Split + Peak Hours + Top Items ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Payment Split */}
        <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
          <h3 className="text-xl font-bold font-serif mb-6">Payment Split</h3>
          <div className="space-y-5">
            {(reports?.paymentBreakdown || []).map((p: any) => {
              const total = (reports?.paymentBreakdown || []).reduce((s: number, x: any) => s + x.revenue, 0);
              const pct   = total > 0 ? (p.revenue / total) * 100 : 0;
              const color = PAYMENT_COLORS[p.method] || '#94a3b8';
              return (
                <div key={p.method}>
                  <div className="flex justify-between items-center mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-sm font-bold text-[#1a1208]">{p.method}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-bold text-[#1a1208]">₹{Number(p.revenue).toLocaleString('en-IN')}</span>
                      <span className="text-[11px] text-[#9c8e85] ml-2">{pct.toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="w-full bg-[#faf7f2] rounded-full h-2">
                    <motion.div initial={{ width:0 }} animate={{ width:`${pct}%` }} transition={{ duration:0.8, ease:'easeOut' }}
                      className="h-2 rounded-full" style={{ backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
            {(!reports?.paymentBreakdown || reports.paymentBreakdown.length === 0) && (
              <p className="text-center text-[#9c8e85] italic text-sm py-8">No payment data yet</p>
            )}
          </div>
        </div>

        {/* Peak Hours */}
        <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
          <h3 className="text-xl font-bold font-serif mb-1">Peak Hours</h3>
          <p className="text-[11px] uppercase tracking-widest text-[#9c8e85] mb-5">When your orders spike</p>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(reports?.peakHours || []).filter((h: any) => h.count > 0)} margin={{ top:0, right:0, left:-25, bottom:0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0e8" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize:8, fill:'#9ca3af' }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize:9 }} />
                <Tooltip contentStyle={{ borderRadius:12, border:'none', boxShadow:'0 4px 16px rgba(0,0,0,0.08)', fontSize:11 }} />
                <Bar dataKey="count" name="Orders" radius={[4,4,0,0]}>
                  {(reports?.peakHours || []).filter((h: any) => h.count > 0).map((h: any, i: number) => {
                    const maxC = Math.max(...(reports?.peakHours || []).map((x: any) => x.count), 1);
                    return <Cell key={i} fill={`rgba(99,102,241,${0.25 + (h.count / maxC) * 0.75})`} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top Items */}
        <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
          <h3 className="text-xl font-bold font-serif mb-1 flex items-center gap-2">
            <Award size={19} className="text-yellow-500" /> Top Items
          </h3>
          <p className="text-[11px] uppercase tracking-widest text-[#9c8e85] mb-5">By quantity sold</p>
          <div className="space-y-3">
            {(reports?.topItems || []).slice(0, 7).map((item: any, i: number) => (
              <div key={item.name} className="flex items-center gap-3">
                <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0',
                  i === 0 ? 'bg-yellow-100 text-yellow-600' :
                  i === 1 ? 'bg-gray-100 text-gray-500' :
                  i === 2 ? 'bg-orange-100 text-orange-600' : 'bg-[#faf7f2] text-[#6b5d52]')}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-[#1a1208] truncate">{item.name}</p>
                  <div className="w-full bg-[#faf7f2] rounded-full h-1.5 mt-1">
                    <div className="h-1.5 rounded-full bg-indigo-400 transition-all duration-700"
                      style={{ width:`${reports?.topItems?.[0]?.count > 0 ? (item.count / reports.topItems[0].count) * 100 : 0}%` }} />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-bold text-[#1a1208]">{item.count}×</p>
                  <p className="text-[11px] text-[#9c8e85]">₹{Number(item.revenue).toLocaleString('en-IN')}</p>
                </div>
              </div>
            ))}
            {(!reports?.topItems || reports.topItems.length === 0) && (
              <p className="text-center text-[#9c8e85] italic text-sm py-8">No data yet</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Order History Table ── */}
      <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
        <div className="p-8 border-b border-[#cc5a16]/10 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold font-serif">Order History</h3>
            <p className="text-xs text-[#9c8e85] mt-0.5">{reports?.allOrders?.length || 0} orders in selected range</p>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
            <input type="text" placeholder="Search orders…" value={analyticsOrderSearch}
              onChange={e => { setAnalyticsOrderSearch(e.target.value); setAnalyticsOrderPage(1); }}
              className="bg-[#faf7f2] border-none rounded-xl pl-9 pr-4 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 w-52" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#faf7f2]/60">
                {([
                  { col: 'id', label: 'Order' },
                  { col: 'created_at', label: 'Date & Time' },
                  { col: 'customer_name', label: 'Customer' },
                  { col: 'table_number', label: 'Table' },
                  { col: 'total_amount', label: 'Amount' },
                  { col: 'payment_method', label: 'Payment' },
                  { col: 'status', label: 'Status' },
                ] as const).map(({ col, label }) => (
                  <th key={col} onClick={() => {
                    if (analyticsOrderSortCol === col) setAnalyticsOrderSortDir(d => d === 'asc' ? 'desc' : 'asc');
                    else { setAnalyticsOrderSortCol(col); setAnalyticsOrderSortDir('asc'); }
                    setAnalyticsOrderPage(1);
                  }} className="p-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] cursor-pointer hover:text-[#cc5a16] select-none transition-colors">
                    <span className="flex items-center gap-1">{label}
                      {analyticsOrderSortCol === col ? <span className="text-[#cc5a16]">{analyticsOrderSortDir === 'asc' ? '↑' : '↓'}</span> : <span className="opacity-20">↕</span>}
                    </span>
                  </th>
                ))}
                <th className="p-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#5A5A40]/5">
              {(() => {
                const q = analyticsOrderSearch.toLowerCase();
                const allOrders = reports?.allOrders || [];
                const filtered = allOrders.filter((o: any) =>
                  !q || (o.id||'').toLowerCase().includes(q) || (o.customer_name||'').toLowerCase().includes(q) ||
                  (o.customer_phone||'').includes(q) || (o.table_number||'').toString().includes(q)
                );
                const sorted = [...filtered].sort((a: any, b: any) => {
                  const va = a[analyticsOrderSortCol] ?? '';
                  const vb = b[analyticsOrderSortCol] ?? '';
                  const n = typeof va === 'number';
                  return analyticsOrderSortDir === 'asc'
                    ? n ? va - vb : String(va).localeCompare(String(vb))
                    : n ? vb - va : String(vb).localeCompare(String(va));
                });
                const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
                const safePage = Math.min(analyticsOrderPage, totalPages);
                const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
                if (pageRows.length === 0) return (
                  <tr><td colSpan={8} className="p-16 text-center text-[#9c8e85] italic">No orders in selected date range</td></tr>
                );
                return pageRows.map((order: any) => {
                const printOwnerReceipt = () => {
                  const norm = normalizeOrder(order);
                  const dt   = new Date(order.created_at);
                  const gstAmt = Number(order.gst_amount || 0);
                  const sub    = Number(order.total_amount || 0);
                  const total  = sub + gstAmt;
                  const html = buildThermalHTML({
                    restaurantName: restaurant?.name || 'Restaurant',
                    gstin:          restaurant?.gst_number,
                    gstEnabled:     restaurant?.is_gst_enabled,
                    gstPercent:     restaurant?.gst_percentage ?? 0,
                    billId:         String(order.id).slice(-8).toUpperCase(),
                    tableName:      order.table_number ? `T-${order.table_number}` : undefined,
                    customerName:   order.customer_name || undefined,
                    customerPhone:  order.customer_phone || undefined,
                    date:           dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
                    time:           dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
                    rounds: [{
                      items: norm.items.map((it: any) => ({
                        name:  it.name,
                        qty:   it.quantity ?? 1,
                        price: it.price ?? 0,
                      })),
                    }],
                    subtotal:      sub,
                    gstAmount:     gstAmt,
                    total,
                    paymentMethod: order.payment_method || order.payment_status || undefined,
                  });
                  openThermalPrint(html);
                };
                return (
                <tr key={order.id} className="hover:bg-[#f9f9f5] transition-colors">
                  <td className="p-4 font-mono text-xs font-bold text-indigo-600">{String(order.id).slice(0,8)}…</td>
                  <td className="p-4 text-sm text-[#6b5d52]">{new Date(order.created_at).toLocaleString()}</td>
                  <td className="p-4">
                    <div className="text-sm font-bold text-[#1a1208]">{order.customer_name || 'Guest'}</div>
                    <div className="text-[11px] text-[#9c8e85]">{order.customer_phone || ''}</div>
                  </td>
                  <td className="p-4 text-sm font-bold text-[#1a1208]">{order.table_number ? `T-${order.table_number}` : '—'}</td>
                  <td className="p-4">
                    <div className="text-sm font-bold text-[#1a1208]">₹{Number(order.total_amount || 0).toFixed(2)}</div>
                    {Number(order.gst_amount) > 0 && <div className="text-[11px] text-emerald-600">+₹{Number(order.gst_amount).toFixed(2)} GST</div>}
                  </td>
                  <td className="p-4">
                    <span className={cn('px-2 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest',
                      order.payment_status === 'PAID' ? 'bg-emerald-50 text-emerald-600' : 'bg-orange-50 text-orange-600')}>
                      {order.payment_method || order.payment_status || 'N/A'}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className={cn('px-2 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest',
                      order.status === 'DELIVERED' ? 'bg-green-100 text-green-600' :
                      order.status === 'CANCELLED' ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-orange-600')}>
                      {order.status}
                    </span>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={printOwnerReceipt}
                      title="Print 80mm thermal receipt"
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#faf7f2] hover:bg-[#cc5a16] hover:text-white text-[#6b5d52] text-[11px] font-bold uppercase tracking-widest transition-all"
                    >
                      🖨 Print
                    </button>
                  </td>
                </tr>
                );
                });
              })()}
            </tbody>
          </table>
        </div>
        {(() => {
          const q = analyticsOrderSearch.toLowerCase();
          const allOrders = reports?.allOrders || [];
          const filtered = allOrders.filter((o: any) =>
            !q || (o.id||'').toLowerCase().includes(q) || (o.customer_name||'').toLowerCase().includes(q)
          );
          const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
          return <PaginationBar page={Math.min(analyticsOrderPage, totalPages)} totalPages={totalPages} setPage={setAnalyticsOrderPage} total={filtered.length} />;
        })()}
        <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
      </div>
    </div>
  );
}

// --- ADMIN DASHBOARD ---
// ── Column-config types ───────────────────────────────────────────────────────
interface ColDef       { key: string; label: string; visible: boolean; sortable?: boolean; }
interface ColCfgEntry  { visible: boolean; order: number; }

// ── useColumnConfig — persists per-table column visibility + order in localStorage ──
function useColumnConfig(tableId: string, defaults: ColDef[]) {
  const STORE_KEY = `as-col-${tableId}`;
  const buildDefault = (): Record<string, ColCfgEntry> =>
    Object.fromEntries(defaults.map((c, i) => [c.key, { visible: c.visible, order: i }]));

  const [cfg, setCfg] = useState<Record<string, ColCfgEntry>>(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ColCfgEntry>;
        const merged = buildDefault();
        for (const [k, v] of Object.entries(parsed)) { if (k in merged) merged[k] = v; }
        return merged;
      }
    } catch {}
    return buildDefault();
  });

  const persist = (next: Record<string, ColCfgEntry>) => {
    setCfg(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch {}
  };

  const ordered  = useMemo(() => Object.entries(cfg).sort((a,b) => a[1].order - b[1].order).map(([k]) => k), [cfg]);
  const visible  = useMemo(() => ordered.filter(k => cfg[k]?.visible), [ordered, cfg]);

  const toggle  = (key: string) => persist({ ...cfg, [key]: { ...cfg[key], visible: !cfg[key].visible } });
  const move    = (key: string, dir: 'up' | 'down') => {
    const idx     = ordered.indexOf(key);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;
    const swapKey = ordered[swapIdx];
    const next    = { ...cfg };
    next[key]     = { ...cfg[key],     order: cfg[swapKey].order };
    next[swapKey] = { ...cfg[swapKey], order: cfg[key].order     };
    persist(next);
  };
  const reset = () => persist(buildDefault());

  return { cfg, visible, ordered, toggle, move, reset };
}

// ── ColumnConfigPanel — floating popover for show/hide + reorder columns ──────
function ColumnConfigPanel({ isOpen, onClose, defaults, cfg, ordered, toggle, move, reset }: {
  isOpen: boolean; onClose: () => void;
  defaults: ColDef[];
  cfg: Record<string, ColCfgEntry>;
  ordered: string[];
  toggle: (k: string) => void;
  move: (k: string, dir: 'up' | 'down') => void;
  reset: () => void;
}) {
  if (!isOpen) return null;
  const labelOf = (key: string) => defaults.find(c => c.key === key)?.label ?? key;
  return (
    <div
      className="absolute top-full right-0 mt-2 z-[200] bg-white rounded-2xl shadow-2xl border border-[#cc5a16]/10 w-68 overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-3 bg-[#faf7f2] border-b border-[#cc5a16]/10">
        <span className="font-bold text-sm text-[#1a1208]">Configure Columns</span>
        <div className="flex items-center gap-3">
          <button onClick={reset} className="text-[11px] text-[#cc5a16] font-bold uppercase tracking-widest hover:underline">Reset</button>
          <button onClick={onClose} className="p-1 hover:bg-[#cc5a16]/10 rounded-lg transition-all">
            <X size={13} className="text-[#6b5d52]" />
          </button>
        </div>
      </div>
      <div className="px-3 py-2.5 space-y-0.5 max-h-72 overflow-y-auto">
        {ordered.map((key, idx) => {
          const isVis = cfg[key]?.visible ?? true;
          return (
            <div key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-[#faf7f2] group transition-colors">
              <button
                onClick={() => toggle(key)}
                className={cn(
                  "h-4 w-4 rounded border-2 flex items-center justify-center shrink-0 transition-all",
                  isVis ? "bg-[#cc5a16] border-[#cc5a16]" : "border-[#0d0a07]/20 bg-white"
                )}
              >
                {isVis && <Check size={9} className="text-white" />}
              </button>
              <span className="flex-1 text-sm text-[#3d3128] select-none">{labelOf(key)}</span>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => move(key, 'up')} disabled={idx === 0}
                  className="p-1 rounded hover:bg-[#cc5a16]/10 disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                  <ChevronDown size={11} className="rotate-180 text-[#6b5d52]" />
                </button>
                <button onClick={() => move(key, 'down')} disabled={idx === ordered.length - 1}
                  className="p-1 rounded hover:bg-[#cc5a16]/10 disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                  <ChevronDown size={11} className="text-[#6b5d52]" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-2 border-t border-[#cc5a16]/10 bg-[#faf7f2]/60">
        <p className="text-[11px] text-[#9c8e85]">↕ Reorder · ✓ Toggle visibility</p>
      </div>
    </div>
  );
}

// ── Monitor column defaults ───────────────────────────────────────────────────
const MONITOR_COL_DEFAULTS: ColDef[] = [
  { key: 'name',     label: 'Table',     visible: true,  sortable: true  },
  { key: 'status',   label: 'Status',    visible: true,  sortable: true  },
  { key: 'customer', label: 'Customer',  visible: true,  sortable: true  },
  { key: 'phone',    label: 'Phone',     visible: false, sortable: false },
  { key: 'duration', label: 'Duration',  visible: true,  sortable: true  },
  { key: 'bill',     label: 'Bill (₹)',  visible: true,  sortable: true  },
  { key: 'rounds',   label: 'Rounds',    visible: true,  sortable: true  },
  { key: 'capacity', label: 'Capacity',  visible: false, sortable: true  },
  { key: 'waiter',   label: 'Waiter',    visible: true,  sortable: true  },
  { key: 'actions',  label: 'Actions',   visible: true,  sortable: false },
];

function OwnerDashboard({ restaurantId, token, onRestaurantUpdate }: { restaurantId: string, token: string, onRestaurantUpdate: (name: string) => void }) {
  const [activeTab, setActiveTab] = useState<
    | 'MENU' | 'REPORTS' | 'QR' | 'STAFF' | 'SETTINGS'
    | 'ORDERS' | 'INVOICES' | 'ATTENDANCE' | 'NOTIFICATIONS'
    | 'FEEDBACK' | 'SUBSCRIPTION' | 'BOOKINGS' | 'MONITOR'
    | 'ROOMS' | 'SERVICES' | 'SERVICE_REQUESTS'   // hospitality Phase 1
    | 'HOTEL_BOOKINGS' | 'FOLIOS' | 'COMPLIANCE'  // hospitality Phase 2 & 3
    | 'CONCIERGE_FAQ'                             // hospitality Phase 4 (AI concierge)
  >('MONITOR');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notificationSettings, setNotificationSettings] = useState<any[]>([]);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [reports, setReports] = useState<any>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [tables, setTables] = useState<Table[]>([]);

  // ─── Hospitality module state (Phase 1) ─────────────────────────────────
  const [hotelRooms, setHotelRooms] = useState<any[]>([]);
  const [hotelServices, setHotelServices] = useState<any[]>([]);
  const [hotelRequests, setHotelRequests] = useState<any[]>([]);
  const [hotelLoading, setHotelLoading] = useState(false);
  const [hotelError, setHotelError] = useState<string>('');
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [editingRoom, setEditingRoom] = useState<any>(null);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [editingService, setEditingService] = useState<any>(null);
  const [roomQrPreview, setRoomQrPreview] = useState<any>(null);
  // Rooms tab filters
  const [roomStatusFilter, setRoomStatusFilter] = useState<'ALL' | 'VACANT' | 'OCCUPIED' | 'CLEANING' | 'MAINTENANCE' | 'BLOCKED'>('ALL');
  const [roomSmokingFilter, setRoomSmokingFilter] = useState<'ALL' | 'SMOKING' | 'NON_SMOKING'>('ALL');
  const [roomSearch, setRoomSearch] = useState('');
  // Phase 2 & 3 state
  const [hotelBookings, setHotelBookings] = useState<any[]>([]);
  const [hotelFolios, setHotelFolios] = useState<any[]>([]);
  const [complianceList, setComplianceList] = useState<any[]>([]);
  const [hotelAnalytics, setHotelAnalytics] = useState<any>(null);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [editingBooking, setEditingBooking] = useState<any>(null);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutBooking, setCheckoutBooking] = useState<any>(null);
  const [checkoutPayment, setCheckoutPayment] = useState<'CASH'|'CARD'|'UPI'|'BANK'>('CASH');
  const [checkoutDiscount, setCheckoutDiscount] = useState(0);
  const [viewFolio, setViewFolio] = useState<any>(null);
  // Phase 4
  const [hotelFaqs, setHotelFaqs] = useState<any[]>([]);
  const [editingFaq, setEditingFaq] = useState<any>(null);
  const [showFaqModal, setShowFaqModal] = useState(false);
  // Derived flag used to conditionally show hotel tabs + UI
  const isHotelEnabled = !!restaurant && (
    (restaurant as any).property_type === 'HOTEL' ||
    (restaurant as any).property_type === 'BOTH'
  );
  const isRestaurantEnabled = !!restaurant && (
    !(restaurant as any).property_type ||
    (restaurant as any).property_type === 'RESTAURANT' ||
    (restaurant as any).property_type === 'BOTH'
  );
  // Alerts toggle (default TRUE unless explicitly disabled in Settings)
  const alertsEnabled = !restaurant || ((restaurant as any).alerts_enabled !== 0 && (restaurant as any).alerts_enabled !== false);
  const [staff, setStaff] = useState<any[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [feedback, setFeedback] = useState<any[]>([]);
  const [loadingFeedback, setLoadingFeedback] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [liveTables, setLiveTables] = useState<LiveTableView[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveLastRefresh, setLiveLastRefresh] = useState<Date | null>(null);
  const [liveNow, setLiveNow] = useState(Date.now());
  const [liveOrders, setLiveOrders] = useState<Order[]>([]);
  const [liveOrdersExpanded, setLiveOrdersExpanded] = useState(true);
  const [viewBillTable, setViewBillTable] = useState<{ id: string; name: string } | null>(null);
  const [waiterCalls, setWaiterCalls] = useState<any[]>([]);

  // ── Audible + visual alerts for unacknowledged items (Phase 6) ────────────
  // Owner/Manager hears a chime every 4s and sees pulsing cards when:
  //   - any table has session_status === 'bill_requested'   (customer called for bill)
  //   - any service request is PENDING (hotel guest service ask)
  //   - any waiter call is 'pending' (restaurant customer pressed Call Waiter)
  // The chime stops the moment all three queues drop to zero.
  const pendingBillReqs     = liveTables.filter(t => t.session_status === 'bill_requested').length;
  const pendingServiceReqs  = hotelRequests.filter(r => r.status === 'PENDING').length;
  const pendingWaiterCalls  = waiterCalls.filter(c => c.status === 'pending').length;
  const totalPendingAlerts  = pendingBillReqs + pendingServiceReqs + pendingWaiterCalls;
  const alertLabel =
    pendingServiceReqs > 0 ? `${pendingServiceReqs} service request${pendingServiceReqs === 1 ? '' : 's'}`
    : pendingWaiterCalls > 0 ? `${pendingWaiterCalls} waiter call${pendingWaiterCalls === 1 ? '' : 's'}`
    : pendingBillReqs > 0 ? `${pendingBillReqs} bill request${pendingBillReqs === 1 ? '' : 's'}`
    : 'Alert';
  useAlertChime(alertsEnabled && totalPendingAlerts > 0, { label: alertLabel });

  // ── Monitor table controls ─────────────────────────────────────────────────
  const [monitorSearch,       setMonitorSearch]       = useState('');
  const [monitorStatusFilter, setMonitorStatusFilter] = useState<'ALL'|'AVAILABLE'|'OCCUPIED'|'NOT_AVAILABLE'|'BILL_REQUESTED'>('ALL');
  const [monitorSort,         setMonitorSort]         = useState<{ col: string; dir: 'asc'|'desc' }>({ col: 'status', dir: 'asc' });
  const [monitorColOpen,      setMonitorColOpen]      = useState(false);
  const monitorCols = useColumnConfig('monitor', MONITOR_COL_DEFAULTS);
  const [waiterCallsExpanded, setWaiterCallsExpanded] = useState(true);
  const [allWaiters, setAllWaiters] = useState<{ id: string; name: string }[]>([]);
  const [allChefs,   setAllChefs]   = useState<{ id: string; name: string }[]>([]);
  const [orderEtaEdits, setOrderEtaEdits] = useState<Record<string, string>>({});
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [isAddingStaff, setIsAddingStaff] = useState(false);

  // ── Invoice Tab State ─────────────────────────────────────────────────────
  const [invoices, setInvoices]               = useState<any[]>([]);
  const [invoiceSearch, setInvoiceSearch]     = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<'ALL'|'UNPAID'|'PAID'|'PRINTED'>('ALL');
  const [invoiceSortKey, setInvoiceSortKey]   = useState<string>('date');
  const [invoiceSortDir, setInvoiceSortDir]   = useState<'asc'|'desc'>('desc');

  // ── Owner Profile (contact info) ──────────────────────────────────────────
  const [ownerProfile, setOwnerProfile] = useState<{ name: string; email: string; phone: string }>({ name: '', email: '', phone: '' });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // ── Menu Management Enhancements ─────────────────────────────────────────────
  const [menuCatFilter, setMenuCatFilter] = useState<string>('ALL');
  const [menuSearchTerm, setMenuSearchTerm] = useState<string>('');
  const [menuViewMode, setMenuViewMode] = useState<'grid' | 'grouped'>('grouped');
  const [csvPreviewRows, setCsvPreviewRows] = useState<any[] | null>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [generatingImageId, setGeneratingImageId] = useState<string | null>(null);
  const [newItemCategoryCustom, setNewItemCategoryCustom] = useState<string>('');

  // Role-Based Tab Access Control
  const [allowedTabs, setAllowedTabs] = useState<string[] | null>(null); // null = no restriction
  const [showTemplatePanel, setShowTemplatePanel]     = useState(false);
  const [showOnDemandModal, setShowOnDemandModal]     = useState(false);
  const [printPreviewHtml, setPrintPreviewHtml]       = useState<string|null>(null);
  const [loadingInvoices, setLoadingInvoices]         = useState(false);
  const [invoiceTemplate, setInvoiceTemplate] = useState<{
    showGSTIN: boolean; showCity: boolean; showCustomerPhone: boolean;
    showPaymentMethod: boolean; showItemBreakdown: boolean; showDiscountLine: boolean;
    showThankYouNote: boolean; footerText: string;
  }>(() => {
    try { return JSON.parse(localStorage.getItem('as-invoice-tpl') || 'null') || {
      showGSTIN: true, showCity: true, showCustomerPhone: true,
      showPaymentMethod: true, showItemBreakdown: true, showDiscountLine: true,
      showThankYouNote: true, footerText: 'Thank you for your business!',
    }; } catch { return {
      showGSTIN: true, showCity: true, showCustomerPhone: true,
      showPaymentMethod: true, showItemBreakdown: true, showDiscountLine: true,
      showThankYouNote: true, footerText: 'Thank you for your business!',
    }; }
  });
  // On-demand invoice form state
  const [odInvoiceItems, setOdInvoiceItems]   = useState<{name:string;qty:number;price:number}[]>([{name:'',qty:1,price:0}]);
  const [odCustomer, setOdCustomer]           = useState({name:'',phone:'',reference:''});
  const [odDiscount, setOdDiscount]           = useState(0);
  const [odSvcPct, setOdSvcPct]               = useState(0);
  const [odGstPct, setOdGstPct]               = useState(0);
  const [odApplyGst, setOdApplyGst]           = useState(false);
  const [odSaving, setOdSaving]               = useState(false);
  const [odSearchActive, setOdSearchActive]   = useState<number | null>(null);
  // ── Invoice Delete Modal State (admin-gated feature) ──────────────────────
  const [deleteInvoiceTarget, setDeleteInvoiceTarget] = useState<any|null>(null);
  const [deleteIdConfirm, setDeleteIdConfirm]         = useState('');
  const [deleteReason, setDeleteReason]               = useState('');
  const [deletingInvoice, setDeletingInvoice]         = useState(false);
  const [deleteError, setDeleteError]                 = useState<string|null>(null);
  // ── Invoice Edit Modal State ──────────────────────────────────────────────
  const [invoiceEditTarget, setInvoiceEditTarget] = useState<any|null>(null);
  const [invEdit, setInvEdit] = useState<{
    items: {name:string; quantity:number; price:number}[];
    discount: number; svcPct: number; gstPct: number; applyGst: boolean;
    payMethod: 'CASH'|'CARD'|'UPI'; saving: boolean; markingPaid: boolean;
  }>({ items:[], discount:0, svcPct:0, gstPct:0, applyGst:false, payMethod:'CASH', saving:false, markingPaid:false });

  // ── Invoice Management State ──────────────────────────────────────────────
  const [invoiceOrder, setInvoiceOrder]       = useState<any | null>(null);
  const [invoiceMode, setInvoiceMode]         = useState<'view' | 'edit'>('view');
  const [invoiceItems, setInvoiceItems]       = useState<any[]>([]);
  const [invoiceDiscount, setInvoiceDiscount]           = useState(0);
  const [invoiceServiceCharge, setInvoiceServiceCharge] = useState(0);   // %
  const [invoiceGstPercent, setInvoiceGstPercent]       = useState(0);   // %
  const [invoiceApplyGst, setInvoiceApplyGst]           = useState(true);
  const [savingInvoice, setSavingInvoice]               = useState(false);
  const [addItemForm, setAddItemForm]                   = useState({ name: '', price: '', quantity: '1' });
  // Payment table sort + search
  const [paymentSearch, setPaymentSearch]               = useState('');
  const [paymentSort, setPaymentSort]                   = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'createdAt', dir: 'desc' });

  // ── Pagination + extra filter state for all tables ────────────────────────
  const [ordersPage, setOrdersPage]           = useState(1);
  const [ordersDateFrom, setOrdersDateFrom]   = useState('');
  const [ordersDateTo, setOrdersDateTo]       = useState('');
  const [invoicesPage, setInvoicesPage]       = useState(1);
  const [staffSearch, setStaffSearch]         = useState('');
  const [staffRoleFilter, setStaffRoleFilter] = useState<'ALL'|'CHEF'|'WAITER'|'MANAGER'>('ALL');
  const [staffPage, setStaffPage]             = useState(1);
  const [feedbackSearch, setFeedbackSearch]   = useState('');
  const [feedbackMinRating, setFeedbackMinRating] = useState(0);
  const [feedbackSortDir, setFeedbackSortDir] = useState<'asc'|'desc'>('desc');
  const [feedbackPage, setFeedbackPage]       = useState(1);

  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [editImageFile, setEditImageFile] = useState<File | null>(null);
  const [newStaff, setNewStaff] = useState({ loginId: '', name: '', password: '', role: 'CHEF' as UserRole, phone: '', email: '' });
  const [newItem, setNewItem] = useState<{ 
    name: string, 
    description: string, 
    price: string, 
    price_half: string, 
    price_full: string, 
    category: string, 
    imageFile: File | null,
    driveUrl: string,
    dietary_type: DietaryType,
    is_daily_special: boolean
  }>({ 
    name: '', 
    description: '', 
    price: '', 
    price_half: '', 
    price_full: '', 
    category: 'Mains', 
    imageFile: null,
    dietary_type: 'VEG',
    is_daily_special: false
  });

  // Fetch role-based tab permissions
  useEffect(() => {
    fetch(`/api/restaurant/${restaurantId}/my-permissions`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.allowed_tabs && Array.isArray(data.allowed_tabs) && data.allowed_tabs.length > 0) {
          setAllowedTabs(data.allowed_tabs);
        }
      })
      .catch(() => {});
  }, [restaurantId, token]);

  // Fetch owner's own profile (name, email, phone) for SETTINGS tab
  const fetchOwnerProfile = async () => {
    try {
      const res = await fetch('/api/owner/profile', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setOwnerProfile({ name: data.name || '', email: data.email || '', phone: data.phone || '' });
      }
    } catch (err) {
      console.error('Failed to fetch owner profile:', err);
    }
  };

  const updateOwnerProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    try {
      const res = await fetch('/api/owner/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(ownerProfile)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update profile');
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setProfileSaving(false);
    }
  };

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchMenu();
    fetchReports();
    fetchRestaurant();
    fetchTables();
    fetchStaff();
    fetchOrders();
    fetchOwnerProfile();
    if (activeTab === 'FEEDBACK') fetchFeedback();
    if (activeTab === 'NOTIFICATIONS') fetchNotificationSettings();
    if (activeTab === 'MONITOR') fetchLiveTables();
    if (activeTab === 'INVOICES') fetchInvoices();

    const interval = setInterval(() => {
      fetchOrders();
      if (activeTab === 'REPORTS') fetchReports();
      if (activeTab === 'MONITOR') fetchLiveTables();
      if (activeTab === 'INVOICES') fetchInvoices();
    }, 30000);

    // Per-second clock tick — only needed on MONITOR tab (live visit timers).
    // Running this on other tabs caused every child component to re-render
    // every second, which in turn made Framer-Motion entry animations flash
    // on Analytics KPI cards (they were unmount/remount due to nested
    // component definition).
    let clockTick: ReturnType<typeof setInterval> | undefined;
    if (activeTab === 'MONITOR') {
      clockTick = setInterval(() => setLiveNow(Date.now()), 1000);
    }

    return () => {
      clearInterval(interval);
      if (clockTick) clearInterval(clockTick);
    };
  }, [restaurantId, activeTab]);

  // ── Invoice helpers ───────────────────────────────────────────────────────
  const openInvoice = async (order: any, mode: 'view' | 'edit' = 'view') => {
    // Fetch fresh invoice detail (includes discount_amount + apply_gst)
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/orders/${order.id}/invoice`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setInvoiceOrder({ ...order, ...data });
      setInvoiceItems(items.map((it: any) => ({ ...it })));
      setInvoiceDiscount(Number(data.discount_amount || 0));
      setInvoiceServiceCharge(Number(data.service_charge_percent || 0));
      setInvoiceGstPercent(Number(data.gst_percent ?? restaurant?.gst_percentage ?? 0));
      setInvoiceApplyGst(Number(data.apply_gst ?? 0) !== 0);
      setInvoiceMode(mode);
      setAddItemForm({ name: '', price: '', quantity: '1' });
    } catch {
      // Fallback to local data
      const items = Array.isArray(order.items) ? order.items : [];
      setInvoiceOrder(order);
      setInvoiceItems(items.map((it: any) => ({ ...it })));
      setInvoiceDiscount(Number(order.discount_amount || 0));
      setInvoiceServiceCharge(Number(order.service_charge_percent || 0));
      setInvoiceGstPercent(Number(restaurant?.gst_percentage ?? 0));
      setInvoiceApplyGst(Boolean(restaurant?.is_gst_enabled));
      setInvoiceMode(mode);
      setAddItemForm({ name: '', price: '', quantity: '1' });
    }
  };

  const closeInvoice = () => { setInvoiceOrder(null); setInvoiceMode('view'); };

  const saveInvoice = async () => {
    if (!invoiceOrder) return;
    setSavingInvoice(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/orders/${invoiceOrder.id}/invoice`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: invoiceItems, discount_amount: invoiceDiscount, service_charge_percent: invoiceServiceCharge, gst_percent: invoiceGstPercent, apply_gst: invoiceApplyGst ? 1 : 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setOrders(prev => prev.map(o => o.id === invoiceOrder.id
        ? { ...o, totalAmount: data.total, gstAmount: data.gst_amount, items: invoiceItems, discount_amount: invoiceDiscount }
        : o
      ));
      setInvoiceOrder((prev: any) => prev ? { ...prev, totalAmount: data.total, gstAmount: data.gst_amount } : null);
      setInvoiceMode('view');
    } catch (err: any) {
      console.error('Save invoice error:', err.message);
    } finally {
      setSavingInvoice(false);
    }
  };

  const printInvoiceOrder = (
    order: any, items: any[], discount: number, applyGst: boolean,
    serviceChargePct: number = 0, gstPct: number = 0
  ) => {
    const dt            = new Date(order.createdAt || order.created_at || Date.now());
    const rawSubtotal   = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
    const afterDiscount = Math.max(0, rawSubtotal - discount);
    const svcAmt        = afterDiscount * serviceChargePct / 100;
    const taxable       = afterDiscount + svcAmt;
    const effGstRate    = applyGst ? gstPct : 0;
    const gstAmt        = taxable * effGstRate / 100;
    const total         = taxable + gstAmt;
    const html = buildThermalHTML({
      restaurantName:       restaurant?.name || 'Restaurant',
      gstin:                restaurant?.gst_number,
      gstEnabled:           applyGst && effGstRate > 0,
      gstPercent:           effGstRate,
      billId:               (order.id || '').slice(-8).toUpperCase(),
      tableName:            order.tableNumber || order.table_number || undefined,
      customerName:         order.customerName || order.customer_name || undefined,
      customerPhone:        order.customerPhone || order.customer_phone || undefined,
      date:                 dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      time:                 dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      rounds:               [{ items: items.map(it => ({ name: it.name || it.item_name || '', qty: Number(it.quantity || 1), price: Number(it.price || 0) })) }],
      subtotal:             afterDiscount,
      discountAmount:       discount > 0 ? discount : undefined,
      serviceChargeAmount:  svcAmt > 0 ? svcAmt : undefined,
      serviceChargePercent: serviceChargePct > 0 ? serviceChargePct : undefined,
      gstAmount:            gstAmt,
      total,
      paymentMethod:        order.paymentMethod || order.payment_method || undefined,
    });
    openThermalPrint(html);
  };

  const fetchOrders = async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/orders`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const rawOrders = await res.json();
          setOrders(rawOrders.map(normalizeOrder));
        }
      }
    } catch (err) {
      console.error("Failed to fetch orders", err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const fetchFeedback = async () => {
    setLoadingFeedback(true);
    try {
      const res = await fetch(`/api/owner/feedback`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setFeedback(await res.json());
        }
      }
    } catch (err) {
      console.error("Failed to fetch feedback", err);
    } finally {
      setLoadingFeedback(false);
    }
  };

  const requestFeedback = async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/request-feedback`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ restaurantId })
      });
      if (res.ok) {
        alert("Feedback request sent to customer!");
        fetchOrders();
      }
    } catch (err) {
      console.error("Failed to request feedback", err);
    }
  };

  const fetchStaff = async () => {
    try {
      const res = await fetch('/api/owner/staff', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setStaff(await res.json());
        }
      }
    } catch (err) {
      console.error("Failed to fetch staff", err);
    }
  };

  const fetchNotificationSettings = async () => {
    try {
      const res = await fetch('/api/owner/notification-settings', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setNotificationSettings(await res.json());
        }
      }
    } catch (err) {
      console.error("Failed to fetch notification settings", err);
    }
  };

  const updateNotificationSetting = async (eventName: string, field: string, value: boolean) => {
    setIsSavingSettings(true);
    try {
      const current = notificationSettings.find(s => s.event_name === eventName) || {
        event_name: eventName,
        whatsapp_enabled: 0,
        sms_enabled: 0,
        email_enabled: 0
      };
      
      const payload = {
        ...current,
        [field]: value ? 1 : 0
      };

      const res = await fetch('/api/owner/notification-settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        fetchNotificationSettings();
      }
    } catch (err) {
      console.error("Failed to update notification setting", err);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/owner/staff', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(newStaff)
      });
      if (res.ok) {
        setIsAddingStaff(false);
        setNewStaff({ loginId: '', name: '', password: '', role: 'CHEF', phone: '', email: '' });
        setTimeout(() => fetchStaff(), 100);
      } else {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await res.json();
          alert(data.error || "Failed to add staff");
        } else {
          alert("Failed to add staff: " + (await res.text()));
        }
      }
    } catch (err) {
      console.error("Failed to add staff", err);
    }
  };

  const removeStaff = async (id: string) => {
    if (!confirm("Are you sure you want to remove this staff member?")) return;
    try {
      await fetch(`/api/owner/staff/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchStaff();
    } catch (err) {
      console.error("Failed to remove staff", err);
    }
  };

  const fetchTables = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/tables`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setTables(await res.json());
        }
      }
    } catch (err) {
      console.error("Failed to fetch tables", err);
    }
  };

  const fetchInvoices = async () => {
    setLoadingInvoices(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/invoices`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        // Do NOT run normalizeOrder — session invoices have their own shape
        const raw = await res.json();
        setInvoices(raw.map((inv: any) => ({
          ...inv,
          // Normalise field aliases for ORDER-type invoices only
          ...(inv.invoice_type === 'ORDER' ? {
            customerName:  inv.customer_name  || inv.customerName  || '',
            customerPhone: inv.customer_phone || inv.customerPhone || '',
            tableNumber:   inv.table_number   || inv.tableNumber   || '',
            totalAmount:   Number(inv.total_amount ?? inv.totalAmount ?? 0),
            createdAt:     inv.created_at     || inv.createdAt,
          } : {
            // SESSION invoice — keep as-is, just alias for convenience
            customerName:  inv.customer_name  || '',
            customerPhone: inv.customer_phone || '',
            tableNumber:   inv.table_number   || '',
            totalAmount:   Number(inv.total_amount ?? 0),
            createdAt:     inv.created_at,
          }),
        })));
      }
    } catch {}
    finally { setLoadingInvoices(false); }
  };

  // ── Invoice deletion (admin-gated per-tenant) ─────────────────────────────
  // Returns true if this invoice row is in a state safe to delete: PRINTED,
  // PAID, or its order status is DELIVERED/CANCELLED. Active in-kitchen orders
  // can never be deleted.
  const isInvoiceDeletable = (inv: any): boolean => {
    if (!inv) return false;
    const isSession = inv.invoice_type === 'SESSION';
    const sessClosed = isSession && (inv.session_status === 'closed' || inv.session_status === 'bill_requested');
    const orderDone = !isSession && (
      String(inv.status || '').toUpperCase() === 'DELIVERED' ||
      String(inv.status || '').toUpperCase() === 'CANCELLED' ||
      String(inv.payment_status || '').toUpperCase() === 'PAID'
    );
    const printed = String(inv.invoice_status || '').toUpperCase() === 'PRINTED';
    return sessClosed || orderDone || printed;
  };

  const openDeleteInvoiceModal = (inv: any) => {
    setDeleteInvoiceTarget(inv);
    setDeleteIdConfirm('');
    setDeleteReason('');
    setDeleteError(null);
  };

  const confirmDeleteInvoice = async () => {
    if (!deleteInvoiceTarget || !restaurantId || !token) return;
    setDeletingInvoice(true);
    setDeleteError(null);
    try {
      const isSession = deleteInvoiceTarget.invoice_type === 'SESSION';
      const url = isSession
        ? `/api/restaurant/${restaurantId}/invoice/session/${deleteInvoiceTarget.session_token || deleteInvoiceTarget.session_db_id || deleteInvoiceTarget.id}`
        : `/api/restaurant/${restaurantId}/invoice/order/${deleteInvoiceTarget.id}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ reason: deleteReason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      // Remove from local list immediately
      setInvoices(prev => prev.filter((x: any) => x.id !== deleteInvoiceTarget.id));
      setDeleteInvoiceTarget(null);
      // Refresh from server to be safe
      fetchInvoices();
    } catch (err: any) {
      setDeleteError(err?.message || 'Failed to delete invoice');
    } finally {
      setDeletingInvoice(false);
    }
  };

  // Update invoice status — routes to session or order endpoint by type
  const patchInvoiceStatus = async (inv: any, status: 'DRAFT'|'APPROVED'|'PRINTED') => {
    if (inv.invoice_type === 'SESSION') {
      await fetch(`/api/restaurant/${restaurantId}/sessions/${inv.session_token}/invoice-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ invoice_status: status }),
      });
    } else {
      await fetch(`/api/orders/${inv.id}/invoice-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ invoice_status: status, restaurantId }),
      });
    }
    fetchInvoices();
  };

  // Build thermal invoice HTML — handles SESSION (multi-round) and ORDER (single) correctly
  const buildInvoiceHTML = (inv: any, tpl: typeof invoiceTemplate): string => {
    const dt = new Date(inv.createdAt || inv.created_at || Date.now());
    const dateStr = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const disc    = Number(inv.discount_amount || 0);
    const svcPct  = Number(inv.service_charge_percent || 0);
    const gstPct  = Number(inv.gst_percent || 0);
    const applyGst = inv.apply_gst !== 0 && inv.apply_gst !== false;

    // For SESSION invoices: use rounds array from server (per-round item groups)
    // For ORDER invoices: single round with all items
    let rounds: { label?: string; items: { name: string; qty: number; price: number }[] }[];
    let rawSubtotal: number;

    if (inv.invoice_type === 'SESSION' && Array.isArray(inv.rounds) && inv.rounds.length > 0) {
      rounds = inv.rounds; // already shaped by server
      rawSubtotal = inv.raw_subtotal ?? (inv.rounds as any[]).reduce((s: number, r: any) =>
        s + (r.items||[]).reduce((rs: number, it: any) => rs + Number(it.price||0)*Number(it.qty||it.quantity||1), 0), 0);
    } else {
      const items = Array.isArray(inv.items) ? inv.items : [];
      rawSubtotal = items.reduce((s: number, it: any) => s + Number(it.price||0)*Number(it.quantity||1), 0);
      rounds = [{ items: items.map((it: any) => ({ name: it.name||'', qty: Number(it.quantity||1), price: Number(it.price||0) })) }];
    }

    const after   = Math.max(0, rawSubtotal - disc);
    const svcAmt  = after * svcPct / 100;
    const taxable = after + svcAmt;
    const gstAmt  = applyGst ? taxable * gstPct / 100 : 0;
    const total   = Number((taxable + gstAmt).toFixed(2));

    return buildThermalHTML({
      restaurantName:       restaurant?.name || 'Restaurant',
      gstin:                tpl.showGSTIN ? restaurant?.gst_number : undefined,
      gstEnabled:           applyGst,
      gstPercent:           gstPct,
      billId:               String(inv.id).slice(-8).toUpperCase(),
      tableName:            inv.tableNumber || inv.table_number,
      customerName:         inv.customerName || inv.customer_name || undefined,
      customerPhone:        tpl.showCustomerPhone ? (inv.customerPhone || inv.customer_phone || undefined) : undefined,
      date:                 dateStr,
      time:                 timeStr,
      rounds,
      subtotal:             rawSubtotal,
      discountAmount:       tpl.showDiscountLine && disc > 0 ? disc : undefined,
      serviceChargeAmount:  svcAmt > 0 ? svcAmt : undefined,
      serviceChargePercent: svcPct > 0 ? svcPct : undefined,
      gstAmount:            gstAmt,
      total,
      paymentMethod:        tpl.showPaymentMethod ? (inv.paymentMethod || inv.payment_method || undefined) : undefined,
      footerNote:           tpl.showThankYouNote ? (tpl.footerText || 'Thank you!') : undefined,
    });
  };

  // ── Invoice Edit helpers ──────────────────────────────────────────────────

  const openInvoiceEdit = (inv: any) => {
    setInvoiceEditTarget(inv);
    setInvEdit({
      items: Array.isArray(inv.items)
        ? inv.items.map((it: any) => ({ name: it.name||'', quantity: Number(it.quantity||1), price: Number(it.price||0) }))
        : [],
      discount:  Number(inv.discount_amount || 0),
      svcPct:    Number(inv.service_charge_percent || 0),
      gstPct:    Number(inv.gst_percent || 0),
      applyGst:  inv.apply_gst !== 0 && inv.apply_gst !== false,
      payMethod: 'CASH',
      saving:    false,
      markingPaid: false,
    });
  };

  const saveInvoiceEdit = async () => {
    const inv = invoiceEditTarget;
    if (!inv) return;
    setInvEdit(p => ({ ...p, saving: true }));
    try {
      if (inv.invoice_type === 'SESSION') {
        // For sessions: only adjustments (items live on individual orders)
        const rawSub  = Number(inv.raw_subtotal || 0);
        const after   = Math.max(0, rawSub - invEdit.discount);
        const svc     = after * invEdit.svcPct / 100;
        const taxable = after + svc;
        const gst     = invEdit.applyGst ? taxable * invEdit.gstPct / 100 : 0;
        const grand   = Number((taxable + gst).toFixed(2));
        await fetch(`/api/restaurant/${restaurantId}/sessions/${inv.session_token}/invoice`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            discount_amount: invEdit.discount, service_charge_percent: invEdit.svcPct,
            gst_percent: invEdit.gstPct, apply_gst: invEdit.applyGst ? 1 : 0, final_amount: grand,
          }),
        });
      } else {
        // For individual orders: items + adjustments
        await fetch(`/api/restaurant/${restaurantId}/orders/${inv.id}/invoice`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            items: invEdit.items,
            discount_amount: invEdit.discount, service_charge_percent: invEdit.svcPct,
            gst_percent: invEdit.gstPct, apply_gst: invEdit.applyGst ? 1 : 0,
          }),
        });
      }
      setInvoiceEditTarget(null);
      fetchInvoices();
    } catch (err) { console.error('Invoice save error', err); }
    finally { setInvEdit(p => ({ ...p, saving: false })); }
  };

  const markInvoicePaid = async (inv: any, payMethod: string) => {
    setInvEdit(p => ({ ...p, markingPaid: true }));
    try {
      if (inv.invoice_type === 'SESSION') {
        const rawSub  = Number(inv.raw_subtotal || 0);
        const disc    = Number(inv.discount_amount || invEdit.discount || 0);
        const svcPct  = Number(inv.service_charge_percent || invEdit.svcPct || 0);
        const after   = Math.max(0, rawSub - disc);
        const svc     = after * svcPct / 100;
        const taxable = after + svc;
        const gstPct  = Number(inv.gst_percent || invEdit.gstPct || 0);
        const applyGst = inv.apply_gst !== 0;
        const gst     = applyGst ? taxable * gstPct / 100 : 0;
        const grand   = Number((taxable + gst).toFixed(2));
        await fetch(`/api/restaurant/${restaurantId}/sessions/${inv.session_token}/close`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ payment_method: payMethod, final_amount: grand }),
        });
      } else {
        await fetch(`/api/orders/${inv.id}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ status: 'PAID', restaurantId }),
        });
      }
      setInvoiceEditTarget(null);
      fetchInvoices();
      fetchLiveTables(); // refresh Command Center so closed table clears immediately
    } catch (err) { console.error('Mark paid error', err); }
    finally { setInvEdit(p => ({ ...p, markingPaid: false })); }
  };

  const fetchLiveTables = async () => {
    setLiveLoading(true);
    try {
      const [tablesRes, ordersRes, callsRes, staffRes] = await Promise.all([
        fetch(`/api/restaurant/${restaurantId}/tables/live`,   { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/restaurant/${restaurantId}/orders/live`,   { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/restaurant/${restaurantId}/waiter-calls`,  { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/owner/staff`,                              { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      if (tablesRes.ok) {
        const data = await tablesRes.json();
        setLiveTables(data);
        setLiveLastRefresh(new Date());
      }
      if (ordersRes.ok) {
        const raw = await ordersRes.json();
        setLiveOrders(raw.map(normalizeOrder));
      }
      if (callsRes.ok) {
        setWaiterCalls(await callsRes.json());
      }
      if (staffRes.ok) {
        const staff = await staffRes.json();
        setAllWaiters(staff.filter((s: any) => s.role === 'WAITER').map((s: any) => ({ id: s.id, name: s.name })));
        setAllChefs(staff.filter((s: any) => ['CHEF','OWNER','MANAGER'].includes(s.role)).map((s: any) => ({ id: s.id, name: s.name })));
      }
    } catch (err) {
      console.error("Failed to fetch live tables", err);
    } finally {
      setLiveLoading(false);
    }
  };

  const patchLiveOrder = async (id: string, body: Record<string, any>) => {
    try {
      await fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      fetchLiveTables();
    } catch (err) {
      console.error("Failed to patch order", err);
    }
  };

  const printKitchenOrder = (o: any) => {
    // Look up waiter from liveTables by matching table name
    const tableData = liveTables.find(lt => lt.name === String(o.tableNumber) || lt.name === o.table_name);
    const waiterName = tableData?.assigned_waiter_name || '';
    const dt = new Date(o.createdAt || o.created_at);
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const html = buildKitchenSlipHTML({
      orderId:      String(o.id),
      tableNumber:  o.tableNumber || o.table_number,
      roundNumber:  o.round_number,
      customerName: o.customerName || o.customer_name,
      waiterName,
      chefName:     o.chef_name,
      eta:          o.eta,
      orderTime:    timeStr,
      items:        (Array.isArray(o.items) ? o.items : []).map((it: any) => ({
        name:     it.name || it.item_name || '',
        quantity: Number(it.quantity || 1),
        size:     it.size || it.item_size || '',
      })),
      restaurantName: restaurant?.name,
    });
    openThermalPrint(html);
  };

  const updateTableStatus = async (tableId: string, status: TableStatus) => {
    try {
      await fetch(`/api/restaurant/${restaurantId}/tables/${tableId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status })
      });
      fetchLiveTables();
    } catch (err) {
      console.error("Failed to update table status", err);
    }
  };

  const assignWaiter = async (tableId: string, waiterId: string | null) => {
    try {
      await fetch(`/api/restaurant/${restaurantId}/tables/${tableId}/assign-waiter`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ waiter_id: waiterId })
      });
      fetchLiveTables();
    } catch (err) {
      console.error("Failed to assign waiter", err);
    }
  };

  const patchWaiterCall = async (callId: string, body: Record<string, any>) => {
    await fetch(`/api/restaurant/${restaurantId}/waiter-calls/${callId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    }).catch(console.error);
    fetchLiveTables();
  };

  const updateTableName = async (tableId: string, name: string) => {
    try {
      await fetch(`/api/restaurant/${restaurantId}/tables/${tableId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name })
      });
      fetchTables();
    } catch (err) {
      console.error("Failed to update table name", err);
    }
  };

  const syncTables = async (count: number) => {
    try {
      await fetch(`/api/restaurant/${restaurantId}/tables/sync`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ count })
      });
      fetchTables();
    } catch (err) {
      console.error("Failed to sync tables", err);
    }
  };

  const fetchRestaurant = async () => {
    if (!restaurantId || typeof restaurantId !== 'string' || restaurantId === 'null' || restaurantId === 'undefined' || restaurantId === '[object Object]') return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setRestaurant(await res.json());
        }
      }
    } catch (err) {
      // Silent error
    }
  };

  // ─── Hospitality module: API helpers ─────────────────────────────────────
  const hotelApi = async (path: string, init: RequestInit = {}): Promise<any> => {
    const res = await fetch(`/api/restaurant/${restaurantId}/hotel${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  };

  const toggleHotelModule = async (enabled: boolean) => {
    setHotelLoading(true); setHotelError('');
    try {
      const result = await hotelApi('/enable', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      await fetchRestaurant();
      if (enabled) { await fetchHotelRooms(); await fetchHotelServices(); }
      return result;
    } catch (err: any) {
      setHotelError(err.message);
      throw err;
    } finally {
      setHotelLoading(false);
    }
  };

  const fetchHotelRooms = async () => {
    if (!isHotelEnabled) return;
    try { setHotelRooms(await hotelApi('/rooms')); } catch (err: any) { setHotelError(err.message); }
  };
  const fetchHotelServices = async () => {
    if (!isHotelEnabled) return;
    try { setHotelServices(await hotelApi('/services')); } catch (err: any) { setHotelError(err.message); }
  };
  const fetchHotelRequests = async () => {
    if (!isHotelEnabled) return;
    try { setHotelRequests(await hotelApi('/service-requests?status=PENDING,ACKNOWLEDGED,IN_PROGRESS')); } catch (err: any) { setHotelError(err.message); }
  };

  const saveRoom = async (data: any) => {
    const isNew = !data.id || !hotelRooms.some(r => r.id === data.id);
    if (isNew) {
      await hotelApi('/rooms', { method: 'POST', body: JSON.stringify(data) });
    } else {
      await hotelApi(`/rooms/${data.id}`, { method: 'PATCH', body: JSON.stringify(data) });
    }
    await fetchHotelRooms();
  };
  const deleteRoom = async (roomId: string) => {
    if (!confirm('Delete this room?')) return;
    await hotelApi(`/rooms/${roomId}`, { method: 'DELETE' });
    await fetchHotelRooms();
  };
  const updateRoomStatus = async (roomId: string, status: string) => {
    await hotelApi(`/rooms/${roomId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await fetchHotelRooms();
  };

  const saveService = async (data: any) => {
    const isNew = !data.id;
    if (isNew) {
      await hotelApi('/services', { method: 'POST', body: JSON.stringify(data) });
    } else {
      await hotelApi(`/services/${data.id}`, { method: 'PATCH', body: JSON.stringify(data) });
    }
    await fetchHotelServices();
  };
  const deleteService = async (serviceId: string) => {
    if (!confirm('Delete this service?')) return;
    await hotelApi(`/services/${serviceId}`, { method: 'DELETE' });
    await fetchHotelServices();
  };

  const updateRequestStatus = async (requestId: string, status: string) => {
    await hotelApi(`/service-requests/${requestId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await fetchHotelRequests();
  };

  // ─── Phase 2 & 3: bookings, folios, compliance, analytics ────────────────
  const fetchHotelBookings = async () => {
    if (!isHotelEnabled) return;
    try { setHotelBookings(await hotelApi('/bookings')); } catch (err: any) { setHotelError(err.message); }
  };
  const fetchHotelFolios = async () => {
    if (!isHotelEnabled) return;
    try { setHotelFolios(await hotelApi('/folios')); } catch (err: any) { setHotelError(err.message); }
  };
  const fetchComplianceList = async () => {
    if (!isHotelEnabled) return;
    try { setComplianceList(await hotelApi('/compliance/foreign-guests')); } catch (err: any) { setHotelError(err.message); }
  };
  const fetchHotelAnalytics = async () => {
    if (!isHotelEnabled) return;
    try { setHotelAnalytics(await hotelApi('/analytics')); } catch (err: any) { setHotelError(err.message); }
  };
  const saveBooking = async (data: any) => {
    const isNew = !data.id;
    if (isNew) await hotelApi('/bookings', { method: 'POST', body: JSON.stringify(data) });
    else await hotelApi(`/bookings/${data.id}`, { method: 'PATCH', body: JSON.stringify(data) });
    await fetchHotelBookings();
  };
  const checkInBooking = async (bookingId: string) => {
    await hotelApi(`/bookings/${bookingId}/checkin`, { method: 'POST', body: JSON.stringify({}) });
    await fetchHotelBookings();
    await fetchHotelRooms();
  };
  const checkOutBooking = async (bookingId: string, payment: string, discount: number) => {
    const result = await hotelApi(`/bookings/${bookingId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ payment_method: payment, discount }),
    });
    await fetchHotelBookings();
    await fetchHotelRooms();
    return result;
  };
  const cancelBooking = async (bookingId: string) => {
    if (!confirm('Cancel this booking?')) return;
    await hotelApi(`/bookings/${bookingId}/cancel`, { method: 'POST', body: JSON.stringify({}) });
    await fetchHotelBookings();
  };
  const loadFolio = async (folioId: string) => {
    try {
      const folio = await hotelApi(`/folios/${folioId}`);
      setViewFolio(folio);
    } catch (err: any) { alert(err.message); }
  };
  const draftFormC = async (bookingId: string) => {
    await hotelApi(`/compliance/form-c/${bookingId}`, { method: 'POST', body: JSON.stringify({}) });
    await fetchComplianceList();
  };
  const downloadFormCPdf = async (booking: any) => {
    try {
      // Ensure we have a logged draft first so reference number is captured in the PDF
      await hotelApi(`/compliance/form-c/${booking.id}`, { method: 'POST', body: JSON.stringify({}) });
      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/compliance/form-c/${booking.id}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to generate PDF');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FormC-${(booking.guest_name || 'guest').replace(/\s+/g,'-')}-${booking.id}.pdf`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      await fetchComplianceList();
    } catch (err: any) {
      alert(err.message || 'Failed to download Form-C PDF');
    }
  };

  // Phase 4: FAQ + sentiment
  const fetchHotelFaqs = async () => {
    if (!isHotelEnabled) return;
    try { setHotelFaqs(await hotelApi('/concierge/faqs')); } catch (err: any) { setHotelError(err.message); }
  };
  const saveFaq = async (data: any) => {
    const isNew = !data.id;
    if (isNew) await hotelApi('/concierge/faqs', { method: 'POST', body: JSON.stringify(data) });
    else await hotelApi(`/concierge/faqs/${data.id}`, { method: 'PATCH', body: JSON.stringify(data) });
    await fetchHotelFaqs();
  };
  const deleteFaq = async (id: string) => {
    if (!confirm('Delete this FAQ?')) return;
    await hotelApi(`/concierge/faqs/${id}`, { method: 'DELETE' });
    await fetchHotelFaqs();
  };
  useEffect(() => {
    if (!isHotelEnabled) return;
    if (activeTab === 'ROOMS') fetchHotelRooms();
    if (activeTab === 'SERVICES') fetchHotelServices();
    if (activeTab === 'SERVICE_REQUESTS') fetchHotelRequests();
    if (activeTab === 'HOTEL_BOOKINGS') { fetchHotelBookings(); fetchHotelRooms(); }
    if (activeTab === 'FOLIOS') fetchHotelFolios();
    if (activeTab === 'COMPLIANCE') fetchComplianceList();
    if (activeTab === 'CONCIERGE_FAQ') fetchHotelFaqs();
    if (activeTab === 'REPORTS' && isHotelEnabled) fetchHotelAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isHotelEnabled]);

  const updateRestaurant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant) return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          name: restaurant.name,
          gst_number: restaurant.gst_number,
          gst_percentage: restaurant.gst_percentage,
          is_gst_enabled: restaurant.is_gst_enabled,
          template_id: restaurant.template_id,
          table_count: restaurant.table_count,
          upi_id: restaurant.upi_id,
          checkout_mode: restaurant.checkout_mode || 'postpaid',
          menu_display_mode: (restaurant as any).menu_display_mode || 'PHOTO',
          alerts_enabled: (restaurant as any).alerts_enabled !== 0 && (restaurant as any).alerts_enabled !== false,
        })
      });
      if (!res.ok) throw new Error("Failed to update settings");
      await syncTables(restaurant.table_count || 0);
      onRestaurantUpdate(restaurant.name);
      fetchRestaurant();
    } catch (error: any) {
      console.error("Error updating settings:", error.message);
    }
  };

  const fetchMenu = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/menu`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await res.json();
          console.log("OwnerDashboard: Fetched menu items:", data.length);
          setMenu(data);
        }
      } else {
        console.error("OwnerDashboard: Failed to fetch menu:", res.status, res.statusText);
      }
    } catch (err) {
      console.error("OwnerDashboard: Error fetching menu:", err);
    }
  };

  const fetchReports = async (from?: string, to?: string) => {
    try {
      const f = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const t = to   || new Date().toISOString().slice(0, 10);
      const res = await fetch(`/api/restaurant/${restaurantId}/reports?from=${f}&to=${t}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setReports(await res.json());
        }
      }
    } catch (err) {
      console.error("Error fetching reports:", err);
    }
  };

  const downloadQR = (id: string, fileName: string) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    if (!canvas) return;
    
    // Create a temporary canvas to add the table name label
    const tempCanvas = document.createElement('canvas');
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return;
    
    const qrSize = 256; // We'll use a larger size for better quality
    const padding = 40;
    const labelHeight = 60;
    
    tempCanvas.width = qrSize + (padding * 2);
    tempCanvas.height = qrSize + (padding * 2) + labelHeight;
    
    // Background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    // Draw QR Code
    ctx.drawImage(canvas, padding, padding, qrSize, qrSize);
    
    // Draw Label
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 24px serif';
    ctx.textAlign = 'center';
    ctx.fillText(fileName.replace(/_/g, ' ').toUpperCase(), tempCanvas.width / 2, qrSize + padding + 40);
    
    const url = tempCanvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `${fileName}.png`;
    link.href = url;
    link.click();
  };

  const downloadAllQRs = () => {
    // Download Online Order QR
    downloadQR('qr-online', 'online_order');
    
    // Download Table QRs
    tables.forEach((table, i) => {
      setTimeout(() => {
        downloadQR(`qr-table-${table.id}`, table.name.replace(/\s+/g, '_').toLowerCase());
      }, i * 200);
    });
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData();
    formData.append('name', newItem.name);
    formData.append('description', newItem.description);
    formData.append('price', newItem.price_full || newItem.price);
    formData.append('price_half', newItem.price_half);
    formData.append('price_full', newItem.price_full || newItem.price);
    formData.append('category', newItem.category);
    formData.append('dietary_type', newItem.dietary_type);
    formData.append('is_daily_special', String(newItem.is_daily_special));
    if (newItem.driveUrl) {
      formData.append('drive_url', newItem.driveUrl);
    }
    if (newItem.imageFile) {
      formData.append('image', newItem.imageFile);
    }

    const res = await fetch(`/api/restaurant/${restaurantId}/menu`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    if (res.ok) {
      console.log("Successfully added menu item");
      setIsAddingItem(false);
      setNewItem({ 
        name: '', 
        description: '', 
        price: '', 
        price_half: '', 
        price_full: '', 
        category: 'Mains', 
        imageFile: null,
        driveUrl: '',
        dietary_type: 'VEG',
        is_daily_special: false
      });
      fetchMenu();
    } else {
      const errorData = await res.json();
      console.error("Failed to add menu item:", errorData.error);
      alert(`Failed to add item: ${errorData.error}`);
    }
  };

  const handleDeleteItem = async (id: string) => {
    await fetch(`/api/menu/${id}`, { 
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    fetchMenu();
  };

  const handleUpdatePrice = async (id: string, price: number) => {
    await fetch(`/api/menu/${id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ price })
    });
    fetchMenu();
  };

  const handleUpdateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem) return;

    if (editImageFile) {
      // Send as multipart/form-data when a new image is selected
      const fd = new FormData();
      fd.append('name', editingItem.name);
      fd.append('price_half', String(editingItem.price_half ?? ''));
      fd.append('price_full', String(editingItem.price_full));
      fd.append('price', String(editingItem.price_full));
      fd.append('dietary_type', editingItem.dietary_type);
      fd.append('description', editingItem.description || '');
      fd.append('category', editingItem.category);
      fd.append('image', editImageFile);
      await fetch(`/api/menu/${editingItem.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` },
        body: fd
      });
    } else {
      await fetch(`/api/menu/${editingItem.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          name: editingItem.name,
          price_half: editingItem.price_half,
          price_full: editingItem.price_full,
          price: editingItem.price_full,
          dietary_type: editingItem.dietary_type,
          description: editingItem.description,
          category: editingItem.category
        })
      });
    }
    setEditingItem(null);
    setEditImageFile(null);
    fetchMenu();
  };

  const handleToggleDailySpecial = async (id: string, is_daily_special: boolean) => {
    await fetch(`/api/menu/${id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ is_daily_special: is_daily_special ? 1 : 0 })
    });
    fetchMenu();
  };

  const handleToggleAvailability = async (id: string, available: boolean) => {
    await fetch(`/api/menu/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ is_available: available ? 1 : 0 })
    });
    fetchMenu();
  };

  // ── Menu CSV Export ───────────────────────────────────────────────────────
  const handleMenuExportCsv = () => {
    const header = 'name,category,description,dietary_type,price_half,price_full,is_daily_special';
    const rows = menu.map(item => [
      `"${(item.name||'').replace(/"/g,'""')}"`,
      `"${(item.category||'').replace(/"/g,'""')}"`,
      `"${(item.description||'').replace(/"/g,'""')}"`,
      item.dietary_type || 'VEG',
      item.price_half != null ? item.price_half : '',
      item.price_full || item.price || '',
      item.is_daily_special ? 'true' : 'false',
    ].join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `menu_${restaurantId}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Menu CSV Template Download ────────────────────────────────────────────
  const handleMenuTemplateCsv = () => {
    const csv = `name,category,description,dietary_type,price_half,price_full,is_daily_special
"Butter Chicken","Mains","Rich creamy tomato-based curry","NON_VEG",180,320,false
"Dal Makhani","Mains","Slow-cooked black lentils in butter","VEG",150,280,false
"Paneer Tikka","Starters","Grilled cottage cheese with spices","VEG",120,220,true
"Masala Chai","Drinks","Spiced Indian tea","VEG",,60,false
"Gulab Jamun","Desserts","Soft milk-solid dumplings in syrup","VEG",,80,false`;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = 'menu_template.csv'; a.click(); URL.revokeObjectURL(url);
  };

  // ── CSV File Parse ────────────────────────────────────────────────────────
  const handleCsvFileParse = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) { alert('CSV file appears empty or has no data rows.'); return; }
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim().toLowerCase());
      const rows: any[] = [];
      for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        // Simple CSV split that handles quoted fields
        const vals: string[] = [];
        let inQ = false, cur = '';
        for (let c = 0; c < raw.length; c++) {
          if (raw[c] === '"') { inQ = !inQ; }
          else if (raw[c] === ',' && !inQ) { vals.push(cur.replace(/""/g,'"').trim()); cur = ''; }
          else cur += raw[c];
        }
        vals.push(cur.replace(/""/g,'"').trim());
        const row: any = {};
        headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/^"|"$/g,''); });
        if (!row.name) continue;
        const isDup = menu.some(m =>
          m.name.toLowerCase().trim() === row.name.toLowerCase().trim() &&
          (m.category||'').toLowerCase().trim() === (row.category||'').toLowerCase().trim()
        );
        rows.push({ ...row, _isDuplicate: isDup, _selected: !isDup });
      }
      if (rows.length === 0) { alert('No valid rows found in CSV.'); return; }
      setCsvPreviewRows(rows);
    };
    reader.readAsText(file);
  };

  // ── CSV Import ────────────────────────────────────────────────────────────
  const handleCsvImport = async () => {
    if (!csvPreviewRows) return;
    const toImport = csvPreviewRows.filter(r => r._selected && !r._isDuplicate);
    if (toImport.length === 0) { alert('No items selected for import.'); return; }
    setCsvImporting(true);
    let imported = 0, failed = 0;
    for (const row of toImport) {
      const fd = new FormData();
      fd.append('name', row.name);
      fd.append('description', row.description || '');
      fd.append('price', row.price_full || row.price || '0');
      fd.append('price_half', row.price_half || '');
      fd.append('price_full', row.price_full || row.price || '0');
      fd.append('category', row.category || 'Mains');
      fd.append('dietary_type', row.dietary_type || 'VEG');
      fd.append('is_daily_special', row.is_daily_special === 'true' ? 'true' : 'false');
      const res = await fetch(`/api/restaurant/${restaurantId}/menu`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd
      });
      if (res.ok) imported++; else failed++;
    }
    setCsvImporting(false);
    setCsvPreviewRows(null);
    fetchMenu();
    alert(`Import complete: ${imported} added${failed > 0 ? `, ${failed} failed` : ''}.`);
  };

  // ── Gemini AI Image Generation ────────────────────────────────────────────
  const handleGenerateImage = async (item: MenuItem) => {
    setGeneratingImageId(item.id);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/menu/${item.id}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: item.name, category: item.category, dietary_type: item.dietary_type })
      });
      if (res.ok) fetchMenu();
      else alert('Image generation failed. Please try again.');
    } catch { alert('Network error during image generation.'); }
    setGeneratingImageId(null);
  };

  return (
    <div className="space-y-6 md:space-y-8">

      {/* ── MOBILE: Hamburger nav header (hidden on md+) ── */}
      <div className="md:hidden flex items-center justify-between bg-white border border-[#cc5a16]/10 rounded-2xl px-4 py-3 shadow-sm">
        <span className="text-sm font-bold text-[#1a1208]">
          {({
            MENU: 'Menu Management', REPORTS: 'Analytics & Reports', QR: 'QR Management',
            BOOKINGS: 'Bookings', STAFF: 'Staff Management', ORDERS: 'Orders', INVOICES: 'Invoices',
            ATTENDANCE: 'Attendance', FEEDBACK: 'Feedback',
            SUBSCRIPTION: 'Subscription', NOTIFICATIONS: 'Notifications',
            SETTINGS: 'Brand & Settings', MONITOR: 'Command & Control'
          } as Record<string, string>)[activeTab]}
        </span>
        <button
          onClick={() => setMobileNavOpen(open => !open)}
          className="p-2 rounded-xl hover:bg-[#cc5a16]/5 transition-colors"
          aria-label="Toggle navigation menu"
        >
          {mobileNavOpen
            ? <X size={20} className="text-[#1a1208]" />
            : <Menu size={20} className="text-[#1a1208]" />}
        </button>
      </div>

      {/* ── MOBILE: Dropdown navigation menu ── */}
      {mobileNavOpen && (
        <div className="md:hidden -mt-3 rounded-2xl bg-white border border-[#cc5a16]/10 shadow-lg overflow-hidden z-40 relative">
          {([
            ['MONITOR', 'Command & Control'], ['MENU', 'Menu Management'], ['REPORTS', 'Analytics & Reports'],
            ['QR', 'QR Management'], ['BOOKINGS', 'Bookings'],
            ...(isHotelEnabled ? [
              ['ROOMS','Rooms'],
              ['HOTEL_BOOKINGS','Hotel Bookings'],
              ['SERVICES','Services'],
              ['SERVICE_REQUESTS','Service Requests'],
              ['FOLIOS','Folios'],
              ['COMPLIANCE','Compliance'],
              ['CONCIERGE_FAQ','Concierge FAQ'],
            ] as [string,string][] : []),
            ['STAFF', 'Staff Management'], ['ORDERS', 'Orders'], ['INVOICES', 'Invoices'],
            ['ATTENDANCE', 'Attendance'], ['FEEDBACK', 'Feedback'],
            ['SUBSCRIPTION', 'Subscription'], ['NOTIFICATIONS', 'Notifications'],
            ['SETTINGS', 'Brand & Settings'],
          ] as [string, string][]).filter(([id]) => {
            // Respect allowedTabs for all tabs, including hotel tabs.
            // If allowedTabs is null (legacy tenants with no saved role permission),
            // the hotel tab still shows because `!allowedTabs` is true.
            return !allowedTabs || allowedTabs.includes(id);
          }).map(([id, label]) => (
            <button
              key={id}
              onClick={() => { setActiveTab(id); setMobileNavOpen(false); }}
              className={cn(
                "w-full text-left px-5 py-3.5 text-sm font-bold uppercase tracking-widest border-b border-[#cc5a16]/10 last:border-0 flex items-center justify-between transition-colors",
                activeTab === id
                  ? "bg-[#cc5a16] text-white"
                  : "text-[#6b5d52] hover:bg-[#cc5a16]/5"
              )}
            >
              {label}
              {activeTab === id && <Check size={14} />}
            </button>
          ))}
        </div>
      )}

      {/* ── DESKTOP: Horizontal scrollable tab bar (hidden on mobile) ── */}
      <div className="hidden md:flex flex-wrap gap-x-4 gap-y-1 border-b border-[#cc5a16]/10">
        {([
          ['MONITOR', 'Command & Control'], ['MENU', 'Menu Management'], ['REPORTS', 'Analytics & Reports'],
          ['QR', 'QR Management'], ['BOOKINGS', 'Bookings'],
          ...(isHotelEnabled ? [
              ['ROOMS','Rooms'],
              ['HOTEL_BOOKINGS','Hotel Bookings'],
              ['SERVICES','Services'],
              ['SERVICE_REQUESTS','Service Requests'],
              ['FOLIOS','Folios'],
              ['COMPLIANCE','Compliance'],
              ['CONCIERGE_FAQ','Concierge FAQ'],
            ] as [string,string][] : []),
          ['STAFF', 'Staff Management'], ['ORDERS', 'Orders'], ['INVOICES', 'Invoices'],
          ['ATTENDANCE', 'Attendance'], ['FEEDBACK', 'Feedback'],
          ['SUBSCRIPTION', 'Subscription'], ['NOTIFICATIONS', 'Notifications'],
          ['SETTINGS', 'Brand & Settings'],
        ] as [string, string][]).filter(([id]) => {
          // Hotel tabs are always shown when hotel is enabled — bypass the stored allowedTabs
          // permission list (which predates the hotel module and doesn't include these IDs).
          if (['ROOMS','SERVICES','SERVICE_REQUESTS'].includes(id)) return true;
          return !allowedTabs || allowedTabs.includes(id);
        }).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              "pb-3 lg:pb-4 text-xs lg:text-sm font-bold uppercase tracking-widest transition-all whitespace-nowrap",
              activeTab === id
                ? "text-[#1a1208] border-b-2 border-[#cc5a16]"
                : "text-[#9c8e85] hover:text-[#3d3128]"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {allowedTabs && !allowedTabs.includes(activeTab) ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
            <Lock size={28} className="text-red-400" />
          </div>
          <h3 className="text-xl font-bold text-[#3d3128]">Access Restricted</h3>
          <p className="text-sm text-[#9c8e85] text-center max-w-xs">
            Your account does not have permission to access the <span className="font-bold">{activeTab}</span> section.
            Contact your administrator to request access.
          </p>
        </div>
      ) : activeTab === 'MENU' ? (
        <div className="space-y-5">
          {/* ── Header ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-3xl font-bold font-serif">Restaurant Menu</h2>
              <p className="text-sm text-[#6b5d52] mt-0.5">{menu.length} items across {[...new Set(menu.map(m => m.category).filter(Boolean))].length} categories</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handleMenuTemplateCsv} title="Download CSV Template"
                className="px-4 py-2.5 rounded-2xl text-xs font-bold border border-[#cc5a16]/15 text-[#6b5d52] hover:bg-[#faf7f2] flex items-center gap-1.5 transition-all">
                <Download size={14}/> Template
              </button>
              <button onClick={handleMenuExportCsv} title="Export all items as CSV"
                className="px-4 py-2.5 rounded-2xl text-xs font-bold border border-[#cc5a16]/15 text-[#6b5d52] hover:bg-[#faf7f2] flex items-center gap-1.5 transition-all">
                <Download size={14}/> Export CSV
              </button>
              <label className="px-4 py-2.5 rounded-2xl text-xs font-bold border border-[#cc5a16]/15 text-[#6b5d52] hover:bg-[#faf7f2] flex items-center gap-1.5 transition-all cursor-pointer">
                <Upload size={14}/> Import CSV
                <input type="file" accept=".csv" className="hidden" onChange={e => { if (e.target.files?.[0]) handleCsvFileParse(e.target.files[0]); e.target.value=''; }} />
              </label>
              <button onClick={() => setIsAddingItem(true)}
                className="bg-[#cc5a16] text-white px-5 py-2.5 rounded-2xl text-xs font-bold flex items-center gap-1.5 hover:bg-[#a84612] transition-all">
                <Plus size={14}/> Add Item
              </button>
            </div>
          </div>

          {/* ── Search + Category filter ── */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]"/>
              <input value={menuSearchTerm} onChange={e => setMenuSearchTerm(e.target.value)}
                placeholder="Search menu items…"
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-[#cc5a16]/10 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 bg-white"/>
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 flex-wrap">
              {(['ALL', ...Array.from(new Set(menu.map(m => m.category).filter(Boolean))).sort()] as string[]).map(cat => (
                <button key={cat} onClick={() => setMenuCatFilter(cat)}
                  className={cn('px-4 py-2 rounded-2xl text-xs font-bold whitespace-nowrap transition-all border',
                    menuCatFilter === cat
                      ? 'bg-[#cc5a16] text-white border-[#cc5a16]'
                      : 'bg-white border-[#cc5a16]/10 text-[#6b5d52] hover:border-[#cc5a16]/30')}>
                  {cat === 'ALL' ? `All (${menu.length})` : `${cat} (${menu.filter(m => m.category === cat).length})`}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <button onClick={() => setMenuViewMode('grid')} title="Grid view"
                className={cn('p-2 rounded-xl transition-all', menuViewMode === 'grid' ? 'bg-[#cc5a16]/10 text-[#cc5a16]' : 'text-[#9c8e85] hover:text-[#6b5d52]')}>
                <LayoutGrid size={16}/>
              </button>
              <button onClick={() => setMenuViewMode('grouped')} title="Grouped by category"
                className={cn('p-2 rounded-xl transition-all', menuViewMode === 'grouped' ? 'bg-[#cc5a16]/10 text-[#cc5a16]' : 'text-[#9c8e85] hover:text-[#6b5d52]')}>
                <List size={16}/>
              </button>
            </div>
          </div>

          {/* ── Menu Items ── */}
          {(() => {
            // Filter
            const filtered = menu.filter(item => {
              const matchesCat = menuCatFilter === 'ALL' || item.category === menuCatFilter;
              const matchesSearch = !menuSearchTerm || item.name.toLowerCase().includes(menuSearchTerm.toLowerCase()) || (item.description||'').toLowerCase().includes(menuSearchTerm.toLowerCase());
              return matchesCat && matchesSearch;
            });

            if (filtered.length === 0) return (
              <div className="text-center py-16 text-[#9c8e85]">
                <div className="text-5xl mb-3">🍽️</div>
                <p className="font-medium">No items found</p>
                <p className="text-sm mt-1">Try adjusting your search or filters</p>
              </div>
            );

            // Category emoji map
            const catEmoji: Record<string,string> = {
              starters:'🥗', mains:'🍛', sides:'🥘', desserts:'🍮',
              drinks:'🥤', breads:'🫓', soups:'🍜', salads:'🥙',
              specials:'⭐', breakfast:'🍳', snacks:'🧆'
            };
            const getCatEmoji = (cat: string) => catEmoji[cat?.toLowerCase()] || '🍽️';
            const dietaryGradient = (dt: string) =>
              dt === 'NON_VEG' ? 'from-red-100 to-orange-100' :
              dt === 'VEGAN'   ? 'from-blue-100 to-teal-100' :
                                 'from-green-100 to-emerald-100';

            const ItemCard = ({ item }: { item: MenuItem }) => (
              <div className="bg-white rounded-3xl border border-[#cc5a16]/10 shadow-sm overflow-hidden flex flex-col group hover:shadow-md transition-shadow">
                {/* Image Area */}
                <div className="aspect-video relative overflow-hidden">
                  {item.image ? (
                    <img src={item.image} alt={item.name} className="w-full h-full object-cover" referrerPolicy="no-referrer"
                      onError={e => { (e.target as HTMLImageElement).style.display='none'; (e.target as HTMLImageElement).nextElementSibling?.removeAttribute('style'); }}/>
                  ) : null}
                  {/* Placeholder shown when no image or image fails */}
                  <div className={cn('w-full h-full bg-gradient-to-br flex flex-col items-center justify-center gap-1', dietaryGradient(item.dietary_type), item.image ? 'hidden' : '')} style={item.image ? {display:'none'} : {}}>
                    <span className="text-4xl">{getCatEmoji(item.category)}</span>
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{item.category}</span>
                  </div>
                  {/* Generate Image overlay button */}
                  {!item.image && (
                    <div className="absolute inset-0 flex items-end justify-center pb-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleGenerateImage(item)} disabled={generatingImageId === item.id}
                        className="px-3 py-1.5 bg-black/70 text-white rounded-full text-[11px] font-bold flex items-center gap-1.5 hover:bg-black/90 transition-all disabled:opacity-50">
                        {generatingImageId === item.id ? <><div className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin"/> Generating…</> : <><Sparkles size={11}/> Generate Image</>}
                      </button>
                    </div>
                  )}
                  {/* Availability badge */}
                  <div className="absolute top-2 left-2">
                    {!item.available && (
                      <span className="bg-red-500/90 text-white text-[11px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Out of Stock</span>
                    )}
                  </div>
                </div>

                {/* Card Body */}
                <div className="p-5 flex-1 flex flex-col">
                  {/* Tags row */}
                  <div className="flex items-center gap-1.5 flex-wrap mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{item.category}</span>
                    <span className={cn('text-[11px] font-bold uppercase px-1.5 py-0.5 rounded flex items-center gap-0.5',
                      item.dietary_type === 'VEG' ? 'bg-green-100 text-green-700' :
                      item.dietary_type === 'NON_VEG' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700')}>
                      <div className={cn('w-1.5 h-1.5 rounded-full', item.dietary_type === 'VEG' ? 'bg-green-600' : item.dietary_type === 'NON_VEG' ? 'bg-red-600' : 'bg-blue-600')}/>
                      {item.dietary_type.replace('_',' ')}
                    </span>
                    {item.is_daily_special && (
                      <span className="bg-yellow-100 text-yellow-700 text-[11px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <Star size={8} fill="currentColor"/> Special
                      </span>
                    )}
                  </div>

                  <h4 className="text-lg font-bold font-serif leading-tight mb-1">{item.name}</h4>
                  <p className="text-xs text-[#6b5d52] mb-4 line-clamp-2 flex-1">{item.description}</p>

                  {/* Prices */}
                  <div className="flex gap-2 mb-4">
                    {item.price_half ? (
                      <div className="bg-[#faf7f2] px-3 py-1.5 rounded-xl">
                        <span className="text-[11px] text-[#9c8e85] uppercase font-bold block">Half</span>
                        <span className="text-sm font-bold font-mono">₹{item.price_half.toFixed(2)}</span>
                      </div>
                    ) : null}
                    <div className="bg-[#faf7f2] px-3 py-1.5 rounded-xl">
                      <span className="text-[11px] text-[#9c8e85] uppercase font-bold block">Full</span>
                      <span className="text-sm font-bold font-mono">₹{item.price_full.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between pt-3 border-t border-[#cc5a16]/10">
                    <div className="flex items-center gap-1">
                      <button onClick={() => setEditingItem(item)} className="text-xs font-bold text-[#6b5d52] hover:text-[#cc5a16] flex items-center gap-1 p-1.5 rounded-lg hover:bg-[#cc5a16]/5 transition-all">
                        <Edit3 size={13}/> Edit
                      </button>
                      <button onClick={() => handleToggleDailySpecial(item.id, !item.is_daily_special)}
                        className={cn('p-1.5 rounded-lg transition-all', item.is_daily_special ? 'text-yellow-500 bg-yellow-50' : 'text-[#c5b9b2] hover:text-yellow-500 hover:bg-yellow-50')}
                        title={item.is_daily_special ? 'Remove Special' : 'Set as Daily Special'}>
                        <Star size={14} fill={item.is_daily_special ? 'currentColor' : 'none'}/>
                      </button>
                      <button onClick={() => handleDeleteItem(item.id)} className="p-1.5 rounded-lg text-[#c5b9b2] hover:text-red-500 hover:bg-red-50 transition-all">
                        <Trash2 size={13}/>
                      </button>
                    </div>
                    <button onClick={() => handleToggleAvailability(item.id, !item.available)}
                      className="flex items-center gap-1.5 text-xs font-bold hover:bg-[#cc5a16]/5 px-2 py-1.5 rounded-lg transition-all">
                      <div className={cn('w-2 h-2 rounded-full', item.available ? 'bg-green-500' : 'bg-red-400')}/>
                      {item.available ? 'Available' : 'Out of Stock'}
                    </button>
                  </div>
                </div>
              </div>
            );

            if (menuViewMode === 'grouped') {
              const cats = menuCatFilter === 'ALL'
                ? Array.from(new Set(filtered.map(m => m.category).filter(Boolean))).sort() as string[]
                : [menuCatFilter];
              return (
                <div className="space-y-8">
                  {cats.map(cat => {
                    const catItems = filtered.filter(m => m.category === cat);
                    if (catItems.length === 0) return null;
                    return (
                      <div key={cat}>
                        <div className="flex items-center gap-3 mb-4">
                          <span className="text-2xl">{getCatEmoji(cat)}</span>
                          <h3 className="text-lg font-bold uppercase tracking-widest text-[#3d3128]">{cat}</h3>
                          <span className="text-xs font-bold text-[#9c8e85] bg-[#faf7f2] px-2 py-0.5 rounded-full">{catItems.length}</span>
                          <div className="flex-1 h-px bg-[#cc5a16]/8"/>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                          {catItems.map(item => <ItemCard key={item.id} item={item}/>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            }

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filtered.map(item => <ItemCard key={item.id} item={item}/>)}
              </div>
            );
          })()}

          {/* ── Edit Item Modal ── */}
          {editingItem && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-start sm:items-center justify-center p-4 overflow-y-auto">
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl overflow-hidden my-auto"
              >
                <div className="p-8 border-b border-[#cc5a16]/10 flex justify-between items-center bg-[#faf7f2]/50">
                  <div>
                    <h3 className="text-2xl font-bold font-serif">Edit Menu Item</h3>
                    <p className="text-sm text-[#6b5d52]">Update details for {editingItem.name}</p>
                  </div>
                  <button onClick={() => setEditingItem(null)} className="p-2 hover:bg-white rounded-full transition-colors"><X size={24}/></button>
                </div>
                <form onSubmit={handleUpdateItem} className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Item Name</label>
                      <input type="text" required value={editingItem.name}
                        onChange={e => setEditingItem({...editingItem, name: e.target.value})}
                        className="w-full px-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-medium"/>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Category</label>
                      <input type="text" list="edit-cats-datalist" value={editingItem.category}
                        onChange={e => setEditingItem({...editingItem, category: e.target.value})}
                        className="w-full px-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-medium bg-white"
                        placeholder="Type or select category"/>
                      <datalist id="edit-cats-datalist">
                        {['Starters','Mains','Sides','Desserts','Drinks','Breads','Soups','Salads','Snacks','Breakfast',
                          ...Array.from(new Set(menu.map(m => m.category).filter(Boolean)))
                        ].filter((v,i,a)=>a.indexOf(v)===i).map(cat => <option key={cat} value={cat}/>)}
                      </datalist>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Description</label>
                    <textarea value={editingItem.description}
                      onChange={e => setEditingItem({...editingItem, description: e.target.value})}
                      className="w-full px-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-medium h-24 resize-none"/>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Price (Full)</label>
                      <div className="relative">
                        <span className="absolute left-6 top-1/2 -translate-y-1/2 text-[#9c8e85] font-bold">₹</span>
                        <input type="number" step="0.01" required value={editingItem.price_full}
                          onChange={e => setEditingItem({...editingItem, price_full: parseFloat(e.target.value)})}
                          className="w-full pl-12 pr-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-mono font-bold"/>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Price (Half)</label>
                      <div className="relative">
                        <span className="absolute left-6 top-1/2 -translate-y-1/2 text-[#9c8e85] font-bold">₹</span>
                        <input type="number" step="0.01" value={editingItem.price_half || ''}
                          onChange={e => setEditingItem({...editingItem, price_half: e.target.value ? parseFloat(e.target.value) : undefined})}
                          className="w-full pl-12 pr-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-mono font-bold"/>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Dietary Type</label>
                      <select value={editingItem.dietary_type}
                        onChange={e => setEditingItem({...editingItem, dietary_type: e.target.value as DietaryType})}
                        className="w-full px-6 py-4 rounded-2xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 font-medium bg-white">
                        <option value="VEG">Veg</option>
                        <option value="NON_VEG">Non-Veg</option>
                        <option value="VEGAN">Vegan</option>
                      </select>
                    </div>
                  </div>
                  {/* Image Upload */}
                  <div className="space-y-3">
                    <label className="text-xs font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Item Image</label>
                    <div className="flex items-center gap-4">
                      {/* Current image preview */}
                      {editingItem.image && !editImageFile ? (
                        <img src={editingItem.image} alt={editingItem.name}
                          className="w-16 h-16 rounded-2xl object-cover border border-[#cc5a16]/20 shrink-0"/>
                      ) : editImageFile ? (
                        <img src={URL.createObjectURL(editImageFile)} alt="preview"
                          className="w-16 h-16 rounded-2xl object-cover border border-[#cc5a16]/20 shrink-0"/>
                      ) : (
                        <div className="w-16 h-16 rounded-2xl bg-amber-50 flex items-center justify-center text-3xl shrink-0 border border-[#cc5a16]/10">🍽️</div>
                      )}
                      <div className="flex-1">
                        <input type="file" accept="image/*"
                          className="w-full text-sm text-[#6b5d52] file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#cc5a16]/10 file:text-[#1a1208] hover:file:bg-[#cc5a16]/20"
                          onChange={e => setEditImageFile(e.target.files?.[0] || null)}/>
                        {editImageFile && (
                          <p className="text-xs text-[#cc5a16] mt-1 ml-1">New image selected — will be saved on submit</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 flex gap-4">
                    <button type="button" onClick={() => { setEditingItem(null); setEditImageFile(null); }}
                      className="flex-1 px-8 py-4 rounded-2xl font-bold border border-[#cc5a16]/10 hover:bg-[#faf7f2] transition-all">Cancel</button>
                    <button type="submit"
                      className="flex-1 bg-[#cc5a16] text-white px-8 py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all shadow-lg">Save Changes</button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}

          {/* ── CSV Import Preview Modal ── */}
          {csvPreviewRows && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-start sm:items-center justify-center p-4 overflow-y-auto">
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-3xl my-auto overflow-hidden">
                <div className="p-6 border-b border-[#cc5a16]/10 bg-[#faf7f2]/50 flex justify-between items-center">
                  <div>
                    <h3 className="text-xl font-bold font-serif">CSV Import Preview</h3>
                    <p className="text-sm text-[#6b5d52] mt-0.5">
                      {csvPreviewRows.filter(r => !r._isDuplicate && r._selected).length} items ready to import •{' '}
                      <span className="text-amber-600 font-semibold">{csvPreviewRows.filter(r => r._isDuplicate).length} duplicates skipped</span>
                    </p>
                  </div>
                  <button onClick={() => setCsvPreviewRows(null)} className="p-2 hover:bg-white rounded-full"><X size={20}/></button>
                </div>
                <div className="max-h-[55vh] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#faf7f2] sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] w-10">✓</th>
                        <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Name</th>
                        <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Category</th>
                        <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Type</th>
                        <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Half</th>
                        <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Full</th>
                        <th className="px-4 py-3 text-center text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {csvPreviewRows.map((row, i) => (
                        <tr key={i} className={cn('border-t border-[#cc5a16]/10', row._isDuplicate ? 'opacity-40 bg-amber-50/50' : '')}>
                          <td className="px-4 py-3">
                            <input type="checkbox" checked={row._selected && !row._isDuplicate} disabled={row._isDuplicate}
                              onChange={e => setCsvPreviewRows(prev => prev!.map((r,j) => j===i ? {...r, _selected: e.target.checked} : r))}
                              className="w-4 h-4 rounded text-[#cc5a16]"/>
                          </td>
                          <td className="px-4 py-3 font-semibold">{row.name}</td>
                          <td className="px-4 py-3 text-[#6b5d52]">{row.category}</td>
                          <td className="px-4 py-3">
                            <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full uppercase',
                              row.dietary_type === 'NON_VEG' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700')}>
                              {row.dietary_type || 'VEG'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-[#6b5d52]">{row.price_half ? `₹${row.price_half}` : '—'}</td>
                          <td className="px-4 py-3 text-right font-mono font-bold">₹{row.price_full || row.price || '?'}</td>
                          <td className="px-4 py-3 text-center">
                            {row._isDuplicate
                              ? <span className="text-[11px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">Duplicate</span>
                              : <span className="text-[11px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">New</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="p-6 border-t border-[#cc5a16]/10 flex items-center justify-between gap-4">
                  <button onClick={() => setCsvPreviewRows(null)}
                    className="px-6 py-3 rounded-2xl font-bold border border-[#cc5a16]/10 hover:bg-[#faf7f2] transition-all">Cancel</button>
                  <button onClick={handleCsvImport} disabled={csvImporting || csvPreviewRows.filter(r=>r._selected&&!r._isDuplicate).length===0}
                    className="bg-[#cc5a16] text-white px-8 py-3 rounded-2xl font-bold hover:bg-[#a84612] transition-all flex items-center gap-2 disabled:opacity-50">
                    {csvImporting
                      ? <><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/> Importing…</>
                      : <><Upload size={16}/> Import {csvPreviewRows.filter(r=>r._selected&&!r._isDuplicate).length} Items</>}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </div>
      ) : activeTab === 'BOOKINGS' ? (
        <BookingsManagement restaurantId={restaurantId} token={token} />
      ) : activeTab === 'REPORTS' ? (
        <AnalyticsDashboard
          restaurantId={restaurantId}
          token={token!}
          feedback={feedback}
          restaurant={restaurant}
          onDateRangeChange={(from, to) => fetchReports(from, to)}
        />
      ) : activeTab === 'STAFF' ? (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Staff Management</h2>
            <button
              onClick={() => setIsAddingStaff(true)}
              className="bg-[#cc5a16] text-white px-6 py-3 rounded-full flex items-center gap-2 hover:bg-[#a84612] transition-colors"
            >
              <Plus size={20} /> Add New Staff
            </button>
          </div>

          {/* Search + Role filter */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
              <input type="text" placeholder="Search by name, login ID, email, phone…"
                value={staffSearch} onChange={e => { setStaffSearch(e.target.value); setStaffPage(1); }}
                className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm" />
            </div>
            <div className="flex gap-2">
              {(['ALL','CHEF','WAITER','MANAGER'] as const).map(r => (
                <button key={r} onClick={() => { setStaffRoleFilter(r); setStaffPage(1); }}
                  className={cn("px-4 py-2 rounded-xl text-xs font-bold transition-all",
                    staffRoleFilter === r ? "bg-[#cc5a16] text-white" : "bg-white border border-[#cc5a16]/10 text-[#1a1208] hover:bg-[#cc5a16]/5")}>
                  {r === 'ALL' ? 'All' : r.charAt(0) + r.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const q = staffSearch.toLowerCase();
            const filtered = staff.filter(s =>
              (staffRoleFilter === 'ALL' || s.role === staffRoleFilter) &&
              (!q || (s.name||'').toLowerCase().includes(q) || (s.login_id||'').toLowerCase().includes(q) ||
               (s.email||'').toLowerCase().includes(q) || (s.phone||'').includes(q))
            );
            const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
            const safePage   = Math.min(staffPage, totalPages);
            const pageItems  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
            return (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pageItems.length === 0 ? (
                    <div className="col-span-full py-16 text-center text-[#9c8e85]">No staff members found</div>
                  ) : pageItems.map((s) => (
              <div key={s.id} className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
                {/* Card header — role-coloured strip */}
                <div className={cn(
                  "px-6 pt-5 pb-4 flex justify-between items-start",
                  s.role === 'CHEF' ? "bg-orange-50" : s.role === 'MANAGER' ? "bg-purple-50" : "bg-blue-50"
                )}>
                  <div>
                    <h3 className="text-lg font-bold text-[#1a1a1a]">{s.name}</h3>
                    <span className={cn(
                      "inline-block text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full mt-1",
                      s.role === 'CHEF' ? "bg-orange-200 text-orange-800"
                      : s.role === 'MANAGER' ? "bg-purple-200 text-purple-800"
                      : "bg-blue-200 text-blue-800"
                    )}>
                      {s.role === 'CHEF' ? '👨‍🍳 Chef' : s.role === 'MANAGER' ? '🧑‍💼 Manager' : '🧑‍🍽️ Waiter'}
                    </span>
                  </div>
                  <button onClick={() => removeStaff(s.id)} className="text-red-400 hover:text-red-600 p-1">
                    <Trash2 size={18} />
                  </button>
                </div>

                {/* Login credentials box */}
                <div className="mx-5 mt-4 bg-[#1a1a1a] rounded-2xl p-4 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">Login Credentials</p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[11px] text-white/50 mb-0.5">Restaurant ID</p>
                      <p className="font-mono font-bold text-sm text-white">{restaurantId}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-white/50 mb-0.5">Login ID</p>
                      {s.login_id ? (
                        <p className="font-mono font-bold text-sm text-emerald-400">{s.login_id}</p>
                      ) : (
                        <p className="text-[11px] italic text-white/30">Not set</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Contact info */}
                <div className="px-5 py-4 space-y-2">
                  {s.phone && (
                    <div className="flex items-center gap-2 text-sm text-[#1a1208]">
                      <span className="text-[11px] uppercase tracking-widest text-[#6b5d52] w-20 shrink-0">Phone</span>
                      <span className="font-bold">{s.phone}</span>
                    </div>
                  )}
                  {s.email && (
                    <div className="flex items-center gap-2 text-sm text-[#1a1208]">
                      <span className="text-[11px] uppercase tracking-widest text-[#6b5d52] w-20 shrink-0">Email</span>
                      <span className="font-medium truncate">{s.email}</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="px-5 pb-5 flex items-center gap-3">
                  <button
                    onClick={async () => {
                      const newPass = prompt(`Set new password for ${s.name}:`);
                      if (!newPass) return;
                      const res = await fetch(`/api/owner/staff/${s.id}/reset-password`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ newPassword: newPass })
                      });
                      if (res.ok) alert(`✓ Password updated for ${s.name}`);
                      else {
                        const d = await res.json().catch(() => ({}));
                        alert(d.error || 'Failed to reset password');
                      }
                    }}
                    className="flex-1 text-[11px] font-bold uppercase tracking-widest text-[#1a1208] border-2 border-[#cc5a16]/20 rounded-xl py-2 hover:bg-[#cc5a16]/5 transition-colors"
                  >
                    Reset Password
                  </button>
                </div>
              </div>
                  ))}
                </div>
                {totalPages > 1 && (
                  <div className="bg-white rounded-2xl border border-[#cc5a16]/10 shadow-sm overflow-hidden">
                    <PaginationBar page={safePage} totalPages={totalPages} setPage={setStaffPage} total={filtered.length} />
                  </div>
                )}
              </>
            );
          })()}

          {isAddingStaff && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-[100] p-4 overflow-y-auto">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-[32px] p-5 sm:p-8 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto my-auto"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-2xl font-bold font-serif">Add Staff Member</h3>
                  <button onClick={() => setIsAddingStaff(false)} className="text-[#6b5d52] hover:text-[#1a1208]">
                    <X />
                  </button>
                </div>
                <form onSubmit={handleAddStaff} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Full Name</label>
                    <input 
                      required
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.name}
                      onChange={e => setNewStaff({...newStaff, name: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Login ID</label>
                    <input 
                      required
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.loginId}
                      onChange={e => setNewStaff({...newStaff, loginId: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Password</label>
                    <input 
                      required
                      type="password"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.password}
                      onChange={e => setNewStaff({...newStaff, password: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">WhatsApp Phone (with country code)</label>
                    <input 
                      required
                      placeholder="+919876543210"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.phone}
                      onChange={e => setNewStaff({...newStaff, phone: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Email Address</label>
                    <input 
                      type="email"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.email}
                      onChange={e => setNewStaff({...newStaff, email: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Role</label>
                    <select 
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newStaff.role}
                      onChange={e => setNewStaff({...newStaff, role: e.target.value as UserRole})}
                    >
                      <option value="CHEF">Chef</option>
                      <option value="WAITER">Waiter / Attender</option>
                      <option value="MANAGER">Manager</option>
                    </select>
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all"
                  >
                    Add Staff
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </div>
      ) : activeTab === 'NOTIFICATIONS' ? (
        <NotificationSettings restaurantId={restaurantId} token={token} />
      ) : activeTab === 'FEEDBACK' ? (
        <div className="space-y-8">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Customer Feedback</h2>
            <button
              onClick={fetchFeedback}
              className="px-4 py-2 bg-white border border-[#cc5a16]/10 rounded-2xl text-[#1a1208] hover:bg-[#faf7f2] transition-all flex items-center gap-2 text-xs font-bold uppercase tracking-widest"
            >
              <RefreshCw size={16} className={cn(loadingFeedback && "animate-spin")} />
              Refresh
            </button>
          </div>

          {/* Feedback filters */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
              <input type="text" placeholder="Search by customer name or comment…"
                value={feedbackSearch} onChange={e => { setFeedbackSearch(e.target.value); setFeedbackPage(1); }}
                className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm" />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-xs text-[#6b5d52] font-bold uppercase tracking-widest shrink-0">Min Rating</span>
              {[0,1,2,3,4,5].map(r => (
                <button key={r} onClick={() => { setFeedbackMinRating(r); setFeedbackPage(1); }}
                  className={cn("w-8 h-8 rounded-full text-xs font-bold transition-all",
                    feedbackMinRating === r ? "bg-yellow-400 text-yellow-900" : "bg-white border border-[#cc5a16]/10 text-[#1a1208] hover:bg-yellow-50")}>
                  {r === 0 ? 'All' : `${r}★`}
                </button>
              ))}
              <button onClick={() => setFeedbackSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                className="ml-2 px-3 py-1.5 bg-white border border-[#cc5a16]/10 rounded-xl text-xs font-bold text-[#1a1208] hover:bg-[#cc5a16]/5 transition-all flex items-center gap-1">
                Date {feedbackSortDir === 'desc' ? '↓' : '↑'}
              </button>
            </div>
          </div>

          {(() => {
            const q = feedbackSearch.toLowerCase();
            const filtered = feedback.filter(f =>
              (feedbackMinRating === 0 || f.rating >= feedbackMinRating) &&
              (!q || (f.customer_name||'').toLowerCase().includes(q) || (f.comment||'').toLowerCase().includes(q))
            );
            const sorted = [...filtered].sort((a, b) =>
              feedbackSortDir === 'desc'
                ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                : new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );
            const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
            const safePage   = Math.min(feedbackPage, totalPages);
            const pageItems  = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
            return (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pageItems.length === 0 ? (
                    <div className="col-span-full py-20 text-center bg-white rounded-[32px] border border-[#cc5a16]/10">
                      <Star className="mx-auto mb-4 text-[#c5b9b2]" size={48} />
                      <p className="text-[#6b5d52] font-bold uppercase tracking-widest text-sm">No feedback found</p>
                    </div>
                  ) : pageItems.map((f) => (
                <div key={f.id} className="bg-white p-6 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-bold text-[#1a1208]">{f.customer_name || 'Anonymous'}</p>
                      <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest">Order: {f.order_id}</p>
                    </div>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star 
                          key={star} 
                          size={14} 
                          className={cn(
                            star <= f.rating ? "text-yellow-400 fill-yellow-400" : "text-gray-200"
                          )} 
                        />
                      ))}
                    </div>
                  </div>
                  <p className="text-sm text-[#0d0a07]/80 italic">"{f.comment || 'No comment provided'}"</p>
                  <div className="pt-4 border-t border-[#cc5a16]/10 text-[11px] text-[#9c8e85] uppercase tracking-widest font-bold">
                    {new Date(f.created_at).toLocaleString()}
                  </div>
                </div>
                  ))
                  }
                </div>
                {totalPages > 1 && (
                  <div className="bg-white rounded-2xl border border-[#cc5a16]/10 shadow-sm overflow-hidden">
                    <PaginationBar page={safePage} totalPages={totalPages} setPage={setFeedbackPage} total={sorted.length} />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      ) : activeTab === 'ORDERS' ? (
        <div className="space-y-8">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Order Management</h2>
            <button 
              onClick={fetchOrders}
              className="px-4 py-2 bg-white border border-[#cc5a16]/10 rounded-2xl text-[#1a1208] hover:bg-[#faf7f2] transition-all flex items-center gap-2 text-xs font-bold uppercase tracking-widest"
            >
              <RefreshCw size={16} className={cn(loadingOrders && "animate-spin")} />
              Refresh On demand database queries
            </button>
          </div>

          {/* Search + Date filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
              <input
                type="text"
                placeholder="Search by order ID, customer name, phone, table…"
                value={paymentSearch}
                onChange={e => { setPaymentSearch(e.target.value); setOrdersPage(1); }}
                className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm"
              />
            </div>
            <div className="flex gap-2 items-center">
              <input type="date" value={ordersDateFrom} onChange={e => { setOrdersDateFrom(e.target.value); setOrdersPage(1); }}
                className="bg-white border border-[#cc5a16]/10 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm text-[#1a1208] cursor-pointer" title="From date" />
              <span className="text-[#9c8e85] text-xs font-bold">to</span>
              <input type="date" value={ordersDateTo} onChange={e => { setOrdersDateTo(e.target.value); setOrdersPage(1); }}
                className="bg-white border border-[#cc5a16]/10 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm text-[#1a1208] cursor-pointer" title="To date" />
              {(ordersDateFrom || ordersDateTo) && (
                <button onClick={() => { setOrdersDateFrom(''); setOrdersDateTo(''); setOrdersPage(1); }}
                  className="p-2 text-[#9c8e85] hover:text-[#cc5a16] transition-colors" title="Clear date filter">
                  <X size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#faf7f2] border-b border-[#cc5a16]/10">
                    {([
                      { col: 'id',            label: 'Order ID'  },
                      { col: 'customerName',  label: 'Customer'  },
                      { col: 'tableNumber',   label: 'Table'     },
                      { col: 'itemCount',     label: 'Items'     },
                      { col: 'totalAmount',   label: 'Amount'    },
                      { col: 'paymentMethod', label: 'Method'    },
                      { col: 'paymentStatus', label: 'Status'    },
                    ] as const).map(({ col, label }) => (
                      <th
                        key={col}
                        onClick={() => setPaymentSort(p => ({ col, dir: p.col === col && p.dir === 'asc' ? 'desc' : 'asc' }))}
                        className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] cursor-pointer select-none hover:text-[#cc5a16] transition-colors"
                      >
                        <span className="flex items-center gap-1">
                          {label}
                          {paymentSort.col === col
                            ? <span className="text-[#cc5a16]">{paymentSort.dir === 'asc' ? '↑' : '↓'}</span>
                            : <span className="opacity-20">↕</span>}
                        </span>
                      </th>
                    ))}
                    <th className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#5A5A40]/5">
                  {(() => {
                    const q = paymentSearch.toLowerCase();
                    const filtered = orders.filter(o => {
                      const matchesSearch = !q ||
                        (o.id || '').toLowerCase().includes(q) ||
                        (o.customerName || '').toLowerCase().includes(q) ||
                        (o.customerPhone || '').includes(q) ||
                        (o.tableNumber || '').toLowerCase().includes(q) ||
                        (o.paymentMethod || '').toLowerCase().includes(q) ||
                        (o.paymentStatus || '').toLowerCase().includes(q);
                      const orderDate = (o as any).createdAt ? (o as any).createdAt.slice(0, 10) : '';
                      const matchesFrom = !ordersDateFrom || orderDate >= ordersDateFrom;
                      const matchesTo   = !ordersDateTo   || orderDate <= ordersDateTo;
                      return matchesSearch && matchesFrom && matchesTo;
                    });
                    const sorted = [...filtered].sort((a, b) => {
                      const col = paymentSort.col;
                      let va: any, vb: any;
                      if (col === 'itemCount') {
                        va = Array.isArray(a.items) ? a.items.length : 0;
                        vb = Array.isArray(b.items) ? b.items.length : 0;
                      } else {
                        va = (a as any)[col] ?? '';
                        vb = (b as any)[col] ?? '';
                      }
                      if (typeof va === 'number') return paymentSort.dir === 'asc' ? va - vb : vb - va;
                      return paymentSort.dir === 'asc'
                        ? String(va).localeCompare(String(vb))
                        : String(vb).localeCompare(String(va));
                    });
                    // pagination
                    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
                    const safePage   = Math.min(ordersPage, totalPages);
                    const pageRows   = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
                    if (pageRows.length === 0) return (
                      <tr><td colSpan={8} className="py-16 text-center text-[#9c8e85] italic">No orders found</td></tr>
                    );
                    return pageRows.map(order => (
                    <tr key={order.id} className={cn("hover:bg-[#faf7f2]/30 transition-colors", (order as any).status === 'CANCELLED' && "opacity-50")}>
                      {/* Order ID — clickable to open invoice */}
                      <td className="px-6 py-4">
                        <button
                          onClick={() => openInvoice(order, 'view')}
                          className="font-mono text-xs font-bold text-[#cc5a16] hover:underline underline-offset-2 text-left"
                        >
                          {order.id}
                        </button>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-bold text-sm">{order.customerName}</p>
                        <p className="text-[11px] text-[#6b5d52]">{order.customerPhone}</p>
                      </td>
                      <td className="px-6 py-4 text-sm">{order.tableNumber}</td>
                      <td className="px-6 py-4 text-xs text-[#6b5d52]">
                        {Array.isArray(order.items) ? order.items.length : 0} item{Array.isArray(order.items) && order.items.length !== 1 ? 's' : ''}
                      </td>
                      <td className="px-6 py-4 font-mono font-bold text-sm">₹{(order.totalAmount ?? 0).toFixed(2)}</td>
                      <td className="px-6 py-4">
                        <span className="text-[11px] font-bold uppercase tracking-widest px-2 py-1 bg-[#cc5a16]/5 rounded-full">
                          {order.paymentMethod || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {(order as any).status === 'CANCELLED' ? (
                          <span className="text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-red-100 text-red-600">
                            Cancelled
                          </span>
                        ) : (
                          <span className={cn(
                            "text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full",
                            order.paymentStatus === 'PAID' ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                          )}>
                            {order.paymentStatus || 'PENDING'}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end items-center gap-1.5 flex-wrap">
                          {/* Print button — hidden for cancelled orders */}
                          {(order as any).status !== 'CANCELLED' && (
                            <button
                              title="Print Invoice"
                              className="p-2 rounded-xl border border-[#cc5a16]/20 text-[#cc5a16] hover:bg-[#cc5a16]/5 transition-all"
                              onClick={() => {
                                const items = Array.isArray(order.items) ? order.items : [];
                                printInvoiceOrder(order, items, Number((order as any).discount_amount || 0), (order as any).apply_gst !== 0, Number((order as any).service_charge_percent || 0), Number((order as any).gst_percent ?? restaurant?.gst_percentage ?? 0));
                              }}
                            >
                              <Printer size={14} />
                            </button>
                          )}
                          {/* Edit Invoice button — hidden for cancelled orders */}
                          {(order as any).status !== 'CANCELLED' && (
                            <button
                              onClick={() => openInvoice(order, 'edit')}
                              title="Edit Invoice"
                              className="p-2 rounded-xl border border-[#cc5a16]/20 text-[#6b5d52] hover:bg-[#faf7f2] transition-all"
                            >
                              <Edit3 size={14} />
                            </button>
                          )}
                          {/* Mark Paid — hidden for cancelled orders */}
                          {(order as any).status !== 'CANCELLED' && order.paymentStatus !== 'PAID' && (
                            <button
                              onClick={async () => {
                                const res = await fetch(`/api/orders/${order.id}/payment`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                  body: JSON.stringify({ status: 'PAID', restaurantId })
                                });
                                if (res.ok) fetchOrders();
                              }}
                              className="bg-green-600 text-white px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-green-700 transition-all"
                            >
                              Mark Paid
                            </button>
                          )}
                          {/* Request Feedback */}
                          {order.paymentStatus === 'PAID' && !order.feedbackRequested && (
                            <button
                              onClick={() => requestFeedback(order.id)}
                              className="bg-[#cc5a16] text-white px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-[#a84612] transition-all flex items-center gap-1.5"
                            >
                              <Star size={11} /> Feedback
                            </button>
                          )}
                          {order.feedbackRequested && (
                            <span className="text-[11px] font-bold uppercase tracking-widest text-green-600 flex items-center gap-1">
                              <CheckCircle2 size={11} /> Sent
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            {(() => {
              const q = paymentSearch.toLowerCase();
              const filtered = orders.filter(o => {
                const matchesSearch = !q || (o.id||'').toLowerCase().includes(q)||(o.customerName||'').toLowerCase().includes(q)||(o.customerPhone||'').includes(q)||(o.tableNumber||'').toLowerCase().includes(q);
                const orderDate = (o as any).createdAt ? (o as any).createdAt.slice(0,10) : '';
                return matchesSearch && (!ordersDateFrom || orderDate >= ordersDateFrom) && (!ordersDateTo || orderDate <= ordersDateTo);
              });
              const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
              return <PaginationBar page={Math.min(ordersPage, totalPages)} totalPages={totalPages} setPage={setOrdersPage} total={filtered.length} />;
            })()}
            <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
          </div>
        </div>
      ) : activeTab === 'INVOICES' ? (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="text-3xl font-bold font-serif">Invoice Management</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setShowTemplatePanel(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl border border-[#cc5a16]/20 text-[#6b5d52] hover:bg-[#faf7f2] text-xs font-bold uppercase tracking-widest transition-all"
              >
                <Settings size={14} /> Template
              </button>
              <button
                onClick={() => { setShowOnDemandModal(true); setOdInvoiceItems([{name:'',qty:1,price:0}]); setOdCustomer({name:'',phone:'',reference:''}); setOdDiscount(0); setOdSvcPct(0); setOdGstPct(restaurant?.is_gst_enabled ? (restaurant?.gst_percentage ?? 0) : 0); setOdApplyGst(Boolean(restaurant?.is_gst_enabled)); }}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-[#cc5a16] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#a84612] transition-all shadow-sm"
              >
                <Plus size={14} /> New Invoice
              </button>
              <button
                onClick={fetchInvoices}
                className="flex items-center gap-2 px-4 py-2 rounded-2xl border border-[#cc5a16]/20 text-[#6b5d52] hover:bg-[#faf7f2] text-xs font-bold uppercase tracking-widest transition-all"
              >
                <RefreshCw size={14} className={cn(loadingInvoices && "animate-spin")} /> Refresh
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
              <input
                type="text"
                placeholder="Search by invoice ID, customer, table…"
                value={invoiceSearch}
                onChange={e => { setInvoiceSearch(e.target.value); setInvoicesPage(1); }}
                className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-9 pr-4 py-2.5 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm"
              />
            </div>
            <div className="flex gap-1.5">
              {(['ALL','UNPAID','PAID','PRINTED'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => { setInvoiceStatusFilter(s); setInvoicesPage(1); }}
                  className={cn(
                    "px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
                    invoiceStatusFilter === s ? "bg-[#cc5a16] text-white" : "bg-white border border-[#cc5a16]/10 text-[#6b5d52] hover:bg-[#faf7f2]"
                  )}
                >{s}</button>
              ))}
            </div>
          </div>

          {/* Invoice stats */}
          {invoices.length > 0 && (() => {
            const isPaidFn = (i: any) => i.invoice_type === 'SESSION' ? i.session_status === 'closed' : i.payment_status === 'PAID';
            const paid    = invoices.filter(isPaidFn).length;
            const unpaid  = invoices.filter(i => !isPaidFn(i)).length;
            const printed = invoices.filter(i => i.invoice_status === 'PRINTED' && !isPaidFn(i)).length;
            const total   = invoices.filter(isPaidFn).reduce((s, i) => s + Number(i.totalAmount||0), 0);
            return (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Unpaid',    value: unpaid,   color: 'bg-amber-50 border-amber-200 text-amber-700' },
                  { label: 'Paid',      value: paid,     color: 'bg-green-50 border-green-200 text-green-700' },
                  { label: 'Printed',   value: printed,  color: 'bg-blue-50 border-blue-200 text-blue-700' },
                  { label: 'Revenue',   value: `₹${total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, color: 'bg-[#cc5a16]/5 border-[#cc5a16]/20 text-[#cc5a16]' },
                ].map(s => (
                  <div key={s.label} className={cn("rounded-2xl border p-3 text-center", s.color)}>
                    <p className="font-bold text-lg leading-none">{s.value}</p>
                    <p className="text-[11px] uppercase tracking-widest mt-1 opacity-70">{s.label}</p>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Invoice table */}
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#faf7f2] border-b border-[#cc5a16]/10">
                    {([
                      { label: 'Invoice # / Type', key: 'id'       },
                      { label: 'Customer',          key: 'customer' },
                      { label: 'Table',             key: 'table'    },
                      { label: 'Date & Time',       key: 'date'     },
                      { label: 'Amount',            key: 'amount'   },
                      { label: 'Status',            key: 'status'   },
                      { label: 'Actions',           key: null       },
                    ] as { label: string; key: string | null }[]).map(({ label, key }) => (
                      <th key={label} className="px-5 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">
                        {key ? (
                          <button
                            onClick={() => {
                              if (invoiceSortKey === key) setInvoiceSortDir(d => d === 'asc' ? 'desc' : 'asc');
                              else { setInvoiceSortKey(key); setInvoiceSortDir('asc'); }
                              setInvoicesPage(1);
                            }}
                            className="flex items-center gap-1 hover:text-[#cc5a16] transition-colors group"
                          >
                            {label}
                            <span className="text-[#9c8e85] group-hover:text-[#cc5a16]">
                              {invoiceSortKey === key
                                ? (invoiceSortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)
                                : <ChevronsUpDown size={10} />}
                            </span>
                          </button>
                        ) : label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#cc5a16]/5">
                  {(() => {
                    const q = invoiceSearch.toLowerCase();
                    let rows = invoices.filter(inv => {
                      const paidNow = inv.invoice_type === 'SESSION' ? inv.session_status === 'closed' : inv.payment_status === 'PAID';
                      if (invoiceStatusFilter === 'PAID'    && !paidNow) return false;
                      if (invoiceStatusFilter === 'UNPAID'  && paidNow)  return false;
                      if (invoiceStatusFilter === 'PRINTED' && (inv.invoice_status !== 'PRINTED' || paidNow)) return false;
                      if (!q) return true;
                      return (
                        String(inv.id||'').toLowerCase().includes(q) ||
                        (inv.customerName||'').toLowerCase().includes(q) ||
                        (inv.customerPhone||'').includes(q) ||
                        (inv.tableNumber||'').toLowerCase().includes(q)
                      );
                    });
                    // Sort
                    rows = [...rows].sort((a, b) => {
                      const getPaidStatus = (i: any) => i.invoice_type === 'SESSION' ? i.session_status === 'closed' : i.payment_status === 'PAID';
                      let va: any, vb: any;
                      switch (invoiceSortKey) {
                        case 'id':       va = String(a.id||'');                          vb = String(b.id||''); break;
                        case 'customer': va = (a.customerName||'').toLowerCase();        vb = (b.customerName||'').toLowerCase(); break;
                        case 'table':    va = (a.tableNumber||'').toLowerCase();         vb = (b.tableNumber||'').toLowerCase(); break;
                        case 'date':     va = new Date(a.createdAt||a.created_at||0).getTime(); vb = new Date(b.createdAt||b.created_at||0).getTime(); break;
                        case 'amount':   va = Number(a.totalAmount||0);                  vb = Number(b.totalAmount||0); break;
                        case 'status':
                          va = getPaidStatus(a) ? 'PAID' : (a.invoice_status||'DRAFT');
                          vb = getPaidStatus(b) ? 'PAID' : (b.invoice_status||'DRAFT');
                          break;
                        default: va = vb = 0;
                      }
                      if (va < vb) return invoiceSortDir === 'asc' ? -1 : 1;
                      if (va > vb) return invoiceSortDir === 'asc' ? 1 : -1;
                      return 0;
                    });

                    if (rows.length === 0) return (
                      <tr><td colSpan={7} className="px-6 py-16 text-center text-[#9c8e85] italic text-sm">
                        {invoices.length === 0 ? 'No invoices yet. Orders will appear here.' : 'No invoices match your filters.'}
                      </td></tr>
                    );
                    // pagination
                    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
                    const safePage   = Math.min(invoicesPage, totalPages);
                    const pageRows   = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
                    return pageRows.map(inv => {
                      const isSession  = inv.invoice_type === 'SESSION';
                      const isPaid     = isSession
                        ? inv.session_status === 'closed'
                        : (inv.payment_status === 'PAID');
                      // Sessions that haven't requested the bill yet show as ACTIVE
                      const isSessionActive = isSession && inv.session_status === 'open';
                      const invStatus  = isSessionActive
                        ? 'ACTIVE'
                        : isPaid ? 'PAID' : ((inv.invoice_status || 'DRAFT') as 'DRAFT'|'PRINTED'|'ACTIVE');
                      const statusCfg: Record<string, { bg: string; text: string; label: string }> = {
                        PAID:    { bg: 'bg-green-100',  text: 'text-green-700',  label: 'PAID'    },
                        DRAFT:   { bg: 'bg-red-100',    text: 'text-red-700',    label: 'UNPAID'  },
                        PRINTED: { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'PRINTED' },
                        ACTIVE:  { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'ACTIVE'  },
                      };
                      const sc = statusCfg[invStatus] || statusCfg.DRAFT;
                      const dt = new Date(inv.createdAt || inv.created_at || Date.now());
                      return (
                        <tr key={inv.id} className="hover:bg-[#faf7f2]/30 transition-colors">
                          {/* Invoice ID + type badge */}
                          <td className="px-5 py-4">
                            <span className="font-mono text-xs font-bold text-[#cc5a16]">
                              #{String(inv.id).slice(-8).toUpperCase()}
                            </span>
                            <div className="mt-0.5">
                              <span className={cn(
                                "text-[11px] font-bold px-1.5 py-0.5 rounded uppercase tracking-widest",
                                isSession ? "bg-purple-100 text-purple-700" : "bg-[#cc5a16]/10 text-[#cc5a16]"
                              )}>
                                {isSession ? `Table · ${inv.round_count} round${inv.round_count !== 1 ? 's' : ''}` : 'Order'}
                              </span>
                            </div>
                          </td>
                          {/* Customer */}
                          <td className="px-5 py-4">
                            <p className="font-semibold text-sm text-[#1a1208]">{inv.customerName || '—'}</p>
                            {inv.customerPhone && <p className="text-[11px] text-[#9c8e85]">{inv.customerPhone}</p>}
                          </td>
                          {/* Table */}
                          <td className="px-5 py-4 text-sm text-[#3d3128]">{inv.tableNumber || '—'}</td>
                          {/* Date & Time */}
                          <td className="px-5 py-4 text-xs text-[#6b5d52] whitespace-nowrap">
                            <div>{dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}</div>
                            <div className="text-[11px] text-[#9c8e85] font-mono mt-0.5">
                              {dt.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12: false })}
                            </div>
                          </td>
                          {/* Amount */}
                          <td className="px-5 py-4 font-mono font-bold text-sm">
                            ₹{Number(inv.totalAmount||0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </td>
                          {/* Status */}
                          <td className="px-5 py-4">
                            <span className={cn("px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest", sc.bg, sc.text)}>
                              {sc.label || invStatus}
                            </span>
                          </td>
                          {/* Actions */}
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {/* Preview */}
                              <button
                                onClick={() => setPrintPreviewHtml(buildInvoiceHTML(inv, invoiceTemplate))}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#0d0a07]/5 text-[#6b5d52] hover:bg-[#0d0a07]/10 transition-all whitespace-nowrap flex items-center gap-1"
                                title={isSession ? `Preview consolidated invoice (${inv.round_count} rounds)` : 'Preview invoice'}
                              >
                                <Eye size={11} /> Preview
                              </button>
                              {/* Edit */}
                              {!isPaid && (
                                <button
                                  onClick={() => openInvoiceEdit(inv)}
                                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#0d0a07]/5 text-[#6b5d52] hover:bg-[#faf7f2] hover:text-[#1a1208] transition-all whitespace-nowrap flex items-center gap-1"
                                  title="Edit invoice adjustments"
                                >
                                  <Edit3 size={11} /> Edit
                                </button>
                              )}
                              {/* Print */}
                              <button
                                onClick={() => {
                                  const html = buildInvoiceHTML(inv, invoiceTemplate);
                                  openThermalPrint(html);
                                  if (invStatus !== 'PRINTED' && invStatus !== 'PAID') patchInvoiceStatus(inv, 'PRINTED');
                                }}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#cc5a16]/10 text-[#cc5a16] hover:bg-[#cc5a16]/20 transition-all whitespace-nowrap flex items-center gap-1"
                              >
                                <Printer size={11} /> Print
                              </button>
                              {/* Mark Paid */}
                              {!isPaid && (
                                <button
                                  onClick={() => openInvoiceEdit(inv)}
                                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-green-100 text-green-700 hover:bg-green-200 transition-all whitespace-nowrap"
                                  title="Open to mark as paid"
                                >
                                  ₹ Paid
                                </button>
                              )}
                              {/* Delete (admin-gated, per-tenant flag) — restaurant
                                  state is loaded from GET /api/restaurant/:id which
                                  returns SELECT *, so it includes invoice_delete_enabled */}
                              {Number((restaurant as any)?.invoice_delete_enabled || 0) === 1 && isInvoiceDeletable(inv) && (
                                <button
                                  onClick={() => openDeleteInvoiceModal(inv)}
                                  className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-50 text-red-700 hover:bg-red-100 transition-all whitespace-nowrap flex items-center gap-1"
                                  title="Permanently delete this invoice"
                                >
                                  <Trash2 size={11} /> Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            {(() => {
              const q = invoiceSearch.toLowerCase();
              let rows = invoices.filter(inv => {
                const paidNow = inv.invoice_type === 'SESSION' ? inv.session_status === 'closed' : inv.payment_status === 'PAID';
                if (invoiceStatusFilter === 'PAID'    && !paidNow) return false;
                if (invoiceStatusFilter === 'UNPAID'  && paidNow)  return false;
                if (invoiceStatusFilter === 'PRINTED' && (inv.invoice_status !== 'PRINTED' || paidNow)) return false;
                if (!q) return true;
                return (
                  String(inv.id||'').toLowerCase().includes(q) ||
                  (inv.customerName||'').toLowerCase().includes(q) ||
                  (inv.customerPhone||'').includes(q) ||
                  (inv.tableNumber||'').toLowerCase().includes(q)
                );
              });
              const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
              return <PaginationBar page={Math.min(invoicesPage, totalPages)} totalPages={totalPages} setPage={setInvoicesPage} total={rows.length} />;
            })()}
          </div>
        </div>

      ) : activeTab === 'QR' ? (
        <div className="max-w-4xl space-y-8">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
            <h2 className="text-3xl font-bold font-serif">QR Code Management</h2>
            <button
              type="button"
              onClick={downloadAllQRs}
              className="flex items-center gap-2 px-6 py-3 bg-[#cc5a16] text-white rounded-2xl font-bold hover:bg-[#a84612] transition-all shadow-lg shadow-[#5A5A40]/20 self-start sm:self-auto"
            >
              <Download size={18} /> Download All QRs
            </button>
          </div>

          <div className="bg-white p-5 sm:p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-8">
            <div className="max-w-md space-y-4">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Number of Tables</label>
              <div className="flex gap-2">
                <input 
                  type="number"
                  min="0"
                  className="flex-1 bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                  value={restaurant?.table_count || 0}
                  onChange={e => setRestaurant(prev => prev ? { ...prev, table_count: parseInt(e.target.value) || 0 } : null)}
                />
                <button 
                  type="button"
                  onClick={updateRestaurant}
                  className="px-6 py-3 bg-[#cc5a16] text-white rounded-2xl font-bold hover:bg-[#a84612] transition-all"
                >
                  Update Tables
                </button>
              </div>
              <p className="text-[11px] text-[#6b5d52]">Update the table count to generate new QR codes for your restaurant.</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6">
              {/* Online Order QR */}
              <div className="bg-[#faf7f2] p-3 sm:p-6 rounded-3xl sm:rounded-[32px] text-center space-y-3 border border-transparent hover:border-[#cc5a16]/10 transition-all">
                <div className="bg-white p-2 sm:p-4 rounded-2xl inline-block shadow-sm">
                  <QRCodeCanvas id="qr-online" value={`${window.location.origin}?r=${restaurantId}`} size={100} />
                </div>
                <div>
                  <p className="text-sm font-bold text-[#1a1a1a]">Online Order</p>
                  <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest">General Access</p>
                </div>
                <button 
                  type="button"
                  onClick={() => downloadQR('qr-online', 'online_order_qr')}
                  className="w-full py-2 text-[11px] font-bold uppercase tracking-widest border border-[#cc5a16]/20 rounded-xl hover:bg-[#cc5a16] hover:text-white transition-all"
                >
                  Download
                </button>
              </div>

              {/* Table QRs */}
              {tables.map((table) => (
                <div key={table.id} className="bg-white p-3 sm:p-6 rounded-3xl sm:rounded-[32px] text-center space-y-3 border border-[#cc5a16]/10 hover:shadow-md transition-all">
                  <div className="bg-white p-2 sm:p-4 rounded-2xl inline-block border border-[#faf7f2]">
                    <QRCodeCanvas id={`qr-table-${table.id}`} value={`${window.location.origin}?r=${restaurantId}&table=${table.id}`} size={100} />
                  </div>
                  <div className="space-y-2">
                    <input 
                      type="text"
                      className="w-full text-center text-sm font-bold text-[#1a1a1a] bg-transparent border-b border-dashed border-[#cc5a16]/20 focus:border-[#cc5a16] outline-none"
                      value={table.name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setTables(prev => prev.map(t => t.id === table.id ? { ...t, name: newName } : t));
                      }}
                      onBlur={(e) => updateTableName(table.id, e.target.value)}
                    />
                    <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest">Dine-in</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => downloadQR(`qr-table-${table.id}`, table.name.replace(/\s+/g, '_').toLowerCase())}
                    className="w-full py-2 text-[11px] font-bold uppercase tracking-widest border border-[#cc5a16]/20 rounded-xl hover:bg-[#cc5a16] hover:text-white transition-all"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
            
            <div className="p-6 bg-[#cc5a16]/5 rounded-2xl border border-dashed border-[#cc5a16]/20 text-center">
              <p className="text-xs text-[#3d3128] italic">
                Tip: Print these QR codes and place them on your tables. When scanned, they will automatically assign the table number to the customer's order.
              </p>
            </div>
          </div>
        </div>
      ) : activeTab === 'ROOMS' && isHotelEnabled ? (
        /* ════════════════ ROOMS — Hospitality module ════════════════ */
        (() => {
          // Status counts for the filter pills (unfiltered — reflects the full property)
          const counts: Record<string, number> = {
            ALL: hotelRooms.length,
            VACANT: 0, OCCUPIED: 0, CLEANING: 0, MAINTENANCE: 0, BLOCKED: 0,
            SMOKING: 0, NON_SMOKING: 0,
          };
          for (const r of hotelRooms) {
            counts[r.status] = (counts[r.status] || 0) + 1;
            if (r.smoking_preference === 'SMOKING') counts.SMOKING++;
            else counts.NON_SMOKING++;
          }
          // Apply filters
          const q = roomSearch.trim().toLowerCase();
          const filteredRooms = hotelRooms.filter((r: any) => {
            if (roomStatusFilter !== 'ALL' && r.status !== roomStatusFilter) return false;
            if (roomSmokingFilter !== 'ALL') {
              const sp = r.smoking_preference || 'NON_SMOKING';
              if (sp !== roomSmokingFilter) return false;
            }
            if (q) {
              const hay = `${r.name || ''} ${r.room_number || ''} ${r.type || ''} ${r.floor || ''}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          });

          const statusPills: Array<{ key: typeof roomStatusFilter; label: string; color: string }> = [
            { key: 'ALL',         label: 'All',          color: '#1a1208' },
            { key: 'VACANT',      label: 'Vacant',       color: '#0f766e' },
            { key: 'OCCUPIED',    label: 'Occupied',     color: '#b8860b' },
            { key: 'CLEANING',    label: 'Cleaning',     color: '#2563a8' },
            { key: 'MAINTENANCE', label: 'Maintenance',  color: '#c13b3b' },
            { key: 'BLOCKED',     label: 'Blocked',      color: '#6b5d52' },
          ];

          return (
          <div className="space-y-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Rooms</h2>
                <p className="text-sm text-[#6b5d52] mt-1">Manage your property's rooms, statuses, and QR codes.</p>
              </div>
              <button
                onClick={() => { setEditingRoom({}); setShowRoomModal(true); }}
                className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] transition-all flex items-center gap-2 shadow-md shadow-[#cc5a16]/20"
              >
                <Plus size={16} /> Add Room
              </button>
            </div>

            {hotelError && <div className="px-4 py-3 rounded-xl bg-[#fdf0f0] border border-[#c13b3b]/20 text-[#c13b3b] text-sm">{hotelError}</div>}

            {hotelRooms.length === 0 ? (
              <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 p-12 text-center">
                <Bed className="mx-auto text-[#cc5a16] mb-3" size={40} />
                <h3 className="text-lg font-bold font-serif text-[#1a1208]">No rooms yet</h3>
                <p className="text-sm text-[#6b5d52] mt-1 mb-4">Add your first room to start accepting guest service requests.</p>
                <button onClick={() => { setEditingRoom({}); setShowRoomModal(true); }} className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612]">Add Room</button>
              </div>
            ) : (
            <>
              {/* ── Filter bar ───────────────────────────────────────── */}
              <div className="bg-white rounded-2xl border border-[#cc5a16]/10 p-3 flex flex-col lg:flex-row lg:items-center gap-3">
                {/* Search */}
                <div className="relative lg:w-60">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search room name / number…"
                    value={roomSearch}
                    onChange={e => setRoomSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-sm bg-[#faf7f2] rounded-xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20"
                  />
                </div>
                {/* Status pills */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {statusPills.map(p => (
                    <button
                      key={p.key}
                      onClick={() => setRoomStatusFilter(p.key)}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-1.5",
                        roomStatusFilter === p.key
                          ? "text-white shadow-sm"
                          : "bg-[#faf7f2] text-[#6b5d52] hover:bg-[#cc5a16]/10"
                      )}
                      style={roomStatusFilter === p.key ? { background: p.color } : undefined}
                    >
                      {p.label}
                      <span className={cn(
                        "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold",
                        roomStatusFilter === p.key ? "bg-white/25" : "bg-[#cc5a16]/10 text-[#cc5a16]"
                      )}>{counts[p.key] ?? 0}</span>
                    </button>
                  ))}
                </div>
                {/* Smoking filter */}
                <div className="flex items-center gap-1.5 lg:ml-auto">
                  <span className="text-[10px] text-[#9c8e85] uppercase tracking-widest font-bold">Smoking</span>
                  {([
                    ['ALL', 'All'], ['NON_SMOKING', 'Non-Smoking'], ['SMOKING', 'Smoking'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setRoomSmokingFilter(key)}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider whitespace-nowrap transition-all",
                        roomSmokingFilter === key
                          ? "bg-[#1a1208] text-white shadow-sm"
                          : "bg-[#faf7f2] text-[#6b5d52] hover:bg-[#cc5a16]/10"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Filtered grid ────────────────────────────────────── */}
              {filteredRooms.length === 0 ? (
                <div className="bg-white rounded-[32px] border border-dashed border-[#cc5a16]/20 p-12 text-center">
                  <Filter className="mx-auto text-[#9c8e85] mb-3" size={32} />
                  <p className="text-sm text-[#6b5d52]">No rooms match the current filters.</p>
                  <button
                    onClick={() => { setRoomStatusFilter('ALL'); setRoomSmokingFilter('ALL'); setRoomSearch(''); }}
                    className="mt-3 text-xs text-[#cc5a16] font-bold uppercase tracking-widest hover:underline"
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredRooms.map((room: any) => {
                  const statusColor: any = {
                    VACANT:      { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
                    OCCUPIED:    { bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-700'   },
                    CLEANING:    { bg: 'bg-blue-50',    border: 'border-blue-200',    text: 'text-blue-700'    },
                    MAINTENANCE: { bg: 'bg-rose-50',    border: 'border-rose-200',    text: 'text-rose-700'    },
                    BLOCKED:     { bg: 'bg-slate-50',   border: 'border-slate-200',   text: 'text-slate-700'   },
                  }[room.status] || { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700' };
                  const qrUrl = `${window.location.origin}/${room.qr_code_data || `?r=${restaurantId}&room=${room.id}`}`;
                  const sp = room.smoking_preference || 'NON_SMOKING';
                  const smokingBadge = sp === 'SMOKING'
                    ? { label: '🚬 Smoking', className: 'bg-rose-50 text-rose-700 border-rose-200' }
                    : sp === 'ANY'
                      ? { label: 'Any', className: 'bg-slate-50 text-slate-700 border-slate-200' }
                      : { label: '🚭 Non-Smoking', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
                  return (
                    <div key={room.id} className="bg-white rounded-3xl border border-[#cc5a16]/10 p-5 shadow-sm">
                      <div className="flex items-start justify-between mb-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-serif font-bold text-[#1a1208] truncate">{room.name}</h3>
                          <p className="text-xs text-[#9c8e85] mt-0.5">{room.type || 'STANDARD'} · {room.capacity || 2} guests · ₹{Number(room.base_rate || 0).toLocaleString('en-IN')}</p>
                        </div>
                        <span className={cn("px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border", statusColor.bg, statusColor.border, statusColor.text)}>
                          {room.status}
                        </span>
                      </div>
                      {/* Smoking badge */}
                      <div className="mb-3">
                        <span className={cn("inline-block px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide border", smokingBadge.className)}>
                          {smokingBadge.label}
                        </span>
                      </div>
                      <div className="flex gap-1.5 flex-wrap mb-3">
                        {['VACANT','OCCUPIED','CLEANING','MAINTENANCE','BLOCKED'].map(st => (
                          <button
                            key={st}
                            onClick={() => updateRoomStatus(room.id, st)}
                            title={st}
                            className={cn("px-2 py-1 text-[10px] font-bold uppercase rounded-lg transition-colors", room.status === st ? 'bg-[#cc5a16] text-white' : 'bg-[#faf7f2] text-[#6b5d52] hover:bg-[#cc5a16]/10')}
                          >
                            {st[0]}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2 pt-3 border-t border-[#cc5a16]/10">
                        <button onClick={() => setRoomQrPreview({ ...room, qrUrl })} className="flex-1 px-3 py-2 rounded-xl bg-[#faf7f2] text-[#cc5a16] text-xs font-bold hover:bg-[#cc5a16]/10 flex items-center justify-center gap-1" title="View QR code"><QrCode size={14} /> QR</button>
                        <button onClick={() => { setEditingRoom(room); setShowRoomModal(true); }} className="flex-1 px-3 py-2 rounded-xl bg-[#faf7f2] text-[#3d3128] text-xs font-bold hover:bg-[#cc5a16]/10">Edit</button>
                        <button onClick={() => deleteRoom(room.id)} className="px-3 py-2 rounded-xl bg-[#fdf0f0] text-[#c13b3b] text-xs font-bold hover:bg-[#c13b3b]/10" title="Delete"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </>
            )}
          </div>
          );
        })()
      ) : activeTab === 'SERVICES' && isHotelEnabled ? (
        /* ════════════════ SERVICES — Hospitality catalogue ════════════════ */
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Services Catalogue</h2>
              <p className="text-sm text-[#6b5d52] mt-1">Configure what guests can request from their room.</p>
            </div>
            <button
              onClick={() => { setEditingService({}); setShowServiceModal(true); }}
              className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] transition-all flex items-center gap-2 shadow-md shadow-[#cc5a16]/20"
            >
              <Plus size={16} /> Add Service
            </button>
          </div>
          {hotelError && <div className="px-4 py-3 rounded-xl bg-[#fdf0f0] border border-[#c13b3b]/20 text-[#c13b3b] text-sm">{hotelError}</div>}
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            {hotelServices.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#6b5d52]">No services yet. Defaults are seeded when you enable the hotel module.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#faf7f2] text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left px-4 py-3">Service</th>
                    <th className="text-left px-4 py-3">Category</th>
                    <th className="text-left px-4 py-3">SLA</th>
                    <th className="text-left px-4 py-3">Role</th>
                    <th className="text-right px-4 py-3">Price</th>
                    <th className="px-4 py-3">Active</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hotelServices.map((svc: any) => (
                    <tr key={svc.id} className="border-t border-[#cc5a16]/10 hover:bg-[#faf7f2]/50">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#1a1208]">{svc.name}</div>
                        {svc.description && <div className="text-[11px] text-[#9c8e85] mt-0.5 line-clamp-1">{svc.description}</div>}
                      </td>
                      <td className="px-4 py-3"><span className="px-2 py-1 rounded-md bg-[#cc5a16]/10 text-[#cc5a16] text-[10px] font-bold uppercase tracking-wide">{svc.category}</span></td>
                      <td className="px-4 py-3 text-[#3d3128] font-mono text-xs">{svc.sla_minutes} min</td>
                      <td className="px-4 py-3 text-[#3d3128] text-xs">{svc.assigned_role || '—'}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        {svc.is_complimentary ? <span className="text-emerald-600 text-xs font-bold">COMP</span> : <span className="text-[#1a1208]">₹{Number(svc.price || 0).toLocaleString('en-IN')}</span>}
                      </td>
                      <td className="px-4 py-3 text-center">{svc.is_active ? <Check size={16} className="text-emerald-600 mx-auto" /> : <X size={16} className="text-[#9c8e85] mx-auto" />}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => { setEditingService(svc); setShowServiceModal(true); }} className="px-3 py-1.5 rounded-lg bg-[#faf7f2] text-[#3d3128] text-[11px] font-bold hover:bg-[#cc5a16]/10 mr-2">Edit</button>
                        <button onClick={() => deleteService(svc.id)} className="px-3 py-1.5 rounded-lg bg-[#fdf0f0] text-[#c13b3b] text-[11px] font-bold hover:bg-[#c13b3b]/10">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : activeTab === 'SERVICE_REQUESTS' && isHotelEnabled ? (
        /* ════════════════ SERVICE REQUESTS — Staff unified dashboard ════════════════ */
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Service Requests</h2>
              <p className="text-sm text-[#6b5d52] mt-1">Live guest requests across housekeeping, maintenance, concierge, and front desk.</p>
            </div>
            <button onClick={() => fetchHotelRequests()} className="px-4 py-2 rounded-xl border border-[#cc5a16]/20 text-[#cc5a16] text-xs font-bold uppercase hover:bg-[#cc5a16]/5 flex items-center gap-2">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
          {hotelRequests.length === 0 ? (
            <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 p-12 text-center">
              <Check className="mx-auto text-emerald-600 mb-3" size={40} />
              <h3 className="text-lg font-bold font-serif text-[#1a1208]">All caught up</h3>
              <p className="text-sm text-[#6b5d52] mt-1">No pending service requests right now.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {hotelRequests.map((r: any) => {
                const priorityColor = r.priority === 'URGENT' ? 'rose' : r.priority === 'HIGH' ? 'orange' : 'slate';
                const statusLabel = { PENDING: 'Pending', ACKNOWLEDGED: 'Acknowledged', IN_PROGRESS: 'In Progress' }[r.status as any] || r.status;
                const elapsedMin = Math.floor((Date.now() - new Date(r.requested_at).getTime()) / 60000);
                return (
                  <div
                    key={r.id}
                    className={cn(
                      "bg-white rounded-3xl border border-[#cc5a16]/10 p-5 shadow-sm",
                      alertsEnabled && r.status === 'PENDING' && "alert-pulse"
                    )}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="font-serif font-bold text-[#1a1208] truncate">{r.service_name}</h3>
                        <p className="text-xs text-[#9c8e85] mt-0.5">Room: <strong className="text-[#3d3128]">{r.room_name || r.room_id}</strong></p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-bold uppercase", `bg-${priorityColor}-50 text-${priorityColor}-700 border border-${priorityColor}-200`)}>{r.priority}</span>
                        <span className="text-[10px] text-[#9c8e85] font-mono">{elapsedMin} min ago</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="px-2 py-1 rounded-md bg-[#cc5a16]/10 text-[#cc5a16] text-[10px] font-bold uppercase">{r.category}</span>
                      <span className="text-[11px] text-[#6b5d52]">Role: {r.assigned_role}</span>
                      <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-bold uppercase", r.status === 'PENDING' ? 'bg-rose-50 text-rose-700' : r.status === 'IN_PROGRESS' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700')}>{statusLabel}</span>
                    </div>
                    {r.notes && <p className="text-xs text-[#3d3128] italic mb-3 p-2 bg-[#faf7f2] rounded-xl">"{r.notes}"</p>}
                    <div className="flex gap-2 pt-3 border-t border-[#cc5a16]/10">
                      {r.status === 'PENDING' && (
                        <button onClick={() => updateRequestStatus(r.id, 'ACKNOWLEDGED')} className="flex-1 px-3 py-2 rounded-xl bg-[#faf7f2] text-[#3d3128] text-xs font-bold hover:bg-[#cc5a16]/10">Acknowledge</button>
                      )}
                      {(r.status === 'PENDING' || r.status === 'ACKNOWLEDGED') && (
                        <button onClick={() => updateRequestStatus(r.id, 'IN_PROGRESS')} className="flex-1 px-3 py-2 rounded-xl bg-amber-50 text-amber-700 text-xs font-bold hover:bg-amber-100">Start</button>
                      )}
                      <button onClick={() => updateRequestStatus(r.id, 'COMPLETED')} className="flex-1 px-3 py-2 rounded-xl bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-600">Complete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : activeTab === 'HOTEL_BOOKINGS' && isHotelEnabled ? (
        /* ════════════════ HOTEL BOOKINGS ════════════════ */
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Hotel Bookings</h2>
              <p className="text-sm text-[#6b5d52] mt-1">Manage reservations, check-ins, and check-outs.</p>
            </div>
            <button onClick={() => { setEditingBooking({ check_in_date: new Date().toISOString().slice(0,10), check_out_date: new Date(Date.now()+86400000).toISOString().slice(0,10) }); setShowBookingModal(true); }} className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] transition-all flex items-center gap-2 shadow-md shadow-[#cc5a16]/20">
              <Plus size={16} /> New Booking
            </button>
          </div>
          {hotelError && <div className="px-4 py-3 rounded-xl bg-[#fdf0f0] border border-[#c13b3b]/20 text-[#c13b3b] text-sm">{hotelError}</div>}

          {/* Today's Arrivals & Departures */}
          {(() => {
            const today = new Date().toISOString().slice(0,10);
            const arrivals = hotelBookings.filter((b: any) => b.status === 'BOOKED' && b.check_in_date && b.check_in_date.slice(0,10) === today);
            const departures = hotelBookings.filter((b: any) => b.status === 'CHECKED_IN' && b.check_out_date && b.check_out_date.slice(0,10) === today);
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-3xl border border-[#cc5a16]/10 p-5" style={{ borderTop: '3px solid #0f766e' }}>
                  <h3 className="text-sm font-bold uppercase tracking-widest text-[#0f766e] mb-3">Today's Arrivals · {arrivals.length}</h3>
                  {arrivals.length === 0 ? <p className="text-sm text-[#9c8e85]">No arrivals today</p> : arrivals.map((b: any) => (
                    <div key={b.id} className="flex items-center justify-between py-2 border-b border-[#cc5a16]/10 last:border-0">
                      <div>
                        <p className="font-semibold text-[#1a1208] text-sm">{b.guest_name}</p>
                        <p className="text-xs text-[#9c8e85]">{b.room_name || b.room_id}</p>
                      </div>
                      <button onClick={() => checkInBooking(b.id)} className="px-3 py-1.5 rounded-lg bg-[#0f766e] text-white text-xs font-bold hover:bg-[#0a5853]">Check In</button>
                    </div>
                  ))}
                </div>
                <div className="bg-white rounded-3xl border border-[#cc5a16]/10 p-5" style={{ borderTop: '3px solid #b8860b' }}>
                  <h3 className="text-sm font-bold uppercase tracking-widest text-[#b8860b] mb-3">Today's Departures · {departures.length}</h3>
                  {departures.length === 0 ? <p className="text-sm text-[#9c8e85]">No departures today</p> : departures.map((b: any) => (
                    <div key={b.id} className="flex items-center justify-between py-2 border-b border-[#cc5a16]/10 last:border-0">
                      <div>
                        <p className="font-semibold text-[#1a1208] text-sm">{b.guest_name}</p>
                        <p className="text-xs text-[#9c8e85]">{b.room_name || b.room_id}</p>
                      </div>
                      <button onClick={() => { setCheckoutBooking(b); setShowCheckoutModal(true); }} className="px-3 py-1.5 rounded-lg bg-[#b8860b] text-white text-xs font-bold hover:bg-[#8f6608]">Check Out</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* All bookings list */}
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            {hotelBookings.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#6b5d52]">No bookings yet. Create your first booking above.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#faf7f2] text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left px-4 py-3">Guest</th>
                    <th className="text-left px-4 py-3">Room</th>
                    <th className="text-left px-4 py-3">Dates</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-right px-4 py-3">Total</th>
                    <th className="text-right px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hotelBookings.map((b: any) => {
                    const statusColor = b.status === 'CHECKED_IN' ? 'bg-amber-50 text-amber-700'
                      : b.status === 'CHECKED_OUT' ? 'bg-slate-100 text-slate-500'
                      : b.status === 'CANCELLED' ? 'bg-rose-50 text-rose-700'
                      : 'bg-emerald-50 text-emerald-700';
                    return (
                      <tr key={b.id} className="border-t border-[#cc5a16]/10 hover:bg-[#faf7f2]/50">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-[#1a1208]">{b.guest_name}</div>
                          <div className="text-[11px] text-[#9c8e85]">{b.guest_phone || '—'} {b.guest_nationality ? `· ${b.guest_nationality}` : ''}</div>
                        </td>
                        <td className="px-4 py-3 text-[#3d3128]">{b.room_name || b.room_id}</td>
                        <td className="px-4 py-3 text-xs text-[#3d3128]">
                          {new Date(b.check_in_date).toLocaleDateString('en-IN')} →<br />
                          {new Date(b.check_out_date).toLocaleDateString('en-IN')}
                        </td>
                        <td className="px-4 py-3"><span className={cn("px-2 py-1 rounded-md text-[10px] font-bold uppercase", statusColor)}>{b.status.replace('_', ' ')}</span></td>
                        <td className="px-4 py-3 text-right font-mono text-[#1a1208]">₹{Number(b.total_amount || 0).toLocaleString('en-IN')}</td>
                        <td className="px-4 py-3 text-right">
                          {b.status === 'BOOKED' && <button onClick={() => checkInBooking(b.id)} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-bold hover:bg-emerald-600 mr-1">Check In</button>}
                          {b.status === 'CHECKED_IN' && <button onClick={() => { setCheckoutBooking(b); setShowCheckoutModal(true); }} className="px-3 py-1.5 rounded-lg bg-[#b8860b] text-white text-[11px] font-bold hover:bg-[#8f6608] mr-1">Check Out</button>}
                          {(b.status === 'BOOKED') && <button onClick={() => cancelBooking(b.id)} className="px-3 py-1.5 rounded-lg bg-[#fdf0f0] text-[#c13b3b] text-[11px] font-bold hover:bg-[#c13b3b]/10">Cancel</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : activeTab === 'FOLIOS' && isHotelEnabled ? (
        /* ════════════════ FOLIOS ════════════════ */
        <div className="space-y-5">
          <div>
            <h2 className="text-3xl font-bold font-serif text-[#1a1208]">Folios</h2>
            <p className="text-sm text-[#6b5d52] mt-1">Per-booking ledgers. Charges auto-post on check-in and when chargeable services complete.</p>
          </div>
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            {hotelFolios.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#6b5d52]">No folios yet. Folios are created automatically on check-in.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#faf7f2] text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left px-4 py-3">Guest</th>
                    <th className="text-left px-4 py-3">Room</th>
                    <th className="text-left px-4 py-3">Dates</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-right px-4 py-3">Subtotal</th>
                    <th className="text-right px-4 py-3">GST</th>
                    <th className="text-right px-4 py-3">Grand Total</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {hotelFolios.map((f: any) => (
                    <tr key={f.id} className="border-t border-[#cc5a16]/10 hover:bg-[#faf7f2]/50">
                      <td className="px-4 py-3 font-semibold text-[#1a1208]">{f.guest_name || '—'}</td>
                      <td className="px-4 py-3 text-[#3d3128]">{f.room_name || f.room_id}</td>
                      <td className="px-4 py-3 text-xs text-[#3d3128]">
                        {f.check_in_date && new Date(f.check_in_date).toLocaleDateString('en-IN')}<br />
                        {f.check_out_date && new Date(f.check_out_date).toLocaleDateString('en-IN')}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-1 rounded-md text-[10px] font-bold uppercase",
                          f.status === 'open' ? 'bg-amber-50 text-amber-700'
                          : f.status === 'settled' ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-100 text-slate-500')}>{f.status}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">₹{Number(f.subtotal || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-right font-mono text-[#6b5d52]">₹{Number(f.gst_amount || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-[#1a1208]">₹{Number(f.grand_total || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => loadFolio(f.id)} className="px-3 py-1.5 rounded-lg bg-[#faf7f2] text-[#3d3128] text-[11px] font-bold hover:bg-[#cc5a16]/10">View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : activeTab === 'COMPLIANCE' && isHotelEnabled ? (
        /* ════════════════ COMPLIANCE ════════════════ */
        <div className="space-y-5">
          <div>
            <h2 className="text-3xl font-bold font-serif text-[#1a1208]">India Compliance</h2>
            <p className="text-sm text-[#6b5d52] mt-1">Form-C / FRRO tracking for foreign guest registration.</p>
          </div>
          <div className="px-4 py-3 rounded-2xl bg-[#fef6e7] border border-[#b8860b]/30 text-[#6b5d52] text-xs">
            <strong className="text-[#b8860b]">Workflow:</strong> For every foreign national, click <em>Download PDF</em> to generate the Form C, print/sign it, and submit at your nearest FRRO / local police office within 24 hours of arrival. Direct FRRO portal integration is planned for a future release.
          </div>
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            {complianceList.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#6b5d52]">No foreign-national bookings. Enter "Nationality" on a booking to surface them here.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#faf7f2] text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left px-4 py-3">Guest</th>
                    <th className="text-left px-4 py-3">Nationality</th>
                    <th className="text-left px-4 py-3">Room</th>
                    <th className="text-left px-4 py-3">Stay</th>
                    <th className="text-center px-4 py-3">Form-C Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {complianceList.map((b: any) => (
                    <tr key={b.id} className="border-t border-[#cc5a16]/10">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#1a1208]">{b.guest_name}</div>
                        <div className="text-[11px] text-[#9c8e85]">{b.guest_id_proof || 'ID not provided'}</div>
                      </td>
                      <td className="px-4 py-3 text-[#3d3128]">{b.guest_nationality}</td>
                      <td className="px-4 py-3 text-[#3d3128]">{b.room_name || b.room_id}</td>
                      <td className="px-4 py-3 text-xs text-[#3d3128]">
                        {new Date(b.check_in_date).toLocaleDateString('en-IN')} →<br />
                        {new Date(b.check_out_date).toLocaleDateString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {Number(b.form_c_submissions) > 0
                          ? <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase">Drafted</span>
                          : <span className="px-2 py-1 rounded-md bg-rose-50 text-rose-700 text-[10px] font-bold uppercase">Pending</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button onClick={() => downloadFormCPdf(b)} className="px-3 py-1.5 rounded-lg bg-[#cc5a16] text-white text-[11px] font-bold hover:bg-[#a84612] inline-flex items-center gap-1">
                          <Download size={12}/> Download PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : activeTab === 'CONCIERGE_FAQ' && isHotelEnabled ? (
        /* ════════════════ CONCIERGE FAQ (Phase 4) ════════════════ */
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl font-bold font-serif text-[#1a1208]">AI Concierge · Knowledge Base</h2>
              <p className="text-sm text-[#6b5d52] mt-1">Teach the in-room chatbot about your property. Guests chat from the QR-scanner interface.</p>
            </div>
            <button onClick={() => { setEditingFaq({ category: 'General' }); setShowFaqModal(true); }} className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] flex items-center gap-2 shadow-md shadow-[#cc5a16]/20"><Plus size={16}/> Add FAQ</button>
          </div>
          <div className="px-4 py-3 rounded-2xl bg-[#eff5fd] border border-[#2563a8]/20 text-[#6b5d52] text-xs">
            <strong className="text-[#2563a8]">Tip:</strong> Add WiFi password, pool hours, breakfast timings, restaurant location, nearby attractions. The chatbot will answer guests in your property's voice, 24/7.
          </div>
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            {hotelFaqs.length === 0 ? (
              <div className="p-12 text-center text-sm text-[#6b5d52]">No FAQs yet. The chatbot will fall back to general knowledge until you add entries.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-[#faf7f2] text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left px-4 py-3">Question</th>
                    <th className="text-left px-4 py-3">Answer</th>
                    <th className="text-left px-4 py-3">Category</th>
                    <th className="px-4 py-3">Active</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hotelFaqs.map((f: any) => (
                    <tr key={f.id} className="border-t border-[#cc5a16]/10">
                      <td className="px-4 py-3 font-semibold text-[#1a1208] align-top">{f.question}</td>
                      <td className="px-4 py-3 text-[#3d3128] text-xs align-top max-w-md">{f.answer}</td>
                      <td className="px-4 py-3 align-top"><span className="px-2 py-1 rounded-md bg-[#cc5a16]/10 text-[#cc5a16] text-[10px] font-bold uppercase">{f.category || 'General'}</span></td>
                      <td className="px-4 py-3 align-top text-center">{f.is_active ? <Check size={16} className="text-emerald-600 mx-auto"/> : <X size={16} className="text-[#9c8e85] mx-auto"/>}</td>
                      <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                        <button onClick={() => { setEditingFaq(f); setShowFaqModal(true); }} className="px-3 py-1.5 rounded-lg bg-[#faf7f2] text-[#3d3128] text-[11px] font-bold hover:bg-[#cc5a16]/10 mr-1">Edit</button>
                        <button onClick={() => deleteFaq(f.id)} className="px-3 py-1.5 rounded-lg bg-[#fdf0f0] text-[#c13b3b] text-[11px] font-bold hover:bg-[#c13b3b]/10">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : activeTab === 'SETTINGS' ? (
        <div className="max-w-xl space-y-6">
          {/* ── Property Type: Restaurant / Hotel toggle ─────────────── */}
          <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-[3px] bg-[#b8860b]"></div>
            <h3 className="text-2xl font-bold font-serif mb-1">Property Type</h3>
            <p className="text-xs text-[#6b5d52] mb-5">
              Select what your business offers. You can enable both if you are a resort with an on-site restaurant.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={async () => {
                  // Toggle restaurant — not much backend work since RESTAURANT is the default.
                  // This UI is for visual symmetry with the hotel toggle.
                }}
                disabled
                className={cn(
                  "relative p-5 rounded-2xl border-2 text-left transition-all",
                  isRestaurantEnabled
                    ? "border-[#cc5a16] bg-[#cc5a16]/5"
                    : "border-[#cc5a16]/10 bg-[#faf7f2] opacity-50"
                )}
              >
                {isRestaurantEnabled && <Check size={18} className="absolute top-3 right-3 text-[#cc5a16]" />}
                <div className="text-2xl mb-2">🍽</div>
                <div className="font-bold text-[#1a1208]">Restaurant</div>
                <div className="text-[11px] text-[#6b5d52] mt-1">Tables · QR ordering · Kitchen display</div>
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const result = await toggleHotelModule(!isHotelEnabled);
                    alert(result.message || 'Updated');
                  } catch (err: any) {
                    alert(err.message || 'Failed');
                  }
                }}
                disabled={hotelLoading}
                className={cn(
                  "relative p-5 rounded-2xl border-2 text-left transition-all",
                  isHotelEnabled
                    ? "border-[#b8860b] bg-[#b8860b]/5"
                    : "border-[#cc5a16]/10 bg-[#faf7f2] hover:border-[#b8860b]/30"
                )}
              >
                {isHotelEnabled && <Check size={18} className="absolute top-3 right-3 text-[#b8860b]" />}
                <div className="text-2xl mb-2">🏨</div>
                <div className="font-bold text-[#1a1208]">Hotel / Resort</div>
                <div className="text-[11px] text-[#6b5d52] mt-1">Rooms · In-room QR · Service requests</div>
                {hotelLoading && <div className="mt-2 text-[11px] text-[#cc5a16] font-bold">Updating…</div>}
              </button>
            </div>
            {isHotelEnabled && (
              <div className="mt-4 px-4 py-3 rounded-xl bg-[#b8860b]/10 border border-[#b8860b]/20 text-[#6b5d52] text-xs">
                <strong className="text-[#b8860b]">Hotel module active.</strong> New tabs appeared above: <em>Rooms · Services · Service Requests</em>. Default services have been seeded — customise them under the Services tab.
              </div>
            )}
          </div>

          {/* ── Brand Logo (used on invoice PDF) ───────────────────── */}
          <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
            <h3 className="text-2xl font-bold font-serif mb-1">Brand Logo</h3>
            <p className="text-xs text-[#6b5d52] mb-5">
              Upload a square or horizontal logo. Embedded on tax invoices, credit notes, and Form-C PDFs.
              PNG or JPG recommended, ~200×200 px or larger. Max 2 MB.
            </p>
            <div className="flex items-center gap-5">
              <div className="w-24 h-24 rounded-2xl bg-[#faf7f2] border border-[#cc5a16]/10 flex items-center justify-center overflow-hidden shrink-0">
                {(restaurant as any)?.logo_url ? (
                  <img src={(restaurant as any).logo_url} alt="Logo" className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[10px] text-[#9c8e85] uppercase tracking-wider">No logo</span>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <input
                  id="hotel-logo-input"
                  type="file"
                  accept="image/png, image/jpeg"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) { alert('Logo must be under 2 MB'); return; }
                    const fd = new FormData();
                    fd.append('logo', file);
                    try {
                      const res = await fetch(`/api/restaurant/${restaurantId}/logo`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` },
                        body: fd,
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || 'Upload failed');
                      await fetchRestaurant();
                    } catch (err: any) { alert(err.message || 'Failed'); }
                    e.target.value = '';  // reset so the same file can be reselected
                  }}
                />
                <button
                  type="button"
                  onClick={() => (document.getElementById('hotel-logo-input') as HTMLInputElement | null)?.click()}
                  className="px-5 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] flex items-center gap-2"
                >
                  <Upload size={14}/> {(restaurant as any)?.logo_url ? 'Replace Logo' : 'Upload Logo'}
                </button>
                {(restaurant as any)?.logo_url && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm('Remove logo?')) return;
                      try {
                        const res = await fetch(`/api/restaurant/${restaurantId}/logo`, {
                          method: 'DELETE',
                          headers: { Authorization: `Bearer ${token}` },
                        });
                        if (!res.ok) throw new Error('Failed');
                        await fetchRestaurant();
                      } catch (err: any) { alert(err.message); }
                    }}
                    className="ml-2 px-4 py-2 rounded-2xl border border-[#c13b3b]/30 text-[#c13b3b] text-xs font-bold hover:bg-[#fdf0f0]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Owner Profile & Contact ───────────────────────────────── */}
          <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
            <h3 className="text-2xl font-bold font-serif mb-1">My Profile</h3>
            <p className="text-xs text-[#6b5d52] mb-6">Update your contact information used for notifications and account recovery.</p>
            <form onSubmit={updateOwnerProfile} className="space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Full Name</label>
                <input
                  required
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                  placeholder="e.g. Ramesh Patel"
                  value={ownerProfile.name}
                  onChange={e => setOwnerProfile(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Email ID</label>
                <input
                  required
                  type="email"
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                  placeholder="e.g. owner@example.com"
                  value={ownerProfile.email}
                  onChange={e => setOwnerProfile(prev => ({ ...prev, email: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Mobile Number</label>
                <input
                  type="tel"
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                  placeholder="e.g. 9876543210"
                  value={ownerProfile.phone}
                  onChange={e => setOwnerProfile(prev => ({ ...prev, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
                />
              </div>
              <button
                type="submit"
                disabled={profileSaving}
                className={cn(
                  "w-full py-3 rounded-2xl font-bold text-sm transition-all",
                  profileSaved
                    ? "bg-green-500 text-white"
                    : "bg-[#cc5a16] text-white hover:bg-[#a84612]"
                )}
              >
                {profileSaving ? 'Saving…' : profileSaved ? '✓ Profile Saved' : 'Save Profile'}
              </button>
            </form>
          </div>

          {/* ── Brand & Restaurant Settings ───────────────────────────── */}
        <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
          <h3 className="text-2xl font-bold font-serif mb-6">Brand & Restaurant Settings</h3>
          <form onSubmit={updateRestaurant} className="space-y-6">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Brand Name</label>
              <input 
                required
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                value={restaurant?.name || ''}
                onChange={e => setRestaurant(prev => prev ? { ...prev, name: e.target.value } : null)}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">GST Number</label>
              <input 
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                placeholder="e.g. 22AAAAA0000A1Z5"
                value={restaurant?.gst_number || ''}
                onChange={e => setRestaurant(prev => prev ? { ...prev, gst_number: e.target.value } : null)}
              />
            </div>
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">GST Percentage (%)</label>
              <input 
                type="number"
                step="0.01"
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                placeholder="e.g. 5"
                value={restaurant?.gst_percentage || 0}
                onChange={e => setRestaurant(prev => prev ? { ...prev, gst_percentage: parseFloat(e.target.value) || 0 } : null)}
              />
            </div>
            <div className="flex items-center justify-between p-4 bg-[#faf7f2] rounded-2xl">
              <div>
                <p className="text-sm font-bold text-[#1a1a1a]">Charge GST</p>
                <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest">Enable or disable GST on invoices</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#6b5d52] w-7 text-right">
                  {restaurant?.is_gst_enabled ? 'ON' : 'OFF'}
                </span>
                <button
                  type="button"
                  onClick={() => setRestaurant(prev => prev ? { ...prev, is_gst_enabled: !prev.is_gst_enabled } : null)}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors relative",
                    restaurant?.is_gst_enabled ? "bg-[#cc5a16]" : "bg-gray-300"
                  )}
                >
                  <motion.div
                    animate={{ x: restaurant?.is_gst_enabled ? 24 : 4 }}
                    className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
                  />
                </button>
              </div>
            </div>

            {/* ── Checkout Mode Toggle ─────────────────────────────────── */}
            <div className="p-5 bg-[#faf7f2] rounded-2xl space-y-4">
              <div>
                <p className="text-sm font-bold text-[#1a1a1a]">Checkout Mode</p>
                <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest mt-0.5">
                  How customers pay for their orders
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setRestaurant(prev => prev ? { ...prev, checkout_mode: 'postpaid' } : null)}
                  className={cn(
                    "p-4 rounded-2xl border-2 text-left transition-all",
                    (restaurant?.checkout_mode || 'postpaid') === 'postpaid'
                      ? "border-[#cc5a16] bg-white shadow-sm"
                      : "border-transparent bg-white/50"
                  )}
                >
                  <Receipt size={18} className="mb-2 text-[#1a1208]" />
                  <p className="text-xs font-bold text-[#1a1a1a]">Postpaid</p>
                  <p className="text-[11px] text-[#6b5d52] mt-0.5 leading-tight">Customer orders, pays at end of visit. Supports multiple rounds.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setRestaurant(prev => prev ? { ...prev, checkout_mode: 'prepaid' } : null)}
                  className={cn(
                    "p-4 rounded-2xl border-2 text-left transition-all",
                    restaurant?.checkout_mode === 'prepaid'
                      ? "border-[#cc5a16] bg-white shadow-sm"
                      : "border-transparent bg-white/50"
                  )}
                >
                  <CreditCard size={18} className="mb-2 text-[#1a1208]" />
                  <p className="text-xs font-bold text-[#1a1a1a]">Prepaid</p>
                  <p className="text-[11px] text-[#6b5d52] mt-0.5 leading-tight">Payment required before order is sent to kitchen.</p>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Menu Template</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {['CLASSIC', 'MODERN', 'EDITORIAL'].map((t: any) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setRestaurant(prev => prev ? { ...prev, template_id: t } : null)}
                    className={cn(
                      "p-4 rounded-2xl border-2 transition-all text-center",
                      restaurant?.template_id === t ? "border-[#cc5a16] bg-[#cc5a16]/5" : "border-transparent bg-[#faf7f2]"
                    )}
                  >
                    <Layout className="mx-auto mb-2 opacity-50" size={20} />
                    <span className="text-[11px] font-bold uppercase tracking-widest">{t}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Menu Display Style — chooses how the customer sees the menu ── */}
            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] block">Menu Display Style</label>
                <p className="text-[11px] text-[#9c8e85] mt-1">
                  Pick how items appear when a customer scans the QR. Owners without photos should choose <strong>Magazine</strong> or <strong>Compact</strong> — the menu still looks rich and appetising with typography alone.
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {([
                  { id: 'PHOTO',    label: 'Photo',    tag: 'Default',             desc: 'Full image cards — best when every item has a photo.' },
                  { id: 'CARD',     label: 'Card',     tag: 'Mixed',               desc: 'Small thumbnail if available, text-first otherwise.' },
                  { id: 'COMPACT',  label: 'Compact',  tag: 'Short menu',          desc: 'Dense two-column list with price dots — fits many items.' },
                  { id: 'MAGAZINE', label: 'Magazine', tag: 'Elegant · no photos', desc: 'Serif headings, italic descriptions, brass dividers — fine-dining feel.' },
                ] as Array<{id: MenuDisplayMode; label: string; tag: string; desc: string}>).map(m => {
                  const current = (restaurant?.menu_display_mode as MenuDisplayMode | undefined) || 'PHOTO';
                  const active = current === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setRestaurant(prev => prev ? ({...prev, menu_display_mode: m.id} as any) : null)}
                      className={cn(
                        "relative p-4 rounded-2xl border-2 text-left transition-all",
                        active ? "border-[#cc5a16] bg-[#cc5a16]/5" : "border-transparent bg-[#faf7f2] hover:bg-[#cc5a16]/5"
                      )}
                    >
                      {active && <Check size={14} className="absolute top-3 right-3 text-[#cc5a16]" />}
                      {/* Mini preview illustration */}
                      <div className="h-14 mb-3 flex items-center justify-center bg-white rounded-xl border border-[#cc5a16]/10">
                        {m.id === 'PHOTO' && (
                          <div className="flex gap-1 px-2 w-full">
                            <div className="flex-1 h-10 bg-[#cc5a16]/20 rounded-md" />
                            <div className="flex-1 h-10 bg-[#cc5a16]/10 rounded-md" />
                          </div>
                        )}
                        {m.id === 'CARD' && (
                          <div className="flex items-center gap-2 w-full px-3">
                            <div className="w-8 h-8 bg-[#cc5a16]/30 rounded-md shrink-0" />
                            <div className="flex-1 space-y-1">
                              <div className="h-1.5 bg-[#1a1208]/60 rounded w-3/4" />
                              <div className="h-1 bg-[#1a1208]/30 rounded w-full" />
                            </div>
                          </div>
                        )}
                        {m.id === 'COMPACT' && (
                          <div className="w-full px-3 space-y-1.5">
                            {[0,1,2].map(i => (
                              <div key={i} className="flex items-center gap-2">
                                <div className="h-1 bg-[#1a1208]/70 rounded flex-1" />
                                <div className="w-0.5 h-0.5 bg-[#cc5a16]/40 rounded-full" />
                                <div className="w-0.5 h-0.5 bg-[#cc5a16]/40 rounded-full" />
                                <div className="w-0.5 h-0.5 bg-[#cc5a16]/40 rounded-full" />
                                <div className="h-1 bg-[#cc5a16] rounded w-5" />
                              </div>
                            ))}
                          </div>
                        )}
                        {m.id === 'MAGAZINE' && (
                          <div className="w-full px-3 space-y-1.5 text-center">
                            <div className="h-2 bg-[#1a1208]/80 rounded mx-auto w-2/3" style={{ fontStyle: 'italic' }} />
                            <div className="h-px bg-[#b8860b] mx-auto w-1/3" />
                            <div className="h-1 bg-[#1a1208]/50 rounded mx-auto w-4/5" />
                          </div>
                        )}
                      </div>
                      <div className="text-sm font-bold font-serif text-[#1a1208]">{m.label}</div>
                      <div className="text-[10px] uppercase tracking-wider text-[#b8860b] font-bold mt-0.5">{m.tag}</div>
                      <p className="text-[11px] text-[#6b5d52] mt-1.5 leading-snug">{m.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Audible + visual alerts toggle ───────────────────────────────── */}
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] block">Alerts for Urgent Requests</label>
                <p className="text-[11px] text-[#9c8e85] mt-1">
                  When a guest requests service (waiter call, bill request, or hotel service) the app plays a gentle chime every 4 seconds and pulses the card until staff acknowledges. Stops automatically when the request is handled.
                </p>
              </div>
              <label className="flex items-center justify-between gap-4 bg-[#faf7f2] rounded-2xl px-4 py-3 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className="text-lg">🔔</span>
                  <div>
                    <div className="text-sm font-bold text-[#1a1208]">Audible + visual alerts</div>
                    <div className="text-[11px] text-[#6b5d52]">Chime + pulsing card · auto-stops when acknowledged</div>
                  </div>
                </div>
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={(restaurant as any)?.alerts_enabled !== 0 && (restaurant as any)?.alerts_enabled !== false}
                    onChange={e => setRestaurant(prev => prev ? ({...prev, alerts_enabled: e.target.checked ? 1 : 0} as any) : null)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-[#9c8e85]/30 rounded-full peer-checked:bg-[#cc5a16] transition-colors"></div>
                  <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5"></div>
                </div>
              </label>
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Menu Watermark</label>
              <div className="flex items-center gap-4">
                {restaurant?.watermark_image && (
                  <img src={restaurant.watermark_image} alt="Watermark" className="w-12 h-12 object-contain border rounded-lg" referrerPolicy="no-referrer" />
                )}
                <input 
                  type="file"
                  accept="image/*"
                  className="w-full text-sm text-[#6b5d52] file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#cc5a16]/10 file:text-[#1a1208] hover:file:bg-[#cc5a16]/20"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const formData = new FormData();
                      formData.append('watermark', file);
                      const res = await fetch(`/api/restaurant/${restaurantId}/watermark`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                        body: formData
                      });
                      if (res.ok) {
                        const contentType = res.headers.get("content-type");
                        if (contentType && contentType.indexOf("application/json") !== -1) {
                          const data = await res.json();
                          if (data.watermark_image) {
                            setRestaurant(prev => prev ? { ...prev, watermark_image: data.watermark_image } : null);
                          }
                        }
                      }
                    }
                  }}
                />
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-[#cc5a16]/10">
              <h4 className="text-sm font-bold uppercase tracking-widest text-[#1a1208]">UPI Payment Settings</h4>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">UPI ID (VPA)</label>
                <input 
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                  placeholder="e.g. merchant@upi"
                  value={restaurant?.upi_id || ''}
                  onChange={e => setRestaurant(prev => prev ? { ...prev, upi_id: e.target.value } : null)}
                />
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Static UPI QR Code</label>
                <div className="flex items-center gap-4">
                  {restaurant?.upi_qr_image && (
                    <img src={restaurant.upi_qr_image} alt="UPI QR" className="w-12 h-12 object-contain border rounded-lg" referrerPolicy="no-referrer" />
                  )}
                  <input 
                    type="file"
                    accept="image/*"
                    className="w-full text-sm text-[#6b5d52] file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#cc5a16]/10 file:text-[#1a1208] hover:file:bg-[#cc5a16]/20"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const formData = new FormData();
                        formData.append('upi_qr', file);
                        const res = await fetch(`/api/restaurant/${restaurantId}/upi-qr`, {
                          method: 'POST',
                          headers: { 'Authorization': `Bearer ${token}` },
                          body: formData
                        });
                        if (res.ok) {
                          const contentType = res.headers.get("content-type");
                          if (contentType && contentType.indexOf("application/json") !== -1) {
                            const data = await res.json();
                            if (data.upi_qr_image) {
                              setRestaurant(prev => prev ? { ...prev, upi_qr_image: data.upi_qr_image } : null);
                            }
                          }
                        }
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all"
            >
              Save Settings
            </button>
          </form>
        </div>
        </div>
      ) : activeTab === 'SUBSCRIPTION' ? (
        <div className="bg-white p-10 rounded-[32px] border border-[#cc5a16]/10 shadow-sm max-w-2xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-16 h-16 rounded-3xl bg-[#cc5a16]/10 flex items-center justify-center text-[#1a1208]">
              <CreditCard size={32} />
            </div>
            <div>
              <h3 className="text-2xl font-bold font-serif">Subscription Plan</h3>
              <p className="text-sm text-[#6b5d52]">Manage your SaaS subscription and billing.</p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="p-6 rounded-3xl bg-[#faf7f2] flex justify-between items-center">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Current Plan</p>
                <p className="text-xl font-bold text-[#1a1208]">
                  {(restaurant as any)?.subscription_type === 'ANNUALLY' ? 'Annual Professional' : 'Monthly Professional'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Status</p>
                <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 text-[11px] font-bold uppercase tracking-widest">Active</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-6 rounded-3xl border border-[#cc5a16]/10">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Registered On</p>
                <p className="font-bold">
                  {(restaurant as any)?.registered_at ? new Date((restaurant as any).registered_at).toLocaleDateString() : 'N/A'}
                </p>
              </div>
              <div className="p-6 rounded-3xl border border-[#cc5a16]/10">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Renewal Due</p>
                <p className="font-bold text-orange-600">
                  {(restaurant as any)?.subscription_expires_at ? new Date((restaurant as any).subscription_expires_at).toLocaleDateString() : 'N/A'}
                </p>
              </div>
            </div>

            <div className="bg-blue-50 p-6 rounded-3xl border border-blue-100 flex gap-4">
              <Info className="text-blue-500 shrink-0" size={20} />
              <p className="text-xs text-blue-700 leading-relaxed">
                Your subscription is managed by your assigned Sales Representative. For renewals or plan changes, please contact support or your representative.
              </p>
            </div>
          </div>
        </div>
      ) : activeTab === 'MONITOR' ? (
        /* ── COMMAND CENTER — dark glassmorphism theme (per CLAUDE.md spec) ─────── */
        <div
          className="relative -mx-4 -my-4 sm:-mx-6 sm:-my-6 p-4 sm:p-6 space-y-5 rounded-3xl"
          style={{
            background: 'radial-gradient(1200px 600px at 20% 0%, #11213f 0%, transparent 55%), radial-gradient(1000px 500px at 100% 100%, #0f1f3d 0%, transparent 50%), linear-gradient(135deg, #0c1628 0%, #0a1020 100%)',
            minHeight: 'calc(100vh - 8rem)',
          }}
          onClick={() => setMonitorColOpen(false)}
        >

          {/* ── TOP BAR ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full backdrop-blur-md bg-rose-500/10 border border-rose-400/30" style={{ boxShadow: '0 0 20px rgba(244, 63, 94, 0.25)' }}>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-400" />
                </span>
                <span className="text-rose-200 text-[11px] font-bold uppercase tracking-widest">Live</span>
              </div>
              <div>
                <h2 className="text-2xl font-bold font-serif text-[#f0ede8]">Command &amp; Control</h2>
                <p className="text-xs text-[#f0ede8]/55 mt-0.5">
                  {liveLastRefresh ? `Updated · ${liveLastRefresh.toLocaleTimeString()}` : 'Fetching live data…'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-sm text-[#f0ede8] px-3 py-2 backdrop-blur-md bg-white/5 rounded-xl border border-white/10">
                {new Date(liveNow).toLocaleTimeString()}
              </span>
              <button
                onClick={fetchLiveTables}
                className="flex items-center gap-2 px-4 py-2 rounded-xl backdrop-blur-md bg-[#cc5a16]/15 border border-[#cc5a16]/40 text-[#f4b07a] text-xs font-bold uppercase tracking-widest hover:bg-[#cc5a16]/25 transition-all"
              >
                <RefreshCw size={13} className={cn(liveLoading && "animate-spin")} />
                Refresh
              </button>
            </div>
          </div>

          {/* ── STATS BAR ── glass cards with per-status colored glow */}
          {liveTables.length > 0 && (() => {
            const avail    = liveTables.filter(t => t.status === 'AVAILABLE').length;
            const occupied = liveTables.filter(t => t.status === 'OCCUPIED').length;
            const na       = liveTables.filter(t => t.status === 'NOT_AVAILABLE').length;
            const billReq  = liveTables.filter(t => t.session_status === 'bill_requested').length;
            const totalRev = liveTables.filter(t => t.status === 'OCCUPIED' || t.session_status === 'bill_requested').reduce((s, t) => s + (t.bill_amount ?? 0), 0);
            return (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {([
                  { label: 'Available', value: avail,                                                   accent: '#10b981', glow: '0 0 20px rgba(16,185,129,0.35)' },
                  { label: 'Occupied',  value: occupied,                                                accent: '#f59e0b', glow: '0 0 20px rgba(245,158,11,0.35)' },
                  { label: 'N / A',     value: na,                                                      accent: '#f43f5e', glow: '0 0 20px rgba(244, 63, 94,0.35)' },
                  { label: 'Bill Reqs', value: billReq,                                                 accent: '#f97316', glow: '0 0 20px rgba(249,115, 22,0.35)' },
                  { label: 'Live Rev.', value: `₹${Math.round(totalRev).toLocaleString()}`, isText: true, accent: '#a855f7', glow: '0 0 20px rgba(168, 85,247,0.30)' },
                ] as any[]).map((s: any) => (
                  <div
                    key={s.label}
                    className="rounded-2xl px-4 py-3 text-center backdrop-blur-md bg-white/7 border border-white/12 transition-all hover:bg-white/10"
                    style={{ boxShadow: s.glow }}
                  >
                    <p
                      className={cn("font-bold font-mono leading-none mb-1", s.isText ? 'text-lg' : 'text-3xl')}
                      style={{ color: s.accent }}
                    >
                      {s.value}
                    </p>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#f0ede8]/70">{s.label}</p>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* ── BILL REQUESTED BANNER ── orange glass with pulse */}
          {liveTables.some(t => t.session_status === 'bill_requested') && (
            <div
              className={cn(
                "px-4 py-3 rounded-2xl flex items-center gap-3 flex-wrap backdrop-blur-md bg-orange-500/15 border border-orange-400/40",
                alertsEnabled && "alert-pulse"
              )}
              style={{ boxShadow: '0 0 30px rgba(249, 115, 22, 0.35)' }}
            >
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-orange-400" />
              </span>
              <span className="text-orange-200 text-xs font-bold uppercase tracking-widest">⚑ Bill Requested:</span>
              <div className="flex flex-wrap gap-2">
                {liveTables.filter(t => t.session_status === 'bill_requested').map(t => (
                  <button
                    key={t.id}
                    onClick={() => setViewBillTable({ id: t.id, name: t.name })}
                    className="px-3 py-1 rounded-full text-[11px] font-bold backdrop-blur-md bg-orange-500/25 text-orange-100 border border-orange-400/50 hover:bg-orange-500/40 transition-all"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── MAIN TABLE CARD ── dark glass container */}
          <div className="backdrop-blur-md bg-white rounded-3xl border border-white/12 overflow-hidden shadow-2xl" style={{ boxShadow: '0 20px 60px rgba(0, 0, 0, 0.35)' }}>

            {/* Toolbar */}
            <div className="px-5 py-3.5 border-b border-[#cc5a16]/10 flex flex-col sm:flex-row items-start sm:items-center gap-3">
              {/* Search */}
              <div className="relative w-full sm:w-60">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
                <input
                  type="text" placeholder="Search table or customer…"
                  value={monitorSearch}
                  onChange={e => setMonitorSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-sm bg-[#faf7f2] rounded-xl border border-[#cc5a16]/10 focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20"
                />
              </div>

              {/* Status filter pills */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {([
                  ['ALL', 'All'],
                  ['AVAILABLE', 'Free'],
                  ['OCCUPIED', 'Busy'],
                  ['NOT_AVAILABLE', 'N/A'],
                  ['BILL_REQUESTED', 'Bill Req'],
                ] as const).map(([val, lbl]) => (
                  <button
                    key={val}
                    onClick={() => setMonitorStatusFilter(val)}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-all whitespace-nowrap",
                      monitorStatusFilter === val
                        ? val === 'AVAILABLE'     ? 'bg-emerald-500 text-white shadow-sm'
                          : val === 'OCCUPIED'    ? 'bg-amber-500 text-white shadow-sm'
                          : val === 'NOT_AVAILABLE'? 'bg-red-500 text-white shadow-sm'
                          : val === 'BILL_REQUESTED'? 'bg-orange-500 text-white shadow-sm'
                          : 'bg-[#cc5a16] text-white shadow-sm'
                        : 'bg-[#faf7f2] text-[#6b5d52] border border-[#cc5a16]/10 hover:bg-[#cc5a16]/5'
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* Column config button */}
              <div className="relative sm:ml-auto" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => setMonitorColOpen(v => !v)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold uppercase tracking-widest transition-all",
                    monitorColOpen
                      ? 'bg-[#cc5a16] text-white border-[#cc5a16]'
                      : 'border-[#cc5a16]/15 text-[#6b5d52] hover:bg-[#faf7f2]'
                  )}
                >
                  <Filter size={12} /> Columns
                </button>
                <ColumnConfigPanel
                  isOpen={monitorColOpen}
                  onClose={() => setMonitorColOpen(false)}
                  defaults={MONITOR_COL_DEFAULTS}
                  cfg={monitorCols.cfg}
                  ordered={monitorCols.ordered}
                  toggle={monitorCols.toggle}
                  move={monitorCols.move}
                  reset={monitorCols.reset}
                />
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-[#faf7f2]/80 border-b border-[#cc5a16]/10">
                    {monitorCols.visible.map(key => {
                      const def      = MONITOR_COL_DEFAULTS.find(c => c.key === key)!;
                      const isSorted = monitorSort.col === key;
                      const canSort  = def?.sortable ?? false;
                      return (
                        <th
                          key={key}
                          onClick={canSort ? () => setMonitorSort(s => ({ col: key, dir: s.col === key && s.dir === 'asc' ? 'desc' : 'asc' })) : undefined}
                          className={cn(
                            "px-4 py-3 text-left text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] select-none whitespace-nowrap",
                            canSort && "cursor-pointer hover:text-[#cc5a16] transition-colors"
                          )}
                        >
                          <span className="inline-flex items-center gap-1">
                            {def?.label}
                            {canSort && (
                              <span className={cn("transition-colors", isSorted ? "text-[#cc5a16]" : "text-[#c5b9b2]")}>
                                {isSorted ? (monitorSort.dir === 'asc' ? '↑' : '↓') : '↕'}
                              </span>
                            )}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // 1. Filter by status
                    let rows = [...liveTables];
                    if (monitorStatusFilter !== 'ALL') {
                      rows = rows.filter(t =>
                        monitorStatusFilter === 'BILL_REQUESTED'
                          ? t.session_status === 'bill_requested'
                          : t.status === monitorStatusFilter
                      );
                    }
                    // 2. Filter by search
                    if (monitorSearch.trim()) {
                      const q = monitorSearch.trim().toLowerCase();
                      rows = rows.filter(t =>
                        t.name?.toLowerCase().includes(q) ||
                        t.customer_name?.toLowerCase().includes(q) ||
                        (t as any).customer_phone?.toLowerCase().includes(q)
                      );
                    }
                    // 3. Sort
                    rows.sort((a, b) => {
                      const d = monitorSort.dir === 'asc' ? 1 : -1;
                      switch (monitorSort.col) {
                        case 'name':     return d * (a.name || '').localeCompare(b.name || '');
                        case 'status': {
                          const rank = (t: typeof a) =>
                            t.session_status === 'bill_requested' ? 0
                              : t.status === 'OCCUPIED'      ? 1
                              : t.status === 'NOT_AVAILABLE' ? 2 : 3;
                          return d * (rank(a) - rank(b));
                        }
                        case 'customer': return d * (a.customer_name || '').localeCompare(b.customer_name || '');
                        case 'duration': {
                          const ms = (t: typeof a) => t.session_opened_at ? liveNow - new Date(t.session_opened_at).getTime() : 0;
                          return d * (ms(a) - ms(b));
                        }
                        case 'bill':     return d * ((a.bill_amount ?? 0) - (b.bill_amount ?? 0));
                        case 'rounds':   return d * ((a.order_count   ?? 0) - (b.order_count   ?? 0));
                        case 'capacity': return d * ((a.capacity       ?? 0) - (b.capacity       ?? 0));
                        case 'waiter':   return d * (a.assigned_waiter_name || '').localeCompare(b.assigned_waiter_name || '');
                        default:         return 0;
                      }
                    });

                    if (rows.length === 0) {
                      return (
                        <tr>
                          <td colSpan={monitorCols.visible.length}
                            className="py-16 text-center text-[#9c8e85] text-sm italic">
                            {liveTables.length === 0
                              ? 'No tables found · Add tables in QR Management first'
                              : 'No tables match your search / filter'}
                          </td>
                        </tr>
                      );
                    }

                    return rows.map((t, rowIdx) => {
                      const isOccupied      = t.status === 'OCCUPIED';
                      const isUnavail       = t.status === 'NOT_AVAILABLE';
                      const isBillRequested = t.session_status === 'bill_requested';
                      const elapsedMs       = t.session_opened_at ? liveNow - new Date(t.session_opened_at).getTime() : 0;
                      const timerStr        = isOccupied && t.session_opened_at
                        ? `${String(Math.floor(elapsedMs / 60000)).padStart(2, '0')}:${String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0')}`
                        : null;

                      const cellFor = (key: string): React.ReactNode => {
                        switch (key) {
                          case 'name':
                            return <span className="font-semibold text-[#1a1208]">{t.name}</span>;

                          case 'status':
                            return (
                              <span className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest whitespace-nowrap",
                                isBillRequested ? 'bg-orange-100 text-orange-700'
                                  : isOccupied  ? 'bg-amber-100  text-amber-700'
                                  : isUnavail   ? 'bg-red-100    text-red-700'
                                  :               'bg-emerald-100 text-emerald-700'
                              )}>
                                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0",
                                  isBillRequested ? 'bg-orange-500 animate-pulse'
                                    : isOccupied  ? 'bg-amber-500 animate-pulse'
                                    : isUnavail   ? 'bg-red-500'
                                    :               'bg-emerald-500'
                                )} />
                                {isBillRequested ? '⏳ Bill Req' : isOccupied ? 'Occupied' : isUnavail ? 'N/A' : 'Free'}
                              </span>
                            );

                          case 'customer':
                            return (isOccupied || isBillRequested) && t.customer_name
                              ? <span className="text-[#0d0a07]/80 font-medium">{t.customer_name}</span>
                              : <span className="text-[#c5b9b2] italic text-xs">—</span>;

                          case 'phone':
                            return (isOccupied || isBillRequested) && (t as any).customer_phone
                              ? <span className="font-mono text-xs text-[#6b5d52]">{(t as any).customer_phone}</span>
                              : <span className="text-[#c5b9b2] text-xs">—</span>;

                          case 'duration':
                            return timerStr
                              ? <span className="font-mono font-bold text-amber-600 tabular-nums">{timerStr}</span>
                              : <span className="text-[#c5b9b2] text-xs">—</span>;

                          case 'bill':
                            return (isOccupied || isBillRequested) && (t.bill_amount ?? 0) > 0
                              ? <span className="font-mono font-bold text-[#cc5a16]">₹{Math.round(t.bill_amount!).toLocaleString()}</span>
                              : <span className="text-[#c5b9b2] text-xs">—</span>;

                          case 'rounds':
                            return (isOccupied || isBillRequested) && (t.order_count ?? 0) > 0
                              ? <span className="font-mono text-[#3d3128]">{t.order_count}</span>
                              : <span className="text-[#c5b9b2] text-xs">—</span>;

                          case 'capacity':
                            return <span className="text-[#6b5d52] text-xs">{t.capacity ?? '—'}</span>;

                          case 'waiter':
                            return (
                              <select
                                value={t.assigned_waiter_id ?? ''}
                                onChange={e => assignWaiter(t.id, e.target.value || null)}
                                onClick={e => e.stopPropagation()}
                                className="w-full min-w-[120px] rounded-lg px-2 py-1.5 text-xs bg-[#faf7f2] border border-[#cc5a16]/10 text-[#3d3128] outline-none hover:border-[#cc5a16]/30 transition-colors cursor-pointer"
                              >
                                <option value="">— Assign —</option>
                                {staff.filter((s: any) => s.role === 'WAITER' || s.role === 'MANAGER').map((s: any) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            );

                          case 'actions':
                            return (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {(['AVAILABLE', 'OCCUPIED', 'NOT_AVAILABLE'] as TableStatus[]).map(st => {
                                  const isActive = t.status === st;
                                  return (
                                    <button
                                      key={st}
                                      onClick={() => updateTableStatus(t.id, st)}
                                      disabled={isActive}
                                      className={cn(
                                        "px-2 py-1 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all whitespace-nowrap",
                                        isActive
                                          ? st === 'AVAILABLE'    ? 'bg-emerald-500 text-white shadow-sm'
                                            : st === 'OCCUPIED'   ? 'bg-amber-500 text-white shadow-sm'
                                            :                        'bg-red-500 text-white shadow-sm'
                                          : 'bg-[#faf7f2] border border-[#cc5a16]/10 text-[#6b5d52] hover:bg-[#cc5a16]/5 hover:border-[#cc5a16]/20'
                                      )}
                                    >
                                      {st === 'AVAILABLE' ? 'Free' : st === 'OCCUPIED' ? 'Busy' : 'N/A'}
                                    </button>
                                  );
                                })}
                                {(isOccupied || isBillRequested) && (
                                  <button
                                    onClick={() => setViewBillTable({ id: t.id, name: t.name })}
                                    className="px-2 py-1 rounded-lg bg-violet-50 border border-violet-200 text-violet-700 text-[11px] font-bold uppercase tracking-widest hover:bg-violet-100 transition-all whitespace-nowrap"
                                  >
                                    📋 Bill
                                  </button>
                                )}
                              </div>
                            );

                          default: return null;
                        }
                      };

                      return (
                        <tr
                          key={t.id}
                          className={cn(
                            "border-b border-[#cc5a16]/10 transition-colors",
                            isBillRequested ? 'bg-orange-50/70 hover:bg-orange-50'
                              : rowIdx % 2 === 0 ? 'bg-white hover:bg-[#faf7f2]/40'
                              : 'bg-[#faf7f2]/30 hover:bg-[#faf7f2]/60'
                          )}
                        >
                          {monitorCols.visible.map(key => (
                            <td key={key} className="px-4 py-3 align-middle whitespace-nowrap">
                              {cellFor(key)}
                            </td>
                          ))}
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>

            {/* Table footer */}
            <div className="px-5 py-2.5 border-t border-[#cc5a16]/10 bg-[#faf7f2]/50 flex items-center justify-between">
              <p className="text-[11px] text-[#9c8e85]">
                {liveTables.length} table{liveTables.length !== 1 ? 's' : ''} total
              </p>
              <p className="text-[11px] text-[#9c8e85]">
                Auto-refreshes every 30s · <button onClick={fetchLiveTables} className="text-[#cc5a16] hover:underline">Refresh now</button>
              </p>
            </div>
          </div>

          {/* ── LIVE KITCHEN ORDERS ── */}
          <div className="bg-white rounded-3xl border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            <button
              onClick={() => setLiveOrdersExpanded(v => !v)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#faf7f2]/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">🍳</span>
                <span className="font-bold text-[#1a1208] text-sm tracking-wide">Live Kitchen Orders</span>
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#cc5a16]/10 text-[#cc5a16]">
                  {liveOrders.length} active
                </span>
              </div>
              <ChevronDown size={16} className={cn("text-[#9c8e85] transition-transform", !liveOrdersExpanded && "-rotate-90")} />
            </button>

            {liveOrdersExpanded && (
              <div className="border-t border-[#cc5a16]/10">
                {liveOrders.length === 0 ? (
                  <div className="py-10 text-center text-[#c5b9b2] text-sm italic">No active kitchen orders</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="bg-[#faf7f2]/80 border-b border-[#cc5a16]/10">
                          {['Table', 'Items', 'Status', 'Assign Chef', 'ETA', 'Elapsed', 'Actions'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {liveOrders.map((o, idx) => {
                          const chefId     = (o as any).chef_id   || '';
                          const chefName   = (o as any).chef_name || '';
                          const etaSaved   = (o as any).eta        || '';
                          const etaLocal   = orderEtaEdits[o.id] ?? etaSaved;
                          const elapsed    = Math.floor((liveNow - new Date(o.createdAt).getTime()) / 1000);
                          const elapsedStr = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
                          const items      = Array.isArray(o.items) ? o.items : [];
                          const itemSummary = items.slice(0, 2).map((i: any) => `${i.quantity}× ${i.name}`).join(', ')
                            + (items.length > 2 ? ` +${items.length - 2}` : '');

                          const statusCfg: Record<string, { bg: string; text: string; label: string }> = {
                            CONFIRMED: { bg: 'bg-amber-100',   text: 'text-amber-700',   label: 'Queued'    },
                            PREPARING: { bg: 'bg-orange-100',  text: 'text-orange-700',  label: 'Preparing' },
                            READY:     { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Ready ✓'   },
                            PENDING:   { bg: 'bg-amber-100',   text: 'text-amber-700',   label: 'Pending'   },
                          };
                          const sc = statusCfg[o.status] || statusCfg.CONFIRMED;

                          const isQueued    = ['CONFIRMED', 'PENDING'].includes(o.status);
                          const isPreparing = o.status === 'PREPARING';
                          const isReady     = o.status === 'READY';

                          return (
                            <tr key={o.id}
                              className={cn("border-b border-[#cc5a16]/10 transition-colors",
                                idx % 2 === 0 ? 'bg-white hover:bg-[#faf7f2]/40' : 'bg-[#faf7f2]/30 hover:bg-[#faf7f2]/60'
                              )}
                            >
                              {/* Table # */}
                              <td className="px-4 py-3 font-bold text-[#1a1208] whitespace-nowrap">
                                {String(o.id || '').startsWith('MAN-') ? (
                                  <span className="text-purple-700">Manual</span>
                                ) : (
                                  <>Table {o.tableNumber}</>
                                )}
                                {(o as any).round_number > 1 && (
                                  <span className="ml-1 text-[11px] text-[#9c8e85]">R{(o as any).round_number}</span>
                                )}
                              </td>

                              {/* Items summary */}
                              <td className="px-4 py-3 max-w-[200px] truncate text-[#6b5d52] text-xs" title={items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')}>
                                {itemSummary || '—'}
                              </td>

                              {/* Status badge */}
                              <td className="px-4 py-3">
                                <span className={cn("px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest", sc.bg, sc.text)}>
                                  {sc.label}
                                </span>
                              </td>

                              {/* Chef assignment dropdown */}
                              <td className="px-4 py-3 whitespace-nowrap">
                                <select
                                  value={chefId}
                                  onChange={e => {
                                    const cId   = e.target.value;
                                    const cName = allChefs.find(c => c.id === cId)?.name || '';
                                    patchLiveOrder(o.id, { chef_id: cId || null, chef_name: cName || null });
                                  }}
                                  className="text-xs border border-[#cc5a16]/20 rounded-lg px-2 py-1 bg-white text-[#1a1208] focus:outline-none focus:ring-1 focus:ring-[#cc5a16]/40 min-w-[110px]"
                                >
                                  <option value="">— Assign chef</option>
                                  {allChefs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                              </td>

                              {/* ETA inline input */}
                              <td className="px-4 py-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  placeholder="e.g. 15m"
                                  value={etaLocal}
                                  onChange={e => setOrderEtaEdits(prev => ({ ...prev, [o.id]: e.target.value }))}
                                  onBlur={e => {
                                    const val = e.target.value.trim();
                                    if (val !== etaSaved) patchLiveOrder(o.id, { eta: val });
                                  }}
                                  className="text-xs border border-[#cc5a16]/20 rounded-lg px-2 py-1 bg-white text-[#1a1208] font-mono focus:outline-none focus:ring-1 focus:ring-[#cc5a16]/40 w-20"
                                />
                              </td>

                              {/* Elapsed */}
                              <td className={cn("px-4 py-3 font-mono text-xs whitespace-nowrap", elapsed > 1800 ? 'text-red-500 font-bold' : 'text-[#9c8e85]')}>
                                {elapsedStr}
                              </td>

                              {/* Actions */}
                              <td className="px-4 py-3 whitespace-nowrap">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {/* Status progression */}
                                  {isQueued && (
                                    <button
                                      onClick={() => patchLiveOrder(o.id, { status: 'PREPARING', kitchen_status: 'preparing' })}
                                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-orange-100 text-orange-700 hover:bg-orange-200 transition-colors whitespace-nowrap"
                                    >
                                      ▶ Start
                                    </button>
                                  )}
                                  {isPreparing && (
                                    <button
                                      onClick={() => patchLiveOrder(o.id, { status: 'READY', kitchen_status: 'ready' })}
                                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors whitespace-nowrap"
                                    >
                                      ✓ Ready
                                    </button>
                                  )}
                                  {isReady && (
                                    <button
                                      onClick={() => patchLiveOrder(o.id, { status: 'DELIVERED', kitchen_status: 'delivered', payment_status: 'PAID' })}
                                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors whitespace-nowrap"
                                    >
                                      🍽 Served
                                    </button>
                                  )}
                                  {!isReady && (
                                    <button
                                      onClick={() => patchLiveOrder(o.id, { status: 'DELIVERED', kitchen_status: 'delivered' })}
                                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#0d0a07]/5 text-[#6b5d52] hover:bg-emerald-50 hover:text-emerald-700 transition-colors whitespace-nowrap"
                                      title="Mark as complete and remove from live view"
                                    >
                                      ✓ Complete
                                    </button>
                                  )}

                                  {/* Divider */}
                                  <span className="w-px h-5 bg-[#0d0a07]/10 mx-0.5" />

                                  {/* Print KOT */}
                                  <button
                                    onClick={() => printKitchenOrder(o)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#cc5a16]/10 text-[#cc5a16] hover:bg-[#cc5a16]/20 transition-colors whitespace-nowrap"
                                    title="Print Kitchen Order Ticket"
                                  >
                                    🖨 Print
                                  </button>

                                  {/* Cancel order */}
                                  <button
                                    onClick={() => {
                                      if (window.confirm(`Cancel order #${String(o.id).slice(-6).toUpperCase()} for Table ${o.tableNumber}?`)) {
                                        patchLiveOrder(o.id, { status: 'CANCELLED' });
                                      }
                                    }}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-50 text-red-600 hover:bg-red-100 transition-colors whitespace-nowrap"
                                    title="Cancel this order"
                                  >
                                    ✕ Cancel
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── WAITER CALLS ── */}
          <div className="bg-white rounded-3xl border border-[#cc5a16]/10 overflow-hidden shadow-sm">
            <button
              onClick={() => setWaiterCallsExpanded(v => !v)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#faf7f2]/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Bell size={16} className={cn("text-[#cc5a16]", waiterCalls.length > 0 && "animate-pulse")} />
                <span className="font-bold text-[#1a1208] text-sm tracking-wide uppercase">Waiter Calls</span>
                {waiterCalls.length > 0 && (
                  <span className="text-[11px] font-black px-2.5 py-0.5 rounded-full bg-[#cc5a16] text-white animate-pulse">
                    {waiterCalls.length}
                  </span>
                )}
              </div>
              <ChevronDown size={16} className={cn("text-[#9c8e85] transition-transform", !waiterCallsExpanded && "-rotate-90")} />
            </button>

            {waiterCallsExpanded && (
              <div className="border-t border-[#cc5a16]/10">
                {waiterCalls.length === 0 ? (
                  <div className="py-10 text-center text-[#c5b9b2] text-sm italic">No active waiter calls</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="bg-[#faf7f2]/80 border-b border-[#cc5a16]/10">
                          {['Table', 'Customer', 'Called', 'Assigned To', 'Actions'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {waiterCalls.map((call, idx) => {
                          const elapsed    = Math.floor((Date.now() - new Date(call.created_at).getTime()) / 1000);
                          const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
                          const isUrgent   = elapsed > 120 && call.status === 'pending';
                          const isAck      = call.status === 'acknowledged';
                          const isPending  = call.status === 'pending';
                          return (
                            <tr key={call.id}
                              className={cn(
                                "border-b border-[#cc5a16]/10 transition-colors",
                                alertsEnabled && isPending && "alert-pulse",
                                isAck    ? 'bg-emerald-50/60'
                                : isUrgent ? 'bg-red-50 hover:bg-red-100/50'
                                : idx % 2 === 0 ? 'bg-white hover:bg-[#faf7f2]/40'
                                : 'bg-[#faf7f2]/30 hover:bg-[#faf7f2]/60'
                              )}
                            >
                              <td className="px-4 py-3 font-bold text-[#1a1208] whitespace-nowrap">{call.table_number}</td>
                              <td className="px-4 py-3 text-xs text-[#6b5d52] max-w-[120px] truncate">{call.customer_name || '—'}</td>
                              <td className={cn("px-4 py-3 font-mono text-xs whitespace-nowrap", isUrgent ? 'text-red-600 font-bold' : 'text-[#9c8e85]')}>
                                {elapsedStr}
                              </td>
                              <td className="px-4 py-3">
                                {isAck ? (
                                  <span className="text-emerald-600 text-xs font-semibold">👋 {call.assigned_waiter_name || 'Waiter'}</span>
                                ) : (
                                  <select
                                    value={call.assigned_waiter_id || ''}
                                    onChange={e => {
                                      const wId   = e.target.value;
                                      const wName = allWaiters.find(w => w.id === wId)?.name || '';
                                      patchWaiterCall(call.id, {
                                        assigned_waiter_id: wId || null,
                                        assigned_waiter_name: wName || null,
                                        status: wId ? 'acknowledged' : 'pending',
                                      });
                                    }}
                                    className="rounded-lg px-2 py-1.5 text-xs bg-[#faf7f2] border border-[#cc5a16]/15 text-[#3d3128] outline-none w-full min-w-[130px]"
                                  >
                                    <option value="">— Assign waiter</option>
                                    {allWaiters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                  </select>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
                                  {call.status === 'pending' && (
                                    <button
                                      onClick={() => patchWaiterCall(call.id, { status: 'acknowledged' })}
                                      className="px-2 py-1 rounded-lg text-[11px] font-bold bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-all whitespace-nowrap"
                                    >
                                      👋 Ack
                                    </button>
                                  )}
                                  <button
                                    onClick={() => patchWaiterCall(call.id, { status: 'resolved' })}
                                    className="px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all whitespace-nowrap"
                                  >
                                    ✓ Done
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      ) : (
        <AttendanceManagement role="OWNER" token={token} restaurantId={restaurantId} />
      )}

      {/* Table Bill Modal — Owner view of current active bill */}
      <AnimatePresence>
        {viewBillTable && (
          <TableBillModal
            restaurantId={restaurantId}
            token={token}
            table={viewBillTable}
            onClose={() => { setViewBillTable(null); fetchLiveTables(); }}
          />
        )}
      </AnimatePresence>

      {/* ═══════════ HOSPITALITY MODALS ═══════════ */}
      {/* Room add/edit modal */}
      {showRoomModal && editingRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-7">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-serif text-[#1a1208]">{editingRoom.id ? 'Edit Room' : 'Add Room'}</h3>
              <button onClick={() => { setShowRoomModal(false); setEditingRoom(null); }} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18} /></button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await saveRoom(editingRoom);
                  setShowRoomModal(false); setEditingRoom(null);
                } catch (err: any) { setHotelError(err.message); }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Room Name *</label>
                <input required value={editingRoom.name || ''} onChange={e => setEditingRoom({...editingRoom, name: e.target.value})} placeholder="e.g. Deluxe Suite 302" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Room Number</label>
                  <input value={editingRoom.room_number || ''} onChange={e => setEditingRoom({...editingRoom, room_number: e.target.value})} placeholder="302" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Floor</label>
                  <input type="number" value={editingRoom.floor || ''} onChange={e => setEditingRoom({...editingRoom, floor: Number(e.target.value) || null})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Type</label>
                  <select value={editingRoom.type || 'STANDARD'} onChange={e => setEditingRoom({...editingRoom, type: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none">
                    <option>STANDARD</option><option>DELUXE</option><option>SUITE</option><option>VILLA</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Capacity</label>
                  <input type="number" min={1} value={editingRoom.capacity || 2} onChange={e => setEditingRoom({...editingRoom, capacity: Number(e.target.value) || 2})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Base Rate (₹/night)</label>
                <input type="number" min={0} value={editingRoom.base_rate || 0} onChange={e => setEditingRoom({...editingRoom, base_rate: Number(e.target.value) || 0})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Smoking Preference</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    ['NON_SMOKING', '🚭 Non-Smoking'],
                    ['SMOKING',     '🚬 Smoking'],
                    ['ANY',         'Any'],
                  ] as const).map(([val, label]) => {
                    const cur = editingRoom.smoking_preference || 'NON_SMOKING';
                    return (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setEditingRoom({...editingRoom, smoking_preference: val})}
                        className={cn(
                          "px-3 py-2.5 rounded-2xl text-xs font-bold transition-all border-2",
                          cur === val
                            ? "bg-[#cc5a16]/10 border-[#cc5a16] text-[#cc5a16]"
                            : "bg-[#faf7f2] border-transparent text-[#6b5d52] hover:bg-[#cc5a16]/5"
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="flex gap-2 pt-3">
                <button type="button" onClick={() => { setShowRoomModal(false); setEditingRoom(null); }} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612]">{editingRoom.id ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Service add/edit modal */}
      {showServiceModal && editingService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-7">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-serif text-[#1a1208]">{editingService.id ? 'Edit Service' : 'Add Service'}</h3>
              <button onClick={() => { setShowServiceModal(false); setEditingService(null); }} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18} /></button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try { await saveService(editingService); setShowServiceModal(false); setEditingService(null); }
                catch (err: any) { setHotelError(err.message); }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Name *</label>
                <input required value={editingService.name || ''} onChange={e => setEditingService({...editingService, name: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Description</label>
                <textarea value={editingService.description || ''} onChange={e => setEditingService({...editingService, description: e.target.value})} rows={2} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Category *</label>
                  <select required value={editingService.category || 'HOUSEKEEPING'} onChange={e => setEditingService({...editingService, category: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none">
                    <option>HOUSEKEEPING</option><option>MAINTENANCE</option><option>ROOM_SERVICE</option>
                    <option>CONCIERGE</option><option>LAUNDRY</option><option>SPA</option><option>UPGRADE</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Assigned Role</label>
                  <select value={editingService.assigned_role || 'HOUSEKEEPING'} onChange={e => setEditingService({...editingService, assigned_role: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none">
                    <option>HOUSEKEEPING</option><option>MAINTENANCE</option><option>CONCIERGE</option><option>FRONT_DESK</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">SLA (minutes)</label>
                  <input type="number" min={1} value={editingService.sla_minutes || 15} onChange={e => setEditingService({...editingService, sla_minutes: Number(e.target.value) || 15})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Price (₹)</label>
                  <input type="number" min={0} disabled={!!editingService.is_complimentary} value={editingService.price || 0} onChange={e => setEditingService({...editingService, price: Number(e.target.value) || 0})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none disabled:opacity-40"/>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-[#3d3128]">
                <input type="checkbox" checked={!!editingService.is_complimentary} onChange={e => setEditingService({...editingService, is_complimentary: e.target.checked, price: e.target.checked ? 0 : editingService.price})} className="w-4 h-4"/>
                Complimentary (free for guest)
              </label>
              <div className="flex gap-2 pt-3">
                <button type="button" onClick={() => { setShowServiceModal(false); setEditingService(null); }} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612]">{editingService.id ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Room QR code preview modal */}
      {roomQrPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setRoomQrPreview(null)}>
          <div className="bg-white rounded-3xl shadow-2xl p-8 text-center max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold font-serif text-[#1a1208] mb-1">{roomQrPreview.name}</h3>
            <p className="text-xs text-[#6b5d52] mb-5">Print and place in the room for guests to scan.</p>
            <div className="bg-[#faf7f2] p-6 rounded-2xl inline-block">
              <QRCodeCanvas
                id={`qr-room-${roomQrPreview.id}`}
                value={roomQrPreview.qrUrl}
                size={220}
                fgColor="#1a1208"
                bgColor="#faf7f2"
                level="M"
              />
            </div>
            <p className="text-[11px] text-[#9c8e85] mt-3 font-mono break-all">{roomQrPreview.qrUrl}</p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setRoomQrPreview(null)} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Close</button>
              <button
                onClick={() => {
                  const canvas = document.getElementById(`qr-room-${roomQrPreview.id}`) as HTMLCanvasElement;
                  if (canvas) {
                    const url = canvas.toDataURL('image/png');
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `qr-${roomQrPreview.name.replace(/\s+/g, '-')}.png`;
                    a.click();
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] flex items-center justify-center gap-2"
              >
                <Download size={14} /> Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═════════ Booking create/edit modal ═════════ */}
      {showBookingModal && editingBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-7 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-serif text-[#1a1208]">{editingBooking.id ? 'Edit Booking' : 'New Booking'}</h3>
              <button onClick={() => { setShowBookingModal(false); setEditingBooking(null); }} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18} /></button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  // Fill rate from selected room if blank
                  const patched = {...editingBooking};
                  if (!patched.room_rate && patched.room_id) {
                    const r = hotelRooms.find(x => x.id === patched.room_id);
                    if (r) patched.room_rate = r.base_rate;
                  }
                  await saveBooking(patched);
                  setShowBookingModal(false); setEditingBooking(null);
                } catch (err: any) { setHotelError(err.message); }
              }}
              className="space-y-4"
            >
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Guest Name *</label>
                <input required value={editingBooking.guest_name || ''} onChange={e => setEditingBooking({...editingBooking, guest_name: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Phone</label>
                  <input value={editingBooking.guest_phone || ''} onChange={e => setEditingBooking({...editingBooking, guest_phone: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Email</label>
                  <input type="email" value={editingBooking.guest_email || ''} onChange={e => setEditingBooking({...editingBooking, guest_email: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Nationality</label>
                  <input value={editingBooking.guest_nationality || ''} onChange={e => setEditingBooking({...editingBooking, guest_nationality: e.target.value})} placeholder="e.g. India, UK" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                  <p className="text-[10px] text-[#9c8e85] mt-1">Non-Indian guests trigger Form-C tracking</p>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">ID Proof</label>
                  <input value={editingBooking.guest_id_proof || ''} onChange={e => setEditingBooking({...editingBooking, guest_id_proof: e.target.value})} placeholder="Passport / Aadhaar #" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Guest State (for GST)</label>
                <select
                  value={editingBooking.guest_state || ''}
                  onChange={e => setEditingBooking({...editingBooking, guest_state: e.target.value})}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                >
                  <option value="">Select state (optional)…</option>
                  {Object.keys(INDIAN_STATES).sort().map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                  <option value="OUTSIDE_INDIA">Outside India</option>
                </select>
                <p className="text-[10px] text-[#9c8e85] mt-1">
                  Determines GST split on invoice: same state as hotel → CGST+SGST, different state → IGST
                </p>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Room *</label>
                <select required value={editingBooking.room_id || ''} onChange={e => {
                  const room = hotelRooms.find(r => r.id === e.target.value);
                  setEditingBooking({...editingBooking, room_id: e.target.value, room_rate: room?.base_rate || editingBooking.room_rate });
                }} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none">
                  <option value="">Select a room…</option>
                  {hotelRooms.map(r => (
                    <option key={r.id} value={r.id}>{r.name} · ₹{r.base_rate}/night{r.status !== 'VACANT' ? ` · ${r.status}` : ''}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Check-in *</label>
                  <input required type="date" value={(editingBooking.check_in_date || '').slice(0,10)} onChange={e => setEditingBooking({...editingBooking, check_in_date: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Check-out *</label>
                  <input required type="date" value={(editingBooking.check_out_date || '').slice(0,10)} onChange={e => setEditingBooking({...editingBooking, check_out_date: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Room Rate (₹/night)</label>
                  <input type="number" min={0} value={editingBooking.room_rate || 0} onChange={e => setEditingBooking({...editingBooking, room_rate: Number(e.target.value)||0})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Guests</label>
                  <input type="number" min={1} value={editingBooking.num_guests || 1} onChange={e => setEditingBooking({...editingBooking, num_guests: Number(e.target.value)||1})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Special Requests</label>
                <textarea value={editingBooking.special_requests || ''} onChange={e => setEditingBooking({...editingBooking, special_requests: e.target.value})} rows={2} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => { setShowBookingModal(false); setEditingBooking(null); }} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612]">{editingBooking.id ? 'Save' : 'Create Booking'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ═════════ Check-out modal (with folio preview) ═════════ */}
      {showCheckoutModal && checkoutBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-7">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-serif text-[#1a1208]">Check Out — {checkoutBooking.guest_name}</h3>
              <button onClick={() => { setShowCheckoutModal(false); setCheckoutBooking(null); }} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18} /></button>
            </div>
            <div className="bg-[#faf7f2] rounded-2xl p-4 mb-4 text-sm">
              <div className="flex justify-between mb-1"><span className="text-[#6b5d52]">Room</span><span className="font-semibold">{checkoutBooking.room_name || checkoutBooking.room_id}</span></div>
              <div className="flex justify-between mb-1"><span className="text-[#6b5d52]">Dates</span><span>{new Date(checkoutBooking.check_in_date).toLocaleDateString('en-IN')} → {new Date(checkoutBooking.check_out_date).toLocaleDateString('en-IN')}</span></div>
              <p className="text-[10px] text-[#9c8e85] mt-2">Folio totals will include room nights + completed service charges.</p>
            </div>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Payment Method</label>
                <select value={checkoutPayment} onChange={e => setCheckoutPayment(e.target.value as any)} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3">
                  <option value="CASH">Cash</option><option value="CARD">Card</option><option value="UPI">UPI</option><option value="BANK">Bank Transfer</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Discount (₹)</label>
                <input type="number" min={0} value={checkoutDiscount} onChange={e => setCheckoutDiscount(Number(e.target.value)||0)} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3"/>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setShowCheckoutModal(false); setCheckoutBooking(null); }} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Cancel</button>
              <button onClick={async () => {
                try {
                  const result = await checkOutBooking(checkoutBooking.id, checkoutPayment, checkoutDiscount);
                  setShowCheckoutModal(false); setCheckoutBooking(null); setCheckoutDiscount(0);
                  if (result?.folio?.id) await loadFolio(result.folio.id);
                } catch (err: any) { alert(err.message); }
              }} className="flex-1 px-4 py-2.5 rounded-2xl bg-[#b8860b] text-white text-sm font-bold hover:bg-[#8f6608]">Settle &amp; Check Out</button>
            </div>
          </div>
        </div>
      )}

      {/* ═════════ FAQ add/edit modal (Phase 4) ═════════ */}
      {showFaqModal && editingFaq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-7">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold font-serif text-[#1a1208]">{editingFaq.id ? 'Edit FAQ' : 'Add FAQ'}</h3>
              <button onClick={() => { setShowFaqModal(false); setEditingFaq(null); }} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18}/></button>
            </div>
            <form onSubmit={async e => { e.preventDefault(); try { await saveFaq(editingFaq); setShowFaqModal(false); setEditingFaq(null); } catch(err: any){ alert(err.message);} }} className="space-y-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Question *</label>
                <input required value={editingFaq.question || ''} onChange={e => setEditingFaq({...editingFaq, question: e.target.value})} placeholder="e.g. What's the WiFi password?" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3"/>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Answer *</label>
                <textarea required rows={4} value={editingFaq.answer || ''} onChange={e => setEditingFaq({...editingFaq, answer: e.target.value})} placeholder="e.g. Network: Sunset-Guest · Password: welcome123" className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3"/>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1">Category</label>
                <select value={editingFaq.category || 'General'} onChange={e => setEditingFaq({...editingFaq, category: e.target.value})} className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3">
                  <option>General</option><option>Rooms</option><option>Dining</option><option>Amenities</option><option>Local Area</option><option>Policies</option>
                </select>
              </div>
              {editingFaq.id && (
                <label className="flex items-center gap-2 text-sm text-[#3d3128]">
                  <input type="checkbox" checked={editingFaq.is_active !== 0} onChange={e => setEditingFaq({...editingFaq, is_active: e.target.checked ? 1 : 0})} className="w-4 h-4"/>
                  Active (visible to chatbot)
                </label>
              )}
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => { setShowFaqModal(false); setEditingFaq(null); }} className="flex-1 px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612]">{editingFaq.id ? 'Save' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ═════════ Folio viewer modal ═════════ */}
      {viewFolio && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setViewFolio(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl p-7 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold font-serif text-[#1a1208]">Folio · {viewFolio.id}</h3>
                <p className="text-xs text-[#6b5d52] mt-0.5">
                  {viewFolio.guest_name || '—'} · {viewFolio.room_name || viewFolio.room_id}
                  {viewFolio.status === 'settled' && viewFolio.settled_at ? ` · Settled ${new Date(viewFolio.settled_at).toLocaleDateString('en-IN')}` : ''}
                </p>
              </div>
              <button onClick={() => setViewFolio(null)} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18} /></button>
            </div>
            <div className="bg-[#faf7f2] rounded-2xl p-4 mb-4">
              <table className="w-full text-sm">
                <thead className="text-[10px] font-bold uppercase tracking-widest text-[#6b5d52]">
                  <tr>
                    <th className="text-left py-2">Description</th>
                    <th className="text-center py-2">Qty</th>
                    <th className="text-right py-2">Amount</th>
                    <th className="text-right py-2">GST</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewFolio.entries || []).map((e: any) => (
                    <tr key={e.id} className="border-t border-[#cc5a16]/10">
                      <td className="py-2">
                        <div className="font-semibold">{e.description}</div>
                        <div className="text-[10px] text-[#9c8e85] uppercase tracking-wide">{e.entry_type}</div>
                      </td>
                      <td className="py-2 text-center font-mono">{e.quantity}</td>
                      <td className="py-2 text-right font-mono">₹{Number(e.amount).toLocaleString('en-IN')}</td>
                      <td className="py-2 text-right font-mono text-[#6b5d52]">{e.gst_rate || 0}% · ₹{Number(e.gst_amount || 0).toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-[#6b5d52]">Subtotal</span><span className="font-mono">₹{Number(viewFolio.subtotal).toLocaleString('en-IN')}</span></div>
              <div className="flex justify-between"><span className="text-[#6b5d52]">GST</span><span className="font-mono">₹{Number(viewFolio.gst_amount).toLocaleString('en-IN')}</span></div>
              {viewFolio.discount > 0 && <div className="flex justify-between text-rose-600"><span>Discount</span><span className="font-mono">−₹{Number(viewFolio.discount).toLocaleString('en-IN')}</span></div>}
              <div className="flex justify-between text-lg font-bold pt-2 border-t border-[#cc5a16]/10 text-[#1a1208]"><span>Grand Total</span><span className="font-mono text-[#cc5a16]">₹{Number(viewFolio.grand_total).toLocaleString('en-IN')}</span></div>
            </div>
            <div className="mt-5 space-y-2">
              {/* Row 1 — Close / Print / Download */}
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => setViewFolio(null)} className="flex-1 min-w-[110px] px-4 py-2.5 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold hover:bg-[#faf7f2]">Close</button>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/folios/${viewFolio.id}/invoice-pdf`, { headers: { Authorization: `Bearer ${token}` } });
                      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
                      const blob = await res.blob();
                      printPdfBlob(blob);
                    } catch (err: any) { alert(err.message); }
                  }}
                  className="flex-1 min-w-[110px] px-4 py-2.5 rounded-2xl border-2 border-[#cc5a16] text-[#cc5a16] text-sm font-bold hover:bg-[#cc5a16]/5 flex items-center justify-center gap-2"
                ><Printer size={14}/> Print</button>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/folios/${viewFolio.id}/invoice-pdf`, { headers: { Authorization: `Bearer ${token}` } });
                      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
                      const blob = await res.blob();
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      const safeName = String(viewFolio.guest_name || 'guest').replace(/\s+/g, '-');
                      a.download = `${viewFolio.doc_type === 'CREDIT_NOTE' ? 'CreditNote' : 'Invoice'}-${viewFolio.id}-${safeName}.pdf`;
                      document.body.appendChild(a); a.click();
                      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
                    } catch (err: any) { alert(err.message); }
                  }}
                  className="flex-1 min-w-[110px] px-4 py-2.5 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] flex items-center justify-center gap-2"
                ><Download size={14}/> Download PDF</button>
              </div>
              {/* Row 2 — Email / Credit Note */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    const defaultEmail = viewFolio.guest_email || '';
                    const toEmail = prompt('Send invoice to (email):', defaultEmail);
                    if (!toEmail || !toEmail.trim()) return;
                    try {
                      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/folios/${viewFolio.id}/email-invoice`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ to: toEmail.trim() }),
                      });
                      const body = await res.json();
                      if (!res.ok) throw new Error(body.error || 'Failed');
                      alert(`✅ Invoice ${body.invoice_number} emailed to ${body.sent_to}`);
                    } catch (err: any) { alert(err.message); }
                  }}
                  className="flex-1 min-w-[140px] px-4 py-2.5 rounded-2xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] flex items-center justify-center gap-2"
                ><Mail size={14}/> Email Invoice</button>
                {viewFolio.doc_type !== 'CREDIT_NOTE' && viewFolio.status === 'settled' && (
                  <button
                    onClick={async () => {
                      const reason = prompt('Reason for credit note (optional):', 'Refund');
                      if (reason === null) return;
                      try {
                        const res = await fetch(`/api/restaurant/${restaurantId}/hotel/folios/${viewFolio.id}/credit-note`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ reason: reason || 'Refund / cancellation' }),
                        });
                        const body = await res.json();
                        if (!res.ok) throw new Error(body.error || 'Failed');
                        alert(`✅ Credit note ${body.id} created. Refresh folios to view.`);
                        await fetchHotelFolios();
                        setViewFolio(null);
                      } catch (err: any) { alert(err.message); }
                    }}
                    className="flex-1 min-w-[140px] px-4 py-2.5 rounded-2xl border-2 border-[#c13b3b] text-[#c13b3b] text-sm font-bold hover:bg-[#fdf0f0] flex items-center justify-center gap-2"
                  ><RefreshCw size={14}/> Generate Credit Note</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      <AnimatePresence>
        {isAddingItem && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-[100] p-4 overflow-y-auto">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[32px] p-5 sm:p-8 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto my-auto"
            >
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-2xl font-bold font-serif">Add Menu Item</h3>
                  <p className="text-xs text-[#9c8e85] mt-0.5">Leave image blank — add it after using AI Generate</p>
                </div>
                <button onClick={() => { setIsAddingItem(false); setNewItemCategoryCustom(''); }} className="text-[#6b5d52] hover:text-[#1a1208]"><X/></button>
              </div>
              <form onSubmit={e => {
                e.preventDefault();
                // Duplicate check
                const dup = menu.some(m =>
                  m.name.toLowerCase().trim() === newItem.name.toLowerCase().trim() &&
                  (m.category||'').toLowerCase().trim() === (newItem.category||'').toLowerCase().trim()
                );
                if (dup) { alert(`"${newItem.name}" in "${newItem.category}" already exists in your menu.`); return; }
                handleAddItem(e);
              }} className="space-y-4">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Item Name *</label>
                  <input required
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    value={newItem.name}
                    onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                    placeholder="e.g. Butter Chicken"/>
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Description</label>
                  <textarea
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none h-20 resize-none"
                    value={newItem.description}
                    onChange={e => setNewItem({ ...newItem, description: e.target.value })}
                    placeholder="Brief description of the dish…"/>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Dietary Type</label>
                    <select className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newItem.dietary_type}
                      onChange={e => setNewItem({ ...newItem, dietary_type: e.target.value as DietaryType })}>
                      <option value="VEG">🟢 Veg</option>
                      <option value="VEGAN">🔵 Vegan</option>
                      <option value="NON_VEG">🔴 Non-Veg</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Category *</label>
                    <input type="text" list="add-cats-datalist" required
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newItem.category}
                      onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                      placeholder="Mains, Starters…"/>
                    <datalist id="add-cats-datalist">
                      {['Starters','Mains','Sides','Desserts','Drinks','Breads','Soups','Salads','Snacks','Breakfast',
                        ...Array.from(new Set(menu.map(m => m.category).filter(Boolean)))
                      ].filter((v,i,a)=>a.indexOf(v)===i).map(cat => <option key={cat} value={cat}/>)}
                    </datalist>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Half Price ₹ (optional)</label>
                    <input type="number" step="0.01" min="0"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newItem.price_half}
                      onChange={e => setNewItem({ ...newItem, price_half: e.target.value })}
                      placeholder="e.g. 150"/>
                  </div>
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Full Price ₹ *</label>
                    <input required type="number" step="0.01" min="0"
                      className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                      value={newItem.price_full}
                      onChange={e => setNewItem({ ...newItem, price_full: e.target.value })}
                      placeholder="e.g. 280"/>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-1">
                  <input type="checkbox" id="add_is_daily_special"
                    checked={newItem.is_daily_special}
                    onChange={e => setNewItem({ ...newItem, is_daily_special: e.target.checked })}
                    className="w-4 h-4 rounded text-[#cc5a16]"/>
                  <label htmlFor="add_is_daily_special" className="text-xs font-bold text-[#1a1208]">⭐ Mark as Daily Special</label>
                </div>
                <div className="border-t border-[#cc5a16]/8 pt-4">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Item Image (optional — you can generate after adding)</label>
                  <input type="file" accept="image/*"
                    className="w-full text-sm text-[#6b5d52] file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#cc5a16]/10 file:text-[#1a1208] hover:file:bg-[#cc5a16]/20"
                    onChange={e => setNewItem({ ...newItem, imageFile: e.target.files?.[0] || null })}/>
                  <div className="relative my-3">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-[#cc5a16]/10"/></div>
                    <div className="relative flex justify-center text-[11px] uppercase tracking-widest text-[#9c8e85] bg-white px-2">or Google Drive URL</div>
                  </div>
                  <input placeholder="https://drive.google.com/file/d/…"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none text-sm"
                    value={newItem.driveUrl}
                    onChange={e => setNewItem({ ...newItem, driveUrl: e.target.value })}/>
                </div>
                <button type="submit"
                  className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all mt-2 flex items-center justify-center gap-2">
                  <Plus size={16}/> Add to Menu
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Invoice Modal ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {invoiceOrder && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={e => { if (e.target === e.currentTarget) closeInvoice(); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
              className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-8 py-5 border-b border-[#cc5a16]/10 shrink-0">
                <div>
                  <h3 className="text-xl font-bold font-serif">Invoice</h3>
                  <p className="font-mono text-xs text-[#9c8e85] mt-0.5">{invoiceOrder.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  {invoiceMode === 'view' ? (
                    <>
                      <button
                        onClick={() => { setInvoiceMode('edit'); setAddItemForm({ name: '', price: '', quantity: '1' }); }}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#cc5a16]/20 text-xs font-bold uppercase tracking-widest hover:bg-[#faf7f2] transition-all"
                      >
                        <Edit3 size={13} /> Edit
                      </button>
                      <button
                        onClick={() => printInvoiceOrder(invoiceOrder, invoiceItems, invoiceDiscount, invoiceApplyGst, invoiceServiceCharge, invoiceGstPercent)}
                        className="flex items-center gap-1.5 px-4 py-2 bg-[#cc5a16] text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-[#a84612] transition-all"
                      >
                        <Printer size={13} /> Print
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setInvoiceMode('view')}
                        className="px-4 py-2 rounded-xl border border-[#cc5a16]/20 text-xs font-bold uppercase tracking-widest hover:bg-[#faf7f2] transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveInvoice}
                        disabled={savingInvoice}
                        className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-green-700 disabled:opacity-50 transition-all"
                      >
                        {savingInvoice ? <Clock size={13} className="animate-spin" /> : <Save size={13} />} Save
                      </button>
                    </>
                  )}
                  <button onClick={closeInvoice} className="p-2 hover:bg-[#faf7f2] rounded-xl transition-all">
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Meta */}
              <div className="px-8 py-3 bg-[#faf7f2]/60 border-b border-[#cc5a16]/10 grid grid-cols-3 gap-4 text-xs shrink-0">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Table</p>
                  <p className="font-bold mt-0.5">{invoiceOrder.tableNumber || invoiceOrder.table_number || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Customer</p>
                  <p className="font-bold mt-0.5">{invoiceOrder.customerName || invoiceOrder.customer_name || '—'}</p>
                  {(invoiceOrder.customerPhone || invoiceOrder.customer_phone) && (
                    <p className="text-[#9c8e85] text-[11px]">{invoiceOrder.customerPhone || invoiceOrder.customer_phone}</p>
                  )}
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Date & Time</p>
                  <p className="font-bold mt-0.5">
                    {new Date(invoiceOrder.createdAt || invoiceOrder.created_at || '').toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>

              {/* Items Table */}
              <div className="flex-1 overflow-y-auto px-8 py-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-widest text-[#9c8e85] border-b border-[#cc5a16]/10">
                      <th className="pb-2 text-left font-bold">Item</th>
                      <th className="pb-2 text-center w-28 font-bold">Qty</th>
                      <th className="pb-2 text-right w-24 font-bold">Unit Price</th>
                      <th className="pb-2 text-right w-24 font-bold">Total</th>
                      {invoiceMode === 'edit' && <th className="pb-2 w-8"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#cc5a16]/5">
                    {invoiceItems.map((item, idx) => (
                      <tr key={idx} className="group">
                        <td className="py-2.5 font-medium">{item.name || item.item_name || '—'}</td>
                        <td className="py-2.5 text-center">
                          {invoiceMode === 'edit' ? (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                onClick={() => setInvoiceItems(prev => { const n = [...prev]; n[idx] = { ...n[idx], quantity: Math.max(1, (n[idx].quantity || 1) - 1) }; return n; })}
                                className="w-6 h-6 rounded-full border border-[#cc5a16]/20 flex items-center justify-center hover:bg-[#faf7f2] text-sm font-bold leading-none"
                              >−</button>
                              <span className="w-6 text-center font-bold">{item.quantity || 1}</span>
                              <button
                                onClick={() => setInvoiceItems(prev => { const n = [...prev]; n[idx] = { ...n[idx], quantity: (n[idx].quantity || 1) + 1 }; return n; })}
                                className="w-6 h-6 rounded-full border border-[#cc5a16]/20 flex items-center justify-center hover:bg-[#faf7f2] text-sm font-bold leading-none"
                              >+</button>
                            </div>
                          ) : (
                            <span>{item.quantity || 1}</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-mono text-[#3d3128]">₹{Number(item.price || 0).toFixed(2)}</td>
                        <td className="py-2.5 text-right font-mono font-bold">₹{(Number(item.price || 0) * Number(item.quantity || 1)).toFixed(2)}</td>
                        {invoiceMode === 'edit' && (
                          <td className="py-2.5 pl-2">
                            <button
                              onClick={() => setInvoiceItems(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Add item row — edit mode only */}
                {invoiceMode === 'edit' && (
                  <div className="mt-4 pt-4 border-t border-dashed border-[#cc5a16]/20">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Add Item</p>
                    <div className="flex items-center gap-2">
                      <input
                        placeholder="Item name"
                        value={addItemForm.name}
                        onChange={e => setAddItemForm(p => ({ ...p, name: e.target.value }))}
                        className="flex-1 bg-[#faf7f2] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                      />
                      <input
                        placeholder="₹ Price"
                        type="number"
                        min="0"
                        value={addItemForm.price}
                        onChange={e => setAddItemForm(p => ({ ...p, price: e.target.value }))}
                        className="w-24 bg-[#faf7f2] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                      />
                      <input
                        placeholder="Qty"
                        type="number"
                        min="1"
                        value={addItemForm.quantity}
                        onChange={e => setAddItemForm(p => ({ ...p, quantity: e.target.value }))}
                        className="w-16 bg-[#faf7f2] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                      />
                      <button
                        onClick={() => {
                          if (!addItemForm.name.trim() || !addItemForm.price) return;
                          setInvoiceItems(prev => [...prev, { name: addItemForm.name.trim(), price: Number(addItemForm.price), quantity: Math.max(1, Number(addItemForm.quantity) || 1) }]);
                          setAddItemForm({ name: '', price: '', quantity: '1' });
                        }}
                        className="px-3 py-2 bg-[#cc5a16] text-white rounded-xl hover:bg-[#a84612] transition-all"
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Discount + GST controls + Totals */}
              <div className="px-8 py-5 border-t border-[#cc5a16]/10 space-y-4 shrink-0">
                {/* Discount, Service Charge & GST — edit mode */}
                {invoiceMode === 'edit' && (
                  <div className="grid grid-cols-2 gap-3 pb-4 border-b border-[#cc5a16]/10">
                    {/* Discount */}
                    <div className="bg-[#faf7f2] rounded-2xl px-4 py-3">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] block mb-1">Discount (₹)</label>
                      <input
                        type="number" min="0" step="0.01"
                        value={invoiceDiscount}
                        onChange={e => setInvoiceDiscount(Math.max(0, Number(e.target.value)))}
                        className="w-full bg-transparent text-sm font-mono font-bold outline-none"
                        placeholder="0.00"
                      />
                    </div>
                    {/* Service Charge */}
                    <div className="bg-[#faf7f2] rounded-2xl px-4 py-3">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] block mb-1">Service Charge (%)</label>
                      <input
                        type="number" min="0" max="100" step="0.1"
                        value={invoiceServiceCharge}
                        onChange={e => setInvoiceServiceCharge(Math.max(0, Math.min(100, Number(e.target.value))))}
                        className="w-full bg-transparent text-sm font-mono font-bold outline-none"
                        placeholder="0"
                      />
                    </div>
                    {/* GST % */}
                    <div className={cn("rounded-2xl px-4 py-3 transition-colors", invoiceApplyGst ? "bg-green-50" : "bg-[#faf7f2]")}>
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] block mb-1">GST (%)</label>
                      <input
                        type="number" min="0" max="100" step="0.1"
                        value={invoiceGstPercent}
                        onChange={e => setInvoiceGstPercent(Math.max(0, Math.min(100, Number(e.target.value))))}
                        disabled={!invoiceApplyGst}
                        className="w-full bg-transparent text-sm font-mono font-bold outline-none disabled:opacity-40"
                        placeholder="5"
                      />
                    </div>
                    {/* Apply GST toggle */}
                    <div className="bg-[#faf7f2] rounded-2xl px-4 py-3 flex items-center justify-between">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Apply GST</label>
                      <button
                        onClick={() => setInvoiceApplyGst(p => !p)}
                        className={cn("relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0", invoiceApplyGst ? "bg-green-500" : "bg-[#0d0a07]/20")}
                      >
                        <span className={cn("absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200", invoiceApplyGst ? "left-6" : "left-1")} />
                      </button>
                    </div>
                  </div>
                )}

                {/* Totals */}
                {(() => {
                  const rawSub    = invoiceItems.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
                  const afterDisc = Math.max(0, rawSub - invoiceDiscount);
                  const svcAmt    = afterDisc * invoiceServiceCharge / 100;
                  const taxable   = afterDisc + svcAmt;
                  const effGst    = invoiceApplyGst ? invoiceGstPercent : 0;
                  const gstAmt    = taxable * effGst / 100;
                  const total     = taxable + gstAmt;
                  return (
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between text-[#6b5d52]">
                        <span>Subtotal</span><span className="font-mono">₹{rawSub.toFixed(2)}</span>
                      </div>
                      {invoiceDiscount > 0 && (
                        <div className="flex justify-between text-green-600 font-medium">
                          <span>Discount</span><span className="font-mono">−₹{invoiceDiscount.toFixed(2)}</span>
                        </div>
                      )}
                      {invoiceServiceCharge > 0 && (
                        <div className="flex justify-between text-[#6b5d52]">
                          <span>Service Charge ({invoiceServiceCharge}%)</span>
                          <span className="font-mono">₹{svcAmt.toFixed(2)}</span>
                        </div>
                      )}
                      {invoiceApplyGst && effGst > 0 && (
                        <div className="flex justify-between text-[#6b5d52]">
                          <span>GST ({effGst}%)</span><span className="font-mono">₹{gstAmt.toFixed(2)}</span>
                        </div>
                      )}
                      {!invoiceApplyGst && (
                        <div className="flex justify-between text-[#9c8e85] text-xs italic">
                          <span>GST</span><span>Not applied</span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold text-lg border-t border-[#cc5a16]/10 pt-2">
                        <span>Grand Total</span>
                        <span className="font-mono text-[#cc5a16]">₹{total.toFixed(2)}</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Print full-width button in view mode */}
                {invoiceMode === 'view' && (
                  <button
                    onClick={() => printInvoiceOrder(invoiceOrder, invoiceItems, invoiceDiscount, invoiceApplyGst, invoiceServiceCharge, invoiceGstPercent)}
                    className="w-full py-3 bg-[#cc5a16] text-white rounded-2xl font-bold text-sm hover:bg-[#a84612] transition-all flex items-center justify-center gap-2 mt-2"
                  >
                    <Printer size={16} /> Print Invoice (80mm)
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

        {/* ── Invoice Edit Modal ── */}
        {invoiceEditTarget && (() => {
          const inv      = invoiceEditTarget;
          const isSess   = inv.invoice_type === 'SESSION';
          // For SESSION: subtotal from server; for ORDER: computed from edit items
          const editSub  = isSess
            ? Number(inv.raw_subtotal || 0)
            : invEdit.items.reduce((s, it) => s + it.price * it.quantity, 0);
          const editAfter   = Math.max(0, editSub - invEdit.discount);
          const editSvc     = editAfter * invEdit.svcPct / 100;
          const editTaxable = editAfter + editSvc;
          const editGst     = invEdit.applyGst ? editTaxable * invEdit.gstPct / 100 : 0;
          const editGrand   = Number((editTaxable + editGst).toFixed(2));
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: '92vh' }}>

                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-[#cc5a16]/10 shrink-0">
                  <div>
                    <h3 className="font-bold text-[#1a1208] flex items-center gap-2">
                      <Edit3 size={16} className="text-[#cc5a16]" />
                      Edit Invoice #{String(inv.id).slice(-8).toUpperCase()}
                    </h3>
                    <p className="text-[11px] text-[#9c8e85] mt-0.5">
                      {isSess ? `Table Invoice · ${inv.round_count} round${inv.round_count !== 1 ? 's' : ''}` : 'Order Invoice'}
                      {' · '}{inv.tableNumber || '—'}
                      {inv.customerName ? ` · ${inv.customerName}` : ''}
                    </p>
                  </div>
                  <button onClick={() => setInvoiceEditTarget(null)} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85] transition-all"><X size={18} /></button>
                </div>

                {/* Scrollable body */}
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

                  {/* Items section */}
                  {isSess ? (
                    /* SESSION: show rounds as read-only */
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">
                        Items (from customer orders — read only)
                      </p>
                      <div className="rounded-2xl border border-[#cc5a16]/10 overflow-hidden">
                        {(inv.rounds || []).map((r: any, ri: number) => (
                          <div key={ri}>
                            {r.label && (
                              <div className="px-4 py-1.5 bg-[#faf7f2] text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] border-b border-[#cc5a16]/10">
                                Round {ri + 1}
                              </div>
                            )}
                            {(r.items || []).map((it: any, ii: number) => (
                              <div key={ii} className="flex justify-between items-center px-4 py-2 border-b border-[#cc5a16]/10 last:border-0 text-sm">
                                <span className="text-[#3d3128]">{it.name}</span>
                                <span className="font-mono text-[#6b5d52] text-xs">{it.qty}× ₹{Number(it.price).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    /* ORDER: editable items */
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Items</p>
                        <button
                          onClick={() => setInvEdit(p => ({ ...p, items: [...p.items, { name: '', quantity: 1, price: 0 }] }))}
                          className="text-xs font-bold text-[#cc5a16] hover:underline flex items-center gap-1"
                        ><Plus size={12} /> Add Item</button>
                      </div>
                      <div className="space-y-2">
                        <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] px-1">
                          <span className="col-span-6">Item Name</span><span className="col-span-2 text-center">Qty</span><span className="col-span-3 text-right">Price (₹)</span><span className="col-span-1"/>
                        </div>
                        {invEdit.items.map((it, i) => (
                          <div key={i} className="grid grid-cols-12 gap-2 items-center">
                            <input type="text" value={it.name}
                              onChange={e => setInvEdit(p => ({ ...p, items: p.items.map((x,j) => j===i ? {...x, name: e.target.value} : x) }))}
                              placeholder="Item name"
                              className="col-span-6 border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                            <input type="number" min="1" value={it.quantity}
                              onChange={e => setInvEdit(p => ({ ...p, items: p.items.map((x,j) => j===i ? {...x, quantity: Number(e.target.value)||1} : x) }))}
                              className="col-span-2 border border-[#cc5a16]/20 rounded-xl px-2 py-2 text-sm text-center outline-none focus:ring-2 ring-[#cc5a16]/20" />
                            <input type="number" min="0" step="0.01" value={it.price}
                              onChange={e => setInvEdit(p => ({ ...p, items: p.items.map((x,j) => j===i ? {...x, price: Number(e.target.value)||0} : x) }))}
                              className="col-span-3 border border-[#cc5a16]/20 rounded-xl px-2 py-2 text-sm text-right outline-none focus:ring-2 ring-[#cc5a16]/20" />
                            <button onClick={() => setInvEdit(p => ({ ...p, items: p.items.filter((_,j) => j!==i) }))}
                              disabled={invEdit.items.length === 1}
                              className="col-span-1 flex justify-center text-[#c5b9b2] hover:text-red-500 disabled:opacity-20 transition-colors">
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Adjustments */}
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Adjustments</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-[#9c8e85] uppercase tracking-widest mb-1">Discount (₹)</label>
                        <input type="number" min="0" value={invEdit.discount}
                          onChange={e => setInvEdit(p => ({ ...p, discount: Number(e.target.value)||0 }))}
                          className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-[#9c8e85] uppercase tracking-widest mb-1">Service (%)</label>
                        <input type="number" min="0" value={invEdit.svcPct}
                          onChange={e => setInvEdit(p => ({ ...p, svcPct: Number(e.target.value)||0 }))}
                          className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-[#9c8e85] uppercase tracking-widest mb-1">GST (%)</label>
                        <div className="flex gap-1.5">
                          <input type="number" min="0" value={invEdit.gstPct}
                            onChange={e => setInvEdit(p => ({ ...p, gstPct: Number(e.target.value)||0 }))}
                            className="flex-1 border border-[#cc5a16]/20 rounded-xl px-2 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                          <button onClick={() => setInvEdit(p => ({ ...p, applyGst: !p.applyGst }))}
                            className={cn("shrink-0 px-2 rounded-xl text-[11px] font-bold transition-all", invEdit.applyGst ? "bg-[#cc5a16] text-white" : "bg-[#0d0a07]/5 text-[#6b5d52]")}>
                            {invEdit.applyGst ? 'ON' : 'OFF'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Live total */}
                  <div className="bg-[#faf7f2] rounded-2xl p-4 space-y-1.5 text-sm">
                    <div className="flex justify-between text-[#6b5d52]"><span>Subtotal</span><span className="font-mono">₹{editSub.toFixed(2)}</span></div>
                    {invEdit.discount > 0 && <div className="flex justify-between text-red-600"><span>Discount</span><span className="font-mono">−₹{invEdit.discount.toFixed(2)}</span></div>}
                    {invEdit.svcPct > 0 && <div className="flex justify-between text-[#6b5d52]"><span>Service ({invEdit.svcPct}%)</span><span className="font-mono">₹{editSvc.toFixed(2)}</span></div>}
                    {invEdit.applyGst && invEdit.gstPct > 0 && <div className="flex justify-between text-[#6b5d52]"><span>GST ({invEdit.gstPct}%)</span><span className="font-mono">₹{editGst.toFixed(2)}</span></div>}
                    <div className="flex justify-between font-bold text-[#1a1208] pt-1.5 border-t border-[#cc5a16]/10 text-base">
                      <span>Grand Total</span><span className="font-mono text-[#cc5a16]">₹{editGrand.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Payment method (for Mark Paid) */}
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Payment Method</p>
                    <div className="flex gap-2">
                      {(['CASH','CARD','UPI'] as const).map(m => (
                        <button key={m} onClick={() => setInvEdit(p => ({ ...p, payMethod: m }))}
                          className={cn("flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                            invEdit.payMethod === m ? "bg-[#cc5a16] text-white" : "bg-[#faf7f2] text-[#6b5d52] hover:bg-[#cc5a16]/10")}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Footer actions */}
                <div className="px-6 py-4 border-t border-[#cc5a16]/10 flex gap-2 shrink-0">
                  <button
                    onClick={saveInvoiceEdit}
                    disabled={invEdit.saving}
                    className="flex-1 py-3 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] font-bold text-sm hover:bg-[#faf7f2] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {invEdit.saving ? <><RefreshCw size={14} className="animate-spin"/>Saving…</> : <><Save size={14}/>Save Changes</>}
                  </button>
                  <button
                    onClick={() => markInvoicePaid(inv, invEdit.payMethod)}
                    disabled={invEdit.markingPaid}
                    className="flex-1 py-3 rounded-2xl bg-green-600 text-white font-bold text-sm hover:bg-green-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {invEdit.markingPaid
                      ? <><RefreshCw size={14} className="animate-spin"/>Processing…</>
                      : <><CheckCircle2 size={14}/>Mark as Paid</>}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Print Preview Modal ── */}
        {printPreviewHtml && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md flex flex-col" style={{ maxHeight: '90vh' }}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#cc5a16]/10">
                <h3 className="font-bold text-[#1a1208]">Print Preview</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openThermalPrint(printPreviewHtml)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#cc5a16] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#a84612] transition-all"
                  >
                    <Printer size={13} /> Print Now
                  </button>
                  <button onClick={() => setPrintPreviewHtml(null)} className="p-2 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85] transition-all"><X size={18} /></button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <div className="border border-[#cc5a16]/10 rounded-xl overflow-hidden" style={{ transform: 'scale(0.85)', transformOrigin: 'top center', width: '118%', marginLeft: '-9%' }}>
                  <iframe
                    srcDoc={printPreviewHtml}
                    style={{ width: '100%', minHeight: '600px', border: 'none', background: '#fff' }}
                    title="Invoice Preview"
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Template Settings Panel ── */}
        {showTemplatePanel && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#cc5a16]/10">
                <h3 className="font-bold text-[#1a1208] flex items-center gap-2"><Settings size={16} className="text-[#cc5a16]" /> Invoice Template</h3>
                <button onClick={() => setShowTemplatePanel(false)} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85] transition-all"><X size={16} /></button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Choose what appears on customer invoices</p>
                {([
                  { key: 'showGSTIN',           label: 'Show GSTIN number'        },
                  { key: 'showCity',             label: 'Show restaurant city'     },
                  { key: 'showCustomerPhone',    label: 'Show customer phone'      },
                  { key: 'showPaymentMethod',    label: 'Show payment method'      },
                  { key: 'showItemBreakdown',    label: 'Show itemized breakdown'  },
                  { key: 'showDiscountLine',     label: 'Show discount line'       },
                  { key: 'showThankYouNote',     label: 'Show thank-you note'      },
                ] as const).map(({ key, label }) => (
                  <label key={key} className="flex items-center justify-between cursor-pointer group">
                    <span className="text-sm font-medium text-[#3d3128] group-hover:text-[#1a1208] transition-colors">{label}</span>
                    <button
                      onClick={() => {
                        const next = { ...invoiceTemplate, [key]: !invoiceTemplate[key] };
                        setInvoiceTemplate(next);
                        localStorage.setItem('as-invoice-tpl', JSON.stringify(next));
                      }}
                      className={cn(
                        "relative w-10 h-5 rounded-full transition-all duration-200 shrink-0",
                        invoiceTemplate[key] ? "bg-[#cc5a16]" : "bg-[#0d0a07]/15"
                      )}
                    >
                      <span className={cn(
                        "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200",
                        invoiceTemplate[key] ? "left-5" : "left-0.5"
                      )} />
                    </button>
                  </label>
                ))}
                <div className="pt-2">
                  <label className="block text-xs font-bold text-[#6b5d52] uppercase tracking-widest mb-1.5">Footer Text</label>
                  <input
                    type="text"
                    value={invoiceTemplate.footerText}
                    onChange={e => {
                      const next = { ...invoiceTemplate, footerText: e.target.value };
                      setInvoiceTemplate(next);
                      localStorage.setItem('as-invoice-tpl', JSON.stringify(next));
                    }}
                    placeholder="Thank you for your business!"
                    className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                  />
                </div>
              </div>
              <div className="px-6 pb-5">
                <button
                  onClick={() => setShowTemplatePanel(false)}
                  className="w-full py-3 rounded-2xl bg-[#cc5a16] text-white font-bold text-sm hover:bg-[#a84612] transition-all"
                >Done</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Delete Invoice Confirmation Modal (admin-gated, per-tenant) ── */}
        {deleteInvoiceTarget && (() => {
          const inv = deleteInvoiceTarget;
          const idStr = String(inv.id || '');
          const last6 = idStr.slice(-6).toUpperCase();
          const idTypedOk = deleteIdConfirm.trim().toUpperCase() === last6;
          const reasonTrim = deleteReason.trim();
          const reasonOk = reasonTrim.length >= 10;
          const canDelete = idTypedOk && reasonOk && !deletingInvoice;
          const isSession = inv.invoice_type === 'SESSION';
          return (
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
              <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: '92vh' }}>
                {/* Header */}
                <div className="px-6 py-5 border-b border-red-100 shrink-0 bg-red-50/60 rounded-t-3xl">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-red-700 flex items-center gap-2">
                        <Trash2 size={16} /> Permanently Delete Invoice
                      </h3>
                      <p className="text-[11px] text-red-600/80 mt-1 leading-snug">
                        This cannot be undone. Reports and analytics will recompute without this invoice. A JSON snapshot is preserved in the central audit log for compliance.
                      </p>
                    </div>
                    <button
                      onClick={() => { if (!deletingInvoice) setDeleteInvoiceTarget(null); }}
                      disabled={deletingInvoice}
                      className="p-1.5 hover:bg-red-100 rounded-xl text-red-600 transition-all disabled:opacity-40"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
                {/* Body */}
                <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                  {/* Summary */}
                  <div className="bg-[#faf7f2] rounded-2xl p-4 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-bold uppercase tracking-widest text-[#9c8e85]">Invoice ID</span>
                      <span className="font-mono font-bold text-[#cc5a16]">#{idStr.slice(-8).toUpperCase()}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="font-bold uppercase tracking-widest text-[#9c8e85]">Type</span>
                      <span className="font-bold">{isSession ? `TABLE · ${inv.round_count || 1} round${(inv.round_count || 1) !== 1 ? 's' : ''}` : 'ORDER'}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="font-bold uppercase tracking-widest text-[#9c8e85]">Customer</span>
                      <span className="font-bold">{inv.customerName || inv.customer_name || '—'}</span>
                    </div>
                    {inv.tableNumber && (
                      <div className="flex justify-between text-xs">
                        <span className="font-bold uppercase tracking-widest text-[#9c8e85]">Table</span>
                        <span className="font-bold">{inv.tableNumber}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs">
                      <span className="font-bold uppercase tracking-widest text-[#9c8e85]">Total</span>
                      <span className="font-mono font-bold text-[#1a1208]">₹{Number(inv.totalAmount || inv.total_amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                  {/* Type-the-ID confirmation */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1.5">
                      Type the last 6 characters of the invoice ID to confirm
                    </label>
                    <div className="text-[11px] text-[#9c8e85] mb-2 font-mono">
                      Expected: <span className="font-bold text-[#cc5a16]">{last6}</span>
                    </div>
                    <input
                      type="text"
                      value={deleteIdConfirm}
                      onChange={e => setDeleteIdConfirm(e.target.value)}
                      placeholder={last6}
                      className={cn(
                        "w-full font-mono uppercase border-2 rounded-xl px-3 py-2 text-sm outline-none transition-all",
                        idTypedOk
                          ? "border-green-500 bg-green-50 text-green-700"
                          : "border-[#cc5a16]/20 focus:ring-2 ring-[#cc5a16]/20"
                      )}
                      autoFocus
                      disabled={deletingInvoice}
                    />
                  </div>
                  {/* Reason */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1.5">
                      Reason for deletion <span className="text-red-600">*</span>
                    </label>
                    <textarea
                      value={deleteReason}
                      onChange={e => setDeleteReason(e.target.value)}
                      placeholder="e.g. Duplicate invoice raised by waiter; cancelled by customer; test record"
                      rows={3}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 resize-none"
                      disabled={deletingInvoice}
                    />
                    <p className={cn("text-[11px] mt-1", reasonOk ? 'text-green-600' : 'text-[#9c8e85]')}>
                      {reasonTrim.length}/10 minimum characters
                    </p>
                  </div>
                  {deleteError && (
                    <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
                      {deleteError}
                    </div>
                  )}
                </div>
                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#cc5a16]/10 flex gap-2 shrink-0">
                  <button
                    onClick={() => { if (!deletingInvoice) setDeleteInvoiceTarget(null); }}
                    disabled={deletingInvoice}
                    className="flex-1 py-3 rounded-2xl border border-[#cc5a16]/20 text-[#6b5d52] font-bold text-sm hover:bg-[#faf7f2] transition-all disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDeleteInvoice}
                    disabled={!canDelete}
                    className={cn(
                      "flex-1 py-3 rounded-2xl text-white font-bold text-sm transition-all flex items-center justify-center gap-2",
                      canDelete
                        ? "bg-red-600 hover:bg-red-700 shadow-lg shadow-red-600/30"
                        : "bg-red-300 cursor-not-allowed"
                    )}
                  >
                    {deletingInvoice ? (
                      <>Deleting…</>
                    ) : (
                      <><Trash2 size={14} /> Permanently delete</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── On-Demand Invoice Modal ── */}
        {showOnDemandModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl flex flex-col" style={{ maxHeight: '90vh' }}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#cc5a16]/10 shrink-0">
                <h3 className="font-bold text-[#1a1208] flex items-center gap-2"><Receipt size={16} className="text-[#cc5a16]" /> New On-Demand Invoice</h3>
                <button onClick={() => setShowOnDemandModal(false)} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85] transition-all"><X size={16} /></button>
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* Customer details */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Customer Name</label>
                    <input type="text" placeholder="Optional" value={odCustomer.name}
                      onChange={e => setOdCustomer(p => ({...p, name: e.target.value}))}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Phone</label>
                    <input type="text" placeholder="Optional" value={odCustomer.phone}
                      onChange={e => setOdCustomer(p => ({...p, phone: e.target.value}))}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Table / Reference</label>
                    <input type="text" placeholder="Table name or reference" value={odCustomer.reference}
                      onChange={e => setOdCustomer(p => ({...p, reference: e.target.value}))}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                  </div>
                </div>

                {/* Items */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Items</label>
                    <button
                      onClick={() => setOdInvoiceItems(p => [...p, {name:'',qty:1,price:0}])}
                      className="text-xs font-bold text-[#cc5a16] hover:underline flex items-center gap-1"
                    ><Plus size={12} /> Add Item</button>
                  </div>
                  <div className="space-y-2">
                    <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] px-1">
                      <span className="col-span-6">Item Name</span><span className="col-span-2 text-center">Qty</span><span className="col-span-3 text-right">Price (₹)</span><span className="col-span-1"/>
                    </div>
                    {odInvoiceItems.map((it, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-6 relative">
                          <input type="text" placeholder="Item name or search menu…" value={it.name}
                            onChange={e => setOdInvoiceItems(p => p.map((x,j) => j===i ? {...x, name: e.target.value} : x))}
                            onFocus={() => setOdSearchActive(i)}
                            onBlur={() => setTimeout(() => setOdSearchActive(null), 150)}
                            className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                          {odSearchActive === i && it.name.length > 0 && (() => {
                            const hits = menu.filter(m => m.available !== false && m.name.toLowerCase().includes(it.name.toLowerCase())).slice(0, 8);
                            return hits.length > 0 ? (
                              <div className="absolute top-full left-0 mt-1 z-[300] w-full bg-white rounded-xl shadow-2xl border border-[#cc5a16]/10 max-h-52 overflow-y-auto">
                                {hits.map(m => (
                                  <button key={m.id} type="button"
                                    onMouseDown={() => {
                                      setOdInvoiceItems(p => p.map((x,j) => j===i ? {...x, name: m.name, price: m.price} : x));
                                      setOdSearchActive(null);
                                    }}
                                    className="w-full flex justify-between items-center px-3 py-2 text-sm text-[#3d3128] hover:bg-[#faf7f2] transition-colors first:rounded-t-xl last:rounded-b-xl">
                                    <span>{m.name}</span>
                                    <span className="text-xs font-semibold text-[#cc5a16] ml-2 shrink-0">₹{m.price}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null;
                          })()}
                        </div>
                        <input type="number" min="1" value={it.qty}
                          onChange={e => setOdInvoiceItems(p => p.map((x,j) => j===i ? {...x, qty: Number(e.target.value)||1} : x))}
                          className="col-span-2 border border-[#cc5a16]/20 rounded-xl px-2 py-2 text-sm text-center outline-none focus:ring-2 ring-[#cc5a16]/20" />
                        <input type="number" min="0" step="0.01" value={it.price}
                          onChange={e => setOdInvoiceItems(p => p.map((x,j) => j===i ? {...x, price: Number(e.target.value)||0} : x))}
                          className="col-span-3 border border-[#cc5a16]/20 rounded-xl px-2 py-2 text-sm text-right outline-none focus:ring-2 ring-[#cc5a16]/20" />
                        <button onClick={() => setOdInvoiceItems(p => p.filter((_,j) => j!==i))} disabled={odInvoiceItems.length===1}
                          className="col-span-1 flex justify-center text-[#c5b9b2] hover:text-red-500 disabled:opacity-20 transition-colors">
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Adjustments */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Discount (₹)</label>
                    <input type="number" min="0" value={odDiscount} onChange={e => setOdDiscount(Number(e.target.value)||0)}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Service (%)</label>
                    <input type="number" min="0" value={odSvcPct} onChange={e => setOdSvcPct(Number(e.target.value)||0)}
                      className="w-full border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">GST (%)</label>
                    <div className="flex items-center gap-2">
                      <input type="number" min="0" value={odGstPct} onChange={e => setOdGstPct(Number(e.target.value)||0)}
                        className="min-w-0 flex-1 border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
                      <button onClick={() => setOdApplyGst(v => !v)}
                        className={cn("shrink-0 px-3 py-2 rounded-xl text-[11px] font-bold transition-all", odApplyGst ? "bg-[#cc5a16] text-white" : "bg-[#0d0a07]/5 text-[#6b5d52]")}>
                        {odApplyGst ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Live total */}
                {(() => {
                  const sub = odInvoiceItems.reduce((s,it) => s + it.price * it.qty, 0);
                  const after = Math.max(0, sub - odDiscount);
                  const svc = after * odSvcPct / 100;
                  const taxable = after + svc;
                  const gst = odApplyGst ? taxable * odGstPct / 100 : 0;
                  const grand = taxable + gst;
                  return (
                    <div className="bg-[#faf7f2] rounded-2xl p-4 space-y-1.5 text-sm">
                      <div className="flex justify-between text-[#6b5d52]"><span>Subtotal</span><span className="font-mono">₹{sub.toFixed(2)}</span></div>
                      {odDiscount > 0 && <div className="flex justify-between text-red-600"><span>Discount</span><span className="font-mono">−₹{odDiscount.toFixed(2)}</span></div>}
                      {odSvcPct > 0 && <div className="flex justify-between text-[#6b5d52]"><span>Service ({odSvcPct}%)</span><span className="font-mono">₹{svc.toFixed(2)}</span></div>}
                      {odApplyGst && odGstPct > 0 && <div className="flex justify-between text-[#6b5d52]"><span>GST ({odGstPct}%)</span><span className="font-mono">₹{gst.toFixed(2)}</span></div>}
                      <div className="flex justify-between font-bold text-[#1a1208] pt-1 border-t border-[#cc5a16]/10 text-base"><span>Grand Total</span><span className="font-mono text-[#cc5a16]">₹{grand.toFixed(2)}</span></div>
                    </div>
                  );
                })()}
              </div>
              <div className="px-6 py-4 border-t border-[#cc5a16]/10 flex gap-3 shrink-0">
                <button
                  onClick={async () => {
                    const validItems = odInvoiceItems.filter(it => it.name.trim());
                    if (validItems.length === 0) return;
                    const sub = validItems.reduce((s,it) => s + it.price * it.qty, 0);
                    const after = Math.max(0, sub - odDiscount);
                    const svc = after * odSvcPct / 100;
                    const taxable = after + svc;
                    const gst = odApplyGst ? taxable * odGstPct / 100 : 0;
                    const grand = taxable + gst;
                    const fakeOrder = {
                      id: `PRV-${Date.now()}`,
                      customerName: odCustomer.name, customerPhone: odCustomer.phone,
                      tableNumber: odCustomer.reference || 'Manual',
                      items: validItems.map(it => ({ name: it.name, quantity: it.qty, price: it.price })),
                      totalAmount: grand, discount_amount: odDiscount,
                      service_charge_percent: odSvcPct, gst_percent: odGstPct,
                      apply_gst: odApplyGst ? 1 : 0, paymentMethod: '',
                      createdAt: new Date().toISOString(),
                    };
                    setPrintPreviewHtml(buildInvoiceHTML(fakeOrder, invoiceTemplate));
                  }}
                  className="flex-1 py-3 rounded-2xl border border-[#cc5a16]/20 text-[#6b5d52] font-bold text-sm hover:bg-[#faf7f2] transition-all flex items-center justify-center gap-2"
                ><Eye size={15} /> Preview</button>
                <button
                  disabled={odSaving || odInvoiceItems.filter(it=>it.name.trim()).length === 0}
                  onClick={async () => {
                    const validItems = odInvoiceItems.filter(it => it.name.trim());
                    if (validItems.length === 0) return;
                    setOdSaving(true);
                    try {
                      const res = await fetch(`/api/restaurant/${restaurantId}/invoices/manual`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({
                          customer_name: odCustomer.name, customer_phone: odCustomer.phone,
                          reference: odCustomer.reference,
                          items: validItems.map(it => ({ name: it.name, quantity: it.qty, price: it.price })),
                          discount_amount: odDiscount, service_charge_percent: odSvcPct,
                          gst_percent: odGstPct, apply_gst: odApplyGst,
                        }),
                      });
                      if (res.ok) {
                        setShowOnDemandModal(false);
                        fetchInvoices();
                      }
                    } finally { setOdSaving(false); }
                  }}
                  className="flex-1 py-3 rounded-2xl bg-[#cc5a16] text-white font-bold text-sm hover:bg-[#a84612] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {odSaving ? <><RefreshCw size={15} className="animate-spin" /> Saving…</> : <><Receipt size={15} /> Generate Invoice</>}
                </button>
              </div>
            </div>
          </div>
        )}

    </div>
  );
}

// --- CHEF DASHBOARD ---
function ChefDashboard({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [activeTab, setActiveTab] = useState<'QUEUE' | 'ATTENDANCE'>('QUEUE');
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  // Per-order ETA selection state: orderId → chosen eta string
  const [orderEtas, setOrderEtas] = useState<Record<string, string>>({});
  const [kdsFilter, setKdsFilter] = useState<'all' | 'available' | 'mine' | 'ready'>('all');
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const { lastMessage } = useSocket('CHEF', restaurantId);

  // Load restaurant settings so we can honor alerts_enabled toggle
  useEffect(() => {
    if (!restaurantId) return;
    fetch(`/api/restaurant/${restaurantId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setAlertsEnabled(data.alerts_enabled !== 0 && data.alerts_enabled !== false);
      })
      .catch(() => {});
  }, [restaurantId]);

  // Count unacknowledged (PENDING / CONFIRMED) orders — these need chef attention
  const pendingOrdersCount = orders.filter(o =>
    o.status === 'PENDING' || o.status === 'CONFIRMED'
  ).length;
  useAlertChime(alertsEnabled && pendingOrdersCount > 0, {
    label: `${pendingOrdersCount} new order${pendingOrdersCount === 1 ? '' : 's'}`,
  });

  // Decode chef identity from JWT token
  const chefIdentity = useMemo(() => {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return { id: String(payload.id || payload.userId || ''), name: localStorage.getItem('userName') || payload.name || 'Chef' };
    } catch { return { id: '', name: 'Chef' }; }
  }, [token]);

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchOrders();
    const interval = setInterval(fetchOrders, 30000);
    return () => clearInterval(interval);
  }, [restaurantId]);

  useEffect(() => {
    if (lastMessage?.type === 'NEW_ORDER' || lastMessage?.type === 'ORDER_UPDATE') {
      fetchOrders();
      // Audio cue is handled by useAlertChime hook above; it will fire as soon
      // as the refreshed orders list contains at least one PENDING/CONFIRMED item.
    }
  }, [lastMessage]);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/orders`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const raw = await res.json();
          setOrders(raw.map(normalizeOrder));
        }
      }
    } catch (err) {
      console.error("Error fetching orders:", err);
    } finally {
      setLoading(false);
    }
  };

  const patchOrder = async (id: string, body: Record<string, any>) => {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    fetchOrders();
  };

  // Accept order: assign this chef, set kitchen_status = 'accepted'
  const acceptOrder = (id: string) => patchOrder(id, {
    kitchen_status: 'accepted',
    chef_id: chefIdentity.id,
    chef_name: chefIdentity.name,
  });

  // Start preparing with chosen ETA
  const startPreparing = (id: string) => {
    const eta = orderEtas[id] || '15m';
    patchOrder(id, { status: 'PREPARING', kitchen_status: 'preparing', eta });
  };

  // All non-terminal orders
  const allActiveOrders = orders.filter(o => !['DELIVERED', 'CANCELLED'].includes(o.status));

  // Per-filter counts for badge display
  const filterCounts = useMemo(() => {
    const isAvailable = (o: Order) => {
      const ks = (o as any).kitchen_status || 'queued';
      const cid = (o as any).chef_id || '';
      return ks === 'queued' || (!cid && o.status !== 'READY' && o.status !== 'PREPARING');
    };
    const ao = orders.filter(o => !['DELIVERED', 'CANCELLED'].includes(o.status));
    return {
      all:       ao.length,
      available: ao.filter(isAvailable).length,
      mine:      ao.filter(o => !!(o as any).chef_id && (o as any).chef_id === chefIdentity.id).length,
      ready:     ao.filter(o => o.status === 'READY').length,
    };
  }, [orders, chefIdentity.id]);

  // Sort priority: READY(0) → PREPARING(1) → accepted-mine(2) → accepted-other(3) → queued(4)
  const orderPriority = (o: Order) => {
    if (o.status === 'READY') return 0;
    if (o.status === 'PREPARING') return 1;
    const ks = (o as any).kitchen_status || 'queued';
    if (ks === 'accepted' && (o as any).chef_id === chefIdentity.id) return 2;
    if (ks === 'accepted') return 3;
    return 4;
  };

  // Filtered + sorted order list for current KDS view
  const activeOrders = useMemo(() => {
    const isAvailable = (o: Order) => {
      const ks = (o as any).kitchen_status || 'queued';
      const cid = (o as any).chef_id || '';
      return ks === 'queued' || (!cid && o.status !== 'READY' && o.status !== 'PREPARING');
    };
    const ao = orders.filter(o => !['DELIVERED', 'CANCELLED'].includes(o.status));
    let filtered: Order[];
    if (kdsFilter === 'available') {
      filtered = ao.filter(isAvailable);
    } else if (kdsFilter === 'mine') {
      filtered = ao.filter(o => !!(o as any).chef_id && (o as any).chef_id === chefIdentity.id);
    } else if (kdsFilter === 'ready') {
      filtered = ao.filter(o => o.status === 'READY');
    } else {
      filtered = ao;
    }
    return [...filtered].sort((a, b) => {
      const diff = orderPriority(a) - orderPriority(b);
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : 1; // oldest first within same priority
    });
  }, [orders, kdsFilter, chefIdentity.id]);

  // Status badge config
  const statusBadge = (status: string) => {
    const map: Record<string, { bg: string; text: string; label: string }> = {
      PENDING:    { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'Pending' },
      CONFIRMED:  { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'Queued' },
      PREPARING:  { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Preparing' },
      READY:      { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Ready' },
      DELIVERED:  { bg: 'bg-gray-100',   text: 'text-gray-500',   label: 'Delivered' },
    };
    return map[status] || { bg: 'bg-gray-100', text: 'text-gray-500', label: status };
  };

  return (
    <div className="space-y-8">
      {/* ── Tabs ── */}
      <div className="flex border-b border-[#cc5a16]/15 mb-8 gap-8">
        {(['QUEUE', 'ATTENDANCE'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
              activeTab === tab
                ? "text-[#cc5a16] border-b-2 border-[#cc5a16]"
                : "text-[#9c8e85] hover:text-[#3d3128]"
            )}
          >
            {tab === 'QUEUE' ? 'Kitchen Queue' : 'Attendance'}
          </button>
        ))}
      </div>

      {activeTab === 'QUEUE' ? (
        <div className="space-y-8">
          {/* ── Header ── */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h2 className="text-3xl font-bold" style={{ fontFamily: "'Playfair Display', serif" }}>Kitchen Queue</h2>
              <button
                onClick={fetchOrders}
                className="px-4 py-2 bg-white border border-[#cc5a16]/20 rounded-2xl text-[#cc5a16] hover:bg-[#faf7f2] transition-all flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest"
              >
                <RefreshCw size={14} className={cn(loading && "animate-spin")} />
                Refresh
              </button>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-[#cc5a16]/10 px-4 py-2 rounded-full">
                <div className="w-2 h-2 rounded-full bg-[#5c7a5a] animate-pulse" />
                <span className="text-xs font-bold text-[#cc5a16] uppercase tracking-widest">Live Updates</span>
              </div>
              <div className="bg-[#faf7f2] border border-[#cc5a16]/20 px-3 py-1.5 rounded-full text-xs font-semibold text-[#6b5d52]">
                👨‍🍳 {chefIdentity.name}
              </div>
            </div>
          </div>

          {/* ── KDS Filter Tabs ── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              {([
                { key: 'all'       as const, label: 'All Orders', emoji: null },
                { key: 'available' as const, label: 'Available',  emoji: '⚡' },
                { key: 'mine'      as const, label: 'My Active',  emoji: '👨‍🍳' },
                { key: 'ready'     as const, label: 'Ready',      emoji: '✅' },
              ]).map(f => {
                const count = filterCounts[f.key];
                const isActive = kdsFilter === f.key;
                const isUrgent = (f.key === 'available' && count > 0) || (f.key === 'ready' && count > 0);
                return (
                  <button
                    key={f.key}
                    onClick={() => setKdsFilter(f.key)}
                    className={cn(
                      "flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all border",
                      isActive
                        ? "bg-[#0d0a07] text-white border-[#0d0a07] shadow-md"
                        : "bg-white text-[#6b5d52] border-[#cc5a16]/15 hover:border-[#cc5a16]/40 hover:text-[#0d0a07]/80 hover:bg-[#faf7f2]"
                    )}
                  >
                    {f.emoji && <span className="text-sm leading-none">{f.emoji}</span>}
                    {f.label}
                    <span className={cn(
                      "min-w-[20px] h-5 rounded-full text-[11px] font-black flex items-center justify-center px-1.5 transition-all",
                      isActive
                        ? "bg-white/20 text-white"
                        : isUrgent
                          ? "bg-[#cc5a16] text-white animate-pulse"
                          : count === 0
                            ? "bg-gray-100 text-gray-400"
                            : "bg-[#cc5a16]/12 text-[#cc5a16]"
                    )}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* ── Context hint line under tabs ── */}
            <p className="text-[11px] text-[#9c8e85] font-medium pl-1">
              {kdsFilter === 'all'       && `Showing all ${filterCounts.all} active orders — sorted by urgency`}
              {kdsFilter === 'available' && (filterCounts.available > 0 ? `${filterCounts.available} order${filterCounts.available > 1 ? 's' : ''} waiting to be claimed — first in, first served` : 'All orders have been claimed by chefs')}
              {kdsFilter === 'mine'      && (filterCounts.mine > 0 ? `${filterCounts.mine} order${filterCounts.mine > 1 ? 's' : ''} assigned to you` : 'No orders assigned to you yet')}
              {kdsFilter === 'ready'     && (filterCounts.ready > 0 ? `${filterCounts.ready} order${filterCounts.ready > 1 ? 's' : ''} ready — waiting for staff to serve` : 'No orders ready to serve yet')}
            </p>
          </div>

          {/* ── Alert nudge: available orders waiting while on All view ── */}
          {kdsFilter === 'all' && filterCounts.available > 0 && (
            <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
              <span className="text-amber-500 text-lg leading-none">⚡</span>
              <span className="text-sm font-semibold text-amber-800 flex-1">
                {filterCounts.available} order{filterCounts.available > 1 ? 's' : ''} waiting for a chef
              </span>
              <button
                onClick={() => setKdsFilter('available')}
                className="text-xs font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-xl transition-all uppercase tracking-wide"
              >
                View Available →
              </button>
            </div>
          )}

          {/* ── Order Cards ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {activeOrders.map(order => {
              const ks = (order as any).kitchen_status || 'queued';
              const assignedChefId   = (order as any).chef_id   || '';
              const assignedChefName = (order as any).chef_name || '';
              const eta              = (order as any).eta        || '';
              const isMyOrder        = assignedChefId && assignedChefId === chefIdentity.id;
              const isTakenByOther   = assignedChefId && assignedChefId !== chefIdentity.id;
              const badge = statusBadge(order.status);

              return (
                <motion.div
                  layout
                  key={order.id}
                  className={cn(
                    "bg-white rounded-3xl border shadow-sm overflow-hidden transition-all",
                    isTakenByOther ? "opacity-60 border-gray-100" : "border-[#cc5a16]/10"
                  )}
                >
                  {/* Card top accent bar */}
                  <div className={cn(
                    "h-1 w-full",
                    order.status === 'READY'      ? "bg-[#5c7a5a]" :
                    order.status === 'PREPARING'  ? "bg-[#cc5a16]" :
                    isMyOrder                     ? "bg-[#c9952a]" :
                    isTakenByOther                ? "bg-gray-200"  : "bg-amber-400"
                  )} />

                  {/* Card header */}
                  <div className="p-5 border-b border-[#faf7f2] flex justify-between items-start bg-[#faf7f2]/40">
                    <div>
                      <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] block">
                        {String(order.id || '').startsWith('MAN-') ? '📋 Manual Invoice' : `Table ${order.tableNumber}`}
                      </span>
                      <h4 className="text-base font-bold font-mono text-[#1a1208]">{order.id}</h4>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        <span className={cn("text-[11px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full", badge.bg, badge.text)}>
                          {badge.label}
                        </span>
                        <span className={cn(
                          "text-[11px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full",
                          order.paymentStatus === 'PAID' ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                        )}>
                          {order.paymentStatus === 'PAID' ? 'Paid' : 'Unpaid'}
                        </span>
                      </div>
                    </div>
                    {/* Chef assignment badge */}
                    {assignedChefId && (
                      <span className={cn(
                        "text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1",
                        isMyOrder ? "bg-[#cc5a16]/10 text-[#cc5a16]" : "bg-gray-100 text-gray-500"
                      )}>
                        👨‍🍳 {isMyOrder ? 'You' : assignedChefName}
                      </span>
                    )}
                  </div>

                  {/* Items list */}
                  <div className="p-5 space-y-4">
                    <div className="space-y-1.5">
                      {(Array.isArray(order.items) ? order.items : []).map((item: any, idx: number) => (
                        <div key={idx} className="flex justify-between text-sm text-[#1a1208]">
                          <span>
                            <span className="font-bold text-[#cc5a16]">{item.quantity}×</span> {item.name}
                            {item.size && <span className="ml-1.5 text-[11px] font-bold uppercase text-[#9c8e85]">({item.size})</span>}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* ETA display if set */}
                    {eta && order.status === 'PREPARING' && (
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#cc5a16] bg-[#cc5a16]/08 rounded-xl px-3 py-2">
                        <Clock size={13} /> Est. {eta} remaining
                      </div>
                    )}

                    {/* ── ACTION AREA ── */}

                    {/* 1. QUEUED — not yet accepted by anyone */}
                    {(ks === 'queued' || (!assignedChefId && order.status !== 'PREPARING' && order.status !== 'READY')) && (
                      <div className="pt-2">
                        <button
                          onClick={() => acceptOrder(order.id)}
                          className="w-full py-3 rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                          style={{ background: '#cc5a16' }}
                        >
                          <CheckCircle2 size={16} /> Accept Order
                        </button>
                      </div>
                    )}

                    {/* 2. ACCEPTED by me — show ETA picker + Start Preparing */}
                    {ks === 'accepted' && isMyOrder && (
                      <div className="pt-2 space-y-3">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Set estimated time</p>
                        <div className="grid grid-cols-4 gap-2">
                          {['10m', '15m', '30m', '45m'].map(t => (
                            <button
                              key={t}
                              onClick={() => setOrderEtas(prev => ({ ...prev, [order.id]: t }))}
                              className={cn(
                                "py-2 rounded-xl border text-xs font-bold transition-all",
                                (orderEtas[order.id] || '15m') === t
                                  ? "bg-[#cc5a16] text-white border-[#cc5a16]"
                                  : "border-[#cc5a16]/25 text-[#6b5d52] hover:border-[#cc5a16]/60"
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                        {/* Custom time input */}
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            placeholder="Custom (e.g. 20m)"
                            value={orderEtas[order.id] && !['10m','15m','30m','45m'].includes(orderEtas[order.id]) ? orderEtas[order.id] : ''}
                            onChange={e => setOrderEtas(prev => ({ ...prev, [order.id]: e.target.value }))}
                            className="flex-1 border border-[#cc5a16]/25 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-[#cc5a16]"
                          />
                        </div>
                        <button
                          onClick={() => startPreparing(order.id)}
                          className="w-full py-3 rounded-2xl font-bold text-sm text-white transition-all active:scale-95"
                          style={{ background: '#cc5a16' }}
                        >
                          🍳 Start Preparing
                        </button>
                      </div>
                    )}

                    {/* 3. ACCEPTED by another chef — read only */}
                    {ks === 'accepted' && isTakenByOther && (
                      <div className="pt-2">
                        <div className="w-full py-3 rounded-2xl bg-gray-100 text-gray-400 text-sm font-semibold text-center">
                          Taken by {assignedChefName}
                        </div>
                      </div>
                    )}

                    {/* 4. PREPARING — mark ready */}
                    {order.status === 'PREPARING' && (
                      <button
                        onClick={() => patchOrder(order.id, { status: 'READY', kitchen_status: 'ready' })}
                        className="w-full py-3 rounded-2xl font-bold text-sm text-white flex items-center justify-center gap-2 transition-all active:scale-95"
                        style={{ background: '#5c7a5a' }}
                      >
                        <CheckCircle2 size={16} /> Mark as Ready
                      </button>
                    )}

                    {/* 5. READY — mark delivered */}
                    {order.status === 'READY' && (
                      <button
                        onClick={() => patchOrder(order.id, { status: 'DELIVERED', kitchen_status: 'served' })}
                        className="w-full py-3 rounded-2xl font-bold text-sm text-[#1a1208] bg-[#faf7f2] border border-[#5c7a5a]/30 flex items-center justify-center gap-2 transition-all active:scale-95 hover:bg-[#5c7a5a]/10"
                      >
                        ✅ Mark Delivered
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}

            {activeOrders.length === 0 && (
              <div className="col-span-full py-20 text-center">
                <ChefHat size={48} className="mx-auto mb-4 text-[#0d0a07]/15" />
                <p className="italic text-xl text-[#9c8e85] mb-3" style={{ fontFamily: "'Playfair Display', serif" }}>
                  {kdsFilter === 'mine'      && 'No orders assigned to you yet.'}
                  {kdsFilter === 'available' && 'No orders available right now.'}
                  {kdsFilter === 'ready'     && 'Nothing ready to serve yet.'}
                  {kdsFilter === 'all'       && 'No active orders in the kitchen.'}
                </p>
                {kdsFilter === 'mine' && filterCounts.available > 0 && (
                  <button
                    onClick={() => setKdsFilter('available')}
                    className="text-sm font-bold text-[#cc5a16] bg-[#cc5a16]/10 hover:bg-[#cc5a16]/20 px-5 py-2.5 rounded-2xl transition-all"
                  >
                    ⚡ {filterCounts.available} order{filterCounts.available > 1 ? 's' : ''} available to accept →
                  </button>
                )}
                {kdsFilter === 'available' && allActiveOrders.length > 0 && (
                  <button
                    onClick={() => setKdsFilter('mine')}
                    className="text-sm font-bold text-[#6b5d52] bg-[#0d0a07]/05 hover:bg-[#0d0a07]/10 px-5 py-2.5 rounded-2xl transition-all"
                  >
                    See all {allActiveOrders.length} active orders →
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <AttendanceManagement role="CHEF" token={token} restaurantId={restaurantId} />
      )}
    </div>
  );
}

// ============================================================
// THERMAL PRINT UTILITY  (80mm / 302px paper width)
// Shared by customer-facing receipts AND owner-side reprint.
// ============================================================
interface ThermalReceiptData {
  restaurantName: string;
  gstin?: string;
  gstEnabled?: boolean;
  gstPercent?: number;
  billId: string;           // shown as receipt/order number
  tableName?: string;
  customerName?: string;
  customerPhone?: string;
  date: string;             // pre-formatted date string
  time?: string;
  rounds: Array<{
    label?: string;         // e.g. "Round 1" — omit for single-order receipts
    items: Array<{ name: string; qty: number; price: number }>;
  }>;
  subtotal: number;
  discountAmount?: number;
  serviceChargeAmount?: number;
  serviceChargePercent?: number;
  gstAmount: number;
  total: number;
  paymentMethod?: string;
  footerNote?: string;
}

function buildThermalHTML(d: ThermalReceiptData): string {
  const W = 36; // chars per line at 12px Consolas/monospace on 72mm printable width

  const centre = (s: string) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2));
    return ' '.repeat(pad) + s;
  };
  const rule  = '='.repeat(W);
  const dash  = '-'.repeat(W);

  const itemLine = (name: string, qty: number, amt: number): string => {
    const qtyStr = `x${qty}`;
    const amtStr = `₹${amt.toFixed(2)}`;
    // name column gets the remaining space
    const maxNameLen = W - qtyStr.length - amtStr.length - 2;
    const truncName = name.length > maxNameLen ? name.slice(0, maxNameLen - 1) + '…' : name;
    const gap = W - truncName.length - qtyStr.length - amtStr.length;
    return truncName + ' '.repeat(Math.max(1, gap - 1)) + qtyStr + ' ' + amtStr;
  };

  const totalLine = (label: string, amt: number, bold = false): string => {
    const amtStr = `₹${amt.toFixed(2)}`;
    const gap = W - label.length - amtStr.length;
    const line = label + ' '.repeat(Math.max(1, gap)) + amtStr;
    return bold ? `<b>${line}</b>` : line;
  };

  let itemsHTML = '';
  d.rounds.forEach(round => {
    if (round.label) {
      itemsHTML += `<div class="dim">${round.label}</div>`;
    }
    round.items.forEach(it => {
      itemsHTML += `<div>${itemLine(it.name, it.qty, it.price * it.qty)}</div>`;
    });
  });

  const gstLabel = `GST @ ${d.gstPercent ?? 0}%`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt – ${d.billId}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; height: auto; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Consolas', 'Liberation Mono', 'Courier New', monospace;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      color: #000;
      width: 80mm;
      padding: 4mm;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      -webkit-font-smoothing: none;
    }
    .center { text-align: center; }
    .bold   { font-weight: 700; }
    .dim    { color: #000; font-size: 11px; margin-top: 3px; }
    .rule   { white-space: pre; letter-spacing: 0; }
    .spacer { height: 4px; }
    .big    { font-size: 16px; font-weight: 900; }
    pre     { font-family: inherit; font-size: inherit; white-space: pre-wrap; }
    @media print {
      body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      button { display: none; }
    }
  </style>
</head>
<body>
  <div class="center bold" style="font-size:13px;margin-bottom:2px;">${d.restaurantName}</div>
  ${d.gstin && d.gstin !== '0' && d.gstEnabled ? `<div class="center dim">GSTIN: ${d.gstin}</div>` : ''}
  <div class="spacer"></div>
  <div class="rule">${rule}</div>

  ${d.tableName  ? `<div><b>Table :</b> ${d.tableName}</div>` : ''}
  ${d.customerName  ? `<div><b>Name  :</b> ${d.customerName}</div>` : ''}
  ${d.customerPhone ? `<div><b>Phone :</b> ${d.customerPhone}</div>` : ''}
  <div><b>Date  :</b> ${d.date}${d.time ? ' ' + d.time : ''}</div>
  <div><b>Bill# :</b> ${d.billId}</div>

  <div class="rule">${rule}</div>
  <div class="dim">ITEM${' '.repeat(W - 14)}QTY    AMT</div>
  <div class="rule">${dash}</div>
  ${itemsHTML}
  <div class="rule">${dash}</div>

  <div>${totalLine('Subtotal', d.subtotal)}</div>
  ${d.discountAmount && d.discountAmount > 0 ? `<div class="dim">${totalLine('Discount', -d.discountAmount)}</div>` : ''}
  ${d.serviceChargeAmount && d.serviceChargeAmount > 0 ? `<div class="dim">${totalLine(`Service Charge (${d.serviceChargePercent ?? 0}%)`, d.serviceChargeAmount)}</div>` : ''}
  ${d.gstAmount > 0 ? `<div class="dim">${totalLine(gstLabel, d.gstAmount)}</div>` : ''}
  <div class="rule">${rule}</div>
  <div class="big">${totalLine('TOTAL', d.total, true)}</div>
  <div class="rule">${rule}</div>

  ${d.paymentMethod ? `<div class="center">Payment: <b>${d.paymentMethod}</b></div>` : ''}
  <div class="spacer"></div>
  <div class="center dim">${d.footerNote ?? 'Thank you! Visit us again.'}</div>
  <div class="center dim" style="margin-top:2px;">ATITHI SETU</div>
  <div class="center dim">SaaS by Manhotra Consulting</div>
  <div class="center dim">www.Atithi-Setu.com</div>
</body>
</html>`;
}

/**
 * Loads a PDF Blob URL in a hidden iframe and triggers print.
 * Same popup-blocker-safe pattern as openThermalPrint, but via iframe.src
 * (document.write can't render PDFs).
 */
// Off-screen 1×1 positioning: hidden from the user but still rendered by the
// browser. Pure 0×0 or display:none iframes cause some Chromium builds to
// skip rendering, which then prints blank.
const PRINT_IFRAME_STYLE = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';

function printPdfBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = PRINT_IFRAME_STYLE;
  document.body.appendChild(iframe);

  let triggered = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
    try { iframe.remove(); } catch { /* noop */ }
  };

  const trigger = () => {
    if (triggered) return;
    triggered = true;
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (err) {
      console.error('PDF print failed:', err);
      alert('Printing failed. Check that a printer is configured as default in Windows.');
      cleanup();
      return;
    }
    const win = iframe.contentWindow;
    if (win) { win.onafterprint = () => setTimeout(cleanup, 2000); }
    setTimeout(cleanup, 60_000);
  };

  iframe.onload = trigger;
  iframe.src = url;
  // Belt-and-suspenders: PDFs take time to parse in the iframe. If onload
  // somehow never fires, kick off print after 2s so the user isn't stuck.
  setTimeout(trigger, 2000);
}

/**
 * Writes thermal HTML into a hidden iframe and triggers print.
 * Uses an iframe (not window.open) to survive popup blockers and async contexts.
 */
function openThermalPrint(html: string) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = PRINT_IFRAME_STYLE;
  document.body.appendChild(iframe);

  let triggered = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { iframe.remove(); } catch { /* noop */ }
  };

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) { cleanup(); alert('Print unavailable — browser blocked the print frame.'); return; }

  doc.open();
  doc.write(html);
  doc.close();

  const trigger = () => {
    if (triggered) return;
    triggered = true;
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (err) {
      console.error('Thermal print failed:', err);
      alert('Printing failed. Check that a printer is configured as default in Windows.');
      cleanup();
      return;
    }
    // Let the print stream finish before removing the iframe — thermal
    // printers over USB/serial can take a couple of seconds after the dialog
    // closes. Removing too early truncates the receipt.
    const win = iframe.contentWindow;
    if (win) { win.onafterprint = () => setTimeout(cleanup, 2000); }
    setTimeout(cleanup, 60_000);
  };

  // Chromium fires load for document.write() iframes immediately after
  // .close(), but we also guard with readyState and a timeout fallback.
  iframe.onload = trigger;
  if (iframe.contentWindow?.document.readyState === 'complete') {
    trigger();
  } else {
    setTimeout(trigger, 300);
  }
}

// ─── Kitchen Order Slip (KOT) ────────────────────────────────────────────────
function buildKitchenSlipHTML(d: {
  orderId: string;
  tableNumber: string | number;
  roundNumber?: number;
  customerName?: string;
  waiterName?: string;
  chefName?: string;
  eta?: string;
  orderTime: string;
  items: { name: string; quantity: number; size?: string; notes?: string }[];
  restaurantName?: string;
}): string {
  const itemRows = d.items.map(it =>
    `<tr>
      <td style="font-size:18px;font-weight:700;padding:6px 4px 6px 0;">${it.quantity}×</td>
      <td style="font-size:16px;font-weight:700;padding:6px 0;">${it.name}${it.size ? ` <span style="font-size:12px;font-weight:500;color:#000;">(${it.size})</span>` : ''}</td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>KOT - Table ${d.tableNumber}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; height: auto; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Consolas', 'Liberation Mono', 'Courier New', monospace; width: 80mm; padding: 4mm; background: #fff; color: #000; font-weight: 500; -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-font-smoothing: none; }
    .header { text-align: center; border-bottom: 3px solid #000; padding-bottom: 8px; margin-bottom: 8px; }
    .kot-label { font-size: 11px; font-weight: 700; letter-spacing: 3px; color: #000; }
    .table-name { font-size: 26px; font-weight: 900; letter-spacing: 1px; margin: 4px 0; color: #000; }
    .round-badge { display: inline-block; background: #000; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 20px; margin-top: 2px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .meta { font-size: 12px; color: #000; margin: 6px 0 2px; border-bottom: 2px dashed #000; padding-bottom: 6px; }
    .meta-row { display: flex; justify-content: space-between; margin-bottom: 3px; }
    .meta-label { font-weight: 700; min-width: 70px; }
    .items-table { width: 100%; margin-top: 8px; border-collapse: collapse; }
    .items-sep { border-top: 2px solid #000; margin: 8px 0; }
    .footer { margin-top: 10px; border-top: 2px dashed #000; padding-top: 6px; font-size: 11px; color: #000; text-align: center; }
    .eta-box { margin-top: 8px; border: 2px solid #000; border-radius: 4px; padding: 4px 8px; text-align: center; }
    .eta-label { font-size: 10px; font-weight: 700; letter-spacing: 2px; }
    .eta-value { font-size: 20px; font-weight: 900; }
    @media print { body { width: 80mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; } @page { margin: 0; size: 80mm auto; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="kot-label">KITCHEN ORDER TICKET</div>
    <div class="table-name">${String(d.tableNumber).toUpperCase()}</div>
    ${d.roundNumber && d.roundNumber > 1 ? `<div class="round-badge">ROUND ${d.roundNumber}</div>` : ''}
  </div>

  <div class="meta">
    <div class="meta-row"><span class="meta-label">ORDER ID</span><span>#${d.orderId.slice(-8).toUpperCase()}</span></div>
    <div class="meta-row"><span class="meta-label">TIME</span><span>${d.orderTime}</span></div>
    ${d.customerName ? `<div class="meta-row"><span class="meta-label">CUSTOMER</span><span>${d.customerName}</span></div>` : ''}
    ${d.waiterName   ? `<div class="meta-row"><span class="meta-label">WAITER</span><span>${d.waiterName}</span></div>` : ''}
    ${d.chefName     ? `<div class="meta-row"><span class="meta-label">CHEF</span><span>${d.chefName}</span></div>` : ''}
  </div>

  <div class="items-sep"></div>
  <table class="items-table">${itemRows}</table>
  <div class="items-sep"></div>

  ${d.eta ? `<div class="eta-box"><div class="eta-label">TARGET ETA</div><div class="eta-value">${d.eta}</div></div>` : ''}

  <div class="footer">${d.restaurantName || ''} · ${new Date().toLocaleDateString('en-IN')}</div>
</body>
</html>`;
}

// --- CUSTOMER INTERFACE ---
// ── Safe date formatter — returns '—' for null/invalid dates ──────────────────
const safeFmt = (val: any, opts: Intl.DateTimeFormatOptions, type: 'date' | 'time' | 'both' = 'both'): string => {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '—';
  if (type === 'time') return d.toLocaleTimeString('en-IN', opts);
  if (type === 'date') return d.toLocaleDateString('en-IN', opts);
  return d.toLocaleString('en-IN', opts);
};

/* ═══════════════════════════════════════════════════════════════════════
 * HotelSentimentPanel — on-demand Groq-powered feedback analysis (Phase 4).
 * Surfaced at the bottom of the hotel Analytics view.
 * ═══════════════════════════════════════════════════════════════════════ */
function HotelSentimentPanel({ restaurantId, token }: { restaurantId: string; token: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string>('');

  const run = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/analytics/sentiment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      setResult(body);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const severityColor: any = {
    high: 'bg-rose-50 text-rose-700 border-rose-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low: 'bg-slate-50 text-slate-700 border-slate-200',
  };

  return (
    <div className="bg-white rounded-3xl border border-[#cc5a16]/10 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-sm font-serif font-bold text-[#1a1208]">AI Sentiment Analysis</h4>
          <p className="text-[11px] text-[#9c8e85] mt-0.5">Analyze guest feedback from the last 30 days — powered by Groq.</p>
        </div>
        <button onClick={run} disabled={loading} className="px-4 py-2 rounded-xl bg-[#1e3a5f] text-white text-xs font-bold hover:bg-[#152a47] disabled:opacity-50 flex items-center gap-2">
          <Sparkles size={14}/> {loading ? 'Analyzing…' : 'Run Analysis'}
        </button>
      </div>
      {error && <div className="px-3 py-2 rounded-xl bg-[#fdf0f0] border border-[#c13b3b]/20 text-[#c13b3b] text-xs mb-3">{error}</div>}
      {result && (
        <div className="space-y-4 mt-4">
          {/* Summary + score */}
          <div className="p-4 rounded-2xl bg-[#faf7f2] border border-[#cc5a16]/10">
            <div className="flex items-baseline justify-between">
              <p className="text-xs uppercase tracking-widest text-[#6b5d52] font-bold">Overall</p>
              <p className={cn("text-2xl font-bold font-mono",
                result.overall_score > 0.25 ? 'text-emerald-600'
                : result.overall_score < -0.25 ? 'text-rose-600' : 'text-[#b8860b]')}>
                {result.overall_score > 0 ? '+' : ''}{Number(result.overall_score).toFixed(2)}
              </p>
            </div>
            <p className="text-sm text-[#3d3128] mt-2">{result.summary}</p>
            {result.breakdown && (
              <div className="flex items-center gap-4 mt-3 text-[11px] text-[#6b5d52] font-bold">
                <span>🙂 {result.breakdown.positive || 0}</span>
                <span>😐 {result.breakdown.neutral || 0}</span>
                <span>☹️ {result.breakdown.negative || 0}</span>
              </div>
            )}
          </div>
          {/* Patterns */}
          {Array.isArray(result.patterns) && result.patterns.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-widest text-[#6b5d52] font-bold">Patterns &amp; Suggested Actions</p>
              {result.patterns.map((p: any, i: number) => (
                <div key={i} className={cn("p-3 rounded-xl border", severityColor[p.severity] || severityColor.low)}>
                  <div className="flex items-center justify-between mb-1">
                    <strong className="text-sm">{p.theme}</strong>
                    <span className="text-[10px] uppercase tracking-wide font-bold">{p.severity}</span>
                  </div>
                  <p className="text-xs mb-1"><strong>Evidence:</strong> {p.evidence}</p>
                  <p className="text-xs"><strong>Suggestion:</strong> {p.suggestion}</p>
                </div>
              ))}
            </div>
          )}
          {Array.isArray(result.items) && result.items.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-bold text-[#6b5d52]">Per-item breakdown · {result.items.length}</summary>
              <div className="mt-2 space-y-1">
                {result.items.map((it: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 py-1 border-b border-[#cc5a16]/5 last:border-0">
                    <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-bold uppercase shrink-0",
                      it.sentiment === 'positive' ? 'bg-emerald-50 text-emerald-700'
                      : it.sentiment === 'negative' ? 'bg-rose-50 text-rose-700'
                      : 'bg-slate-100 text-slate-500')}>{it.sentiment}</span>
                    <span className="text-[#3d3128]">{it.reason}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {!result && !loading && !error && (
        <p className="text-xs text-[#9c8e85]">Click <strong>Run Analysis</strong> to have AI read your guests' feedback and surface patterns that need attention.</p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * RoomConciergeChat — in-room AI chatbot widget (Phase 4).
 * Floating bubble at the bottom-right that expands into a chat pane.
 * ═══════════════════════════════════════════════════════════════════════ */
function RoomConciergeChat({ restaurantId, sessionToken, hotelName }: {
  restaurantId: string; sessionToken: string | undefined; hotelName: string;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [history, open]);

  const send = async () => {
    if (!input.trim() || sending) return;
    const userMsg = input.trim();
    setInput('');
    setHistory(h => [...h, { role: 'user', content: userMsg }]);
    setSending(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/concierge/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: sessionToken, message: userMsg, history }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Chat failed');
      setHistory(h => [...h, { role: 'assistant', content: body.reply || '(no response)' }]);
    } catch (err: any) {
      setHistory(h => [...h, { role: 'assistant', content: `Sorry, I'm having trouble right now. ${err.message}` }]);
    } finally { setSending(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-40 w-14 h-14 rounded-full bg-[#cc5a16] text-white shadow-xl shadow-[#cc5a16]/40 hover:bg-[#a84612] flex items-center justify-center transition-transform hover:scale-105" aria-label="Open concierge chat">
        <MessageCircle size={24} />
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 z-50 bg-white rounded-3xl shadow-2xl flex flex-col border-t-[3px] border-[#b8860b]" style={{ maxHeight: '80vh', boxShadow: '0 20px 60px rgba(26, 18, 8, 0.25)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#cc5a16]/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#cc5a16] to-[#a84612] flex items-center justify-center text-white text-sm font-bold font-serif">✨</div>
          <div>
            <h3 className="text-sm font-serif font-bold text-[#1a1208]">Concierge</h3>
            <p className="text-[10px] text-[#9c8e85]">{hotelName}</p>
          </div>
        </div>
        <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85]"><X size={18}/></button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3" style={{ minHeight: '200px', maxHeight: '400px' }}>
        {history.length === 0 && (
          <div className="text-center text-xs text-[#9c8e85] mt-8">
            <p>Hi 👋 I'm your digital concierge.</p>
            <p className="mt-2">Ask me about WiFi, breakfast, checkout, local attractions, or anything about your stay.</p>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={cn("flex", m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm",
              m.role === 'user' ? 'bg-[#cc5a16] text-white' : 'bg-[#faf7f2] text-[#1a1208]')}>
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#faf7f2] rounded-2xl px-3 py-2 text-sm text-[#9c8e85]">
              <span className="inline-block w-1.5 h-1.5 bg-[#9c8e85] rounded-full animate-pulse mr-1"/>
              <span className="inline-block w-1.5 h-1.5 bg-[#9c8e85] rounded-full animate-pulse mr-1" style={{ animationDelay: '150ms' }}/>
              <span className="inline-block w-1.5 h-1.5 bg-[#9c8e85] rounded-full animate-pulse" style={{ animationDelay: '300ms' }}/>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={e => { e.preventDefault(); send(); }} className="p-3 border-t border-[#cc5a16]/10 flex gap-2">
        <input type="text" value={input} onChange={e => setInput(e.target.value)} placeholder="Ask anything…" disabled={sending}
          className="flex-1 bg-[#faf7f2] rounded-2xl px-4 py-2 text-sm focus:ring-2 ring-[#cc5a16]/20 outline-none"/>
        <button type="submit" disabled={!input.trim() || sending} className="px-4 py-2 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] disabled:opacity-50">Send</button>
      </form>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
 * RoomGuestInterface — in-room QR-scanner interface for hotel guests.
 * Activated when URL has ?r=<restaurantId>&room=<roomId>.
 * Heritage Premium styling matches the rest of the app.
 * ═══════════════════════════════════════════════════════════════════════ */
function RoomGuestInterface({ restaurantId, roomId }: { restaurantId: string; roomId: string }) {
  const [restaurant, setRestaurant] = useState<any>(null);
  const [room, setRoom] = useState<any>(null);
  const [services, setServices] = useState<any[]>([]);
  const [myRequests, setMyRequests] = useState<any[]>([]);
  const [session, setSession] = useState<any>(null);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedService, setSelectedService] = useState<any>(null);
  const [requestNote, setRequestNote] = useState('');
  const [showCustomIssue, setShowCustomIssue] = useState(false);
  const [customIssue, setCustomIssue] = useState('');
  const sessionKey = `room_session_${restaurantId}_${roomId}`;

  // On mount: load restaurant + room + services + resume or create session
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [rRes, sRes] = await Promise.all([
          fetch(`/api/restaurant/${restaurantId}`),
          fetch(`/api/restaurant/${restaurantId}/hotel/services`).catch(() => null),
        ]);
        const rData = await rRes.json();
        setRestaurant(rData);
        if (!rData || (rData.property_type !== 'HOTEL' && rData.property_type !== 'BOTH')) {
          throw new Error('This property does not offer hotel services.');
        }

        // Note: /hotel/services requires auth; the public /rooms is also auth-gated.
        // For v1 guest flow, we'll fetch services through a session-token-bearing path.
        // Actually the backend currently requires auth for services — we need a public variant.
        // Workaround: expose a public guest-service-list endpoint. For now, we'll let the
        // POST /room-sessions return a service catalogue.

        const existingToken = localStorage.getItem(sessionKey);
        const sessRes = await fetch(`/api/restaurant/${restaurantId}/hotel/room-sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room_id: roomId, session_token: existingToken || undefined })
        });
        if (!sessRes.ok) {
          const body = await sessRes.json();
          throw new Error(body.error || 'Failed to open session');
        }
        const sess = await sessRes.json();
        setSession(sess);
        localStorage.setItem(sessionKey, sess.session_token);
        if (sess.guest_name) setGuestName(sess.guest_name);
        if (sess.guest_phone) setGuestPhone(sess.guest_phone);

        // Fetch the public guest services list
        const pubSvcRes = await fetch(`/api/restaurant/${restaurantId}/hotel/guest-services?token=${encodeURIComponent(sess.session_token)}`);
        if (pubSvcRes.ok) {
          setServices(await pubSvcRes.json());
        }
        // Also fetch this guest's existing requests
        const pubReqRes = await fetch(`/api/restaurant/${restaurantId}/hotel/guest-requests?token=${encodeURIComponent(sess.session_token)}`);
        if (pubReqRes.ok) {
          setMyRequests(await pubReqRes.json());
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantId, roomId]);

  const categories = Array.from(new Set(services.map(s => s.category))).sort();
  const filtered = activeCategory === 'ALL' ? services : services.filter(s => s.category === activeCategory);

  const submitRequest = async (service: any, note?: string, quantity?: number) => {
    if (!session) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/hotel/service-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: roomId,
          service_id: service?.id || null,
          quantity: quantity || 1,
          notes: note || null,
          priority: note && !service ? 'HIGH' : 'NORMAL',
          guest_session_token: session.session_token,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit');
      // Refresh requests
      const pubReqRes = await fetch(`/api/restaurant/${restaurantId}/hotel/guest-requests?token=${encodeURIComponent(session.session_token)}`);
      if (pubReqRes.ok) setMyRequests(await pubReqRes.json());
      setSelectedService(null);
      setRequestNote('');
      setShowCustomIssue(false);
      setCustomIssue('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 border-4 border-[#cc5a16] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-[#6b5d52] text-sm">Loading your room…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#faf7f2] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-2xl max-w-md p-8 text-center border-t-[3px] border-[#b8860b]">
          <div className="w-14 h-14 rounded-full bg-[#fdf0f0] flex items-center justify-center mx-auto mb-4">
            <X size={30} className="text-[#c13b3b]" />
          </div>
          <h1 className="text-xl font-serif font-bold text-[#1a1208] mb-1">Unable to load</h1>
          <p className="text-sm text-[#6b5d52] mb-4">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#faf7f2] pb-24">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-white border-b border-[#cc5a16]/10 px-5 py-4 shadow-sm">
        <div className="max-w-md mx-auto flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#cc5a16] to-[#a84612] flex items-center justify-center text-white font-bold font-serif shrink-0">
            {(restaurant?.name || 'R').charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-widest text-[#9c8e85] font-bold">{restaurant?.name || 'Hotel'}</p>
            <h1 className="text-lg font-serif font-bold text-[#1a1208] truncate">Welcome{guestName ? `, ${guestName}` : ''}!</h1>
          </div>
        </div>
      </div>

      <div className="max-w-md mx-auto px-5 pt-5">
        {/* Booking-aware welcome: show "Day X of Y" when a booking is linked via the session */}
        {session?.booking_id && (() => {
          // If we have booking details from backend, display them. We piggy-back on requests list
          // which is the session-scoped public endpoint. For v1 we'll show just a friendly line.
          return (
            <div className="bg-white rounded-3xl p-4 border border-[#b8860b]/30 mb-4 flex items-center gap-3" style={{ borderTop: '3px solid #b8860b' }}>
              <div className="w-10 h-10 rounded-xl bg-[#b8860b]/10 flex items-center justify-center">
                <Calendar size={18} className="text-[#b8860b]" />
              </div>
              <div>
                <p className="text-xs text-[#9c8e85] uppercase tracking-widest font-bold">Your stay</p>
                <p className="text-sm text-[#1a1208] font-semibold">We're glad to have you with us</p>
              </div>
            </div>
          );
        })()}

        {/* Guest name capture (on first visit) */}
        {!guestName && (
          <div className="bg-white rounded-3xl p-5 border border-[#cc5a16]/10 mb-5">
            <h3 className="text-sm font-bold font-serif text-[#1a1208] mb-1">Your name</h3>
            <p className="text-xs text-[#6b5d52] mb-3">So we can address you properly.</p>
            <input
              value={guestName}
              onChange={e => setGuestName(e.target.value)}
              placeholder="Your name"
              className="w-full bg-[#faf7f2] rounded-2xl px-4 py-3 text-sm focus:ring-2 ring-[#cc5a16]/20 outline-none"
            />
          </div>
        )}

        {/* Category tabs */}
        {categories.length > 0 && (
          <div className="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar">
            <button
              onClick={() => setActiveCategory('ALL')}
              className={cn(
                "px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all",
                activeCategory === 'ALL' ? 'bg-[#cc5a16] text-white shadow-md' : 'bg-white border border-[#cc5a16]/10 text-[#6b5d52]'
              )}
            >All</button>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={cn(
                  "px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wide whitespace-nowrap transition-all",
                  activeCategory === cat ? 'bg-[#cc5a16] text-white shadow-md' : 'bg-white border border-[#cc5a16]/10 text-[#6b5d52]'
                )}
              >{cat.replace('_', ' ').toLowerCase()}</button>
            ))}
          </div>
        )}

        {/* Service cards */}
        <div className="space-y-3 mb-6">
          {filtered.map((svc: any) => (
            <button
              key={svc.id}
              onClick={() => setSelectedService(svc)}
              className="w-full bg-white rounded-2xl p-4 border border-[#cc5a16]/10 text-left hover:border-[#cc5a16]/30 transition-all flex items-start gap-3 shadow-sm"
            >
              <div className="w-10 h-10 rounded-xl bg-[#cc5a16]/10 flex items-center justify-center shrink-0">
                <Bell size={20} className="text-[#cc5a16]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-serif font-bold text-[#1a1208]">{svc.name}</h3>
                  {!svc.is_complimentary && svc.price > 0 && (
                    <span className="text-[#cc5a16] text-xs font-bold font-mono shrink-0">₹{Number(svc.price).toLocaleString('en-IN')}</span>
                  )}
                  {svc.is_complimentary && (
                    <span className="text-emerald-600 text-[10px] font-bold uppercase tracking-wide shrink-0">Complimentary</span>
                  )}
                </div>
                {svc.description && <p className="text-xs text-[#6b5d52] mt-1 line-clamp-2">{svc.description}</p>}
                {svc.sla_minutes && <p className="text-[10px] text-[#9c8e85] mt-1 uppercase tracking-wide">~{svc.sla_minutes} min</p>}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="bg-white rounded-2xl p-6 text-center text-sm text-[#6b5d52] border border-[#cc5a16]/10">
              No services in this category yet.
            </div>
          )}
        </div>

        {/* Report an Issue button */}
        <button
          onClick={() => setShowCustomIssue(true)}
          className="w-full bg-white rounded-2xl p-4 border-2 border-dashed border-[#cc5a16]/30 text-[#cc5a16] font-bold text-sm hover:bg-[#cc5a16]/5 transition-all flex items-center justify-center gap-2 mb-5"
        >
          <AlertCircle size={16} /> Report an Issue
        </button>

        {/* My Requests */}
        {myRequests.length > 0 && (
          <div className="space-y-2 mb-5">
            <h3 className="text-sm font-bold font-serif text-[#1a1208] px-1">My Recent Requests</h3>
            {myRequests.map((r: any) => (
              <div key={r.id} className="bg-white rounded-2xl p-3 border border-[#cc5a16]/10 flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[#1a1208] truncate">{r.service_name}</p>
                  <p className="text-[11px] text-[#9c8e85]">
                    {new Date(r.requested_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <span className={cn(
                  "px-2 py-1 rounded-md text-[10px] font-bold uppercase whitespace-nowrap",
                  r.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700'
                  : r.status === 'IN_PROGRESS' ? 'bg-amber-50 text-amber-700'
                  : r.status === 'CANCELLED' ? 'bg-slate-100 text-slate-500'
                  : 'bg-rose-50 text-rose-700'
                )}>
                  {r.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-[10px] text-[#9c8e85] mt-8 uppercase tracking-widest">Powered by Atithi Setu™</p>
      </div>

      {/* AI Concierge chat widget (Phase 4) */}
      <RoomConciergeChat
        restaurantId={restaurantId}
        sessionToken={session?.session_token}
        hotelName={restaurant?.name || 'Your Hotel'}
      />

      {/* Service request confirmation modal */}
      {selectedService && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setSelectedService(null)}>
          <div className="bg-white w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-serif font-bold text-[#1a1208] mb-1">{selectedService.name}</h3>
            {selectedService.description && <p className="text-sm text-[#6b5d52] mb-4">{selectedService.description}</p>}
            {!selectedService.is_complimentary && selectedService.price > 0 && (
              <div className="bg-[#b8860b]/10 rounded-2xl p-3 mb-4 flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-[#6b5d52] font-bold">Charge</span>
                <span className="text-lg font-bold font-mono text-[#b8860b]">₹{Number(selectedService.price).toLocaleString('en-IN')}</span>
              </div>
            )}
            <textarea
              value={requestNote}
              onChange={e => setRequestNote(e.target.value)}
              placeholder="Any special instructions? (optional)"
              rows={3}
              className="w-full bg-[#faf7f2] rounded-2xl px-4 py-3 text-sm mb-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
            />
            <div className="flex gap-2">
              <button onClick={() => setSelectedService(null)} className="flex-1 px-4 py-3 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold">Cancel</button>
              <button onClick={() => submitRequest(selectedService, requestNote)} disabled={submitting} className="flex-1 px-4 py-3 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] disabled:opacity-50">
                {submitting ? 'Submitting…' : 'Request Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom issue modal */}
      {showCustomIssue && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowCustomIssue(false)}>
          <div className="bg-white w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-serif font-bold text-[#1a1208] mb-1">Report an issue</h3>
            <p className="text-sm text-[#6b5d52] mb-4">Describe the problem — our team will be with you shortly.</p>
            <textarea
              value={customIssue}
              onChange={e => setCustomIssue(e.target.value)}
              placeholder="e.g. AC is not cooling, water leak in bathroom…"
              rows={4}
              autoFocus
              className="w-full bg-[#faf7f2] rounded-2xl px-4 py-3 text-sm mb-4 focus:ring-2 ring-[#cc5a16]/20 outline-none"
            />
            <div className="flex gap-2">
              <button onClick={() => setShowCustomIssue(false)} className="flex-1 px-4 py-3 rounded-2xl border border-[#cc5a16]/20 text-[#3d3128] text-sm font-bold">Cancel</button>
              <button onClick={() => submitRequest(null, customIssue)} disabled={!customIssue.trim() || submitting} className="flex-1 px-4 py-3 rounded-2xl bg-[#cc5a16] text-white text-sm font-bold hover:bg-[#a84612] disabled:opacity-50">
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerInterface({ restaurantId }: { restaurantId: string }) {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [showUPIModal, setShowUPIModal] = useState(false);
  const [upiCopied, setUpiCopied] = useState(false);
  const [upiQrType, setUpiQrType] = useState<'DYNAMIC' | 'BASIC'>('DYNAMIC');
  const [showInvoice, setShowInvoice] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [customerInfo, setCustomerInfo] = useState({ name: '', phone: '', email: '' });
  const [tableNumber, setTableNumber] = useState("Online");
  const [tableName, setTableName] = useState("Online Order");
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterDietary, setFilterDietary] = useState('All');
  const [filterSize, setFilterSize] = useState('All');
  const [customerView, setCustomerView] = useState<'MENU' | 'RESERVATIONS'>('MENU');
  // ── Postpaid session state ────────────────────────────────────────────────
  const [session, setSession] = useState<TableSession | null>(null);
  const [showBillRequestModal, setShowBillRequestModal] = useState(false);
  const [showSessionBill, setShowSessionBill] = useState(false);
  const [sessionBillPayMethod, setSessionBillPayMethod] = useState<'ONLINE' | 'TABLE' | null>(null);
  const [activeCustomerTab, setActiveCustomerTab] = useState<'MENU' | 'MY_ORDERS'>('MENU');
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [placeOrderError, setPlaceOrderError] = useState('');
  // ── Waiter call state ─────────────────────────────────────────────────────
  const [waiterCallStatus, setWaiterCallStatus] = useState<'idle' | 'sending' | 'sent' | 'acknowledged' | 'cooldown'>('idle');
  const [waiterCallCooldown, setWaiterCallCooldown] = useState(0);
  // ─────────────────────────────────────────────────────────────────────────
  const { lastMessage } = useSocket('CUSTOMER', restaurantId);

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchMenu();
    fetchRestaurant();
    fetchTableInfo();

    const params = new URLSearchParams(window.location.search);
    const tableId = params.get('table');
    if (tableId) setTableNumber(tableId);

    const orderId = params.get('orderId');
    if (orderId) {
      fetchOrder(orderId);
    }
  }, [restaurantId]);

  // Auto-init postpaid session once we know the restaurant mode + table
  useEffect(() => {
    if (restaurant?.checkout_mode === 'postpaid' && tableNumber && tableNumber !== 'Online') {
      initSession(tableNumber, tableName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurant?.checkout_mode, tableNumber, tableName]);

  // If the customer re-scans and lands on a bill_requested session, jump
  // straight to the bill view so they can see their invoice and pay.
  useEffect(() => {
    if (session?.status === 'bill_requested') {
      setActiveCustomerTab('MY_ORDERS');
      setShowSessionBill(true);
      if (session.payment_method) {
        setSessionBillPayMethod(session.payment_method as 'ONLINE' | 'TABLE');
      }
    }
  }, [session?.status]);

  const fetchTableInfo = async () => {
    const params = new URLSearchParams(window.location.search);
    const tableId = params.get('table');
    if (!tableId) return;

    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/tables/public`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const tables: any[] = await res.json();
          const table = tables.find(t => t.id === tableId);
          if (table) setTableName(table.name);
        }
      }
    } catch (err) {
      console.error("Failed to fetch table info", err);
    }
  };

  const fetchRestaurant = async () => {
    if (!restaurantId || typeof restaurantId !== 'string' || restaurantId === 'null' || restaurantId === 'undefined' || restaurantId === '[object Object]') return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setRestaurant(await res.json());
        }
      }
    } catch (err) {
      // Silent error
    }
  };

  const fetchOrder = async (id: string) => {
    try {
      const res = await fetch(`/api/orders/${id}?restaurantId=${restaurantId}`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setOrder(await res.json());
        }
      }
    } catch (err) {
      console.error("Failed to fetch order", err);
    }
  };

  useEffect(() => {
    if (order && lastMessage) {
      if (lastMessage.type === 'ORDER_UPDATE' && lastMessage.orderId === order.id) {
        setOrder(prev => prev ? { ...prev, status: lastMessage.status, eta: lastMessage.eta } : null);
      }
      if (lastMessage.type === 'PAYMENT_UPDATE' && lastMessage.orderId === order.id) {
        setOrder(prev => prev ? { ...prev, paymentStatus: lastMessage.status } : null);
        if (lastMessage.status === 'PAID') {
          setShowUPIModal(false);
        }
      }
      if (lastMessage.type === 'FEEDBACK_REQUESTED' && lastMessage.orderId === order.id) {
        setOrder(prev => prev ? { ...prev, feedbackRequested: true } : null);
      }
    }
    // Waiter acknowledged → show live "On the way" feedback; also cancel any active cooldown
    if (lastMessage?.type === 'WAITER_CALL_UPDATE' && lastMessage.data?.status === 'acknowledged') {
      setWaiterCallStatus('acknowledged');
      setWaiterCallCooldown(0); // cancel cooldown — waiter is already coming
    }
    // Waiter resolved the call → re-enable the button immediately so customer can call again
    if (lastMessage?.type === 'WAITER_CALL_UPDATE' && lastMessage.data?.status === 'resolved') {
      setWaiterCallStatus('idle');
      setWaiterCallCooldown(0);
    }
  }, [lastMessage, order]);

  const fetchMenu = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/menu`);
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await res.json();
          console.log("CustomerInterface: Fetched menu items:", data.length);
          setMenu(data);
        }
      } else {
        console.error("CustomerInterface: Failed to fetch menu:", res.status, res.statusText);
      }
    } catch (err) {
      console.error("CustomerInterface: Error fetching menu:", err);
    }
  };

  // ── Postpaid: create or resume a table session ───────────────────────────
  const initSession = async (tId: string, tName: string) => {
    if (!restaurantId) return;
    const storageKey = `session_${restaurantId}_${tId}`;
    const storedToken = localStorage.getItem(storageKey);
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_id: tId, table_name: tName, session_token: storedToken || undefined }),
      });
      if (res.ok) {
        const data: TableSession = await res.json();

        // Normalize DB snake_case order fields → camelCase so running totals
        // calculate correctly when resuming a session after a re-scan.
        if (Array.isArray(data.orders)) {
          data.orders = data.orders.map((o: any) => ({
            ...o,
            totalAmount:   o.totalAmount   ?? o.total_amount   ?? 0,
            gstAmount:     o.gstAmount     ?? o.gst_amount     ?? 0,
            tableNumber:   o.tableNumber   ?? o.table_number   ?? '',
            customerName:  o.customerName  ?? o.customer_name  ?? '',
            customerPhone: o.customerPhone ?? o.customer_phone ?? '',
            paymentStatus: o.paymentStatus ?? o.payment_status ?? 'PENDING',
            items: Array.isArray(o.items)
              ? o.items
              : (typeof o.items === 'string' ? (() => { try { return JSON.parse(o.items); } catch { return []; } })() : []),
          }));
        }

        setSession(data);
        localStorage.setItem(storageKey, data.session_token);

        // Always pre-fill customer info from the session — the customer should
        // never be asked for their name/phone again within the same session.
        if (data.customer_name) {
          setCustomerInfo({
            name:  data.customer_name  || '',
            phone: data.customer_phone || '',
            email: '',
          });
        }
      }
    } catch (err) {
      console.error('Failed to init session:', err);
    }
  };

  // ── Postpaid: customer requests the final bill ───────────────────────────
  const requestBill = async (paymentMethod: 'ONLINE' | 'TABLE') => {
    if (!session?.session_token || !restaurantId) return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/sessions/${session.session_token}/request-bill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_method: paymentMethod }),
      });
      if (res.ok) {
        const data = await res.json();
        setSession(prev => prev
          ? { ...prev, status: 'bill_requested', bill_amount: data.bill_amount, payment_method: paymentMethod }
          : null
        );
        setShowBillRequestModal(false);
        setSessionBillPayMethod(paymentMethod);
        // Navigate to My Orders tab and show the full bill invoice
        setActiveCustomerTab('MY_ORDERS');
        setShowSessionBill(true);
      }
    } catch (err) {
      console.error('Failed to request bill:', err);
    }
  };

  // ── Waiter Call ──────────────────────────────────────────────────────────
  const callWaiter = async () => {
    if (waiterCallStatus !== 'idle') return;
    setWaiterCallStatus('sending');
    try {
      await fetch(`/api/restaurant/${restaurantId}/waiter-calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_number: tableName,
          table_id: tableNumber,
          session_token: session?.session_token ?? null,
          customer_name: customerInfo.name || undefined,
        }),
      });
      setWaiterCallStatus('sent');
      // After 3 s show "sent", then enter 90 s cooldown to prevent spam
      setTimeout(() => {
        setWaiterCallStatus('cooldown');
        setWaiterCallCooldown(90);
      }, 3000);
    } catch {
      setWaiterCallStatus('idle');
    }
  };

  // Cooldown tick — counts down and resets to idle
  useEffect(() => {
    if (waiterCallStatus !== 'cooldown') return;
    if (waiterCallCooldown <= 0) { setWaiterCallStatus('idle'); return; }
    const t = setTimeout(() => setWaiterCallCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [waiterCallStatus, waiterCallCooldown]);

  // ── Postpaid: open UPI modal for the session bill ────────────────────────
  const openSessionUpiPayment = () => {
    if (!session || !restaurantId) return;
    const billTotal = session.bill_amount || sessionRunningTotal;
    // Build a synthetic Order so the existing UPI modal can render
    const billOrder: Order = {
      id:            session.id,
      restaurantId:  restaurantId,
      tableNumber:   session.table_name || tableName,
      customerName:  session.customer_name,
      customerPhone: session.customer_phone,
      items:         (session.orders || []).flatMap(o => Array.isArray(o.items) ? o.items : []),
      totalAmount:   billTotal,
      gstAmount:     0, // GST already included in bill_amount
      status:        'PENDING',
      paymentStatus: 'PENDING',
      createdAt:     session.opened_at,
    };
    setOrder(billOrder);
    setShowUPIModal(true);
  };
  // ─────────────────────────────────────────────────────────────────────────

  const addToCart = (item: MenuItem, size: ItemSize = 'FULL') => {
    const price = size === 'HALF' && item.price_half ? item.price_half : (item.price_full || item.price);
    setCart(prev => {
      const existing = prev.find(i => i.menuItemId === item.id && i.size === size);
      if (existing) {
        return prev.map(i => (i.menuItemId === item.id && i.size === size) ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, {
        id: Math.random().toString(),
        menuItemId: item.id,
        name: item.name,
        price: price,
        quantity: 1,
        size: size,
        category: item.category || '',
      }];
    });
  };

  const removeFromCart = (id: string) => {
    setCart(prev => prev.filter(i => i.id !== id));
  };

  const updateCartQuantity = (id: string, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        const newQuantity = Math.max(1, item.quantity + delta);
        return { ...item, quantity: newQuantity };
      }
      return item;
    }));
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const placeOrder = async (paymentMethod: 'ONLINE' | 'TABLE') => {
    // Block new orders once bill has been requested (session locked)
    if (session?.status === 'bill_requested') {
      setPlaceOrderError('Your bill has been requested. New orders cannot be added to this session.');
      return;
    }
    // Use the session's stored customer info when available (re-scan / second+ round)
    // so the customer is never asked for their name/phone more than once per session.
    const effectiveName  = customerInfo.name  || session?.customer_name  || '';
    const effectivePhone = customerInfo.phone || session?.customer_phone || '';

    if (!effectiveName || !effectivePhone) {
      setPlaceOrderError("Please provide your name and phone number.");
      return;
    }
    if (isPlacingOrder) return;
    setPlaceOrderError('');

    const checkoutMode = restaurant?.checkout_mode || 'postpaid';
    setIsPlacingOrder(true);

    try {
      const gstAmount = restaurant?.is_gst_enabled
        ? cartTotal * ((restaurant?.gst_percentage || 0) / 100)
        : 0;

      const orderBody: Record<string, any> = {
        table_number: tableName,
        customer_name: effectiveName,
        customer_phone: effectivePhone,
        customer_email: customerInfo.email,
        items: cart.map(i => ({
          id: i.menuItemId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
          size: i.size,
          category: i.category || '',
        })),
        total_amount: cartTotal,
        gst_amount: gstAmount,
        payment_method: paymentMethod,
        checkout_mode: checkoutMode,
      };

      // Attach session context for postpaid
      if (checkoutMode === 'postpaid' && session) {
        orderBody.session_token = session.session_token;
        orderBody.session_id    = session.id;
      }

      const res = await fetch(`/api/restaurant/${restaurantId}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderBody),
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type");
        const errData = ct?.includes("application/json") ? await res.json() : {};
        throw new Error(errData.error || 'Failed to place order');
      }

      const data = await res.json();
      if (!data.id && !data.orderId) throw new Error('Server did not return an order ID');

      const orderId  = data.orderId || data.id;
      const newOrder: Order = {
        id:           orderId,
        restaurantId: restaurantId!,
        tableNumber:  tableName,
        customerName: effectiveName,
        customerPhone: effectivePhone,
        items:        cart,
        totalAmount:  cartTotal,
        gstAmount,
        status:        checkoutMode === 'prepaid' ? 'PENDING' : 'CONFIRMED',
        paymentStatus: 'PENDING',
        checkout_mode: checkoutMode,
        createdAt:     new Date().toISOString(),
      };

      setCart([]);
      setIsCheckingOut(false);

      if (checkoutMode === 'postpaid') {
        // Update local session state with the new order and persist customer info
        // onto the session so subsequent rounds don't ask for name/phone again.
        setSession(prev => {
          if (!prev) return prev;
          const updatedOrders = [...(prev.orders || []), newOrder];
          return {
            ...prev,
            orders: updatedOrders,
            round_count: updatedOrders.length,
            customer_name:  prev.customer_name  || effectiveName,
            customer_phone: prev.customer_phone || effectivePhone,
          };
        });
        // Also ensure customerInfo is set so the checkout chip shows on next round
        setCustomerInfo(prev => ({
          name:  prev.name  || effectiveName,
          phone: prev.phone || effectivePhone,
          email: prev.email,
        }));
        setActiveCustomerTab('MY_ORDERS');
      } else {
        // Prepaid — track single order and optionally show UPI
        setOrder(newOrder);
        localStorage.setItem('last_restaurant_id', restaurantId || '');
        if (paymentMethod === 'ONLINE') {
          setShowUPIModal(true);
        } else {
          // Simulate WhatsApp message for prepaid table payment
          const trackingUrl = `${window.location.origin}?r=${restaurantId}&orderId=${orderId}`;
          const message = `Hello ${effectiveName}! Your order ${orderId} at ${restaurant?.name || 'Restaurant'} has been placed. Track it live here: ${trackingUrl}`;
          console.log("SIMULATING WHATSAPP MESSAGE TO:", effectivePhone);
          console.log("MESSAGE CONTENT:", message);
          console.log(`[WhatsApp Simulation] To: ${effectivePhone} | Message: ${message}`);
        }
      }
    } catch (error: any) {
      console.error('Order placement error:', error);
      setPlaceOrderError(error.message || 'Something went wrong. Please try again.');
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const TemplateRenderer = () => {
    const template = restaurant?.template_id || 'CLASSIC';
    
    const filteredMenu = menu.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                           item.description.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesCategory = filterCategory === 'All' || item.category === filterCategory;
      const matchesDietary = filterDietary === 'All' || item.dietary_type === filterDietary;
      const matchesSize = filterSize === 'All' || (filterSize === 'HALF' ? !!item.price_half : !item.price_half);
      
      return matchesSearch && matchesCategory && matchesDietary && matchesSize;
    });

    const sortedMenu = [...filteredMenu].sort((a, b) => (b.is_daily_special ? 1 : 0) - (a.is_daily_special ? 1 : 0));

    const DietaryIcon = ({ type }: { type: DietaryType }) => {
      if (type === 'VEG') return (
        <div className="w-3 h-3 bg-green-600 rounded-full shadow-sm" title="Vegetarian" />
      );
      if (type === 'VEGAN') return (
        <div className="text-green-600 flex items-center gap-1" title="Vegan">
          <Leaf size={14} className="text-green-600" />
          <span className="text-[11px] font-bold uppercase tracking-tighter">Vegan</span>
        </div>
      );
      return (
        <div className="w-3 h-3 bg-red-600 rounded-full shadow-sm" title="Non-Vegetarian" />
      );
    };

    // If an explicit menu_display_mode is set to a non-PHOTO variant, that takes
    // priority over the legacy template_id branches (MODERN/EDITORIAL are both
    // photo-heavy and wouldn't look good when the owner has no photos).
    const _dm = (restaurant?.menu_display_mode as any) || 'PHOTO';
    const _overrideTemplate = _dm && _dm !== 'PHOTO';

    if (!_overrideTemplate && template === 'MODERN') {
      return (
        <div className="space-y-12">
          {sortedMenu.map(item => (
            <div key={item.id} className={cn(
              "flex flex-col md:flex-row gap-8 items-center bg-white p-8 rounded-[32px] shadow-sm relative",
              item.is_daily_special && "border-2 border-yellow-400"
            )}>
              {item.is_daily_special && <div className="absolute -top-3 left-8 bg-yellow-400 text-yellow-950 px-4 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest shadow-md">Daily Special</div>}
              <div className="w-full md:w-1/3 aspect-square rounded-3xl overflow-hidden bg-amber-50 flex items-center justify-center">
                {item.image
                  ? <img src={item.image} className="w-full h-full object-cover" referrerPolicy="no-referrer" alt={item.name} />
                  : <span className="text-5xl">🍽️</span>
                }
              </div>
              <div className="flex-1 space-y-4">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <DietaryIcon type={item.dietary_type} />
                    <h4 className="text-3xl font-bold">{item.name}</h4>
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-mono font-bold">₹{item.price_full || item.price}</span>
                    {item.price_half && <p className="text-sm text-[#6b5d52] font-mono">Half: ₹{item.price_half}</p>}
                  </div>
                </div>
                <p className="text-lg text-[#6b5d52]">{item.description}</p>
                <div className="flex gap-4">
                  <button onClick={() => addToCart(item, 'FULL')} className="flex-1 bg-[#1a1a1a] text-white px-8 py-4 rounded-2xl font-bold hover:scale-105 transition-transform">
                    Add Full
                  </button>
                  {item.price_half && (
                    <button onClick={() => addToCart(item, 'HALF')} className="flex-1 border-2 border-[#1a1a1a] text-[#1a1a1a] px-8 py-4 rounded-2xl font-bold hover:scale-105 transition-transform">
                      Add Half
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (!_overrideTemplate && template === 'EDITORIAL') {
      const editorialCategories = Array.from(new Set(sortedMenu.map(i => i.category).filter(Boolean))).sort() as string[];
      return (
        <div className="max-w-3xl mx-auto space-y-16 py-12">
          {editorialCategories.map(cat => {
            const items = sortedMenu.filter(i => i.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="space-y-8">
                <h3 className="text-5xl font-serif italic border-b border-[#1a1a1a] pb-4">{cat}</h3>
                <div className="space-y-10">
                  {items.map(item => (
                    <div key={item.id} className={cn(
                      "group cursor-pointer p-4 rounded-2xl transition-all",
                      item.is_daily_special && "bg-yellow-50 border border-yellow-200"
                    )}>
                      <div className="flex justify-between items-baseline mb-2">
                        <div className="flex items-center gap-2">
                          <DietaryIcon type={item.dietary_type} />
                          <h4 className="text-2xl font-bold uppercase tracking-tighter group-hover:text-[#1a1208] transition-colors">{item.name}</h4>
                        </div>
                        <div className="flex-1 border-b border-dotted border-[#1a1a1a]/20 mx-4" />
                        <div className="text-right">
                          <span className="text-xl font-mono">₹{item.price_full || item.price}</span>
                          {item.price_half && <p className="text-[11px] font-mono opacity-50">H: ₹{item.price_half}</p>}
                        </div>
                      </div>
                      <p className="text-[#6b5d52] italic font-serif mb-4">{item.description}</p>
                      <div className="flex gap-2 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); addToCart(item, 'FULL'); }} className="text-[11px] font-bold uppercase tracking-widest bg-[#1a1a1a] text-white px-4 py-1 rounded-full">Add Full</button>
                        {item.price_half && <button onClick={(e) => { e.stopPropagation(); addToCart(item, 'HALF'); }} className="text-[11px] font-bold uppercase tracking-widest border border-[#1a1a1a] px-4 py-1 rounded-full">Add Half</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    // ─── Display mode (takes precedence over template CLASSIC default) ────
    // Selected by owner in Settings → Menu Display Style.
    const displayMode = (restaurant?.menu_display_mode as any) || 'PHOTO';

    // CARD — Mixed mode: small thumb if photo exists, text-first otherwise
    if (displayMode === 'CARD') {
      // Group by category for scan-ability
      const categories = Array.from(new Set(sortedMenu.map(i => i.category).filter(Boolean))).sort() as string[];
      return (
        <div className="space-y-8 max-w-3xl mx-auto">
          {categories.map(cat => {
            const items = sortedMenu.filter(i => i.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat}>
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-1.5 h-6 bg-[#cc5a16] rounded-full"/>
                  <h3 className="text-lg font-serif font-bold text-[#1a1208]">{cat}</h3>
                  <div className="flex-1 border-t border-dashed border-[#cc5a16]/20"/>
                  <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">{items.length} item{items.length===1?'':'s'}</span>
                </div>
                <div className="space-y-2">
                  {items.map(item => (
                    <div key={item.id} className={cn(
                      "bg-white rounded-2xl p-4 border flex items-center gap-4 shadow-sm",
                      item.is_daily_special ? "border-yellow-400 ring-1 ring-yellow-400/20" : "border-[#cc5a16]/10"
                    )}>
                      {item.image
                        ? <img src={item.image} alt={item.name} className="w-16 h-16 rounded-xl object-cover shrink-0" referrerPolicy="no-referrer" />
                        : <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#cc5a16]/10 to-[#b8860b]/10 flex items-center justify-center shrink-0 text-lg font-serif font-bold text-[#cc5a16]">
                            {item.name.charAt(0).toUpperCase()}
                          </div>}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-serif font-bold text-[#1a1208] truncate">{item.name}</h4>
                          <DietaryIcon type={item.dietary_type} />
                          {item.is_daily_special && <span className="px-2 py-0.5 rounded-md bg-yellow-400/20 text-yellow-800 text-[10px] font-bold uppercase tracking-wider">Special</span>}
                        </div>
                        {item.description && <p className="text-xs text-[#6b5d52] mt-1 line-clamp-2">{item.description}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-bold text-[#cc5a16] text-sm">₹{(item.price_full || item.price).toFixed(0)}</div>
                        {item.price_half && <div className="text-[10px] text-[#9c8e85] font-mono">½ ₹{item.price_half.toFixed(0)}</div>}
                        <button onClick={() => addToCart(item, 'FULL')} className="mt-1.5 px-3 py-1.5 rounded-full bg-[#cc5a16] text-white text-[11px] font-bold hover:bg-[#a84612] flex items-center gap-1">
                          <Plus size={11}/> Add
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      );
    }

    // COMPACT — Dense two-column list; every item on one short line with price-dots
    if (displayMode === 'COMPACT') {
      const categories = Array.from(new Set(sortedMenu.map(i => i.category).filter(Boolean))).sort() as string[];
      return (
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-3xl border border-[#cc5a16]/10 shadow-sm p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
              {categories.map(cat => {
                const items = sortedMenu.filter(i => i.category === cat);
                if (items.length === 0) return null;
                return (
                  <div key={cat}>
                    <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-[#b8860b] mb-1 pb-2 border-b border-[#b8860b]/30">{cat}</h3>
                    <div className="space-y-3 pt-3">
                      {items.map(item => (
                        <button key={item.id} onClick={() => addToCart(item, 'FULL')}
                          className="w-full text-left group">
                          <div className="flex items-baseline gap-2">
                            <div className="flex items-center gap-1.5 shrink-0">
                              <DietaryIcon type={item.dietary_type} />
                            </div>
                            <h4 className={cn(
                              "font-serif font-bold group-hover:text-[#cc5a16] transition-colors",
                              item.is_daily_special ? "text-[#cc5a16]" : "text-[#1a1208]"
                            )}>{item.name}</h4>
                            <div className="flex-1 border-b border-dotted border-[#cc5a16]/30 translate-y-[-3px]" aria-hidden="true"/>
                            <div className="font-mono font-bold text-[#1a1208] text-sm shrink-0">
                              ₹{(item.price_full || item.price).toFixed(0)}
                              {item.price_half && <span className="text-[10px] text-[#9c8e85] ml-1.5">/½ ₹{item.price_half.toFixed(0)}</span>}
                            </div>
                          </div>
                          {item.description && <p className="text-[11px] text-[#6b5d52] italic mt-0.5 ml-5 leading-snug">{item.description}</p>}
                          {item.is_daily_special && <span className="ml-5 mt-1 inline-block text-[9px] font-bold uppercase tracking-widest text-yellow-700">★ Daily Special</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-8 text-center text-[10px] uppercase tracking-[0.3em] text-[#9c8e85]">Tap any item to add to your order</div>
          </div>
        </div>
      );
    }

    // MAGAZINE — Elegant fine-dining feel. Serif display headings, italic descriptions,
    // brass rule dividers, generous whitespace. No photos shown even if available.
    if (displayMode === 'MAGAZINE') {
      const categories = Array.from(new Set(sortedMenu.map(i => i.category).filter(Boolean))).sort() as string[];
      return (
        <div className="max-w-2xl mx-auto space-y-14 py-6">
          {categories.map((cat, catIdx) => {
            const items = sortedMenu.filter(i => i.category === cat);
            if (items.length === 0) return null;
            return (
              <section key={cat}>
                {/* Category title — large serif, brass rule, centered */}
                <div className="text-center mb-8">
                  <p className="text-[10px] uppercase tracking-[0.4em] text-[#b8860b] font-bold mb-2">
                    {String(catIdx + 1).padStart(2, '0')} · Chapter
                  </p>
                  <h2 className="text-3xl sm:text-4xl font-serif font-bold text-[#1a1208] italic">{cat}</h2>
                  <div className="flex items-center justify-center gap-3 mt-3">
                    <div className="w-10 h-px bg-[#b8860b]"/>
                    <div className="w-1.5 h-1.5 rounded-full bg-[#b8860b]"/>
                    <div className="w-10 h-px bg-[#b8860b]"/>
                  </div>
                </div>

                <div className="space-y-7">
                  {items.map(item => (
                    <div key={item.id} className="relative">
                      <div className="flex items-baseline gap-3">
                        <h3 className="text-xl font-serif font-bold text-[#1a1208] flex items-center gap-2">
                          {item.name}
                          {item.is_daily_special && <Star size={13} className="text-[#b8860b]" fill="currentColor" />}
                        </h3>
                        <div className="flex-1 border-b border-dotted border-[#cc5a16]/30 translate-y-[-4px]" aria-hidden="true"/>
                        <div className="font-mono font-bold text-[#1a1208] shrink-0">
                          ₹{(item.price_full || item.price).toFixed(0)}
                          {item.price_half && <span className="ml-2 text-[11px] text-[#9c8e85]">/ ½ ₹{item.price_half.toFixed(0)}</span>}
                        </div>
                      </div>
                      <div className="flex items-start gap-2 mt-1.5">
                        <DietaryIcon type={item.dietary_type} />
                        {item.description && (
                          <p className="flex-1 text-[13px] text-[#6b5d52] leading-relaxed italic font-serif">
                            {item.description}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => addToCart(item, 'FULL')}
                          className="px-4 py-1.5 rounded-full border border-[#1a1208] text-[#1a1208] text-[11px] font-bold uppercase tracking-widest hover:bg-[#1a1208] hover:text-white transition-all"
                        >
                          Add Full
                        </button>
                        {item.price_half && (
                          <button
                            onClick={() => addToCart(item, 'HALF')}
                            className="px-4 py-1.5 rounded-full border border-[#b8860b] text-[#b8860b] text-[11px] font-bold uppercase tracking-widest hover:bg-[#b8860b] hover:text-white transition-all"
                          >
                            Add Half
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          <div className="text-center pt-6">
            <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.4em] text-[#9c8e85]">
              <span className="w-6 h-px bg-[#9c8e85]"/>
              Thank you
              <span className="w-6 h-px bg-[#9c8e85]"/>
            </div>
          </div>
        </div>
      );
    }

    // Default CLASSIC / PHOTO
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sortedMenu.map(item => (
          <motion.div
            key={item.id}
            className={cn(
              "bg-white rounded-[32px] overflow-hidden border shadow-sm group relative",
              item.is_daily_special ? "border-yellow-400 ring-2 ring-yellow-400/20" : "border-[#cc5a16]/10"
            )}
          >
            {item.is_daily_special && (
              <div className="absolute top-4 left-4 z-10 bg-yellow-400 text-yellow-950 text-[11px] font-bold uppercase tracking-widest px-3 py-1 rounded-full flex items-center gap-1 shadow-lg">
                <Star size={12} fill="currentColor" /> Daily Special
              </div>
            )}
            <div className="aspect-[4/3] bg-amber-50 relative overflow-hidden flex items-center justify-center">
              {item.image
                ? <img
                    src={item.image}
                    alt={item.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    referrerPolicy="no-referrer"
                  />
                : <span className="text-5xl">🍽️</span>
              }
              <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-xs font-bold font-mono flex flex-col items-end">
                <span>₹{(item.price_full || item.price).toFixed(2)}</span>
                {item.price_half && <span className="text-[11px] opacity-50">H: ₹{item.price_half.toFixed(2)}</span>}
              </div>
            </div>
            <div className="p-6">
              <div className="flex justify-between items-start mb-1">
                <span className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">{item.category}</span>
                <DietaryIcon type={item.dietary_type} />
              </div>
              <h4 className="text-xl font-bold font-serif mb-2">{item.name}</h4>
              <p className="text-sm text-[#6b5d52] mb-6 line-clamp-2">{item.description}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => addToCart(item, 'FULL')}
                  className="flex-1 bg-[#faf7f2] text-[#1a1208] py-3 rounded-2xl font-bold hover:bg-[#cc5a16] hover:text-white transition-all flex items-center justify-center gap-2 text-xs"
                >
                  <Plus size={14} /> Full
                </button>
                {item.price_half && (
                  <button
                    onClick={() => addToCart(item, 'HALF')}
                    className="flex-1 border border-[#cc5a16]/20 text-[#1a1208] py-3 rounded-2xl font-bold hover:bg-[#cc5a16] hover:text-white transition-all flex items-center justify-center gap-2 text-xs"
                  >
                    <Plus size={14} /> Half
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    );
  };

  if (order) {
    const orderTotal = (order.totalAmount ?? 0) + (order.gstAmount || 0);

    const STATUS_STEPS = [
      { key: 'PENDING',   label: 'Placed'     },
      { key: 'CONFIRMED', label: 'Confirmed'  },
      { key: 'READY',     label: 'Ready'      },
      { key: 'DELIVERED', label: 'Served'     },
    ];
    const currentStepIdx = STATUS_STEPS.findIndex(s => s.key === order.status);

    const printThermalInvoice = () => {
      const dt = new Date(order.createdAt);
      const html = buildThermalHTML({
        restaurantName: restaurant?.name || 'Restaurant',
        gstin:          restaurant?.gst_number,
        gstEnabled:     restaurant?.is_gst_enabled,
        gstPercent:     restaurant?.gst_percentage ?? 0,
        billId:         order.id.slice(-8).toUpperCase(),
        tableName:      tableName || undefined,
        customerName:   order.customerName || undefined,
        customerPhone:  order.customerPhone || undefined,
        date:           dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        time:           dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        rounds: [{
          items: (Array.isArray(order.items) ? order.items : []).map((it: any) => ({
            name:  it.name,
            qty:   it.quantity ?? 1,
            price: it.price ?? 0,
          })),
        }],
        subtotal:      order.totalAmount ?? 0,
        gstAmount:     order.gstAmount   ?? 0,
        total:         orderTotal,
        paymentMethod: order.paymentMethod || undefined,
      });
      openThermalPrint(html);
    };

    return (
      <div className="min-h-screen bg-[#faf7f2] p-4 md:p-8">
        <div className="max-w-md mx-auto space-y-4 pt-4">

          {/* ── Success header ── */}
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-[#cc5a16] text-white rounded-[32px] p-8 text-center space-y-3"
          >
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.15, type: 'spring', stiffness: 200 }}>
              <CheckCircle2 size={52} className="mx-auto" />
            </motion.div>
            <h2 className="text-2xl font-bold font-serif">Order Placed!</h2>
            <p className="text-white/70 text-sm font-mono tracking-wider">#{order.id.slice(-8).toUpperCase()}</p>
            <p className="text-white/50 text-xs">{tableName} · {order.customerName}</p>
          </motion.div>

          {/* ── Live status tracker ── */}
          <div className="bg-white rounded-3xl p-6 space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Order Status</p>
            <div className="flex items-start">
              {STATUS_STEPS.map((step, idx) => {
                const done = idx <= currentStepIdx;
                const active = idx === currentStepIdx;
                return (
                  <React.Fragment key={step.key}>
                    <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                      <div className={cn(
                        "w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm transition-all",
                        done ? "bg-[#cc5a16] text-white shadow-md" : "bg-[#faf7f2] text-[#c5b9b2]"
                      )}>
                        {done ? <Check size={15} /> : <span className="text-xs">{idx + 1}</span>}
                      </div>
                      <span className={cn(
                        "text-[11px] font-bold uppercase tracking-wide text-center w-[54px] leading-tight",
                        active ? "text-[#1a1208]" : done ? "text-[#6b5d52]" : "text-[#c5b9b2]"
                      )}>
                        {step.label}
                      </span>
                    </div>
                    {idx < STATUS_STEPS.length - 1 && (
                      <div className={cn(
                        "flex-1 h-0.5 mt-[18px] mx-1",
                        idx < currentStepIdx ? "bg-[#cc5a16]" : "bg-[#faf7f2]"
                      )} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            {order.eta && (
              <p className="text-xs text-[#6b5d52] text-center bg-[#faf7f2] rounded-2xl py-2 px-4">
                ⏱ Estimated: <span className="font-bold text-[#1a1208]">{order.eta} mins</span>
              </p>
            )}
          </div>

          {/* ── Invoice (always visible) ── */}
          <div className="bg-white rounded-3xl p-6 space-y-4">
            {/* Restaurant header */}
            <div className="text-center pb-4 border-b border-dashed border-[#cc5a16]/10">
              <Utensils className="w-8 h-8 mx-auto mb-2 text-[#1a1208]" />
              <h3 className="text-xl font-bold font-serif">{restaurant?.name || 'Restaurant'}</h3>
              {restaurant?.is_gst_enabled && restaurant?.gst_number && restaurant.gst_number !== '0' && (
                <p className="text-[11px] text-[#6b5d52] mt-1 uppercase tracking-widest">GSTIN: {restaurant.gst_number}</p>
              )}
            </div>

            {/* Order meta */}
            <div className="flex justify-between text-[11px] text-[#9c8e85] uppercase tracking-widest font-bold">
              <span>#{order.id.slice(-8).toUpperCase()}</span>
              <span>{new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
            </div>

            {/* Items */}
            <div className="space-y-2">
              {(Array.isArray(order.items) ? order.items : []).map((item: any, idx: number) => (
                <div key={idx} className="flex justify-between text-sm">
                  <span className="text-[#0d0a07]/80">{item.quantity}× {item.name}{item.size ? ` (${item.size})` : ''}</span>
                  <span className="font-mono font-bold text-[#1a1208]">₹{((item.price ?? 0) * (item.quantity ?? 1)).toFixed(2)}</span>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="border-t border-dashed border-[#cc5a16]/10 pt-4 space-y-1.5">
              <div className="flex justify-between text-sm text-[#6b5d52]">
                <span>Subtotal</span>
                <span className="font-mono">₹{(order.totalAmount ?? 0).toFixed(2)}</span>
              </div>
              {order.gstAmount ? (
                <div className="flex justify-between text-sm text-[#6b5d52]">
                  <span>GST ({restaurant?.gst_percentage ?? 0}%)</span>
                  <span className="font-mono">₹{(order.gstAmount).toFixed(2)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-lg font-bold font-serif pt-2 border-t border-[#cc5a16]/10">
                <span>Total</span>
                <span className="font-mono">₹{orderTotal.toFixed(2)}</span>
              </div>
            </div>

            <p className="text-[11px] text-[#9c8e85] text-center uppercase tracking-widest font-bold pt-1">
              Thank you for dining with us!
            </p>
          </div>

          {/* ── Action buttons ── */}
          <div className="space-y-3">
            <button
              onClick={printThermalInvoice}
              className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-[#a84612] transition-all active:scale-[0.98]"
            >
              <Receipt size={18} /> Print Receipt
            </button>

            {(restaurant?.upi_id || restaurant?.upi_qr_image) && (
              <button
                onClick={() => setShowUPIModal(true)}
                className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-[#cc5a16] hover:text-white transition-all"
              >
                <CreditCard size={18} /> Pay via UPI
              </button>
            )}
          </div>

          <div className="text-center pb-8">
            <button
              onClick={() => { setOrder(null); setFeedbackSubmitted(false); }}
              className="text-[#6b5d52] underline text-sm hover:text-[#1a1208] transition-colors"
            >
              Place another order
            </button>
          </div>
        </div>

        {/* ── UPI Payment Modal ── */}
        <AnimatePresence>
          {showUPIModal && restaurant && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start sm:items-center justify-center z-[110] p-4 overflow-y-auto">
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white rounded-[32px] p-5 sm:p-8 w-full max-w-md shadow-2xl text-center space-y-6 max-h-[90vh] overflow-y-auto my-auto"
              >
                <div className="flex justify-between items-center">
                  <h3 className="text-2xl font-bold font-serif">UPI Payment</h3>
                  <button onClick={() => setShowUPIModal(false)} className="text-[#6b5d52] hover:text-[#1a1208]"><X /></button>
                </div>

                <div className="space-y-2">
                  <p className="text-sm text-[#6b5d52] uppercase tracking-widest font-bold">Order Total</p>
                  <p className="text-4xl font-bold font-mono text-[#1a1a1a]">₹{orderTotal.toFixed(2)}</p>
                </div>

                {restaurant.upi_id ? (
                  <div className="space-y-6">
                    <div className="flex p-1 bg-[#faf7f2] rounded-2xl">
                      <button onClick={() => setUpiQrType('DYNAMIC')} className={cn("flex-1 py-2 text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all", upiQrType === 'DYNAMIC' ? "bg-white text-[#1a1208] shadow-sm" : "text-[#9c8e85]")}>Auto Amount</button>
                      <button onClick={() => setUpiQrType('BASIC')} className={cn("flex-1 py-2 text-[11px] font-bold uppercase tracking-widest rounded-xl transition-all", upiQrType === 'BASIC' ? "bg-white text-[#1a1208] shadow-sm" : "text-[#9c8e85]")}>Basic QR</button>
                    </div>
                    <div className="bg-[#faf7f2] p-6 rounded-[32px] inline-block shadow-inner border border-[#cc5a16]/10">
                      <QRCodeCanvas
                        value={upiQrType === 'DYNAMIC'
                          ? `upi://pay?pa=${restaurant.upi_id}&pn=${encodeURIComponent(restaurant.name)}&am=${orderTotal.toFixed(2)}&cu=INR&tn=${order.id}&tr=${order.id}`
                          : `upi://pay?pa=${restaurant.upi_id}&pn=${encodeURIComponent(restaurant.name)}`}
                        size={200} level="H" includeMargin={true}
                      />
                    </div>
                    <div className="space-y-4">
                      <p className="text-xs text-[#6b5d52]">{upiQrType === 'DYNAMIC' ? "Scan to pay exact amount automatically" : "Scan to pay. Enter the amount manually."}</p>
                      <div className="grid gap-3">
                        <a href={`upi://pay?pa=${restaurant.upi_id}&pn=${encodeURIComponent(restaurant.name)}&am=${orderTotal.toFixed(2)}&cu=INR&tn=${order.id}&tr=${order.id}`}
                          className="flex items-center justify-center gap-2 w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all">
                          <Smartphone size={18} /> Open UPI App
                        </a>
                        <button onClick={() => { navigator.clipboard.writeText(restaurant.upi_id || ''); setUpiCopied(true); setTimeout(() => setUpiCopied(false), 2000); }}
                          className="flex items-center justify-center gap-2 w-full border-2 border-[#cc5a16]/10 text-[#1a1208] py-4 rounded-2xl font-bold hover:bg-[#faf7f2] transition-all">
                          {upiCopied ? <Check size={18} className="text-green-600" /> : <Copy size={18} />}
                          {upiCopied ? "UPI ID Copied!" : "Copy UPI ID"}
                        </button>
                        <div className="p-5 bg-blue-50 rounded-3xl text-left border border-blue-100">
                          <div className="flex items-center gap-2 text-blue-600 mb-2"><Info size={16} /><p className="text-[11px] font-bold uppercase tracking-widest">Payment Help</p></div>
                          <p className="text-[11px] text-blue-800 leading-relaxed">If you see <strong>"Bank Limit Exceeded"</strong>, switch to <strong>"Basic QR"</strong> above or copy the UPI ID and pay manually.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : restaurant.upi_qr_image ? (
                  <div className="space-y-4">
                    <img src={restaurant.upi_qr_image} alt="UPI QR" className="w-full max-w-[200px] mx-auto rounded-2xl shadow-md" referrerPolicy="no-referrer" />
                    <p className="text-xs text-[#6b5d52]">Scan this QR to make payment</p>
                  </div>
                ) : (
                  <div className="p-8 bg-yellow-50 text-yellow-700 rounded-2xl text-sm italic">UPI payment details are not set. Please pay at the counter.</div>
                )}

                <div className="pt-4 border-t border-[#cc5a16]/10">
                  <button
                    onClick={() => { setShowUPIModal(false); alert("Payment confirmation sent to restaurant. Please wait for verification."); }}
                    className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-4 rounded-2xl font-bold hover:bg-[#cc5a16] hover:text-white transition-all"
                  >
                    I have paid
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  const checkoutMode = restaurant?.checkout_mode || 'postpaid';
  const sessionRunningTotal = (session?.orders || []).reduce((s, o) => s + (o.totalAmount || 0), 0);
  const sessionGstTotal     = (session?.orders || []).reduce((s, o) => s + (o.gstAmount   || 0), 0);
  // bill_amount from server already includes GST; fall back to computed sum
  const sessionFinalAmount  = session?.bill_amount || (sessionRunningTotal + sessionGstTotal);

  const printThermalSessionBill = () => {
    if (!session) return;
    const dt = new Date(session.opened_at);
    const rounds = (session.orders || []).map((o: any, idx: number) => ({
      label: (session.orders || []).length > 1 ? `-- Round ${idx + 1} --` : undefined,
      items: (Array.isArray(o.items) ? o.items : []).map((it: any) => ({
        name:  it.name,
        qty:   it.quantity ?? 1,
        price: it.price   ?? 0,
      })),
    }));
    const html = buildThermalHTML({
      restaurantName: restaurant?.name || 'Restaurant',
      gstin:          restaurant?.gst_number,
      gstEnabled:     restaurant?.is_gst_enabled,
      gstPercent:     restaurant?.gst_percentage ?? 0,
      billId:         (session.id || '').slice(-8).toUpperCase(),
      tableName:      session.table_name || tableName || undefined,
      customerName:   session.customer_name || undefined,
      customerPhone:  session.customer_phone || undefined,
      date:           dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      time:           dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      rounds,
      subtotal:      sessionRunningTotal,
      gstAmount:     sessionGstTotal,
      total:         sessionFinalAmount,
      paymentMethod: session.payment_method || undefined,
    });
    openThermalPrint(html);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 pb-32">
      {/* Bill-requested locked banner */}
      {session?.status === 'bill_requested' && checkoutMode === 'postpaid' && (
        <motion.div
          initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
          className="bg-orange-50 border border-orange-200 rounded-2xl px-5 py-4 flex items-start gap-3"
        >
          <span className="text-2xl shrink-0">⏳</span>
          <div className="flex-1">
            <p className="font-bold text-orange-800 text-sm">Your bill has been requested</p>
            <p className="text-orange-600/80 text-xs mt-0.5">New items cannot be added to this session. Staff will collect payment shortly.</p>
          </div>
        </motion.div>
      )}

      {/* Tab navigation: Menu / My Orders (postpaid) / Reserve */}
      <div className="flex p-1 bg-white rounded-2xl border border-[#cc5a16]/10 shadow-sm">
        <button
          onClick={() => { setCustomerView('MENU'); setActiveCustomerTab('MENU'); }}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all",
            customerView === 'MENU' && activeCustomerTab === 'MENU' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#6b5d52] hover:text-[#1a1208]"
          )}
        >
          <Utensils size={16} /> Menu
        </button>
        {checkoutMode === 'postpaid' && session && (
          <button
            onClick={() => { setCustomerView('MENU'); setActiveCustomerTab('MY_ORDERS'); }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all relative",
              activeCustomerTab === 'MY_ORDERS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#6b5d52] hover:text-[#1a1208]"
            )}
          >
            <ShoppingCart size={16} /> My Orders
            {(session.orders?.length || 0) > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
                {session.orders?.length}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => setCustomerView('RESERVATIONS')}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all",
            customerView === 'RESERVATIONS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#6b5d52] hover:text-[#1a1208]"
          )}
        >
          <CalendarCheck size={16} /> Reserve
        </button>
      </div>

      {customerView === 'RESERVATIONS' ? (
        <CustomerReservationView restaurantId={restaurantId} onBack={() => setCustomerView('MENU')} />
      ) : activeCustomerTab === 'MY_ORDERS' && checkoutMode === 'postpaid' && session ? (
        /* ── POSTPAID: My Orders / Session View ──────────────────────────── */
        <div className="space-y-6">

          {showSessionBill ? (
            /* ═══════════════════════════════════════════════════════════════
               BILL / INVOICE VIEW  –  shown after Request Bill is confirmed
               ═══════════════════════════════════════════════════════════════ */
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-5"
            >
              {/* Bill ready banner */}
              <div className="bg-[#cc5a16] text-white rounded-[32px] p-6 text-center space-y-2">
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220 }}>
                  <CheckCircle2 size={44} className="mx-auto" />
                </motion.div>
                <h2 className="text-2xl font-bold font-serif">Your Bill is Ready</h2>
                <p className="text-white/60 text-sm">{session.table_name || tableName} · {session.customer_name}</p>
              </div>

              {/* Full invoice card */}
              <div className="bg-white rounded-3xl p-6 space-y-4 border border-[#cc5a16]/10 shadow-sm">
                {/* Restaurant header */}
                <div className="text-center pb-4 border-b border-dashed border-[#cc5a16]/10">
                  <Utensils className="w-7 h-7 mx-auto mb-2 text-[#1a1208]" />
                  <h3 className="text-xl font-bold font-serif">{restaurant?.name || 'Restaurant'}</h3>
                  {restaurant?.is_gst_enabled && restaurant?.gst_number && restaurant.gst_number !== '0' && (
                    <p className="text-[11px] text-[#9c8e85] mt-1 uppercase tracking-widest">GSTIN: {restaurant.gst_number}</p>
                  )}
                  <p className="text-[11px] text-[#9c8e85] mt-1 uppercase tracking-widest">
                    {safeFmt(session.opened_at, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>

                {/* All rounds + items */}
                <div className="space-y-4">
                  {(session.orders || []).map((o, idx) => (
                    <div key={o.id}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Round {idx + 1}</span>
                        <span className="text-xs font-mono text-[#6b5d52]">₹{(o.totalAmount || 0).toFixed(2)}</span>
                      </div>
                      <div className="space-y-1">
                        {(Array.isArray(o.items) ? o.items : []).map((item: any, i: number) => (
                          <div key={i} className="flex justify-between text-sm">
                            <span className="text-[#3d3128]">{item.quantity}× {item.name}{item.size ? ` (${item.size})` : ''}</span>
                            <span className="font-mono text-[#3d3128]">₹{((item.price || 0) * (item.quantity || 1)).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="border-t border-dashed border-[#cc5a16]/10 pt-4 space-y-1.5">
                  <div className="flex justify-between text-sm text-[#6b5d52]">
                    <span>Subtotal</span>
                    <span className="font-mono">₹{sessionRunningTotal.toFixed(2)}</span>
                  </div>
                  {sessionGstTotal > 0 && (
                    <div className="flex justify-between text-sm text-[#6b5d52]">
                      <span>GST ({restaurant?.gst_percentage ?? 0}%)</span>
                      <span className="font-mono">₹{sessionGstTotal.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xl font-bold font-serif pt-2 border-t border-[#cc5a16]/10">
                    <span>Total</span>
                    <span className="font-mono text-[#1a1208]">₹{sessionFinalAmount.toFixed(2)}</span>
                  </div>
                </div>

                <p className="text-[11px] text-[#c5b9b2] text-center uppercase tracking-widest font-bold pt-1">
                  Thank you for dining with us!
                </p>
              </div>

              {/* Payment action buttons */}
              <div className="space-y-3">
                {/* Pay Online */}
                {(restaurant?.upi_id || restaurant?.upi_qr_image) && (
                  <button
                    onClick={openSessionUpiPayment}
                    className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#a84612] transition-all shadow-lg"
                  >
                    <CreditCard size={20} /> Pay Online — UPI / QR
                  </button>
                )}

                {/* Pay at Table */}
                {sessionBillPayMethod === 'TABLE' || !restaurant?.upi_id ? (
                  <div className="bg-amber-50 border-2 border-amber-200 rounded-3xl p-5 text-center space-y-1">
                    <Utensils size={22} className="mx-auto text-amber-600" />
                    <p className="font-bold text-amber-800">Pay at the Table</p>
                    <p className="text-sm text-amber-700">Our staff has been notified and will collect your payment shortly.</p>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setSessionBillPayMethod('TABLE');
                      // Notify staff via re-request (idempotent — server checks status)
                    }}
                    className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#cc5a16] hover:text-white transition-all"
                  >
                    <Utensils size={20} /> Pay at Table (Cash / Card)
                  </button>
                )}

                {/* Print thermal receipt */}
                <button
                  onClick={printThermalSessionBill}
                  className="w-full border border-[#cc5a16]/20 text-[#3d3128] py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-[#faf7f2] transition-all text-sm"
                >
                  <Receipt size={16} /> Print Receipt
                </button>
              </div>
            </motion.div>

          ) : (
            /* ═══════════════════════════════════════════════════════════════
               ORDERS VIEW  –  active session, still ordering
               ═══════════════════════════════════════════════════════════════ */
            <>
              {/* Session header */}
              <div className="bg-[#cc5a16] text-white rounded-[32px] p-6 space-y-1">
                <p className="text-[11px] font-bold uppercase tracking-widest text-white/50">Current Session</p>
                <h2 className="text-2xl font-bold font-serif">{session.table_name || tableName}</h2>
                <p className="text-white/60 text-sm">
                  Opened {safeFmt(session.opened_at, { hour: '2-digit', minute: '2-digit' }, 'time')}
                  {session.customer_name && ` · ${session.customer_name}`}
                </p>
              </div>

              {/* Running total */}
              <div className="bg-white rounded-3xl p-6 flex justify-between items-center border border-[#cc5a16]/10 shadow-sm">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Running Total</p>
                  <p className="text-3xl font-bold font-mono mt-1">₹{sessionRunningTotal.toFixed(2)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Rounds</p>
                  <p className="text-3xl font-bold mt-1">{session.orders?.length || 0}</p>
                </div>
              </div>

              {/* Orders by round */}
              {(session.orders || []).length === 0 ? (
                <div className="text-center py-12 text-[#9c8e85]">
                  <ShoppingCart size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="font-serif italic">No orders yet. Go to the menu to add items.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {(session.orders || []).map((o, idx) => {
                    const eta = (o as any).eta || '';
                    const chefName = (o as any).chef_name || '';
                    // status badge config
                    const sMap: Record<string, { color: string; bg: string; icon: string; label: string }> = {
                      CONFIRMED:  { color: '#b45309', bg: '#fef3c7', icon: '⏳', label: 'Queued' },
                      PENDING:    { color: '#b45309', bg: '#fef3c7', icon: '⏳', label: 'Pending' },
                      PREPARING:  { color: '#c2410c', bg: '#ffedd5', icon: '🍳', label: eta ? `Preparing · Est. ${eta}` : 'Preparing' },
                      READY:      { color: '#166534', bg: '#dcfce7', icon: '✅', label: 'Ready — Staff will serve shortly!' },
                      DELIVERED:  { color: '#374151', bg: '#f3f4f6', icon: '✔',  label: 'Delivered' },
                    };
                    const sc = sMap[o.status] || sMap.CONFIRMED;
                    // accent bar colour per status
                    const accentColor = o.status === 'READY' ? '#5c7a5a' : o.status === 'PREPARING' ? '#cc5a16' : o.status === 'DELIVERED' ? '#9ca3af' : '#f59e0b';

                    return (
                      <div key={o.id} className="bg-white rounded-3xl overflow-hidden border border-[#cc5a16]/10 shadow-sm">
                        {/* status accent bar */}
                        <div className="h-1 w-full" style={{ background: accentColor }} />
                        <div className="p-5">
                          {/* Round header row */}
                          <div className="flex justify-between items-start mb-3 gap-2 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Round {idx + 1}</span>
                              <span
                                className="text-[11px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
                                style={{ background: sc.bg, color: sc.color }}
                              >
                                {sc.icon} {sc.label}
                              </span>
                            </div>
                            <span className="font-mono font-bold text-sm">₹{(o.totalAmount || 0).toFixed(2)}</span>
                          </div>
                          {/* Chef info (if assigned) */}
                          {chefName && o.status !== 'DELIVERED' && (
                            <p className="text-[11px] text-[#cc5a16] font-semibold mb-2">👨‍🍳 Being prepared by {chefName}</p>
                          )}
                          <div className="space-y-1.5">
                            {(Array.isArray(o.items) ? o.items : []).map((item: any, i: number) => (
                              <div key={i} className="flex justify-between text-sm">
                                <span className="text-[#3d3128]">{item.quantity}× {item.name}{item.size ? ` (${item.size})` : ''}</span>
                                <span className="font-mono text-[#3d3128]">₹{((item.price || 0) * (item.quantity || 1)).toFixed(2)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Request Bill CTA */}
              {session.status === 'open' && (session.orders?.length || 0) > 0 && (
                <div className="space-y-1.5">
                  <button
                    onClick={() => setShowBillRequestModal(true)}
                    className="w-full bg-[#1a1a1a] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:scale-[1.01] transition-transform shadow-xl"
                  >
                    <IndianRupee size={20} /> Request Bill — ₹{(sessionRunningTotal + sessionGstTotal).toFixed(2)}
                  </button>
                  {sessionGstTotal > 0 && (
                    <p className="text-center text-xs text-[#9c8e85]">
                      Subtotal ₹{sessionRunningTotal.toFixed(2)} + GST ({restaurant?.gst_percentage ?? 0}%) ₹{sessionGstTotal.toFixed(2)}
                    </p>
                  )}
                </div>
              )}

              {/* ── Call Waiter CTA ── */}
              {session && (
                <button
                  onClick={callWaiter}
                  disabled={waiterCallStatus !== 'idle'}
                  className={cn(
                    "w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2.5 transition-all border-2",
                    waiterCallStatus === 'idle'
                      ? "border-[#0d0a07]/15 text-[#3d3128] hover:border-[#0d0a07]/35 hover:bg-[#0d0a07]/5"
                      : waiterCallStatus === 'sending'
                        ? "border-amber-300 text-amber-600 bg-amber-50"
                        : waiterCallStatus === 'sent'
                          ? "border-[#5c7a5a]/40 text-[#5c7a5a] bg-[#5c7a5a]/8"
                          : waiterCallStatus === 'acknowledged'
                            ? "border-[#5c7a5a]/60 text-[#5c7a5a] bg-[#5c7a5a]/12"
                            : "border-gray-200 text-gray-400 bg-gray-50"
                  )}
                >
                  <Bell size={17} className={cn(
                    waiterCallStatus === 'sending' && "animate-bounce",
                    waiterCallStatus === 'sent' || waiterCallStatus === 'acknowledged' ? "text-[#5c7a5a]" : ""
                  )} />
                  {waiterCallStatus === 'idle'         && 'Call Waiter'}
                  {waiterCallStatus === 'sending'      && 'Calling…'}
                  {waiterCallStatus === 'sent'         && '🔔 Waiter Notified!'}
                  {waiterCallStatus === 'acknowledged' && '👋 Waiter is on the way!'}
                  {waiterCallStatus === 'cooldown'     && `Please wait ${waiterCallCooldown}s`}
                </button>
              )}

              {/* Add More Items CTA */}
              {session.status === 'open' && (
                <button
                  onClick={() => setActiveCustomerTab('MENU')}
                  className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-[#cc5a16] hover:text-white transition-all"
                >
                  <Plus size={18} /> Add More Items
                </button>
              )}
            </>
          )}
        </div>
      ) : (<>
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-4xl font-bold font-serif mb-2">{restaurant?.name || 'Our Menu'}</h2>
          <p className="text-[#6b5d52] italic">{tableName} • Fresh & Seasonal</p>
        </div>
        <div className="bg-white p-2 rounded-2xl shadow-sm border border-[#cc5a16]/10">
          <QRCodeSVG value={`${window.location.origin}?r=${restaurantId}`} size={60} />
        </div>
      </div>

      <div className="space-y-4">
        <div className="relative">
          <input 
            type="text"
            placeholder="Search for dishes..."
            className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#cc5a16]/20 outline-none shadow-sm"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" size={20} />
        </div>
        
        <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
          {['All', ...Array.from(new Set(menu.map(m => m.category).filter(Boolean))).sort()].map(cat => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={cn(
                "px-6 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-all",
                filterCategory === cat ? "bg-[#cc5a16] text-white shadow-md" : "bg-white text-[#1a1208] border border-[#cc5a16]/10"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex gap-4">
          <select 
            className="bg-white border border-[#cc5a16]/10 rounded-xl px-4 py-2 text-xs font-bold text-[#1a1208] outline-none"
            value={filterDietary}
            onChange={e => setFilterDietary(e.target.value)}
          >
            <option value="All">All Dietary</option>
            <option value="VEG">Veg</option>
            <option value="VEGAN">Vegan</option>
            <option value="NON_VEG">Non-Veg</option>
          </select>
          <select 
            className="bg-white border border-[#cc5a16]/10 rounded-xl px-4 py-2 text-xs font-bold text-[#1a1208] outline-none"
            value={filterSize}
            onChange={e => setFilterSize(e.target.value)}
          >
            <option value="All">All Sizes</option>
            <option value="HALF">Half Available</option>
            <option value="FULL">Full Only</option>
          </select>
        </div>
      </div>

      <div className="relative">
        {restaurant?.watermark_image && (
          <div 
            className="fixed inset-0 pointer-events-none opacity-[0.03] z-0"
            style={{ 
              backgroundImage: `url(${restaurant.watermark_image})`,
              backgroundSize: '400px',
              backgroundRepeat: 'repeat'
            }}
          />
        )}
        <TemplateRenderer />
      </div>

      {/* Floating Cart Button */}
      {cart.length > 0 && (
        <motion.div 
          initial={{ y: 100 }}
          animate={{ y: 0 }}
          className="fixed bottom-8 left-1/2 -translate-x-1/2 w-full max-w-md px-6 z-50"
        >
          <button 
            onClick={() => setIsCheckingOut(true)}
            className="w-full bg-[#1a1a1a] text-white p-6 rounded-[32px] shadow-2xl flex justify-between items-center hover:scale-[1.02] transition-transform"
          >
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center">
                <ShoppingCart size={20} />
              </div>
              <div className="text-left">
                <p className="text-xs text-white/50 font-bold uppercase tracking-widest">{cart.length} Items</p>
                <p className="text-lg font-bold">View Cart</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-white/50 font-bold uppercase tracking-widest">Total</p>
              <p className="text-xl font-bold font-mono">₹{cartTotal.toFixed(2)}</p>
            </div>
          </button>
        </motion.div>
      )}

      {/* ── Call Waiter FAB — visible on MENU tab ── */}
      <AnimatePresence>
        {activeCustomerTab === 'MENU' && customerView !== 'RESERVATIONS' && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            className={cn(
              "fixed right-4 z-[51] transition-all duration-300",
              cart.length > 0 ? "bottom-28" : "bottom-8"
            )}
          >
            <button
              onClick={callWaiter}
              disabled={waiterCallStatus !== 'idle'}
              title={
                waiterCallStatus === 'idle'         ? 'Call Waiter' :
                waiterCallStatus === 'sending'      ? 'Calling...' :
                waiterCallStatus === 'sent'         ? 'Waiter Notified!' :
                waiterCallStatus === 'acknowledged' ? 'Waiter is on the way!' :
                `Wait ${waiterCallCooldown}s`
              }
              className={cn(
                "flex items-center gap-2 px-4 py-3 rounded-2xl shadow-xl font-bold text-sm transition-all active:scale-95 border-2",
                waiterCallStatus === 'idle'
                  ? "bg-white text-[#1a1208] border-[#0d0a07]/10 hover:border-[#cc5a16]/40 hover:shadow-2xl"
                  : waiterCallStatus === 'sending'
                    ? "bg-amber-50 text-amber-600 border-amber-300"
                    : waiterCallStatus === 'sent'
                      ? "bg-[#5c7a5a]/10 text-[#5c7a5a] border-[#5c7a5a]/30"
                      : waiterCallStatus === 'acknowledged'
                        ? "bg-[#5c7a5a]/15 text-[#5c7a5a] border-[#5c7a5a]/40"
                        : "bg-gray-50 text-gray-400 border-gray-200"
              )}
            >
              <Bell
                size={16}
                className={cn(
                  waiterCallStatus === 'sending' && "animate-bounce",
                )}
              />
              <span>
                {waiterCallStatus === 'idle'         && 'Call Waiter'}
                {waiterCallStatus === 'sending'      && 'Calling…'}
                {waiterCallStatus === 'sent'         && 'Notified!'}
                {waiterCallStatus === 'acknowledged' && 'On the way!'}
                {waiterCallStatus === 'cooldown'     && `${waiterCallCooldown}s`}
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Checkout Modal */}
      <AnimatePresence>
        {isCheckingOut && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end md:items-center justify-center z-[100] p-4">
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="bg-white rounded-t-[40px] md:rounded-[32px] p-8 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-3xl font-bold font-serif">Your Order</h3>
                <button onClick={() => setIsCheckingOut(false)} className="text-[#6b5d52] hover:text-[#1a1208]">
                  <X />
                </button>
              </div>

              {/* Customer identity — show a read-only chip when the session already
                  has the customer's name (re-scan / second+ order round). Only
                  show the full form for the very first order of a new session. */}
              {checkoutMode === 'postpaid' && session?.customer_name ? (
                <div className="flex items-center gap-3 bg-[#faf7f2] rounded-2xl px-4 py-3 mb-8">
                  <div className="w-9 h-9 rounded-full bg-[#cc5a16] text-white flex items-center justify-center font-bold text-sm shrink-0">
                    {session.customer_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Ordering as</p>
                    <p className="font-bold text-[#1a1208] truncate">{session.customer_name}{session.customer_phone ? ` · ${session.customer_phone}` : ''}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 mb-8">
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Your Name</label>
                      <input
                        required
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                        placeholder="John Doe"
                        value={customerInfo.name}
                        onChange={e => setCustomerInfo({ ...customerInfo, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Phone Number (for WhatsApp)</label>
                      <input
                        required
                        type="tel"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                        placeholder="+1 234 567 890"
                        value={customerInfo.phone}
                        onChange={e => setCustomerInfo({ ...customerInfo, phone: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mb-1 block">Email Address (Optional)</label>
                      <input
                        type="email"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                        placeholder="john@example.com"
                        value={customerInfo.email}
                        onChange={e => setCustomerInfo({ ...customerInfo, email: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-4 mb-8">
                {cart.map(item => (
                  <div key={item.id} className="flex justify-between items-center bg-[#faf7f2]/50 p-3 rounded-2xl">
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center gap-1 bg-white p-1 rounded-xl shadow-sm">
                        <button 
                          onClick={() => updateCartQuantity(item.id, 1)}
                          className="p-1 hover:bg-[#faf7f2] rounded-lg transition-colors text-[#1a1208]"
                        >
                          <Plus size={14} />
                        </button>
                        <span className="font-bold text-sm min-w-[20px] text-center">{item.quantity}</span>
                        <button 
                          onClick={() => updateCartQuantity(item.id, -1)}
                          disabled={item.quantity <= 1}
                          className="p-1 hover:bg-[#faf7f2] rounded-lg transition-colors text-[#1a1208] disabled:opacity-30"
                        >
                          <Minus size={14} />
                        </button>
                      </div>
                      <div>
                        <p className="font-bold text-sm">{item.name}</p>
                        <p className="text-[11px] text-[#6b5d52] font-mono">₹{item.price.toFixed(2)} each</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-mono font-bold text-sm">₹{(item.price * item.quantity).toFixed(2)}</p>
                      <button 
                        onClick={() => removeFromCart(item.id)} 
                        className="p-2 hover:bg-red-50 text-red-400 rounded-xl transition-colors"
                        title="Remove item"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-[#cc5a16]/10 pt-6 space-y-4 mb-8">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-[#6b5d52]">Subtotal</span>
                    <span className="font-mono">₹{cartTotal.toFixed(2)}</span>
                  </div>
                  {restaurant?.is_gst_enabled && restaurant?.gst_percentage ? (
                    <div className="flex justify-between text-sm">
                      <span className="text-[#6b5d52]">GST ({restaurant.gst_percentage}%)</span>
                      <span className="font-mono">₹{(cartTotal * (restaurant.gst_percentage / 100)).toFixed(2)}</span>
                    </div>
                  ) : null}
                </div>
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span className="font-mono">
                    ₹{(cartTotal * (1 + (restaurant?.is_gst_enabled ? (restaurant?.gst_percentage || 0) / 100 : 0))).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* ── Order error message ── */}
              {placeOrderError && (
                <p className="text-red-500 text-sm text-center bg-red-50 rounded-xl px-4 py-2">{placeOrderError}</p>
              )}

              {/* ── Mode-aware action buttons ── */}
              <div className="space-y-3">
                {checkoutMode === 'postpaid' ? (
                  <button
                    onClick={() => placeOrder('TABLE')}
                    disabled={isPlacingOrder}
                    className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#a84612] transition-all disabled:opacity-60"
                  >
                    {isPlacingOrder ? <RefreshCw size={20} className="animate-spin" /> : <IndianRupee size={20} />}
                    {isPlacingOrder ? 'Placing Order…' : 'Add to Bill'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => placeOrder('ONLINE')}
                      disabled={isPlacingOrder}
                      className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#a84612] transition-all disabled:opacity-60"
                    >
                      {isPlacingOrder ? <RefreshCw size={20} className="animate-spin" /> : <CreditCard size={20} />}
                      {isPlacingOrder ? 'Placing Order…' : 'Pay Online Now'}
                    </button>
                    <button
                      onClick={() => placeOrder('TABLE')}
                      disabled={isPlacingOrder}
                      className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#cc5a16] hover:text-white transition-all disabled:opacity-60"
                    >
                      <Utensils size={20} /> Pay at Table
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      </>)}

      {/* ── Bill Request Modal (Postpaid) ── */}
      {/* NOTE: Must be OUTSIDE the activeCustomerTab ternary so it renders
          even when the MY_ORDERS tab is active (where the button lives). */}
      <AnimatePresence>
        {showBillRequestModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center z-[120] p-4">
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="bg-white rounded-t-[40px] md:rounded-[32px] p-8 w-full max-w-md shadow-2xl"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold font-serif">Request Bill</h3>
                <button onClick={() => setShowBillRequestModal(false)} className="text-[#6b5d52] hover:text-[#1a1208]"><X /></button>
              </div>
              <div className="bg-[#faf7f2] rounded-2xl p-5 mb-6 text-center">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Session Total</p>
                <p className="text-4xl font-bold font-mono">₹{(sessionRunningTotal + sessionGstTotal).toFixed(2)}</p>
                <p className="text-xs text-[#6b5d52] mt-1">{session?.orders?.length || 0} round{(session?.orders?.length || 0) !== 1 ? 's' : ''} of orders</p>
                {sessionGstTotal > 0 && (
                  <p className="text-xs text-[#9c8e85] mt-1">Incl. GST ({restaurant?.gst_percentage ?? 0}%) ₹{sessionGstTotal.toFixed(2)}</p>
                )}
              </div>
              <p className="text-sm text-[#6b5d52] text-center mb-6">How would you like to pay?</p>
              <div className="space-y-3">
                {(restaurant?.upi_id || restaurant?.upi_qr_image) ? (
                  <button
                    onClick={() => requestBill('ONLINE')}
                    className="w-full bg-[#cc5a16] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#a84612] transition-all"
                  >
                    <CreditCard size={20} /> Pay Online (UPI)
                  </button>
                ) : (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-center">
                    UPI payments are not available at this time. Please pay at the table.
                  </p>
                )}
                <button
                  onClick={() => requestBill('TABLE')}
                  className="w-full border-2 border-[#cc5a16] text-[#1a1208] py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#cc5a16] hover:text-white transition-all"
                >
                  <Utensils size={20} /> Pay at Table (Cash / Card)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SuperAdminDashboard({ token }: { token: string }) {
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [internalUsers, setInternalUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'INACTIVE' | 'PENDING'>('PENDING');
  const [viewMode, setViewMode] = useState<'RESTAURANTS' | 'USERS' | 'LOCATIONS' | 'PERMISSIONS'>('RESTAURANTS');
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ loginId: '', name: '', email: '', phone: '', password: '', role: 'SALES_REP' as UserRole });
  const [editingOwner, setEditingOwner] = useState<{ restaurantId: string; name: string; email: string; phone: string } | null>(null);

  // Location management state
  const [adminLocations, setAdminLocations] = useState<any[]>([]);
  const [locationSearch, setLocationSearch] = useState('');
  const [newLocation, setNewLocation] = useState({ state: '', city: '', zip_code: '' });
  const [locationMsg, setLocationMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [editingZip, setEditingZip] = useState<{ id: string; zip_code: string } | null>(null);

  // Role permissions state
  const [permSelectedRestaurant, setPermSelectedRestaurant] = useState<string>('');
  const [permData, setPermData] = useState<Record<string, string[]>>({});
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [permMsg, setPermMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetchRestaurants();
    fetchInternalUsers();
  }, []);

  const fetchRestaurants = async () => {
    try {
      const res = await fetch('/api/admin/restaurants', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          setRestaurants(await res.json());
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchInternalUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setInternalUsers(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const fetchAdminLocations = async () => {
    try {
      const res = await fetch('/api/admin/locations', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setAdminLocations(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocationMsg(null);
    try {
      const res = await fetch('/api/admin/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(newLocation),
      });
      const data = await res.json();
      if (res.ok) {
        setLocationMsg({ type: 'ok', text: `Added ${newLocation.city}, ${newLocation.state} successfully.` });
        setNewLocation({ state: '', city: '', zip_code: '' });
        fetchAdminLocations();
      } else {
        setLocationMsg({ type: 'err', text: data.error || 'Failed to add location' });
      }
    } catch {
      setLocationMsg({ type: 'err', text: 'Network error' });
    }
  };

  const handleUpdateZip = async (id: string, zip_code: string) => {
    try {
      await fetch(`/api/admin/locations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ zip_code }),
      });
      setEditingZip(null);
      fetchAdminLocations();
    } catch { /* ignore */ }
  };

  const handleToggleLocationStatus = async (id: string, currentStatus: number) => {
    try {
      await fetch(`/api/admin/locations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 }),
      });
      fetchAdminLocations();
    } catch { /* ignore */ }
  };

  const handleDeleteLocation = async (id: string, label: string) => {
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/admin/locations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      fetchAdminLocations();
    } catch { /* ignore */ }
  };

  // Base restaurant-only tabs (shown for every restaurant)
  const RESTAURANT_TABS = [
    'MONITOR', 'MENU', 'REPORTS', 'QR', 'BOOKINGS',
    'STAFF', 'ORDERS', 'INVOICES', 'ATTENDANCE',
    'FEEDBACK', 'SUBSCRIPTION', 'NOTIFICATIONS', 'SETTINGS'
  ];
  // Hotel-only tabs (shown only when the selected restaurant has property_type IN ('HOTEL','BOTH'))
  const HOTEL_TABS = [
    'ROOMS', 'HOTEL_BOOKINGS', 'SERVICES', 'SERVICE_REQUESTS',
    'FOLIOS', 'COMPLIANCE', 'CONCIERGE_FAQ',
  ];
  // Compose the active tab list based on the currently-selected restaurant's property_type
  const selectedRestaurantRow = restaurants.find(r => r.id === permSelectedRestaurant);
  const selectedIsHotel = !!selectedRestaurantRow && (
    selectedRestaurantRow.property_type === 'HOTEL' ||
    selectedRestaurantRow.property_type === 'BOTH'
  );
  const ALL_TABS = selectedIsHotel ? [...RESTAURANT_TABS, ...HOTEL_TABS] : RESTAURANT_TABS;
  const PERM_ROLES = ['OWNER', 'MANAGER'];

  const fetchPermissions = async (restaurantId: string) => {
    if (!restaurantId) return;
    setPermLoading(true);
    setPermMsg(null);
    try {
      const res = await fetch(`/api/admin/restaurant/${restaurantId}/role-permissions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        // Default: all tabs allowed (empty array = full access)
        const normalized: Record<string, string[]> = {};
        for (const role of PERM_ROLES) {
          normalized[role] = data[role] && data[role].length > 0 ? data[role] : [...ALL_TABS];
        }
        setPermData(normalized);
      }
    } catch { /* ignore */ }
    finally { setPermLoading(false); }
  };

  const savePermissions = async () => {
    if (!permSelectedRestaurant) return;
    setPermSaving(true);
    setPermMsg(null);
    try {
      // Convert: if all tabs selected → save empty array (means no restriction)
      const toSave: Record<string, string[]> = {};
      for (const role of PERM_ROLES) {
        const tabs = permData[role] || [];
        toSave[role] = tabs.length === ALL_TABS.length ? [] : tabs;
      }
      const res = await fetch(`/api/admin/restaurant/${permSelectedRestaurant}/role-permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(toSave)
      });
      if (res.ok) setPermMsg({ type: 'ok', text: 'Permissions saved successfully.' });
      else setPermMsg({ type: 'err', text: 'Failed to save permissions.' });
    } catch {
      setPermMsg({ type: 'err', text: 'Network error.' });
    } finally {
      setPermSaving(false);
    }
  };

  const togglePermTab = (role: string, tab: string) => {
    setPermData(prev => {
      const current = prev[role] || [...ALL_TABS];
      if (current.includes(tab)) {
        return { ...prev, [role]: current.filter(t => t !== tab) };
      } else {
        return { ...prev, [role]: [...current, tab] };
      }
    });
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(newUser)
      });
      if (res.ok) {
        setIsAddingUser(false);
        setNewUser({ loginId: '', name: '', email: '', phone: '', password: '', role: 'SALES_REP' });
        fetchInternalUsers();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const assignSalesRep = async (restaurantId: string, salesRepId: string) => {
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/sales-rep`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ sales_rep_id: salesRepId })
      });
      if (res.ok) fetchRestaurants();
    } catch (err) {
      console.error(err);
    }
  };

  const setStatus = async (id: string, newStatus: number) => {
    await fetch(`/api/admin/restaurants/${id}/toggle-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ is_active: newStatus })
    });
    fetchRestaurants();
  };

  // Toggle the per-tenant Invoice Deletion feature flag. Calls the admin
  // PATCH endpoint and refreshes the restaurants list on success.
  const setInvoiceDeleteFlag = async (id: string, currentlyEnabled: boolean) => {
    const next = currentlyEnabled ? 0 : 1;
    if (next === 1) {
      const ok = window.confirm(
        "Enable invoice deletion for this restaurant?\n\n" +
        "The OWNER will be able to permanently delete invoices (including PRINTED).\n" +
        "Every deletion is recorded in the central audit log.\n\n" +
        "GST records: this is a regulatory-sensitive feature. Proceed only after the operator has acknowledged compliance implications."
      );
      if (!ok) return;
    }
    try {
      const res = await fetch(`/api/admin/restaurants/${id}/invoice-delete-flag`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ enabled: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Failed: ${data.error || res.status}`);
        return;
      }
      fetchRestaurants();
    } catch (err) {
      alert('Network error. Please try again.');
    }
  };

  const resetPassword = async (restaurantId: string) => {
    const newPass = prompt("Enter new password for Owner:");
    if (newPass) {
      try {
        const res = await fetch('/api/admin/reset-owner-password', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ restaurantId, newPassword: newPass })
        });
        
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          const data = await res.json();
          if (res.ok) {
            alert("Password reset successfully");
          } else {
            alert("Error: " + (data.error || "Failed to reset password"));
          }
        } else {
          if (res.ok) {
            alert("Password reset successfully");
          } else {
            alert("Error: Failed to reset password");
          }
        }
      } catch (err) {
        alert("Network error. Please try again.");
      }
    }
  };

  const updateOwnerInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingOwner) return;
    try {
      const res = await fetch(`/api/admin/owner/${editingOwner.restaurantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: editingOwner.name, email: editingOwner.email, phone: editingOwner.phone })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      setEditingOwner(null);
      fetchRestaurants();
      // If a new owner account was created (restaurant had no linked user), show credentials
      if (data.isNew) {
        alert(
          `✅ Owner account created successfully!\n\n` +
          `Login ID:  ${data.loginId}\n` +
          `Temp Password:  ${data.tempPassword}\n\n` +
          `⚠️ Please share these credentials with the owner and ask them to change the password after first login.`
        );
      }
    } catch (err: any) {
      alert(`❌ ${err.message}`);
    }
  };

  const resetInternalUserPassword = async (userId: string) => {
    const newPass = prompt("Enter new password for Internal User:");
    if (newPass) {
      try {
        const res = await fetch('/api/admin/reset-internal-user-password', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ userId, newPassword: newPass })
        });
        if (res.ok) {
          alert("Password reset successfully");
        } else {
          const data = await res.json();
          alert("Error: " + (data.error || "Failed to reset password"));
        }
      } catch (err) {
        alert("Network error. Please try again.");
      }
    }
  };

  const toggleInternalUserStatus = async (userId: string, currentStatus: number) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/toggle-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 })
      });
      if (res.ok) fetchInternalUsers();
    } catch (err) {
      console.error(err);
    }
  };

  const filteredRestaurants = restaurants.filter(r => {
    if (activeTab === 'ACTIVE') return r.is_active === 1;
    if (activeTab === 'INACTIVE') return r.is_active === 2;
    if (activeTab === 'PENDING') return r.is_active === 0;
    return false;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-12 h-12 border-4 border-[#cc5a16] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">ERP Super Admin</h2>
          <p className="text-sm text-[#6b5d52]">Manage business partners, internal users, and activations.</p>
        </div>
        <div className="flex bg-white p-1 rounded-2xl border border-[#cc5a16]/10 flex-wrap gap-1">
          <button
            onClick={() => setViewMode('RESTAURANTS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'RESTAURANTS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <Layout size={16} /> Businesses
          </button>
          <button
            onClick={() => setViewMode('USERS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'USERS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <Users size={16} /> Internal Users
          </button>
          <button
            onClick={() => { setViewMode('LOCATIONS'); fetchAdminLocations(); }}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'LOCATIONS' ? "bg-indigo-600 text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <MapPin size={16} /> Locations
          </button>
          <button
            onClick={() => setViewMode('PERMISSIONS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'PERMISSIONS' ? "bg-violet-600 text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <Shield size={16} /> Role Access
          </button>
        </div>
      </div>

      {viewMode === 'RESTAURANTS' ? (
        <>
          <div className="flex bg-white p-1 rounded-2xl border border-[#cc5a16]/10 overflow-x-auto max-w-full">
            <button 
              onClick={() => setActiveTab('PENDING')}
              className={cn(
                "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
                activeTab === 'PENDING' ? "bg-orange-500 text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
              )}
            >
              Pending Approval ({restaurants.filter(r => r.is_active === 0).length})
            </button>
            <button 
              onClick={() => setActiveTab('ACTIVE')}
              className={cn(
                "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
                activeTab === 'ACTIVE' ? "bg-green-600 text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
              )}
            >
              Active Business ({restaurants.filter(r => r.is_active === 1).length})
            </button>
            <button 
              onClick={() => setActiveTab('INACTIVE')}
              className={cn(
                "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
                activeTab === 'INACTIVE' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
              )}
            >
              Inactive Business ({restaurants.filter(r => r.is_active === 2).length})
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredRestaurants.map(r => (
              <div key={r.id} className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-6 flex flex-col">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <h3 className="text-xl font-bold font-serif">{r.name}</h3>
                    <p className="text-xs text-[#6b5d52] font-mono">{r.city}, {r.state}</p>
                  </div>
                  <div className={cn(
                    "px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest",
                    r.is_active === 1 ? "bg-green-100 text-green-700" : 
                    r.is_active === 0 ? "bg-orange-100 text-orange-700" : 
                    "bg-red-100 text-red-700"
                  )}>
                    {r.is_active === 1 ? 'Active' : r.is_active === 0 ? 'Pending' : 'Inactive'}
                  </div>
                </div>
                
                <div className="space-y-3 flex-1">
                  <div className="flex items-center gap-3 text-sm">
                    <Hash size={16} className="text-[#9c8e85] shrink-0" />
                    <span className="font-mono text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold">{r.id}</span>
                  </div>
                  {/* Slug + tenant URL (SUPER_ADMIN hand-off) */}
                  {(() => {
                    const slug = (r as any).slug;
                    if (!slug) {
                      return (
                        <div className="flex items-center gap-3 text-sm">
                          <Globe size={16} className="text-[#9c8e85] shrink-0" />
                          <span className="text-xs text-[#9c8e85] italic">No slug yet</span>
                        </div>
                      );
                    }
                    const host = window.location.hostname;
                    const isLocal = host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
                    // Figure out the apex. On localhost use localhost:5001 + ?tenant=; in prod use <slug>.atithi-setu.com
                    const parts = host.split('.');
                    const apex = parts.length >= 2 ? parts.slice(-2).join('.') : host;
                    const tenantUrl = isLocal
                      ? `${window.location.origin}/?tenant=${slug}`
                      : `https://${slug}.${apex}`;
                    return (
                      <div className="flex items-center gap-3 text-sm">
                        <Globe size={16} className="text-[#9c8e85] shrink-0" />
                        <a
                          href={tenantUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs bg-[#fef3ea] text-[#cc5a16] px-2 py-1 rounded font-bold hover:bg-[#cc5a16]/15 flex items-center gap-1.5 truncate"
                          title={tenantUrl}
                        >
                          <span className="truncate">{tenantUrl.replace(/^https?:\/\//, '')}</span>
                          <Copy
                            size={12}
                            className="shrink-0 cursor-pointer hover:text-[#a84612]"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(tenantUrl)
                                .then(() => {
                                  const el = e.currentTarget as HTMLElement;
                                  if (el && el.dataset) { el.dataset.copied = '1'; setTimeout(() => delete el.dataset.copied, 1200); }
                                })
                                .catch(() => {});
                            }}
                          />
                        </a>
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-3 text-sm">
                    <User size={16} className="text-[#9c8e85] shrink-0" />
                    <span className="font-medium">{r.owner_name || <span className="text-[#9c8e85] italic">—</span>}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Mail size={16} className="text-[#9c8e85] shrink-0" />
                    <span className="truncate text-xs">{r.owner_email || <span className="text-[#9c8e85] italic">—</span>}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Lock size={16} className="text-[#9c8e85] shrink-0" />
                    <span className="font-mono text-xs bg-[#faf7f2] px-2 py-1 rounded">{r.owner_login_id || <span className="text-[#9c8e85] italic">—</span>}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Smartphone size={16} className="text-[#9c8e85] shrink-0" />
                    <span className="text-xs">{r.owner_phone || <span className="text-[#9c8e85] italic">No mobile</span>}</span>
                  </div>

                  {editingOwner?.restaurantId === r.id ? (
                    <form onSubmit={updateOwnerInfo} className="pt-2 space-y-2">
                      <input
                        required
                        className="w-full bg-[#faf7f2] border-none rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                        placeholder="Owner name"
                        value={editingOwner.name}
                        onChange={e => setEditingOwner(prev => prev ? { ...prev, name: e.target.value } : prev)}
                      />
                      <input
                        required
                        type="email"
                        className="w-full bg-[#faf7f2] border-none rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                        placeholder="Owner email"
                        value={editingOwner.email}
                        onChange={e => setEditingOwner(prev => prev ? { ...prev, email: e.target.value } : prev)}
                      />
                      <input
                        type="tel"
                        className="w-full bg-[#faf7f2] border-none rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                        placeholder="Mobile number (optional)"
                        value={editingOwner.phone}
                        onChange={e => setEditingOwner(prev => prev ? { ...prev, phone: e.target.value } : prev)}
                      />
                      <div className="flex gap-2">
                        <button type="submit" className="flex-1 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest bg-[#cc5a16] text-white hover:bg-[#a84612] transition-all">Save</button>
                        <button type="button" onClick={() => setEditingOwner(null)} className="flex-1 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest border border-[#cc5a16]/10 text-[#1a1208] hover:bg-[#cc5a16]/5 transition-all">Cancel</button>
                      </div>
                    </form>
                  ) : null}

                  <div className="pt-2">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1">Sales Representative</p>
                    <select
                      value={r.sales_rep_id || ''}
                      onChange={(e) => assignSalesRep(r.id, e.target.value)}
                      className="w-full bg-[#faf7f2] border border-[#cc5a16]/10 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                    >
                      <option value="">Unassigned</option>
                      {internalUsers.filter(u => u.role === 'SALES_REP').map(u => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="pt-6 border-t border-[#cc5a16]/10 flex flex-col gap-3">
                  {r.is_active === 0 && (
                    <button
                      onClick={() => setStatus(r.id, 1)}
                      className="w-full py-4 rounded-xl font-bold text-xs uppercase tracking-widest bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-600/20 transition-all"
                    >
                      Approve & Activate
                    </button>
                  )}
                  {r.is_active === 1 && (
                    <button
                      onClick={() => setStatus(r.id, 2)}
                      className="w-full py-4 rounded-xl font-bold text-xs uppercase tracking-widest bg-red-50 text-red-600 hover:bg-red-100 transition-all"
                    >
                      Deactivate Business
                    </button>
                  )}
                  {r.is_active === 2 && (
                    <button
                      onClick={() => setStatus(r.id, 1)}
                      className="w-full py-4 rounded-xl font-bold text-xs uppercase tracking-widest bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-600/20 transition-all"
                    >
                      Re-activate Business
                    </button>
                  )}
                  <button
                    onClick={() => setEditingOwner(editingOwner?.restaurantId === r.id ? null : { restaurantId: r.id, name: r.owner_name || '', email: r.owner_email || '', phone: r.owner_phone || '' })}
                    className="w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-[#1a1208] border border-[#cc5a16]/10 hover:bg-[#cc5a16]/5 transition-all flex items-center justify-center gap-2"
                  >
                    <Edit3 size={14} /> Edit Owner Info
                  </button>
                  <button
                    onClick={() => resetPassword(r.id)}
                    className="w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-[#1a1208] border border-[#cc5a16]/10 hover:bg-[#cc5a16]/5 transition-all"
                  >
                    Reset Owner Password
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch(`/api/admin/restaurants/${r.id}/resend-welcome-email`, {
                          method: 'POST',
                          headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const data = await res.json();
                        if (res.ok) alert(`✅ ${data.message}`);
                        else alert(`❌ ${data.error}`);
                      } catch { alert('Network error. Please try again.'); }
                    }}
                    className="w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-blue-700 border border-blue-200 hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                  >
                    <Mail size={13} /> Resend Welcome Email
                  </button>
                  {/* Provision DNS — creates/repairs Cloudflare CNAME + Public Hostname for this tenant's slug */}
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch(`/api/admin/restaurants/${r.id}/provision-dns`, {
                          method: 'POST',
                          headers: { 'Authorization': `Bearer ${token}` }
                        });
                        const data = await res.json();
                        if (!res.ok) {
                          alert(`❌ ${data.error || 'Failed'}`);
                          return;
                        }
                        if (data.skipped) {
                          alert('⚠ Cloudflare auto-provisioning is not configured. See deploy/CLOUDFLARE-AUTO-SETUP.md to enable it.');
                          return;
                        }
                        if (data.error) {
                          alert(`❌ ${data.error}`);
                          return;
                        }
                        const msg = data.already_exists
                          ? `✅ DNS already existed for ${data.hostname}. Tunnel rule ${data.tunnel_config_updated ? 'also added' : 'already present'}.`
                          : `✅ DNS CNAME created for ${data.hostname}. Tunnel rule ${data.tunnel_config_updated ? 'added' : 'skipped (manually managed)'}.`;
                        alert(msg);
                      } catch { alert('Network error. Please try again.'); }
                    }}
                    className="w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-[#cc5a16] border border-[#cc5a16]/30 hover:bg-[#cc5a16]/5 transition-all flex items-center justify-center gap-2"
                  >
                    <Globe size={13} /> Provision DNS
                  </button>
                  {/* Invoice Deletion feature flag — high-risk, per-tenant gate.
                      SuperAdminDashboard is only rendered for SUPER_ADMIN, so the
                      backend's isAdmin middleware (SUPER_ADMIN/CTO) will accept calls. */}
                  {(() => {
                    const enabled = Number(r.invoice_delete_enabled || 0) === 1;
                    return (
                      <button
                        onClick={() => setInvoiceDeleteFlag(r.id, enabled)}
                        title={enabled ? "Click to disable invoice deletion for this tenant" : "Click to enable invoice deletion for this tenant"}
                        className={cn(
                          "w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 border",
                          enabled
                            ? "text-red-700 border-red-300 bg-red-50 hover:bg-red-100"
                            : "text-[#6b5d52] border-[#cc5a16]/10 hover:bg-[#cc5a16]/5"
                        )}
                      >
                        <Trash2 size={13} /> Invoice Deletion: {enabled ? 'ENABLED' : 'OFF'}
                      </button>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : viewMode === 'USERS' ? (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h3 className="text-xl font-bold font-serif">Internal User Management</h3>
            <button
              onClick={() => setIsAddingUser(true)}
              className="bg-[#cc5a16] text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-[#a84612] transition-all"
            >
              <Plus size={16} /> Add Internal User
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {internalUsers.map(u => (
              <div key={u.id} className="bg-white p-6 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-4">
                <div className="flex justify-between items-start">
                  <div className="w-12 h-12 rounded-2xl bg-[#cc5a16]/10 flex items-center justify-center text-[#1a1208]">
                    <User size={24} />
                  </div>
                  <div className="px-3 py-1 rounded-full bg-[#cc5a16]/10 text-[#1a1208] text-[11px] font-bold uppercase tracking-widest">
                    {u.role.replace('_', ' ')}
                  </div>
                </div>
                <div>
                  <h4 className="font-bold text-lg">{u.name}</h4>
                  <p className="text-xs text-[#6b5d52] font-mono">{u.login_id}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-[#3d3128] flex items-center gap-2"><Mail size={12} /> {u.email || 'No email'}</p>
                  <p className="text-xs text-[#3d3128] flex items-center gap-2"><Smartphone size={12} /> {u.phone || 'No phone'}</p>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={() => resetInternalUserPassword(u.id)}
                    className="flex-1 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest text-[#1a1208] border border-[#cc5a16]/10 hover:bg-[#cc5a16]/5 transition-all"
                  >
                    Reset Password
                  </button>
                  <button 
                    onClick={() => toggleInternalUserStatus(u.id, u.is_active)}
                    className={cn(
                      "flex-1 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
                      u.is_active === 1 ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-green-50 text-green-600 hover:bg-green-100"
                    )}
                  >
                    {u.is_active === 1 ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <AnimatePresence>
            {isAddingUser && (
              <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white w-full max-w-md rounded-[32px] p-6 sm:p-10 shadow-2xl relative max-h-[90vh] overflow-y-auto my-auto"
                >
                  <button onClick={() => setIsAddingUser(false)} className="absolute top-6 right-6 text-[#9c8e85] hover:text-[#1a1208]"><X size={24} /></button>
                  <h3 className="text-2xl font-bold mb-6">Add Internal User</h3>
                  <form onSubmit={handleAddUser} className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Full Name</label>
                      <input 
                        required
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-3 outline-none"
                        value={newUser.name}
                        onChange={e => setNewUser({...newUser, name: e.target.value})}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Login ID</label>
                        <input 
                          required
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-3 outline-none"
                          value={newUser.loginId}
                          onChange={e => setNewUser({...newUser, loginId: e.target.value})}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Role</label>
                        <select 
                          className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-3 outline-none"
                          value={newUser.role}
                          onChange={e => setNewUser({...newUser, role: e.target.value as UserRole})}
                        >
                          <option value="SUPER_ADMIN">Super Admin</option>
                          <option value="SALES_REP">Sales Rep</option>
                          <option value="CTO">CTO</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Email</label>
                      <input 
                        type="email"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-3 outline-none"
                        value={newUser.email}
                        onChange={e => setNewUser({...newUser, email: e.target.value})}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Password</label>
                      <input 
                        required
                        type="password"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-3 outline-none"
                        value={newUser.password}
                        onChange={e => setNewUser({...newUser, password: e.target.value})}
                      />
                    </div>
                    <button type="submit" className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold mt-4">Create User</button>
                  </form>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
        </div>
      ) : viewMode === 'LOCATIONS' ? (
        <div className="space-y-6">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white p-5 rounded-3xl border border-[#cc5a16]/10 shadow-sm text-center">
              <p className="text-3xl font-bold font-serif text-[#1a1208]">{adminLocations.length}</p>
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mt-1">Total Cities</p>
            </div>
            <div className="bg-white p-5 rounded-3xl border border-[#cc5a16]/10 shadow-sm text-center">
              <p className="text-3xl font-bold font-serif text-[#1a1208]">{new Set(adminLocations.map((l: any) => l.state)).size}</p>
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mt-1">States / UTs</p>
            </div>
            <div className="bg-white p-5 rounded-3xl border border-[#cc5a16]/10 shadow-sm text-center">
              <p className="text-3xl font-bold font-serif text-emerald-600">{adminLocations.filter((l: any) => l.is_active).length}</p>
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] mt-1">Active</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* ── Add Location form ── */}
            <div className="bg-white p-6 sm:p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-5">
              <h3 className="text-xl font-bold font-serif flex items-center gap-2">
                <MapPin size={18} className="text-indigo-500" /> Add New Location
              </h3>
              <form onSubmit={handleAddLocation} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">State / UT</label>
                  <input
                    list="admin-state-list"
                    required
                    placeholder="e.g. Punjab"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    value={newLocation.state}
                    onChange={e => setNewLocation({ ...newLocation, state: e.target.value })}
                  />
                  <datalist id="admin-state-list">
                    {[...new Set(adminLocations.map((l: any) => l.state as string))].sort().map(s => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">City</label>
                  <input
                    required
                    placeholder="e.g. Phagwara"
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none"
                    value={newLocation.city}
                    onChange={e => setNewLocation({ ...newLocation, city: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">ZIP / PIN Code <span className="normal-case font-normal">(optional)</span></label>
                  <input
                    placeholder="e.g. 144401"
                    maxLength={6}
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#cc5a16]/20 outline-none font-mono"
                    value={newLocation.zip_code}
                    onChange={e => setNewLocation({ ...newLocation, zip_code: e.target.value.replace(/\D/g, '') })}
                  />
                </div>
                {locationMsg && (
                  <div className={cn(
                    "p-3 rounded-2xl text-xs font-bold flex items-center gap-2",
                    locationMsg.type === 'ok' ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
                  )}>
                    {locationMsg.type === 'ok' ? <Check size={14} /> : <X size={14} />}
                    {locationMsg.text}
                  </div>
                )}
                <button
                  type="submit"
                  className="w-full bg-indigo-600 text-white py-3 rounded-2xl font-bold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2"
                >
                  <Plus size={16} /> Add Location
                </button>
              </form>
            </div>

            {/* ── Locations table ── */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex gap-3 items-center">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85]" />
                  <input
                    placeholder="Search state or city…"
                    className="w-full bg-white border border-[#cc5a16]/10 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                    value={locationSearch}
                    onChange={e => setLocationSearch(e.target.value)}
                  />
                </div>
                <button
                  onClick={fetchAdminLocations}
                  className="p-3 bg-white border border-[#cc5a16]/10 rounded-2xl hover:bg-[#faf7f2] transition-all"
                  title="Refresh"
                >
                  <RefreshCw size={16} className="text-[#6b5d52]" />
                </button>
              </div>

              <div className="relative bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#faf7f2] border-b border-[#cc5a16]/10">
                        <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">State</th>
                        <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">City</th>
                        <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">ZIP / PIN</th>
                        <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Status</th>
                        <th className="px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#5A5A40]/5">
                      {adminLocations
                        .filter((l: any) =>
                          !locationSearch ||
                          l.state.toLowerCase().includes(locationSearch.toLowerCase()) ||
                          l.city.toLowerCase().includes(locationSearch.toLowerCase()) ||
                          (l.zip_code || '').includes(locationSearch)
                        )
                        .map((loc: any) => (
                          <tr key={loc.id} className="hover:bg-[#f9f9f5] transition-colors">
                            <td className="px-5 py-3 text-sm font-bold text-[#1a1208]">{loc.state}</td>
                            <td className="px-5 py-3 text-sm">{loc.city}</td>
                            <td className="px-5 py-3">
                              {editingZip?.id === loc.id ? (
                                <div className="flex items-center gap-1">
                                  <input
                                    autoFocus
                                    maxLength={6}
                                    className="w-24 bg-[#faf7f2] border-none rounded-lg px-2 py-1 text-sm font-mono outline-none focus:ring-1 ring-[#cc5a16]/20"
                                    value={editingZip.zip_code}
                                    onChange={e => setEditingZip({ ...editingZip, zip_code: e.target.value.replace(/\D/g, '') })}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleUpdateZip(loc.id, editingZip.zip_code);
                                      if (e.key === 'Escape') setEditingZip(null);
                                    }}
                                  />
                                  <button onClick={() => handleUpdateZip(loc.id, editingZip.zip_code)} className="p-1 text-green-600 hover:bg-green-50 rounded"><Check size={14} /></button>
                                  <button onClick={() => setEditingZip(null)} className="p-1 text-red-400 hover:bg-red-50 rounded"><X size={14} /></button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setEditingZip({ id: loc.id, zip_code: loc.zip_code || '' })}
                                  className="font-mono text-sm text-[#1a1208] hover:text-indigo-600 hover:underline flex items-center gap-1 group"
                                  title="Click to edit ZIP"
                                >
                                  {loc.zip_code || <span className="text-[#9c8e85] italic">—</span>}
                                  <Edit3 size={11} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                                </button>
                              )}
                            </td>
                            <td className="px-5 py-3">
                              <span className={cn(
                                "px-2 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest",
                                loc.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"
                              )}>
                                {loc.is_active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-5 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => handleToggleLocationStatus(loc.id, loc.is_active)}
                                  className={cn(
                                    "px-3 py-1 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
                                    loc.is_active ? "bg-orange-50 text-orange-600 hover:bg-orange-100" : "bg-green-50 text-green-600 hover:bg-green-100"
                                  )}
                                >
                                  {loc.is_active ? 'Disable' : 'Enable'}
                                </button>
                                <button
                                  onClick={() => handleDeleteLocation(loc.id, `${loc.city}, ${loc.state}`)}
                                  className="p-1.5 text-red-400 hover:bg-red-50 rounded-lg transition-all"
                                  title="Delete"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      {adminLocations.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-5 py-12 text-center text-[#9c8e85] italic">
                            No locations loaded. Click the refresh button.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
              </div>
            </div>
          </div>
        </div>
      ) : viewMode === 'PERMISSIONS' ? (
        <div className="space-y-6">
          <div className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm p-8">
            <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6">
              <div className="flex-1">
                <h3 className="text-xl font-bold flex items-center gap-2"><Shield size={20} className="text-violet-500" /> Role-Based Tab Access</h3>
                <p className="text-sm text-[#6b5d52] mt-1">Control which dashboard tabs OWNER and MANAGER can access for each restaurant.</p>
              </div>
              <select
                value={permSelectedRestaurant}
                onChange={e => { setPermSelectedRestaurant(e.target.value); fetchPermissions(e.target.value); }}
                className="bg-[#faf7f2] border-none rounded-2xl px-5 py-3 text-sm font-semibold outline-none min-w-[220px]"
              >
                <option value="">— Select Restaurant —</option>
                {restaurants.map(r => (
                  <option key={r.id} value={r.id}>{r.name} ({r.city})</option>
                ))}
              </select>
            </div>

            {!permSelectedRestaurant && (
              <div className="text-center py-16 text-[#9c8e85] italic">Select a restaurant above to configure role permissions.</div>
            )}

            {permSelectedRestaurant && permLoading && (
              <div className="flex justify-center py-12"><div className="w-8 h-8 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" /></div>
            )}

            {permSelectedRestaurant && !permLoading && (
              <>
                {/* Module status banner */}
                <div className={cn(
                  "mb-4 px-4 py-3 rounded-2xl text-xs flex items-center gap-3 border",
                  selectedIsHotel
                    ? "bg-[#b8860b]/10 border-[#b8860b]/20 text-[#6b5d52]"
                    : "bg-[#eff5fd] border-[#2563a8]/20 text-[#6b5d52]"
                )}>
                  <span className="text-lg">{selectedIsHotel ? '🏨' : '🍽'}</span>
                  <div>
                    {selectedIsHotel ? (
                      <>
                        <strong className="text-[#b8860b]">Hotel module enabled</strong> for this property.
                        The 7 hotel tabs (<em>Rooms, Hotel Bookings, Services, Service Requests, Folios, Compliance, Concierge FAQ</em>) are listed below in a separate section and can be toggled independently.
                      </>
                    ) : (
                      <>
                        <strong className="text-[#2563a8]">Restaurant-only tenant.</strong>
                        Hotel-related tabs (Rooms, Folios, Compliance, etc.) are hidden here because this property has not enabled the Hotel module. The owner can enable it under <em>Brand &amp; Settings → Property Type</em>.
                      </>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-2xl border border-[#cc5a16]/10">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#faf7f2]">
                        <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] w-32">Tab</th>
                        {PERM_ROLES.map(role => (
                          <th key={role} className="px-5 py-3 text-center text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">
                            {role}
                            <div className="flex items-center justify-center gap-1 mt-1">
                              <button
                                onClick={() => setPermData(prev => ({ ...prev, [role]: [...ALL_TABS] }))}
                                className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-[11px] hover:bg-green-200 transition-colors"
                              >All</button>
                              <button
                                onClick={() => setPermData(prev => ({ ...prev, [role]: [] }))}
                                className="px-2 py-0.5 bg-red-100 text-red-600 rounded-full text-[11px] hover:bg-red-200 transition-colors"
                              >None</button>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {/* Section header — Restaurant tabs */}
                      <tr className="bg-[#2563a8]/5">
                        <td colSpan={1 + PERM_ROLES.length} className="px-5 py-2 text-[10px] font-bold uppercase tracking-widest text-[#2563a8] border-l-4 border-[#2563a8]">
                          🍽 Restaurant Tabs
                        </td>
                      </tr>
                      {RESTAURANT_TABS.map((tab, i) => (
                        <tr key={tab} className={i % 2 === 0 ? 'bg-white' : 'bg-[#faf7f2]/40'}>
                          <td className="px-5 py-3 font-semibold text-[#3d3128] text-xs uppercase tracking-wider">{tab}</td>
                          {PERM_ROLES.map(role => {
                            const allowed = (permData[role] || ALL_TABS).includes(tab);
                            return (
                              <td key={role} className="px-5 py-3 text-center">
                                <button
                                  onClick={() => togglePermTab(role, tab)}
                                  className={cn(
                                    "w-8 h-8 rounded-xl flex items-center justify-center mx-auto transition-all",
                                    allowed ? "bg-green-100 text-green-600 hover:bg-green-200" : "bg-red-50 text-red-400 hover:bg-red-100"
                                  )}
                                >
                                  {allowed ? <Check size={14} /> : <X size={14} />}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {/* Section header — Hotel tabs (only if enabled) */}
                      {selectedIsHotel && (
                        <>
                          <tr className="bg-[#b8860b]/5">
                            <td colSpan={1 + PERM_ROLES.length} className="px-5 py-2 text-[10px] font-bold uppercase tracking-widest text-[#b8860b] border-l-4 border-[#b8860b]">
                              🏨 Hotel Tabs
                            </td>
                          </tr>
                          {HOTEL_TABS.map((tab, i) => (
                            <tr key={tab} className={i % 2 === 0 ? 'bg-white' : 'bg-[#faf7f2]/40'}>
                              <td className="px-5 py-3 font-semibold text-[#3d3128] text-xs uppercase tracking-wider">{tab.replace(/_/g, ' ')}</td>
                              {PERM_ROLES.map(role => {
                                const allowed = (permData[role] || ALL_TABS).includes(tab);
                                return (
                                  <td key={role} className="px-5 py-3 text-center">
                                    <button
                                      onClick={() => togglePermTab(role, tab)}
                                      className={cn(
                                        "w-8 h-8 rounded-xl flex items-center justify-center mx-auto transition-all",
                                        allowed ? "bg-green-100 text-green-600 hover:bg-green-200" : "bg-red-50 text-red-400 hover:bg-red-100"
                                      )}
                                    >
                                      {allowed ? <Check size={14} /> : <X size={14} />}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>

                {permMsg && (
                  <div className={cn(
                    "mt-4 px-4 py-3 rounded-2xl text-sm font-medium",
                    permMsg.type === 'ok' ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
                  )}>
                    {permMsg.text}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={savePermissions}
                    disabled={permSaving}
                    className="bg-violet-600 text-white px-8 py-3 rounded-2xl font-bold hover:bg-violet-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {permSaving ? <><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving…</> : <><Check size={16} /> Save Permissions</>}
                  </button>
                  <p className="text-xs text-[#9c8e85]">Changes take effect on next login. Users currently logged in won't be affected until they log out and back in.</p>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SalesRepresentativeDashboard({ token }: { token: string }) {
  const [restaurants, setRestaurants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMyRestaurants();
  }, []);

  const fetchMyRestaurants = async () => {
    try {
      const res = await fetch('/api/admin/restaurants', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setRestaurants(await res.json());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const approveRestaurant = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/restaurants/${id}/toggle-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ is_active: 1 })
      });
      if (res.ok) fetchMyRestaurants();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="flex justify-center p-12"><Clock className="animate-spin" /></div>;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold font-serif">Sales Representative Dashboard</h2>
        <p className="text-sm text-[#6b5d52]">Your onboarded businesses and performance tracking.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm text-center">
          <p className="text-4xl font-bold text-[#1a1208] mb-2">{restaurants.length}</p>
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Total Onboarded</p>
        </div>
        <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm text-center">
          <p className="text-4xl font-bold text-green-600 mb-2">{restaurants.filter(r => r.is_active === 1).length}</p>
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Active Businesses</p>
        </div>
        <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm text-center">
          <p className="text-4xl font-bold text-orange-500 mb-2">{restaurants.filter(r => r.is_active === 0).length}</p>
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Pending Approval</p>
        </div>
      </div>

      <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
        <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
          <Layout size={20} /> My Onboarded Businesses
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {restaurants.map(r => (
            <div key={r.id} className="p-6 rounded-3xl bg-[#faf7f2] flex justify-between items-center">
              <div>
                <h4 className="font-bold">{r.name}</h4>
                <p className="text-xs text-[#6b5d52]">{r.city}, {r.state}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-widest",
                    r.is_active === 1 ? "bg-green-100 text-green-700" : 
                    r.is_active === 0 ? "bg-orange-100 text-orange-700" : 
                    "bg-red-100 text-red-700"
                  )}>
                    {r.is_active === 1 ? 'Active' : r.is_active === 0 ? 'Pending' : 'Inactive'}
                  </span>
                  {r.subscription_expires_at && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-widest flex items-center gap-1",
                      new Date(r.subscription_expires_at) < new Date() ? "bg-red-50 text-red-600" : "bg-blue-50 text-blue-600"
                    )}>
                      <Clock size={8} /> Due: {new Date(r.subscription_expires_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right flex flex-col items-end gap-2">
                <div>
                  <p className="text-xs font-bold">{r.owner_name}</p>
                  <p className="text-[11px] text-[#9c8e85] font-mono">{r.id}</p>
                </div>
                {r.is_active === 0 && (
                  <button 
                    onClick={() => approveRestaurant(r.id)}
                    className="bg-green-600 text-white px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-green-700 transition-all shadow-lg shadow-green-600/20"
                  >
                    Approve
                  </button>
                )}
              </div>
            </div>
          ))}
          {restaurants.length === 0 && (
            <div className="col-span-full py-12 text-center text-[#9c8e85] italic">
              You haven't onboarded any businesses yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CTODashboard({ token }: { token: string }) {
  const [report, setReport] = useState<any[]>([]);
  const [internalUsers, setInternalUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSalesRep, setSelectedSalesRep] = useState<string | null>(null);
  const [salesRepRestaurants, setSalesRepRestaurants] = useState<any[]>([]);
  const [viewMode, setViewMode] = useState<'REPORTS' | 'USERS' | 'SUBSCRIPTIONS'>('REPORTS');
  const [prices, setPrices] = useState({ monthly_price: '999', annual_price: '9999' });
  const [isSavingPrices, setIsSavingPrices] = useState(false);

  useEffect(() => {
    fetchReport();
    fetchInternalUsers();
    fetchPrices();
  }, []);

  const fetchPrices = async () => {
    try {
      const res = await fetch('/api/admin/subscription-prices', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setPrices(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const savePrices = async () => {
    setIsSavingPrices(true);
    try {
      const res = await fetch('/api/admin/subscription-prices', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(prices)
      });
      if (res.ok) alert("Prices updated successfully");
    } catch (err) {
      alert("Failed to update prices");
    } finally {
      setIsSavingPrices(false);
    }
  };

  const renewSubscription = async (restaurantId: string, type: 'MONTHLY' | 'ANNUALLY') => {
    try {
      const res = await fetch(`/api/admin/restaurants/${restaurantId}/renew-subscription`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ type })
      });
      if (res.ok) {
        alert("Subscription renewed successfully");
        if (selectedSalesRep) fetchSalesRepRestaurants(selectedSalesRep);
      }
    } catch (err) {
      alert("Failed to renew subscription");
    }
  };

  const fetchReport = async () => {
    try {
      const res = await fetch('/api/cto/onboarding-report', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setReport(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchInternalUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setInternalUsers(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  const toggleInternalUserStatus = async (userId: string, currentStatus: number) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/toggle-status`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ is_active: currentStatus === 1 ? 0 : 1 })
      });
      if (res.ok) fetchInternalUsers();
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSalesRepRestaurants = async (id: string) => {
    try {
      const res = await fetch(`/api/cto/sales-rep-restaurants/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setSalesRepRestaurants(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="flex justify-center p-12"><Clock className="animate-spin" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">CTO Dashboard</h2>
          <p className="text-sm text-[#6b5d52]">Onboarding performance and internal user management.</p>
        </div>
        <div className="flex bg-white p-1 rounded-2xl border border-[#cc5a16]/10">
          <button 
            onClick={() => setViewMode('REPORTS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'REPORTS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <BarChart size={16} /> Reports
          </button>
          <button 
            onClick={() => setViewMode('USERS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'USERS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <Users size={16} /> Internal Users
          </button>
          <button 
            onClick={() => setViewMode('SUBSCRIPTIONS')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2",
              viewMode === 'SUBSCRIPTIONS' ? "bg-[#cc5a16] text-white shadow-md" : "text-[#1a1208] hover:bg-[#cc5a16]/5"
            )}
          >
            <CreditCard size={16} /> Subscriptions
          </button>
        </div>
      </div>

      {viewMode === 'REPORTS' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
            <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
              <Users size={20} /> Sales Representative Performance
            </h3>
            <div className="space-y-4">
              {report.map(item => (
                <div 
                  key={item.sales_rep_id}
                  onClick={() => {
                    setSelectedSalesRep(item.sales_rep_id);
                    fetchSalesRepRestaurants(item.sales_rep_id);
                  }}
                  className={cn(
                    "p-4 rounded-2xl border transition-all cursor-pointer flex justify-between items-center",
                    selectedSalesRep === item.sales_rep_id ? "border-[#cc5a16] bg-[#cc5a16]/5" : "border-[#cc5a16]/10 hover:bg-[#cc5a16]/5"
                  )}
                >
                  <div>
                    <p className="font-bold">{item.sales_rep_name}</p>
                    <p className="text-xs text-[#6b5d52]">Sales Representative</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-[#1a1208]">{item.restaurant_count}</p>
                    <p className="text-[11px] uppercase tracking-widest text-[#9c8e85]">Onboarded</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white p-8 rounded-[32px] border border-[#cc5a16]/10 shadow-sm">
            <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
              <Layout size={20} /> Onboarded Businesses
            </h3>
            {selectedSalesRep ? (
              <div className="space-y-4">
                {salesRepRestaurants.length > 0 ? (
                  salesRepRestaurants.map(r => (
                    <div key={r.id} className="p-4 rounded-2xl bg-[#faf7f2] flex justify-between items-center">
                      <div>
                        <p className="font-bold">{r.name}</p>
                        <p className="text-xs text-[#6b5d52]">{r.city}, {r.state}</p>
                        {r.subscription_expires_at && (
                          <p className={cn(
                            "text-[11px] font-bold mt-1",
                            new Date(r.subscription_expires_at) < new Date() ? "text-red-500" : "text-blue-500"
                          )}>
                            Due: {new Date(r.subscription_expires_at).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="text-right flex flex-col items-end gap-2">
                        <div>
                          <p className="text-xs font-bold">{r.owner_name}</p>
                          <p className="text-[11px] text-[#9c8e85]">Business Owner</p>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => renewSubscription(r.id, 'MONTHLY')}
                            className="bg-[#cc5a16] text-white px-3 py-1 rounded-lg text-[11px] font-bold uppercase tracking-widest hover:bg-[#a84612]"
                          >
                            +1 Month
                          </button>
                          <button 
                            onClick={() => renewSubscription(r.id, 'ANNUALLY')}
                            className="bg-green-600 text-white px-3 py-1 rounded-lg text-[11px] font-bold uppercase tracking-widest hover:bg-green-700"
                          >
                            +1 Year
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center py-12 text-[#9c8e85]">No businesses onboarded yet.</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-[#9c8e85]">
                <Info size={48} className="mb-4 opacity-20" />
                <p>Select a sales representative to view details</p>
              </div>
            )}
          </div>
        </div>
      ) : viewMode === 'USERS' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {internalUsers.map(u => (
            <div key={u.id} className="bg-white p-6 rounded-[32px] border border-[#cc5a16]/10 shadow-sm space-y-4">
              <div className="flex justify-between items-start">
                <div className="w-12 h-12 rounded-2xl bg-[#cc5a16]/10 flex items-center justify-center text-[#1a1208]">
                  <User size={24} />
                </div>
                <div className="px-3 py-1 rounded-full bg-[#cc5a16]/10 text-[#1a1208] text-[11px] font-bold uppercase tracking-widest">
                  {u.role.replace('_', ' ')}
                </div>
              </div>
              <div>
                <h4 className="font-bold text-lg">{u.name}</h4>
                <p className="text-xs text-[#6b5d52] font-mono">{u.login_id}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-[#3d3128] flex items-center gap-2"><Mail size={12} /> {u.email || 'No email'}</p>
                <p className="text-xs text-[#3d3128] flex items-center gap-2"><Smartphone size={12} /> {u.phone || 'No phone'}</p>
              </div>
              <button 
                onClick={() => toggleInternalUserStatus(u.id, u.is_active)}
                className={cn(
                  "w-full py-2 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
                  u.is_active === 1 ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-green-50 text-green-600 hover:bg-green-100"
                )}
              >
                {u.is_active === 1 ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white p-10 rounded-[32px] border border-[#cc5a16]/10 shadow-sm max-w-2xl mx-auto">
          <h3 className="text-2xl font-bold font-serif mb-8 flex items-center gap-2">
            <CreditCard size={28} /> Subscription Pricing
          </h3>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Monthly Price (₹)</label>
                <input 
                  type="number"
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 outline-none font-bold"
                  value={prices.monthly_price}
                  onChange={e => setPrices({...prices, monthly_price: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] ml-2">Annual Price (₹)</label>
                <input 
                  type="number"
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-6 py-4 outline-none font-bold"
                  value={prices.annual_price}
                  onChange={e => setPrices({...prices, annual_price: e.target.value})}
                />
              </div>
            </div>
            <button 
              onClick={savePrices}
              disabled={isSavingPrices}
              className="w-full bg-[#cc5a16] text-white py-4 rounded-2xl font-bold hover:bg-[#a84612] transition-all disabled:opacity-50"
            >
              {isSavingPrices ? 'Saving...' : 'Update Subscription Prices'}
            </button>
            <div className="bg-orange-50 p-6 rounded-3xl border border-orange-100 flex gap-4">
              <Info className="text-orange-500 shrink-0" size={20} />
              <p className="text-xs text-orange-700 leading-relaxed">
                Only the CTO can modify global subscription pricing. These prices will be visible to all sales representatives and business owners.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WaiterOrderPanel — full ordering interface for waiter acting on behalf of customer ───
function WaiterOrderPanel({ restaurantId, tableId, tableName, onClose }: {
  restaurantId: string; tableId: string; tableName: string; onClose: () => void;
}) {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [restaurant, setRestaurant] = useState<any>(null);
  const [session, setSession] = useState<any | null>(null);
  const [cart, setCart] = useState<{ name: string; price: number; quantity: number }[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [panelTab, setPanelTab] = useState<'MENU' | 'BILL'>('MENU');
  const [selectedCat, setSelectedCat] = useState('All');
  const [isPlacing, setIsPlacing] = useState(false);
  const [isRequestingBill, setIsRequestingBill] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  const parseOrders = (orders: any[]) => orders.map((o: any) => ({
    ...o,
    items: typeof o.items === 'string' ? (() => { try { return JSON.parse(o.items); } catch { return []; } })() : (o.items || []),
    totalAmount: Number(o.total_amount ?? o.totalAmount ?? 0),
  }));

  const loadData = async () => {
    setLoading(true);
    try {
      const [menuRes, restRes, sessRes] = await Promise.all([
        fetch(`/api/restaurant/${restaurantId}/menu`),
        fetch(`/api/restaurant/${restaurantId}`),
        fetch(`/api/restaurant/${restaurantId}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table_id: tableId, table_name: tableName }),
        }),
      ]);
      if (menuRes.ok) setMenu(await menuRes.json());
      if (restRes.ok) setRestaurant(await restRes.json());
      if (sessRes.ok) {
        const data = await sessRes.json();
        if (Array.isArray(data.orders)) data.orders = parseOrders(data.orders);
        setSession(data);
        if (data.customer_name) { setCustomerName(data.customer_name); setCustomerPhone(data.customer_phone || ''); }
      }
    } finally { setLoading(false); }
  };

  const addToCart = (item: MenuItem, size: 'FULL' | 'HALF' = 'FULL') => {
    const price = size === 'HALF' ? (item.price_half ?? item.price) : item.price_full;
    const label = `${item.name}${size === 'HALF' ? ' (Half)' : ''}`;
    setCart(prev => {
      const ex = prev.find(c => c.name === label);
      if (ex) return prev.map(c => c.name === label ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { name: label, price, quantity: 1 }];
    });
  };

  const removeFromCart = (name: string) => setCart(prev => prev.filter(c => c.name !== name));
  const incQty = (name: string) => setCart(prev => prev.map(c => c.name === name ? { ...c, quantity: c.quantity + 1 } : c));
  const decQty = (name: string) => setCart(prev => prev.flatMap(c => c.name === name ? (c.quantity > 1 ? [{ ...c, quantity: c.quantity - 1 }] : []) : [c]));
  const cartTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0);
  const categories = ['All', ...Array.from(new Set(menu.map(m => m.category).filter(Boolean)))];
  const filteredMenu = selectedCat === 'All' ? menu : menu.filter(m => m.category === selectedCat);
  const sessionOrders = session?.orders || [];
  const sessionTotal = sessionOrders.reduce((s: number, o: any) => s + Number(o.totalAmount || 0), 0);
  const gstRate = restaurant?.is_gst_enabled ? (restaurant.gst_percentage ?? 0) : 0;
  const sessionGst = sessionOrders.reduce((s: number, o: any) => s + Number(o.gst_amount ?? o.gstAmount ?? 0), 0);

  const placeOrder = async () => {
    if (!session || session.status !== 'open') { setError('Session is not active.'); return; }
    if (cart.length === 0) { setError('Cart is empty.'); return; }
    setIsPlacing(true); setError('');
    try {
      const name  = customerName.trim()  || 'Walk-in Guest';
      const phone = customerPhone.trim() || '0000000000';
      const sub  = cartTotal;
      const gst  = sub * gstRate / 100;
      const res = await fetch(`/api/restaurant/${restaurantId}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tableNumber: tableName, tableId,
          customerName: name, customerPhone: phone,
          items: cart.map(c => ({ name: c.name, price: c.price, quantity: c.quantity })),
          totalAmount: sub + gst, gstAmount: gst,
          paymentMethod: 'TABLE', session_token: session.session_token,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to place order');
      setCart([]);
      await loadData();
      setPanelTab('BILL');
    } catch (e: any) { setError(e.message); }
    finally { setIsPlacing(false); }
  };

  const requestBill = async (method: string) => {
    if (!session) return;
    setIsRequestingBill(true);
    try {
      await fetch(`/api/restaurant/${restaurantId}/sessions/${session.session_token}/request-bill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_method: method }),
      });
      await loadData();
    } finally { setIsRequestingBill(false); }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col bg-[#faf7f2]"
    >
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-4 bg-white border-b border-[#cc5a16]/10 shrink-0">
        <button onClick={onClose} className="p-2 hover:bg-[#faf7f2] rounded-xl transition-all"><X size={20} /></button>
        <div className="flex-1">
          <p className="font-bold text-lg font-serif">{tableName}</p>
          {session?.customer_name && <p className="text-xs text-[#6b5d52]">{session.customer_name} · {session.customer_phone}</p>}
        </div>
        {session?.status === 'bill_requested' && (
          <span className="text-[11px] font-bold uppercase tracking-widest bg-orange-100 text-orange-700 px-3 py-1.5 rounded-full">Bill Requested</span>
        )}
        {session?.status === 'open' && cart.length > 0 && (
          <button onClick={placeOrder} disabled={isPlacing}
            className="flex items-center gap-2 px-4 py-2 bg-[#cc5a16] text-white rounded-xl text-sm font-bold hover:bg-[#a84612] disabled:opacity-50 transition-all"
          >
            {isPlacing ? <Clock size={14} className="animate-spin" /> : <Plus size={14} />}
            Place Order · ₹{cartTotal.toFixed(0)}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-2 bg-white border-b border-[#cc5a16]/10 shrink-0">
        {(['MENU', 'BILL'] as const).map(t => (
          <button key={t} onClick={() => setPanelTab(t)}
            className={cn("flex-1 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
              panelTab === t ? "bg-[#cc5a16] text-white" : "text-[#6b5d52] hover:bg-[#faf7f2]")}
          >{t === 'MENU' ? `Menu${cart.length > 0 ? ` (${cart.length})` : ''}` : `Current Bill${sessionOrders.length > 0 ? ` (${sessionOrders.length} rounds)` : ''}`}</button>
        ))}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><Clock size={24} className="animate-spin text-[#cc5a16]" /></div>
      ) : panelTab === 'MENU' ? (
        <div className="flex-1 overflow-y-auto">
          {/* Category pills */}
          <div className="flex gap-2 px-4 py-3 overflow-x-auto shrink-0 border-b border-[#cc5a16]/10">
            {categories.map(cat => (
              <button key={cat} onClick={() => setSelectedCat(cat)}
                className={cn("shrink-0 px-3 py-1.5 rounded-full text-xs font-bold transition-all",
                  selectedCat === cat ? "bg-[#cc5a16] text-white" : "bg-white border border-[#cc5a16]/10 text-[#6b5d52]")}
              >{cat}</button>
            ))}
          </div>
          {/* Customer name (if no session yet or no customer) */}
          {!session?.customer_name && (
            <div className="px-4 py-3 grid grid-cols-2 gap-2 border-b border-[#cc5a16]/10 bg-white">
              <input placeholder="Customer Name *" value={customerName} onChange={e => setCustomerName(e.target.value)}
                className="bg-[#faf7f2] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
              <input placeholder="Phone *" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} type="tel"
                className="bg-[#faf7f2] rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20" />
            </div>
          )}
          {/* Menu items */}
          <div className="divide-y divide-[#cc5a16]/5">
            {filteredMenu.filter(m => m.available).map(item => {
              const inCart = cart.filter(c => c.name.startsWith(item.name)).reduce((s, c) => s + c.quantity, 0);
              return (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3 bg-white">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("w-2.5 h-2.5 rounded-sm border shrink-0",
                        item.dietary_type === 'VEG' ? "border-green-600 bg-green-600/20" : item.dietary_type === 'VEGAN' ? "border-emerald-600 bg-emerald-600/20" : "border-red-600 bg-red-600/20")} />
                      <p className="font-medium text-sm truncate">{item.name}</p>
                      {inCart > 0 && <span className="shrink-0 w-5 h-5 rounded-full bg-[#cc5a16] text-white text-[11px] font-bold flex items-center justify-center">{inCart}</span>}
                    </div>
                    {item.description && <p className="text-xs text-[#9c8e85] truncate mt-0.5">{item.description}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.price_half && (
                      <button onClick={() => addToCart(item, 'HALF')}
                        className="px-2 py-1 rounded-lg bg-[#faf7f2] border border-[#cc5a16]/10 text-xs font-bold">
                        H ₹{item.price_half}
                      </button>
                    )}
                    <button onClick={() => addToCart(item, 'FULL')}
                      className="px-2 py-1 rounded-lg bg-[#cc5a16] text-white text-xs font-bold">
                      ₹{item.price_full}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Cart summary */}
          {cart.length > 0 && (
            <div className="sticky bottom-0 bg-white border-t border-[#cc5a16]/10 px-4 py-3 space-y-2">
              {cart.map(c => (
                <div key={c.name} className="flex items-center justify-between text-sm">
                  <span className="truncate flex-1">{c.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => decQty(c.name)}
                      className="w-6 h-6 rounded-full bg-[#faf7f2] border border-[#cc5a16]/10 flex items-center justify-center hover:bg-[#cc5a16]/10"
                      aria-label="Decrease quantity"
                    >
                      <Minus size={12} />
                    </button>
                    <span className="w-5 text-center font-bold">{c.quantity}</span>
                    <button
                      onClick={() => incQty(c.name)}
                      className="w-6 h-6 rounded-full bg-[#cc5a16] text-white flex items-center justify-center hover:bg-[#a84612]"
                      aria-label="Increase quantity"
                    >
                      <Plus size={12} />
                    </button>
                    <span className="font-mono font-bold w-12 text-right">₹{(c.price * c.quantity).toFixed(0)}</span>
                    <button onClick={() => removeFromCart(c.name)} className="p-1 text-red-400 hover:text-red-600 rounded" aria-label="Remove item"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
              {error && <p className="text-red-500 text-xs">{error}</p>}
            </div>
          )}
        </div>
      ) : (
        /* BILL tab */
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {sessionOrders.length === 0 ? (
            <div className="py-12 text-center text-[#9c8e85] italic text-sm">No orders placed yet for this table.</div>
          ) : (
            <>
              {sessionOrders.map((order: any, idx: number) => (
                <div key={order.id} className="bg-white rounded-2xl border border-[#cc5a16]/10 overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#faf7f2] border-b border-[#cc5a16]/10 flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Round {idx + 1}</span>
                    <span className="font-mono font-bold text-sm text-[#cc5a16]">₹{Number(order.totalAmount).toFixed(2)}</span>
                  </div>
                  <div className="px-4 py-2 divide-y divide-[#cc5a16]/5">
                    {(order.items || []).map((it: any, i: number) => (
                      <div key={i} className="flex justify-between py-1.5 text-sm">
                        <span>{it.name} ×{it.quantity || 1}</span>
                        <span className="font-mono">₹{(Number(it.price || 0) * Number(it.quantity || 1)).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {/* Totals */}
              <div className="bg-white rounded-2xl border border-[#cc5a16]/10 px-4 py-4 space-y-2 text-sm">
                <div className="flex justify-between text-[#6b5d52]"><span>Subtotal</span><span className="font-mono">₹{(sessionTotal - sessionGst).toFixed(2)}</span></div>
                {sessionGst > 0 && <div className="flex justify-between text-[#6b5d52]"><span>GST ({gstRate}%)</span><span className="font-mono">₹{sessionGst.toFixed(2)}</span></div>}
                <div className="flex justify-between font-bold text-lg border-t border-[#cc5a16]/10 pt-2"><span>Total</span><span className="font-mono text-[#cc5a16]">₹{sessionTotal.toFixed(2)}</span></div>
              </div>
              {/* Request bill / status */}
              {session?.status === 'open' && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => requestBill('CASH')} disabled={isRequestingBill}
                    className="py-3 bg-green-600 text-white rounded-2xl font-bold text-sm hover:bg-green-700 disabled:opacity-50 transition-all">
                    💵 Cash
                  </button>
                  <button onClick={() => requestBill('CARD')} disabled={isRequestingBill}
                    className="py-3 bg-blue-600 text-white rounded-2xl font-bold text-sm hover:bg-blue-700 disabled:opacity-50 transition-all">
                    💳 Card / UPI
                  </button>
                </div>
              )}
              {session?.status === 'bill_requested' && (
                <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 text-center">
                  <p className="font-bold text-orange-700">⏳ Bill Requested</p>
                  <p className="text-orange-600/70 text-xs mt-1">Waiting for payment collection</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}

// ─── PostpaidInvoiceModal — consolidated invoice for a full table session ──────
// Combines all order rounds into one invoice with editable adjustments.
// Owner can: review rounds · edit discount/service charge/GST · print · close table.
function PostpaidInvoiceModal({ restaurantId, token, table, onClose }: {
  restaurantId: string; token: string; table: { id: string; name: string }; onClose: () => void;
}) {
  const [loading, setLoading]     = useState(true);
  const [session, setSession]     = useState<any>(null);
  const [orders, setOrders]       = useState<any[]>([]);
  const [restaurant, setRestaurant] = useState<any>(null);
  const [fetchErr, setFetchErr]   = useState('');

  // Adjustment inputs (live, not saved until "Save" clicked)
  const [discount, setDiscount]   = useState(0);
  const [svcPct,   setSvcPct]     = useState(0);
  const [gstPct,   setGstPct]     = useState(5);
  const [applyGst, setApplyGst]   = useState(false);

  // UI state
  const [saving, setSaving]           = useState(false);
  const [saveDone, setSaveDone]       = useState(false);
  const [closing, setClosing]         = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [payMethod, setPayMethod]     = useState<'CASH' | 'CARD' | 'UPI'>('CASH');
  const [expanded, setExpanded]       = useState<Record<number, boolean>>({});

  // ── Fetch session ──────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true); setFetchErr('');
    fetch(`/api/restaurant/${restaurantId}/tables/${table.id}/active-session`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        const sess = d.session;
        const rest = d.restaurant;
        if (sess) {
          setSession(sess);
          setOrders(sess.orders || []);
          setRestaurant(rest);
          setDiscount(Number(sess.discount_amount || 0));
          setSvcPct(Number(sess.service_charge_percent || 0));
          setGstPct(Number(rest?.is_gst_enabled ? (sess.gst_percent != null ? sess.gst_percent : (rest?.gst_percentage ?? 0)) : 0));
          setApplyGst(Boolean(rest?.is_gst_enabled) && (sess.apply_gst != null ? Number(sess.apply_gst) === 1 : true));
          if (sess.payment_method) setPayMethod(sess.payment_method as 'CASH' | 'CARD' | 'UPI');
          // All rounds expanded by default
          const exp: Record<number, boolean> = {};
          (sess.orders || []).forEach((_: any, i: number) => { exp[i] = true; });
          setExpanded(exp);
        }
        setLoading(false);
      })
      .catch(() => { setFetchErr('Failed to load session data'); setLoading(false); });
  }, [table.id]);

  // ── Derived totals (computed live from actual item prices) ─────────────────
  // Cancelled orders are shown in the rounds list but excluded from all financial totals
  const activeOrders  = orders.filter((o: any) => o.status !== 'CANCELLED');
  const cancelledCnt  = orders.length - activeOrders.length;
  const rawSubtotal   = activeOrders.reduce((sum: number, o: any) => {
    const items = Array.isArray(o.items) ? o.items : [];
    return sum + items.reduce((s: number, it: any) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
  }, 0);
  const afterDiscount = Math.max(0, rawSubtotal - discount);
  const svcAmt        = Number((afterDiscount * svcPct / 100).toFixed(2));
  const taxable       = afterDiscount + svcAmt;
  const gstAmt        = applyGst ? Number((taxable * gstPct / 100).toFixed(2)) : 0;
  const grandTotal    = Number((taxable + gstAmt).toFixed(2));
  const totalRounds   = activeOrders.length;
  const totalItems    = activeOrders.reduce((n: number, o: any) => n + (Array.isArray(o.items) ? o.items.reduce((s: number, it: any) => s + Number(it.quantity || 1), 0) : 0), 0);

  // ── API helpers ────────────────────────────────────────────────────────────
  const persistAdjustments = async () => {
    if (!session) return;
    await fetch(`/api/restaurant/${restaurantId}/sessions/${session.session_token}/invoice`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        discount_amount: discount, service_charge_percent: svcPct,
        gst_percent: gstPct, apply_gst: applyGst ? 1 : 0, final_amount: grandTotal,
      }),
    });
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true); setSaveDone(false);
    try { await persistAdjustments(); setSaveDone(true); setTimeout(() => setSaveDone(false), 2500); }
    catch { /* silent */ }
    finally { setSaving(false); }
  };

  const handlePrint = () => {
    if (!session || activeOrders.length === 0) return;
    const dt = new Date(session.opened_at || Date.now());
    // Only print active (non-cancelled) orders
    const roundData = activeOrders.map((o: any, idx: number) => ({
      label: activeOrders.length > 1 ? `── Round ${o.round_number || idx + 1} ──` : undefined,
      items: (Array.isArray(o.items) ? o.items : []).map((it: any) => ({
        name: it.name || '', qty: Number(it.quantity || 1), price: Number(it.price || 0),
      })),
    }));
    const html = buildThermalHTML({
      restaurantName: restaurant?.name || 'Restaurant',
      gstin: restaurant?.gst_number,
      gstEnabled: applyGst,
      gstPercent: gstPct,
      billId: `TBL-${(session.session_token || '').slice(-6).toUpperCase()}`,
      tableName: table.name,
      customerName: session.customer_name || undefined,
      customerPhone: session.customer_phone || undefined,
      date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      time: dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      rounds: roundData,
      subtotal: rawSubtotal,
      discountAmount: discount > 0 ? discount : undefined,
      serviceChargeAmount: svcAmt > 0 ? svcAmt : undefined,
      serviceChargePercent: svcPct > 0 ? svcPct : undefined,
      gstAmount: gstAmt,
      total: grandTotal,
      paymentMethod: payMethod || session.payment_method || undefined,
      footerNote: 'Thank you for dining with us!',
    });
    openThermalPrint(html);
  };

  const handleCloseSession = async () => {
    if (!session || closing) return;
    setClosing(true);
    try {
      await persistAdjustments();
      const res = await fetch(`/api/restaurant/${restaurantId}/sessions/${session.session_token}/close`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ payment_method: payMethod, final_amount: grandTotal }),
      });
      if (!res.ok) throw new Error('Close failed');
      onClose(); // parent refreshes live tables via onClose callback
    } catch (err) {
      setClosing(false);
      setFetchErr('Failed to close session — please try again.');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.93, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.93, opacity: 0, y: 24 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden"
        style={{ maxHeight: '92vh' }}
      >
        {/* ── HEADER ── */}
        <div className="px-6 pt-5 pb-4 border-b border-[#cc5a16]/10 shrink-0 bg-gradient-to-r from-[#faf7f2] to-white">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-xl font-bold font-serif text-[#1a1208]">{table.name}</h3>
                {session && (
                  <span className={cn(
                    "text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full shrink-0",
                    session.status === 'bill_requested'
                      ? 'bg-orange-100 text-orange-700'
                      : 'bg-emerald-100 text-emerald-700'
                  )}>
                    {session.status === 'bill_requested' ? '⏳ Bill Requested' : '🟢 Open Session'}
                  </span>
                )}
              </div>
              {session?.customer_name && (
                <p className="text-sm text-[#6b5d52] mt-0.5 truncate">
                  👤 {session.customer_name}{session.customer_phone ? ` · ${session.customer_phone}` : ''}
                </p>
              )}
              {session?.opened_at && (
                <p className="text-xs text-[#9c8e85] mt-0.5">
                  Opened {safeFmt(session.opened_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {session.status === 'bill_requested' && session.payment_method
                    ? ` · Requested: ${session.payment_method}` : ''}
                </p>
              )}
            </div>
            <button onClick={onClose}
              className="p-2 hover:bg-[#faf7f2] rounded-xl text-[#9c8e85] hover:text-[#1a1208] transition-all shrink-0">
              <X size={20} />
            </button>
          </div>

          {/* Quick stats bar */}
          {!loading && session && orders.length > 0 && (
            <div className="mt-3 flex items-center gap-3">
              {[
                { label: 'Rounds',    value: totalRounds },
                { label: 'Items',     value: totalItems  },
                { label: 'Subtotal',  value: `₹${rawSubtotal.toFixed(2)}` },
                { label: 'Payable',   value: `₹${grandTotal.toFixed(2)}`, highlight: true },
                ...(cancelledCnt > 0 ? [{ label: 'Cancelled', value: cancelledCnt, cancelled: true }] : []),
              ].map(s => (
                <div key={s.label} className={cn(
                  "flex-1 rounded-xl px-2 py-1.5 text-center",
                  (s as any).cancelled ? 'bg-red-50 text-red-600'
                    : s.highlight ? 'bg-[#cc5a16] text-white'
                    : 'bg-[#faf7f2] text-[#1a1208]'
                )}>
                  <p className={cn("font-mono font-bold text-sm leading-none", s.highlight && "text-white", (s as any).cancelled && "text-red-600")}>
                    {s.value}
                  </p>
                  <p className={cn("text-[11px] uppercase tracking-widest mt-0.5", s.highlight ? 'text-white/70' : (s as any).cancelled ? 'text-red-400' : 'text-[#9c8e85]')}>
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── SCROLLABLE CONTENT ── */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="py-20 flex flex-col items-center gap-3">
              <Clock size={28} className="animate-spin text-[#cc5a16]" />
              <p className="text-sm text-[#9c8e85]">Loading session data…</p>
            </div>
          ) : fetchErr ? (
            <div className="py-20 text-center">
              <p className="text-red-500 text-sm font-medium">{fetchErr}</p>
              <button onClick={() => window.location.reload()} className="mt-3 text-xs text-[#cc5a16] underline">Retry</button>
            </div>
          ) : !session ? (
            <div className="py-20 text-center px-6">
              <p className="text-4xl mb-3">🪑</p>
              <p className="text-[#6b5d52] font-medium">No active session for {table.name}</p>
              <p className="text-[#9c8e85] text-sm mt-1">This table may already be closed or hasn't started yet.</p>
            </div>
          ) : orders.length === 0 ? (
            <div className="py-20 text-center px-6">
              <p className="text-4xl mb-3">📋</p>
              <p className="text-[#6b5d52] font-medium">Session active — no orders yet</p>
            </div>
          ) : (
            <div className="px-6 py-5 space-y-6">

              {/* ── ORDER ROUNDS ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">
                    Order Rounds ({totalRounds} active{cancelledCnt > 0 ? `, ${cancelledCnt} cancelled` : ''})
                  </p>
                  {cancelledCnt > 0 && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600 uppercase tracking-widest">
                      {cancelledCnt} excluded from bill
                    </span>
                  )}
                </div>
                <div className="space-y-2.5">
                  {orders.map((order: any, idx: number) => {
                    const isCancelled = order.status === 'CANCELLED';
                    const items       = Array.isArray(order.items) ? order.items : [];
                    const roundSub    = items.reduce((s: number, it: any) => s + Number(it.price || 0) * Number(it.quantity || 1), 0);
                    const isOpen      = expanded[idx] !== false;
                    const roundNum    = order.round_number || idx + 1;
                    return (
                      <div key={order.id || idx} className={cn("rounded-2xl border overflow-hidden", isCancelled ? "border-red-200 opacity-60" : "border-[#cc5a16]/10")}>
                        {/* Round header — clickable to collapse */}
                        <button
                          type="button"
                          onClick={() => setExpanded(prev => ({ ...prev, [idx]: !isOpen }))}
                          className={cn("w-full flex items-center justify-between px-4 py-3 transition-colors", isCancelled ? "bg-red-50 hover:bg-red-100/50" : "bg-[#faf7f2] hover:bg-[#f5ece0]")}
                        >
                          <div className="flex items-center gap-2.5">
                            <span className={cn("flex items-center justify-center h-6 w-6 rounded-full text-white text-[11px] font-black shrink-0", isCancelled ? "bg-red-400" : "bg-[#cc5a16]")}>
                              {roundNum}
                            </span>
                            <span className={cn("text-xs font-bold", isCancelled ? "text-red-500 line-through" : "text-[#3d3128]")}>
                              Round {roundNum}
                            </span>
                            {isCancelled ? (
                              <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-red-100 text-red-600 uppercase tracking-widest">Cancelled</span>
                            ) : (
                              <span className="text-[11px] text-[#9c8e85]">
                                {items.reduce((s: number, it: any) => s + Number(it.quantity || 1), 0)} item{items.length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={cn("font-mono font-bold text-sm", isCancelled ? "text-red-400 line-through" : "text-[#cc5a16]")}>
                              ₹{roundSub.toFixed(2)}
                            </span>
                            <ChevronDown size={14} className={cn(
                              "text-[#9c8e85] transition-transform duration-200",
                              !isOpen && "-rotate-90"
                            )} />
                          </div>
                        </button>

                        {/* Round items */}
                        {isOpen && (
                          <div className="divide-y divide-[#cc5a16]/5">
                            <div className="grid px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]"
                              style={{ gridTemplateColumns: '1fr auto auto' }}>
                              <span>Item</span>
                              <span className="text-right mr-4">Qty</span>
                              <span className="text-right">Amount</span>
                            </div>
                            {items.map((it: any, i: number) => (
                              <div key={i}
                                className="grid items-center px-4 py-2.5 text-sm"
                                style={{ gridTemplateColumns: '1fr auto auto' }}
                              >
                                <div className="pr-3 min-w-0">
                                  <span className="text-[#1a1208] font-medium leading-tight block truncate">{it.name}</span>
                                  {it.size && <span className="text-[#9c8e85] text-[11px] uppercase">{it.size}</span>}
                                </div>
                                <span className="text-[#9c8e85] text-xs font-mono text-right mr-4">×{it.quantity || 1}</span>
                                <span className="font-mono text-sm text-[#3d3128] text-right">
                                  ₹{(Number(it.price || 0) * Number(it.quantity || 1)).toFixed(2)}
                                </span>
                              </div>
                            ))}
                            <div className="flex justify-between items-center px-4 py-2 bg-[#faf7f2]/60">
                              <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Round Subtotal</span>
                              <span className="font-mono font-bold text-sm text-[#6b5d52]">₹{roundSub.toFixed(2)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* ── ADJUSTMENTS PANEL ── */}
              <section className="rounded-2xl border border-[#cc5a16]/15 overflow-hidden">
                <div className="px-4 py-3 bg-[#faf7f2] border-b border-[#cc5a16]/10 flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Bill Adjustments</p>
                  <p className="text-[11px] text-[#9c8e85]">Changes update the total live</p>
                </div>
                <div className="px-5 py-4 space-y-4">

                  {/* Subtotal row */}
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-[#6b5d52]">
                      Subtotal ({totalRounds} round{totalRounds !== 1 ? 's' : ''})
                    </span>
                    <span className="font-mono font-bold text-sm">₹{rawSubtotal.toFixed(2)}</span>
                  </div>

                  {/* Flat discount */}
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-sm text-[#3d3128] shrink-0">Discount (₹)</label>
                    <input
                      type="number" min="0" max={rawSubtotal} step="1"
                      value={discount || ''}
                      onChange={e => setDiscount(Math.max(0, Math.min(rawSubtotal, Number(e.target.value))))}
                      placeholder="0.00"
                      className="w-32 text-right bg-[#faf7f2] border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20"
                    />
                  </div>

                  {/* After discount */}
                  {discount > 0 && (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-[#9c8e85] flex items-center gap-1">
                        <ArrowDownCircle size={12} className="text-emerald-500" />
                        After Discount
                      </span>
                      <span className="font-mono text-emerald-600 font-medium">₹{afterDiscount.toFixed(2)}</span>
                    </div>
                  )}

                  {/* Service charge % */}
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-sm text-[#3d3128] shrink-0">Service Charge (%)</label>
                    <input
                      type="number" min="0" max="30" step="0.5"
                      value={svcPct || ''}
                      onChange={e => setSvcPct(Math.max(0, Math.min(30, Number(e.target.value))))}
                      placeholder="0"
                      className="w-32 text-right bg-[#faf7f2] border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20"
                    />
                  </div>
                  {svcAmt > 0 && (
                    <div className="flex justify-between items-center text-sm text-[#9c8e85]">
                      <span>Service Charge Amount</span>
                      <span className="font-mono">₹{svcAmt.toFixed(2)}</span>
                    </div>
                  )}

                  {/* GST toggle + % */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setApplyGst(!applyGst)}
                        className={cn(
                          "relative inline-flex h-5 w-9 rounded-full transition-colors",
                          applyGst ? 'bg-[#cc5a16]' : 'bg-[#0d0a07]/15'
                        )}
                      >
                        <span className={cn(
                          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5",
                          applyGst ? 'translate-x-4' : 'translate-x-0.5'
                        )} />
                      </button>
                      <label className="text-sm text-[#3d3128] cursor-pointer" onClick={() => setApplyGst(!applyGst)}>
                        Apply GST (%)
                      </label>
                    </div>
                    <input
                      type="number" min="0" max="28" step="0.5"
                      value={gstPct || ''}
                      onChange={e => setGstPct(Math.max(0, Math.min(28, Number(e.target.value))))}
                      disabled={!applyGst}
                      placeholder="5"
                      className="w-32 text-right bg-[#faf7f2] border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#cc5a16]/20 disabled:opacity-30 disabled:cursor-not-allowed"
                    />
                  </div>
                  {applyGst && gstAmt > 0 && (
                    <div className="flex justify-between items-center text-sm text-[#9c8e85]">
                      <span>GST @ {gstPct}%
                        {restaurant?.gst_number && (
                          <span className="ml-1 text-[11px]">· GSTIN: {restaurant.gst_number}</span>
                        )}
                      </span>
                      <span className="font-mono">₹{gstAmt.toFixed(2)}</span>
                    </div>
                  )}

                  {/* Grand total */}
                  <div className="pt-2 border-t border-[#cc5a16]/10">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-lg text-[#1a1208]">Grand Total</span>
                      <span className="font-mono font-black text-2xl text-[#cc5a16]">₹{grandTotal.toFixed(2)}</span>
                    </div>
                  </div>

                  {/* Save button */}
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className={cn(
                      "w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border",
                      saveDone
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        : 'bg-[#faf7f2] border-[#cc5a16]/20 text-[#cc5a16] hover:bg-[#cc5a16]/5'
                    )}
                  >
                    {saving ? '…Saving' : saveDone ? '✓ Adjustments Saved' : 'Save Adjustments'}
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>

        {/* ── FOOTER ACTIONS (only when session has orders) ── */}
        {!loading && session && orders.length > 0 && (
          <div className="px-6 py-4 border-t border-[#cc5a16]/10 space-y-3 shrink-0 bg-[#faf7f2]/40">

            {/* Payment method selector */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-2">Payment Method</p>
              <div className="grid grid-cols-3 gap-2">
                {(['CASH', 'CARD', 'UPI'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPayMethod(m)}
                    className={cn(
                      "py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                      payMethod === m
                        ? 'bg-[#cc5a16] text-white shadow-sm'
                        : 'bg-white border border-[#cc5a16]/15 text-[#6b5d52] hover:border-[#cc5a16]/30 hover:text-[#3d3128]'
                    )}
                  >
                    {m === 'CASH' ? '💵 Cash' : m === 'CARD' ? '💳 Card' : '📱 UPI'}
                  </button>
                ))}
              </div>
            </div>

            {/* Print + Close buttons */}
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                className="flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl border border-[#cc5a16]/20 text-[#cc5a16] text-xs font-bold uppercase tracking-widest hover:bg-[#cc5a16]/5 transition-all"
              >
                <Printer size={14} />
                Print
              </button>

              {!confirmClose ? (
                <button
                  onClick={() => setConfirmClose(true)}
                  className="flex-1 py-3 rounded-xl bg-[#cc5a16] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#a84612] active:scale-[0.98] transition-all shadow-sm"
                >
                  ✓ Mark Paid & Close Table
                </button>
              ) : (
                <button
                  onClick={handleCloseSession}
                  disabled={closing}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-60 active:scale-[0.98] transition-all shadow-sm"
                >
                  {closing ? '…Closing' : `✓ Confirm — ₹${grandTotal.toFixed(2)} via ${payMethod}`}
                </button>
              )}
            </div>

            {confirmClose && !closing && (
              <button
                onClick={() => setConfirmClose(false)}
                className="w-full text-center text-xs text-[#9c8e85] hover:text-[#6b5d52] transition-colors py-1"
              >
                ← Cancel
              </button>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// Keep alias for backward compat with call sites
const TableBillModal = PostpaidInvoiceModal;

function WaiterDashboard({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [activeTab, setActiveTab] = useState<'DASHBOARD' | 'ATTENDANCE'>('DASHBOARD');
  const [orders, setOrders] = useState<Order[]>([]);
  const [liveTables, setLiveTables] = useState<LiveTableView[]>([]);
  const [liveNow, setLiveNow] = useState(Date.now());
  const [waiterCalls, setWaiterCalls] = useState<any[]>([]);
  const [waiterOrderTable, setWaiterOrderTable] = useState<{ tableId: string; tableName: string } | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const { lastMessage: waiterMsg } = useSocket('WAITER', restaurantId);

  // Fetch restaurant settings (to honor alerts_enabled toggle)
  useEffect(() => {
    if (!restaurantId) return;
    fetch(`/api/restaurant/${restaurantId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setAlertsEnabled(data.alerts_enabled !== 0 && data.alerts_enabled !== false);
      })
      .catch(() => {});
  }, [restaurantId]);

  // Decode JWT to get current user's staff id
  const myId: string | null = (() => {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.id ?? null;
    } catch { return null; }
  })();

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchData();
    const interval = setInterval(fetchData, 30000);
    const clock    = setInterval(() => setLiveNow(Date.now()), 1000);
    return () => { clearInterval(interval); clearInterval(clock); };
  }, [restaurantId]);

  const fetchData = async () => {
    try {
      const [ordersRes, liveRes, callsRes] = await Promise.all([
        fetch(`/api/restaurant/${restaurantId}/orders`,            { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/restaurant/${restaurantId}/tables/live`,       { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/restaurant/${restaurantId}/waiter-calls`,      { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      if (ordersRes.ok) { const raw = await ordersRes.json(); setOrders(raw.map(normalizeOrder)); }
      if (liveRes.ok)   setLiveTables(await liveRes.json());
      if (callsRes.ok)  setWaiterCalls(await callsRes.json());
    } catch (err) {
      console.error(err);
    }
  };

  // Refresh on WAITER_CALL / WAITER_CALL_UPDATE WebSocket events
  useEffect(() => {
    if (waiterMsg?.type === 'WAITER_CALL' || waiterMsg?.type === 'WAITER_CALL_UPDATE') {
      fetchData();
    }
  }, [waiterMsg]);

  const updateTableStatus = async (tableId: string, status: TableStatus) => {
    try {
      await fetch(`/api/restaurant/${restaurantId}/tables/${tableId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status })
      });
      fetchData();
    } catch (err) { console.error(err); }
  };

  const patchWaiterCall = async (callId: string, body: Record<string, any>) => {
    await fetch(`/api/restaurant/${restaurantId}/waiter-calls/${callId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    fetchData();
  };

  const readyOrders = orders.filter(o => o.status === 'READY');
  // Only show tables assigned to me
  const myTables = myId ? liveTables.filter(t => t.assigned_waiter_id === myId) : [];
  // Show calls for my assigned tables OR calls explicitly assigned to me
  const myTableNames = myTables.map(t => t.name);
  const myWaiterCalls = waiterCalls.filter(c =>
    myTableNames.includes(c.table_number) || c.assigned_waiter_id === myId
  );

  // Audible + visual alert for any UN-acknowledged waiter call assigned to this waiter.
  // Also covers orders that are ready to serve (status === READY).
  const pendingMyCalls = myWaiterCalls.filter(c => c.status === 'pending').length;
  const pendingReadyOrders = readyOrders.length;
  const totalAlerts = pendingMyCalls + pendingReadyOrders;
  const alertLbl =
    pendingMyCalls > 0 ? `${pendingMyCalls} waiter call${pendingMyCalls === 1 ? '' : 's'}`
    : pendingReadyOrders > 0 ? `${pendingReadyOrders} order${pendingReadyOrders === 1 ? '' : 's'} ready`
    : 'Alert';
  useAlertChime(alertsEnabled && totalAlerts > 0, { label: alertLbl });

  return (
    <div className="space-y-8">
      <div className="flex border-b border-[#cc5a16]/10 mb-8 gap-8">
        <button 
          onClick={() => setActiveTab('DASHBOARD')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'DASHBOARD' ? "text-[#1a1208] border-b-2 border-[#cc5a16]" : "text-[#9c8e85]"
          )}
        >
          Waiter Dashboard
        </button>
        <button 
          onClick={() => setActiveTab('ATTENDANCE')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'ATTENDANCE' ? "text-[#1a1208] border-b-2 border-[#cc5a16]" : "text-[#9c8e85]"
          )}
        >
          Attendance
        </button>
      </div>

      {activeTab === 'DASHBOARD' ? (
        <div className="space-y-8">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Waiter Dashboard</h2>
            <div className="bg-green-100 text-green-700 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest">
              {readyOrders.length} Orders Ready for Pickup
            </div>
          </div>

          {/* ── Waiter Call Requests panel ── */}
          {myWaiterCalls.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Bell size={18} className="text-[#cc5a16] animate-pulse" />
                <h3 className="text-lg font-bold text-[#1a1208]">Customer Requests</h3>
                <span className="bg-[#cc5a16] text-white text-[11px] font-black px-2.5 py-0.5 rounded-full animate-pulse">
                  {myWaiterCalls.length}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {myWaiterCalls.map(call => {
                  const elapsed = Math.floor((Date.now() - new Date(call.created_at).getTime()) / 1000);
                  const elapsedStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed/60)}m ago`;
                  const isAck = call.status === 'acknowledged';
                  return (
                    <div key={call.id} className={cn(
                      "bg-white rounded-2xl border-2 p-4 space-y-3 shadow-sm",
                      isAck ? "border-[#5c7a5a]/30" : "border-[#cc5a16]/40"
                    )}>
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-bold text-[#1a1208]">{call.table_number}</p>
                          {call.customer_name && (
                            <p className="text-xs text-[#6b5d52]">{call.customer_name}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <span className={cn(
                            "text-[11px] font-bold uppercase tracking-widest px-2 py-1 rounded-full",
                            isAck ? "bg-[#5c7a5a]/10 text-[#5c7a5a]" : "bg-[#cc5a16]/10 text-[#cc5a16]"
                          )}>
                            {isAck ? '👋 On the way' : '🔔 Needs attention'}
                          </span>
                          <p className="text-[11px] text-[#9c8e85] font-mono mt-1">{elapsedStr}</p>
                        </div>
                      </div>
                      {call.note && (
                        <p className="text-xs text-[#6b5d52] bg-[#faf7f2] rounded-xl px-3 py-2 italic">"{call.note}"</p>
                      )}
                      <div className="flex gap-2">
                        {!isAck && (
                          <button
                            onClick={() => patchWaiterCall(call.id, { status: 'acknowledged', assigned_waiter_id: myId, assigned_waiter_name: localStorage.getItem('userName') || 'Waiter' })}
                            className="flex-1 py-2 rounded-xl bg-[#cc5a16] text-white text-xs font-bold transition-all hover:bg-[#a84612] active:scale-95"
                          >
                            👋 On My Way
                          </button>
                        )}
                        <button
                          onClick={() => patchWaiterCall(call.id, { status: 'resolved' })}
                          className="flex-1 py-2 rounded-xl bg-[#5c7a5a]/10 text-[#5c7a5a] text-xs font-bold border border-[#5c7a5a]/20 transition-all hover:bg-[#5c7a5a]/20 active:scale-95"
                        >
                          ✓ Resolved
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <h3 className="text-xl font-bold font-serif">Ready to Serve</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {readyOrders.map(order => (
                  <div key={order.id} className="bg-white p-6 rounded-[32px] border-2 border-green-200 shadow-sm space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-[11px] font-bold uppercase">Ready</span>
                      <span className="font-mono font-bold">{order.id}</span>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-[#1a1a1a]">{order.tableNumber}</p>
                      <p className="text-sm text-[#6b5d52]">{order.customerName}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className={cn(
                          "text-[11px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full",
                          order.paymentStatus === 'PAID' ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                        )}>
                          {order.paymentStatus === 'PAID' ? 'Paid' : 'Unpaid'}
                        </span>
                        <span className="text-[11px] font-bold uppercase tracking-widest px-2 py-0.5 bg-[#faf7f2] text-[#6b5d52] rounded-full">
                          {order.paymentMethod}
                        </span>
                      </div>
                      <div className="mt-3 space-y-1">
                        {(Array.isArray(order.items) ? order.items : []).map((item: any, idx: number) => (
                          <p key={idx} className="text-xs text-[#3d3128]">
                            <span className="font-bold">{item.quantity}x</span> {item.name}
                          </p>
                        ))}
                      </div>
                    </div>
                    <button 
                      onClick={async () => {
                        await fetch(`/api/orders/${order.id}`, {
                          method: 'PATCH',
                          headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                          },
                          body: JSON.stringify({ status: 'DELIVERED' })
                        });
                        fetchData();
                      }}
                      className="w-full bg-green-600 text-white py-4 rounded-2xl font-bold hover:bg-green-700 transition-all"
                    >
                      Mark as Delivered
                    </button>
                  </div>
                ))}
                {readyOrders.length === 0 && (
                  <div className="col-span-full p-12 text-center bg-white rounded-[32px] border border-dashed border-[#cc5a16]/20">
                    <p className="text-[#9c8e85] italic">No orders ready for pickup right now.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-6">
              <h3 className="text-xl font-bold font-serif">My Tables</h3>
              {myTables.length === 0 ? (
                <div className="p-8 text-center bg-white rounded-3xl border border-dashed border-[#cc5a16]/20">
                  <p className="text-[#9c8e85] text-sm italic">No tables assigned to you yet.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {myTables.map(t => {
                    const isOccupied = t.status === 'OCCUPIED';
                    const isUnavail  = t.status === 'NOT_AVAILABLE';
                    const elapsedMs  = t.session_opened_at ? liveNow - new Date(t.session_opened_at).getTime() : 0;
                    const timerStr   = isOccupied && t.session_opened_at
                      ? `${String(Math.floor(elapsedMs/60000)).padStart(2,'0')}:${String(Math.floor((elapsedMs%60000)/1000)).padStart(2,'0')}`
                      : null;

                    return (
                      <div key={t.id} className={cn(
                        "bg-white p-4 rounded-2xl border space-y-3",
                        isOccupied ? "border-amber-200" : isUnavail ? "border-red-200" : "border-[#cc5a16]/10"
                      )}>
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-[#1a1a1a]">{t.name}</span>
                          <span className={cn(
                            "text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full",
                            isOccupied ? "bg-amber-100 text-amber-700"
                            : isUnavail ? "bg-red-100 text-red-700"
                            : "bg-emerald-100 text-emerald-700"
                          )}>
                            {isOccupied ? 'Occupied' : isUnavail ? 'N/A' : 'Free'}
                          </span>
                        </div>
                        {isOccupied && t.customer_name && (
                          <div className="flex justify-between text-xs text-[#3d3128]">
                            <span>{t.customer_name}</span>
                            {timerStr && <span className="font-mono font-bold text-amber-600">{timerStr}</span>}
                          </div>
                        )}
                        {t.session_status === 'bill_requested' && (
                          <div className="bg-orange-50 text-orange-700 text-[11px] font-bold uppercase tracking-widest px-2 py-1.5 rounded-xl text-center">
                            ⚑ Bill Requested
                          </div>
                        )}
                        {/* Status toggle */}
                        <div className="flex gap-1.5">
                          {(['AVAILABLE','OCCUPIED','NOT_AVAILABLE'] as TableStatus[]).map(st => (
                            <button
                              key={st}
                              onClick={() => updateTableStatus(t.id, st)}
                              disabled={t.status === st}
                              className={cn(
                                "flex-1 py-1.5 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
                                t.status === st
                                  ? st === 'AVAILABLE'  ? 'bg-emerald-500 text-white'
                                    : st === 'OCCUPIED' ? 'bg-amber-500 text-white'
                                    : 'bg-red-500 text-white'
                                  : 'bg-[#cc5a16]/5 text-[#6b5d52] hover:bg-[#cc5a16]/10'
                              )}
                            >
                              {st === 'AVAILABLE' ? 'Free' : st === 'OCCUPIED' ? 'Busy' : 'N/A'}
                            </button>
                          ))}
                        </div>

                        {/* Manage Table — open ordering panel on behalf of customer */}
                        <button
                          onClick={() => setWaiterOrderTable({ tableId: t.id, tableName: t.name })}
                          className="w-full py-2 bg-[#cc5a16] text-white rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-[#a84612] transition-all active:scale-95"
                        >
                          🧾 Manage Table
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <AttendanceManagement role="WAITER" token={token} restaurantId={restaurantId} />
      )}

      {/* Waiter Order Panel — full-screen overlay for managing a table */}
      <AnimatePresence>
        {waiterOrderTable && (
          <WaiterOrderPanel
            restaurantId={restaurantId}
            tableId={waiterOrderTable.tableId}
            tableName={waiterOrderTable.tableName}
            onClose={() => { setWaiterOrderTable(null); fetchData(); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function CustomerReservationView({ restaurantId, onBack }: { restaurantId: string; onBack: () => void }) {
  const [step, setStep] = useState<'PICK' | 'DETAILS' | 'SUCCESS'>('PICK');
  const todayStr = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [slots, setSlots] = useState<any[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsFetched, setSlotsFetched] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [guests, setGuests] = useState(2);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [booking, setBooking] = useState(false);
  const [bookingRef, setBookingRef] = useState('');

  // Auto-fetch slots whenever date changes
  useEffect(() => {
    if (!selectedDate) return;
    setSlotsFetched(false);
    setSelectedSlot('');
    setSlots([]);
    setSlotsLoading(true);
    fetch(`/api/public/restaurants/${restaurantId}/slots?date=${selectedDate}`)
      .then(r => r.ok ? r.json() : { slots: [] })
      .then(data => { setSlots(data.slots || []); setSlotsFetched(true); })
      .catch(() => { setSlotsFetched(true); })
      .finally(() => setSlotsLoading(false));
  }, [selectedDate, restaurantId]);

  const handleBook = async () => {
    setBooking(true);
    try {
      const res = await fetch(`/api/public/restaurants/${restaurantId}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: form.name,
          customerPhone: form.phone,
          customerEmail: form.email || undefined,
          bookingDate: selectedDate,
          bookingTime: selectedSlot,
          guests
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBookingRef(data.id ? String(data.id).slice(-6).toUpperCase() : 'CONFIRMED');
        setStep('SUCCESS');
      } else {
        alert(data.error || 'Booking failed. Please try again.');
      }
    } catch { alert('Booking failed. Please try again.'); }
    finally { setBooking(false); }
  };

  const displayDate = selectedDate
    ? new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="p-2 hover:bg-black/5 rounded-full transition-colors">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h2 className="text-2xl font-serif font-bold">Reserve a Table</h2>
          <p className="text-[#6b5d52] text-sm">Pick a date and time to get started</p>
        </div>
      </div>

      {/* ── Step 1: Pick date + slot ── */}
      {step === 'PICK' && (
        <>
          {/* Date + guests card */}
          <div className="bg-white rounded-3xl p-5 border border-black/5 shadow-sm space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Date</label>
                <input
                  type="date"
                  min={todayStr}
                  value={selectedDate}
                  onChange={e => setSelectedDate(e.target.value)}
                  onInput={e => setSelectedDate((e.target as HTMLInputElement).value)}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Guests</label>
                <div className="flex items-center gap-2 bg-[#faf7f2] px-3 py-2 rounded-2xl h-[46px]">
                  <button onClick={() => setGuests(Math.max(1, guests - 1))} className="p-1 hover:bg-white rounded-lg"><Minus size={14}/></button>
                  <span className="flex-1 text-center font-bold text-sm">{guests}</span>
                  <button onClick={() => setGuests(guests + 1)} className="p-1 hover:bg-white rounded-lg"><Plus size={14}/></button>
                </div>
              </div>
            </div>
          </div>

          {/* Slot list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">
                Available Times
              </label>
              {selectedDate && (
                <span className="text-[11px] text-[#9c8e85] font-medium">{displayDate}</span>
              )}
            </div>

            {slotsLoading ? (
              <div className="bg-white rounded-2xl p-8 border border-black/5 text-center text-[#9c8e85] text-sm">
                Checking availability…
              </div>
            ) : !slotsFetched ? (
              <div className="bg-white rounded-2xl p-8 border border-black/5 text-center text-[#9c8e85] text-sm">
                Select a date to see available times
              </div>
            ) : slots.length === 0 ? (
              <div className="bg-white rounded-3xl p-8 border border-black/5 text-center">
                <Calendar size={32} className="mx-auto text-[#c5b9b2] mb-3" />
                <p className="text-[#6b5d52] font-medium text-sm">No slots available on this date.</p>
                <p className="text-[#9c8e85] text-xs mt-1">Please try a different date.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {slots.map((slot: any) => {
                  const isSel = selectedSlot === slot.time;
                  const isLow = slot.available && slot.remaining <= 3;
                  return (
                    <button
                      key={slot.time}
                      onClick={() => slot.available && setSelectedSlot(slot.time === selectedSlot ? '' : slot.time)}
                      disabled={!slot.available}
                      className={cn(
                        "w-full flex items-center justify-between px-5 py-4 rounded-2xl border-2 transition-all",
                        !slot.available
                          ? "border-black/5 bg-white opacity-40 cursor-not-allowed"
                          : isSel
                          ? "border-[#cc5a16] bg-[#cc5a16] text-white shadow-lg scale-[1.01]"
                          : "border-transparent bg-white hover:border-[#cc5a16]/20 hover:bg-[#faf7f2]"
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center", isSel ? "bg-white/20" : "bg-[#cc5a16]/5")}>
                          <Clock size={16} className={isSel ? "text-white" : "text-[#6b5d52]"} />
                        </div>
                        <span className="font-bold">{slot.time}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {slot.available ? (
                          <span className={cn(
                            "text-xs font-bold px-2.5 py-1 rounded-full",
                            isSel ? "bg-white/20 text-white" :
                            isLow ? "bg-orange-100 text-orange-600" :
                            "bg-green-100 text-green-600"
                          )}>
                            {slot.remaining} {slot.remaining === 1 ? 'table' : 'tables'} left
                          </span>
                        ) : (
                          <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-500">Full</span>
                        )}
                        {isSel && <Check size={18} className="text-white" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button
            onClick={() => setStep('DETAILS')}
            disabled={!selectedSlot}
            className="w-full bg-[#1a1a1a] text-white py-4 rounded-2xl font-bold disabled:opacity-30 hover:scale-[1.02] transition-transform"
          >
            Continue →
          </button>
        </>
      )}

      {/* ── Step 2: Details ── */}
      {step === 'DETAILS' && (
        <>
          <button onClick={() => setStep('PICK')} className="flex items-center gap-2 text-sm text-[#3d3128] hover:text-[#1a1208] font-medium">
            <ChevronLeft size={16} /> Change date or time
          </button>

          {/* Summary banner */}
          <div className="bg-[#cc5a16] text-white rounded-3xl p-5 flex items-center justify-between">
            <div>
              <p className="text-white/50 text-[11px] font-bold uppercase tracking-widest mb-1">Your Reservation</p>
              <p className="font-bold text-lg font-serif">
                {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </p>
              <p className="text-white/70 text-sm">{selectedSlot} · {guests} {guests === 1 ? 'guest' : 'guests'}</p>
            </div>
            <CalendarCheck size={36} className="text-white/20" />
          </div>

          {/* Form */}
          <div className="bg-white rounded-3xl p-6 border border-black/5 shadow-sm space-y-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Your Details</p>
            {([
              { label: 'Full Name *', key: 'name', type: 'text', placeholder: 'John Doe' },
              { label: 'Phone Number *', key: 'phone', type: 'tel', placeholder: '+91 98765 43210' },
              { label: 'Email (optional)', key: 'email', type: 'email', placeholder: 'john@example.com' },
            ] as const).map(f => (
              <div key={f.key} className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">{f.label}</label>
                <input
                  type={f.type} placeholder={f.placeholder}
                  value={form[f.key]}
                  onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>
            ))}
          </div>

          <button
            onClick={handleBook}
            disabled={booking || !form.name || !form.phone}
            className="w-full bg-[#1a1a1a] text-white py-4 rounded-2xl font-bold disabled:opacity-30 hover:scale-[1.02] transition-transform"
          >
            {booking ? 'Confirming…' : 'Confirm Reservation'}
          </button>
        </>
      )}

      {/* ── Step 3: Success ── */}
      {step === 'SUCCESS' && (
        <div className="text-center py-10">
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6"
          >
            <CheckCircle2 size={48} />
          </motion.div>
          <h3 className="text-2xl font-serif font-bold mb-2">All Set!</h3>
          <p className="text-[#6b5d52] text-sm mb-1">Booking Reference</p>
          <p className="text-3xl font-bold text-[#1a1208] mb-4">#{bookingRef}</p>
          <div className="bg-[#cc5a16]/5 rounded-2xl p-4 mb-8 inline-block min-w-[200px]">
            <p className="font-bold text-[#1a1208]">
              {new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}
            </p>
            <p className="text-[#6b5d52] text-sm">{selectedSlot} · {guests} {guests === 1 ? 'guest' : 'guests'}</p>
          </div>
          <button
            onClick={onBack}
            className="w-full bg-[#1a1a1a] text-white py-4 rounded-2xl font-bold hover:scale-[1.02] transition-transform"
          >
            Back to Menu
          </button>
        </div>
      )}
    </div>
  );
}

function BookingsManagement({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [bookings, setBookings] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<'RESERVATIONS' | 'AVAILABILITY'>('RESERVATIONS');
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'TODAY' | 'UPCOMING' | 'PENDING' | 'CONFIRMED' | 'CANCELLED'>('ALL');
  const [bookingSearch, setBookingSearch] = useState('');
  const [bookingSort, setBookingSort]     = useState<{col: string; dir: 'asc'|'desc'}>({col: 'booking_date', dir: 'asc'});
  const [bookingPage, setBookingPage]     = useState(1);
  const [showNewBooking, setShowNewBooking] = useState(false);

  // Availability calendar month navigation
  const _now = new Date();
  const [availMonth, setAvailMonth] = useState({ year: _now.getFullYear(), month: _now.getMonth() });

  // Slot helpers
  const DEFAULT_SLOTS: Array<{ time: string; max_tables: number }> = [
    { time: '12:00', max_tables: 10 }, { time: '13:00', max_tables: 10 }, { time: '14:00', max_tables: 10 },
    { time: '19:00', max_tables: 10 }, { time: '20:00', max_tables: 10 }, { time: '21:00', max_tables: 10 },
  ];
  const parseTimeSlots = (raw: string, defaultMax: number): Array<{ time: string; max_tables: number }> => {
    try {
      const parsed = JSON.parse(raw || '[]');
      if (!Array.isArray(parsed) || !parsed.length) return [];
      return parsed.map((s: any) =>
        typeof s === 'string' ? { time: s, max_tables: defaultMax } : { time: String(s.time || ''), max_tables: Number(s.max_tables ?? defaultMax) }
      );
    } catch { return []; }
  };

  // Config edit panel state
  const [configDate, setConfigDate] = useState(new Date().toISOString().split('T')[0]);
  const [configForm, setConfigForm] = useState<{ max_tables: number; time_slots: Array<{ time: string; max_tables: number }>; is_open: boolean; notes: string }>({
    max_tables: 10, time_slots: DEFAULT_SLOTS, is_open: true, notes: ''
  });
  const [savingConfig, setSavingConfig] = useState(false);
  const [deletingConfig, setDeletingConfig] = useState(false);

  // Bulk apply state
  const [bulkForm, setBulkForm] = useState({
    from_date: new Date().toISOString().split('T')[0],
    to_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    day_of_week: [0, 1, 2, 3, 4, 5, 6] as number[],
    max_tables: 10,
    time_slots: '12:00, 13:00, 14:00, 19:00, 20:00, 21:00',
    is_open: true,
  });
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  // New booking form state
  const [nbForm, setNbForm] = useState({ customer_name: '', customer_phone: '', customer_email: '', booking_date: new Date().toISOString().split('T')[0], booking_time: '19:00', guests: 2, notes: '' });
  const [savingBooking, setSavingBooking] = useState(false);

  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => { fetchBookings(); fetchConfigs(); }, []);

  const fetchBookings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/bookings', { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) setBookings(await res.json());
    } catch {} finally { setLoading(false); }
  };

  const fetchConfigs = async () => {
    try {
      const res = await fetch('/api/owner/reservation-config', { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) setConfigs(await res.json());
    } catch {}
  };

  // Sync config form when configDate or configs change
  useEffect(() => {
    const existing = configs.find(c => String(c.config_date).slice(0, 10) === configDate);
    if (existing) {
      const defaultMax = existing.max_tables ?? 10;
      const slots = parseTimeSlots(existing.time_slots || '[]', defaultMax);
      setConfigForm({
        max_tables: defaultMax,
        time_slots: slots.length ? slots : DEFAULT_SLOTS.map(s => ({ ...s, max_tables: defaultMax })),
        is_open: !!existing.is_open,
        notes: existing.notes || ''
      });
    } else {
      setConfigForm({ max_tables: 10, time_slots: DEFAULT_SLOTS, is_open: true, notes: '' });
    }
  }, [configDate, configs]);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const computedMax = configForm.time_slots.length
        ? Math.max(...configForm.time_slots.map(s => s.max_tables), 1)
        : configForm.max_tables;
      await fetch(`/api/owner/reservation-config/${configDate}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ max_tables: computedMax, time_slots: configForm.time_slots, is_open: configForm.is_open ? 1 : 0, notes: configForm.notes })
      });
      await fetchConfigs();
    } finally { setSavingConfig(false); }
  };

  const deleteConfig = async () => {
    if (!window.confirm(`Remove availability config for ${configDate}?`)) return;
    setDeletingConfig(true);
    try {
      await fetch(`/api/owner/reservation-config/${configDate}`, { method: 'DELETE', headers: authHeaders });
      await fetchConfigs();
    } finally { setDeletingConfig(false); }
  };

  const bulkApply = async () => {
    setBulkApplying(true);
    setBulkResult(null);
    try {
      const slotTimes = bulkForm.time_slots.split(',').map(s => s.trim()).filter(Boolean);
      const slots = slotTimes.map(time => ({ time, max_tables: bulkForm.max_tables }));
      const res = await fetch('/api/owner/reservation-config/bulk', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          from_date: bulkForm.from_date,
          to_date: bulkForm.to_date,
          day_of_week: bulkForm.day_of_week,
          max_tables: bulkForm.max_tables,
          time_slots: slots,
          is_open: bulkForm.is_open ? 1 : 0,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBulkResult(`✓ Applied to ${data.days_updated} day(s)`);
        await fetchConfigs();
      } else {
        setBulkResult(`✗ ${data.error || 'Failed'}`);
      }
    } finally { setBulkApplying(false); }
  };

  const createBooking = async () => {
    if (!nbForm.customer_name || !nbForm.customer_phone || !nbForm.booking_date || !nbForm.booking_time || !nbForm.guests) {
      alert('Please fill in all required fields.');
      return;
    }
    setSavingBooking(true);
    try {
      const res = await fetch('/api/owner/bookings', {
        method: 'POST', headers: authHeaders, body: JSON.stringify(nbForm)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShowNewBooking(false);
        setNbForm({ customer_name: '', customer_phone: '', customer_email: '', booking_date: new Date().toISOString().split('T')[0], booking_time: '19:00', guests: 2, notes: '' });
        setTimeout(() => fetchBookings(), 100);
      } else {
        alert(data.error || 'Failed to create booking');
      }
    } finally { setSavingBooking(false); }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await fetch(`/api/owner/bookings/${id}/status`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ status })
      });
      fetchBookings();
    } catch {}
  };

  // Calendar cells memoised per month + configs
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const calendarCells = useMemo(() => {
    const { year, month } = availMonth;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const configMap = new Map(configs.map(c => [String(c.config_date).slice(0, 10), c]));
    const cells: Array<{ date: string | null; config: any }> = [];
    for (let i = 0; i < firstDay; i++) cells.push({ date: null, config: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ date: dateStr, config: configMap.get(dateStr) || null });
    }
    return cells;
  }, [availMonth, configs]);

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const todayCount = bookings.filter(b => String(b.booking_date).slice(0, 10) === today && b.status !== 'CANCELLED').length;
  const tomorrowCount = bookings.filter(b => String(b.booking_date).slice(0, 10) === tomorrow && b.status !== 'CANCELLED').length;
  const pendingCount = bookings.filter(b => b.status === 'PENDING').length;
  const monthCount = bookings.filter(b => String(b.booking_date).slice(0, 7) === today.slice(0, 7) && b.status !== 'CANCELLED').length;

  const filteredBookings = bookings.filter(b => {
    const bd = String(b.booking_date).slice(0, 10);
    if (activeFilter === 'TODAY') return bd === today;
    if (activeFilter === 'UPCOMING') return bd >= today && b.status !== 'CANCELLED';
    if (activeFilter === 'PENDING') return b.status === 'PENDING';
    if (activeFilter === 'CONFIRMED') return b.status === 'CONFIRMED';
    if (activeFilter === 'CANCELLED') return b.status === 'CANCELLED';
    return true;
  });

  const statusColors: Record<string, string> = {
    PENDING: 'bg-yellow-100 text-yellow-700',
    CONFIRMED: 'bg-green-100 text-green-700',
    CANCELLED: 'bg-red-100 text-red-600',
  };

  const existingConfig = configs.find(c => String(c.config_date).slice(0, 10) === configDate);

  return (
    <div className="space-y-6">
      {/* Header with section tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-wrap">
          <h2 className="text-2xl font-serif font-bold">Table Reservations</h2>
          {/* Section tab pills */}
          <div className="flex bg-[#faf7f2] rounded-2xl p-1 gap-1">
            {(([
              { id: 'RESERVATIONS' as const, label: 'Reservations', icon: <CalendarCheck size={14} /> },
              { id: 'AVAILABILITY' as const, label: 'Availability', icon: <Calendar size={14} /> },
            ])).map(s => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all",
                  activeSection === s.id ? "bg-[#cc5a16] text-white shadow-sm" : "text-[#6b5d52] hover:text-[#1a1208]"
                )}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { fetchBookings(); fetchConfigs(); }} className="p-2 hover:bg-black/5 rounded-full transition-colors" title="Refresh">
            <RefreshCw size={20} />
          </button>
          {activeSection === 'RESERVATIONS' && (
            <button
              onClick={() => setShowNewBooking(true)}
              className="flex items-center gap-2 bg-[#cc5a16] text-white px-4 py-2 rounded-xl text-sm font-bold hover:scale-105 transition-transform"
            >
              <Plus size={16} /> New Booking
            </button>
          )}
        </div>
      </div>

      {/* ── RESERVATIONS SECTION ── */}
      {activeSection === 'RESERVATIONS' && (
        <div className="space-y-6">
          {/* Stats row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Today's Bookings", value: todayCount, icon: <Calendar size={20} /> },
              { label: "Tomorrow", value: tomorrowCount, icon: <CalendarCheck size={20} /> },
              { label: "Pending Approval", value: pendingCount, icon: <Clock size={20} /> },
              { label: "This Month", value: monthCount, icon: <Users size={20} /> },
            ].map(stat => (
              <div key={stat.label} className="bg-white rounded-2xl p-5 border border-black/5 shadow-sm flex items-center gap-4">
                <div className="p-3 bg-[#cc5a16]/10 text-[#1a1208] rounded-xl">{stat.icon}</div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">{stat.label}</p>
                  <p className="text-2xl font-bold text-[#1a1208]">{stat.value}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9c8e85] pointer-events-none" />
            <input type="text" placeholder="Search by customer name, phone, email…"
              value={bookingSearch} onChange={e => { setBookingSearch(e.target.value); setBookingPage(1); }}
              className="w-full bg-white border border-black/5 rounded-2xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20 shadow-sm" />
          </div>

          {/* Filter tabs */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(['ALL', 'TODAY', 'UPCOMING', 'PENDING', 'CONFIRMED', 'CANCELLED'] as const).map(f => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={cn(
                  "px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all",
                  activeFilter === f ? "bg-[#cc5a16] text-white" : "bg-white text-[#1a1208] border border-black/5 hover:bg-[#cc5a16]/5"
                )}
              >
                {f === 'ALL' ? 'All' : f === 'TODAY' ? 'Today' : f === 'UPCOMING' ? 'Upcoming' : f.charAt(0) + f.slice(1).toLowerCase()}
                {f === 'PENDING' && pendingCount > 0 && (
                  <span className="ml-1.5 bg-yellow-400 text-yellow-900 text-[11px] font-black px-1.5 py-0.5 rounded-full">{pendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* Bookings table — full width */}
          <div className="bg-white rounded-3xl overflow-hidden border border-black/5 shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-[#faf7f2] text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">
                    {([
                      { col: 'customer_name', label: 'Customer' },
                      { col: 'booking_date',  label: 'Date & Time' },
                      { col: 'guests',        label: 'Guests' },
                    ] as const).map(({ col, label }) => (
                      <th key={col} onClick={() => {
                        setBookingSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }));
                        setBookingPage(1);
                      }} className="px-5 py-4 cursor-pointer select-none hover:text-[#cc5a16] transition-colors">
                        <span className="flex items-center gap-1">{label}
                          {bookingSort.col === col ? <span className="text-[#cc5a16]">{bookingSort.dir === 'asc' ? '↑' : '↓'}</span> : <span className="opacity-30">↕</span>}
                        </span>
                      </th>
                    ))}
                    <th className="px-5 py-4">Source</th>
                    <th className="px-5 py-4">Status</th>
                    <th className="px-5 py-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5">
                  {(() => {
                    const q = bookingSearch.toLowerCase();
                    const searched = filteredBookings.filter(b =>
                      !q || (b.customer_name||'').toLowerCase().includes(q) ||
                      (b.customer_phone||'').includes(q) || (b.customer_email||'').toLowerCase().includes(q)
                    );
                    const sorted = [...searched].sort((a, b) => {
                      const col = bookingSort.col;
                      const va = (a as any)[col] ?? '';
                      const vb = (b as any)[col] ?? '';
                      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
                      return bookingSort.dir === 'asc' ? cmp : -cmp;
                    });
                    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
                    const safePage   = Math.min(bookingPage, totalPages);
                    const pageRows   = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
                    return pageRows.map(booking => (
                    <tr key={booking.id} className="hover:bg-[#faf7f2]/40 transition-colors">
                      <td className="px-5 py-4">
                        <p className="font-bold text-sm">{booking.customer_name}</p>
                        <p className="text-xs text-[#6b5d52]">{booking.customer_phone}</p>
                        {booking.customer_email && <p className="text-xs text-[#9c8e85]">{booking.customer_email}</p>}
                      </td>
                      <td className="px-5 py-4">
                        <p className="text-sm font-bold">{String(booking.booking_date).slice(0, 10)}</p>
                        <p className="text-xs text-[#6b5d52]">{String(booking.booking_time).slice(0, 5)}</p>
                      </td>
                      <td className="px-5 py-4 font-bold text-sm">{booking.guests}</td>
                      <td className="px-5 py-4">
                        <span className={cn(
                          "px-2 py-1 rounded-full text-[11px] font-bold uppercase",
                          booking.booked_by ? "bg-blue-100 text-blue-600" : "bg-[#cc5a16]/10 text-[#1a1208]"
                        )}>
                          {booking.booked_by ? 'Staff' : 'Online'}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={cn("px-3 py-1 rounded-full text-[11px] font-bold uppercase", statusColors[booking.status] || "bg-gray-100 text-gray-600")}>
                          {booking.status}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex gap-1">
                          {booking.status === 'PENDING' && (
                            <>
                              <button onClick={() => updateStatus(booking.id, 'CONFIRMED')} className="p-2 hover:bg-green-50 text-green-500 rounded-xl transition-colors" title="Confirm">
                                <Check size={15} />
                              </button>
                              <button onClick={() => updateStatus(booking.id, 'CANCELLED')} className="p-2 hover:bg-red-50 text-red-400 rounded-xl transition-colors" title="Cancel">
                                <X size={15} />
                              </button>
                            </>
                          )}
                          {booking.status === 'CONFIRMED' && (
                            <button onClick={() => updateStatus(booking.id, 'CANCELLED')} className="p-2 hover:bg-red-50 text-red-400 rounded-xl transition-colors" title="Cancel">
                              <X size={15} />
                            </button>
                          )}
                          {booking.status === 'CANCELLED' && (
                            <button onClick={() => updateStatus(booking.id, 'CONFIRMED')} className="p-2 hover:bg-green-50 text-green-500 rounded-xl transition-colors" title="Re-confirm">
                              <Check size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    ));
                  })()}
                </tbody>
              </table>
              {filteredBookings.length === 0 && !loading && (
                <div className="py-16 text-center">
                  <Calendar size={40} className="mx-auto text-[#c5b9b2] mb-3" />
                  <p className="text-[#6b5d52] font-medium">No bookings found.</p>
                </div>
              )}
            </div>
            {(() => {
              const q = bookingSearch.toLowerCase();
              const searched = filteredBookings.filter(b =>
                !q || (b.customer_name||'').toLowerCase().includes(q) || (b.customer_phone||'').includes(q)
              );
              const totalPages = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
              return <PaginationBar page={Math.min(bookingPage, totalPages)} totalPages={totalPages} setPage={setBookingPage} total={searched.length} />;
            })()}
            <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
          </div>
        </div>
      )}

      {/* ── AVAILABILITY SECTION ── */}
      {activeSection === 'AVAILABILITY' && (
        <div className="space-y-6">
          {/* Calendar + Edit panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Monthly calendar — 2/3 */}
            <div className="lg:col-span-2 bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
              {/* Calendar header */}
              <div className="bg-gradient-to-r from-[#5A5A40] to-[#7a7a58] px-6 py-4 flex items-center justify-between">
                <button
                  onClick={() => setAvailMonth(m => { const d = new Date(m.year, m.month - 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
                  className="p-2 hover:bg-white/10 rounded-xl transition-colors text-white"
                >
                  <ChevronLeft size={18} />
                </button>
                <div className="text-center">
                  <h3 className="font-bold font-serif text-lg text-white">{MONTH_NAMES[availMonth.month]} {availMonth.year}</h3>
                  <p className="text-white/60 text-[11px] mt-0.5">Click any date to configure</p>
                </div>
                <button
                  onClick={() => setAvailMonth(m => { const d = new Date(m.year, m.month + 1, 1); return { year: d.getFullYear(), month: d.getMonth() }; })}
                  className="p-2 hover:bg-white/10 rounded-xl transition-colors text-white"
                >
                  <ChevronRight size={18} />
                </button>
              </div>

              <div className="p-5 space-y-3">
              {/* Day-of-week headers */}
              <div className="grid grid-cols-7 text-center">
                {DAY_HEADERS.map(d => (
                  <div key={d} className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] py-1">{d}</div>
                ))}
              </div>

              {/* Calendar cells */}
              <div className="grid grid-cols-7 gap-1">
                {calendarCells.map((cell, i) => {
                  if (!cell.date) return <div key={`empty-${i}`} />;
                  const isToday = cell.date === today;
                  const isSelected = cell.date === configDate;
                  const cfg = cell.config;
                  // is_open may come back as integer (0/1) or boolean (false/true) depending on DB driver
                  const isClosed = cfg && !cfg.is_open;   // falsy: 0, false, null, undefined → closed
                  const isOpen   = cfg && !!cfg.is_open;  // truthy: 1, true → open
                  const dayNum = new Date(cell.date + 'T12:00:00').getDate();

                  // Count slots stored for this day
                  let slotCount = 0;
                  if (isOpen && cfg.time_slots) {
                    try { slotCount = JSON.parse(cfg.time_slots || '[]').length; } catch {}
                  }

                  // Use inline styles for background/border to bypass Tailwind v4 oklch color issues
                  const cellStyle: React.CSSProperties = isSelected
                    ? { backgroundColor: 'rgba(90,90,64,0.12)', borderColor: 'rgba(90,90,64,0.35)' }
                    : isClosed
                      ? { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' }
                      : isOpen
                        ? { backgroundColor: '#D1FAE5', borderColor: '#6EE7B7' }
                        : { borderColor: 'transparent' };

                  return (
                    <button
                      key={cell.date}
                      onClick={() => setConfigDate(cell.date!)}
                      className={cn(
                        "rounded-xl p-1 text-center transition-all min-h-[64px] flex flex-col items-center justify-start pt-1.5 relative border",
                        isSelected ? "ring-2 ring-offset-1 ring-[#cc5a16]" : ""
                      )}
                      style={cellStyle}
                    >
                      <span className={cn(
                        "text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full mb-1 flex-shrink-0",
                        isToday
                          ? "bg-[#cc5a16] text-white shadow-sm"
                          : isClosed
                            ? "text-red-700"
                            : isOpen
                              ? "text-emerald-800"
                              : "text-[#3d3128]"
                      )}>
                        {dayNum}
                      </span>
                      {isClosed ? (
                        <span style={{ backgroundColor: '#DC2626', color: 'white', fontSize: '9px', borderRadius: '4px', padding: '1px 4px', fontWeight: 'bold', width: '100%', textAlign: 'center', display: 'block', lineHeight: '1.4' }}>
                          ✕ Closed
                        </span>
                      ) : isOpen ? (
                        <span style={{ backgroundColor: '#059669', color: 'white', fontSize: '9px', borderRadius: '4px', padding: '1px 4px', fontWeight: 'bold', width: '100%', textAlign: 'center', display: 'block', lineHeight: '1.4' }}>
                          {slotCount > 0 ? `${slotCount} slot${slotCount !== 1 ? 's' : ''}` : `${cfg.max_tables}T`}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-black/5">
                <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d52] font-medium">
                  <span className="w-3 h-3 rounded bg-emerald-500 inline-block" />
                  Open
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d52] font-medium">
                  <span className="w-3 h-3 rounded bg-red-500 inline-block" />
                  Closed
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d52] font-medium">
                  <span className="w-3 h-3 rounded-full bg-[#cc5a16] inline-block" />
                  Today
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d52] font-medium">
                  <span className="w-3 h-3 rounded border-2 border-[#cc5a16] inline-block" />
                  Selected
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d52] font-medium">
                  <span className="w-3 h-3 rounded bg-[#faf7f2] border border-black/10 inline-block" />
                  No Config
                </span>
              </div>
              </div>{/* /p-5 space-y-3 */}
            </div>

            {/* Edit panel — 1/3 */}
            <div className="space-y-3">
              <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
                {/* Colored panel header */}
                <div className={cn(
                  "px-5 py-4",
                  existingConfig
                    ? !!existingConfig.is_open
                      ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                      : "bg-gradient-to-r from-red-500 to-red-400"
                    : "bg-gradient-to-r from-[#5A5A40] to-[#7a7a58]"
                )}>
                  <p className="text-white/70 text-[11px] font-bold uppercase tracking-widest">Configure Date</p>
                  <p className="text-white font-bold font-serif text-base mt-0.5">
                    {new Date(configDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                  {existingConfig && (
                    <p className="text-white/80 text-[11px] font-bold mt-1">
                      {!!existingConfig.is_open ? '● Open for reservations' : '● Marked as closed'}
                    </p>
                  )}
                </div>

                <div className="p-5 space-y-4">
                {/* Date picker */}
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] mb-1.5">Jump to Date</p>
                  <input
                    type="date"
                    value={configDate}
                    onChange={e => setConfigDate(e.target.value)}
                    className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm font-bold outline-none focus:ring-2 ring-[#cc5a16]/20"
                  />
                </div>

                {/* Open toggle */}
                <div className={cn(
                  "flex items-center justify-between rounded-2xl px-4 py-3 transition-colors",
                  configForm.is_open ? "bg-emerald-50 border border-emerald-200" : "bg-red-50 border border-red-200"
                )}>
                  <div>
                    <p className={cn("text-sm font-bold", configForm.is_open ? "text-emerald-800" : "text-red-700")}>
                      {configForm.is_open ? '● Open for Reservations' : '✕ Closed'}
                    </p>
                    <p className="text-[11px] text-[#6b5d52]">
                      {configForm.is_open ? 'Customers can book on this date' : 'No bookings accepted on this date'}
                    </p>
                  </div>
                  <button
                    onClick={() => setConfigForm(f => ({ ...f, is_open: !f.is_open }))}
                    className={cn("w-12 h-6 rounded-full transition-colors relative flex-shrink-0", configForm.is_open ? "bg-emerald-500" : "bg-red-400")}
                  >
                    <span className={cn("absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform", configForm.is_open ? "translate-x-7" : "translate-x-1")} />
                  </button>
                </div>

                {configForm.is_open && (
                  <>
                    {/* Per-slot time table */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Time Slots & Tables</label>
                        <button
                          onClick={() => setConfigForm(f => ({ ...f, time_slots: [...f.time_slots, { time: '12:00', max_tables: 10 }] }))}
                          className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition-colors"
                        >
                          <Plus size={10} /> Add Slot
                        </button>
                      </div>

                      {/* Column headers */}
                      <div className="grid grid-cols-[1fr_100px_32px] gap-1.5 px-2">
                        <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85]">Time</span>
                        <span className="text-[11px] font-bold uppercase tracking-widest text-[#9c8e85] text-center">Tables Avail.</span>
                        <span />
                      </div>

                      {/* Slot rows */}
                      <div className="space-y-1.5 max-h-64 overflow-y-auto pr-0.5">
                        {configForm.time_slots.map((slot, idx) => (
                          <div key={idx} className="grid grid-cols-[1fr_100px_32px] gap-1.5 items-center bg-[#faf7f2] rounded-xl px-3 py-2.5">
                            <input
                              type="time"
                              value={slot.time}
                              onChange={e => setConfigForm(f => {
                                const s = [...f.time_slots]; s[idx] = { ...s[idx], time: e.target.value };
                                return { ...f, time_slots: s };
                              })}
                              className="bg-transparent text-sm font-bold outline-none text-[#1a1208] min-w-0 w-full"
                            />
                            <div className="flex items-center gap-1 bg-white rounded-lg px-1.5 py-1">
                              <button
                                onClick={() => setConfigForm(f => {
                                  const s = [...f.time_slots]; s[idx] = { ...s[idx], max_tables: Math.max(1, s[idx].max_tables - 1) };
                                  return { ...f, time_slots: s };
                                })}
                                className="w-5 h-5 flex items-center justify-center hover:bg-[#cc5a16]/10 rounded text-[#6b5d52] transition-colors"
                              ><Minus size={9} /></button>
                              <span className="flex-1 text-center text-sm font-bold text-[#1a1208] min-w-[20px]">{slot.max_tables}</span>
                              <button
                                onClick={() => setConfigForm(f => {
                                  const s = [...f.time_slots]; s[idx] = { ...s[idx], max_tables: s[idx].max_tables + 1 };
                                  return { ...f, time_slots: s };
                                })}
                                className="w-5 h-5 flex items-center justify-center hover:bg-[#cc5a16]/10 rounded text-[#6b5d52] transition-colors"
                              ><Plus size={9} /></button>
                            </div>
                            <button
                              onClick={() => setConfigForm(f => ({ ...f, time_slots: f.time_slots.filter((_, i) => i !== idx) }))}
                              className="w-7 h-7 flex items-center justify-center hover:bg-red-100 text-red-400 rounded-lg transition-colors"
                            ><X size={12} /></button>
                          </div>
                        ))}
                        {configForm.time_slots.length === 0 && (
                          <p className="text-[11px] text-[#9c8e85] text-center py-4 bg-[#faf7f2] rounded-xl">
                            No slots — click "Add Slot" to begin
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Notes */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Notes (optional)</label>
                      <input
                        type="text"
                        value={configForm.notes}
                        onChange={e => setConfigForm(f => ({ ...f, notes: e.target.value }))}
                        placeholder="e.g. Holiday hours"
                        className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                      />
                    </div>
                  </>
                )}

                {/* Save button */}
                <button
                  onClick={saveConfig}
                  disabled={savingConfig}
                  className="w-full bg-[#cc5a16] text-white py-3 rounded-2xl font-bold text-sm disabled:opacity-50 hover:scale-[1.02] transition-transform flex items-center justify-center gap-2"
                >
                  <Save size={16} /> {savingConfig ? 'Saving…' : 'Save'}
                </button>

                {/* Delete button — only shown when config already exists */}
                {existingConfig && (
                  <button
                    onClick={deleteConfig}
                    disabled={deletingConfig}
                    className="w-full border-2 border-red-200 text-red-500 py-3 rounded-2xl font-bold text-sm disabled:opacity-50 hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
                  >
                    <Trash2 size={16} /> {deletingConfig ? 'Removing…' : 'Remove Config'}
                  </button>
                )}
                </div>{/* /p-5 space-y-4 */}
              </div>
            </div>
          </div>

          {/* Bulk Apply */}
          <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
            <div className="bg-gradient-to-r from-blue-600 to-indigo-500 px-6 py-4">
              <h3 className="text-base font-bold font-serif text-white">Bulk Apply</h3>
              <p className="text-xs text-white/70 mt-0.5">Apply the same availability settings to a range of dates at once.</p>
            </div>
            <div className="p-6 space-y-5">

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* From date */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">From Date</label>
                <input
                  type="date"
                  value={bulkForm.from_date}
                  onChange={e => setBulkForm(f => ({ ...f, from_date: e.target.value }))}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>

              {/* To date */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">To Date</label>
                <input
                  type="date"
                  value={bulkForm.to_date}
                  onChange={e => setBulkForm(f => ({ ...f, to_date: e.target.value }))}
                  className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>

              {/* Max tables (bulk) */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Max Tables / Slot</label>
                <div className="flex items-center gap-3 bg-[#faf7f2] p-2 rounded-2xl">
                  <button onClick={() => setBulkForm(f => ({ ...f, max_tables: Math.max(1, f.max_tables - 1) }))} className="p-2 hover:bg-white rounded-xl transition-colors"><Minus size={14} /></button>
                  <span className="flex-1 text-center font-bold">{bulkForm.max_tables}</span>
                  <button onClick={() => setBulkForm(f => ({ ...f, max_tables: f.max_tables + 1 }))} className="p-2 hover:bg-white rounded-xl transition-colors"><Plus size={14} /></button>
                </div>
              </div>

              {/* Open toggle (bulk) */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Status</label>
                <div className={cn(
                  "flex items-center justify-between rounded-2xl px-4 py-3 h-[50px] transition-colors",
                  bulkForm.is_open ? "bg-emerald-50 border border-emerald-200" : "bg-red-50 border border-red-200"
                )}>
                  <span className={cn("text-sm font-bold", bulkForm.is_open ? "text-emerald-700" : "text-red-600")}>
                    {bulkForm.is_open ? '● Open' : '✕ Closed'}
                  </span>
                  <button
                    onClick={() => setBulkForm(f => ({ ...f, is_open: !f.is_open }))}
                    className={cn("w-12 h-6 rounded-full transition-colors relative flex-shrink-0", bulkForm.is_open ? "bg-emerald-500" : "bg-red-400")}
                  >
                    <span className={cn("absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform", bulkForm.is_open ? "translate-x-7" : "translate-x-1")} />
                  </button>
                </div>
              </div>
            </div>

            {/* Time slots (bulk) */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Time Slots (comma-separated)</label>
              <input
                type="text"
                value={bulkForm.time_slots}
                onChange={e => setBulkForm(f => ({ ...f, time_slots: e.target.value }))}
                placeholder="12:00, 13:00, 19:00, 20:00, 21:00"
                className="w-full bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
              />
            </div>

            {/* Day-of-week checkboxes */}
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Apply on Days</label>
              <div className="flex gap-2 flex-wrap">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, idx) => {
                  const active = bulkForm.day_of_week.includes(idx);
                  return (
                    <button
                      key={day}
                      onClick={() => setBulkForm(f => ({
                        ...f,
                        day_of_week: active
                          ? f.day_of_week.filter(d => d !== idx)
                          : [...f.day_of_week, idx].sort()
                      }))}
                      className={cn(
                        "w-12 h-12 rounded-2xl text-xs font-bold transition-all border-2",
                        active
                          ? "bg-[#cc5a16] text-white border-[#cc5a16]"
                          : "bg-[#faf7f2] text-[#6b5d52] border-transparent hover:border-[#cc5a16]/20"
                      )}
                    >
                      {day}
                    </button>
                  );
                })}
                <button
                  onClick={() => setBulkForm(f => ({
                    ...f,
                    day_of_week: f.day_of_week.length === 7 ? [] : [0, 1, 2, 3, 4, 5, 6]
                  }))}
                  className="px-3 h-12 rounded-2xl text-xs font-bold text-[#6b5d52] hover:bg-[#faf7f2] transition-colors"
                >
                  {bulkForm.day_of_week.length === 7 ? 'Clear all' : 'Select all'}
                </button>
              </div>
            </div>

            {/* Apply button + result */}
            <div className="flex items-center gap-4">
              <button
                onClick={bulkApply}
                disabled={bulkApplying || bulkForm.day_of_week.length === 0}
                className="flex items-center gap-2 bg-blue-600 text-white px-6 py-3 rounded-2xl font-bold text-sm disabled:opacity-50 hover:scale-[1.02] transition-transform"
              >
                <CalendarCheck size={16} />
                {bulkApplying ? 'Applying…' : 'Apply to Range'}
              </button>
              {bulkResult && (
                <span className={cn(
                  "text-sm font-bold",
                  bulkResult.startsWith('✓') ? "text-emerald-600" : "text-red-500"
                )}>
                  {bulkResult}
                </span>
              )}
            </div>
            </div>{/* /p-6 space-y-5 */}
          </div>
        </div>
      )}

      {/* New Booking Modal */}
      {showNewBooking && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#faf7f2] w-full max-w-md rounded-[32px] p-5 sm:p-8 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto my-auto"
          >
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-serif font-bold">New Booking</h3>
              <button onClick={() => setShowNewBooking(false)} className="p-2 hover:bg-black/5 rounded-full"><X size={20} /></button>
            </div>
            <p className="text-xs text-[#6b5d52]">Booking on behalf of a customer — auto-confirmed.</p>
            {[
              { label: 'Customer Name *', key: 'customer_name', type: 'text', placeholder: 'John Doe' },
              { label: 'Phone *', key: 'customer_phone', type: 'tel', placeholder: '+91 98765 43210' },
              { label: 'Email', key: 'customer_email', type: 'email', placeholder: 'john@example.com' },
            ].map(field => (
              <div key={field.key} className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">{field.label}</label>
                <input
                  type={field.type} placeholder={field.placeholder}
                  value={(nbForm as any)[field.key]}
                  onChange={e => setNbForm({ ...nbForm, [field.key]: e.target.value })}
                  className="w-full bg-white border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Date *</label>
                <input type="date" value={nbForm.booking_date} onChange={e => setNbForm({ ...nbForm, booking_date: e.target.value })}
                  className="w-full bg-white border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Time *</label>
                <input type="time" value={nbForm.booking_time} onChange={e => setNbForm({ ...nbForm, booking_time: e.target.value })}
                  className="w-full bg-white border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Guests *</label>
              <div className="flex items-center gap-4 bg-white p-2 rounded-2xl border border-black/5">
                <button onClick={() => setNbForm({ ...nbForm, guests: Math.max(1, nbForm.guests - 1) })} className="p-2 hover:bg-[#faf7f2] rounded-xl"><Minus size={14} /></button>
                <span className="flex-1 text-center font-bold">{nbForm.guests}</span>
                <button onClick={() => setNbForm({ ...nbForm, guests: nbForm.guests + 1 })} className="p-2 hover:bg-[#faf7f2] rounded-xl"><Plus size={14} /></button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">Notes</label>
              <input type="text" placeholder="Special requests…"
                value={nbForm.notes} onChange={e => setNbForm({ ...nbForm, notes: e.target.value })}
                className="w-full bg-white border-none rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 ring-[#cc5a16]/20"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowNewBooking(false)} className="flex-1 border-2 border-[#cc5a16] text-[#1a1208] py-3 rounded-2xl font-bold text-sm">Cancel</button>
              <button onClick={createBooking} disabled={savingBooking} className="flex-1 bg-[#cc5a16] text-white py-3 rounded-2xl font-bold text-sm disabled:opacity-50">
                {savingBooking ? 'Saving…' : 'Confirm Booking'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

const NOTIFICATION_EVENTS: {
  id: string; label: string; roles: string[];
  group: 'Orders' | 'Payments' | 'Bookings' | 'Feedback & Reports' | 'Hotel';
  description: string;
  schedulable?: boolean;
}[] = [
  // Orders
  { id: 'ORDER_PLACED',               label: 'New Order Received',            roles: ['OWNER', 'CHEF'],     group: 'Orders',              description: 'Fired when a customer places a new order' },
  { id: 'ORDER_READY',                label: 'Order Ready to Serve',          roles: ['WAITER'],             group: 'Orders',              description: 'Fired when chef marks an order as ready' },
  { id: 'ORDER_CANCELLED',            label: 'Order Cancelled',               roles: ['OWNER', 'CHEF'],     group: 'Orders',              description: 'Fired when an order is cancelled' },
  { id: 'CUSTOMER_ORDER_CONFIRMATION',label: 'Order Confirmation (Customer)', roles: ['CUSTOMER'],           group: 'Orders',              description: 'Confirmation sent to the customer after order is placed' },
  { id: 'CUSTOMER_INVOICE',           label: 'Invoice to Customer',           roles: ['CUSTOMER'],           group: 'Orders',              description: 'Invoice sent to the customer after payment' },
  // Payments
  { id: 'PAYMENT_RECEIVED',           label: 'Payment Received',              roles: ['OWNER'],              group: 'Payments',            description: 'Fired when a payment is marked as paid' },
  // Bookings
  { id: 'TABLE_BOOKING',              label: 'New Booking Request',           roles: ['OWNER', 'CUSTOMER'], group: 'Bookings',            description: 'Fired when a customer makes a reservation' },
  { id: 'BOOKING_CONFIRMED',          label: 'Booking Confirmed',             roles: ['CUSTOMER'],           group: 'Bookings',            description: 'Sent to customer when owner confirms the booking' },
  { id: 'BOOKING_CANCELLED',          label: 'Booking Cancelled',             roles: ['OWNER', 'CUSTOMER'], group: 'Bookings',            description: 'Fired when a booking is cancelled by owner or customer' },
  // Feedback & Reports
  { id: 'NEW_FEEDBACK',               label: 'New Customer Feedback',         roles: ['OWNER'],              group: 'Feedback & Reports',  description: 'Fired when a customer submits a rating or review' },
  { id: 'DAILY_REPORT',               label: 'Daily Sales Summary',           roles: ['OWNER'],              group: 'Feedback & Reports',  description: 'End-of-day summary of orders and revenue', schedulable: true },
  { id: 'STAFF_ATTENDANCE',           label: 'Staff Check-In / Check-Out',    roles: ['OWNER'],              group: 'Feedback & Reports',  description: 'Fired when a staff member logs attendance' },
  // Hotel / Hospitality (Phase 2)
  { id: 'HOUSEKEEPING_REQUESTED',     label: 'New Service Request',           roles: ['OWNER', 'HOUSEKEEPING', 'MAINTENANCE', 'FRONT_DESK'], group: 'Hotel', description: 'Fired when a guest submits an in-room service request' },
  { id: 'SERVICE_REQUEST_COMPLETED',  label: 'Service Request Completed',     roles: ['CUSTOMER'],                                          group: 'Hotel', description: 'Sent to the guest when their request is marked complete' },
  { id: 'SLA_BREACH',                 label: 'Service SLA Breach',            roles: ['OWNER', 'MANAGER'],                                  group: 'Hotel', description: 'Fired when a service request exceeds 1.5× its SLA' },
  { id: 'BOOKING_CREATED',            label: 'New Hotel Booking',             roles: ['OWNER', 'FRONT_DESK'],                               group: 'Hotel', description: 'Fired when a new room booking is made' },
  { id: 'GUEST_CHECKED_IN',           label: 'Guest Checked In',              roles: ['OWNER', 'FRONT_DESK'],                               group: 'Hotel', description: 'Fired on guest check-in' },
  { id: 'GUEST_CHECKED_OUT',          label: 'Guest Checked Out',             roles: ['OWNER', 'FRONT_DESK', 'HOUSEKEEPING'],               group: 'Hotel', description: 'Fired on guest check-out (housekeeping is notified to prepare cleaning)' },
];

const NOTIFICATION_CHANNELS = [
  { id: 'whatsapp_enabled', label: 'WhatsApp', icon: MessageSquare },
  { id: 'sms_enabled',      label: 'SMS',       icon: Smartphone   },
  { id: 'email_enabled',    label: 'Email',     icon: Mail         },
  { id: 'telegram_enabled', label: 'Telegram',  icon: MessageCircle },
];

function NotificationSettings({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [settings, setSettings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/owner/notification-settings', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setSettings(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (eventName: string, role: string, channel: string) => {
    setSettings(prev => {
      const existing = prev.find(s => s.event_name === eventName && s.role === role);
      if (existing) {
        return prev.map(s => 
          (s.event_name === eventName && s.role === role) 
            ? { ...s, [channel]: s[channel] ? 0 : 1 } 
            : s
        );
      } else {
        return [...prev, {
          event_name: eventName,
          role,
          whatsapp_enabled:  channel === 'whatsapp_enabled'  ? 1 : 0,
          sms_enabled:       channel === 'sms_enabled'       ? 1 : 0,
          email_enabled:     channel === 'email_enabled'     ? 1 : 0,
          telegram_enabled:  channel === 'telegram_enabled'  ? 1 : 0,
          telegram_chat_id:  '',
        }];
      }
    });
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/owner/notification-settings', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ settings })
      });
      if (res.ok) alert("Notification settings saved!");
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const testNotification = async (eventName: string) => {
    try {
      const res = await fetch('/api/owner/test-notification', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ eventName })
      });
      if (res.ok) alert("Test notification triggered!");
      else alert("Failed to trigger test notification. Check console.");
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) return <div className="p-12 text-center text-[#6b5d52] font-medium">Loading notification settings…</div>;

  // Group events by their category
  const eventGroups = Array.from(
    new Set(NOTIFICATION_EVENTS.map(e => e.group))
  ).map(group => ({
    group,
    events: NOTIFICATION_EVENTS.filter(e => e.group === group),
  }));

  // Channel config status pills (purely UI — keys match env var prefixes)
  const channelStatus = [
    { label: 'WhatsApp', subtitle: 'Meta Cloud API', key: 'META_WA',  icon: MessageSquare,  color: '#25D366' },
    { label: 'SMS',      subtitle: 'Twilio',          key: 'TWILIO',   icon: Smartphone,     color: '#F22F46' },
    { label: 'Email',    subtitle: 'SMTP',            key: 'SMTP',     icon: Mail,           color: '#EA4335' },
    { label: 'Telegram', subtitle: 'Bot API',         key: 'TELEGRAM', icon: MessageCircle,  color: '#229ED9' },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">Notification Settings</h2>
          <p className="text-[#6b5d52] mt-1">Toggle alerts for each event and role.</p>
        </div>
        <button
          onClick={saveSettings}
          disabled={saving}
          className="bg-[#cc5a16] text-white px-8 py-3 rounded-2xl font-bold hover:bg-[#a84612] transition-all disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
          Save Changes
        </button>
      </div>

      {/* ── Per-event toggle table, grouped by category ── */}
      {eventGroups.map(({ group, events }) => (
        <div key={group} className="bg-white rounded-[32px] border border-[#cc5a16]/10 shadow-sm overflow-hidden">
          {/* Group header */}
          <div className="px-8 py-4 bg-[#faf7f2] border-b border-[#cc5a16]/10 flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-widest text-[#1a1208]">{group}</span>
            <span className="text-[11px] bg-[#cc5a16]/10 text-[#6b5d52] px-2 py-0.5 rounded-full font-bold">{events.length} event{events.length !== 1 ? 's' : ''}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#cc5a16]/10">
                  <th className="px-8 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] min-w-[260px]">Event &amp; Role</th>
                  {NOTIFICATION_CHANNELS.map(channel => (
                    <th key={channel.id} className="px-6 py-4 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <channel.icon size={16} className="text-[#1a1208]" />
                        <span className="text-[11px] font-bold uppercase tracking-widest text-[#6b5d52]">{channel.label}</span>
                      </div>
                    </th>
                  ))}
                  <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] min-w-[160px]">Telegram Chat ID</th>
                  <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] min-w-[220px]">Additional Recipients</th>
                  <th className="px-4 py-4 text-center text-[11px] font-bold uppercase tracking-widest text-[#6b5d52] min-w-[130px]">Schedule Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#5A5A40]/5">
                {events.map(event => (
                  <React.Fragment key={event.id}>
                    {event.roles.map((role, idx) => {
                      const setting = settings.find(s => s.event_name === event.id && s.role === role);
                      return (
                        <tr key={`${event.id}-${role}`} className="hover:bg-[#fcfcfc] transition-colors">
                          <td className="px-8 py-5">
                            {idx === 0 && (
                              <div className="flex items-start justify-between gap-2 group mb-1.5">
                                <div>
                                  <p className="font-bold text-[#1a1a1a] text-sm">{event.label}</p>
                                  <p className="text-[11px] text-[#6b5d52] mt-0.5">{event.description}</p>
                                </div>
                                <button
                                  onClick={() => testNotification(event.id)}
                                  className="shrink-0 px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest text-[#1a1208] bg-[#cc5a16]/5 rounded-lg hover:bg-[#cc5a16]/10 transition-all"
                                >
                                  Test
                                </button>
                              </div>
                            )}
                            <span className="inline-block px-2 py-0.5 bg-[#cc5a16]/10 text-[#1a1208] rounded text-[11px] font-bold uppercase tracking-widest">
                              → {role}
                            </span>
                          </td>
                          {NOTIFICATION_CHANNELS.map(channel => (
                            <td key={channel.id} className="px-6 py-5 text-center">
                              <button
                                onClick={() => handleToggle(event.id, role, channel.id)}
                                className={cn(
                                  "w-11 h-6 rounded-full transition-all relative",
                                  setting?.[channel.id] ? "bg-[#cc5a16]" : "bg-gray-200"
                                )}
                                title={setting?.[channel.id] ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                              >
                                <div className={cn(
                                  "absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all",
                                  setting?.[channel.id] ? "left-[22px]" : "left-1"
                                )} />
                              </button>
                            </td>
                          ))}
                          {/* Telegram Chat ID */}
                          <td className="px-4 py-5">
                            <input
                              placeholder="-100xxxx or @channel"
                              className="w-full bg-[#faf7f2] border-none rounded-xl px-3 py-2 text-xs outline-none focus:ring-2 ring-[#229ED9]/30 font-mono"
                              value={setting?.telegram_chat_id || ''}
                              onChange={e => {
                                const val = e.target.value;
                                setSettings(prev => {
                                  const existing = prev.find(s => s.event_name === event.id && s.role === role);
                                  if (existing) {
                                    return prev.map(s => (s.event_name === event.id && s.role === role) ? { ...s, telegram_chat_id: val } : s);
                                  }
                                  return [...prev, { event_name: event.id, role, telegram_chat_id: val }];
                                });
                              }}
                            />
                          </td>
                          {/* Additional Recipients */}
                          <td className="px-4 py-5">
                            <input
                              placeholder="e.g. mgr@resto.com, +919876543210"
                              className="w-full bg-[#faf7f2] border-none rounded-xl px-4 py-2 text-xs outline-none focus:ring-2 ring-[#cc5a16]/20"
                              value={setting?.recipients || ''}
                              onChange={e => {
                                const val = e.target.value;
                                setSettings(prev => {
                                  const existing = prev.find(s => s.event_name === event.id && s.role === role);
                                  if (existing) {
                                    return prev.map(s => (s.event_name === event.id && s.role === role) ? { ...s, recipients: val } : s);
                                  }
                                  return [...prev, { event_name: event.id, role, recipients: val }];
                                });
                              }}
                            />
                          </td>
                          {/* Schedule Time — only for schedulable events */}
                          <td className="px-4 py-5 text-center">
                            {(event as any).schedulable ? (
                              <div className="flex flex-col items-center gap-1">
                                <input
                                  type="time"
                                  className="bg-[#faf7f2] border border-[#cc5a16]/20 rounded-xl px-3 py-2 text-xs outline-none focus:ring-2 ring-[#cc5a16]/30 font-mono w-[110px] cursor-pointer"
                                  value={setting?.schedule_time || ''}
                                  title={setting?.schedule_time ? `Fires daily at ${setting.schedule_time}` : 'Set a time to auto-send daily'}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setSettings(prev => {
                                      const existing = prev.find(s => s.event_name === event.id && s.role === role);
                                      if (existing) {
                                        return prev.map(s => (s.event_name === event.id && s.role === role) ? { ...s, schedule_time: val } : s);
                                      }
                                      return [...prev, { event_name: event.id, role, schedule_time: val }];
                                    });
                                  }}
                                />
                                {setting?.schedule_time ? (
                                  <span className="text-[11px] text-[#cc5a16] font-bold">Daily at {setting.schedule_time}</span>
                                ) : (
                                  <span className="text-[11px] text-[#9c8e85]">Not scheduled</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[11px] text-[#c5b9b2]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-center text-[11px] text-[#9c8e85] py-1.5 md:hidden select-none">‹ scroll ›</p>
        </div>
      ))}

    </div>
  );
}

function TelegramSetupGuide({ token }: { token: string }) {
  const [testChatId, setTestChatId] = React.useState('');
  const [testing, setTesting]       = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; msg: string } | null>(null);

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/owner/test-telegram', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: testChatId || undefined }),
      });
      const data = await res.json();
      setTestResult({ ok: res.ok, msg: res.ok ? '✅ Test message sent! Check your Telegram.' : (data.error || 'Failed') });
    } catch {
      setTestResult({ ok: false, msg: '❌ Network error' });
    } finally {
      setTesting(false);
    }
  };

  const steps = [
    { n: 1, title: 'Create a Telegram Bot', body: <>Open Telegram and search for <strong>@BotFather</strong>. Send the command <code className="bg-gray-100 px-1 rounded">/newbot</code>, choose a name and username. BotFather will reply with your <strong>Bot Token</strong> (e.g. <code className="bg-gray-100 px-1 rounded">123456789:ABCdefGHI...</code>).</> },
    { n: 2, title: 'Add the Bot Token to .env', body: <>Open your <code className="bg-gray-100 px-1 rounded">.env</code> file and add:<br/><code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono block mt-1">TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...</code></> },
    { n: 3, title: 'Get your Chat ID', body: <>
      <p className="mb-1"><strong>For a personal chat / DM:</strong> Message your bot, then visit:</p>
      <code className="bg-gray-100 px-1 rounded text-[11px] break-all">https://api.telegram.org/bot&#x3C;YOUR_TOKEN&#x3E;/getUpdates</code>
      <p className="mt-2 mb-1"><strong>For a group:</strong> Add your bot to the group, send a message, then check the same URL. The <code className="bg-gray-100 px-1 rounded">chat.id</code> for groups is a negative number like <code className="bg-gray-100 px-1 rounded">-1001234567890</code>.</p>
      <p className="mt-2 mb-1"><strong>For a channel:</strong> Add your bot as an admin, then use <code className="bg-gray-100 px-1 rounded">@channelname</code> as the chat ID.</p>
    </> },
    { n: 4, title: 'Set a Default Chat ID (optional)', body: <>Add to your <code className="bg-gray-100 px-1 rounded">.env</code>:<br/><code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono block mt-1">TELEGRAM_DEFAULT_CHAT_ID=-1001234567890</code><br/>This is used when no per-event Chat ID is entered above.</> },
    { n: 5, title: 'Enable in Notification Settings', body: <>Toggle the <strong>Telegram</strong> column for each event you want, enter the Chat ID in the <strong>Telegram Chat ID</strong> column, and click <strong>Save Changes</strong>.</> },
    { n: 6, title: 'Restart the Server', body: <>After editing <code className="bg-gray-100 px-1 rounded">.env</code>, restart the container:<br/><code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono block mt-1 text-[11px]">docker compose up -d app</code></> },
  ];

  return (
    <div className="bg-white rounded-[32px] border border-[#229ED9]/20 shadow-sm overflow-hidden">
      <div className="px-8 py-5 bg-[#229ED9]/5 border-b border-[#229ED9]/10 flex items-center gap-3">
        <MessageCircle size={20} className="text-[#229ED9]" />
        <div>
          <p className="font-bold text-[#1a1208]">Telegram Setup Guide</p>
          <p className="text-[11px] text-[#6b5d52] uppercase tracking-widest mt-0.5">Step-by-step instructions to connect Telegram notifications</p>
        </div>
      </div>
      <div className="px-8 py-6 space-y-5">
        {steps.map(s => (
          <div key={s.n} className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-[#229ED9] text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{s.n}</div>
            <div className="flex-1 text-sm text-[#0d0a07]/80">
              <p className="font-bold text-[#1a1208] mb-1">{s.title}</p>
              <div className="text-xs leading-relaxed">{s.body}</div>
            </div>
          </div>
        ))}

        {/* Test connection */}
        <div className="mt-6 pt-6 border-t border-[#229ED9]/10">
          <p className="font-bold text-sm text-[#1a1208] mb-3">Test Telegram Connection</p>
          <div className="flex gap-3 items-center">
            <input
              type="text"
              placeholder="Chat ID (e.g. -1001234567890 or @channel)"
              className="flex-1 bg-[#faf7f2] border-none rounded-2xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 ring-[#229ED9]/30"
              value={testChatId}
              onChange={e => setTestChatId(e.target.value)}
            />
            <button
              onClick={sendTest}
              disabled={testing}
              className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-[#229ED9] text-white text-sm font-bold hover:bg-[#1a8bc4] transition-all disabled:opacity-50 whitespace-nowrap"
            >
              {testing ? <RefreshCw size={15} className="animate-spin" /> : <MessageCircle size={15} />}
              Send Test
            </button>
          </div>
          {testResult && (
            <p className={`mt-2 text-xs font-semibold ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
              {testResult.msg}
            </p>
          )}
          <p className="text-[11px] text-[#9c8e85] mt-2">Leave Chat ID blank to use <code className="bg-gray-100 px-1 rounded">TELEGRAM_DEFAULT_CHAT_ID</code> from .env</p>
        </div>
      </div>
    </div>
  );
}
