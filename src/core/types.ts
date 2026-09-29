/**
 * 输入网络的数据契约（与 README「输入契约」一节一一对应）。
 * 所有容量均为 0..10^12 的整数（安全整数范围内用 number 精确表示）。
 */

export interface NodeItem {
  id: string
}

export interface ArcItem {
  id: string
  from: string
  to: string
  capacity: number
}

/** 供水点（sources）与需求点（sinks）共用结构。 */
export interface BoundaryItem {
  node: string
  capacity: number
}

export interface Network {
  nodes: NodeItem[]
  arcs: ArcItem[]
  sources: BoundaryItem[]
  sinks: BoundaryItem[]
}

/** 割项类别：供水点 / 管段 / 需求点。 */
export type CutKind = 'source' | 'arc' | 'sink'

export interface CutItem {
  kind: CutKind
  /** 供水点/需求点取节点 id，管段取管段 id。 */
  id: string
  capacity: number
  /** 仅管段割项携带起终点，便于复核。 */
  from?: string
  to?: string
}

/** 一次核算（基线或某个断管方案）的完整结果。 */
export interface Analysis {
  /** 最大供水量（最大流值）。 */
  value: number
  /** 残量网络中源侧到汇侧的割项，按 类别(供水点→管段→需求点)、id UTF-16 升序 排列。 */
  cut: CutItem[]
  /** 本方案停用的管段 id，UTF-16 升序。 */
  disabled: string[]
}

/** 载入成功后的模型：网络 + 基线核算。 */
export interface Model {
  network: Network
  baseline: Analysis
}

/**
 * 避难点供水区间：在当前最大供水总量不变的前提下，指定需求边
 * （某需求点 → 超级汇）在所有可行最大流分配中的可获水量范围。
 *
 * current 只是 Dinic 求出的「一组」可行分配，并非唯一答案；
 * min / max 为严格保持当前 analysis.value 时该需求边流量的可达端点。
 */
export interface SinkInterval {
  /** 需求点节点 id。 */
  sinkNode: string
  /** 当前 Dinic 方案中该需求边的流量（一组可行分配）。 */
  current: number
  /** 最小值（保持总值 = 当前 analysis.value，容量与节点守恒均成立时可达）。 */
  min: number
  /** 最大值（同上可达）。 */
  max: number
  /** 当前最大供水总量（= 区间所约束的总值，便于复核）。 */
  total: number
}

export const INVALID_NETWORK = 'INVALID_NETWORK' as const

/**
 * 联合最低供水承诺裁决：在固定当前最大供水总量（= analysis.value）的前提下，
 * 多个需求点的最低供水量下限能否「同时」满足。
 *
 * 可行时仅给出结论与固定总量，不输出任何逐边/逐点分配——承诺问题只需
 * 能/不能的联合裁决，单点分配由调用方另行读取区间或当前方案。
 */
export interface JointCommitment {
  /** 固定的总供水量（= 裁决时的 analysis.value）。 */
  total: number
  /** 实际参与裁决（填写了非空下限）的需求点数量。 */
  committed: number
}

export interface LoadError {
  code: typeof INVALID_NETWORK
  details: string[]
}

export type ParseResult =
  | { ok: true; network: Network }
  | { ok: false; error: LoadError }
