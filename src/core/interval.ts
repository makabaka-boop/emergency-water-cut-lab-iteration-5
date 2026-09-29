import { PlanSolution } from './analyze'
import { FlowEdge, maxFlow } from './maxflow'
import { SinkInterval } from './types'

/**
 * 避难点供水区间（保持当前最大供水总量不变时，单个需求点的可获水量范围）。
 *
 * 原理：设 Dinic 当前解为 f（总值 V），任意同值可行最大流 f' 与 f 之差
 * 是当前残量网络中的一个环流（每个节点净入流为 0）。对目标需求边
 * e = (v → T)（流量 f_e，容量 c_e，正残量 c_e - f_e，反残量 f_e）：
 *
 *  - 上调：沿残量路 T → v 推 g，再走 e 的反残量弧 v → T 闭合环流，
 *    e 的流量增加 g。辅助网络中 e 的正/反残量弧都必须排除（环流的闭合
 *    正是要单独计量的那段），故 up = min(c_e - f_e, maxflow(T → v))；
 *  - 下调：沿残量路 v → T 推 g，与 e 的正残量弧 T → v 闭合环流，
 *    e 的流量减少 g，down = min(f_e, maxflow(v → T))。
 *
 * 端点由最大流（整数容量、整数增广）给出，因此 min / max 都是整数且
 * 可实现：叠加对应环流即得到一组容量、节点守恒、总值均不变的新分配。
 *
 * 重边、原生反向边、自环、零容量边均按各输入边独立加入残量（每条边
 * 独立一对弧），同一节点兼作供水点与需求点时其供水/需求边同样各自独立。
 */

export interface IntervalFailure {
  ok: false
  /** 失败原因（非空字符串），调用方就地提示并清除旧区间。 */
  reason: string
}

export type IntervalResult =
  | ({ ok: true } & SinkInterval)
  | IntervalFailure

/**
 * 构建辅助残量网络：按输入边身份为每条建模边加入
 * 正残量弧（from→to，容量 residual）与反残量弧（to→from，容量 flow）；
 * 零容量残量自然跳过。目标需求边自身的两条残量弧一律排除。
 */
function buildAuxEdges(solution: PlanSolution, targetEdge: number): FlowEdge[] {
  const aux: FlowEdge[] = []
  const { edges, flow, residual } = solution
  for (let i = 0; i < edges.length; i++) {
    if (i === targetEdge) continue
    const e = edges[i]
    const r = residual[i]
    const b = flow[i]
    if (r > 0) aux.push({ from: e.from, to: e.to, capacity: r })
    if (b > 0) aux.push({ from: e.to, to: e.from, capacity: b })
  }
  return aux
}

/**
 * 对方案中的一个需求点（按 network.sinks 下标）求供水区间。
 * sinkIndex 越界或不指向需求边时返回失败结果，由调用方清除旧区间并提示。
 */
export function sinkInterval(
  solution: PlanSolution,
  sinkIndex: number,
): IntervalResult {
  if (!Number.isInteger(sinkIndex) || sinkIndex < 0) {
    return { ok: false, reason: '需求点下标无效' }
  }
  const targetEdge = solution.sinkEdgeIndex[sinkIndex]
  if (targetEdge === undefined) {
    return { ok: false, reason: '所选需求点在当前方案中不存在' }
  }

  const target = solution.edges[targetEdge]
  const current = solution.flow[targetEdge]
  const headroom = solution.residual[targetEdge] // c_e - f_e ≥ 0

  // 健全性：当前解自身不得突破容量或守恒前提。
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(headroom) ||
    current < 0 ||
    headroom < 0 ||
    current + headroom !== target.capacity
  ) {
    return { ok: false, reason: '当前方案流量与残量不满足容量约束' }
  }

  const aux = buildAuxEdges(solution, targetEdge)
  const { nodeCount, superSink: T } = solution

  // 增加目标边流量：辅助网中 T → v 的可调流。
  const upFlow = maxFlow(nodeCount, aux, T, target.from)
  // 减少目标边流量：辅助网中 v → T 的可调流。
  const downFlow = maxFlow(nodeCount, aux, target.from, T)

  // 区间端点不能突破容量（headroom / current）或当前总值（环流构造保证守恒）。
  const increase = Math.min(headroom, upFlow.value)
  const decrease = Math.min(current, downFlow.value)

  return {
    ok: true,
    sinkNode: target.id,
    current,
    min: current - decrease,
    max: current + increase,
    total: solution.analysis.value,
  }
}

/** 按需求点节点 id 查询的便捷封装（id 不属于当前方案需求点时失败）。 */
export function sinkIntervalByNode(
  solution: PlanSolution,
  nodeId: string,
): IntervalResult {
  const idx = findSinkIndex(solution, nodeId)
  if (idx < 0) {
    return { ok: false, reason: `需求点 "${nodeId}" 不属于当前模型` }
  }
  return sinkInterval(solution, idx)
}

/** 方案需求边中节点 id 的下标；不存在返回 -1。 */
export function findSinkIndex(solution: PlanSolution, nodeId: string): number {
  for (let i = 0; i < solution.sinkEdgeIndex.length; i++) {
    if (solution.edges[solution.sinkEdgeIndex[i]].id === nodeId) return i
  }
  return -1
}
