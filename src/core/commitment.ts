import { PlanSolution } from './analyze'
import { findSinkIndex } from './interval'
import { FlowEdge, maxFlow } from './maxflow'
import { JointCommitment } from './types'

/**
 * 联合最低供水承诺（多需求点下限能否在「同一组边流量」上同时兑现）。
 *
 * 裁决针对 solvePlan 给出的同一组建模边（停用管段已移除；重边、原生反向边、
 * 自环、零容量边及同点供需均按 PlanEdge 的输入身份各自独立参与），判定条件：
 *
 *   1. 每条边流量满足 0 ≤ f_e ≤ c_e（容量约束）；
 *   2. 原网络节点（不含超级源 S / 超级汇 T）净入流为 0（节点守恒）；
 *   3. 超级源到超级汇的总量严格等于当前 analysis.value（V）；
 *   4. 每个被承诺需求点的需求边流量 ≥ 其填写下限。
 *
 * 不能用单点区间拼接（各点区间只覆盖「单独固定该点」的边际可达性），也不能
 * 只比较承诺总和与总量（共享管段等局部瓶颈会在总和不超限时否决）。
 *
 * 下界环流构造（标准带下界可行流变换）：
 *  - 给每条建模边 e 置下界 l_e（承诺需求边取下限，其余为 0），上界仍为 c_e；
 *  - 另加一条 T → S 的「汇到源回边」，下界与上界都固定为 V，
 *    于是任何可行环流中 S→T 的总量被严格锁定为 V（条件 3）；
 *  - 下界本身按 b[v] = Σ(入边下界) − Σ(出边下界) 折算为节点失衡：
 *    b[v] > 0（下界净入超）→ 辅助源 SS → v 容量 b[v]；
 *    b[v] < 0（下界净出超）→ v → 辅助汇 TT 容量 −b[v]；
 *    其余边以剩余容量 c_e − l_e 加入辅助网络；
 *  - 求 SS → TT 的最大流。Σb ≡ 0（回边也计入），故辅助源总供给恒等于
 *    辅助汇总需求；当且仅当全部 SS 出边饱和（最大流值 = 总供给）时，
 *    存在把所有下界同时补齐的剩余流，即全部下限可同时兑现。
 *
 * 与单点区间的残量环流不同：本辅助网络以「原始容量 − 下界」直接构造，
 * 不依赖某一组当前分配；它检验的是同一个可行流多面体中的联合可行点。
 */

export interface CommitmentEntry {
  /** 需求点在 network.sinks 中的下标。 */
  sinkIndex: number
  /** 最低供水量：0..该需求点容量 的整数。 */
  minimum: number
}

export interface CommitmentFailure {
  ok: false
  /** 失败原因（非空字符串）：无效填写或辅助求解异常，调用方据此清除裁决并就地提示。 */
  reason: string
}

export type CommitmentResult =
  | ({ ok: true } & JointCommitment)
  | CommitmentFailure

/** 方案/参数健全性：方案结构或总量异常时按辅助求解失败处理，绝不抛出。 */
function checkSound(solution: PlanSolution): string | null {
  const { analysis, edges, nodeCount, sinkEdgeIndex } = solution
  if (!Number.isSafeInteger(analysis.value) || analysis.value < 0) {
    return '当前方案总量不是非负安全整数'
  }
  if (!Array.isArray(edges) || nodeCount < 2) {
    return '当前方案建模结构无效'
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]
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
 * 对当前方案做一次联合裁决。
 * entries 为空（全部留空）时裁决自然可行（无任何下限，回边锁定总量 V，
 * 当前最大流本身即见证）。无效填写返回 ok:false 且不抛出。
 */
export function jointCommitment(
  solution: PlanSolution,
  entries: readonly CommitmentEntry[],
): CommitmentResult {
  try {
    const soundError = checkSound(solution)
    if (soundError) return { ok: false, reason: soundError }
    if (!Array.isArray(entries)) {
      return { ok: false, reason: '承诺列表无效' }
    }

    const { edges, nodeCount, sinkEdgeIndex } = solution
    const V = solution.analysis.value

    // 校验每条承诺：下标有效、不重复、值为 0..该需求点容量 的安全整数。
    const lower = new Float64Array(edges.length)
    const seen = new Set<number>()
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
      const edgeIndex = sinkEdgeIndex[entry.sinkIndex]
      if (
        edgeIndex === undefined ||
        edgeIndex < 0 ||
        edgeIndex >= edges.length ||
        edges[edgeIndex].kind !== 'sink'
      ) {
        return { ok: false, reason: '承诺所指需求点在当前方案中不存在' }
      }
      if (seen.has(entry.sinkIndex)) {
        return { ok: false, reason: '同一需求点被重复承诺' }
      }
      seen.add(entry.sinkIndex)
      const capacity = edges[edgeIndex].capacity
      if (entry.minimum > capacity) {
        return {
          ok: false,
          reason: `需求点 "${edges[edgeIndex].id}" 的承诺超过其容量 ${capacity}`,
        }
      }
      lower[edgeIndex] = entry.minimum
    }

    // 节点失衡（下界净入流）。回边 T→S 的下界=上界=V：
    // 不加入辅助边（剩余容量为 0），只把其下界计入 S / T 的失衡。
    const balance = new Float64Array(nodeCount)
    const { superSource: S, superSink: T } = solution
    balance[S] += V
    balance[T] -= V
    for (let i = 0; i < edges.length; i++) {
      const l = lower[i]
      if (l === 0) continue
      const e = edges[i]
      balance[e.to] += l
      balance[e.from] -= l
    }

    // 辅助网络：剩余容量边 + SS/TT 失衡边。
    const aux: FlowEdge[] = []
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      const rest = e.capacity - lower[i]
      if (rest > 0) aux.push({ from: e.from, to: e.to, capacity: rest })
    }
    const SS = nodeCount
    const TT = nodeCount + 1
    let required = 0
    for (let v = 0; v < nodeCount; v++) {
      const b = balance[v]
      if (b > 0) {
        aux.push({ from: SS, to: v, capacity: b })
        required += b
      } else if (b < 0) {
        aux.push({ from: v, to: TT, capacity: -b })
      }
    }

    const result = maxFlow(nodeCount + 2, aux, SS, TT)
    if (!Number.isSafeInteger(result.value)) {
      return { ok: false, reason: '辅助最大流返回非整数结果' }
    }

    // 全部失衡必须饱和（Σb ≡ 0 保证供给与需求总量相等）。
    if (result.value !== required) {
      return {
        ok: false,
        reason: 'joint-lower-bounds-infeasible',
      }
    }

    return { ok: true, total: V, committed: entries.length }
  } catch (err) {
    // 辅助求解异常隔离：不抛出，交调用方清除裁决并就地提示。
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 按需求点节点 id 填写承诺的便捷封装（id 不属于当前方案需求点时失败）。 */
export function jointCommitmentByNode(
  solution: PlanSolution,
  entries: ReadonlyArray<{ node: string; minimum: number }>,
): CommitmentResult {
  if (!Array.isArray(entries)) {
    return { ok: false, reason: '承诺列表无效' }
  }
  const indexed: CommitmentEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.node !== 'string') {
      return { ok: false, reason: '存在无效的需求点或承诺数值' }
    }
    const idx = findSinkIndex(solution, entry.node)
    if (idx < 0) {
      return { ok: false, reason: `需求点 "${entry.node}" 不属于当前模型` }
    }
    indexed.push({ sinkIndex: idx, minimum: entry.minimum })
  }
  return jointCommitment(solution, indexed)
}
