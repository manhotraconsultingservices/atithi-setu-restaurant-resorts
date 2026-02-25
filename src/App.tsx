import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Utensils, 
  ChefHat, 
  ShieldCheck, 
  ShoppingCart, 
  QrCode, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  Clock, 
  BarChart3,
  ChevronRight,
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
  Search
} from 'lucide-react';
import { useSocket } from './lib/socket';
import { MenuItem, Order, UserRole, OrderItem, Restaurant, Table, DietaryType, ItemSize } from './types';
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
  Cell
} from 'recharts';

export default function App() {
  const [role, setRole] = useState<UserRole | null>(localStorage.getItem('role') as UserRole);
  const [userName, setUserName] = useState<string | null>(localStorage.getItem('userName'));
  const [view, setView] = useState<'LANDING' | 'DASHBOARD' | 'AUTH'>(localStorage.getItem('token') ? 'DASHBOARD' : 'LANDING');
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [restaurantId, setRestaurantId] = useState<string | null>(localStorage.getItem('restaurantId'));
  const [authMode, setAuthMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [initialAuthRole, setInitialAuthRole] = useState<UserRole | undefined>(undefined);
  const [restaurantName, setRestaurantName] = useState<string>('RestoFlow');
  const [landingStep, setLandingStep] = useState<'ID' | 'LOGIN'>('ID');
  const [tempRId, setTempRId] = useState('');
  const [tempRName, setTempRName] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [loginRole, setLoginRole] = useState<UserRole>('OWNER');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleVerifyId = async () => {
    const id = tempRId.trim();
    if (!id) return;
    setIsVerifying(true);
    try {
      const res = await fetch(`/api/restaurant/${id}`);
      const data = await res.json();
      if (res.ok) {
        setTempRName(data.name);
        setTempRId(data.id); // Use the canonical ID from the server
        setLandingStep('LOGIN');
      } else {
        alert("Restaurant ID is wrong. Please check and try again.");
      }
    } catch (err) {
      alert("Error validating Restaurant ID. Please try again later.");
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      setToken(data.token);
      setRestaurantId(data.restaurantId);
      setRole(data.role);
      setUserName(data.name);
      localStorage.setItem('token', data.token);
      localStorage.setItem('restaurantId', data.restaurantId);
      localStorage.setItem('role', data.role);
      localStorage.setItem('userName', data.name);
      setView('DASHBOARD');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  useEffect(() => {
    const savedRole = localStorage.getItem('role');
    const validRoles: UserRole[] = ['SUPER_ADMIN', 'OWNER', 'CHEF', 'WAITER', 'CUSTOMER'];
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
    if (restaurantId && restaurantId !== 'null' && restaurantId !== 'undefined' && restaurantId !== '') {
      fetch(`/api/restaurant/${restaurantId}`)
        .then(res => {
          if (res.status === 404) {
            throw new Error('Restaurant not found');
          }
          if (!res.ok) throw new Error('Failed to fetch restaurant info');
          return res.json();
        })
        .then(data => {
          if (data && data.name) setRestaurantName(data.name);
        })
        .catch(err => {
          console.error(err.message, err);
          if (err.message === 'Restaurant not found') {
            setRestaurantId(null);
            localStorage.removeItem('restaurantId');
            setView('LANDING');
          }
        });
    }
  }, [restaurantId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rId = params.get('r');
    const orderId = params.get('orderId');
    
    if (rId) {
      setRestaurantId(rId);
      setRole('CUSTOMER');
      setView('DASHBOARD');
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
    setLandingStep('ID');
    setView('LANDING');
  };

  if (view === 'LANDING') {
    return (
      <div className="min-h-screen bg-[#f5f5f0] flex flex-col items-center justify-center p-6 font-serif overflow-hidden relative">
        {/* Background decorative elements */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#5A5A40]/5 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#5A5A40]/5 rounded-full blur-3xl" />

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-xl z-10"
        >
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#5A5A40]/10 text-[#5A5A40] text-xs font-bold uppercase tracking-widest mb-6">
              <Star size={14} /> The Future of Restaurant Management
            </div>
            <h1 className="text-6xl font-bold text-[#1a1a1a] mb-4 tracking-tight">RestoFlow ERP</h1>
            <p className="text-lg text-[#5A5A40]/70 leading-relaxed">
              Seamless multi-tenant operations, real-time analytics, and effortless customer experiences.
            </p>
          </div>

          <div className="bg-white p-10 rounded-[40px] shadow-2xl border border-[#5A5A40]/5 relative overflow-hidden">
            <AnimatePresence mode="wait">
              {landingStep === 'ID' ? (
                <motion.div
                  key="id-step"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-8"
                >
                  <div className="text-center">
                    <h2 className="text-3xl font-bold mb-2">Enter Restaurant ID</h2>
                    <p className="text-[#5A5A40]/60 text-sm">Please provide your unique business identifier to continue.</p>
                  </div>

                  <div className="space-y-4">
                    <div className="relative">
                      <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={20} />
                      <input 
                        type="text"
                        placeholder="e.g. resto-1"
                        className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-14 pr-6 py-5 text-xl font-mono focus:ring-2 ring-[#5A5A40]/20 outline-none transition-all"
                        value={tempRId}
                        onChange={e => setTempRId(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && !isVerifying && handleVerifyId()}
                      />
                    </div>
                    <button 
                      onClick={handleVerifyId}
                      disabled={!tempRId || isVerifying}
                      className="w-full bg-[#5A5A40] text-white py-5 rounded-2xl font-bold text-lg hover:bg-[#4A4A30] transition-all shadow-lg shadow-[#5A5A40]/20 disabled:opacity-50 flex items-center justify-center gap-2"
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

                  <div className="pt-6 border-t border-[#5A5A40]/5 flex flex-col gap-4">
                    <div className="flex items-center justify-between text-sm">
                      <button 
                        onClick={() => {
                          setAuthMode('REGISTER');
                          setView('AUTH');
                        }}
                        className="text-[#5A5A40] font-bold hover:underline"
                      >
                        Register New Business
                      </button>
                      <button 
                        onClick={() => {
                          setAuthMode('LOGIN');
                          setInitialAuthRole('SUPER_ADMIN');
                          setView('AUTH');
                        }}
                        className="text-[#5A5A40]/50 hover:text-[#5A5A40] transition-colors"
                      >
                        Admin Portal
                      </button>
                    </div>
                    <p className="text-[10px] text-[#5A5A40]/40 text-center uppercase tracking-widest">
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
                  className="space-y-8"
                >
                  <div className="flex items-center justify-between">
                    <button 
                      onClick={() => setLandingStep('ID')}
                      className="text-[#5A5A40]/50 hover:text-[#5A5A40] flex items-center gap-1 text-sm transition-colors"
                    >
                      <ChevronRight className="rotate-180" size={16} /> Change ID
                    </button>
                    <div className="text-right">
                      <h2 className="text-2xl font-bold">{tempRName}</h2>
                      <p className="text-[#5A5A40]/60 text-xs font-mono uppercase tracking-widest">{tempRId}</p>
                    </div>
                  </div>

                  <form onSubmit={handleUnifiedLogin} className="space-y-6">
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Your Role</label>
                        <select 
                          className="w-full bg-[#f5f5f0] border-none rounded-2xl px-5 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none appearance-none font-sans"
                          value={loginRole}
                          onChange={e => setLoginRole(e.target.value as UserRole)}
                        >
                          <option value="OWNER">Business Owner</option>
                          <option value="CHEF">Chef / Kitchen Staff</option>
                          <option value="WAITER">Waiter / Attender</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Login ID</label>
                        <div className="relative">
                          <User className="absolute left-5 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                          <input 
                            required
                            className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-14 pr-6 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none font-sans"
                            placeholder="e.g. OWNER-XXXX"
                            value={loginId}
                            onChange={e => setLoginId(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Password</label>
                        <div className="relative">
                          <Lock className="absolute left-5 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                          <input 
                            required
                            type="password"
                            className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-14 pr-6 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none font-sans"
                            placeholder="••••••••"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-4">
                      <button 
                        type="submit"
                        disabled={isLoggingIn}
                        className="w-full bg-[#5A5A40] text-white py-5 rounded-2xl font-bold text-lg hover:bg-[#4A4A30] transition-all shadow-lg shadow-[#5A5A40]/20 disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {isLoggingIn ? (
                          <>
                            <Clock className="animate-spin" size={20} /> Signing In...
                          </>
                        ) : (
                          <>Sign In to Dashboard</>
                        )}
                      </button>
                      
                      <div className="relative py-2">
                        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[#5A5A40]/10"></div></div>
                        <div className="relative flex justify-center text-[10px] uppercase tracking-widest"><span className="bg-white px-2 text-[#5A5A40]/40">or</span></div>
                      </div>

                      <button 
                        type="button"
                        onClick={() => {
                          setRestaurantId(tempRId);
                          localStorage.setItem('restaurantId', tempRId);
                          setRole('CUSTOMER');
                          localStorage.setItem('role', 'CUSTOMER');
                          setView('DASHBOARD');
                        }}
                        className="w-full bg-white border-2 border-[#5A5A40]/10 text-[#5A5A40] py-4 rounded-2xl font-bold hover:bg-[#f5f5f0] transition-all flex items-center justify-center gap-2"
                      >
                        <ShoppingCart size={18} /> Enter as Customer
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-12 text-center text-[#5A5A40]/40 text-xs">
            &copy; {new Date().getFullYear()} RestoFlow ERP. All rights reserved.
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

  if (!restaurantId && role !== 'SUPER_ADMIN' && role !== null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f5f0]">
        <div className="bg-white p-12 rounded-[40px] shadow-xl border border-[#5A5A40]/10 max-w-xl text-center">
          <div className="w-20 h-20 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <X size={40} />
          </div>
          <h2 className="text-3xl font-bold font-serif mb-4">Access Denied</h2>
          <p className="text-[#5A5A40]/60 mb-8">A valid Restaurant ID is required to access this interface. If you are an administrator, please ensure you are logged in with the correct role.</p>
          <button 
            onClick={() => {
              handleLogout();
              setView('LANDING');
            }} 
            className="bg-[#5A5A40] text-white px-8 py-4 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f0]">
      <nav className="bg-white border-b border-[#5A5A40]/10 px-6 py-4 flex justify-between items-center sticky top-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('LANDING')}>
          <Utensils className="w-6 h-6 text-[#5A5A40]" />
          <span className="text-xl font-bold font-serif text-[#1a1a1a]">
            {role === 'SUPER_ADMIN' ? 'RestoFlow ERP Admin' : restaurantName}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-xs font-bold uppercase tracking-wider text-[#5A5A40]">
              {userName}
            </span>
            <span className="text-[10px] text-[#5A5A40]/60 uppercase tracking-widest">
              {role} {restaurantId && `| ${restaurantId}`}
            </span>
          </div>
          <div className="h-8 w-px bg-[#5A5A40]/10 mx-2" />
          <button 
            onClick={handleLogout}
            className="bg-red-50 text-red-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-red-100 transition-colors"
          >
            <LogOut size={16} /> <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto p-6">
        {role === 'SUPER_ADMIN' && <SuperAdminDashboard token={token!} />}
        {role === 'OWNER' && (
          <OwnerDashboard 
            restaurantId={restaurantId!} 
            token={token!} 
            onRestaurantUpdate={(name) => setRestaurantName(name)} 
          />
        )}
        {role === 'CHEF' && <ChefDashboard restaurantId={restaurantId!} token={token!} />}
        {role === 'WAITER' && <WaiterDashboard restaurantId={restaurantId!} token={token!} />}
        {role === 'CUSTOMER' && <CustomerInterface restaurantId={restaurantId!} />}
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
  "Punjab": ["Ludhiana", "Amritsar", "Jalandhar", "Patiala", "Bathinda"],
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
  const [selectedRole, setSelectedRole] = useState<UserRole>(initialRole || 'OWNER');

  useEffect(() => {
    if (initialRole) setSelectedRole(initialRole);
  }, [initialRole]);
  const [selectedRestaurantId, setSelectedRestaurantId] = useState('');
  const [restaurants, setRestaurants] = useState<{id: string, name: string}[]>([]);
  const [loading, setLoading] = useState(false);
  const [registrationResult, setRegistrationResult] = useState<{ loginId: string, password: string, restaurantId: string } | null>(null);

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
    }
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = mode === 'LOGIN' ? '/api/auth/login' : '/api/auth/register';
      const body = mode === 'LOGIN' 
        ? { loginId: loginId.trim(), password: password.trim(), restaurantId: selectedRestaurantId, role: selectedRole } 
        : { email, restaurantName, name, password, phone, state, city };
        
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      if (mode === 'REGISTER') {
        setRegistrationResult({ loginId: data.loginId, password: password, restaurantId: data.restaurantId });
      } else {
        onSuccess(data.token, data.restaurantId, data.role, data.name);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (registrationResult) {
    return (
      <div className="min-h-screen bg-[#f5f5f0] flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-10 rounded-[40px] shadow-xl border border-[#5A5A40]/5 w-full max-w-md text-center"
        >
          <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={40} />
          </div>
          <h2 className="text-3xl font-bold font-serif mb-2">Registration Successful!</h2>
          <p className="text-[#5A5A40]/60 mb-8">Your business has been registered and is pending activation by the Admin. Please save your login credentials.</p>
          
          <div className="bg-[#f5f5f0] p-6 rounded-3xl space-y-4 mb-8 text-left">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Restaurant ID (Required for Login)</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-emerald-500/30 text-emerald-700 select-all">
                {registrationResult.restaurantId}
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Login ID</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-[#5A5A40]/10 select-all">
                {registrationResult.loginId}
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Password</label>
              <div className="bg-white px-4 py-3 rounded-xl font-mono font-bold text-lg border border-[#5A5A40]/10 select-all">
                {registrationResult.password}
              </div>
            </div>
          </div>
          
          <button 
            onClick={() => {
              setRegistrationResult(null);
              onSwitch(); // Switch to login mode
            }}
            className="w-full bg-[#5A5A40] text-white py-5 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all"
          >
            Go to Login
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f0] flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white p-10 rounded-[40px] shadow-xl border border-[#5A5A40]/5 w-full max-w-2xl"
      >
        <button onClick={onBack} className="text-[#5A5A40]/50 hover:text-[#5A5A40] mb-8 flex items-center gap-1 text-sm">
          <ChevronRight className="rotate-180" size={16} /> Back
        </button>
        <h2 className="text-4xl font-bold font-serif mb-2">{mode === 'LOGIN' ? 'Welcome Back' : 'Business Registration'}</h2>
        <p className="text-[#5A5A40]/60 mb-8">{mode === 'LOGIN' ? 'Login to manage your restaurant.' : 'Register your business and we will generate your credentials.'}</p>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === 'REGISTER' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Business Name</label>
                <div className="relative">
                  <Utensils className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="The Gourmet Kitchen"
                    value={restaurantName}
                    onChange={e => setRestaurantName(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Business Owner Name</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="John Doe"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Owner Phone Number</label>
                <div className="relative">
                  <Star className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    type="tel"
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Owner Email ID</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    type="email"
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="owner@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Business State</label>
                <select 
                  required
                  className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none appearance-none"
                  value={state}
                  onChange={e => {
                    setState(e.target.value);
                    setCity('');
                  }}
                >
                  <option value="">Select State</option>
                  {Object.keys(INDIAN_STATES).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Business City</label>
                <select 
                  required
                  disabled={!state}
                  className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none appearance-none disabled:opacity-50"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                >
                  <option value="">Select City</option>
                  {state && INDIAN_STATES[state].map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Desired Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    type="password"
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-md mx-auto space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Role</label>
                <select 
                  className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none appearance-none"
                  value={selectedRole}
                  onChange={e => setSelectedRole(e.target.value as UserRole)}
                >
                  <option value="OWNER">Business Owner</option>
                  <option value="CHEF">Chef</option>
                  <option value="WAITER">Waiter / Attender</option>
                  <option value="SUPER_ADMIN">ERP Admin</option>
                </select>
              </div>

              {selectedRole !== 'SUPER_ADMIN' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Business / Restaurant</label>
                  <select 
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none appearance-none"
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
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Login ID</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    placeholder="OWNER-XXXX"
                    value={loginId}
                    onChange={e => setLoginId(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Password</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={18} />
                  <input 
                    required
                    type="password"
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none"
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
              className="w-full bg-[#5A5A40] text-white py-5 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all shadow-lg shadow-[#5A5A40]/20 disabled:opacity-50"
            >
              {loading ? 'Processing...' : mode === 'LOGIN' ? 'Login Dashboard' : 'Register Business'}
            </button>
          </div>
        </form>
        
        <div className="mt-8 text-center">
          <button onClick={onSwitch} className="text-sm text-[#5A5A40] hover:underline">
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
      className="bg-white p-8 rounded-[32px] shadow-sm border border-[#5A5A40]/5 text-left hover:shadow-md transition-all group"
    >
      <div className="w-12 h-12 rounded-2xl bg-[#5A5A40]/10 flex items-center justify-center text-[#5A5A40] mb-6 group-hover:bg-[#5A5A40] group-hover:text-white transition-colors">
        {icon}
      </div>
      <h3 className="text-2xl font-bold text-[#1a1a1a] mb-2 font-serif">{title}</h3>
      <p className="text-sm text-[#5A5A40]/70 leading-relaxed">{description}</p>
    </motion.button>
  );
}

// --- ADMIN DASHBOARD ---
function OwnerDashboard({ restaurantId, token, onRestaurantUpdate }: { restaurantId: string, token: string, onRestaurantUpdate: (name: string) => void }) {
  const [activeTab, setActiveTab] = useState<'MENU' | 'REPORTS' | 'QR' | 'STAFF' | 'SETTINGS'>('MENU');
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [reports, setReports] = useState<any>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [isAddingStaff, setIsAddingStaff] = useState(false);
  const [newStaff, setNewStaff] = useState({ loginId: '', name: '', password: '', role: 'CHEF' as UserRole });
  const [newItem, setNewItem] = useState<{ 
    name: string, 
    description: string, 
    price: string, 
    price_half: string, 
    price_full: string, 
    category: string, 
    imageFile: File | null,
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

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchMenu();
    fetchReports();
    fetchRestaurant();
    fetchTables();
    fetchStaff();
  }, [restaurantId]);

  const fetchStaff = async () => {
    try {
      const res = await fetch('/api/owner/staff', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setStaff(await res.json());
    } catch (err) {
      console.error("Failed to fetch staff", err);
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
        setNewStaff({ loginId: '', name: '', password: '', role: 'CHEF' });
        fetchStaff();
      } else {
        const data = await res.json();
        alert(data.error);
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
      if (res.ok) setTables(await res.json());
    } catch (err) {
      console.error("Failed to fetch tables", err);
    }
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
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`);
      if (res.ok) {
        setRestaurant(await res.json());
      }
    } catch (err) {
      console.error("Error fetching restaurant:", err);
    }
  };

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
          table_count: restaurant.table_count
        })
      });
      if (!res.ok) throw new Error("Failed to update settings");
      await syncTables(restaurant.table_count || 0);
      alert("Settings updated successfully!");
      onRestaurantUpdate(restaurant.name);
      fetchRestaurant();
    } catch (error: any) {
      alert("Error: " + error.message);
    }
  };

  const fetchMenu = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/menu`);
      if (res.ok) {
        setMenu(await res.json());
      }
    } catch (err) {
      console.error("Error fetching menu:", err);
    }
  };

  const fetchReports = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/reports`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setReports(await res.json());
      }
    } catch (err) {
      console.error("Error fetching reports:", err);
    }
  };

  const exportToCSV = () => {
    if (!reports?.allOrders) return;
    
    const headers = ["Order ID", "Table", "Customer", "Phone", "Total", "GST", "Status", "Payment", "Date"];
    const rows = reports.allOrders.map((o: any) => [
      o.id,
      o.table_number,
      o.customer_name || 'N/A',
      o.customer_phone || 'N/A',
      o.total_amount,
      o.gst_amount,
      o.status,
      o.payment_status,
      new Date(o.created_at).toLocaleString()
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r: any) => r.map((v: any) => `"${v}"`).join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `orders_report_${restaurantId}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    if (newItem.imageFile) {
      formData.append('image', newItem.imageFile);
    }

    await fetch(`/api/restaurant/${restaurantId}/menu`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    setIsAddingItem(false);
    setNewItem({ 
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
    fetchMenu();
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

  const handleToggleDailySpecial = async (id: string, is_daily_special: boolean) => {
    await fetch(`/api/menu/${id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ is_daily_special })
    });
    fetchMenu();
  };

  return (
    <div className="space-y-8">
      <div className="flex gap-4 border-b border-[#5A5A40]/10">
        <button 
          onClick={() => setActiveTab('MENU')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'MENU' ? "text-[#5A5A40] border-b-2 border-[#5A5A40]" : "text-[#5A5A40]/40"
          )}
        >
          Menu Management
        </button>
        <button 
          onClick={() => setActiveTab('REPORTS')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'REPORTS' ? "text-[#5A5A40] border-b-2 border-[#5A5A40]" : "text-[#5A5A40]/40"
          )}
        >
          Analytics & Reports
        </button>
        <button 
          onClick={() => setActiveTab('QR')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'QR' ? "text-[#5A5A40] border-b-2 border-[#5A5A40]" : "text-[#5A5A40]/40"
          )}
        >
          QR Management
        </button>
        <button 
          onClick={() => setActiveTab('STAFF')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'STAFF' ? "text-[#5A5A40] border-b-2 border-[#5A5A40]" : "text-[#5A5A40]/40"
          )}
        >
          Staff Management
        </button>
        <button 
          onClick={() => setActiveTab('SETTINGS')}
          className={cn(
            "pb-4 text-sm font-bold uppercase tracking-widest transition-all",
            activeTab === 'SETTINGS' ? "text-[#5A5A40] border-b-2 border-[#5A5A40]" : "text-[#5A5A40]/40"
          )}
        >
          Brand & Settings
        </button>
      </div>

      {activeTab === 'MENU' ? (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Restaurant Menu</h2>
            <button 
              onClick={() => setIsAddingItem(true)}
              className="bg-[#5A5A40] text-white px-6 py-3 rounded-full flex items-center gap-2 hover:bg-[#4A4A30] transition-colors"
            >
              <Plus size={20} /> Add New Item
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {menu.map(item => (
              <div key={item.id} className="bg-white rounded-3xl border border-[#5A5A40]/5 shadow-sm overflow-hidden flex flex-col">
                <div className="aspect-video bg-[#f5f5f0] relative overflow-hidden">
                  <img 
                    src={item.image || `https://picsum.photos/seed/${item.id}/600/450`} 
                    alt={item.name} 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="p-6 flex-1 flex flex-col">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 block">
                          {item.category}
                        </span>
                        {item.is_daily_special ? (
                          <span className="bg-yellow-100 text-yellow-700 text-[8px] font-bold uppercase px-1.5 py-0.5 rounded flex items-center gap-0.5">
                            <Star size={8} fill="currentColor" /> Daily Special
                          </span>
                        ) : null}
                      </div>
                      <h4 className="text-xl font-bold font-serif">{item.name}</h4>
                    </div>
                    <div className="flex items-center gap-1">
                      <button 
                        onClick={() => handleToggleDailySpecial(item.id, !item.is_daily_special)}
                        className={cn(
                          "p-2 rounded-full transition-colors",
                          item.is_daily_special ? "text-yellow-500 bg-yellow-50" : "text-gray-300 hover:text-yellow-500 hover:bg-yellow-50"
                        )}
                        title={item.is_daily_special ? "Remove from Daily Special" : "Set as Daily Special"}
                      >
                        <Star size={18} fill={item.is_daily_special ? "currentColor" : "none"} />
                      </button>
                      <button 
                        onClick={() => handleDeleteItem(item.id)}
                        className="text-red-400 hover:text-red-600 p-2"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-[#5A5A40]/70 mb-6 line-clamp-2">{item.description}</p>
                  <div className="mt-auto flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold font-mono">₹{item.price.toFixed(2)}</span>
                      <button 
                        onClick={() => {
                          const newPrice = prompt("Enter new price:", item.price.toString());
                          if (newPrice) handleUpdatePrice(item.id, parseFloat(newPrice));
                        }}
                        className="text-xs text-[#5A5A40] underline"
                      >
                        Edit
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={cn("w-2 h-2 rounded-full", item.available ? "bg-green-500" : "bg-red-500")} />
                      <span className="text-xs font-medium">{item.available ? 'Available' : 'Out of Stock'}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : activeTab === 'REPORTS' ? (
        <div className="space-y-8">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Analytics & Reports</h2>
            <button 
              onClick={exportToCSV}
              className="flex items-center gap-2 px-6 py-3 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-all shadow-lg shadow-[#5A5A40]/20"
            >
              <Receipt size={18} /> Export CSV
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-white p-8 rounded-[32px] border border-[#5A5A40]/5 shadow-sm">
              <h3 className="text-xl font-bold font-serif mb-6 flex items-center gap-2">
                <BarChart3 className="text-[#5A5A40]" /> Sales by Category
              </h3>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={reports?.salesByCategory || []}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="total"
                      nameKey="category"
                    >
                      {reports?.salesByCategory?.map((_: any, index: number) => (
                        <Cell key={`cell-${index}`} fill={['#5A5A40', '#8A8A60', '#A5A58D', '#BDB76B'][index % 4]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white p-8 rounded-[32px] border border-[#5A5A40]/5 shadow-sm">
              <h3 className="text-xl font-bold font-serif mb-6 flex items-center gap-2">
                <Clock className="text-[#5A5A40]" /> Daily Revenue
              </h3>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reports?.dailySales || []}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                    <Tooltip cursor={{ fill: '#f5f5f0' }} />
                    <Bar dataKey="total" fill="#5A5A40" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[32px] border border-[#5A5A40]/5 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-[#5A5A40]/5">
              <h3 className="text-xl font-bold font-serif">Order History</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#f5f5f0]">
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Order ID</th>
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Date & Time</th>
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Customer</th>
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Table</th>
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Amount</th>
                    <th className="p-4 text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reports?.allOrders?.map((order: any) => (
                    <tr key={order.id} className="border-b border-[#5A5A40]/5 hover:bg-[#fcfcfc] transition-colors">
                      <td className="p-4 font-mono text-xs font-bold">{order.id}</td>
                      <td className="p-4 text-sm text-[#5A5A40]/70">
                        {new Date(order.created_at).toLocaleString()}
                      </td>
                      <td className="p-4">
                        <div className="text-sm font-bold">{order.customer_name || 'Guest'}</div>
                        <div className="text-[10px] text-[#5A5A40]/50">{order.customer_phone || 'No Phone'}</div>
                      </td>
                      <td className="p-4 text-sm font-bold">Table {order.table_number}</td>
                      <td className="p-4">
                        <div className="text-sm font-bold">₹{order.total_amount.toFixed(2)}</div>
                        {order.gst_amount > 0 && (
                          <div className="text-[10px] text-green-600">+ ₹{order.gst_amount.toFixed(2)} GST</div>
                        )}
                      </td>
                      <td className="p-4">
                        <span className={cn(
                          "px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest",
                          order.status === 'DELIVERED' ? "bg-green-100 text-green-600" :
                          order.status === 'CANCELLED' ? "bg-red-100 text-red-600" :
                          "bg-orange-100 text-orange-600"
                        )}>
                          {order.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(!reports?.allOrders || reports.allOrders.length === 0) && (
                    <tr>
                      <td colSpan={6} className="p-12 text-center text-[#5A5A40]/40 italic">
                        No orders found in history.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : activeTab === 'STAFF' ? (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">Staff Management</h2>
            <button 
              onClick={() => setIsAddingStaff(true)}
              className="bg-[#5A5A40] text-white px-6 py-3 rounded-full flex items-center gap-2 hover:bg-[#4A4A30] transition-colors"
            >
              <Plus size={20} /> Add New Staff
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {staff.map((s) => (
              <div key={s.id} className="bg-white p-6 rounded-[32px] border border-[#5A5A40]/5 shadow-sm space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-bold">{s.name}</h3>
                    <p className="text-xs text-[#5A5A40]/60 uppercase tracking-widest">{s.role}</p>
                  </div>
                  <button onClick={() => removeStaff(s.id)} className="text-red-400 hover:text-red-600">
                    <Trash2 size={18} />
                  </button>
                </div>
                <div className="bg-[#f5f5f0] p-4 rounded-2xl">
                  <p className="text-[10px] uppercase tracking-widest text-[#5A5A40]/50 mb-1">Login ID</p>
                  <p className="font-mono font-bold">{s.login_id}</p>
                </div>
                <button 
                  onClick={() => {
                    const newPass = prompt("Enter new password for " + s.name);
                    if (newPass) {
                      fetch('/api/owner/reset-staff-password', {
                        method: 'POST',
                        headers: { 
                          'Content-Type': 'application/json',
                          'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ staffId: s.id, newPassword: newPass })
                      }).then(res => {
                        if (res.ok) alert("Password reset successfully");
                      });
                    }
                  }}
                  className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40] hover:underline"
                >
                  Reset Password
                </button>
              </div>
            ))}
          </div>

          {isAddingStaff && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-[32px] p-8 w-full max-w-md shadow-2xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-2xl font-bold font-serif">Add Staff Member</h3>
                  <button onClick={() => setIsAddingStaff(false)} className="text-[#5A5A40]/50 hover:text-[#5A5A40]">
                    <X />
                  </button>
                </div>
                <form onSubmit={handleAddStaff} className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Full Name</label>
                    <input 
                      required
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newStaff.name}
                      onChange={e => setNewStaff({...newStaff, name: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Login ID</label>
                    <input 
                      required
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newStaff.loginId}
                      onChange={e => setNewStaff({...newStaff, loginId: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Password</label>
                    <input 
                      required
                      type="password"
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newStaff.password}
                      onChange={e => setNewStaff({...newStaff, password: e.target.value})}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 ml-2">Role</label>
                    <select 
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newStaff.role}
                      onChange={e => setNewStaff({...newStaff, role: e.target.value as UserRole})}
                    >
                      <option value="CHEF">Chef</option>
                      <option value="WAITER">Waiter / Attender</option>
                    </select>
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all"
                  >
                    Add Staff
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </div>
      ) : activeTab === 'QR' ? (
        <div className="max-w-4xl space-y-8">
          <div className="flex justify-between items-center">
            <h2 className="text-3xl font-bold font-serif">QR Code Management</h2>
            <button 
              type="button"
              onClick={downloadAllQRs}
              className="flex items-center gap-2 px-6 py-3 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-all shadow-lg shadow-[#5A5A40]/20"
            >
              <Download size={18} /> Download All QRs
            </button>
          </div>

          <div className="bg-white p-8 rounded-[32px] border border-[#5A5A40]/5 shadow-sm space-y-8">
            <div className="max-w-md space-y-4">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Number of Tables</label>
              <div className="flex gap-2">
                <input 
                  type="number"
                  min="0"
                  className="flex-1 bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                  value={restaurant?.table_count || 0}
                  onChange={e => setRestaurant(prev => prev ? { ...prev, table_count: parseInt(e.target.value) || 0 } : null)}
                />
                <button 
                  type="button"
                  onClick={updateRestaurant}
                  className="px-6 py-3 bg-[#5A5A40] text-white rounded-2xl font-bold hover:bg-[#4A4A30] transition-all"
                >
                  Update Tables
                </button>
              </div>
              <p className="text-[10px] text-[#5A5A40]/60">Update the table count to generate new QR codes for your restaurant.</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6">
              {/* Online Order QR */}
              <div className="bg-[#f5f5f0] p-6 rounded-[32px] text-center space-y-4 border border-transparent hover:border-[#5A5A40]/10 transition-all">
                <div className="bg-white p-4 rounded-2xl inline-block shadow-sm">
                  <QRCodeCanvas id="qr-online" value={`${window.location.origin}?r=${restaurantId}`} size={120} />
                </div>
                <div>
                  <p className="text-sm font-bold text-[#1a1a1a]">Online Order</p>
                  <p className="text-[10px] text-[#5A5A40]/50 uppercase tracking-widest">General Access</p>
                </div>
                <button 
                  type="button"
                  onClick={() => downloadQR('qr-online', 'online_order_qr')}
                  className="w-full py-2 text-[10px] font-bold uppercase tracking-widest border border-[#5A5A40]/20 rounded-xl hover:bg-[#5A5A40] hover:text-white transition-all"
                >
                  Download
                </button>
              </div>

              {/* Table QRs */}
              {tables.map((table) => (
                <div key={table.id} className="bg-white p-6 rounded-[32px] text-center space-y-4 border border-[#5A5A40]/5 hover:shadow-md transition-all">
                  <div className="bg-white p-4 rounded-2xl inline-block border border-[#f5f5f0]">
                    <QRCodeCanvas id={`qr-table-${table.id}`} value={`${window.location.origin}?r=${restaurantId}&table=${table.id}`} size={120} />
                  </div>
                  <div className="space-y-2">
                    <input 
                      type="text"
                      className="w-full text-center text-sm font-bold text-[#1a1a1a] bg-transparent border-b border-dashed border-[#5A5A40]/20 focus:border-[#5A5A40] outline-none"
                      value={table.name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setTables(prev => prev.map(t => t.id === table.id ? { ...t, name: newName } : t));
                      }}
                      onBlur={(e) => updateTableName(table.id, e.target.value)}
                    />
                    <p className="text-[10px] text-[#5A5A40]/50 uppercase tracking-widest">Dine-in</p>
                  </div>
                  <button 
                    type="button"
                    onClick={() => downloadQR(`qr-table-${table.id}`, table.name.replace(/\s+/g, '_').toLowerCase())}
                    className="w-full py-2 text-[10px] font-bold uppercase tracking-widest border border-[#5A5A40]/20 rounded-xl hover:bg-[#5A5A40] hover:text-white transition-all"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
            
            <div className="p-6 bg-[#5A5A40]/5 rounded-2xl border border-dashed border-[#5A5A40]/20 text-center">
              <p className="text-xs text-[#5A5A40]/70 italic">
                Tip: Print these QR codes and place them on your tables. When scanned, they will automatically assign the table number to the customer's order.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="max-w-xl bg-white p-8 rounded-[32px] border border-[#5A5A40]/5 shadow-sm">
          <h3 className="text-2xl font-bold font-serif mb-6">Brand & Restaurant Settings</h3>
          <form onSubmit={updateRestaurant} className="space-y-6">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Brand Name</label>
              <input 
                required
                className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                value={restaurant?.name || ''}
                onChange={e => setRestaurant(prev => prev ? { ...prev, name: e.target.value } : null)}
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">GST Number</label>
              <input 
                className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                placeholder="e.g. 22AAAAA0000A1Z5"
                value={restaurant?.gst_number || ''}
                onChange={e => setRestaurant(prev => prev ? { ...prev, gst_number: e.target.value } : null)}
              />
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">GST Percentage (%)</label>
              <input 
                type="number"
                step="0.01"
                className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                placeholder="e.g. 5"
                value={restaurant?.gst_percentage || 0}
                onChange={e => setRestaurant(prev => prev ? { ...prev, gst_percentage: parseFloat(e.target.value) || 0 } : null)}
              />
            </div>
            <div className="flex items-center justify-between p-4 bg-[#f5f5f0] rounded-2xl">
              <div>
                <p className="text-sm font-bold text-[#1a1a1a]">Charge GST</p>
                <p className="text-[10px] text-[#5A5A40]/50 uppercase tracking-widest">Enable or disable GST on invoices</p>
              </div>
              <button 
                type="button"
                onClick={() => setRestaurant(prev => prev ? { ...prev, is_gst_enabled: !prev.is_gst_enabled } : null)}
                className={cn(
                  "w-12 h-6 rounded-full transition-colors relative",
                  restaurant?.is_gst_enabled ? "bg-[#5A5A40]" : "bg-gray-300"
                )}
              >
                <motion.div 
                  animate={{ x: restaurant?.is_gst_enabled ? 24 : 4 }}
                  className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
                />
              </button>
            </div>

            <div className="space-y-4">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Menu Template</label>
              <div className="grid grid-cols-3 gap-4">
                {['CLASSIC', 'MODERN', 'EDITORIAL'].map((t: any) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setRestaurant(prev => prev ? { ...prev, template_id: t } : null)}
                    className={cn(
                      "p-4 rounded-2xl border-2 transition-all text-center",
                      restaurant?.template_id === t ? "border-[#5A5A40] bg-[#5A5A40]/5" : "border-transparent bg-[#f5f5f0]"
                    )}
                  >
                    <Layout className="mx-auto mb-2 opacity-50" size={20} />
                    <span className="text-[10px] font-bold uppercase tracking-widest">{t}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Menu Watermark</label>
              <div className="flex items-center gap-4">
                {restaurant?.watermark_image && (
                  <img src={restaurant.watermark_image} alt="Watermark" className="w-12 h-12 object-contain border rounded-lg" referrerPolicy="no-referrer" />
                )}
                <input 
                  type="file"
                  accept="image/*"
                  className="w-full text-sm text-[#5A5A40]/50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#5A5A40]/10 file:text-[#5A5A40] hover:file:bg-[#5A5A40]/20"
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
                      const data = await res.json();
                      if (data.watermark_image) {
                        setRestaurant(prev => prev ? { ...prev, watermark_image: data.watermark_image } : null);
                      }
                    }
                  }}
                />
              </div>
            </div>

            <button 
              type="submit"
              className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all"
            >
              Save Settings
            </button>
          </form>
        </div>
      )}

      {/* Add Item Modal */}
      <AnimatePresence>
        {isAddingItem && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-[32px] p-8 w-full max-w-md shadow-2xl"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold font-serif">Add Menu Item</h3>
                <button onClick={() => setIsAddingItem(false)} className="text-[#5A5A40]/50 hover:text-[#5A5A40]">
                  <X />
                </button>
              </div>
              <form onSubmit={handleAddItem} className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Item Name</label>
                  <input 
                    required
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                    value={newItem.name}
                    onChange={e => setNewItem({ ...newItem, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Description</label>
                  <textarea 
                    required
                    className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none h-24 resize-none"
                    value={newItem.description}
                    onChange={e => setNewItem({ ...newItem, description: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Half Price (₹)</label>
                    <input 
                      type="number"
                      step="0.01"
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newItem.price_half}
                      onChange={e => setNewItem({ ...newItem, price_half: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Full Price (₹)</label>
                    <input 
                      required
                      type="number"
                      step="0.01"
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newItem.price_full}
                      onChange={e => setNewItem({ ...newItem, price_full: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Dietary Type</label>
                    <select 
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newItem.dietary_type}
                      onChange={e => setNewItem({ ...newItem, dietary_type: e.target.value as DietaryType })}
                    >
                      <option value="VEG">Veg</option>
                      <option value="VEGAN">Vegan</option>
                      <option value="NON_VEG">Non-Veg</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Category</label>
                    <select 
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      value={newItem.category}
                      onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                    >
                      <option>Mains</option>
                      <option>Starters</option>
                      <option>Sides</option>
                      <option>Drinks</option>
                      <option>Desserts</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-2">
                  <input 
                    type="checkbox"
                    id="is_daily_special"
                    checked={newItem.is_daily_special}
                    onChange={e => setNewItem({ ...newItem, is_daily_special: e.target.checked })}
                    className="w-4 h-4 rounded border-[#5A5A40]/20 text-[#5A5A40] focus:ring-[#5A5A40]/20"
                  />
                  <label htmlFor="is_daily_special" className="text-xs font-bold text-[#5A5A40]">Daily Special Item</label>
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Item Image</label>
                  <input 
                    type="file"
                    accept="image/*"
                    className="w-full text-sm text-[#5A5A40]/50 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#5A5A40]/10 file:text-[#5A5A40] hover:file:bg-[#5A5A40]/20"
                    onChange={e => setNewItem({ ...newItem, imageFile: e.target.files?.[0] || null })}
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold hover:bg-[#4A4A30] transition-all mt-4"
                >
                  Create Item
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- CHEF DASHBOARD ---
function ChefDashboard({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const { lastMessage } = useSocket('CHEF', restaurantId);

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchOrders();
  }, [restaurantId]);

  useEffect(() => {
    if (lastMessage?.type === 'NEW_ORDER') {
      fetchOrders();
      new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3').play().catch(() => {});
    }
  }, [lastMessage]);

  const fetchOrders = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/orders`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setOrders(await res.json());
      } else {
        console.error("Failed to fetch orders", await res.text());
      }
    } catch (err) {
      console.error("Error fetching orders:", err);
    }
  };

  const updateOrderStatus = async (id: string, status: string, eta?: string) => {
    await fetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status, eta })
    });
    fetchOrders();
  };

  const activeOrders = orders.filter(o => !['DELIVERED', 'CANCELLED'].includes(o.status));

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold font-serif">Kitchen Queue</h2>
        <div className="flex items-center gap-2 bg-[#5A5A40]/10 px-4 py-2 rounded-full">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs font-bold text-[#5A5A40] uppercase tracking-widest">Live Updates</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {activeOrders.map(order => (
          <motion.div 
            layout
            key={order.id} 
            className="bg-white rounded-[32px] border border-[#5A5A40]/5 shadow-sm overflow-hidden"
          >
            <div className="p-6 border-b border-[#5A5A40]/5 flex justify-between items-center bg-[#fcfcfc]">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 block">Table {order.tableNumber}</span>
                <h4 className="text-lg font-bold font-mono">{order.id}</h4>
              </div>
              <span className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest",
                order.status === 'PENDING' ? "bg-orange-100 text-orange-600" : "bg-blue-100 text-blue-600"
              )}>
                {order.status}
              </span>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-2">
                {order.items.map((item, idx) => (
                  <div key={idx} className="flex justify-between text-sm">
                    <span><span className="font-bold text-[#5A5A40]">{item.quantity}x</span> {item.name}</span>
                  </div>
                ))}
              </div>

              {order.status === 'PENDING' && (
                <div className="pt-4 space-y-3">
                  <div className="flex gap-2">
                    {['15m', '30m', '45m'].map(time => (
                      <button 
                        key={time}
                        onClick={() => updateOrderStatus(order.id, 'PREPARING', time)}
                        className="flex-1 py-2 rounded-xl border border-[#5A5A40]/20 text-xs font-bold hover:bg-[#5A5A40] hover:text-white transition-all"
                      >
                        {time}
                      </button>
                    ))}
                  </div>
                  <button 
                    onClick={() => updateOrderStatus(order.id, 'PREPARING', '10m')}
                    className="w-full bg-[#5A5A40] text-white py-3 rounded-xl font-bold text-sm"
                  >
                    Confirm & Start
                  </button>
                </div>
              )}

              {order.status === 'PREPARING' && (
                <button 
                  onClick={() => updateOrderStatus(order.id, 'READY')}
                  className="w-full bg-green-600 text-white py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2"
                >
                  <CheckCircle2 size={18} /> Mark as Ready
                </button>
              )}

              {order.status === 'READY' && (
                <button 
                  onClick={() => updateOrderStatus(order.id, 'DELIVERED')}
                  className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-sm"
                >
                  Delivered
                </button>
              )}
            </div>
          </motion.div>
        ))}
        {activeOrders.length === 0 && (
          <div className="col-span-full py-20 text-center text-[#5A5A40]/40">
            <ChefHat size={48} className="mx-auto mb-4 opacity-20" />
            <p className="font-serif italic text-xl">No active orders in the kitchen.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- CUSTOMER INTERFACE ---
function CustomerInterface({ restaurantId }: { restaurantId: string }) {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [order, setOrder] = useState<Order | null>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [customerInfo, setCustomerInfo] = useState({ name: '', phone: '' });
  const [tableNumber, setTableNumber] = useState("Online");
  const [tableName, setTableName] = useState("Online Order");
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterDietary, setFilterDietary] = useState('All');
  const [filterSize, setFilterSize] = useState('All');
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

  const fetchTableInfo = async () => {
    const params = new URLSearchParams(window.location.search);
    const tableId = params.get('table');
    if (!tableId) return;

    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/tables/public`);
      if (res.ok) {
        const tables: any[] = await res.json();
        const table = tables.find(t => t.id === tableId);
        if (table) setTableName(table.name);
      }
    } catch (err) {
      console.error("Failed to fetch table info", err);
    }
  };

  const fetchRestaurant = async () => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}`);
      if (res.ok) {
        setRestaurant(await res.json());
      }
    } catch (err) {
      console.error("Error fetching restaurant:", err);
    }
  };

  const fetchOrder = async (id: string) => {
    try {
      const res = await fetch(`/api/orders/${id}?restaurantId=${restaurantId}`);
      if (res.ok) {
        setOrder(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch order", err);
    }
  };

  useEffect(() => {
    if (lastMessage?.type === 'ORDER_UPDATE' && order && lastMessage.orderId === order.id) {
      setOrder(prev => prev ? { ...prev, status: lastMessage.status, eta: lastMessage.eta } : null);
    }
  }, [lastMessage, order]);

  const fetchMenu = async () => {
    try {
      const res = await fetch(`/api/restaurant/${restaurantId}/menu`);
      if (res.ok) {
        setMenu(await res.json());
      }
    } catch (err) {
      console.error("Error fetching menu:", err);
    }
  };

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
        name: `${item.name} (${size})`, 
        price: price, 
        quantity: 1,
        size: size
      }];
    });
  };

  const removeFromCart = (menuItemId: string) => {
    setCart(prev => prev.filter(i => i.menuItemId !== menuItemId));
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const placeOrder = async (paymentMethod: 'ONLINE' | 'TABLE') => {
    if (!customerInfo.name || !customerInfo.phone) {
      alert("Please provide your name and phone number.");
      return;
    }

    try {
      const gstAmount = restaurant?.is_gst_enabled 
        ? cartTotal * ((restaurant?.gst_percentage || 0) / 100)
        : 0;
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: restaurantId,
          tableNumber: tableName,
          customerName: customerInfo.name,
          customerPhone: customerInfo.phone,
          items: cart.map(i => ({ 
            id: i.menuItemId, 
            name: i.name, 
            price: i.price, 
            quantity: i.quantity,
            size: i.size
          })),
          totalAmount: cartTotal,
          gstAmount: gstAmount,
          paymentMethod
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to place order');
      }

      const data = await res.json();
      
      if (!data.orderId) {
        throw new Error('Server did not return an order ID');
      }

      const newOrder: Order = {
        id: data.orderId,
        restaurantId: restaurantId,
        tableNumber: tableName,
        customerName: customerInfo.name,
        customerPhone: customerInfo.phone,
        items: cart,
        totalAmount: cartTotal,
        gstAmount: gstAmount,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString()
      };
      setOrder(newOrder);
      setCart([]);
      setIsCheckingOut(false);
      localStorage.setItem('last_restaurant_id', restaurantId);

      // Simulate WhatsApp Message
      const trackingUrl = `${window.location.origin}?r=${restaurantId}&orderId=${data.orderId}`;
      const message = `Hello ${customerInfo.name}! Your order ${data.orderId} at ${restaurant?.name || 'RestoFlow'} has been placed. Track it live here: ${trackingUrl}`;
      console.log("SIMULATING WHATSAPP MESSAGE TO:", customerInfo.phone);
      console.log("MESSAGE CONTENT:", message);
      
      setTimeout(() => {
        alert(`[WhatsApp Simulation]\nTo: ${customerInfo.phone}\nMessage: ${message}`);
      }, 1000);
    } catch (error: any) {
      console.error('Order placement error:', error);
      alert(`Error: ${error.message || 'Something went wrong while placing your order. Please try again.'}`);
    }
  };

  if (order) {
    return (
      <div className="max-w-md mx-auto space-y-8">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-[40px] shadow-xl border border-[#5A5A40]/5 text-center"
        >
          <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 size={40} />
          </div>
          <h2 className="text-3xl font-bold font-serif mb-2">Order Confirmed!</h2>
          <p className="text-[#5A5A40]/60 mb-8">Your order <span className="font-mono font-bold text-[#1a1a1a]">{order.id}</span> is being prepared.</p>
          
          <div className="bg-[#f5f5f0] p-6 rounded-3xl space-y-4 mb-8">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[#5A5A40]/60 uppercase tracking-widest font-bold">Status</span>
              <span className="px-3 py-1 bg-[#5A5A40] text-white rounded-full text-[10px] font-bold uppercase tracking-widest">
                {order.status}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-[#5A5A40]/60 uppercase tracking-widest font-bold">Estimated Time</span>
              <span className="text-xl font-bold font-serif text-[#5A5A40]">
                {order.eta || 'Waiting for Chef...'}
              </span>
            </div>
          </div>

          <button 
            onClick={() => setShowInvoice(true)}
            className="w-full border-2 border-[#5A5A40] text-[#5A5A40] py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-[#5A5A40] hover:text-white transition-all"
          >
            <Receipt size={20} /> View Invoice
          </button>
        </motion.div>

        <AnimatePresence>
          {showInvoice && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[110] p-4">
              <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white rounded-[32px] p-8 w-full max-w-md shadow-2xl relative"
              >
                <button onClick={() => setShowInvoice(false)} className="absolute top-6 right-6 text-[#5A5A40]/50 hover:text-[#5A5A40]">
                  <X />
                </button>
                
                <div className="text-center border-b border-[#5A5A40]/10 pb-6 mb-6">
                  <Utensils className="w-10 h-10 mx-auto mb-2 text-[#5A5A40]" />
                  <h3 className="text-2xl font-bold font-serif">{restaurant?.name || 'RestoFlow'}</h3>
                  {restaurant?.is_gst_enabled && restaurant?.gst_number && (
                    <p className="text-[10px] font-bold text-[#5A5A40]/50 uppercase tracking-widest mt-1">GSTIN: {restaurant.gst_number}</p>
                  )}
                </div>

                <div className="space-y-4 mb-8">
                  <div className="flex justify-between text-xs text-[#5A5A40]/50 uppercase tracking-widest font-bold">
                    <span>Order ID: {order.id}</span>
                    <span>{new Date(order.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="space-y-2">
                    {order.items.map((item, idx) => (
                      <div key={idx} className="flex justify-between text-sm">
                        <span>{item.quantity}x {item.name}</span>
                        <span className="font-mono">₹{(item.price * item.quantity).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t-2 border-dashed border-[#5A5A40]/10 pt-4 mb-8">
                  <div className="space-y-2 mb-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-[#5A5A40]/60">Subtotal</span>
                      <span className="font-mono">₹{order.totalAmount.toFixed(2)}</span>
                    </div>
                    {order.gstAmount ? (
                      <div className="flex justify-between text-sm">
                        <span className="text-[#5A5A40]/60">GST</span>
                        <span className="font-mono">₹{order.gstAmount.toFixed(2)}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-between text-xl font-bold font-serif">
                    <span>Total Amount</span>
                    <span className="font-mono">
                      ₹{(order.totalAmount + (order.gstAmount || 0)).toFixed(2)}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#5A5A40]/40 text-center mt-6 uppercase tracking-widest font-bold">Thank you for dining with us!</p>
                </div>

                <button 
                  onClick={() => window.print()}
                  className="w-full bg-[#5A5A40] text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2"
                >
                  Print Invoice
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <div className="text-center">
          <button onClick={() => setOrder(null)} className="text-[#5A5A40] underline text-sm">Place another order</button>
        </div>
      </div>
    );
  }

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
          <span className="text-[8px] font-bold uppercase tracking-tighter">Vegan</span>
        </div>
      );
      return (
        <div className="w-3 h-3 bg-red-600 rounded-full shadow-sm" title="Non-Vegetarian" />
      );
    };

    if (template === 'MODERN') {
      return (
        <div className="space-y-12">
          {sortedMenu.map(item => (
            <div key={item.id} className={cn(
              "flex flex-col md:flex-row gap-8 items-center bg-white p-8 rounded-[40px] shadow-sm relative",
              item.is_daily_special && "border-2 border-yellow-400"
            )}>
              {item.is_daily_special && <div className="absolute -top-3 left-8 bg-yellow-400 text-yellow-950 px-4 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest shadow-md">Daily Special</div>}
              <div className="w-full md:w-1/3 aspect-square rounded-3xl overflow-hidden">
                <img src={item.image || `https://picsum.photos/seed/${item.id}/600/600`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              </div>
              <div className="flex-1 space-y-4">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    <DietaryIcon type={item.dietary_type} />
                    <h4 className="text-3xl font-bold">{item.name}</h4>
                  </div>
                  <div className="text-right">
                    <span className="text-2xl font-mono font-bold">₹{item.price_full || item.price}</span>
                    {item.price_half && <p className="text-sm text-[#5A5A40]/50 font-mono">Half: ₹{item.price_half}</p>}
                  </div>
                </div>
                <p className="text-lg text-[#5A5A40]/60">{item.description}</p>
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

    if (template === 'EDITORIAL') {
      return (
        <div className="max-w-3xl mx-auto space-y-16 py-12">
          {['Starters', 'Mains', 'Desserts', 'Drinks'].map(cat => {
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
                          <h4 className="text-2xl font-bold uppercase tracking-tighter group-hover:text-[#5A5A40] transition-colors">{item.name}</h4>
                        </div>
                        <div className="flex-1 border-b border-dotted border-[#1a1a1a]/20 mx-4" />
                        <div className="text-right">
                          <span className="text-xl font-mono">₹{item.price_full || item.price}</span>
                          {item.price_half && <p className="text-[10px] font-mono opacity-50">H: ₹{item.price_half}</p>}
                        </div>
                      </div>
                      <p className="text-[#5A5A40]/60 italic font-serif mb-4">{item.description}</p>
                      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); addToCart(item, 'FULL'); }} className="text-[10px] font-bold uppercase tracking-widest bg-[#1a1a1a] text-white px-4 py-1 rounded-full">Add Full</button>
                        {item.price_half && <button onClick={(e) => { e.stopPropagation(); addToCart(item, 'HALF'); }} className="text-[10px] font-bold uppercase tracking-widest border border-[#1a1a1a] px-4 py-1 rounded-full">Add Half</button>}
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

    // Default CLASSIC
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sortedMenu.map(item => (
          <motion.div 
            key={item.id} 
            className={cn(
              "bg-white rounded-[32px] overflow-hidden border shadow-sm group relative",
              item.is_daily_special ? "border-yellow-400 ring-2 ring-yellow-400/20" : "border-[#5A5A40]/5"
            )}
          >
            {item.is_daily_special && (
              <div className="absolute top-4 left-4 z-10 bg-yellow-400 text-yellow-950 text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full flex items-center gap-1 shadow-lg">
                <Star size={12} fill="currentColor" /> Daily Special
              </div>
            )}
            <div className="aspect-[4/3] bg-[#f5f5f0] relative overflow-hidden">
              <img 
                src={item.image || `https://picsum.photos/seed/${item.id}/600/450`} 
                alt={item.name} 
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                referrerPolicy="no-referrer"
              />
              <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-xs font-bold font-mono flex flex-col items-end">
                <span>₹{(item.price_full || item.price).toFixed(2)}</span>
                {item.price_half && <span className="text-[8px] opacity-50">H: ₹{item.price_half.toFixed(2)}</span>}
              </div>
            </div>
            <div className="p-6">
              <div className="flex justify-between items-start mb-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50">{item.category}</span>
                <DietaryIcon type={item.dietary_type} />
              </div>
              <h4 className="text-xl font-bold font-serif mb-2">{item.name}</h4>
              <p className="text-sm text-[#5A5A40]/60 mb-6 line-clamp-2">{item.description}</p>
              <div className="flex gap-2">
                <button 
                  onClick={() => addToCart(item, 'FULL')}
                  className="flex-1 bg-[#f5f5f0] text-[#5A5A40] py-3 rounded-2xl font-bold hover:bg-[#5A5A40] hover:text-white transition-all flex items-center justify-center gap-2 text-xs"
                >
                  <Plus size={14} /> Full
                </button>
                {item.price_half && (
                  <button 
                    onClick={() => addToCart(item, 'HALF')}
                    className="flex-1 border border-[#5A5A40]/20 text-[#5A5A40] py-3 rounded-2xl font-bold hover:bg-[#5A5A40] hover:text-white transition-all flex items-center justify-center gap-2 text-xs"
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

  return (
    <div className="space-y-8 pb-32">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-4xl font-bold font-serif mb-2">{restaurant?.name || 'Our Menu'}</h2>
          <p className="text-[#5A5A40]/60 italic">{tableName} • Fresh & Seasonal</p>
        </div>
        <div className="bg-white p-2 rounded-2xl shadow-sm border border-[#5A5A40]/5">
          <QRCodeSVG value={`${window.location.origin}?r=${restaurantId}`} size={60} />
        </div>
      </div>

      <div className="space-y-4">
        <div className="relative">
          <input 
            type="text"
            placeholder="Search for dishes..."
            className="w-full bg-white border border-[#5A5A40]/10 rounded-2xl pl-12 pr-4 py-4 focus:ring-2 ring-[#5A5A40]/20 outline-none shadow-sm"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#5A5A40]/40" size={20} />
        </div>
        
        <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
          {['All', 'Starters', 'Mains', 'Sides', 'Drinks', 'Desserts'].map(cat => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={cn(
                "px-6 py-2 rounded-full text-xs font-bold whitespace-nowrap transition-all",
                filterCategory === cat ? "bg-[#5A5A40] text-white shadow-md" : "bg-white text-[#5A5A40] border border-[#5A5A40]/10"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex gap-4">
          <select 
            className="bg-white border border-[#5A5A40]/10 rounded-xl px-4 py-2 text-xs font-bold text-[#5A5A40] outline-none"
            value={filterDietary}
            onChange={e => setFilterDietary(e.target.value)}
          >
            <option value="All">All Dietary</option>
            <option value="VEG">Veg</option>
            <option value="VEGAN">Vegan</option>
            <option value="NON_VEG">Non-Veg</option>
          </select>
          <select 
            className="bg-white border border-[#5A5A40]/10 rounded-xl px-4 py-2 text-xs font-bold text-[#5A5A40] outline-none"
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

      {/* Checkout Modal */}
      <AnimatePresence>
        {isCheckingOut && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end md:items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="bg-white rounded-t-[40px] md:rounded-[40px] p-8 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-between items-center mb-8">
                <h3 className="text-3xl font-bold font-serif">Your Order</h3>
                <button onClick={() => setIsCheckingOut(false)} className="text-[#5A5A40]/50 hover:text-[#5A5A40]">
                  <X />
                </button>
              </div>

              <div className="space-y-4 mb-8">
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Your Name</label>
                    <input 
                      required
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      placeholder="John Doe"
                      value={customerInfo.name}
                      onChange={e => setCustomerInfo({ ...customerInfo, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#5A5A40]/50 mb-1 block">Phone Number (for WhatsApp)</label>
                    <input 
                      required
                      type="tel"
                      className="w-full bg-[#f5f5f0] border-none rounded-2xl px-4 py-3 focus:ring-2 ring-[#5A5A40]/20 outline-none"
                      placeholder="+1 234 567 890"
                      value={customerInfo.phone}
                      onChange={e => setCustomerInfo({ ...customerInfo, phone: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4 mb-8">
                {cart.map(item => (
                  <div key={item.id} className="flex justify-between items-center">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-[#f5f5f0] rounded-xl flex items-center justify-center font-bold text-[#5A5A40]">
                        {item.quantity}x
                      </div>
                      <div>
                        <p className="font-bold">{item.name}</p>
                        <p className="text-xs text-[#5A5A40]/50">₹{item.price.toFixed(2)} each</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-mono font-bold">₹{(item.price * item.quantity).toFixed(2)}</p>
                      <button onClick={() => removeFromCart(item.menuItemId)} className="text-red-400">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-[#5A5A40]/10 pt-6 space-y-4 mb-8">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-[#5A5A40]/60">Subtotal</span>
                    <span className="font-mono">₹{cartTotal.toFixed(2)}</span>
                  </div>
                  {restaurant?.is_gst_enabled && restaurant?.gst_percentage ? (
                    <div className="flex justify-between text-sm">
                      <span className="text-[#5A5A40]/60">GST ({restaurant.gst_percentage}%)</span>
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

              <div className="space-y-3">
                <button 
                  onClick={() => placeOrder('ONLINE')}
                  className="w-full bg-[#5A5A40] text-white py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#4A4A30] transition-all"
                >
                  <CreditCard size={20} /> Pay Online Now
                </button>
                <button 
                  onClick={() => placeOrder('TABLE')}
                  className="w-full border-2 border-[#5A5A40] text-[#5A5A40] py-5 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-[#5A5A40] hover:text-white transition-all"
                >
                  <Utensils size={20} /> Pay at Table
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
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'INACTIVE' | 'PENDING'>('PENDING');

  useEffect(() => {
    fetchRestaurants();
  }, []);

  const fetchRestaurants = async () => {
    try {
      const res = await fetch('/api/admin/restaurants', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) setRestaurants(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
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
        const data = await res.json();
        if (res.ok) {
          alert("Password reset successfully");
        } else {
          alert("Error: " + (data.error || "Failed to reset password"));
        }
      } catch (err) {
        alert("Network error. Please try again.");
      }
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
        <div className="w-12 h-12 border-4 border-[#5A5A40] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold font-serif">ERP Super Admin</h2>
          <p className="text-sm text-[#5A5A40]/60">Manage business partners, approvals, and activations.</p>
        </div>
        <div className="flex bg-white p-1 rounded-2xl border border-[#5A5A40]/10 overflow-x-auto max-w-full">
          <button 
            onClick={() => setActiveTab('PENDING')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
              activeTab === 'PENDING' ? "bg-orange-500 text-white shadow-md" : "text-[#5A5A40] hover:bg-[#5A5A40]/5"
            )}
          >
            Pending Approval ({restaurants.filter(r => r.is_active === 0).length})
          </button>
          <button 
            onClick={() => setActiveTab('ACTIVE')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
              activeTab === 'ACTIVE' ? "bg-green-600 text-white shadow-md" : "text-[#5A5A40] hover:bg-[#5A5A40]/5"
            )}
          >
            Active Business ({restaurants.filter(r => r.is_active === 1).length})
          </button>
          <button 
            onClick={() => setActiveTab('INACTIVE')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
              activeTab === 'INACTIVE' ? "bg-[#5A5A40] text-white shadow-md" : "text-[#5A5A40] hover:bg-[#5A5A40]/5"
            )}
          >
            Inactive Business ({restaurants.filter(r => r.is_active === 2).length})
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredRestaurants.map(r => (
          <div key={r.id} className="bg-white p-8 rounded-[40px] border border-[#5A5A40]/5 shadow-sm space-y-6 flex flex-col">
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <h3 className="text-xl font-bold font-serif">{r.name}</h3>
                <p className="text-xs text-[#5A5A40]/50 font-mono">{r.city}, {r.state}</p>
              </div>
              <div className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest",
                r.is_active === 1 ? "bg-green-100 text-green-700" : 
                r.is_active === 0 ? "bg-orange-100 text-orange-700" : 
                "bg-red-100 text-red-700"
              )}>
                {r.is_active === 1 ? 'Active' : r.is_active === 0 ? 'Pending' : 'Inactive'}
              </div>
            </div>
            
            <div className="space-y-3 flex-1">
              <div className="flex items-center gap-3 text-sm">
                <User size={16} className="text-[#5A5A40]/40" />
                <span className="font-medium">{r.owner_name}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Star size={16} className="text-[#5A5A40]/40" />
                <span>{r.owner_phone || 'No Phone'}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Mail size={16} className="text-[#5A5A40]/40" />
                <span className="truncate">{r.owner_email}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Lock size={16} className="text-[#5A5A40]/40" />
                <span className="font-mono text-xs bg-[#f5f5f0] px-2 py-1 rounded">{r.owner_login_id}</span>
              </div>
            </div>

            <div className="pt-6 border-t border-[#5A5A40]/10 flex flex-col gap-3">
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
                onClick={() => resetPassword(r.id)}
                className="w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-[#5A5A40] border border-[#5A5A40]/10 hover:bg-[#5A5A40]/5 transition-all"
              >
                Reset Owner Password
              </button>
            </div>
          </div>
        ))}
        {filteredRestaurants.length === 0 && (
          <div className="col-span-full py-20 text-center bg-white rounded-[40px] border border-dashed border-[#5A5A40]/20">
            <p className="text-[#5A5A40]/40 italic">No {activeTab.toLowerCase().replace('_', ' ')} businesses found.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function WaiterDashboard({ restaurantId, token }: { restaurantId: string, token: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [tables, setTables] = useState<Table[]>([]);

  useEffect(() => {
    if (!restaurantId || restaurantId === 'null' || restaurantId === 'undefined') return;
    fetchData();
  }, [restaurantId]);

  const fetchData = async () => {
    try {
      const [ordersRes, tablesRes] = await Promise.all([
        fetch(`/api/restaurant/${restaurantId}/orders`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`/api/restaurant/${restaurantId}/tables`, { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      if (ordersRes.ok) setOrders(await ordersRes.json());
      if (tablesRes.ok) setTables(await tablesRes.json());
    } catch (err) {
      console.error(err);
    }
  };

  const readyOrders = orders.filter(o => o.status === 'READY');
  const myTables = tables; // In a real app, filter by assigned_waiter_id

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold font-serif">Waiter Dashboard</h2>
        <div className="bg-green-100 text-green-700 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest">
          {readyOrders.length} Orders Ready for Pickup
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <h3 className="text-xl font-bold font-serif">Ready to Serve</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {readyOrders.map(order => (
              <div key={order.id} className="bg-white p-6 rounded-[32px] border-2 border-green-200 shadow-sm space-y-4">
                <div className="flex justify-between items-center">
                  <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-[10px] font-bold uppercase">Ready</span>
                  <span className="font-mono font-bold">{order.id}</span>
                </div>
                <div>
                  <p className="text-2xl font-bold text-[#1a1a1a]">{order.tableNumber}</p>
                  <p className="text-sm text-[#5A5A40]/60">{order.customerName}</p>
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
              <div className="col-span-full p-12 text-center bg-white rounded-[32px] border border-dashed border-[#5A5A40]/20">
                <p className="text-[#5A5A40]/40 italic">No orders ready for pickup right now.</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <h3 className="text-xl font-bold font-serif">My Tables</h3>
          <div className="space-y-3">
            {myTables.map(table => (
              <div key={table.id} className="bg-white p-4 rounded-2xl border border-[#5A5A40]/5 flex justify-between items-center">
                <span className="font-bold">{table.name}</span>
                <span className="text-[10px] uppercase tracking-widest text-[#5A5A40]/50">Active</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
