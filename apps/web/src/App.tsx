import React, { useState, useEffect } from 'react';
import {
  Activity,
  Layers,
  Cpu,
  ShieldCheck,
  Play,
  RotateCcw,
  CheckCircle2,
  Clock,
  Terminal,
  Server,
  FileCheck,
  AlertTriangle,
  Flame,
  ArrowRight
} from 'lucide-react';
import type { AgentEvent, MissionSnapshot, MissionSpec } from '@mindchestra/contracts';

type NavTab =
  | 'overview'
  | 'missions'
  | 'council'
  | 'agents'
  | 'mcp'
  | 'evidence'
  | 'approvals'
  | 'replay'
  | 'settings';

export function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('missions');
  const [mockMode, setMockMode] = useState(true);

  // Sample active mission state
  const [activeMission, setActiveMission] = useState<MissionSnapshot | null>({
    id: 'm-0042-council-sample',
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

  // Mission form inputs
  const [objective, setObjective] = useState('');
  const [selectedMode, setSelectedMode] = useState<'council' | 'parallel' | 'review'>('council');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['codex', 'claude', 'antigravity']);

  const handleStartMission = (e: React.FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) return;

    const newSnapshot: MissionSnapshot = {
      id: `m-${Math.floor(Math.random() * 9000 + 1000)}`,
      spec: {
        schemaVersion: 1,
        objective,
        mode: selectedMode,
        agents: selectedAgents,
        workspace: 'active-workspace',
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
      { seq: 1, type: 'mission.created', actor: 'daemon', text: `New mission started: ${objective}` }
    ]);
  };

  return (
    <div className="flex h-screen w-screen bg-[#11191F] text-[#EAF3F0] font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-[#2C3E47] bg-[#162027] flex flex-col justify-between shrink-0">
        <div>
          {/* Logo / Header */}
          <div className="p-5 border-b border-[#2C3E47] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded bg-[#88C7AD] flex items-center justify-center text-[#11191F] font-bold">
                M
              </div>
              <span className="font-semibold text-lg tracking-tight">mindchestra.</span>
            </div>
            <span className="text-[10px] tracking-wider font-mono uppercase bg-[#202D34] text-[#88C7AD] px-2 py-0.5 rounded border border-[#2C3E47]">
              {mockMode ? 'Mock' : 'Live'}
            </span>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            <button
              onClick={() => setActiveTab('overview')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'overview'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <Activity className="w-4 h-4" /> Overview
            </button>
            <button
              onClick={() => setActiveTab('missions')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'missions'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <Layers className="w-4 h-4" /> Missions
            </button>
            <button
              onClick={() => setActiveTab('council')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'council'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <Flame className="w-4 h-4" /> Council Room
            </button>
            <button
              onClick={() => setActiveTab('agents')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'agents'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <Cpu className="w-4 h-4" /> Agent Registry
            </button>
            <button
              onClick={() => setActiveTab('mcp')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'mcp'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <Server className="w-4 h-4" /> MCP Network
            </button>
            <button
              onClick={() => setActiveTab('evidence')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'evidence'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <FileCheck className="w-4 h-4" /> Evidence Graph
            </button>
            <button
              onClick={() => setActiveTab('approvals')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'approvals'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <ShieldCheck className="w-4 h-4" /> Approvals
            </button>
            <button
              onClick={() => setActiveTab('replay')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === 'replay'
                  ? 'bg-[#202D34] text-[#88C7AD] font-medium'
                  : 'text-[#8D9FA5] hover:bg-[#1D2B32] hover:text-[#EAF3F0]'
              }`}
            >
              <RotateCcw className="w-4 h-4" /> Session Replay
            </button>
          </nav>
        </div>

        {/* Footer info */}
        <div className="p-4 border-t border-[#2C3E47] text-xs text-[#8D9FA5]">
          <div className="flex items-center justify-between">
            <span>Daemon</span>
            <span className="flex items-center gap-1.5 text-[#88C7AD]">
              <span className="w-2 h-2 rounded-full bg-[#88C7AD] inline-block"></span>
              Online :4311
            </span>
          </div>
          <div className="mt-2 text-[11px] text-[#5C6F76]">v0.1.0 · TwoBit Dev</div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-[#11191F]">
        {/* Top bar */}
        <header className="h-14 border-b border-[#2C3E47] bg-[#162027] px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold capitalize tracking-wide">
              {activeTab === 'missions' ? 'Mission Control' : activeTab}
            </h1>
            <span className="text-xs text-[#8D9FA5] font-mono">
              {activeMission ? `[${activeMission.id}]` : 'No mission selected'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setMockMode(!mockMode)}
              className="px-3 py-1 text-xs border border-[#2C3E47] rounded bg-[#202D34] hover:bg-[#2A3B44] transition-colors"
            >
              Mode: {mockMode ? 'Mock Offline' : 'Live Daemon'}
            </button>
          </div>
        </header>

        {/* View Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'missions' && (
            <div className="space-y-6">
              {/* Mission Snapshot Banner */}
              {activeMission && (
                <div className="bg-[#202D34] border border-[#2C3E47] rounded-lg p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs uppercase tracking-wider font-mono text-[#88C7AD] bg-[#11191F] px-2 py-0.5 rounded border border-[#2C3E47]">
                        {activeMission.spec.mode} mode
                      </span>
                      <h2 className="text-lg font-medium mt-2">{activeMission.spec.objective}</h2>
                    </div>
                    <span className="px-3 py-1 rounded text-xs uppercase font-mono font-semibold bg-[#11191F] border border-[#88C7AD] text-[#88C7AD]">
                      {activeMission.status}
                    </span>
                  </div>

                  {/* Phase Progress Bar */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-[#8D9FA5]">
                      <span>Phase: {activeMission.phase}</span>
                      <span>Budget: 7 runs · 600s</span>
                    </div>
                    <div className="grid grid-cols-6 gap-2">
                      {['prepare', 'independent', 'critique', 'verify', 'synthesize', 'finalize'].map(
                        (phaseName) => {
                          const isCurrent = activeMission.phase === phaseName;
                          return (
                            <div
                              key={phaseName}
                              className={`h-2 rounded ${
                                isCurrent
                                  ? 'bg-[#88C7AD]'
                                  : 'bg-[#11191F] border border-[#2C3E47]'
                              }`}
                              title={phaseName}
                            />
                          );
                        }
                      )}
                    </div>
                  </div>

                  {/* Active Agents Cards */}
                  <div className="grid grid-cols-3 gap-4 pt-2">
                    {activeMission.spec.agents.map((agent) => (
                      <div
                        key={agent}
                        className="bg-[#162027] border border-[#2C3E47] p-3 rounded flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-[#88C7AD]" />
                          <span className="font-mono text-sm uppercase">{agent}</span>
                        </div>
                        <span className="text-xs text-[#88C7AD] flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3" /> ACTIVE
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Mission Wizard */}
              <div className="bg-[#202D34] border border-[#2C3E47] rounded-lg p-5">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-[#8D9FA5] mb-4">
                  New Mission Dispatcher
                </h3>
                <form onSubmit={handleStartMission} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-[#8D9FA5] mb-1">
                      Objective & Guidelines
                    </label>
                    <textarea
                      rows={3}
                      value={objective}
                      onChange={(e) => setObjective(e.target.value)}
                      placeholder="e.g. Audit SQLite WAL transaction handling under high concurrency..."
                      className="w-full bg-[#11191F] border border-[#2C3E47] rounded p-3 text-sm focus:outline-none focus:border-[#88C7AD]"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-[#8D9FA5] mb-1">Mode</label>
                      <select
                        value={selectedMode}
                        onChange={(e) => setSelectedMode(e.target.value as any)}
                        className="w-full bg-[#11191F] border border-[#2C3E47] rounded p-2.5 text-sm focus:outline-none focus:border-[#88C7AD]"
                      >
                        <option value="council">Council (Multi-agent critique & synthesis)</option>
                        <option value="parallel">Parallel (Independent runs comparison)</option>
                        <option value="review">Review (Candidate verification)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#8D9FA5] mb-1">Workspace</label>
                      <input
                        type="text"
                        readOnly
                        value="local-first / demo-repo"
                        className="w-full bg-[#11191F] border border-[#2C3E47] rounded p-2.5 text-sm text-[#8D9FA5]"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      className="flex items-center gap-2 bg-[#88C7AD] text-[#11191F] px-4 py-2 rounded font-medium text-sm hover:bg-[#72af97] transition-colors"
                    >
                      <Play className="w-4 h-4 fill-current" /> Dispatch Mission
                    </button>
                  </div>
                </form>
              </div>

              {/* Real-time Event Stream */}
              <div className="bg-[#162027] border border-[#2C3E47] rounded-lg p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Terminal className="w-4 h-4 text-[#88C7AD]" />
                    <span>Ordered Event Stream</span>
                  </div>
                  <span className="text-xs text-[#8D9FA5] font-mono">
                    Monotonic seq · {events.length} events
                  </span>
                </div>

                <div className="bg-[#11191F] border border-[#2C3E47] rounded p-3 space-y-2 font-mono text-xs max-h-64 overflow-y-auto">
                  {events.map((ev) => (
                    <div key={ev.seq} className="flex items-start gap-3 border-b border-[#1D2B32] pb-1.5 last:border-0">
                      <span className="text-[#88C7AD] shrink-0 font-bold">#{ev.seq}</span>
                      <span className="text-[#5C6F76] shrink-0">[{ev.actor}]</span>
                      <span className="text-[#8D9FA5] shrink-0">{ev.type}</span>
                      <span className="text-[#EAF3F0] truncate">{ev.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Registered Agent Adapters</h2>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { id: 'mock-agent', name: 'Deterministic Mock Agent', kind: 'custom', status: 'READY', models: 'mock-v1' },
                  { id: 'codex', name: 'Codex CLI', kind: 'cli', status: 'READY', models: 'gpt-5-codex' },
                  { id: 'claude', name: 'Claude Code CLI', kind: 'cli', status: 'READY', models: 'claude-3-7-sonnet' },
                  { id: 'antigravity', name: 'Antigravity CLI (agy)', kind: 'cli', status: 'READY', models: 'gemini-2.5-pro' }
                ].map((item) => (
                  <div key={item.id} className="bg-[#202D34] border border-[#2C3E47] rounded p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{item.name}</span>
                      <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#11191F] text-[#88C7AD] border border-[#2C3E47]">
                        {item.status}
                      </span>
                    </div>
                    <div className="text-xs text-[#8D9FA5] font-mono space-y-1">
                      <div>ID: {item.id}</div>
                      <div>Kind: {item.kind}</div>
                      <div>Model: {item.models}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'council' && (
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Council Room · Critique Matrix</h2>
              <div className="bg-[#202D34] border border-[#2C3E47] p-4 rounded space-y-3">
                <div className="text-xs text-[#88C7AD] font-mono">Round 2 · Independent reports unlocked</div>
                <div className="border border-[#2C3E47] bg-[#162027] p-3 rounded">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-[#88C7AD]">Codex · Claim C-01</span>
                    <span className="bg-[#11191F] px-1.5 py-0.5 rounded text-[#88C7AD]">CLAIM</span>
                  </div>
                  <div className="text-sm">Object pooling reduces allocations in inner render loop. Evidence: E-01</div>
                </div>

                <div className="border border-[#2C3E47] bg-[#162027] p-3 rounded">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-[#88C7AD]">Claude Code · C-02</span>
                    <span className="bg-[#11191F] px-1.5 py-0.5 rounded text-[#FFD54F]">CRITIQUE</span>
                  </div>
                  <div className="text-sm">Reset invariant may be violated if pool lifecycle is not guaranteed. Evidence: E-02</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'approvals' && (
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Pending Approvals (Action Hash Bound)</h2>
              <div className="bg-[#202D34] border border-[#2C3E47] p-4 rounded space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Approval Request A-17</span>
                  <span className="text-xs font-mono bg-[#11191F] text-[#FFD54F] border border-[#2C3E47] px-2 py-0.5 rounded">
                    HIGH RISK
                  </span>
                </div>
                <div className="font-mono text-xs text-[#8D9FA5]">
                  Action: apply_patch · Target: src/pool.ts
                  <div className="text-[11px] text-[#5C6F76] mt-1 truncate">
                    Hash: 49a2b5e0c671a938d41fe093ab54b9d0e7293a1024e4d5801267812903abc812
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button className="px-3 py-1.5 bg-[#88C7AD] text-[#11191F] text-xs font-semibold rounded hover:bg-[#72af97]">
                    Approve with Hash
                  </button>
                  <button className="px-3 py-1.5 bg-[#162027] border border-[#2C3E47] text-xs font-medium rounded hover:bg-[#1D2B32]">
                    Deny
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'overview' && (
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-[#202D34] border border-[#2C3E47] p-4 rounded">
                <div className="text-xs text-[#8D9FA5]">Active Missions</div>
                <div className="text-2xl font-bold mt-1 text-[#88C7AD]">1</div>
              </div>
              <div className="bg-[#202D34] border border-[#2C3E47] p-4 rounded">
                <div className="text-xs text-[#8D9FA5]">Connected Adapters</div>
                <div className="text-2xl font-bold mt-1 text-[#88C7AD]">4</div>
              </div>
              <div className="bg-[#202D34] border border-[#2C3E47] p-4 rounded">
                <div className="text-xs text-[#8D9FA5]">Loopback Daemon</div>
                <div className="text-2xl font-bold mt-1 text-[#88C7AD]">Healthy</div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
