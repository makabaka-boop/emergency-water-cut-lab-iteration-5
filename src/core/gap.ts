import { PlanSolution } from './analyze'
import { findSinkIndex } from './interval'
import { FlowEdge, maxFlow } from './maxflow'
import { Network } from './types'

/**
 * 最小承诺缺口诊断。
 *
 * 在总送水量必须严格等于当前网络最大流 V 的前提下，从所有最大流方案中选择
 * Σ max(承诺_i − 实际_i, 0) 最小的一组方案，并返回该方案的完整流量见证。
 *
 * 不能把每个需求点的单独可达上限拼接为联合方案；这里所有点由同一次网络流
 * 同时决定。每个承诺点把需求边拆成两条平行边：
 *
 *  1. 承诺内边（容量 = 承诺值），第一段只加入这些需求边，求 S→T 最大流 P。
 *     P 是承诺内可同时送达的最大水量，故最小缺口 = Σ承诺 − P。
 *  2. 加入未承诺需求边与承诺点的「承诺外」平行边，以第一段流为初始流继续
 *     增广至 V。承诺内边的反向弧从 T 出发，不可能出现在 S→T 增广路中，
 *     因此 P 不会被后续补量挤占。
 *
 * 辅助边按 PlanEdge 顺序确定构建；相同输入由 Dinic 给出同一项最优裁决。
 */

export interface CommitmentGapEntry {
  /** 需求点在 network.sinks 中的下标。 */
  sinkIndex: number
  /** 最低供水量承诺：0..该需求点容量 的安全整数。 */
  minimum: number
}

export interface CommitmentGapAllocation {
  sinkNode: string
  committed: number | null
  actual: number
  gap: number
}

export interface CommitmentGapWitnessEdge {
  kind: 'arc' | 'source' | 'sink'
  id: string
  from: string
  to: string
  capacity: number
  flow: number
}

export interface CommitmentGapDiagnosis {
  total: number
  committedEntries: number
  committedTotal: number
  totalGap: number
  allocatedToCommitted: number
  allocations: CommitmentGapAllocation[]
  witness: CommitmentGapWitnessEdge[]
}

export type CommitmentGapResult =
  | ({ ok: true } & CommitmentGapDiagnosis)
  | { ok: false; reason: string }

interface AuxEdge extends FlowEdge {
  planIndex: number
}

function checkSound(solution: PlanSolution): string | null {
  const { analysis, edges, nodeCount, sinkEdgeIndex } = solution
  if (!Number.isSafeInteger(analysis.value) || analysis.value < 0) {
    return '当前方案总量不是非负安全整数'
  }
  if (!Array.isArray(edges) || nodeCount < 2) return '当前方案建模结构无效'
  for (const e of edges) {
    if (
      !Number.isInteger(e.from) ||
      !Number.isInteger(e.to) ||
      e.from < 0 ||
      e.to < 0 ||
      e.from >= nodeCount ||
      e.to >= nodeCount ||
      !Number.isSafeInteger(e.capacity) ||
      e.capacity < 0
    ) {
      return '当前方案存在非法建模边'
    }
  }
  if (!Array.isArray(sinkEdgeIndex)) return '当前方案需求边索引无效'
  return null
}

/**
 * 计算最小承诺缺口。entries 为空时返回当前最大流的一组完整见证，缺口为 0。
 * 任何输入/求解异常均返回 ok:false，不修改 solution，也不影响既有最大流结论。
 */
export function minimumCommitmentGap(
  network: Network,
  solution: PlanSolution,
  entries: readonly CommitmentGapEntry[],
): CommitmentGapResult {
  try {
    const soundError = checkSound(solution)
    if (soundError) return { ok: false, reason: soundError }
    if (!Array.isArray(entries)) return { ok: false, reason: '承诺列表无效' }

    const V = solution.analysis.value
    const requested = new Float64Array(solution.edges.length)
    const committedEdge = new Uint8Array(solution.edges.length)
    const seen = new Set<number>()
    let committedTotal = 0

    for (const entry of entries) {
      if (
        !entry ||
        !Number.isInteger(entry.sinkIndex) ||
        entry.sinkIndex < 0 ||
        !Number.isSafeInteger(entry.minimum) ||
        entry.minimum < 0
      ) {
        return { ok: false, reason: '存在无效的需求点或承诺数值' }
      }
      const edgeIndex = solution.sinkEdgeIndex[entry.sinkIndex]
      if (
        edgeIndex === undefined ||
        edgeIndex < 0 ||
        edgeIndex >= solution.edges.length ||
        solution.edges[edgeIndex].kind !== 'sink'
      ) {
        return { ok: false, reason: '承诺所指需求点在当前方案中不存在' }
      }
      if (seen.has(entry.sinkIndex)) {
        return { ok: false, reason: '同一需求点被重复承诺' }
      }
      seen.add(entry.sinkIndex)
      const edge = solution.edges[edgeIndex]
      if (entry.minimum > edge.capacity) {
        return {
          ok: false,
          reason: `需求点 "${edge.id}" 的承诺超过其容量 ${edge.capacity}`,
        }
      }
      committedEdge[edgeIndex] = 1
      requested[edgeIndex] = entry.minimum
      committedTotal += entry.minimum
    }

    // 第一段：仅保留承诺点的承诺内需求边，优先最大化承诺送达量 P。
    const priorityEdges: AuxEdge[] = []
    solution.edges.forEach((e, i) => {
      if (e.kind === 'sink') {
        if (!committedEdge[i]) return
        priorityEdges.push({
          from: e.from,
          to: e.to,
          capacity: requested[i],
          planIndex: i,
        })
        return
      }
      priorityEdges.push({ from: e.from, to: e.to, capacity: e.capacity, planIndex: i })
    })
    const first = maxFlow(
      solution.nodeCount,
      priorityEdges,
      solution.superSource,
      solution.superSink,
    )

    // 第二段：加入未承诺需求边与承诺外平行边，从第一段可行流继续补到 V。
    const fullEdges: AuxEdge[] = []
    const priorityFullIndex: number[] = []
    solution.edges.forEach((e, i) => {
      if (e.kind === 'sink' && committedEdge[i]) {
        priorityFullIndex.push(fullEdges.length)
        fullEdges.push({
          from: e.from,
          to: e.to,
          capacity: requested[i],
          planIndex: i,
        })
        const excess = e.capacity - requested[i]
        if (excess > 0) {
          fullEdges.push({ from: e.from, to: e.to, capacity: excess, planIndex: i })
        }
      } else {
        const fullIndex = fullEdges.length
        if (e.kind !== 'sink') priorityFullIndex.push(fullIndex)
        fullEdges.push({ from: e.from, to: e.to, capacity: e.capacity, planIndex: i })
      }
    })

    // 第一段边与第二段中的原始/承诺内边一一对应；承诺外平行边初始流量为 0。
    const initialFlow = new Float64Array(fullEdges.length)
    priorityEdges.forEach((_, i) => {
      initialFlow[priorityFullIndex[i]] = first.flow[i]
    })
    const second = maxFlow(
      solution.nodeCount,
      fullEdges,
      solution.superSource,
      solution.superSink,
      initialFlow,
    )

    if (!Number.isSafeInteger(second.value) || second.value !== V) {
      return { ok: false, reason: '诊断见证未达到当前网络最大供水量' }
    }

    // 平行边合并回输入需求边身份。
    const finalFlow = new Float64Array(solution.edges.length)
    fullEdges.forEach((e, i) => {
      finalFlow[e.planIndex] += second.flow[i]
    })

    let allocatedToCommitted = 0
    let totalGap = 0
    const allocations: CommitmentGapAllocation[] = solution.sinkEdgeIndex.map(
      (edgeIndex) => {
        const edge = solution.edges[edgeIndex]
        const actual = finalFlow[edgeIndex]
        const committed = committedEdge[edgeIndex] ? requested[edgeIndex] : null
        const gap = committed === null ? 0 : Math.max(0, committed - actual)
        if (committed !== null) {
          allocatedToCommitted += Math.min(actual, committed)
          totalGap += gap
        }
        return { sinkNode: edge.id, committed, actual, gap }
      },
    )

    if (
      !Number.isSafeInteger(committedTotal) ||
      !Number.isSafeInteger(allocatedToCommitted) ||
      !Number.isSafeInteger(totalGap) ||
      totalGap < 0 ||
      allocatedToCommitted !== first.value
    ) {
      return { ok: false, reason: '最小承诺缺口计算结果无效' }
    }

    const nodeName = new Map<number, string>()
    network.nodes.forEach((node, i) => nodeName.set(i, node.id))
    const witness: CommitmentGapWitnessEdge[] = solution.edges.map((edge, i) => ({
      kind: edge.kind,
      id: edge.id,
      from: nodeName.get(edge.from) ?? '__super_source__',
      to: nodeName.get(edge.to) ?? '__super_sink__',
      capacity: edge.capacity,
      flow: finalFlow[i],
    }))

    return {
      ok: true,
      total: V,
      committedEntries: entries.length,
      committedTotal,
      totalGap,
      allocatedToCommitted,
      allocations,
      witness,
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 按需求点节点 id 诊断的便捷封装。 */
export function minimumCommitmentGapByNode(
  network: Network,
  solution: PlanSolution,
  entries: ReadonlyArray<{ node: string; minimum: number }>,
): CommitmentGapResult {
  if (!Array.isArray(entries)) return { ok: false, reason: '承诺列表无效' }
  const indexed: CommitmentGapEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.node !== 'string') {
      return { ok: false, reason: '存在无效的需求点或承诺数值' }
    }
    const idx = findSinkIndex(solution, entry.node)
    if (idx < 0) return { ok: false, reason: `需求点 "${entry.node}" 不属于当前模型` }
    indexed.push({ sinkIndex: idx, minimum: entry.minimum })
  }
  return minimumCommitmentGap(network, solution, indexed)
}
