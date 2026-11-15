import React, { useState } from 'react';
import {
  Layers,
  Cpu,
  ShieldCheck,
  Flame,
  Play,
  Terminal,
  Clock,
  Plus,
  Circle,
  X
} from 'lucide-react';
import type { MissionSnapshot } from '@mindchestra/contracts';

type NavTab = 'missions' | 'council' | 'agents' | 'approvals';

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('missions');
  const [showNewMissionModal, setShowNewMissionModal] = useState(false);

  // Active mission state
  const [activeMission, setActiveMission] = useState<MissionSnapshot | null>({
    id: 'm-0042',
    spec: {
      schemaVersion: 1,
      objective: 'Analyze frame drop causes in game loop and verify allocation bounds',
      mode: 'council',
      agents: ['codex', 'claude', 'antigravity'],
      workspace: 'demo-repo',
      profile: 'read-only',
      budget: {
        maxRuns: 7,
        maxSeconds: 600,
        maxRounds: 2,
        maxConcurrency: 3,
        maxToolCalls: 20
      }
    },
    status: 'running',
    phase: 'critique',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeq: 4,
    resultAvailable: false,
    pendingApprovalIds: []
  });

  const [events, setEvents] = useState<Array<{ seq: number; type: string; actor: string; text: string }>>([
    { seq: 1, type: 'mission.created', actor: 'daemon', text: 'Council mission initiated with 3 agents' },
    { seq: 2, type: 'mission.phase', actor: 'daemon', text: 'Phase advanced to: independent findings' },
    { seq: 3, type: 'claim.created', actor: 'codex', text: 'Claim C-01: Object pooling reduces GC pause allocations' },
    { seq: 4, type: 'mission.phase', actor: 'daemon', text: 'Phase barrier unlocked: critique round' }
  ]);

  // Form state
  const [objective, setObjective] = useState('');
  const [selectedMode, setSelectedMode] = useState<'council' | 'parallel' | 'review'>('council');

  const handleStartMission = (e: React.FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) return;

    const newSnapshot: MissionSnapshot = {
      id: `m-${Math.floor(Math.random() * 9000 + 1000)}`,
      spec: {
        schemaVersion: 1,
        objective: objective.trim(),
        mode: selectedMode,
        agents: ['codex', 'claude', 'antigravity'],
        workspace: 'local-repo',
        profile: 'read-only',
        budget: {
          maxRuns: 7,
          maxSeconds: 600,
          maxRounds: 2,
          maxConcurrency: 3,
          maxToolCalls: 20
        }
      },
      status: 'running',
      phase: 'prepare',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeq: 1,
      resultAvailable: false,
      pendingApprovalIds: []
    };

    setActiveMission(newSnapshot);
    setEvents([
      { seq: 1, type: 'mission.created', actor: 'daemon', text: `Mission started: ${objective}` }
    ]);
    setObjective('');
    setShowNewMissionModal(false);
  };

  const phases = ['prepare', 'independent', 'critique', 'verify', 'synthesize', 'finalize'];

  return (
    <div className="flex h-screen w-screen bg-[#11191F] text-[#EAF3F0] font-sans antialiased overflow-hidden select-none">
      {/* Sleek Minimal Sidebar */}
      <aside className="w-56 border-r border-[#1C2830] bg-[#141E25] flex flex-col justify-between shrink-0">
        <div>
          {/* Brand header */}
          <div className="h-14 px-5 border-b border-[#1C2830] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#88C7AD]"></span>
              <span className="font-semibold text-sm tracking-tight">mindchestra.</span>
            </div>
            <span className="text-[10px] font-mono text-[#8D9FA5] bg-[#19242C] px-1.5 py-0.5 rounded border border-[#22323D]">
              local
            </span>
          </div>

          {/* Navigation */}
          <nav className="p-2 space-y-0.5">
            {[
              { id: 'missions', label: 'Missions', icon: Layers },
              { id: 'council', label: 'Council Room', icon: Flame },
              { id: 'agents', label: 'Agents', icon: Cpu },
              { id: 'approvals', label: 'Approvals', icon: ShieldCheck }
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as NavTab)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-[#1F2D36] text-[#88C7AD]'
                      : 'text-[#8D9FA5] hover:text-[#EAF3F0] hover:bg-[#18232B]'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[#88C7AD]' : 'text-[#5C6F76]'}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Quiet footer */}
        <div className="p-3 border-t border-[#1C2830] flex items-center justify-between text-[11px] text-[#5C6F76] font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#88C7AD]"></span>
            :4311
          </span>
          <span>v0.1.0</span>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-[#1C2830] px-6 flex items-center justify-between shrink-0 bg-[#141E25]">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#8D9FA5]">Workspace</span>
            <span className="text-xs text-[#5C6F76]">/</span>
            <span className="text-xs font-medium text-[#EAF3F0]">demo-repo</span>
          </div>

          <button
            onClick={() => setShowNewMissionModal(true)}
            className="flex items-center gap-1.5 bg-[#88C7AD] hover:bg-[#77b79d] text-[#11191F] px-3 py-1.5 rounded text-xs font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Mission</span>
          </button>
        </header>

        {/* Content View */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'missions' && (
            <div className="max-w-4xl space-y-6">
              {/* Mission Card */}
              {activeMission ? (
                <div className="bg-[#18232B] border border-[#22323D] rounded-lg p-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-mono uppercase text-[#88C7AD]">
                          {activeMission.spec.mode}
                        </span>
                        <span className="text-xs text-[#5C6F76]">·</span>
                        <span className="text-xs font-mono text-[#8D9FA5]">
                          {activeMission.id}
                        </span>
                      </div>
                      <h2 className="text-base font-medium text-[#EAF3F0] leading-snug">
                        {activeMission.spec.objective}
                      </h2>
                    </div>

                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono uppercase bg-[#11191F] border border-[#22323D] text-[#88C7AD] shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#88C7AD] animate-pulse"></span>
                      {activeMission.status}
                    </span>
                  </div>

                  {/* Phase Tracker */}
                  <div className="space-y-2 pt-2 border-t border-[#1C2830]">
                    <div className="flex items-center justify-between text-xs text-[#8D9FA5]">
                      <span>Phase: <strong className="text-[#EAF3F0] font-normal">{activeMission.phase}</strong></span>
                      <span className="text-[11px] font-mono text-[#5C6F76]">maxRuns: 7 · maxSeconds: 600</span>
                    </div>

                    <div className="grid grid-cols-6 gap-1.5">
                      {phases.map((p) => {
                        const isCurrent = activeMission.phase === p;
                        const isPast = phases.indexOf(p) < phases.indexOf(activeMission.phase);
                        return (
                          <div
                            key={p}
                            className={`h-1.5 rounded-full transition-all ${
                              isCurrent
                                ? 'bg-[#88C7AD]'
                                : isPast
                                ? 'bg-[#5E9580]'
                                : 'bg-[#1C2830]'
                            }`}
                            title={p}
                          />
                        );
                      })}
                    </div>
                  </div>

                  {/* Assigned Agents */}
                  <div className="flex items-center gap-2 pt-1">
                    {activeMission.spec.agents.map((agent) => (
                      <span
                        key={agent}
                        className="inline-flex items-center gap-1 text-[11px] font-mono bg-[#141E25] border border-[#22323D] px-2 py-0.5 rounded text-[#8D9FA5]"
                      >
                        <Circle className="w-1.5 h-1.5 fill-[#88C7AD] text-[#88C7AD]" />
                        {agent}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="border border-dashed border-[#22323D] rounded-lg p-12 text-center text-xs text-[#8D9FA5]">
                  No active mission. Click "+ New Mission" above to start one.
                </div>
              )}

              {/* Event Stream Log */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-[#8D9FA5] px-1">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Terminal className="w-3.5 h-3.5 text-[#88C7AD]" />
                    Event Stream
                  </span>
                  <span className="font-mono text-[11px] text-[#5C6F76]">
                    {events.length} events · monotonic seq
                  </span>
                </div>

                <div className="bg-[#141E25] border border-[#1C2830] rounded-lg p-3 font-mono text-xs space-y-2 max-h-72 overflow-y-auto">
                  {events.map((ev) => (
                    <div
                      key={ev.seq}
                      className="flex items-start gap-3 text-xs leading-relaxed py-0.5"
                    >
                      <span className="text-[#88C7AD] shrink-0 font-semibold select-none">
                        #{ev.seq}
                      </span>
                      <span className="text-[#5C6F76] shrink-0">[{ev.actor}]</span>
                      <span className="text-[#8D9FA5] shrink-0">{ev.type}</span>
                      <span className="text-[#EAF3F0] truncate">{ev.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'council' && (
            <div className="max-w-4xl space-y-3">
              <div className="text-xs text-[#8D9FA5] font-mono mb-2">Round 2 · Independent findings</div>
              <div className="bg-[#18232B] border border-[#22323D] p-4 rounded-lg space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#88C7AD]">Codex · Claim C-01</span>
                  <span className="bg-[#11191F] px-2 py-0.5 rounded text-[10px] font-mono text-[#88C7AD]">
                    CLAIM
                  </span>
                </div>
                <p className="text-xs text-[#EAF3F0]">
                  Object pooling reduces allocations in inner render loop. Evidence ref: E-01.
                </p>
              </div>

              <div className="bg-[#18232B] border border-[#22323D] p-4 rounded-lg space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#88C7AD]">Claude Code · Critique C-02</span>
                  <span className="bg-[#11191F] px-2 py-0.5 rounded text-[10px] font-mono text-[#FFD54F]">
                    CRITIQUE
                  </span>
                </div>
                <p className="text-xs text-[#EAF3F0]">
                  Reset invariant may be violated if pool lifecycle is not guaranteed. Evidence ref: E-02.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="max-w-4xl space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'mock-agent', name: 'Deterministic Mock Agent', provider: 'local', status: 'READY' },
                  { id: 'codex', name: 'Codex CLI', provider: 'openai', status: 'READY' },
                  { id: 'claude', name: 'Claude Code CLI', provider: 'anthropic', status: 'READY' },
                  { id: 'antigravity', name: 'Antigravity CLI (agy)', provider: 'google', status: 'BETA' }
                ].map((a) => (
                  <div key={a.id} className="bg-[#18232B] border border-[#22323D] p-4 rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{a.name}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#11191F] text-[#88C7AD] border border-[#22323D]">
                        {a.status}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-[#8D9FA5]">
                      id: {a.id} · provider: {a.provider}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'approvals' && (
            <div className="max-w-4xl space-y-3">
              <div className="bg-[#18232B] border border-[#22323D] p-4 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Approval Request A-17</span>
                  <span className="text-[10px] font-mono text-[#FFD54F] bg-[#11191F] px-2 py-0.5 rounded border border-[#22323D]">
                    HIGH RISK
                  </span>
                </div>
                <div className="text-xs font-mono text-[#8D9FA5]">
                  Action: apply_patch · Target: src/pool.ts
                  <div className="text-[10px] text-[#5C6F76] mt-0.5 truncate">
                    Hash: 49a2b5e0c671a938d41fe093ab54b9d0e7293a1024e4d5801267812903abc812
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button className="px-3 py-1 bg-[#88C7AD] hover:bg-[#77b79d] text-[#11191F] text-xs font-semibold rounded transition-colors">
                    Approve
                  </button>
                  <button className="px-3 py-1 bg-[#141E25] hover:bg-[#1B2730] border border-[#22323D] text-xs font-medium rounded transition-colors">
                    Deny
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* New Mission Modal */}
      {showNewMissionModal && (
        <div className="fixed inset-0 bg-[#0B1014]/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-[#18232B] border border-[#22323D] rounded-xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#22323D] pb-3">
              <h3 className="text-sm font-semibold text-[#EAF3F0]">New Mission Dispatcher</h3>
              <button
                onClick={() => setShowNewMissionModal(false)}
                className="text-[#8D9FA5] hover:text-[#EAF3F0] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleStartMission} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8D9FA5] mb-1">Objective</label>
                <textarea
                  rows={3}
                  required
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="e.g. Audit SQLite WAL transaction handling under concurrency..."
                  className="w-full bg-[#11191F] border border-[#22323D] rounded-md p-3 text-xs text-[#EAF3F0] focus:outline-none focus:border-[#88C7AD]"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8D9FA5] mb-1">Mode</label>
                <select
                  value={selectedMode}
                  onChange={(e) => setSelectedMode(e.target.value as any)}
                  className="w-full bg-[#11191F] border border-[#22323D] rounded-md p-2 text-xs text-[#EAF3F0] focus:outline-none focus:border-[#88C7AD]"
                >
                  <option value="council">Council (Multi-agent critique & synthesis)</option>
                  <option value="parallel">Parallel (Independent runs comparison)</option>
                  <option value="review">Review (Candidate verification)</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#22323D]">
                <button
                  type="button"
                  onClick={() => setShowNewMissionModal(false)}
                  className="px-3 py-1.5 text-xs text-[#8D9FA5] hover:text-[#EAF3F0] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-1.5 bg-[#88C7AD] hover:bg-[#77b79d] text-[#11191F] px-4 py-1.5 rounded text-xs font-semibold transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Dispatch</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
