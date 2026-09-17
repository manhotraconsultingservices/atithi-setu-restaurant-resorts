// ─────────────────────────────────────────────────────────────────────────────
// Notifications workspace: a WhatsApp business console in the style of WATI and
// Gupshup. Six tabs, each a fixed-height pane so nothing needs a long scroll:
//   Inbox       shared team inbox; free text inside the 24-hour window,
//               an approved template outside it
//   Broadcasts  approved template to an audience from the property's records
//   Automations event messages (who hears about what) and automatic replies
//   Templates   Meta-approved templates (read only) and email/SMS wording
//   Analytics   delivery totals, templates, top contacts and the message log
//   Settings    mail server, smart alerts and the opt-out list
// WhatsApp tabs are hidden when the tenant does not have the WhatsApp module.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, Megaphone, Zap, FileText, BarChart3, Settings as SettingsIcon, Search, Send, RefreshCw,
  CheckCircle2, Clock, UserPlus, Tag, X, Plus, Trash2, MessageSquare, Lock, Ban, PenSquare,
} from 'lucide-react';
import { useToast } from './components/Toast';
import { useT } from './i18n';
import { canWriteTab } from './perm';
import { moduleOn } from './tenantModules';
import { cn } from './lib/utils';

type Tpl = { name: string; language: string; status: string; category: string; body: string; variable_count: number };
type EventDef = { id: string; label: string; roles: string[]; group: string; description: string };
type ChannelDef = { id: string; label: string; icon: any };

export interface NotificationsWorkspaceProps {
  token: string;
  restaurantId: string;
  propertyName: string;
  events: EventDef[];
  channels: ChannelDef[];
  renderWording: (canEdit: boolean) => React.ReactNode;
  renderEmailServer: (canEdit: boolean) => React.ReactNode;
  renderSmartAlerts: () => React.ReactNode;
}

const PANE = 'h-[calc(100vh-190px)] min-h-[460px]';
const CARD = 'bg-white rounded-2xl border border-brand/10';
const fmtWhen = (v: any) => {
  if (!v) return '';
  const d = new Date(v);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
const initials = (s: string) => (String(s || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();

function useApi(token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: async (url: string) => {
      const r = await fetch(url, { headers: auth });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(b.error || 'Request failed'), { code: b.code, status: r.status });
      return b;
    },
    send: async (method: string, url: string, body?: any) => {
      const r = await fetch(url, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(b.error || 'Request failed'), { code: b.code, status: r.status });
      return b;
    },
  };
}

function useTemplates(token: string, enabled: boolean) {
  const api = useApi(token);
  const [all, setAll] = useState<Tpl[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!enabled) return;
    api.get('/api/owner/whatsapp/templates')
      .then(d => { setAll(d.templates || []); setConfigured(!!d.configured); setReason(d.reason || ''); })
      .catch(() => setConfigured(false));
  }, [enabled]);
  const approved = all.filter(t => String(t.status).toUpperCase() === 'APPROVED');
  return { all, approved, configured, reason };
}

// Fill {{1}} with the property name and the rest with the values typed.
const renderTpl = (body: string, propertyName: string, vars: string[]) =>
  String(body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) =>
    Number(n) === 1 ? (propertyName || 'Your property') : (vars[Number(n) - 2] || `{{${n}}}`));

function TemplatePicker({ templates, value, onChange, vars, setVars, propertyName, allowName }: {
  templates: Tpl[]; value: string; onChange: (n: string) => void; vars: string[]; setVars: (v: string[]) => void; propertyName: string; allowName?: boolean;
}) {
  const { t } = useT();
  const tpl = templates.find(x => x.name === value);
  return (
    <div className="space-y-2">
      <select value={value} onChange={e => {
        const n = e.target.value; onChange(n);
        const x = templates.find(y => y.name === n);
        setVars(Array.from({ length: Math.max(0, (x?.variable_count || 1) - 1) }, () => ''));
      }} className="w-full border border-brand/15 rounded-xl px-3 py-2 text-sm bg-white">
        <option value="">{t('nw.pickTemplate')}</option>
        {templates.map(x => <option key={`${x.name}-${x.language}`} value={x.name}>{x.name} · {x.category} · {x.language}</option>)}
      </select>
      {vars.map((v, i) => (
        <input key={i} value={v} onChange={e => { const n = [...vars]; n[i] = e.target.value; setVars(n); }}
          placeholder={`{{${i + 2}}}${allowName ? ` — ${t('nw.nameHint')}` : ''}`}
          className="w-full border border-brand/15 rounded-xl px-3 py-2 text-sm" />
      ))}
      {tpl && <p className="text-xs whitespace-pre-wrap bg-[#e7f7ec] border border-emerald-100 rounded-xl px-3 py-2 text-[#1a1208]">{renderTpl(tpl.body, propertyName, vars)}</p>}
    </div>
  );
}

// ══ Inbox ════════════════════════════════════════════════════════════════════
function InboxTab({ token, restaurantId, canEdit, propertyName }: { token: string; restaurantId: string; canEdit: boolean; propertyName: string }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const { approved } = useTemplates(token, true);
  const [filter, setFilter] = useState('OPEN');
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [counts, setCounts] = useState<any>({});
  const [active, setActive] = useState<string>('');
  const [conv, setConv] = useState<any>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [quick, setQuick] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const loadList = async () => {
    try {
      const d = await api.get(`/api/owner/inbox/conversations?filter=${filter}&q=${encodeURIComponent(q)}`);
      setList(d.conversations || []); setCounts(d.counts || {});
    } catch (e: any) { toast.error(e.message); }
  };
  const loadConv = async (contact: string) => {
    try {
      const d = await api.get(`/api/owner/inbox/conversation?contact=${encodeURIComponent(contact)}`);
      setConv(d); setNotes(d.notes || ''); setTags(d.tags || '');
      if (list.find(c => c.contact === contact)?.unread) {
        api.send('POST', '/api/owner/inbox/read', { contact }).then(() => setList(l => l.map(c => c.contact === contact ? { ...c, unread: 0 } : c))).catch(() => {});
      }
    } catch (e: any) { toast.error(e.message); }
  };
  useEffect(() => { loadList(); }, [filter]);
  useEffect(() => { const h = setTimeout(loadList, 300); return () => clearTimeout(h); }, [q]);
  useEffect(() => { const h = setInterval(() => { loadList(); if (active) loadConv(active); }, 15000); return () => clearInterval(h); }, [active, filter, q]);
  useEffect(() => { if (active) loadConv(active); }, [active]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [conv?.messages?.length]);
  useEffect(() => {
    api.get('/api/owner/inbox/quick-replies').then(d => setQuick(d.quick_replies || [])).catch(() => {});
    api.get(`/api/restaurant/${restaurantId}/staff-picker`).then(d => setStaff(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const patch = async (body: any) => {
    try {
      await api.send('PATCH', '/api/owner/inbox/conversation', { contact: active, ...body });
      setConv((c: any) => ({ ...c, ...body })); loadList();
    } catch (e: any) { toast.error(e.message); }
  };
  const reply = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.send('POST', '/api/owner/inbox/reply', { contact: active, text });
      setText(''); loadConv(active);
    } catch (e: any) {
      if (e.code === 'WINDOW_CLOSED') setTplOpen(true);
      toast.error(e.message);
    }
    setSending(false);
  };
  const sendTemplate = async () => {
    const tpl = approved.find(x => x.name === tplName);
    if (!tpl) return;
    setSending(true);
    try {
      await api.send('POST', '/api/owner/inbox/template', { contact: active, template_name: tpl.name, language: tpl.language, category: tpl.category, variables: vars });
      setTplOpen(false); setTplName(''); setVars([]); loadConv(active);
      toast.success(t('nw.templateSent'));
    } catch (e: any) { toast.error(e.message); }
    setSending(false);
  };
  const onText = (v: string) => {
    setText(v);
  };
  const slash = text.startsWith('/') ? quick.filter(x => ('/' + x.shortcut).startsWith(text.split(/\s/)[0])) : [];

  const FILTERS = [
    ['OPEN', t('nw.open'), counts.open], ['UNREAD', t('nw.unread'), counts.unread], ['MINE', t('nw.mine'), counts.mine],
    ['UNASSIGNED', t('nw.unassigned'), counts.unassigned], ['RESOLVED', t('nw.resolved'), counts.resolved], ['ALL', t('nw.all'), counts.all],
  ];

  return (
    <div className={cn('grid gap-3 grid-cols-1 md:grid-cols-[300px_1fr] xl:grid-cols-[300px_1fr_260px]', PANE)}>
      {/* Conversation list */}
      <div className={cn(CARD, 'flex flex-col min-h-0', active && 'hidden md:flex')}>
        <div className="p-3 border-b border-brand/10 space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 border border-brand/15 rounded-xl px-2.5">
              <Search size={14} className="text-[#9c8e85]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('nw.searchContacts')} className="flex-1 py-1.5 text-sm outline-none bg-transparent" />
            </div>
            {canEdit && <button onClick={() => setComposeOpen(true)} title={t('nw.newMessage')} className="p-2 rounded-xl bg-brand text-white hover:bg-brand-dark"><PenSquare size={15} /></button>}
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([id, label, n]) => (
              <button key={id} onClick={() => setFilter(id)}
                className={cn('px-2 py-1 rounded-lg text-[11px] font-bold', filter === id ? 'bg-brand text-white' : 'bg-[#faf7f2] text-[#6b5d52] hover:bg-brand/10')}>
                {label}{n ? ` ${n}` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0 && <p className="p-6 text-center text-sm text-[#9c8e85]">{t('nw.noConversations')}</p>}
          {list.map(c => (
            <button key={c.contact} onClick={() => setActive(c.contact)}
              className={cn('w-full text-left px-3 py-2.5 flex gap-2.5 border-b border-[#f3ece2] hover:bg-[#faf7f2]', active === c.contact && 'bg-brand/5')}>
              <span className="w-9 h-9 shrink-0 rounded-full bg-brand/10 text-brand text-xs font-bold flex items-center justify-center">{initials(c.name || c.contact.slice(-2))}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1">
                  <span className="font-bold text-sm text-[#1a1208] truncate">{c.name || c.phone}</span>
                  <span className="ml-auto text-[10px] text-[#9c8e85] shrink-0">{fmtWhen(c.last_at)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-xs text-[#6b5d52] truncate">{c.last_direction === 'OUT' ? '↪ ' : ''}{c.last_preview}</span>
                  {c.unread > 0 && <span className="ml-auto shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center">{c.unread}</span>}
                </span>
                <span className="flex items-center gap-1 mt-0.5">
                  <span className={cn('w-1.5 h-1.5 rounded-full', c.window_open ? 'bg-emerald-500' : 'bg-[#d8ccbf]')} />
                  {c.assigned_name && <span className="text-[10px] text-[#6b5d52] truncate">{c.assigned_name}</span>}
                  {String(c.tags || '').split(',').filter(Boolean).slice(0, 2).map((tg: string) => <span key={tg} className="text-[10px] px-1.5 rounded bg-amber-50 text-amber-700">{tg.trim()}</span>)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className={cn(CARD, 'flex flex-col min-h-0', !active && 'hidden md:flex')}>
        {!conv ? (
          <div className="flex-1 flex flex-col items-center justify-center text-[#9c8e85] gap-2"><Inbox size={28} /><p className="text-sm">{t('nw.pickConversation')}</p></div>
        ) : (
          <>
            <div className="px-4 py-2.5 border-b border-brand/10 flex items-center gap-2">
              <button className="md:hidden p-1" onClick={() => { setActive(''); setConv(null); }}><X size={16} /></button>
              <div className="min-w-0">
                <p className="font-bold text-sm truncate">{conv.name || conv.phone}</p>
                <p className="text-[11px] text-[#6b5d52] flex items-center gap-1">
                  {conv.window_open
                    ? <><Clock size={11} className="text-emerald-600" /> {t('nw.windowOpen', { time: new Date(conv.window_closes_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) })}</>
                    : <><Lock size={11} /> {t('nw.windowClosed')}</>}
                  {conv.opted_out && <span className="ml-1 text-rose-700 flex items-center gap-0.5"><Ban size={11} /> {t('nw.optedOut')}</span>}
                </p>
              </div>
              {canEdit && (
                <button onClick={() => patch({ status: conv.status === 'RESOLVED' ? 'OPEN' : 'RESOLVED' })}
                  className={cn('ml-auto px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1',
                    conv.status === 'RESOLVED' ? 'bg-[#faf7f2] text-[#6b5d52]' : 'bg-emerald-600 text-white hover:bg-emerald-700')}>
                  <CheckCircle2 size={13} /> {conv.status === 'RESOLVED' ? t('nw.reopen') : t('nw.resolve')}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5 bg-[#f7f3ec]">
              {(conv.messages || []).map((m: any) => {
                const inbound = String(m.direction || 'OUT') === 'IN';
                return (
                  <div key={m.id} className={cn('flex', inbound ? 'justify-start' : 'justify-end')}>
                    <div className={cn('max-w-[78%] rounded-2xl px-3 py-1.5 text-sm shadow-sm', inbound ? 'bg-white rounded-tl-sm' : 'bg-[#dcf5e3] rounded-tr-sm')}>
                      {m.template_name && <p className="text-[10px] font-bold text-emerald-800 mb-0.5">{t('nw.template')}: {m.template_name}</p>}
                      {!inbound && m.event_name && !['INBOX_REPLY', 'INBOX_TEMPLATE'].includes(m.event_name) && <p className="text-[10px] text-[#6b5d52] mb-0.5">{String(m.event_name).replace(/_/g, ' ').toLowerCase()}</p>}
                      <p className="whitespace-pre-wrap break-words">{m.preview}</p>
                      <p className="text-[10px] text-[#9c8e85] text-right mt-0.5">
                        {new Date(m.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        {!inbound && <span className={cn('ml-1 font-bold', m.status === 'FAILED' ? 'text-rose-600' : m.status === 'READ' ? 'text-sky-600' : '')} title={m.error || ''}>
                          {m.status === 'READ' ? '✓✓' : m.status === 'DELIVERED' ? '✓✓' : m.status === 'FAILED' ? '!' : '✓'}
                        </span>}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottom} />
            </div>
            {canEdit && moduleOn('whatsapp') && (
              <div className="border-t border-brand/10 p-2.5 relative">
                {slash.length > 0 && (
                  <div className="absolute bottom-full left-2.5 right-2.5 mb-1 bg-white border border-brand/15 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                    {slash.map(x => (
                      <button key={x.id} onClick={() => setText(x.body)} className="w-full text-left px-3 py-2 hover:bg-[#faf7f2] text-sm">
                        <b>/{x.shortcut}</b> <span className="text-[#6b5d52]">{String(x.body).slice(0, 70)}</span>
                      </button>
                    ))}
                  </div>
                )}
                {conv.window_open && !tplOpen ? (
                  <div className="flex items-end gap-2">
                    <textarea value={text} onChange={e => onText(e.target.value)} rows={2}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !slash.length) { e.preventDefault(); reply(); } }}
                      placeholder={t('nw.typeReply')} className="flex-1 resize-none border border-brand/15 rounded-xl px-3 py-2 text-sm" />
                    <button onClick={() => setTplOpen(true)} title={t('nw.sendTemplate')} className="p-2.5 rounded-xl bg-[#faf7f2] text-[#6b5d52] hover:bg-brand/10"><FileText size={16} /></button>
                    <button onClick={reply} disabled={sending || !text.trim()} className="p-2.5 rounded-xl bg-brand text-white disabled:opacity-40"><Send size={16} /></button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {!conv.window_open && <p className="text-[11px] text-amber-800 bg-amber-50 rounded-lg px-2 py-1">{t('nw.windowClosedHint')}</p>}
                    <TemplatePicker templates={approved} value={tplName} onChange={setTplName} vars={vars} setVars={setVars} propertyName={propertyName} />
                    <div className="flex gap-2 justify-end">
                      {conv.window_open && <button onClick={() => setTplOpen(false)} className="px-3 py-1.5 rounded-xl text-xs font-bold bg-[#faf7f2]">{t('nw.cancel')}</button>}
                      <button onClick={sendTemplate} disabled={sending || !tplName} className="px-3 py-1.5 rounded-xl text-xs font-bold bg-brand text-white disabled:opacity-40">{t('nw.sendTemplate')}</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Contact panel */}
      <div className={cn(CARD, 'hidden xl:flex flex-col min-h-0 overflow-y-auto p-3 space-y-3')}>
        {conv ? (
          <>
            <div className="text-center">
              <span className="mx-auto w-12 h-12 rounded-full bg-brand/10 text-brand font-bold flex items-center justify-center">{initials(conv.name || conv.contact.slice(-2))}</span>
              <p className="font-bold mt-1 text-sm">{conv.name || '—'}</p>
              <p className="text-xs text-[#6b5d52]">{conv.phone}</p>
            </div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9c8e85]"><UserPlus size={11} className="inline mr-1" />{t('nw.assignee')}
              <select disabled={!canEdit} value={conv.assigned_to || ''} onChange={e => {
                const s = staff.find(x => String(x.id) === e.target.value);
                patch({ assigned_to: e.target.value || null, assigned_name: s?.name || '' });
              }} className="mt-1 w-full border border-brand/15 rounded-xl px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-[#1a1208] bg-white">
                <option value="">{t('nw.unassigned')}</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9c8e85]"><Tag size={11} className="inline mr-1" />{t('nw.tags')}
              <input disabled={!canEdit} value={tags} onChange={e => setTags(e.target.value)} onBlur={() => tags !== (conv.tags || '') && patch({ tags })}
                placeholder={t('nw.tagsHint')} className="mt-1 w-full border border-brand/15 rounded-xl px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-[#1a1208]" />
            </label>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9c8e85]">{t('nw.notes')}
              <textarea disabled={!canEdit} value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => notes !== (conv.notes || '') && patch({ notes })}
                rows={5} className="mt-1 w-full border border-brand/15 rounded-xl px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-[#1a1208] resize-none" />
            </label>
          </>
        ) : <p className="text-xs text-[#9c8e85] text-center mt-8">{t('nw.contactDetails')}</p>}
        <QuickReplies token={token} canEdit={canEdit} items={quick} onChange={setQuick} />
      </div>

      {composeOpen && <ComposeModal token={token} propertyName={propertyName} templates={approved} onClose={() => { setComposeOpen(false); loadList(); }} />}
    </div>
  );
}

function QuickReplies({ token, canEdit, items, onChange }: { token: string; canEdit: boolean; items: any[]; onChange: (v: any[]) => void }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [shortcut, setShortcut] = useState('');
  const [body, setBody] = useState('');
  const reload = () => api.get('/api/owner/inbox/quick-replies').then(d => onChange(d.quick_replies || [])).catch(() => {});
  return (
    <div className="border-t border-brand/10 pt-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[#9c8e85] mb-1">{t('nw.quickReplies')}</p>
      <div className="space-y-1">
        {items.map(x => (
          <div key={x.id} className="flex items-start gap-1 text-xs">
            <span className="flex-1 min-w-0"><b>/{x.shortcut}</b> <span className="text-[#6b5d52] line-clamp-1">{x.body}</span></span>
            {canEdit && <button onClick={() => api.send('DELETE', `/api/owner/inbox/quick-replies/${x.id}`).then(reload).catch((e: any) => toast.error(e.message))} className="text-[#9c8e85] hover:text-rose-600"><Trash2 size={12} /></button>}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="mt-2 space-y-1">
          <input value={shortcut} onChange={e => setShortcut(e.target.value)} placeholder={t('nw.shortcut')} className="w-full border border-brand/15 rounded-lg px-2 py-1 text-xs" />
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} placeholder={t('nw.message')} className="w-full border border-brand/15 rounded-lg px-2 py-1 text-xs resize-none" />
          <button disabled={!shortcut.trim() || !body.trim()} onClick={() => api.send('POST', '/api/owner/inbox/quick-replies', { shortcut, body })
            .then(() => { setShortcut(''); setBody(''); reload(); }).catch((e: any) => toast.error(e.message))}
            className="w-full py-1 rounded-lg bg-brand/10 text-brand text-xs font-bold disabled:opacity-40"><Plus size={12} className="inline" /> {t('nw.add')}</button>
        </div>
      )}
    </div>
  );
}

function ComposeModal({ token, propertyName, templates, onClose }: { token: string; propertyName: string; templates: Tpl[]; onClose: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const wa = moduleOn('whatsapp');
  const [channel, setChannel] = useState<'WHATSAPP' | 'EMAIL' | 'SMS'>(wa ? 'WHATSAPP' : 'EMAIL');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [tplName, setTplName] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const recipients = to.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  const tpl = templates.find(x => x.name === tplName);
  const send = async () => {
    setBusy(true);
    try {
      const d = await api.send('POST', '/api/owner/messaging/send', {
        channel, recipients, text, subject, template_name: channel === 'WHATSAPP' ? tplName : '',
        template_language: tpl?.language || 'en', category: tpl?.category || 'UTILITY', variables: vars,
      });
      if (d.sent) { toast.success(t('nw.sentTo', { n: d.sent, total: recipients.length })); onClose(); }
      else toast.error((d.results || []).map((r: any) => r.error).filter(Boolean)[0] || t('nw.nothingSent'));
    } catch (e: any) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center"><h3 className="font-bold">{t('nw.newMessage')}</h3><button onClick={onClose} className="ml-auto"><X size={18} /></button></div>
        <div className="flex gap-1">
          {(['WHATSAPP', 'EMAIL', 'SMS'] as const).filter(c => c !== 'WHATSAPP' || wa).map(c => (
            <button key={c} onClick={() => setChannel(c)} className={cn('px-3 py-1.5 rounded-xl text-xs font-bold', channel === c ? 'bg-brand text-white' : 'bg-[#faf7f2] text-[#6b5d52]')}>{c === 'WHATSAPP' ? 'WhatsApp' : c === 'EMAIL' ? 'Email' : 'SMS'}</button>
          ))}
        </div>
        <textarea value={to} onChange={e => setTo(e.target.value)} rows={2} placeholder={channel === 'EMAIL' ? t('nw.toEmails') : t('nw.toPhones')} className="w-full border border-brand/15 rounded-xl px-3 py-2 text-sm" />
        {channel === 'EMAIL' && <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={t('nw.subject')} className="w-full border border-brand/15 rounded-xl px-3 py-2 text-sm" />}
        {channel === 'WHATSAPP'
          ? <TemplatePicker templates={templates} value={tplName} onChange={setTplName} vars={vars} setVars={setVars} propertyName={propertyName} />
          : <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder={t('nw.message')} className="w-full border border-brand/15 rounded-xl px-3 py-2 text-sm" />}
        <button onClick={send} disabled={busy || !recipients.length || (channel === 'WHATSAPP' ? !tplName : !text.trim())}
          className="w-full py-2.5 rounded-xl bg-brand text-white font-bold disabled:opacity-40 flex items-center justify-center gap-2"><Send size={15} /> {t('nw.send')}</button>
      </div>
    </div>
  );
}

// ══ Broadcasts ═══════════════════════════════════════════════════════════════
const SOURCES = ['ARRIVALS', 'IN_HOUSE', 'PAST_STAYS', 'DINERS', 'SPA_CLIENTS', 'EVENT_CUSTOMERS', 'MANUAL'];

function BroadcastsTab({ token, canEdit, propertyName }: { token: string; canEdit: boolean; propertyName: string }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const { approved } = useTemplates(token, true);
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const load = () => api.get('/api/owner/broadcasts').then(d => setList(d.broadcasts || [])).catch((e: any) => toast.error(e.message));
  useEffect(() => { load(); const h = setInterval(load, 20000); return () => clearInterval(h); }, []);
  const open = (id: string) => api.get(`/api/owner/broadcasts/${id}`).then(setSel).catch((e: any) => toast.error(e.message));

  const pct = (a: number, b: number) => b ? `${Math.round((a / b) * 100)}%` : '—';
  const pill = (s: string) => ({ SENT: 'bg-emerald-50 text-emerald-700', SENDING: 'bg-sky-50 text-sky-700', SCHEDULED: 'bg-amber-50 text-amber-700', CANCELLED: 'bg-[#faf7f2] text-[#9c8e85]', FAILED: 'bg-rose-50 text-rose-700' } as any)[s] || 'bg-[#faf7f2]';

  return (
    <div className={cn('grid gap-3 grid-cols-1 lg:grid-cols-[1fr_380px]', PANE)}>
      <div className={cn(CARD, 'flex flex-col min-h-0')}>
        <div className="px-4 py-2.5 border-b border-brand/10 flex items-center gap-2">
          <h3 className="font-bold text-sm">{t('nw.broadcasts')}</h3>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-[#faf7f2]"><RefreshCw size={13} /></button>
          {canEdit && <button onClick={() => { setCreating(true); setSel(null); }} className="ml-auto px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1"><Plus size={13} /> {t('nw.newBroadcast')}</button>}
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#f5f0e8] text-[11px] uppercase text-[#6b5d52]">
              <tr>{['name', 'status', 'recipients', 'sentCol', 'delivered', 'read', 'replied', 'failed', 'when'].map(k => <th key={k} className="text-left px-3 py-2 whitespace-nowrap">{t(`nw.col.${k}`)}</th>)}</tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={9} className="p-8 text-center text-[#9c8e85]">{t('nw.noBroadcasts')}</td></tr>}
              {list.map(b => (
                <tr key={b.id} onClick={() => { setCreating(false); open(b.id); }} className={cn('border-t border-[#f0e8d8] cursor-pointer hover:bg-[#faf7f2]', sel?.broadcast?.id === b.id && 'bg-brand/5')}>
                  <td className="px-3 py-2"><p className="font-bold">{b.name}</p><p className="text-[11px] text-[#6b5d52]">{b.template_name}</p></td>
                  <td className="px-3 py-2"><span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', pill(b.status))}>{t(`nw.st.${b.status}`)}</span></td>
                  <td className="px-3 py-2 tabular-nums">{b.total}</td>
                  <td className="px-3 py-2 tabular-nums">{b.sent}</td>
                  <td className="px-3 py-2 tabular-nums">{b.delivered} <span className="text-[10px] text-[#9c8e85]">{pct(b.delivered, b.sent)}</span></td>
                  <td className="px-3 py-2 tabular-nums">{b.read} <span className="text-[10px] text-[#9c8e85]">{pct(b.read, b.sent)}</span></td>
                  <td className="px-3 py-2 tabular-nums">{b.replied}</td>
                  <td className="px-3 py-2 tabular-nums text-rose-700">{b.failed || ''}</td>
                  <td className="px-3 py-2 text-xs text-[#6b5d52] whitespace-nowrap">{new Date(b.scheduled_at || b.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={cn(CARD, 'min-h-0 overflow-y-auto p-4')}>
        {creating ? <BroadcastForm token={token} templates={approved} propertyName={propertyName} onDone={() => { setCreating(false); load(); }} />
          : sel ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <div><h3 className="font-bold">{sel.broadcast.name}</h3><p className="text-xs text-[#6b5d52]">{sel.broadcast.template_name} · {t(`nw.src.${(() => { try { return JSON.parse(sel.broadcast.audience || '{}').source; } catch { return ''; } })()}`)}</p></div>
                {canEdit && ['SCHEDULED', 'SENDING'].includes(sel.broadcast.status) && (
                  <button onClick={() => api.send('POST', `/api/owner/broadcasts/${sel.broadcast.id}/cancel`).then(() => { load(); open(sel.broadcast.id); }).catch((e: any) => toast.error(e.message))}
                    className="ml-auto px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 text-xs font-bold">{t('nw.cancelBroadcast')}</button>
                )}
              </div>
              {sel.broadcast.last_error && <p className="text-xs text-rose-700 bg-rose-50 rounded-lg px-2 py-1">{sel.broadcast.last_error}</p>}
              <div className="max-h-[60vh] overflow-y-auto border border-[#f0e8d8] rounded-xl">
                <table className="w-full text-xs">
                  <tbody>
                    {(sel.recipients || []).map((r: any) => (
                      <tr key={r.contact} className="border-t border-[#f0e8d8] first:border-0">
                        <td className="px-2 py-1.5"><p className="font-medium">{r.name || r.phone}</p>{r.name && <p className="text-[10px] text-[#9c8e85]">{r.phone}</p>}</td>
                        <td className="px-2 py-1.5 text-right" title={r.delivery_error || r.error || ''}>
                          <span className={cn('font-bold', (r.delivery_status || r.send_status) === 'FAILED' ? 'text-rose-700' : (r.delivery_status || r.send_status) === 'SKIPPED' ? 'text-amber-700' : 'text-emerald-700')}>
                            {t(`nw.rs.${r.delivery_status || r.send_status}`)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : <div className="h-full flex flex-col items-center justify-center text-[#9c8e85] gap-2"><Megaphone size={26} /><p className="text-sm text-center">{t('nw.broadcastHint')}</p></div>}
      </div>
    </div>
  );
}

function BroadcastForm({ token, templates, propertyName, onDone }: { token: string; templates: Tpl[]; propertyName: string; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [name, setName] = useState('');
  const [tplName, setTplName] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const [source, setSource] = useState('PAST_STAYS');
  const [days, setDays] = useState(90);
  const [manual, setManual] = useState('');
  const [when, setWhen] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const tpl = templates.find(x => x.name === tplName);
  const contacts = useMemo(() => manual.split('\n').map(l => {
    const parts = l.split(/[,;\t]/).map(s => s.trim());
    const phone = parts.find(p => /\d{10}/.test(p.replace(/\D/g, ''))) || '';
    const nm = parts.find(p => p && p !== phone) || '';
    return { phone, name: nm };
  }).filter(c => c.phone), [manual]);
  const audience = () => ({ source, days, ...(source === 'MANUAL' ? { contacts } : {}) });
  useEffect(() => {
    const h = setTimeout(() => {
      api.send('POST', '/api/owner/broadcasts/audience', { audience: audience(), category: tpl?.category || 'MARKETING' })
        .then(setPreview).catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(h);
  }, [source, days, manual, tplName]);
  const onFile = async (f: File | undefined) => { if (f) setManual(await f.text()); };
  const create = async () => {
    setBusy(true);
    try {
      await api.send('POST', '/api/owner/broadcasts', {
        name, template_name: tplName, language: tpl?.language || 'en', category: tpl?.category || 'MARKETING',
        variables: vars, audience: audience(), scheduled_at: when ? new Date(when).toISOString() : null,
      });
      toast.success(when ? t('nw.scheduled') : t('nw.sending'));
      onDone();
    } catch (e: any) { toast.error(e.message); }
    setBusy(false);
  };
  const inp = 'w-full border border-brand/15 rounded-xl px-3 py-2 text-sm';
  return (
    <div className="space-y-3">
      <h3 className="font-bold">{t('nw.newBroadcast')}</h3>
      <input value={name} onChange={e => setName(e.target.value)} placeholder={t('nw.broadcastName')} className={inp} />
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-[#9c8e85] mb-1">{t('nw.audience')}</p>
        <div className="flex flex-wrap gap-1">
          {SOURCES.map(s => <button key={s} onClick={() => setSource(s)} className={cn('px-2 py-1 rounded-lg text-[11px] font-bold', source === s ? 'bg-brand text-white' : 'bg-[#faf7f2] text-[#6b5d52]')}>{t(`nw.src.${s}`)}</button>)}
        </div>
        {['ARRIVALS', 'PAST_STAYS', 'DINERS', 'EVENT_CUSTOMERS'].includes(source) && (
          <label className="flex items-center gap-2 text-xs mt-2 text-[#6b5d52]">{source === 'ARRIVALS' ? t('nw.nextDays') : t('nw.lastDays')}
            <input type="number" min={1} max={730} value={days} onChange={e => setDays(Number(e.target.value) || 30)} className="w-20 border border-brand/15 rounded-lg px-2 py-1" />
          </label>
        )}
        {source === 'MANUAL' && (
          <div className="mt-2 space-y-1">
            <textarea value={manual} onChange={e => setManual(e.target.value)} rows={4} placeholder={t('nw.manualHint')} className={inp} />
            <input type="file" accept=".csv,.txt" onChange={e => onFile(e.target.files?.[0])} className="text-xs" />
          </div>
        )}
        {preview && (
          <p className="text-xs mt-2 bg-[#faf7f2] rounded-lg px-2 py-1.5">
            {t('nw.reach', { n: preview.reachable, total: preview.count, opted: preview.opted_out })}
            {preview.estimated_cost > 0 && <> · {t('nw.estCost', { cost: `₹${Number(preview.estimated_cost).toLocaleString('en-IN')}` })}</>}
          </p>
        )}
      </div>
      <TemplatePicker templates={templates} value={tplName} onChange={setTplName} vars={vars} setVars={setVars} propertyName={propertyName} allowName />
      <label className="block text-xs text-[#6b5d52]">{t('nw.scheduleFor')}
        <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={cn(inp, 'mt-1')} />
      </label>
      <button onClick={create} disabled={busy || !name.trim() || !tplName || !(preview?.count > 0)}
        className="w-full py-2.5 rounded-xl bg-brand text-white font-bold disabled:opacity-40 flex items-center justify-center gap-2">
        <Megaphone size={15} /> {when ? t('nw.schedule') : t('nw.sendNow')}
      </button>
    </div>
  );
}

// ══ Automations ══════════════════════════════════════════════════════════════
function AutomationsTab({ token, canEdit, events, channels }: { token: string; canEdit: boolean; events: EventDef[]; channels: ChannelDef[] }) {
  const { t } = useT();
  const wa = moduleOn('whatsapp');
  const [view, setView] = useState<'EVENTS' | 'REPLIES'>('EVENTS');
  return (
    <div className={cn('flex flex-col gap-2', PANE)}>
      {wa && (
        <div className="flex gap-1">
          {(['EVENTS', 'REPLIES'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className={cn('px-3 py-1.5 rounded-xl text-xs font-bold', view === v ? 'bg-brand text-white' : 'bg-white border border-brand/10 text-[#6b5d52]')}>
              {v === 'EVENTS' ? t('nw.eventMessages') : t('nw.autoReplies')}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {view === 'EVENTS' || !wa ? <EventMatrix token={token} canEdit={canEdit} events={events} channels={channels} /> : <AutoReplies token={token} canEdit={canEdit} />}
      </div>
    </div>
  );
}

function EventMatrix({ token, canEdit, events, channels }: { token: string; canEdit: boolean; events: EventDef[]; channels: ChannelDef[] }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [settings, setSettings] = useState<any[]>([]);
  const [group, setGroup] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<any>(null);
  const chans = channels.filter(c => c.id !== 'whatsapp_enabled' || moduleOn('whatsapp'));
  useEffect(() => { api.get('/api/owner/notification-settings').then(d => setSettings(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  const groups = Array.from(new Set(events.map(e => e.group)));
  const shown = group ? events.filter(e => e.group === group) : events;
  const isGuest = (r: string) => String(r).toUpperCase() === 'CUSTOMER';
  const setting = (ev: string, role: string) => settings.find(s => s.event_name === ev && s.role === role);
  const on = (ev: EventDef, guest: boolean, ch: string) => ev.roles.filter(r => isGuest(r) === guest).some(r => !!setting(ev.id, r)?.[ch]);

  const persist = (next: any[]) => {
    clearTimeout(timer.current);
    setSaveState('saving');
    timer.current = setTimeout(() => {
      api.send('POST', '/api/owner/notification-settings', { settings: next })
        .then(() => { setSaveState('saved'); setTimeout(() => setSaveState('idle'), 1500); })
        .catch((e: any) => { setSaveState('idle'); toast.error(e.message); });
    }, 700);
  };
  // A team channel applies to every team role of the event at once.
  const toggle = (ev: EventDef, guest: boolean, ch: string) => {
    if (!canEdit) return;
    const val = on(ev, guest, ch) ? 0 : 1;
    const roles = ev.roles.filter(r => isGuest(r) === guest);
    const next = [...settings];
    for (const role of roles) {
      const i = next.findIndex(s => s.event_name === ev.id && s.role === role);
      if (i >= 0) next[i] = { ...next[i], [ch]: val };
      else next.push({ event_name: ev.id, role, whatsapp_enabled: 0, sms_enabled: 0, email_enabled: 0, telegram_enabled: 0, telegram_chat_id: '', [ch]: val });
    }
    setSettings(next);
    persist(next);
  };
  const test = (id: string) => api.send('POST', '/api/owner/test-notification', { eventName: id })
    .then(() => toast.success(t('nw.testSent'))).catch((e: any) => toast.error(e.message));

  const cell = (ev: EventDef, guest: boolean) => ev.roles.some(r => isGuest(r) === guest)
    ? <div className="flex gap-1">{chans.map(c => {
        const o = on(ev, guest, c.id);
        return <button key={c.id} disabled={!canEdit} title={c.label} onClick={() => toggle(ev, guest, c.id)}
          className={cn('w-7 h-7 rounded-lg flex items-center justify-center border transition-colors disabled:cursor-default', o ? 'bg-brand text-white border-brand' : 'bg-white text-[#c4b6a8] border-[#e8dccf] hover:border-brand/40')}><c.icon size={13} /></button>;
      })}</div>
    : <span className="text-[#d8ccbf] text-xs">—</span>;

  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-[200px_1fr] h-full">
      <div className={cn(CARD, 'hidden md:block overflow-y-auto p-2')}>
        {[['', t('nw.all')], ...groups.map(g => [g, g])].map(([id, label]) => (
          <button key={id} onClick={() => setGroup(id)} className={cn('w-full text-left px-3 py-2 rounded-xl text-sm', group === id ? 'bg-brand/10 text-brand font-bold' : 'text-[#6b5d52] hover:bg-[#faf7f2]')}>
            {label}
            <span className="float-right text-[11px] text-[#9c8e85]">{(id ? events.filter(e => e.group === id) : events).filter(e => chans.some(c => on(e, true, c.id) || on(e, false, c.id))).length}</span>
          </button>
        ))}
      </div>
      <div className={cn(CARD, 'flex flex-col min-h-0')}>
        <div className="px-4 py-2 border-b border-brand/10 flex items-center gap-2 text-xs">
          <select value={group} onChange={e => setGroup(e.target.value)} className="md:hidden border border-brand/15 rounded-lg px-2 py-1">
            <option value="">{t('nw.all')}</option>{groups.map(g => <option key={g}>{g}</option>)}
          </select>
          <span className="flex gap-2 text-[#6b5d52]">{chans.map(c => <span key={c.id} className="flex items-center gap-1"><c.icon size={12} />{c.label}</span>)}</span>
          <span className="ml-auto text-[#9c8e85]">{saveState === 'saving' ? t('nw.saving') : saveState === 'saved' ? `✓ ${t('nw.saved')}` : ''}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[#f5f0e8] text-[11px] uppercase text-[#6b5d52] z-10">
              <tr><th className="text-left px-3 py-2">{t('nw.event')}</th><th className="text-left px-3 py-2">{t('nw.guests')}</th><th className="text-left px-3 py-2">{t('nw.team')}</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {shown.map(ev => (
                <tr key={ev.id} className="border-t border-[#f0e8d8] hover:bg-[#fdfbf7]">
                  <td className="px-3 py-1.5" title={ev.description}><p className="font-medium text-[13px]">{ev.label}</p>{!group && <p className="text-[10px] text-[#9c8e85]">{ev.group}</p>}</td>
                  <td className="px-3 py-1.5">{cell(ev, true)}</td>
                  <td className="px-3 py-1.5">{cell(ev, false)}</td>
                  <td className="px-3 py-1.5 text-right">{canEdit && <button onClick={() => test(ev.id)} className="text-[11px] font-bold text-brand hover:underline">{t('nw.test')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const DAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];
function AutoReplies({ token, canEdit }: { token: string; canEdit: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [rules, setRules] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/owner/automations').then(d => setRules(d.rules || [])).catch((e: any) => toast.error(e.message)); }, []);
  const welcome = rules.find(r => r.kind === 'WELCOME');
  const away = rules.find(r => r.kind === 'AWAY');
  const keywords = rules.filter(r => r.kind === 'KEYWORD');
  const upd = (rule: any, patch: any) => { setRules(rs => rs.map(r => r === rule ? { ...r, ...patch } : r)); setDirty(true); };
  const add = (rule: any) => { setRules(rs => [...rs, rule]); setDirty(true); };
  const remove = (rule: any) => { setRules(rs => rs.filter(r => r !== rule)); setDirty(true); };
  const save = async () => {
    setBusy(true);
    try { const d = await api.send('PUT', '/api/owner/automations', { rules }); setRules(d.rules || rules); setDirty(false); toast.success(t('nw.saved')); }
    catch (e: any) { toast.error(e.message); }
    setBusy(false);
  };
  const inp = 'w-full border border-brand/15 rounded-xl px-3 py-2 text-sm';
  const Toggle = ({ rule, onAdd }: { rule: any; onAdd: () => void }) => (
    <button disabled={!canEdit} onClick={() => rule ? upd(rule, { is_active: Number(rule.is_active) ? 0 : 1 }) : onAdd()}
      className={cn('ml-auto w-10 h-5 rounded-full relative transition-colors', rule && Number(rule.is_active) ? 'bg-brand' : 'bg-[#e8dccf]')}>
      <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all', rule && Number(rule.is_active) ? 'left-5' : 'left-0.5')} />
    </button>
  );
  return (
    <div className="h-full flex flex-col gap-2">
      <div className="grid gap-3 grid-cols-1 lg:grid-cols-3 flex-1 min-h-0">
        <div className={cn(CARD, 'p-4 space-y-2 overflow-y-auto')}>
          <div className="flex items-center"><h4 className="font-bold text-sm">{t('nw.welcome')}</h4><Toggle rule={welcome} onAdd={() => add({ kind: 'WELCOME', is_active: 1, reply_text: '' })} /></div>
          <p className="text-[11px] text-[#9c8e85]">{t('nw.welcomeHint')}</p>
          {welcome && <textarea disabled={!canEdit} value={welcome.reply_text} onChange={e => upd(welcome, { reply_text: e.target.value })} rows={5} className={inp} />}
        </div>
        <div className={cn(CARD, 'p-4 space-y-2 overflow-y-auto')}>
          <div className="flex items-center"><h4 className="font-bold text-sm">{t('nw.away')}</h4><Toggle rule={away} onAdd={() => add({ kind: 'AWAY', is_active: 1, reply_text: '', hours_start: '09:00', hours_end: '21:00', days: '0,1,2,3,4,5,6' })} /></div>
          <p className="text-[11px] text-[#9c8e85]">{t('nw.awayHint')}</p>
          {away && (
            <>
              <div className="flex items-center gap-2 text-xs">
                <input disabled={!canEdit} type="time" value={away.hours_start || ''} onChange={e => upd(away, { hours_start: e.target.value })} className="border border-brand/15 rounded-lg px-2 py-1" />
                <span>–</span>
                <input disabled={!canEdit} type="time" value={away.hours_end || ''} onChange={e => upd(away, { hours_end: e.target.value })} className="border border-brand/15 rounded-lg px-2 py-1" />
              </div>
              <div className="flex gap-1">
                {DAY_KEYS.map(d => {
                  const set = String(away.days || '').split(',');
                  const o = set.includes(d);
                  return <button key={d} disabled={!canEdit} onClick={() => upd(away, { days: (o ? set.filter(x => x !== d) : [...set, d]).filter(Boolean).sort().join(',') })}
                    className={cn('w-7 h-7 rounded-lg text-[11px] font-bold', o ? 'bg-brand text-white' : 'bg-[#faf7f2] text-[#9c8e85]')}>{t(`nw.day${d}`)}</button>;
                })}
              </div>
              <textarea disabled={!canEdit} value={away.reply_text} onChange={e => upd(away, { reply_text: e.target.value })} rows={4} className={inp} />
            </>
          )}
        </div>
        <div className={cn(CARD, 'p-4 space-y-2 overflow-y-auto')}>
          <div className="flex items-center"><h4 className="font-bold text-sm">{t('nw.keywordReplies')}</h4>
            {canEdit && <button onClick={() => add({ kind: 'KEYWORD', is_active: 1, keywords: '', match_mode: 'CONTAINS', reply_text: '' })} className="ml-auto text-xs font-bold text-brand flex items-center gap-0.5"><Plus size={13} />{t('nw.add')}</button>}
          </div>
          <p className="text-[11px] text-[#9c8e85]">{t('nw.keywordHint')}</p>
          {keywords.map((r, i) => (
            <div key={r.id || `new-${i}`} className="border border-[#f0e8d8] rounded-xl p-2 space-y-1.5">
              <div className="flex gap-1">
                <input disabled={!canEdit} value={r.keywords || ''} onChange={e => upd(r, { keywords: e.target.value })} placeholder={t('nw.keywords')} className="flex-1 border border-brand/15 rounded-lg px-2 py-1 text-xs" />
                <select disabled={!canEdit} value={r.match_mode} onChange={e => upd(r, { match_mode: e.target.value })} className="border border-brand/15 rounded-lg px-1 text-xs">
                  <option value="CONTAINS">{t('nw.contains')}</option><option value="EXACT">{t('nw.exact')}</option>
                </select>
                {canEdit && <button onClick={() => remove(r)} className="text-[#9c8e85] hover:text-rose-600 px-1"><Trash2 size={13} /></button>}
              </div>
              <textarea disabled={!canEdit} value={r.reply_text} onChange={e => upd(r, { reply_text: e.target.value })} rows={2} placeholder={t('nw.reply')} className="w-full border border-brand/15 rounded-lg px-2 py-1 text-xs resize-none" />
            </div>
          ))}
        </div>
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <button onClick={save} disabled={!dirty || busy} className="px-5 py-2 rounded-xl bg-brand text-white text-sm font-bold disabled:opacity-40">{busy ? t('nw.saving') : t('nw.save')}</button>
        </div>
      )}
    </div>
  );
}

// ══ Templates ════════════════════════════════════════════════════════════════
function TemplatesTab({ token, canEdit, propertyName, renderWording }: { token: string; canEdit: boolean; propertyName: string; renderWording: (c: boolean) => React.ReactNode }) {
  const { t } = useT();
  const wa = moduleOn('whatsapp');
  const [view, setView] = useState<'WA' | 'WORDING'>(wa ? 'WA' : 'WORDING');
  const { all, configured, reason } = useTemplates(token, wa);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Tpl | null>(null);
  const shown = all.filter(x => !q || `${x.name} ${x.category} ${x.body}`.toLowerCase().includes(q.toLowerCase()));
  const pill = (s: string) => String(s).toUpperCase() === 'APPROVED' ? 'bg-emerald-50 text-emerald-700' : String(s).toUpperCase() === 'REJECTED' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700';
  return (
    <div className={cn('flex flex-col gap-2', PANE)}>
      {wa && (
        <div className="flex gap-1">
          {(['WA', 'WORDING'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className={cn('px-3 py-1.5 rounded-xl text-xs font-bold', view === v ? 'bg-brand text-white' : 'bg-white border border-brand/10 text-[#6b5d52]')}>
              {v === 'WA' ? t('nw.waTemplates') : t('nw.emailSmsWording')}
            </button>
          ))}
        </div>
      )}
      {view === 'WORDING' ? <div className="flex-1 min-h-0 overflow-y-auto">{renderWording(canEdit)}</div> : (
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-[1fr_340px] flex-1 min-h-0">
          <div className={cn(CARD, 'flex flex-col min-h-0')}>
            <div className="px-3 py-2 border-b border-brand/10 flex items-center gap-2">
              <Search size={14} className="text-[#9c8e85]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('nw.searchTemplates')} className="flex-1 text-sm outline-none" />
              <span className="text-xs text-[#9c8e85]">{t('nw.approvedByMeta')}</span>
            </div>
            <div className="flex-1 overflow-auto">
              {configured === false && <p className="p-6 text-sm text-center text-[#9c8e85]">{reason || t('nw.notConnected')}</p>}
              <table className="w-full text-sm">
                <tbody>
                  {shown.map(x => (
                    <tr key={`${x.name}-${x.language}`} onClick={() => setSel(x)} className={cn('border-t border-[#f0e8d8] cursor-pointer hover:bg-[#faf7f2]', sel === x && 'bg-brand/5')}>
                      <td className="px-3 py-2 font-medium">{x.name}</td>
                      <td className="px-3 py-2 text-xs text-[#6b5d52]">{x.category}</td>
                      <td className="px-3 py-2 text-xs text-[#6b5d52]">{x.language}</td>
                      <td className="px-3 py-2"><span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', pill(x.status))}>{x.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className={cn(CARD, 'p-4 overflow-y-auto')}>
            {sel ? (
              <div className="space-y-2">
                <p className="font-bold">{sel.name}</p>
                <p className="text-xs text-[#6b5d52]">{sel.category} · {sel.language} · {t('nw.variables', { n: sel.variable_count })}</p>
                <div className="bg-[#efe7dc] rounded-2xl p-3"><p className="bg-white rounded-xl rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap shadow-sm">{renderTpl(sel.body, propertyName, [])}</p></div>
                <p className="text-[11px] text-[#9c8e85] flex items-center gap-1"><Lock size={11} /> {t('nw.readOnlyTemplate')}</p>
              </div>
            ) : <p className="text-sm text-[#9c8e85] text-center mt-10">{t('nw.pickTemplateToPreview')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ══ Analytics ════════════════════════════════════════════════════════════════
function AnalyticsTab({ token }: { token: string }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [days, setDays] = useState(30);
  const [sum, setSum] = useState<any>(null);
  const [log, setLog] = useState<any[]>([]);
  const [status, setStatus] = useState('ALL');
  const [who, setWho] = useState('');
  useEffect(() => { api.get(`/api/owner/messaging/summary?days=${days}`).then(setSum).catch((e: any) => toast.error(e.message)); }, [days]);
  useEffect(() => {
    const h = setTimeout(() => {
      const qs = new URLSearchParams({ limit: '200' });
      if (who) qs.set('recipient', who);
      if (status === 'RECEIVED') qs.set('direction', 'IN'); else if (status !== 'ALL') qs.set('status', status);
      api.get(`/api/owner/notification-deliveries?${qs}`).then(d => setLog(d.deliveries || [])).catch(() => {});
    }, 300);
    return () => clearTimeout(h);
  }, [status, who]);
  const tot = sum?.totals || {};
  const tiles: [string, any, string][] = [
    ['sentCol', tot.sent, ''], ['delivered', tot.delivered, 'text-emerald-700'], ['read', tot.read, 'text-sky-700'],
    ['failed', tot.failed, 'text-rose-700'], ['received', tot.received, 'text-brand'], ['people', tot.people, ''],
  ];
  const daily = sum?.daily || [];
  const max = Math.max(1, ...daily.map((d: any) => Number(d.total || 0)));
  return (
    <div className={cn('grid gap-3 grid-cols-1 lg:grid-cols-[1fr_1.2fr] min-h-0', PANE)}>
      <div className="flex flex-col gap-3 min-h-0">
        <div className={cn(CARD, 'p-3')}>
          <div className="flex items-center gap-1 mb-2">
            {[7, 30, 90].map(d => <button key={d} onClick={() => setDays(d)} className={cn('px-2.5 py-1 rounded-lg text-xs font-bold', days === d ? 'bg-brand text-white' : 'bg-[#faf7f2] text-[#6b5d52]')}>{t('nw.daysN', { n: d })}</button>)}
            {sum?.cost?.estimated_total > 0 && <span className="ml-auto text-xs text-[#6b5d52]">{t('nw.estCost', { cost: `₹${Number(sum.cost.estimated_total).toLocaleString('en-IN')}` })}</span>}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {tiles.map(([k, v, c]) => (
              <button key={k} onClick={() => setStatus(({ sentCol: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED', received: 'RECEIVED' } as any)[k] || 'ALL')}
                className="rounded-xl bg-[#faf7f2] px-2 py-2 text-center hover:bg-brand/10">
                <p className={cn('text-lg font-bold tabular-nums leading-none', c)}>{v ?? 0}</p>
                <p className="text-[10px] uppercase tracking-wider text-[#9c8e85] mt-1">{t(`nw.col.${k}`)}</p>
              </button>
            ))}
          </div>
          <div className="flex items-end gap-px h-16 mt-3">
            {daily.map((d: any) => (
              <div key={d.day} title={`${d.day}: ${d.total}`} className="flex-1 bg-brand/70 rounded-t" style={{ height: `${Math.max(3, (Number(d.total) / max) * 100)}%` }} />
            ))}
          </div>
        </div>
        <div className={cn(CARD, 'flex-1 min-h-0 overflow-auto')}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#f5f0e8] uppercase text-[10px] text-[#6b5d52]">
              <tr><th className="text-left px-3 py-2">{t('nw.template')}</th><th className="text-right px-2">{t('nw.col.sentCol')}</th><th className="text-right px-2">{t('nw.col.delivered')}</th><th className="text-right px-2">{t('nw.col.read')}</th><th className="text-right px-3">{t('nw.col.failed')}</th></tr>
            </thead>
            <tbody>
              {(sum?.by_template || []).map((r: any) => (
                <tr key={r.template_name || '-'} className="border-t border-[#f0e8d8]">
                  <td className="px-3 py-1.5 font-medium">{r.template_name || t('nw.freeText')}</td>
                  <td className="text-right px-2 tabular-nums">{r.messages}</td>
                  <td className="text-right px-2 tabular-nums">{r.delivered}</td>
                  <td className="text-right px-2 tabular-nums">{r.read}</td>
                  <td className="text-right px-3 tabular-nums text-rose-700">{r.failed || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={cn(CARD, 'flex flex-col min-h-0')}>
        <div className="px-3 py-2 border-b border-brand/10 flex flex-wrap items-center gap-2">
          <h3 className="font-bold text-sm">{t('nw.messageLog')}</h3>
          <select value={status} onChange={e => setStatus(e.target.value)} className="border border-brand/15 rounded-lg px-2 py-1 text-xs">
            {['ALL', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'RECEIVED'].map(s => <option key={s} value={s}>{t(`nw.rs.${s}`)}</option>)}
          </select>
          <input value={who} onChange={e => setWho(e.target.value)} placeholder={t('nw.searchContacts')} className="ml-auto border border-brand/15 rounded-lg px-2 py-1 text-xs w-40" />
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <tbody>
              {log.length === 0 && <tr><td className="p-8 text-center text-[#9c8e85]">{t('nw.nothingHere')}</td></tr>}
              {log.map((d: any) => (
                <tr key={d.id} className="border-t border-[#f0e8d8] first:border-0">
                  <td className="px-3 py-1.5 whitespace-nowrap text-[#6b5d52]">{d.created_at ? new Date(d.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</td>
                  <td className="px-2 py-1.5"><span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-brand/10 text-brand">{d.channel}</span></td>
                  <td className="px-2 py-1.5 max-w-[140px] truncate" title={d.recipient}>{d.contact_name || d.recipient}</td>
                  <td className="px-2 py-1.5 max-w-[200px] truncate text-[#6b5d52]" title={d.preview}>{d.template_name || String(d.event_name || '').replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="px-3 py-1.5 text-right" title={d.error || ''}>
                    <span className={cn('font-bold', d.status === 'FAILED' ? 'text-rose-700' : d.status === 'SKIPPED' ? 'text-amber-700' : String(d.direction) === 'IN' ? 'text-brand' : 'text-emerald-700')}>
                      {t(`nw.rs.${String(d.direction) === 'IN' ? 'RECEIVED' : d.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ══ Settings ═════════════════════════════════════════════════════════════════
function SettingsTab({ token, canEdit, renderEmailServer, renderSmartAlerts }: { token: string; canEdit: boolean; renderEmailServer: (c: boolean) => React.ReactNode; renderSmartAlerts: () => React.ReactNode }) {
  const { t } = useT();
  const [view, setView] = useState<'EMAIL' | 'ALERTS' | 'OPTOUT'>('EMAIL');
  return (
    <div className={cn('grid gap-3 grid-cols-1 md:grid-cols-[200px_1fr]', PANE)}>
      <div className={cn(CARD, 'p-2 flex md:flex-col gap-1 overflow-x-auto')}>
        {([['EMAIL', t('nw.emailServer')], ['ALERTS', t('nw.smartAlerts')], ['OPTOUT', t('nw.optOuts')]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setView(id)} className={cn('text-left px-3 py-2 rounded-xl text-sm whitespace-nowrap', view === id ? 'bg-brand/10 text-brand font-bold' : 'text-[#6b5d52] hover:bg-[#faf7f2]')}>{label}</button>
        ))}
      </div>
      <div className="min-h-0 overflow-y-auto">
        {view === 'EMAIL' && renderEmailServer(canEdit)}
        {view === 'ALERTS' && renderSmartAlerts()}
        {view === 'OPTOUT' && <OptOuts token={token} canEdit={canEdit} />}
      </div>
    </div>
  );
}

function OptOuts({ token, canEdit }: { token: string; canEdit: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const api = useApi(token);
  const [rows, setRows] = useState<any[]>([]);
  const [contact, setContact] = useState('');
  const [channel, setChannel] = useState('WHATSAPP');
  const load = () => api.get('/api/owner/messaging-optouts').then(d => setRows(d.optouts || [])).catch(() => {});
  useEffect(() => { load(); }, []);
  const change = (body: any) => api.send('POST', '/api/owner/messaging-optouts', body).then(() => { setContact(''); load(); }).catch((e: any) => toast.error(e.message));
  return (
    <div className={cn(CARD, 'p-4 space-y-3')}>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <input value={contact} onChange={e => setContact(e.target.value)} placeholder={t('nw.phoneOrEmail')} className="flex-1 min-w-[180px] border border-brand/15 rounded-xl px-3 py-2 text-sm" />
          <select value={channel} onChange={e => setChannel(e.target.value)} className="border border-brand/15 rounded-xl px-2 text-sm">
            {['WHATSAPP', 'SMS', 'EMAIL'].map(c => <option key={c}>{c}</option>)}
          </select>
          <button disabled={!contact.trim()} onClick={() => change({ contact, channel })} className="px-4 py-2 rounded-xl bg-brand text-white text-sm font-bold disabled:opacity-40">{t('nw.block')}</button>
        </div>
      )}
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 && <tr><td className="p-6 text-center text-[#9c8e85]">{t('nw.noOptOuts')}</td></tr>}
          {rows.map(r => (
            <tr key={`${r.contact}-${r.channel}`} className="border-t border-[#f0e8d8] first:border-0">
              <td className="py-2 font-medium">{r.contact}</td>
              <td className="py-2 text-xs">{r.channel}</td>
              <td className="py-2 text-xs text-[#6b5d52]">{r.source}</td>
              <td className="py-2 text-right">{canEdit && <button onClick={() => change({ contact: r.contact, channel: r.channel, remove: true })} className="text-xs font-bold text-brand hover:underline">{t('nw.allow')}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ══ Shell ════════════════════════════════════════════════════════════════════
export function NotificationsWorkspace(p: NotificationsWorkspaceProps) {
  const { t } = useT();
  const canEdit = canWriteTab('NOTIFICATIONS');
  const wa = moduleOn('whatsapp');
  const tabs = [
    ...(wa ? [{ id: 'INBOX', label: t('nw.inbox'), icon: Inbox }, { id: 'BROADCASTS', label: t('nw.broadcasts'), icon: Megaphone }] : []),
    { id: 'AUTOMATIONS', label: t('nw.automations'), icon: Zap },
    { id: 'TEMPLATES', label: t('nw.templates'), icon: FileText },
    { id: 'ANALYTICS', label: t('nw.analytics'), icon: BarChart3 },
    { id: 'SETTINGS', label: t('nw.settings'), icon: SettingsIcon },
  ];
  const [tab, setTab] = useState(() => {
    try { const s = localStorage.getItem('nw:tab'); if (s && tabs.some(x => x.id === s)) return s; } catch { /* storage unavailable */ }
    return tabs[0].id;
  });
  const pick = (id: string) => { setTab(id); try { localStorage.setItem('nw:tab', id); } catch { /* storage unavailable */ } };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold font-serif flex items-center gap-2"><MessageSquare size={22} className="text-brand" />{t('nw.title')}</h2>
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(x => (
            <button key={x.id} onClick={() => pick(x.id)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold whitespace-nowrap transition-colors',
                tab === x.id ? 'bg-brand text-white' : 'text-[#6b5d52] hover:bg-white')}>
              <x.icon size={14} /> {x.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'INBOX' && wa && <InboxTab token={p.token} restaurantId={p.restaurantId} canEdit={canEdit} propertyName={p.propertyName} />}
      {tab === 'BROADCASTS' && wa && <BroadcastsTab token={p.token} canEdit={canEdit} propertyName={p.propertyName} />}
      {tab === 'AUTOMATIONS' && <AutomationsTab token={p.token} canEdit={canEdit} events={p.events} channels={p.channels} />}
      {tab === 'TEMPLATES' && <TemplatesTab token={p.token} canEdit={canEdit} propertyName={p.propertyName} renderWording={p.renderWording} />}
      {tab === 'ANALYTICS' && <AnalyticsTab token={p.token} />}
      {tab === 'SETTINGS' && <SettingsTab token={p.token} canEdit={canEdit} renderEmailServer={p.renderEmailServer} renderSmartAlerts={p.renderSmartAlerts} />}
    </div>
  );
}
