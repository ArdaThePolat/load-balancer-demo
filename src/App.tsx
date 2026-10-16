import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RoutingDemo from './RoutingDemo'
import './alb.css'

type RequestItem = { id: number; createdAt: number; queuedAt?: number; source: 'manual' | 'auto' }
type Worker = { id: number; active: RequestItem | null; startedAt: number | null; durationMs: number | null; unhealthyUntil: number }
type Protocol = 'push' | 'poll'
type EventItem = { id: number; time: number; kind: 'route' | 'queue' | 'complete' | 'signal' | 'system'; text: string; signal?: { workerId: number; direction: 'to-lb' | 'to-worker'; type: 'status' | 'request' } }
type Simulation = {
  workers: Worker[]
  queue: RequestItem[]
  events: EventItem[]
  nextRequestId: number
  nextWorkerIndex: number
  completed: number
  totalSent: number
  totalWaitMs: number
}

const TICK_MS = 100
const MAX_EVENTS = 60

function makeSimulation(count: number): Simulation {
  return {
    workers: Array.from({ length: count }, (_, i) => ({ id: i + 1, active: null, startedAt: null, durationMs: null, unhealthyUntil: 0 })),
    queue: [], events: [{ id: 0, time: Date.now(), kind: 'system', text: `Pool ready · ${count} workers listening for requests` }],
    nextRequestId: 1, nextWorkerIndex: 0, completed: 0, totalSent: 0, totalWaitMs: 0,
  }
}

function addEvent(sim: Simulation, kind: EventItem['kind'], text: string, time = Date.now(), signal?: EventItem['signal']) {
  sim.events = [{ id: time + Math.random(), time, kind, text, signal }, ...sim.events].slice(0, MAX_EVENTS)
}

function resizeWorkers(current: Simulation, count: number) {
  const sim = { ...current, workers: current.workers.map((worker) => ({ ...worker })), queue: [...current.queue], events: [...current.events] }
  if (count === sim.workers.length) return current

  if (count < sim.workers.length) {
    const removed = sim.workers.slice(count)
    const requeued = removed.flatMap((worker) => {
      if (!worker.active) return []
      const request = { ...worker.active, queuedAt: Date.now() }
      addEvent(sim, 'queue', `Worker ${worker.id} removed · Request #${request.id} returned to the queue`)
      return [request]
    })
    sim.queue = [...sim.queue, ...requeued].sort((a, b) => a.createdAt - b.createdAt)
    sim.workers = sim.workers.slice(0, count)
  } else {
    sim.workers = [...sim.workers, ...Array.from({ length: count - sim.workers.length }, (_, index) => ({
      id: sim.workers.length + index + 1, active: null, startedAt: null, durationMs: null, unhealthyUntil: 0,
    }))]
  }

  sim.nextWorkerIndex %= count
  addEvent(sim, 'system', `Worker pool resized · ${count} worker${count === 1 ? '' : 's'} active`)
  return sim
}

function dispatch(sim: Simulation, request: RequestItem, now: number, minSeconds: number, maxSeconds: number, protocol: Protocol) {
  const count = sim.workers.length
  const checks: string[] = []
  for (let offset = 0; offset < count; offset += 1) {
    const index = (sim.nextWorkerIndex + offset) % count
    const worker = sim.workers[index]
    if (protocol === 'poll') {
      addEvent(sim, 'signal', `LB → W${worker.id}: “Are you idle?” · W${worker.id} → LB: “${worker.unhealthyUntil > now ? 'Unhealthy' : worker.active ? 'Busy' : 'Idle'}”`, now, { workerId: worker.id, direction: 'to-lb', type: 'status' })
    } else {
      addEvent(sim, 'signal', `LB checks W${worker.id}’s latest ${worker.unhealthyUntil > now ? 'UNHEALTHY' : worker.active ? 'BUSY' : 'IDLE'} status announcement`, now)
    }
    checks.push(`W${worker.id} ${worker.unhealthyUntil > now ? 'unhealthy' : worker.active ? 'busy' : 'available'}`)
    if (!worker.active && worker.unhealthyUntil <= now) {
      const durationMs = (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000
      worker.active = request
      worker.startedAt = now
      worker.durationMs = durationMs
      sim.nextWorkerIndex = (index + 1) % count
      addEvent(sim, 'route', `Request #${request.id} → Worker ${worker.id} · checked ${checks.join(' → ')}`, now)
      if (protocol === 'push') addEvent(sim, 'signal', `W${worker.id} → LB: “I’m busy” · status published`, now, { workerId: worker.id, direction: 'to-lb', type: 'status' })
      return
    }
  }
  sim.queue.push({ ...request, queuedAt: request.queuedAt ?? now })
  addEvent(sim, 'queue', `Request #${request.id} queued · checked ${checks.join(' → ')}; no worker available`, now)
}

function sendRequest(current: Simulation, source: RequestItem['source'], minSeconds: number, maxSeconds: number, protocol: Protocol) {
  const sim = { ...current, workers: current.workers.map((worker) => ({ ...worker })), queue: [...current.queue], events: [...current.events] }
  const now = Date.now()
  const request: RequestItem = { id: sim.nextRequestId, createdAt: now, source }
  sim.nextRequestId += 1
  sim.totalSent += 1
  dispatch(sim, request, now, minSeconds, maxSeconds, protocol)
  return sim
}

function tickSimulation(current: Simulation, minSeconds: number, maxSeconds: number, protocol: Protocol) {
  const sim = { ...current, workers: current.workers.map((worker) => ({ ...worker })), queue: [...current.queue], events: [...current.events] }
  const now = Date.now()
  for (const worker of sim.workers) {
    if (worker.unhealthyUntil > 0 && worker.unhealthyUntil <= now) {
      worker.unhealthyUntil = 0
      addEvent(sim, 'system', `Worker ${worker.id} recovered · healthy and accepting new requests`, now)
      if (protocol === 'push') addEvent(sim, 'signal', `W${worker.id} → LB: “I’m healthy” · status published`, now, { workerId: worker.id, direction: 'to-lb', type: 'status' })
    }
    if (worker.active && worker.startedAt !== null && worker.durationMs !== null && now - worker.startedAt >= worker.durationMs) {
      const request = worker.active
      sim.totalWaitMs += Math.max(0, worker.startedAt - (request.queuedAt ?? request.createdAt))
      sim.completed += 1
      addEvent(sim, 'complete', `Request #${request.id} completed on Worker ${worker.id}`, now)
      if (protocol === 'push') addEvent(sim, 'signal', `W${worker.id} → LB: “I’m ${worker.unhealthyUntil > now ? 'unhealthy' : 'idle'}” · status published`, now, { workerId: worker.id, direction: 'to-lb', type: 'status' })
      worker.active = null
      worker.startedAt = null
      worker.durationMs = null
    }
  }
  for (const worker of sim.workers) {
    if (!worker.active && worker.unhealthyUntil <= now && sim.queue.length > 0) {
      const nextRequest = sim.queue.shift()!
      dispatch(sim, nextRequest, now, minSeconds, maxSeconds, protocol)
    }
  }
  return sim
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time)
}

function Icon({ name }: { name: 'sun' | 'moon' | 'play' | 'pause' | 'send' | 'refresh' | 'bolt' | 'arrow' }) {
  const common = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  if (name === 'sun') return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>
  if (name === 'moon') return <svg {...common}><path d="M20.8 13A8.5 8.5 0 0 1 11 3.2 8.5 8.5 0 1 0 20.8 13Z"/></svg>
  if (name === 'play') return <svg {...common}><path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/></svg>
  if (name === 'pause') return <svg {...common}><path d="M8 5h3v14H8zm5 0h3v14h-3z" fill="currentColor" stroke="none"/></svg>
  if (name === 'send') return <svg {...common}><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
  if (name === 'refresh') return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3"/></svg>
  if (name === 'bolt') return <svg {...common}><path d="m13 2-3 8h7l-6 12 1-9H5z"/></svg>
  return <svg {...common}><path d="M5 12h14m-6-6 6 6-6 6"/></svg>
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'concept' | 'round-robin' | 'least-outstanding'>('concept')
  const [workerCount, setWorkerCount] = useState(2)
  const [minSeconds, setMinSeconds] = useState(1)
  const [maxSeconds, setMaxSeconds] = useState(2)
  const [failureProbability, setFailureProbability] = useState(0)
  const [minFailureSeconds, setMinFailureSeconds] = useState(3)
  const [maxFailureSeconds, setMaxFailureSeconds] = useState(5)
  const [protocol, setProtocol] = useState<Protocol>('push')
  const [simulation, setSimulation] = useState(() => makeSimulation(2))
  const [autoTraffic, setAutoTraffic] = useState(false)
  const [requestsPerSecond, setRequestsPerSecond] = useState(1)
  const [darkMode, setDarkMode] = useState(false)
  const [now, setNow] = useState(Date.now())
  const topologyRef = useRef<HTMLDivElement>(null)
  const pulseSvgRef = useRef<SVGSVGElement>(null)
  const lastSignalId = useRef<number | null>(null)
  const [signalPulse, setSignalPulse] = useState<{ id: number; path: string; width: number; height: number; color: string } | null>(null)

  const send = useCallback((source: RequestItem['source']) => {
    setSimulation((current) => sendRequest(current, source, minSeconds, maxSeconds, protocol))
  }, [minSeconds, maxSeconds, protocol])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now())
      setSimulation((current) => tickSimulation(current, minSeconds, maxSeconds, protocol))
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [minSeconds, maxSeconds, protocol])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (failureProbability <= 0 || failureProbability > 100 || minFailureSeconds <= 0 || maxFailureSeconds < minFailureSeconds || maxFailureSeconds > 60) return
      const now = Date.now()
      setSimulation((current) => {
        const sim = { ...current, workers: current.workers.map((worker) => ({ ...worker })), queue: [...current.queue], events: [...current.events] }
        for (const worker of sim.workers) {
          if (worker.unhealthyUntil > now || worker.unhealthyUntil > 0) continue
          if (Math.random() * 100 < failureProbability) {
            const duration = minFailureSeconds + Math.random() * (maxFailureSeconds - minFailureSeconds)
            worker.unhealthyUntil = now + duration * 1000
            addEvent(sim, 'system', `Worker ${worker.id} failed · unhealthy for ${duration.toFixed(1)}s; active work continues`, now)
            if (protocol === 'push') addEvent(sim, 'signal', `W${worker.id} → LB: “I’m unhealthy” · status published`, now, { workerId: worker.id, direction: 'to-lb', type: 'status' })
          }
        }
        return sim
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [failureProbability, minFailureSeconds, maxFailureSeconds, protocol])

  useEffect(() => {
    if (!autoTraffic || !Number.isFinite(requestsPerSecond) || requestsPerSecond < 0.1 || requestsPerSecond > 20 || minSeconds <= 0 || maxSeconds < minSeconds) return
    const timer = window.setInterval(() => send('auto'), 1000 / requestsPerSecond)
    return () => window.clearInterval(timer)
  }, [autoTraffic, requestsPerSecond, send])

  useEffect(() => {
    const event = simulation.events.find((item) => item.signal)
    if (!event?.signal || event.id === lastSignalId.current) return
    lastSignalId.current = event.id
    const board = topologyRef.current
    const worker = board?.querySelector<HTMLElement>(`[data-worker-id="${event.signal.workerId}"]`)
    const balancer = board?.querySelector<HTMLElement>('.load-balancer-node')
    if (!board || !worker || !balancer) return
    const rect = board.getBoundingClientRect()
    const workerRect = worker.getBoundingClientRect()
    const lbRect = balancer.getBoundingClientRect()
    const workerNodes = board.querySelector<HTMLElement>('.worker-nodes')
    const narrow = window.matchMedia('(max-width: 600px)').matches
    const branchStyle = getComputedStyle(worker, event.signal.type === 'status' ? '::after' : '::before')
    const railStyle = workerNodes && getComputedStyle(workerNodes, event.signal.type === 'status' ? '::after' : '::before')
    const lbX = lbRect.right - rect.left
    const lbCenterY = lbRect.top + lbRect.height / 2 - rect.top
    const workerEdgeX = workerRect.left - rect.left
    const workerBranchX = workerEdgeX + parseFloat(branchStyle.left || '0')
    const workerBranchY = workerRect.top + parseFloat(branchStyle.top || `${workerRect.height / 2}px`) - rect.top
    const branch = workerNodes?.getBoundingClientRect()
    const railOffset = parseFloat(railStyle?.left || '0')
    const railX = branch ? (narrow ? branch.left + branch.width * railOffset / 100 : branch.left + railOffset) - rect.left : (lbX + workerBranchX) / 2
    const boardCenterX = rect.width / 2 + (event.signal.type === 'status' ? 3 : -4)
    const bridgeY = narrow ? lbRect.bottom - rect.top + 21 : rect.height / 2 + (event.signal.type === 'status' ? 3 : -3)
    const path = narrow
      ? `M ${workerEdgeX} ${workerBranchY} H ${railX} V ${branch ? branch.top - rect.top : workerBranchY} H ${boardCenterX} V ${lbRect.bottom - rect.top}`
      : `M ${workerEdgeX} ${workerBranchY} H ${railX} V ${bridgeY} H ${lbX} V ${lbCenterY}`
    setSignalPulse({ id: event.id, path, width: rect.width, height: rect.height, color: event.signal.type === 'status' ? '#24a879' : '#536ff0' })
    const timer = window.setTimeout(() => setSignalPulse((active) => active?.id === event.id ? null : active), 850)
    return () => window.clearTimeout(timer)
  }, [simulation.events])

  useEffect(() => {
    const svg = pulseSvgRef.current
    const motionPath = svg?.querySelector<SVGPathElement>('.signal-motion-path')
    const dot = svg?.querySelector<SVGCircleElement>('.signal-motion-dot')
    if (!signalPulse || !motionPath || !dot) return
    const length = motionPath.getTotalLength()
    const started = performance.now()
    let frame = 0
    const animate = (time: number) => {
      const progress = Math.min(1, (time - started) / 750)
      const point = motionPath.getPointAtLength(length * progress)
      dot.setAttribute('cx', String(point.x))
      dot.setAttribute('cy', String(point.y))
      dot.setAttribute('opacity', '1')
      if (progress < 1) frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frame)
  }, [signalPulse])

  const activeCount = simulation.workers.filter((worker) => worker.active).length
  const idleCount = simulation.workers.filter((worker) => !worker.active && worker.unhealthyUntil <= now).length
  const utilization = simulation.workers.length ? Math.round((activeCount / simulation.workers.length) * 100) : 0
  const avgQueueWait = simulation.completed ? (simulation.totalWaitMs / simulation.completed / 1000).toFixed(2) : '0.00'
  const recentEvents = useMemo(() => simulation.events, [simulation.events])

  function resetSimulation() {
    setAutoTraffic(false)
    setSimulation(makeSimulation(workerCount))
  }

  const failureConfigValid = failureProbability >= 0 && failureProbability <= 100 && minFailureSeconds > 0 && maxFailureSeconds >= minFailureSeconds && maxFailureSeconds <= 60
  const configurationValid = minSeconds > 0 && maxSeconds >= minSeconds && workerCount >= 1 && workerCount <= 12 && failureConfigValid
  const trafficRateValid = Number.isFinite(requestsPerSecond) && requestsPerSecond >= 0.1 && requestsPerSecond <= 20

  function changeWorkerCount(value: number) {
    setWorkerCount(value)
    if (Number.isInteger(value) && value >= 1 && value <= 12) {
      setSimulation((current) => resizeWorkers(current, value))
    }
  }

  return (
    <main className={darkMode ? 'app dark' : 'app'}>
      <div className="shell">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="Balancer home"><span className="brand-mark"><span/><span/><span/></span><span>balancer<span className="brand-dot">.</span></span></a>
          <div className="topbar-right"><span className="local-badge"><span className="live-dot"/>LOCAL SIMULATION</span><button className="theme-toggle" onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}><Icon name={darkMode ? 'sun' : 'moon'}/><span>{darkMode ? 'Light mode' : 'Dark mode'}</span></button></div>
        </header>

        <section className="intro" id="top">
          <div className="eyebrow"><span className="eyebrow-line"/>INTERACTIVE PLAYGROUND</div>
          <h1>Load balancing,<br/><span>made visible.</span></h1>
          <p className="intro-copy">Send requests into a pool of workers and watch the load balancer decide where each one goes.</p>
        </section>

        <nav className="demo-tabs" aria-label="Load balancer demos" role="tablist">
          <button role="tab" aria-selected={activeTab === 'concept'} className={activeTab === 'concept' ? 'demo-tab active' : 'demo-tab'} onClick={() => setActiveTab('concept')}>Conceptual demo<span>Worker availability & FIFO queue</span></button>
          <button role="tab" aria-selected={activeTab === 'round-robin'} className={activeTab === 'round-robin' ? 'demo-tab active' : 'demo-tab'} onClick={() => setActiveTab('round-robin')}>Round robin demo<span>Rotate across healthy targets</span></button>
          <button role="tab" aria-selected={activeTab === 'least-outstanding'} className={activeTab === 'least-outstanding' ? 'demo-tab active' : 'demo-tab'} onClick={() => setActiveTab('least-outstanding')}>Least outstanding requests<span>Prefer fewer active requests</span></button>
        </nav>

        <div className="tab-view" hidden={activeTab !== 'concept'} role="tabpanel">

        <section className="control-panel panel" aria-label="Simulation controls">
          <div className="panel-heading"><div><div className="section-kicker">01 / CONFIGURE</div><h2>Simulation setup</h2></div><span className="defaults-label">Worker count updates live</span></div>
          <div className="config-controls">
            <label className="field"><span>Workers</span><div className="input-wrap"><input aria-label="Number of workers" type="number" min="1" max="12" step="1" value={workerCount} onChange={(event) => changeWorkerCount(Number(event.target.value))}/><span className="input-suffix">workers</span></div></label>
            <label className="field"><span>Min processing</span><div className="input-wrap"><input aria-label="Minimum processing seconds" type="number" min="0.1" max="60" step="0.1" value={minSeconds} onChange={(event) => setMinSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
            <label className="field"><span>Max processing</span><div className="input-wrap"><input aria-label="Maximum processing seconds" type="number" min="0.1" max="60" step="0.1" value={maxSeconds} onChange={(event) => setMaxSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
            <button className="button button-secondary reset-button" onClick={resetSimulation} disabled={!configurationValid}><Icon name="refresh"/>Reset simulation</button>
          </div>
          {!configurationValid && <div className="form-error" role="alert">Use 1–12 workers, a positive processing range, a 0–100% failure chance, and a valid outage duration range up to 60 seconds.</div>}
        </section>

        <section className="panel failure-controls" aria-label="Random worker failure configuration">
          <div className="failure-controls-copy"><div className="section-kicker">SIMULATED FAILURES</div><h3>Test worker availability</h3><p>Each healthy worker gets an independent failure roll every second. Existing requests continue during an outage.</p></div>
          <label className="field"><span>Failure chance</span><div className="input-wrap"><input aria-label="Failure probability percent" type="number" min="0" max="100" step="1" value={failureProbability} onChange={(event) => setFailureProbability(Number(event.target.value))}/><span className="input-suffix">%</span></div></label>
          <label className="field"><span>Min outage</span><div className="input-wrap"><input aria-label="Minimum failure duration seconds" type="number" min="0.1" max="60" step="0.1" value={minFailureSeconds} onChange={(event) => setMinFailureSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
          <label className="field"><span>Max outage</span><div className="input-wrap"><input aria-label="Maximum failure duration seconds" type="number" min="0.1" max="60" step="0.1" value={maxFailureSeconds} onChange={(event) => setMaxFailureSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
          {!failureConfigValid && <div className="form-error" role="alert">Use a 0–100% chance and an outage range up to 60 seconds, with maximum at least minimum.</div>}
        </section>

        <div className="dashboard-head"><div><div className="section-kicker">02 / LIVE VIEW</div><h2>Worker pool</h2></div><div className="traffic-controls"><label className="rate-control"><span>Auto req/s</span><input aria-label="Automatic requests per second" type="number" min="0.1" max="20" step="0.1" value={requestsPerSecond} onChange={(event) => setRequestsPerSecond(Number(event.target.value))}/></label><button className="button button-primary" onClick={() => send('manual')} disabled={!configurationValid}><Icon name="send"/>Send request</button><button className={autoTraffic ? 'button button-auto active' : 'button button-auto'} onClick={() => setAutoTraffic((value) => !value)} disabled={!configurationValid || (!autoTraffic && !trafficRateValid)}><Icon name={autoTraffic ? 'pause' : 'play'}/>{autoTraffic ? 'Stop auto traffic' : 'Start auto traffic'}</button></div></div>

        <section className="metrics-grid" aria-label="Simulation metrics">
          <article className="metric-card"><div className="metric-label">Requests sent <span className="metric-icon blue"><Icon name="send"/></span></div><div className="metric-value">{simulation.totalSent.toString().padStart(2, '0')}</div><div className="metric-note">Since last reset</div></article>
          <article className="metric-card"><div className="metric-label">In progress <span className="metric-icon amber"><Icon name="bolt"/></span></div><div className="metric-value">{activeCount.toString().padStart(2, '0')}<span className="metric-unit">/ {simulation.workers.length}</span></div><div className="metric-note">{idleCount} worker{idleCount === 1 ? '' : 's'} available</div></article>
          <article className="metric-card"><div className="metric-label">Waiting in queue <span className="metric-icon violet"><Icon name="arrow"/></span></div><div className="metric-value">{simulation.queue.length.toString().padStart(2, '0')}</div><div className="metric-note">FIFO · first in, first out</div></article>
          <article className="metric-card"><div className="metric-label">Completed <span className="metric-icon green">✓</span></div><div className="metric-value">{simulation.completed.toString().padStart(2, '0')}</div><div className="metric-note">Avg. queue wait {avgQueueWait}s</div></article>
        </section>

        <div className="content-grid">
          <section className="panel workers-panel">
            <div className="panel-heading worker-heading"><div><div className="section-kicker">LIVE SYSTEM MAP · {activeCount}/{simulation.workers.length} BUSY</div><h2>Load balancer & worker pool</h2></div><div className="utilization"><span>Pool utilization</span><strong>{utilization}%</strong></div></div>
            <div className="utilization-track"><span style={{ width: `${utilization}%` }}/></div>
            <div className="protocol-bar">
              <div><span className="protocol-label">WORKER STATUS SIGNAL</span><span className="protocol-hint">Choose how the balancer learns who is idle</span></div>
              <div className="protocol-toggle" role="group" aria-label="Worker status signaling mode">
                <button className={protocol === 'push' ? 'protocol-option selected' : 'protocol-option'} onClick={() => setProtocol('push')} aria-pressed={protocol === 'push'}><span className="protocol-option-dot push-dot"/>Worker publishes</button>
                <button className={protocol === 'poll' ? 'protocol-option selected' : 'protocol-option'} onClick={() => setProtocol('poll')} aria-pressed={protocol === 'poll'}><span className="protocol-option-dot poll-dot"/>LB polls</button>
              </div>
            </div>
            <div className="topology-canvas">
              <div className="topology-layout" ref={topologyRef}>
                <div className="lb-column">
                  <div className="incoming-chip"><span className="incoming-pulse"/>INCOMING REQUESTS</div>
                  <div className="load-balancer-node"><span className="lb-icon"><span/><span/><span/></span><span className="lb-copy"><strong>Load balancer</strong><small>Round-robin · tracks availability</small></span><span className="lb-live"><i/>ACTIVE</span></div>
                </div>
                <div className="signal-bridge" aria-hidden="true"><span className="bridge-request"/><span className="bridge-status"/></div>
                <div className="worker-nodes">
                  {simulation.workers.map((worker) => {
                    const elapsed = worker.active && worker.startedAt ? now - worker.startedAt : 0
                    const progress = worker.durationMs ? Math.min(100, (elapsed / worker.durationMs) * 100) : 0
                    const remaining = worker.durationMs ? Math.max(0, worker.durationMs - elapsed) / 1000 : 0
                    const unhealthy = worker.unhealthyUntil > now
                    const status = unhealthy ? 'UNHEALTHY' : worker.active ? 'BUSY' : 'IDLE'
                    return <article className={`worker-card topology-worker ${worker.active ? 'busy' : 'idle'} ${unhealthy ? 'unhealthy' : ''}`} data-worker-id={worker.id} key={worker.id}>
                      <div className="worker-top"><div className="worker-identity"><div className="worker-avatar"><span className="worker-avatar-inner">W{worker.id.toString().padStart(2, '0')}</span><span className={`worker-indicator ${worker.active ? 'is-busy' : ''} ${unhealthy ? 'is-unhealthy' : ''}`}/></div><div><div className="worker-name">Worker {worker.id.toString().padStart(2, '0')}</div><div className="worker-subtitle">{worker.active ? `Request #${worker.active.id}` : unhealthy ? 'Temporarily unavailable' : 'Ready for work'}</div></div></div><span className={`status-pill ${unhealthy ? 'status-unhealthy' : worker.active ? 'status-busy' : 'status-idle'}`}><span/>{status}</span></div>
                      <div className="worker-progress"><div className="progress-track"><span className={worker.active ? 'progress-active' : ''} style={{ width: `${progress}%` }}/></div><span className="progress-label">{worker.active ? `${remaining.toFixed(1)}s` : unhealthy ? `${Math.max(0, worker.unhealthyUntil - now) / 1000 | 0}s` : '—'}</span></div>
                      <div className={`worker-signal ${protocol}`}><span className="signal-mini-dot"/>{protocol === 'push' ? `PUBLISHED · ${status}` : unhealthy ? 'HEALTH CHECK · UNHEALTHY' : 'HEALTH CHECK READY'}</div>
                    </article>
                  })}
                </div>
                {signalPulse && <svg ref={pulseSvgRef} className="signal-animation-layer" width={signalPulse.width} height={signalPulse.height} viewBox={`0 0 ${signalPulse.width} ${signalPulse.height}`} aria-hidden="true"><path className="signal-motion-path" d={signalPulse.path}/><circle className="signal-motion-dot" r="4.5" cx="0" cy="0" opacity="0" fill={signalPulse.color}/></svg>}
              </div>
              <div className={`connector-legend ${protocol}`}><span className="legend-request"><i/>Request to worker</span><span className="legend-status"><i/>{protocol === 'push' ? 'Status published to LB' : 'LB asks “Are you idle?”'}</span></div>
            </div>
            <div className="queue-section">
              <div className="queue-heading"><span>REQUEST QUEUE</span><span>{simulation.queue.length} waiting</span></div>
              {simulation.queue.length > 0 ? <ol className="queue-list">{simulation.queue.map((request, index) => <li className="queue-item" key={request.id}><span className="queue-position">{String(index + 1).padStart(2, '0')}</span><span>Request #{request.id}</span><span className="queue-waiting">WAITING</span></li>)}</ol> : <div className="queue-empty">No requests waiting — the next request will be routed immediately.</div>}
            </div>
            <div className="pool-note"><span className="note-icon">i</span><span>{protocol === 'push' ? 'Workers publish status changes to the balancer. The balancer routes from its latest availability view.' : 'The balancer asks workers about availability as it scans, then routes to the first idle worker.'} If all workers are busy, requests wait in FIFO order.</span></div>
          </section>

          <aside className="panel activity-panel">
            <div className="panel-heading activity-heading"><div><div className="section-kicker">LIVE TRACE</div><h2>Activity</h2></div><span className="live-indicator"><span className="live-dot"/>LIVE</span></div>
            <ol className="event-list" aria-live="polite" aria-label="Routing activity">
              {recentEvents.map((event) => <li className={`event-item event-${event.kind}`} key={event.id}><span className="event-marker"/><div className="event-content"><div className="event-text">{event.text}</div><time>{formatTime(event.time)}</time></div></li>)}
            </ol>
          </aside>
        </div>

        <section className="how-it-works panel">
          <div className="how-title"><div className="section-kicker">HOW THIS SYSTEM WORKS</div><h2>Three simple steps</h2><p>Follow a request from arrival to completion.</p></div>
          <div className="explain-cards">
            <article className="explain-card"><span className="explain-number">01</span><div><h3>Find the next worker</h3><p>The balancer scans in round-robin order, starting after the last assignment. Busy workers are skipped.</p></div></article>
            <article className="explain-card"><span className="explain-number">02</span><div><h3>Share availability</h3><p><strong>Worker publishes:</strong> workers announce IDLE or BUSY changes. <strong>LB polls:</strong> the balancer asks “Are you idle?” while scanning.</p></div></article>
            <article className="explain-card"><span className="explain-number">03</span><div><h3>Queue when full</h3><p>If every worker is busy, requests wait FIFO. The next available worker picks up the oldest request.</p></div></article>
            <article className="explain-card"><span className="explain-number">04</span><div><h3>Recover from temporary outages</h3><p>Each healthy worker gets an independent failure roll every second. Unhealthy workers stop receiving new work for a random configured duration; requests already in progress continue.</p></div></article>
          </div>
        </section>

        <footer className="footer"><span>Conceptual scheduler demo.</span><span><span className="footer-dot"/>All processing runs locally in your browser</span></footer>
        </div>

        <div className="tab-view" hidden={activeTab !== 'round-robin'} role="tabpanel"><RoutingDemo algorithm="round-robin"/></div>
        <div className="tab-view" hidden={activeTab !== 'least-outstanding'} role="tabpanel"><RoutingDemo algorithm="least-outstanding"/></div>

        <section className="panel practices-panel" aria-labelledby="practices-title">
          <div className="how-title"><div className="section-kicker">BEYOND THE ALGORITHM</div><h2 id="practices-title">Load balancer practices to consider</h2><p>Reliability depends on safe target lifecycle, clear health signals, and useful monitoring as well as request selection.</p></div>
          <div className="explain-cards practices-grid">
            <article className="explain-card"><span className="explain-number">01</span><div><h3>Match the algorithm to the workload</h3><p>Use round robin when request costs and target capacity are similar. Consider least outstanding requests when request times or target capacity vary.</p></div></article>
            <article className="explain-card"><span className="explain-number">02</span><div><h3>Check readiness, not just process uptime</h3><p>Health checks should represent whether a target can serve traffic. Choose the endpoint, accepted response codes, and failure/recovery thresholds deliberately.</p></div></article>
            <article className="explain-card"><span className="explain-number">03</span><div><h3>Drain before shutting down</h3><p>Stop assigning new requests to a removed target and allow in-flight requests to finish before termination. Set the drain window to fit your request and shutdown times.</p></div></article>
            <article className="explain-card"><span className="explain-number">04</span><div><h3>Warm new targets gradually</h3><p>Give a new instance time to initialize caches and connections before it receives a full share. ALB slow start cannot be combined with least outstanding requests.</p></div></article>
            <article className="explain-card"><span className="explain-number">05</span><div><h3>Use session stickiness only when needed</h3><p>Affinity helps when an application keeps session state on one target, but repeated requests from that client bypass normal balancing and can make load uneven.</p></div></article>
            <article className="explain-card"><span className="explain-number">06</span><div><h3>Monitor latency, errors, and healthy capacity</h3><p>Track target response time, 4xx/5xx errors, and healthy target counts. Alert on sustained changes so a single bad target or shrinking pool is visible.</p></div></article>
            <article className="explain-card"><span className="explain-number">07</span><div><h3>Keep retries bounded</h3><p>Limit retries and use exponential backoff. Immediate repeated retries can add traffic to a service that is already struggling.</p></div></article>
          </div>
          <div className="alb-sources practices-sources"><span>Sources:</span><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html" target="_blank" rel="noreferrer">ALB target group settings</a><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html" target="_blank" rel="noreferrer">Health checks</a><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html" target="_blank" rel="noreferrer">Monitoring metrics</a><a href="https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_limit_retries.html" target="_blank" rel="noreferrer">Retry guidance</a></div>
        </section>

        <section className="panel practices-panel techniques-panel" aria-labelledby="techniques-title">
          <div className="how-title"><div className="section-kicker">MORE ROUTING OPTIONS</div><h2 id="techniques-title">Other techniques we could simulate</h2><p>These algorithms make good comparison demos because each optimizes for a different kind of workload.</p></div>
          <div className="explain-cards practices-grid">
            <article className="explain-card"><span className="explain-number">A</span><div><h3>Weighted round robin</h3><p>Give higher-capacity targets more turns, such as 3 requests to a large worker for every 1 to a small one. Straightforward and predictable.</p></div></article>
            <article className="explain-card"><span className="explain-number">B</span><div><h3>Weighted random</h3><p>Pick targets randomly, with stronger targets assigned a higher chance. Over many requests, traffic approaches the configured proportions; short bursts can vary.</p></div></article>
            <article className="explain-card"><span className="explain-number">C</span><div><h3>Least connections</h3><p>Choose the target with the fewest open connections. This differs from least outstanding requests, which compares in-progress requests; it can suit long-lived connections.</p></div></article>
            <article className="explain-card"><span className="explain-number">D</span><div><h3>Client IP hash</h3><p>Hash a client IP to a target so repeat requests tend to return to the same worker. It can preserve local session state, but some targets may get more clients than others.</p></div></article>
            <article className="explain-card"><span className="explain-number">E</span><div><h3>Least time</h3><p>Favor targets using response latency along with active work. It can react to a slow target, but needs reliable latency measurements and smoothing.</p></div></article>
          </div>
          <div className="alb-sources practices-sources"><span>Technique references:</span><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html" target="_blank" rel="noreferrer">AWS weighted random</a><a href="https://nginx.org/en/docs/http/load_balancing.html" target="_blank" rel="noreferrer">NGINX load-balancing methods</a></div>
        </section>
      </div>
    </main>
  )
}
