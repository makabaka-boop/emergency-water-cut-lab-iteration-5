import { expect } from 'vitest'
import { compareCutItems } from '../src/core/analyze'
import { FlowEdge, maxFlow } from '../src/core/maxflow'
import { CutItem, Network } from '../src/core/types'

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 随机小网络：2..8 节点、0..14 条管段、1..3 个供水/需求点，
 * 容量 0..20（含零容量），天然覆盖重边、反向边、自环与多源多汇。
 */
export function randomNetwork(rng: () => number): Network {
  const nodeCount = 2 + Math.floor(rng() * 7)
  const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
  const pick = () => ids[Math.floor(rng() * nodeCount)]
  const arcCount = Math.floor(rng() * 15)
  const arcs = Array.from({ length: arcCount }, (_, i) => ({
    id: `a${i}`,
    from: pick(),
    to: pick(),
    capacity: Math.floor(rng() * 21),
  }))
  const shuffled = [...ids]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = t
  }
  const srcCount = 1 + Math.floor(rng() * Math.min(3, nodeCount))
  const snkCount = 1 + Math.floor(rng() * Math.min(3, nodeCount))
  const sources = shuffled
    .slice(0, srcCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 21) }))
  const sinks = shuffled
    .slice(nodeCount - snkCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 21) }))
  return { nodes: ids.map((id) => ({ id })), arcs, sources, sinks }
}

export function randomDisabled(net: Network, rng: () => number): Set<string> {
  const s = new Set<string>()
  net.arcs.forEach((a) => {
    if (rng() < 0.3) s.add(a.id)
  })
  return s
}

/**
 * 枚举小整数网络的全部可行流。
 *
 * 做法：枚举每条在用管段的整数流量（0..capacity，自环/重边/反向边各自独立），
 * 再由节点守恒逐节点解析供水边/需求边流量是否落在各自容量内；
 * 同一节点兼作供水点与需求点时，其需求流量在守恒允许的整数区间内逐一枚举。
 * 返回所有可行点（按 network.sinks 顺序的各需求边流量 + 总供水量）。
 *
 * 仅适用于 ≤4 节点、≤5 管段、容量 0..3 的小网络（枚举上界 4^5 × 5^2）。
 */
export interface FeasiblePoint {
  sinkY: number[]
  total: number
}

export function enumerateFeasibleFlows(
  net: Network,
  disabled: ReadonlySet<string>,
): FeasiblePoint[] {
  const n = net.nodes.length
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const arcs = net.arcs
    .filter((a) => !disabled.has(a.id))
    .map((a) => ({ from: idx.get(a.from)!, to: idx.get(a.to)!, cap: a.capacity }))
  const sourceCap = new Int32Array(n)
  const sinkCap = new Int32Array(n)
  net.sources.forEach((s) => {
    sourceCap[idx.get(s.node)!] = s.capacity
  })
  net.sinks.forEach((k) => {
    sinkCap[idx.get(k.node)!] = k.capacity
  })
  const sourceNodes = new Set(net.sources.map((s) => idx.get(s.node)!))
  const sinkNodes = new Set(net.sinks.map((k) => idx.get(k.node)!))

  const points: FeasiblePoint[] = []
  const flows = new Int32Array(arcs.length)

  // 既是供水点又是需求点的节点：B=管段净入流，a(供水)-b(需求)=-B，
  // b=a+B，枚举 a∈[0,sc] 且 b∈[0,kc] 的所有整数 b。
  const bothChoicesAt = (B: number, v: number): number[] => {
    const sc = sourceCap[v]
    const kc = sinkCap[v]
    const bLo = Math.max(0, B)
    const bHi = Math.min(kc, sc + B)
    const out: number[] = []
    for (let b = bLo; b <= bHi; b++) out.push(b)
    return out
  }

  const leaf = () => {
    const B = new Int32Array(n) // 管段净入流
    arcs.forEach((a, i) => {
      B[a.to] += flows[i]
      B[a.from] -= flows[i]
    })

    let feasible = true
    const sinkB = new Int32Array(n) // 各节点最终需求流量
    const bothNodes: number[] = []
    const bothChoices: number[][] = []
    for (let v = 0; v < n; v++) {
      const asSource = sourceNodes.has(v)
      const asSink = sinkNodes.has(v)
      if (!asSource && !asSink) {
        if (B[v] !== 0) {
          feasible = false
          break
        }
      } else if (asSource && !asSink) {
        const a = -B[v]
        if (a < 0 || a > sourceCap[v]) {
          feasible = false
          break
        }
      } else if (!asSource && asSink) {
        const b = B[v]
        if (b < 0 || b > sinkCap[v]) {
          feasible = false
          break
        }
        sinkB[v] = b
      } else {
        const choices = bothChoicesAt(B[v], v)
        if (choices.length === 0) {
          feasible = false
          break
        }
        bothNodes.push(v)
        bothChoices.push(choices)
      }
    }
    if (!feasible) return

    const emit = () => {
      const sinkY = net.sinks.map((k) => sinkB[idx.get(k.node)!])
      const total = sinkY.reduce((s, y) => s + y, 0)
      points.push({ sinkY, total })
    }

    if (bothNodes.length === 0) {
      emit()
      return
    }
    const enumBoth = (d: number) => {
      if (d === bothNodes.length) {
        emit()
        return
      }
      for (const b of bothChoices[d]) {
        sinkB[bothNodes[d]] = b
        enumBoth(d + 1)
      }
    }
    enumBoth(0)
  }

  const dfs = (i: number) => {
    if (i === arcs.length) {
      leaf()
      return
    }
    for (let f = 0; f <= arcs[i].cap; f++) {
      flows[i] = f
      dfs(i + 1)
    }
  }
  dfs(0)
  return points
}

/** 区间/承诺专用小整数网络：2..4 节点、1..5 管段（容量 0..3）、1..2 个供水/需求点。 */
export function smallIntervalNetwork(rng: () => number): Network {
  const nodeCount = 2 + Math.floor(rng() * 3) // 2..4
  const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
  const pick = () => ids[Math.floor(rng() * nodeCount)]
  const arcCount = 1 + Math.floor(rng() * 5) // 1..5
  const arcs = Array.from({ length: arcCount }, (_, i) => ({
    id: `a${i}`,
    from: pick(),
    to: pick(),
    capacity: Math.floor(rng() * 4), // 0..3
  }))
  const shuffled = [...ids]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const srcCount = 1 + Math.floor(rng() * Math.min(2, nodeCount))
  const snkCount = 1 + Math.floor(rng() * Math.min(2, nodeCount))
  const sources = shuffled
    .slice(0, srcCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 5) }))
  const sinks = shuffled
    .slice(nodeCount - snkCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 5) }))
  return { nodes: ids.map((id) => ({ id })), arcs, sources, sinks }
}

/**
 * 10000 节点 / 50000 管段的层状网络（与 maxflow.test.ts 同一确定性构造，
 * 抽到 helpers 以便性能用例复用）：99×100×5 条层间前向边 + 250 条反向边
 * + 250 条重边，首末层各 100 个供水/需求点。
 */
export function buildLargeNetwork(): Network {
  const rng = mulberry32(42)
  const LAYERS = 100
  const PER = 100
  const nodes: { id: string }[] = []
  for (let l = 0; l < LAYERS; l++) {
    for (let i = 0; i < PER; i++) nodes.push({ id: `L${l}N${i}` })
  }
  const arcs: Network['arcs'] = []
  let counter = 0
  const randCap = () => Math.floor(rng() * 1_000_000_000)
  for (let l = 0; l < LAYERS - 1; l++) {
    for (let i = 0; i < PER; i++) {
      for (let k = 0; k < 5; k++) {
        const j = Math.floor(rng() * PER)
        arcs.push({
          id: `a${counter++}`,
          from: `L${l}N${i}`,
          to: `L${l + 1}N${j}`,
          capacity: randCap(),
        })
      }
    }
  }
  for (let i = 0; i < 250; i++) {
    const l = Math.floor(rng() * (LAYERS - 1))
    arcs.push({
      id: `a${counter++}`,
      from: `L${l + 1}N${Math.floor(rng() * PER)}`,
      to: `L${l}N${Math.floor(rng() * PER)}`,
      capacity: randCap(),
    })
  }
  for (let i = 0; i < 250; i++) {
    const l = Math.floor(rng() * (LAYERS - 1))
    const u = Math.floor(rng() * PER)
    arcs.push({
      id: `a${counter++}`,
      from: `L${l}N${u}`,
      to: `L${l + 1}N${u}`,
      capacity: randCap(),
    })
  }
  const sources: Network['sources'] = []
  const sinks: Network['sinks'] = []
  for (let i = 0; i < PER; i++) {
    sources.push({ node: `L0N${i}`, capacity: 1_000_000_000 })
    sinks.push({ node: `L${LAYERS - 1}N${i}`, capacity: 1_000_000_000 })
  }
  return { nodes, arcs, sources, sinks }
}

/**
 * 穷举所有源侧/汇侧二分，直接求最小割容量（与任何最大流实现无关）。
 * 仅适用于节点数 ≤ 12 的小图。
 */
export function bruteForceMinCut(
  net: Network,
  disabled: ReadonlySet<string>,
): number {
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const n = net.nodes.length
  let best = Infinity
  for (let mask = 0; mask < 1 << n; mask++) {
    const inS = (id: string) => ((mask >> idx.get(id)!) & 1) === 1
    let cap = 0
    for (const s of net.sources) if (!inS(s.node)) cap += s.capacity
    for (const k of net.sinks) if (inS(k.node)) cap += k.capacity
    for (const a of net.arcs) {
      if (disabled.has(a.id)) continue
      if (inS(a.from) && !inS(a.to)) cap += a.capacity
    }
    if (cap < best) best = cap
  }
  return best
}

export interface IndependentResult {
  value: number
  cut: CutItem[]
}

/**
 * 独立复核：
 *  1. 按契约建模并调用 maxFlow；
 *  2. 校验所得流量的可行性（容量约束、节点守恒、源汇平衡）；
 *  3. 由流量（而非 maxFlow 内部状态）重建残量网络，遍历得到割项。
 */
export function independentSolve(
  net: Network,
  disabled: ReadonlySet<string>,
): IndependentResult {
  const n = net.nodes.length
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const S = n
  const T = n + 1
  const edges: FlowEdge[] = []
  const arcEdgeIdx: number[] = []
  net.arcs.forEach((a) => {
    if (disabled.has(a.id)) {
      arcEdgeIdx.push(-1)
    } else {
      arcEdgeIdx.push(edges.length)
      edges.push({
        from: idx.get(a.from)!,
        to: idx.get(a.to)!,
        capacity: a.capacity,
      })
    }
  })
  net.sources.forEach((s) => {
    edges.push({ from: S, to: idx.get(s.node)!, capacity: s.capacity })
  })
  net.sinks.forEach((k) => {
    edges.push({ from: idx.get(k.node)!, to: T, capacity: k.capacity })
  })

  const res = maxFlow(n + 2, edges, S, T)

  // 流量可行性校验。
  const balance = new Float64Array(n + 2)
  edges.forEach((e, i) => {
    const f = res.flow[i]
    expect(Number.isSafeInteger(f)).toBe(true)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeLessThanOrEqual(e.capacity)
    balance[e.from] -= f
    balance[e.to] += f
  })
  for (let v = 0; v < n; v++) expect(balance[v]).toBe(0)
  expect(balance[S]).toBe(0 - res.value)
  expect(balance[T]).toBe(res.value)

  // 由流量独立重建残量网络并求源侧可达集。
  const adj: number[][] = Array.from({ length: n + 2 }, () => [])
  edges.forEach((e, i) => {
    const f = res.flow[i]
    if (e.capacity - f > 0) adj[e.from].push(e.to)
    if (f > 0) adj[e.to].push(e.from)
  })
  const reach = new Array<boolean>(n + 2).fill(false)
  const stack = [S]
  reach[S] = true
  while (stack.length > 0) {
    const v = stack.pop()!
    for (const w of adj[v]) {
      if (!reach[w]) {
        reach[w] = true
        stack.push(w)
      }
    }
  }

  const cut: CutItem[] = []
  net.sources.forEach((s) => {
    if (!reach[idx.get(s.node)!]) {
      cut.push({ kind: 'source', id: s.node, capacity: s.capacity })
    }
  })
  net.arcs.forEach((a, i) => {
    if (arcEdgeIdx[i] === -1) return
    if (reach[idx.get(a.from)!] && !reach[idx.get(a.to)!]) {
      cut.push({
        kind: 'arc',
        id: a.id,
        from: a.from,
        to: a.to,
        capacity: a.capacity,
      })
    }
  })
  net.sinks.forEach((k) => {
    if (reach[idx.get(k.node)!]) {
      cut.push({ kind: 'sink', id: k.node, capacity: k.capacity })
    }
  })
  cut.sort(compareCutItems)
  return { value: res.value, cut }
}
