import { useEffect, useRef, useState } from 'react'

type Target = { id: number; healthy: boolean; serviceUp: boolean; failures: number; successes: number; failureUntil: number; requests: number; inFlight: number; inFlightUntil: number[] }
type LogEvent = { id: number; text: string; kind: 'check' | 'route' | 'state' }
type Pulse = { id: number; targetId: number; kind: 'request' | 'health-request' | 'health-response'; path: string; delay: number }

const INTERVAL = 2500
const THRESHOLD = 2

function makeTargets(): Target[] {
  return [1, 2, 3].map((id) => ({ id, healthy: true, serviceUp: true, failures: 0, successes: 0, failureUntil: 0, requests: 0, inFlight: 0, inFlightUntil: [] }))
}

type Algorithm = 'round-robin' | 'least-outstanding'

export default function RoutingDemo({ algorithm }: { algorithm: Algorithm }) {
  const [minSeconds, setMinSeconds] = useState(1)
  const [maxSeconds, setMaxSeconds] = useState(4)
  const [failureProbability, setFailureProbability] = useState(0)
  const [minFailureSeconds, setMinFailureSeconds] = useState(3)
  const [maxFailureSeconds, setMaxFailureSeconds] = useState(5)
  const [requestsPerSecond, setRequestsPerSecond] = useState(1)
  const [autoTraffic, setAutoTraffic] = useState(false)
  const [targets, setTargets] = useState(makeTargets)
  const [events, setEvents] = useState<LogEvent[]>([{ id: 0, text: 'Balancer ready · 3 registered targets are healthy', kind: 'state' }])
  const [nextTarget, setNextTarget] = useState(0)
  const [requestCount, setRequestCount] = useState(0)
  const [lastCheck, setLastCheck] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const [pulses, setPulses] = useState<Pulse[]>([])
  const targetsRef = useRef(targets)
  const routeRef = useRef<HTMLDivElement>(null)
  const pulseSvgRef = useRef<SVGSVGElement>(null)
  const animatedPulseIds = useRef(new Set<number>())
  const pulseFrames = useRef(new Map<number, number>())
  const sendRequestRef = useRef<() => void>(() => {})
  targetsRef.current = targets

  function log(text: string, kind: LogEvent['kind']) {
    setEvents((current) => [{ id: Date.now() + Math.random(), text, kind }, ...current].slice(0, 10))
  }

  function makePulse(targetId: number, kind: Pulse['kind'], delay = 0): Pulse | null {
    const route = routeRef.current
    const target = route?.querySelector<HTMLElement>(`[data-target-id="${targetId}"]`)
    const client = route?.querySelector<HTMLElement>('.client-node')
    const lb = route?.querySelector<HTMLElement>('.lb-node')
    const branches = route?.querySelector<HTMLElement>('.alb-branches')
    if (!route || !target || !client || !lb || !branches) return null
    const bounds = route.getBoundingClientRect()
    const point = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left - bounds.left, right: rect.right - bounds.left, top: rect.top - bounds.top, cy: rect.top + rect.height / 2 - bounds.top }
    }
    const c = point(client), l = point(lb), t = point(target), b = point(branches)
    const targetBranch = branches.querySelectorAll<HTMLElement>('span')[targetId - 1]
    const branchTop = targetBranch ? targetBranch.getBoundingClientRect().top - bounds.top : t.cy
    const spine = b.left + (kind.startsWith('health') ? 6 : 1)
    const rowY = branchTop + (kind.startsWith('health') ? 4 : 0)
    let path: string
    if (kind === 'request') path = `M ${c.right} ${c.cy} H ${l.left} H ${l.right} H ${spine} V ${rowY} H ${t.left}`
    else if (kind === 'health-response') path = `M ${t.left} ${rowY} H ${spine} V ${l.cy - 7} H ${l.right}`
    else path = `M ${l.right} ${l.cy - 7} H ${spine} V ${rowY} H ${t.left}`
    return { id: Date.now() + Math.random(), targetId, kind, path, delay }
  }

  function animateRequest(targetId: number) {
    const pulse = makePulse(targetId, 'request')
    if (!pulse) return
    setPulses((current) => [...current, pulse])
    window.setTimeout(() => setPulses((current) => current.filter((item) => item.id !== pulse.id)), 1200)
  }

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 100)
    const completionClock = window.setInterval(() => {
      const time = Date.now()
      const updated = targetsRef.current.map((target) => {
        const inFlightUntil = target.inFlightUntil.filter((finishAt) => finishAt > time)
        const recovered = target.failureUntil > 0 && target.failureUntil <= time
        if (recovered) log(`Target T${target.id} recovered · returned to healthy pool`, 'state')
        if (inFlightUntil.length === target.inFlightUntil.length && !recovered) return target
        return { ...target, inFlightUntil, inFlight: inFlightUntil.length, ...(recovered ? { failureUntil: 0, healthy: target.serviceUp, failures: 0, successes: 0 } : {}) }
      })
      if (updated.some((target, index) => target !== targetsRef.current[index])) {
        targetsRef.current = updated
        setTargets(updated)
      }
    }, 100)
    const timer = window.setInterval(() => {
      const time = Date.now()
      setNow(time)
      setLastCheck(time)
      const updated = targetsRef.current.map((target) => {
        if (target.failureUntil > time) {
          log(`Health check → T${target.id} · simulated outage`, 'check')
          return { ...target, healthy: false, failures: 0, successes: 0 }
        }
        if (target.failureUntil > 0 && target.failureUntil <= time) return target
        if (target.serviceUp) {
          const successes = Math.min(THRESHOLD, target.successes + 1)
          const recovered = !target.healthy && successes >= THRESHOLD
          log(recovered ? `Target T${target.id} passed ${THRESHOLD} checks · marked healthy` : `Health check → T${target.id} · HTTP 200 OK${target.healthy ? '' : ` (recovery ${successes}/${THRESHOLD})`}`, recovered ? 'state' : 'check')
          return { ...target, failures: 0, successes, healthy: target.healthy || successes >= THRESHOLD }
        }
        const failures = Math.min(THRESHOLD, target.failures + 1)
        const failed = target.healthy && failures >= THRESHOLD
        log(failed ? `Target T${target.id} failed ${THRESHOLD} checks · removed from routing` : `Health check → T${target.id} · timeout (failure ${failures}/${THRESHOLD})`, failed ? 'state' : 'check')
        return { ...target, successes: 0, failures, healthy: target.healthy && failures < THRESHOLD }
      })
      targetsRef.current = updated
      setTargets(updated)
      const checks = updated.flatMap((target, index) => [
        makePulse(target.id, 'health-request', index * 90),
        makePulse(target.id, 'health-response', 520 + index * 90),
      ]).filter((pulse): pulse is Pulse => pulse !== null)
      setPulses((current) => [...current, ...checks])
      window.setTimeout(() => setPulses((current) => current.filter((pulse) => !checks.some((check) => check.id === pulse.id))), 1550)
    }, INTERVAL)
    return () => { window.clearInterval(timer); window.clearInterval(clock); window.clearInterval(completionClock) }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (failureProbability <= 0 || failureProbability > 100 || minFailureSeconds <= 0 || maxFailureSeconds < minFailureSeconds || maxFailureSeconds > 60) return
      const now = Date.now()
      const updated = targetsRef.current.map((target) => {
        if (target.failureUntil > 0) {
          if (target.failureUntil > now) return target
          log(`Target T${target.id} recovered · returned to healthy pool`, 'state')
          return { ...target, healthy: target.serviceUp, failureUntil: 0, failures: 0, successes: 0 }
        }
        if (!target.serviceUp || !target.healthy || Math.random() * 100 >= failureProbability) return target
        const duration = minFailureSeconds + Math.random() * (maxFailureSeconds - minFailureSeconds)
        log(`Target T${target.id} failed · unhealthy for ${duration.toFixed(1)}s`, 'state')
        return { ...target, healthy: false, failureUntil: now + duration * 1000, failures: 0, successes: 0 }
      })
      if (updated.some((target, index) => target !== targetsRef.current[index])) {
        targetsRef.current = updated
        setTargets(updated)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [failureProbability, minFailureSeconds, maxFailureSeconds])

  useEffect(() => {
    const svg = pulseSvgRef.current
    if (!svg) return
    const liveIds = new Set(pulses.map((pulse) => pulse.id))
    for (const [id, frame] of pulseFrames.current) {
      if (!liveIds.has(id)) {
        window.cancelAnimationFrame(frame)
        pulseFrames.current.delete(id)
      }
    }
    for (const pulse of pulses) {
      if (animatedPulseIds.current.has(pulse.id)) continue
      const path = svg.querySelector<SVGPathElement>(`[data-pulse-path="${pulse.id}"]`)
      const dot = svg.querySelector<SVGCircleElement>(`[data-pulse-dot="${pulse.id}"]`)
      if (!path || !dot) continue
      animatedPulseIds.current.add(pulse.id)
      const length = path.getTotalLength()
      const startsAt = performance.now() + pulse.delay
      const animate = (time: number) => {
        const elapsed = time - startsAt
        if (elapsed < 0) {
          pulseFrames.current.set(pulse.id, window.requestAnimationFrame(animate))
          return
        }
        const progress = Math.min(1, elapsed / 440)
        const position = path.getPointAtLength(length * progress)
        dot.setAttribute('cx', String(position.x))
        dot.setAttribute('cy', String(position.y))
        dot.setAttribute('opacity', progress < 1 ? '1' : '0')
        if (progress < 1) pulseFrames.current.set(pulse.id, window.requestAnimationFrame(animate))
        else pulseFrames.current.delete(pulse.id)
      }
      pulseFrames.current.set(pulse.id, window.requestAnimationFrame(animate))
    }
  }, [pulses])

  useEffect(() => () => {
    for (const frame of pulseFrames.current.values()) window.cancelAnimationFrame(frame)
    pulseFrames.current.clear()
  }, [])

  const healthyCount = targets.filter((target) => target.healthy).length
  const timeToCheck = Math.max(0, INTERVAL - (now - lastCheck))

  function sendRequest() {
    const currentTargets = targetsRef.current
    const eligible = currentTargets.map((target, index) => ({ target, index })).filter(({ target }) => target.healthy)
    setRequestCount((count) => count + 1)
    const candidates = eligible.length ? eligible : currentTargets.map((target, index) => ({ target, index }))
    if (eligible.length === 0) log('No healthy targets · fail-open model routes across registered targets', 'state')
    const least = algorithm === 'least-outstanding'
      ? Math.min(...candidates.map(({ target }) => target.inFlight))
      : null
    const leastCandidates = least === null ? candidates : candidates.filter(({ target }) => target.inFlight === least)
    const selected = leastCandidates.find(({ index }) => index >= nextTarget) ?? leastCandidates[0]
    const id = requestCount + 1
    setNextTarget((selected.index + 1) % targets.length)
    const finishAt = Date.now() + ((minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000)
    const updated = currentTargets.map((target) => target.id === selected.target.id
      ? { ...target, requests: target.requests + 1, inFlightUntil: [...target.inFlightUntil, finishAt], inFlight: target.inFlight + 1 }
      : target)
    targetsRef.current = updated
    setTargets(updated)
    log(algorithm === 'round-robin'
      ? `Request #${id} → T${selected.target.id} · next healthy target in rotation`
      : `Request #${id} → T${selected.target.id} · ${selected.target.inFlight} in flight (fewest among eligible)`, 'route')
    animateRequest(selected.target.id)
  }

  sendRequestRef.current = sendRequest

  useEffect(() => {
    const rangeValid = minSeconds > 0 && maxSeconds >= minSeconds && maxSeconds <= 60
    const rateValid = Number.isFinite(requestsPerSecond) && requestsPerSecond >= 0.1 && requestsPerSecond <= 20
    if (!autoTraffic || !rangeValid || !rateValid) return
    const timer = window.setInterval(() => sendRequestRef.current(), 1000 / requestsPerSecond)
    return () => window.clearInterval(timer)
  }, [autoTraffic, requestsPerSecond, minSeconds, maxSeconds])

  function toggleService(id: number) {
    const updated = targetsRef.current.map((target) => target.id === id ? { ...target, serviceUp: !target.serviceUp, failures: 0, successes: 0 } : target)
    targetsRef.current = updated
    targetsRef.current = updated
    setTargets(updated)
    const target = targets.find((item) => item.id === id)!
    log(`T${id} test endpoint ${target.serviceUp ? 'disabled' : 'restored'} · waiting for health-check thresholds`, 'state')
  }

  function reset() {
    const freshTargets = makeTargets()
    targetsRef.current = freshTargets
    setAutoTraffic(false); setTargets(freshTargets); setEvents([{ id: Date.now(), text: 'Balancer ready · 3 registered targets are healthy', kind: 'state' }]); setNextTarget(0); setRequestCount(0); setPulses([])
  }

  const failureConfigValid = failureProbability >= 0 && failureProbability <= 100 && minFailureSeconds > 0 && maxFailureSeconds >= minFailureSeconds && maxFailureSeconds <= 60

  return <section className="alb-demo">
    <div className="alb-heading"><div><div className="section-kicker">{algorithm === 'round-robin' ? 'ROUND ROBIN' : 'LEAST OUTSTANDING REQUESTS'} · SIMULATED</div><h2>{algorithm === 'round-robin' ? 'Rotate across healthy targets' : 'Choose the lightest active request load'}</h2><p>Health checks run independently and mark targets eligible. Each client request is routed using the selected algorithm.</p><p className="alb-sim-note">New requests take a random {minSeconds}–{maxSeconds} seconds to process. Health checks are accelerated to every 2.5 seconds with a threshold of 2.</p></div><button className="button button-secondary" onClick={reset}>Reset demo</button></div>
    <section className="panel alb-processing-controls" aria-label="Processing time configuration">
      <div><div className="section-kicker">PROCESSING TIME</div><h3>Set the request duration range</h3><p>New requests use a random duration in this range. Active requests keep their current duration.</p></div>
      <label className="field"><span>Minimum</span><div className="input-wrap"><input aria-label="Minimum processing seconds" type="number" min="0.1" max="60" step="0.1" value={minSeconds} onChange={(event) => setMinSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
      <label className="field"><span>Maximum</span><div className="input-wrap"><input aria-label="Maximum processing seconds" type="number" min="0.1" max="60" step="0.1" value={maxSeconds} onChange={(event) => setMaxSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
      {!(minSeconds > 0 && maxSeconds >= minSeconds && maxSeconds <= 60) && <div className="form-error" role="alert">Use a positive range up to 60 seconds, with maximum at least minimum.</div>}
    </section>
    <section className="panel alb-processing-controls alb-failure-controls" aria-label="Random target failure configuration">
      <div><div className="section-kicker">SIMULATED FAILURES</div><h3>Test target availability</h3><p>Each healthy target gets an independent failure roll every second. Existing requests continue during an outage.</p></div>
      <label className="field"><span>Failure chance</span><div className="input-wrap"><input aria-label="Failure probability percent" type="number" min="0" max="100" step="1" value={failureProbability} onChange={(event) => setFailureProbability(Number(event.target.value))}/><span className="input-suffix">%</span></div></label>
      <label className="field"><span>Min outage</span><div className="input-wrap"><input aria-label="Minimum failure duration seconds" type="number" min="0.1" max="60" step="0.1" value={minFailureSeconds} onChange={(event) => setMinFailureSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
      <label className="field"><span>Max outage</span><div className="input-wrap"><input aria-label="Maximum failure duration seconds" type="number" min="0.1" max="60" step="0.1" value={maxFailureSeconds} onChange={(event) => setMaxFailureSeconds(Number(event.target.value))}/><span className="input-suffix">sec</span></div></label>
      {!failureConfigValid && <div className="form-error" role="alert">Use a 0–100% chance and an outage range up to 60 seconds, with maximum at least minimum.</div>}
    </section>
    <div className="alb-metrics"><div className="alb-metric"><span>REGISTERED TARGETS</span><strong>{targets.length}</strong></div><div className="alb-metric"><span>HEALTHY TARGETS</span><strong>{healthyCount}<small> / {targets.length}</small></strong></div><div className="alb-metric"><span>CLIENT REQUESTS</span><strong>{requestCount}</strong></div><div className="alb-metric"><span>NEXT HEALTH CHECK</span><strong>{(timeToCheck / 1000).toFixed(1)}<small> sec</small></strong></div></div>
    <div className="alb-columns">
      <section className="panel alb-map">
        <div className="panel-heading"><div><div className="section-kicker">LISTENER → TARGET GROUP</div><h2>Request path</h2></div><span className="alb-live"><i/>ACTIVE</span></div>
        <div className="alb-route" ref={routeRef}><div className="alb-node client-node"><b>Client</b><span>HTTP request</span></div><div className="alb-link" aria-hidden="true"/><div className="alb-node lb-node"><b>Load<br/>Balancer</b><span>Listener rules</span></div><div className="alb-branches" aria-hidden="true"><span/><span/><span/></div><div className="alb-targets">
          {targets.map((target) => <article className={`alb-target ${target.healthy ? 'healthy' : 'unhealthy'}`} data-target-id={target.id} key={target.id}><div className="alb-target-info"><i className="health-led"/><b>Target T{target.id}</b><span>{target.healthy ? 'HEALTHY' : 'UNHEALTHY'}</span></div><div className="alb-target-details"><span>Requests <b>{target.requests}</b></span><span>In flight <b>{target.inFlight}</b></span><span>Health checks <b>{target.failureUntil > now ? `outage ${Math.max(0, target.failureUntil - now) / 1000 | 0}s` : target.serviceUp ? '200 OK' : `failed ${target.failures}/${THRESHOLD}`}</b></span></div><button className={`alb-fault ${target.serviceUp ? '' : 'recover'}`} onClick={() => toggleService(target.id)}>{target.serviceUp ? 'Simulate endpoint failure' : 'Restore endpoint'}</button></article>)}
        </div><svg ref={pulseSvgRef} className="alb-motion-layer" aria-hidden="true"><defs>{pulses.map((pulse) => <path data-pulse-path={pulse.id} d={pulse.path} key={pulse.id}/>)}</defs>{pulses.map((pulse) => <circle className={`alb-motion-dot ${pulse.kind}`} data-pulse-dot={pulse.id} key={pulse.id} r={pulse.kind === 'request' ? 6 : 3.5} cx="0" cy="0" opacity="0"/>)}</svg></div>
        <div className="alb-connection-legend"><span><i className="request-key"/>Client request · blue pulse appears on send</span><span><i className="health-key"/>Health check · green request and response pulses</span></div>
        <div className="alb-actions"><div className="alb-traffic-controls"><label className="rate-control"><span>Auto req/s</span><input aria-label="Automatic requests per second" type="number" min="0.1" max="20" step="0.1" value={requestsPerSecond} onChange={(event) => setRequestsPerSecond(Number(event.target.value))}/></label><button className="button button-primary" onClick={sendRequest} disabled={!(minSeconds > 0 && maxSeconds >= minSeconds && maxSeconds <= 60 && failureConfigValid)}>Send request</button><button className={autoTraffic ? 'button button-auto active' : 'button button-auto'} onClick={() => setAutoTraffic((active) => !active)} disabled={!((minSeconds > 0 && maxSeconds >= minSeconds && maxSeconds <= 60 && failureConfigValid) && (autoTraffic || (Number.isFinite(requestsPerSecond) && requestsPerSecond >= 0.1 && requestsPerSecond <= 20)))}>{autoTraffic ? 'Stop auto traffic' : 'Start auto traffic'}</button></div><p>{algorithm === 'round-robin' ? 'Each request goes to the next healthy target, regardless of current in-flight request counts.' : 'Each request goes to a healthy target with the fewest in-flight requests. Ties rotate for fairness.'} Simulate a health endpoint failure to see it leave the eligible pool after consecutive failed checks.</p></div>
      </section>
      <aside className="panel alb-trace"><div className="panel-heading"><div><div className="section-kicker">BACKGROUND & REQUEST EVENTS</div><h2>Routing activity</h2></div><span className="live-indicator"><span className="live-dot"/>LIVE</span></div><ol className="event-list">{events.map((event) => <li className={`event-item alb-event-${event.kind}`} key={event.id}><span className="event-marker"/><div className="event-content"><div className="event-text">{event.text}</div><time>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(event.id || Date.now())}</time></div></li>)}</ol></aside>
    </div>
    <section className="panel alb-learning"><div className="how-title"><div className="section-kicker">HOW THE ALGORITHM WORKS</div><h2>{algorithm === 'round-robin' ? 'Predictable distribution across eligible targets' : 'Balance based on current in-flight requests'}</h2><p>Both modes use the same target health and listener model; only the target selection rule changes.</p></div><div className="explain-cards alb-cards">
      <article className="explain-card"><span className="explain-number">01</span><div><h3>Health checks run independently</h3><p>ALB periodically sends a configured HTTP/HTTPS or gRPC health check to registered targets. Consecutive success/failure thresholds control healthy state. This is separate from client requests; it is not an idle/busy handshake.</p></div></article>
      <article className="explain-card"><span className="explain-number">02</span><div><h3>Listener rules pick a target group</h3><p>A listener evaluates rules such as host or path conditions, then forwards matching requests to a target group. Each target group has its own registered targets and health settings.</p></div></article>
      <article className="explain-card"><span className="explain-number">03</span><div><h3>{algorithm === 'round-robin' ? 'Rotate the selection' : 'Compare active request counts'}</h3><p>{algorithm === 'round-robin' ? 'Round robin rotates requests across healthy targets in sequence. It works well when requests and targets have similar cost and capacity.' : 'Least outstanding requests picks a healthy target with the fewest requests currently in progress. If several tie, this demo rotates among them.'} The balancer does not wait for a target to become idle.</p></div></article>
      <article className="explain-card"><span className="explain-number">04</span><div><h3>Unhealthy targets leave rotation</h3><p>When all targets are unhealthy, ALB can fail open and route to all of them. This demo shows that case explicitly. AWS ALB also supports stickiness and cross-zone routing options.</p></div></article>
      <article className="explain-card"><span className="explain-number">05</span><div><h3>Model temporary target outages</h3><p>Each healthy target gets an independent failure roll once per second. It leaves the eligible pool for a random configured duration, then recovers. Requests already in flight continue.</p></div></article>
    </div><div className="alb-sources"><span>Read more:</span><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html" target="_blank" rel="noreferrer">Target health checks</a><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html" target="_blank" rel="noreferrer">Routing algorithms</a><a href="https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html" target="_blank" rel="noreferrer">Target groups & health behavior</a></div></section>
    <footer className="footer"><span>{algorithm === 'round-robin' ? 'Round robin demo.' : 'Least outstanding requests demo.'}</span><span><span className="footer-dot"/>A local conceptual simulation, not connected to AWS</span></footer>
  </section>
}
