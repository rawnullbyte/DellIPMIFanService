import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Save, FunctionSquare, Thermometer, BarChart3,
  Settings2, Clock, Info, KeyRound, Eye, EyeOff,
  Wind, Zap, ThermometerSun, Cpu
} from 'lucide-react';
import * as math from 'mathjs';

interface Rule { id: string; temp: number; speed: number; }
interface Settings { id: number; polling_interval: number; formula: string; }
interface FanReading { name: string; rpm: number; }
interface SdrSnapshot {
  inlet_temp: number | null;
  exhaust_temp: number | null;
  fans: FanReading[];
  power_watts: number | null;
}

export default function App() {
  const [view, setView] = useState<'editor' | 'info' | 'settings'>('editor');
  const [rules, setRules] = useState<Rule[]>([]);
  const [formula, setFormula] = useState<string>("");
  const [sysConfig, setSysConfig] = useState<Settings>({ id: 1, polling_interval: 5, formula: "" });
  const [liveData, setLiveData] = useState({ temp: 0, speed: 0 });
  const [sdr, setSdr] = useState<SdrSnapshot | null>(null);
  const [activePointId, setActivePointId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pwStatus, setPwStatus] = useState<'idle' | 'ok' | 'error' | 'mismatch'>('idle');

  const lastY = useRef<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const padding = 60;
  const width = 900;
  const height = 450;
  const minTemp = 20;
  const maxTemp = 100;
  const tempStep = 5;

  const calculateSpeed = (t: number, curFormula: string | undefined | null, curRules: Rule[]): number => {
    if (curFormula && curFormula.trim().length > 0) {
      try {
        const res = math.evaluate(curFormula, { t });
        return Math.max(0, Math.min(100, Math.round(Number(res))));
      } catch { return 0; }
    }
    const match = [...curRules].sort((a, b) => b.temp - a.temp).find(r => t >= r.temp);
    return match ? match.speed : 20;
  };

  useEffect(() => {
    const init = async () => {
      try {
        const [ruleRes, settingsRes] = await Promise.all([
          fetch('/api/rules'),
          fetch('/api/settings'),
        ]);
        const dbRules: Rule[] = await ruleRes.json();
        const settings: Settings = await settingsRes.json();
        setSysConfig(settings);
        setFormula(settings.formula ?? "");
        const speedMap = new Map(dbRules.map(r => [r.temp, r.speed]));
        const grid: Rule[] = [];
        for (let t = minTemp; t <= maxTemp; t += tempStep) {
          grid.push({ id: `step-${t}`, temp: t, speed: speedMap.get(t) ?? 20 });
        }
        setRules(grid);
      } catch (e) { console.error("Init failed", e); }
    };
    init();

    const telemetryInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/telemetry');
        const data = await res.json();
        if (data[0]) setLiveData({ temp: data[0].temp, speed: data[0].speed });
      } catch { /* offline */ }
    }, 2000);

    const sdrInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/sdr');
        setSdr(await res.json());
      } catch { /* offline */ }
    }, 5000);

    fetch('/api/sdr').then(r => r.json()).then(setSdr).catch(() => { });

    return () => {
      clearInterval(telemetryInterval);
      clearInterval(sdrInterval);
    };
  }, []);

  const curveData = useMemo(() => {
    const pts = [];
    for (let temp = minTemp; temp <= maxTemp; temp++) {
      pts.push({ t: temp, speed: calculateSpeed(temp, formula, rules) });
    }
    return pts;
  }, [rules, formula]);

  const getX = (t: number) => padding + ((t - minTemp) / (maxTemp - minTemp)) * (width - 2 * padding);
  const getY = (s: number) => (height - padding) - (s / 100) * (height - 2 * padding);

  const handleMouseDown = (e: React.MouseEvent, id: string) => {
    if (formula.length > 0) return;
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    } else {
      if (!selectedIds.includes(id)) setSelectedIds([id]);
      setActivePointId(id);
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) lastY.current = (e.clientY - rect.top) * (height / rect.height);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!activePointId || formula.length > 0 || lastY.current === null) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const currentY = (e.clientY - rect.top) * (height / rect.height);
    const delta = Math.round(
      ((height - padding - currentY) / (height - 2 * padding) * 100) -
      ((height - padding - lastY.current) / (height - 2 * padding) * 100)
    );
    if (delta !== 0) {
      setRules(prev => prev.map(r =>
        selectedIds.includes(r.id) ? { ...r, speed: Math.max(0, Math.min(100, r.speed + delta)) } : r
      ));
      lastY.current = currentY;
    }
  };

  const saveAll = async () => {
    try {
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules)
      });
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sysConfig, formula })
      });
      alert("Settings saved.");
    } catch { alert("Communication Error"); }
  };

  const changePassword = async () => {
    if (newPassword !== confirmPassword) { setPwStatus('mismatch'); return; }
    if (newPassword.trim().length === 0) return;
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: newPassword })
      });
      setPwStatus(res.ok ? 'ok' : 'error');
      if (res.ok) { setNewPassword(""); setConfirmPassword(""); }
    } catch { setPwStatus('error'); }
    setTimeout(() => setPwStatus('idle'), 3000);
  };

  const fanPairs = useMemo(() => {
    if (!sdr) return [];
    const map = new Map<string, FanReading[]>();
    for (const fan of sdr.fans) {
      const group = fan.name.replace(/[AB]$/, '');
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(fan);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sdr]);

  const maxRpm = useMemo(() => {
    if (!sdr || sdr.fans.length === 0) return 6000;
    return Math.max(...sdr.fans.map(f => f.rpm), 6000);
  }, [sdr]);

  const exhaustPct = sdr?.exhaust_temp != null ? Math.min(100, Math.max(0, ((sdr.exhaust_temp - 20) / 80) * 100)) : 0;
  const inletPct = sdr?.inlet_temp != null ? Math.min(100, Math.max(0, ((sdr.inlet_temp - 10) / 60) * 100)) : 0;

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 font-sans select-none">
      {/* Nav */}
      <nav className="flex items-center gap-8 p-6 border-b border-zinc-800 bg-black/40 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg">
            <BarChart3 size={18} className="text-white" />
          </div>
          <h1 className="text-xl font-black tracking-tighter italic text-white uppercase">PowerEdge</h1>
        </div>

        <div className="flex gap-2 bg-zinc-900/80 p-1.5 rounded-xl border border-zinc-800">
          {([
            { id: 'editor', icon: <BarChart3 size={14} />, label: 'Curve Editor' },
            { id: 'info', icon: <Info size={14} />, label: 'System Info' },
            { id: 'settings', icon: <Settings2 size={14} />, label: 'Settings' },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${view === tab.id ? 'bg-zinc-700 text-white shadow-lg' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-8">
          <div className="flex gap-6 border-r border-zinc-800 pr-8">
            <div className="text-right">
              <p className="text-[9px] text-zinc-500 font-bold uppercase">Inlet</p>
              <p className="text-sm font-mono font-bold text-emerald-400">{sdr?.inlet_temp ?? '—'}°C</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] text-zinc-500 font-bold uppercase">Exhaust</p>
              <p className="text-sm font-mono font-bold text-orange-400">{sdr?.exhaust_temp ?? '—'}°C</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] text-zinc-500 font-bold uppercase">Fan</p>
              <p className="text-sm font-mono font-bold text-blue-400">{liveData.speed}%</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] text-zinc-500 font-bold uppercase">Power</p>
              <p className="text-sm font-mono font-bold text-yellow-400">{sdr?.power_watts ?? '—'}W</p>
            </div>
          </div>
          <button
            onClick={saveAll}
            className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-tight flex items-center gap-2 shadow-lg active:scale-95 transition-all"
          >
            <Save size={16} /> Commit
          </button>
        </div>
      </nav>

      <main className="p-8 max-w-7xl mx-auto">

        {/* ── Curve Editor ── */}
        {view === 'editor' && (
          <div className="flex gap-8">
            <div className="w-72 shrink-0 space-y-6">
              <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl shadow-xl">
                <div className="flex items-center gap-2 mb-4 text-blue-400">
                  <FunctionSquare size={18} />
                  <h2 className="text-xs font-bold uppercase tracking-widest">Math Formula</h2>
                </div>
                <input
                  value={formula}
                  onChange={e => setFormula(e.target.value)}
                  placeholder="e.g., max(0, min(100, (t-60)*2.5))"
                  className="w-full bg-black border border-zinc-800 rounded-lg px-4 py-3 font-mono text-sm focus:border-blue-400 outline-none transition-colors"
                />
                <div className="mt-3 p-3 bg-blue-500/5 rounded-lg flex items-start gap-2 border border-blue-500/10">
                  <Info size={14} className="text-blue-400 shrink-0 mt-0.5" />
                  <span className="text-[10px] text-zinc-400">
                    Formula controls fan speed. Variable 't' is <span className="text-orange-400 font-bold">exhaust temp</span>. Manual points disabled when active.
                  </span>
                </div>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-2xl flex flex-col shadow-xl" style={{ height: '400px' }}>
                <div className="flex items-center gap-2 mb-4 text-zinc-400">
                  <Thermometer size={18} />
                  <h2 className="text-xs font-bold uppercase tracking-widest">Calculated List</h2>
                </div>
                <div className="overflow-y-auto space-y-1 pr-2">
                  {rules.map(r => (
                    <div key={r.id} className={`flex justify-between p-2 rounded-lg text-[10px] font-mono border ${selectedIds.includes(r.id) ? 'bg-blue-600/10 border-blue-500/40 text-blue-300' : 'bg-black/40 border-transparent text-zinc-500'}`}>
                      <span>{r.temp}°C</span>
                      <span className="font-bold">{calculateSpeed(r.temp, formula, rules)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 min-w-0 bg-zinc-900/40 border border-zinc-800 rounded-3xl p-8 shadow-2xl">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${width} ${height}`}
                className={`w-full h-auto ${formula ? 'cursor-not-allowed' : 'cursor-ns-resize'}`}
                onMouseMove={handleMouseMove}
                onMouseUp={() => { setActivePointId(null); lastY.current = null; }}
                onMouseLeave={() => { setActivePointId(null); lastY.current = null; }}
              >
                {[0, 25, 50, 75, 100].map(v => (
                  <g key={v}>
                    <line x1={padding} y1={getY(v)} x2={width - padding} y2={getY(v)} stroke="#27272a" strokeDasharray="4 4" />
                    <text x={padding - 15} y={getY(v) + 4} fill="#52525b" fontSize="10" fontWeight="bold" textAnchor="end">{v}%</text>
                  </g>
                ))}
                {Array.from({ length: (maxTemp - minTemp) / tempStep + 1 }, (_, i) => minTemp + i * tempStep).map(t => (
                  <text key={t} x={getX(t)} y={height - padding + 20} fill="#52525b" fontSize="10" fontWeight="bold" textAnchor="middle">{t}°</text>
                ))}
                {/* Live exhaust temp marker */}
                {sdr?.exhaust_temp != null && sdr.exhaust_temp >= minTemp && sdr.exhaust_temp <= maxTemp && (
                  <g>
                    <line x1={getX(sdr.exhaust_temp)} y1={padding} x2={getX(sdr.exhaust_temp)} y2={height - padding} stroke="#f97316" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                    <text x={getX(sdr.exhaust_temp)} y={padding - 6} fill="#f97316" fontSize="9" fontWeight="bold" textAnchor="middle">exhaust</text>
                  </g>
                )}
                <path d={`M ${curveData.map(p => `${getX(p.t)},${getY(p.speed)}`).join(' L ')}`} fill="none" stroke="#3b82f6" strokeWidth="3" strokeLinecap="round" />
                {rules.map(r => (
                  <g key={r.id} onMouseDown={(e) => handleMouseDown(e, r.id)}>
                    <circle cx={getX(r.temp)} cy={getY(calculateSpeed(r.temp, formula, rules))} r="14" fill="transparent" />
                    <circle cx={getX(r.temp)} cy={getY(calculateSpeed(r.temp, formula, rules))} r={selectedIds.includes(r.id) ? 6 : 4} fill={selectedIds.includes(r.id) ? "#fff" : "#3b82f6"} className="transition-all" />
                  </g>
                ))}
              </svg>
            </div>
          </div>
        )}

        {/* ── System Info ── */}
        {view === 'info' && (
          <div className="space-y-6">
            {/* Stat cards */}
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: 'Inlet Temp', value: sdr?.inlet_temp != null ? `${sdr.inlet_temp}°C` : '—', color: 'emerald', icon: <ThermometerSun size={22} />, pct: inletPct },
                { label: 'Exhaust Temp', value: sdr?.exhaust_temp != null ? `${sdr.exhaust_temp}°C` : '—', color: 'orange', icon: <Thermometer size={22} />, pct: exhaustPct },
                { label: 'Power Draw', value: sdr?.power_watts != null ? `${sdr.power_watts}W` : '—', color: 'yellow', icon: <Zap size={22} />, pct: sdr?.power_watts != null ? Math.min(100, (sdr.power_watts / 500) * 100) : 0 },
                { label: 'Fan Output', value: `${liveData.speed}%`, color: 'blue', icon: <Cpu size={22} />, pct: liveData.speed },
              ].map(card => (
                <div key={card.label} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                  <div className={`p-2.5 bg-${card.color}-500/10 rounded-xl w-fit mb-4`}>
                    <div className={`text-${card.color}-400`}>{card.icon}</div>
                  </div>
                  <p className="text-[10px] font-black uppercase text-zinc-500 mb-1">{card.label}</p>
                  <p className={`text-3xl font-black font-mono text-${card.color}-400 mb-3`}>{card.value}</p>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full bg-${card.color}-500 rounded-full transition-all duration-700`}
                      style={{ width: `${card.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Fan speeds */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-6 text-blue-400">
                <Wind size={18} />
                <h2 className="text-xs font-bold uppercase tracking-widest">Fan Speeds</h2>
                <span className="ml-auto text-[10px] text-zinc-600 font-mono">max {maxRpm.toLocaleString()} RPM</span>
              </div>

              {sdr && sdr.fans.length > 0 ? (
                <div className="grid grid-cols-2 gap-x-12 gap-y-5">
                  {fanPairs.map(([group, fans]) => {
                    const avgRpm = Math.round(fans.reduce((a, f) => a + f.rpm, 0) / fans.length);
                    const pct = (avgRpm / maxRpm) * 100;
                    return (
                      <div key={group}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold text-zinc-300">{group}</span>
                          <div className="flex gap-3">
                            {fans.map(fan => (
                              <span key={fan.name} className="text-[10px] font-mono">
                                <span className="text-zinc-600">{fan.name.slice(-1)}: </span>
                                <span className="text-blue-300 font-bold">{fan.rpm.toLocaleString()}</span>
                              </span>
                            ))}
                            <span className="text-[10px] font-mono text-zinc-500">RPM</span>
                          </div>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-zinc-600 text-sm">No fan data available.</p>
              )}
            </div>
          </div>
        )}

        {/* ── Settings ── */}
        {view === 'settings' && (
          <div className="max-w-xl mx-auto space-y-6">
            <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl shadow-2xl">
              <h2 className="flex items-center gap-3 text-lg font-bold mb-8 text-blue-400">
                <Clock size={20} /> Execution Loop
              </h2>
              <div>
                <div className="flex justify-between mb-4">
                  <label className="text-[10px] font-black uppercase text-zinc-500">Polling Interval</label>
                  <span className="text-xs font-bold text-blue-400">{sysConfig.polling_interval}s</span>
                </div>
                <input
                  type="range" min="1" max="60"
                  value={sysConfig.polling_interval}
                  onChange={e => setSysConfig({ ...sysConfig, polling_interval: parseInt(e.target.value) })}
                  className="w-full h-2 bg-black rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl shadow-2xl">
              <h2 className="flex items-center gap-3 text-lg font-bold mb-8 text-blue-400">
                <KeyRound size={20} /> Admin Password
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-zinc-500 mb-2 block">New Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-black border border-zinc-800 rounded-xl p-4 pr-12 font-mono text-sm focus:border-blue-400 outline-none"
                    />
                    <button onClick={() => setShowPassword(v => !v)} className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors">
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-zinc-500 mb-2 block">Confirm Password</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-black border border-zinc-800 rounded-xl p-4 font-mono text-sm focus:border-blue-400 outline-none"
                  />
                </div>
                {pwStatus === 'mismatch' && <p className="text-xs text-red-400 font-bold">Passwords do not match.</p>}
                {pwStatus === 'ok' && <p className="text-xs text-emerald-400 font-bold">Password updated. Re-login required.</p>}
                {pwStatus === 'error' && <p className="text-xs text-red-400 font-bold">Server error. Try again.</p>}
                <button
                  onClick={changePassword}
                  disabled={newPassword.trim().length === 0}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white py-3 rounded-xl text-xs font-black uppercase tracking-tight flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <KeyRound size={14} /> Update Password
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}