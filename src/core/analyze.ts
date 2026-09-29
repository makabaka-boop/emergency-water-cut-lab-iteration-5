import { Analysis, CutItem, CutKind, Network } from './types'
import { FlowEdge, maxFlow, MaxFlowResult } from './maxflow'

const KIND_ORDER: Record<CutKind, number> = { source: 0, arc: 1, sink: 2 }

/** UTF-16 编码单元升序（即 JavaScript 字符串默认 < 比较）。 */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareCutItems(a: CutItem, b: CutItem): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareUtf16(a.id, b.id)
  )
}

/** 送入 Dinic 的建模边类别（与输入边身份一一对应，含零容量边）。 */
export type PlanEdgeKind = 'arc' | 'source' | 'sink'

export interface PlanEdge {
  kind: PlanEdgeKind
  /** 管段取管段 id；供水点/需求点取节点 id。 */
  id: string
  from: number
  to: number
  capacity: number
}

/**
 * 一次完整方案解：核算结果 + 建模边身份与其流量/残量。
 * 最大流层按输入边身份提供该组解的正反残量容量（flow / residual），
 * 供避难点供水区间的辅助网络独立核算使用。
 */
export interface PlanSolution {
  analysis: Analysis
  edges: PlanEdge[]
  nodeCount: number
  superSource: number
  superSink: number
  /** 与 edges 同序：当前方案分配到每条建模边的流量。 */
  flow: Float64Array
  /** 与 edges 同序：正向残量（capacity - flow）；反向残量即 flow。 */
  residual: Float64Array
  /** 需求点在 network.sinks 中的下标 → 建模边下标。 */
  sinkEdgeIndex: number[]
}

/**
 * 对给定断管方案建模并求一次最大流：
 *  1. 建模：超级源 → 各供水点（容量=供水能力），原管段（停用管段移除），
 *     各需求点 → 超级汇（容量=需求能力）；
 *  2. 求最大流，即当前最大供水量；
 *  3. 在残量网络中从超级源遍历，源侧可达集到汇侧不可达集的
 *     「供水点 / 管段 / 需求点」边即为割项；
 *  4. 割项按 类别（供水点→管段→需求点）、id UTF-16 升序 排列。
 *
 * 同一输入必得同一输出（算法与排序均确定），因此清空方案后
 * 重算结果与基线逐项相等。
 */
export function solvePlan(
  network: Network,
  disabled: ReadonlySet<string>,
): PlanSolution {
  const n = network.nodes.length
  const index = new Map<string, number>()
  network.nodes.forEach((node, i) => index.set(node.id, i))

  const SUPER_SOURCE = n
  const SUPER_SINK = n + 1

  const edges: PlanEdge[] = []
  const rawEdges: FlowEdge[] = []
  const arcEdgeIndex: number[] = [] // 每条管段对应的边下标，停用为 -1
  network.arcs.forEach((arc) => {
    if (disabled.has(arc.id)) {
      arcEdgeIndex.push(-1)
      return
    }
    arcEdgeIndex.push(edges.length)
    edges.push({
      kind: 'arc',
      id: arc.id,
      from: index.get(arc.from)!,
      to: index.get(arc.to)!,
      capacity: arc.capacity,
    })
    rawEdges.push({
      from: index.get(arc.from)!,
      to: index.get(arc.to)!,
      capacity: arc.capacity,
    })
  })
  network.sources.forEach((s) => {
    edges.push({
      kind: 'source',
      id: s.node,
      from: SUPER_SOURCE,
      to: index.get(s.node)!,
      capacity: s.capacity,
    })
    rawEdges.push({ from: SUPER_SOURCE, to: index.get(s.node)!, capacity: s.capacity })
  })
  const sinkEdgeIndex: number[] = []
  network.sinks.forEach((k) => {
    sinkEdgeIndex.push(edges.length)
    edges.push({
      kind: 'sink',
      id: k.node,
      from: index.get(k.node)!,
      to: SUPER_SINK,
      capacity: k.capacity,
    })
    rawEdges.push({ from: index.get(k.node)!, to: SUPER_SINK, capacity: k.capacity })
  })

  const result: MaxFlowResult = maxFlow(n + 2, rawEdges, SUPER_SOURCE, SUPER_SINK)
  const { value, flow, residual, reachable } = result

  // 割项 = 从源侧可达集指向汇侧不可达集的建模边（残量必为 0）。
  const cut: CutItem[] = []
  network.sources.forEach((s) => {
    if (!reachable[index.get(s.node)!]) {
      cut.push({ kind: 'source', id: s.node, capacity: s.capacity })
    }
  })
  network.arcs.forEach((arc, i) => {
    if (arcEdgeIndex[i] === -1) return // 已停用的管段不属于当前网络
    const fromReachable = reachable[index.get(arc.from)!]
    const toReachable = reachable[index.get(arc.to)!]
    if (fromReachable && !toReachable) {
      cut.push({
        kind: 'arc',
        id: arc.id,
        from: arc.from,
        to: arc.to,
        capacity: arc.capacity,
      })
    }
  })
  network.sinks.forEach((k) => {
    if (reachable[index.get(k.node)!]) {
      cut.push({ kind: 'sink', id: k.node, capacity: k.capacity })
    }
  })
  cut.sort(compareCutItems)

  const disabledSorted = Array.from(disabled).sort(compareUtf16)
  return {
    analysis: { value, cut, disabled: disabledSorted },
    edges,
    nodeCount: n + 2,
    superSource: SUPER_SOURCE,
    superSink: SUPER_SINK,
    flow,
    residual,
    sinkEdgeIndex,
  }
}

/**
 * 对给定断管方案做一次完整核算，仅返回 Analysis（输入输出向后兼容）。
 */
export function analyze(
  network: Network,
  disabled: ReadonlySet<string>,
): Analysis {
  return solvePlan(network, disabled).analysis
}

/** 相对损失 = (基线 - 当前) / 基线；基线为 0 时约定为 0（此时当前必为 0）。 */
export function relativeLoss(baseline: number, current: number): number {
  return baseline > 0 ? (baseline - current) / baseline : 0
}
